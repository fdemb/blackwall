import type { Rejection } from "../engine-types";
import { ENTITIES } from "../records";
import type { Entity } from "../records";
import type { PendingMutation } from "../store";
import {
  acceptsChange,
  initialMeta,
  recordKey,
  recordScope,
  replicaName,
  scopeKey,
} from "./shared";
import type {
  LoadedReplica,
  Replica,
  ReplicaCloseReason,
  ReplicaIdentity,
  ReplicaMeta,
  ReplicaOpenInput,
  ReplicaStorage,
  Scope,
} from "./types";

interface State {
  meta: ReplicaMeta;
  records: Map<Entity, Map<string, object>>;
  outbox: Map<number, PendingMutation>;
  /** Outbox ids whose push results arrived. */
  confirmed: Set<number>;
  scopes: Map<string, Scope>;
  rejected: Map<number, Rejection>;
}

/** Acknowledged mutations leave the outbox once confirmed, like the IndexedDB replica. */
function dropConfirmed(state: State): void {
  for (const id of state.outbox.keys()) {
    if (id > state.meta.lastMutationId || !state.confirmed.has(id)) continue;
    state.outbox.delete(id);
    state.confirmed.delete(id);
  }
}

function sortedOutbox(state: State): PendingMutation[] {
  return [...state.outbox.values()].sort((a, b) => a.id - b.id);
}

interface Entry {
  state: State;
  handles: Set<MemoryReplica>;
}

class MemoryReplica implements Replica {
  private closed = false;

  constructor(
    private readonly entry: Entry,
    private readonly schema: number,
    private readonly onClose: ((reason: ReplicaCloseReason) => void) | undefined,
  ) {}

  private transaction<T>(write: (state: State) => T): T {
    if (this.closed) throw new Error("replica is closed");
    const next = structuredClone(this.entry.state);
    const result = write(next);
    this.entry.state = next;
    return result;
  }

  async load(): Promise<LoadedReplica> {
    if (this.closed) throw new Error("replica is closed");
    const state = structuredClone(this.entry.state);
    const records: LoadedReplica["records"] = {};
    for (const [entity, table] of state.records) records[entity] = [...table.values()];
    const outbox = sortedOutbox(state);
    const acknowledged = (mutation: PendingMutation) => mutation.id <= state.meta.lastMutationId;
    return {
      meta: state.meta,
      records,
      outbox: outbox.filter((mutation) => !acknowledged(mutation)),
      unconfirmed: outbox.filter(acknowledged),
      scopes: [...state.scopes.values()],
      rejected: [...state.rejected.values()].sort((a, b) => a.id - b.id),
    };
  }

  async loadOutbox(): Promise<readonly PendingMutation[]> {
    if (this.closed) throw new Error("replica is closed");
    const { state } = this.entry;
    return structuredClone(
      sortedOutbox(state).filter((mutation) => mutation.id > state.meta.lastMutationId),
    );
  }

  async resetBase(): Promise<void> {
    this.transaction((state) => {
      for (const table of state.records.values()) table.clear();
      state.scopes.clear();
      state.meta.schema = this.schema;
      state.meta.serverSchema = 0;
      state.meta.cursor = null;
    });
  }

  async writeBootstrap(input: Parameters<Replica["writeBootstrap"]>[0]): Promise<void> {
    this.transaction((state) => {
      for (const entity of input.entities) {
        const table = new Map<string, object>();
        for (const record of input.records[entity] ?? []) {
          table.set(recordKey(entity, record), structuredClone(record));
        }
        state.records.set(entity, table);
      }
      state.records.get("comments")?.clear();
      state.records.get("activity")?.clear();
      state.scopes.clear();
      state.meta.cursor = input.cursor;
      state.meta.lastMutationId = Math.max(state.meta.lastMutationId, input.lastMutationId);
      dropConfirmed(state);
      state.meta.serverSchema = input.serverSchema;
    });
  }

  async applyPull(input: Parameters<Replica["applyPull"]>[0]): Promise<void> {
    this.transaction((state) => {
      for (const change of input.changes) {
        const table = state.records.get(change.entity);
        if (table === undefined) throw new Error(`unknown entity ${change.entity}`);
        const record = change.record ?? table.get(change.id);
        if (!acceptsChange(change.entity, record, state.scopes)) continue;
        if (change.record === null) table.delete(change.id);
        else {
          if (recordKey(change.entity, change.record) !== change.id) {
            throw new Error("change id does not match record key");
          }
          table.set(change.id, structuredClone(change.record));
        }
      }
      state.meta.cursor = input.cursor;
      if (input.acknowledgedUpTo !== null) {
        state.meta.lastMutationId = Math.max(state.meta.lastMutationId, input.acknowledgedUpTo);
        dropConfirmed(state);
      }
    });
  }

  async writeScope(input: Parameters<Replica["writeScope"]>[0]): Promise<void> {
    this.transaction((state) => {
      const key = scopeKey(input.scope);
      const table = state.records.get(input.scope.entity);
      if (table === undefined) throw new Error(`unknown entity ${input.scope.entity}`);
      for (const [id, record] of table) {
        const scope = recordScope(input.scope.entity, record);
        if (scope !== null && scopeKey(scope) === key) table.delete(id);
      }
      for (const record of input.records) {
        table.set(recordKey(input.scope.entity, record), structuredClone(record));
      }
      state.scopes.set(key, structuredClone(input.scope));
    });
  }

  async loadScope(scope: Scope): Promise<{ loaded: boolean; records: readonly object[] }> {
    if (this.closed) throw new Error("replica is closed");
    const key = scopeKey(scope);
    const table = this.entry.state.records.get(scope.entity);
    if (table === undefined) throw new Error(`unknown entity ${scope.entity}`);
    const records = [...table.values()].filter((record) => {
      const current = recordScope(scope.entity, record);
      return current !== null && scopeKey(current) === key;
    });
    return structuredClone({ loaded: this.entry.state.scopes.has(key), records });
  }

  async appendMutation(build: Parameters<Replica["appendMutation"]>[0]): Promise<PendingMutation> {
    return this.transaction((state) => {
      const id = state.meta.nextMutationId;
      const mutation = structuredClone({ ...build(id), id });
      state.outbox.set(id, mutation);
      state.meta.nextMutationId += 1;
      return structuredClone(mutation);
    });
  }

  async confirm(ids: readonly number[], rejected: readonly Rejection[] = []): Promise<void> {
    this.transaction((state) => {
      for (const id of ids) if (state.outbox.has(id)) state.confirmed.add(id);
      for (const rejection of rejected) state.rejected.set(rejection.id, rejection);
      dropConfirmed(state);
    });
  }

  async discard(rejections: readonly Rejection[]): Promise<void> {
    this.transaction((state) => {
      for (const rejection of rejections) {
        state.rejected.set(rejection.id, structuredClone(rejection));
        state.outbox.delete(rejection.id);
        state.confirmed.delete(rejection.id);
      }
    });
  }

  async resolveRejection(id: number): Promise<void> {
    this.transaction((state) => state.rejected.delete(id));
  }

  close(): void {
    this.closed = true;
    this.entry.handles.delete(this);
  }

  /** The replica was deleted under this handle, which is reported like IndexedDB's versionchange. */
  closeExternally(): void {
    this.close();
    this.onClose?.("versionchange");
  }
}

export class MemoryReplicaStorage implements ReplicaStorage {
  private readonly replicas = new Map<string, Entry>();

  async open(input: ReplicaOpenInput): Promise<Replica> {
    const name = replicaName(input);
    let entry = this.replicas.get(name);
    if (entry === undefined) {
      entry = {
        state: {
          meta: initialMeta(input),
          records: new Map(ENTITIES.map((entity) => [entity, new Map<string, object>()])),
          outbox: new Map(),
          confirmed: new Set(),
          scopes: new Map(),
          rejected: new Map(),
        },
        handles: new Set(),
      };
      this.replicas.set(name, entry);
    }
    const replica = new MemoryReplica(entry, input.schema, input.onClose);
    entry.handles.add(replica);
    return replica;
  }

  async list(): Promise<readonly ReplicaIdentity[]> {
    return [...this.replicas.values()].map(({ state: { meta } }) => ({
      userId: meta.userId,
      workspaceId: meta.workspaceId,
    }));
  }

  async delete(input: ReplicaIdentity): Promise<void> {
    const name = replicaName(input);
    const entry = this.replicas.get(name);
    if (entry === undefined) return;
    for (const handle of entry.handles) handle.closeExternally();
    this.replicas.delete(name);
  }
}
