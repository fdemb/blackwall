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
  revisionOf,
  scopeKey,
  withSkipped,
  writeStaged,
} from "./shared";
import type {
  BootstrapStage,
  LoadedReplica,
  Replica,
  ReplicaCloseReason,
  ReplicaHead,
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

/** Moves the base revision on, for a write that changes what only a reload shows. */
function revise(state: State): number {
  const revision = revisionOf(state.meta) + 1;
  state.meta.revision = revision;
  return revision;
}

function sortedOutbox(state: State): PendingMutation[] {
  return [...state.outbox.values()].sort((a, b) => a.id - b.id);
}

interface Entry {
  state: State;
  handles: Set<MemoryReplica>;
  /** The bootstrap being staged, outside `state` like IndexedDB's idle stores. */
  stage: { token: string; records: Map<Entity, Map<string, object>> } | null;
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

  async loadHead(): Promise<ReplicaHead> {
    const { meta, unconfirmed, scopes } = await this.load();
    return { meta, unconfirmed, scopes };
  }

  async claimTerm(): Promise<ReplicaHead> {
    this.transaction((state) => {
      state.meta.term = (state.meta.term ?? 0) + 1;
    });
    return this.loadHead();
  }

  async loadOutbox(): Promise<readonly PendingMutation[]> {
    if (this.closed) throw new Error("replica is closed");
    const { state } = this.entry;
    return structuredClone(
      sortedOutbox(state).filter((mutation) => mutation.id > state.meta.lastMutationId),
    );
  }

  async resetBase(): Promise<number> {
    this.entry.stage = null;
    return this.transaction((state) => {
      for (const table of state.records.values()) table.clear();
      state.scopes.clear();
      state.meta.schema = this.schema;
      state.meta.serverSchema = 0;
      state.meta.cursor = null;
      return revise(state);
    });
  }

  writeBootstrap(input: Parameters<Replica["writeBootstrap"]>[0]): Promise<number> {
    return writeStaged(this, input);
  }

  async stageBootstrap(): Promise<BootstrapStage> {
    if (this.closed) throw new Error("replica is closed");
    const stage = { token: crypto.randomUUID(), records: new Map<Entity, Map<string, object>>() };
    this.entry.stage = stage;
    const current = () => {
      if (this.entry.stage !== stage) throw new Error("bootstrap stage was replaced");
    };
    return {
      write: async (records) => {
        if (this.closed) throw new Error("replica is closed");
        current();
        const writes: [Entity, string, object][] = [];
        for (const [entity, list] of Object.entries(records) as [Entity, object[]][])
          for (const record of list)
            writes.push([entity, recordKey(entity, record), structuredClone(record)]);
        for (const [entity, key, record] of writes) {
          const table = stage.records.get(entity) ?? new Map<string, object>();
          stage.records.set(entity, table);
          table.set(key, record);
        }
      },
      commit: async (input) => {
        const revision = this.transaction((state) => {
          current();
          for (const entity of input.entities)
            state.records.set(entity, new Map(stage.records.get(entity)));
          state.records.get("comments")?.clear();
          state.records.get("activity")?.clear();
          state.scopes.clear();
          state.meta.cursor = input.cursor;
          state.meta.lastMutationId = Math.max(state.meta.lastMutationId, input.lastMutationId);
          dropConfirmed(state);
          state.meta.serverSchema = input.serverSchema;
          state.meta = withSkipped(state.meta, input.skipped ?? [], input.resync === true);
          return revise(state);
        });
        this.entry.stage = null;
        return revision;
      },
    };
  }

  async applyPull(input: Parameters<Replica["applyPull"]>[0]): Promise<number> {
    return this.transaction((state) => {
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
      if (input.skipped !== undefined)
        state.meta = withSkipped(state.meta, input.skipped, input.resync === true);
      return revise(state);
    });
  }

  async writeScope(input: Parameters<Replica["writeScope"]>[0]): Promise<number> {
    return this.transaction((state) => {
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
      if (input.partial) state.scopes.delete(key);
      else state.scopes.set(key, structuredClone(input.scope));
      return revise(state);
    });
  }

  async evictScopes(scopes: readonly Scope[]): Promise<number> {
    return this.transaction((state) => {
      for (const scope of scopes) {
        const key = scopeKey(scope);
        const table = state.records.get(scope.entity);
        if (table === undefined) throw new Error(`unknown entity ${scope.entity}`);
        for (const [id, record] of table) {
          const current = recordScope(scope.entity, record);
          if (current !== null && scopeKey(current) === key) table.delete(id);
        }
        state.scopes.delete(key);
      }
      return revise(state);
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

  async discard(rejections: readonly Rejection[]): Promise<number> {
    return this.transaction((state) => {
      for (const rejection of rejections) {
        state.rejected.set(rejection.id, structuredClone(rejection));
        state.outbox.delete(rejection.id);
        state.confirmed.delete(rejection.id);
      }
      return revise(state);
    });
  }

  async setAccessLost(lost: boolean): Promise<void> {
    this.transaction((state) => {
      state.meta.accessLost = lost;
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
        stage: null,
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
