import type { Rejection } from "../engine-types";
import { ENTITIES } from "../records";
import type { PendingMutation } from "../store";
import {
  acceptsChange,
  initialMeta,
  keyPath,
  recordKey,
  replicaIdentity,
  replicaName,
  scopeKey,
  storageFailure,
  withSkipped,
} from "./shared";
import type {
  LoadedReplica,
  Replica,
  ReplicaCloseListener,
  ReplicaIdentity,
  ReplicaMeta,
  ReplicaOpenInput,
  ReplicaStorage,
  Scope,
} from "./types";

/** Store layout version, independent of the client record/index schema in meta. */
export const IDB_VERSION = 3;
const META_KEY = "replica";
const STORES = ["meta", ...ENTITIES, "outbox", "scopes", "rejected"];
/** Stores that hold the user's own work, kept across layout upgrades. */
const KEPT_STORES = ["meta", "outbox", "rejected"];
/** The index on each scoped entity, named after the field that holds its scope id. */
const SCOPE_INDEX = { comments: "issue_id", activity: "entity_id" } as const;

/** An outbox row. `confirmed` marks a mutation whose push result arrived. */
type StoredMutation = PendingMutation & { confirmed?: true };

function pendingOf(row: StoredMutation): PendingMutation {
  if (!row.confirmed) return row;
  const mutation: StoredMutation = { ...row };
  delete mutation.confirmed;
  return mutation;
}

function scopeValue(scope: Scope): string {
  return scope.entity === "comments" ? scope.issueId : scope.entityId;
}

/** Acknowledged rows leave the outbox once confirmed. The rest wait for a confirmation push. */
function dropConfirmed(tx: IDBTransaction, lastMutationId: number, guard: Guard): void {
  const request = tx.objectStore("outbox").openCursor(IDBKeyRange.upperBound(lastMutationId));
  read<IDBCursorWithValue | null>(request, guard, (cursor) => {
    if (cursor === null) return;
    if ((cursor.value as StoredMutation).confirmed) cursor.delete();
    cursor.continue();
  });
}

type Guard = (fn: () => void) => void;

/** Values come only from this module's writes, under the current store layout. */
function read<T>(request: IDBRequest, guard: Guard, receive: (value: T) => void): void {
  request.onsuccess = () => guard(() => receive(request.result as T));
}

class IndexedDBReplica implements Replica {
  private closed = false;

  constructor(
    private readonly db: IDBDatabase,
    private readonly schema: number,
    identity: ReplicaIdentity,
    onClose: ReplicaCloseListener | undefined,
  ) {
    db.onversionchange = (event) => {
      this.close();
      onClose?.({ ...identity, reason: "versionchange", newVersion: event.newVersion });
    };
    db.onclose = () => {
      this.close();
      onClose?.({ ...identity, reason: "terminated" });
    };
  }

  private transaction<T>(
    stores: readonly string[],
    mode: IDBTransactionMode,
    run: (tx: IDBTransaction, done: (result: T) => void, guard: Guard) => void,
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      if (this.closed) {
        reject(new Error("replica is closed"));
        return;
      }
      const tx = this.db.transaction([...new Set(stores)], mode);
      let failure: unknown;
      let complete = () => reject(new Error("transaction completed without a result"));
      const guard: Guard = (fn) => {
        try {
          fn();
        } catch (error) {
          failure = error;
          tx.abort();
        }
      };
      tx.oncomplete = () => complete();
      // A write that runs out of space fails its request, or aborts the transaction at commit.
      tx.onerror = (event) =>
        reject(
          storageFailure(
            failure ??
              (event.target as IDBRequest | null)?.error ??
              tx.error ??
              new Error("IndexedDB transaction failed"),
          ),
        );
      tx.onabort = () =>
        reject(storageFailure(failure ?? tx.error ?? new Error("IndexedDB transaction aborted")));
      guard(() =>
        run(
          tx,
          (result) => {
            complete = () => resolve(result);
          },
          guard,
        ),
      );
    });
  }

  load(): Promise<LoadedReplica> {
    return this.transaction(STORES, "readonly", (tx, done, guard) => {
      const records: LoadedReplica["records"] = {};
      let meta: ReplicaMeta;
      let stored: StoredMutation[] = [];
      let scopes: Scope[] = [];
      let rejected: Rejection[] = [];
      let remaining = ENTITIES.length + 4;
      const received = () => {
        remaining -= 1;
        if (remaining > 0) return;
        const acknowledged = (mutation: PendingMutation) => mutation.id <= meta.lastMutationId;
        const rows = stored.map(pendingOf);
        done({
          meta,
          records,
          outbox: rows.filter((mutation) => !acknowledged(mutation)),
          unconfirmed: rows.filter(acknowledged),
          scopes,
          rejected,
        });
      };
      read<ReplicaMeta | undefined>(tx.objectStore("meta").get(META_KEY), guard, (value) => {
        if (value === undefined) throw new Error("replica metadata is missing");
        meta = value;
        received();
      });
      for (const entity of ENTITIES) {
        read<object[]>(tx.objectStore(entity).getAll(), guard, (value) => {
          records[entity] = value;
          received();
        });
      }
      read<StoredMutation[]>(tx.objectStore("outbox").getAll(), guard, (value) => {
        stored = value;
        received();
      });
      read<Scope[]>(tx.objectStore("scopes").getAll(), guard, (value) => {
        scopes = value;
        received();
      });
      read<Rejection[]>(tx.objectStore("rejected").getAll(), guard, (value) => {
        rejected = value;
        received();
      });
    });
  }

  loadOutbox(): Promise<readonly PendingMutation[]> {
    return this.transaction<readonly PendingMutation[]>(
      ["meta", "outbox"],
      "readonly",
      (tx, done, guard) => {
        read<ReplicaMeta>(tx.objectStore("meta").get(META_KEY), guard, (meta) => {
          const unacknowledged = IDBKeyRange.lowerBound(meta.lastMutationId, true);
          read<StoredMutation[]>(tx.objectStore("outbox").getAll(unacknowledged), guard, (rows) =>
            done(rows.map(pendingOf)),
          );
        });
      },
    );
  }

  resetBase(): Promise<void> {
    return this.transaction(["meta", ...ENTITIES, "scopes"], "readwrite", (tx, done, guard) => {
      for (const entity of ENTITIES) tx.objectStore(entity).clear();
      tx.objectStore("scopes").clear();
      read<ReplicaMeta>(tx.objectStore("meta").get(META_KEY), guard, (meta) => {
        tx.objectStore("meta").put(
          { ...meta, schema: this.schema, serverSchema: 0, cursor: null },
          META_KEY,
        );
        done(undefined);
      });
    });
  }

  writeBootstrap(input: Parameters<Replica["writeBootstrap"]>[0]): Promise<void> {
    const stores = ["meta", "outbox", "scopes", "comments", "activity", ...input.entities];
    return this.transaction(stores, "readwrite", (tx, done, guard) => {
      for (const entity of input.entities) {
        const store = tx.objectStore(entity);
        store.clear();
        for (const record of input.records[entity] ?? []) {
          recordKey(entity, record);
          store.put(record);
        }
      }
      tx.objectStore("comments").clear();
      tx.objectStore("activity").clear();
      tx.objectStore("scopes").clear();
      read<ReplicaMeta>(tx.objectStore("meta").get(META_KEY), guard, (meta) => {
        const lastMutationId = Math.max(meta.lastMutationId, input.lastMutationId);
        tx.objectStore("meta").put(
          withSkipped(
            {
              ...meta,
              cursor: input.cursor,
              lastMutationId,
              serverSchema: input.serverSchema,
            },
            input.skipped ?? [],
            input.resync === true,
          ),
          META_KEY,
        );
        dropConfirmed(tx, lastMutationId, guard);
        done(undefined);
      });
    });
  }

  applyPull(input: Parameters<Replica["applyPull"]>[0]): Promise<void> {
    const stores = ["meta", "scopes", ...input.changes.map((change) => change.entity)];
    if (input.acknowledgedUpTo !== null) stores.push("outbox");
    return this.transaction(stores, "readwrite", (tx, done, guard) => {
      read<Scope[]>(tx.objectStore("scopes").getAll(), guard, (loaded) => {
        const scopes = new Map(loaded.map((scope) => [scopeKey(scope), scope]));
        // A scoped tombstone needs the stored row; resume after its point read.
        const apply = (start: number): void => {
          for (let index = start; index < input.changes.length; index += 1) {
            const change = input.changes[index];
            const store = tx.objectStore(change.entity);
            if (
              change.record === null &&
              (change.entity === "comments" || change.entity === "activity")
            ) {
              read<object | undefined>(store.get(change.id), guard, (previous) => {
                if (acceptsChange(change.entity, previous, scopes)) store.delete(change.id);
                apply(index + 1);
              });
              return;
            }
            if (!acceptsChange(change.entity, change.record ?? undefined, scopes)) continue;
            if (change.record === null) store.delete(change.id);
            else {
              if (recordKey(change.entity, change.record) !== change.id) {
                throw new Error("change id does not match record key");
              }
              store.put(change.record);
            }
          }
        };
        apply(0);
      });
      read<ReplicaMeta>(tx.objectStore("meta").get(META_KEY), guard, (meta) => {
        const lastMutationId = Math.max(
          meta.lastMutationId,
          input.acknowledgedUpTo ?? meta.lastMutationId,
        );
        const next = { ...meta, cursor: input.cursor, lastMutationId };
        tx.objectStore("meta").put(
          input.skipped === undefined
            ? next
            : withSkipped(next, input.skipped, input.resync === true),
          META_KEY,
        );
        if (input.acknowledgedUpTo !== null) dropConfirmed(tx, lastMutationId, guard);
        done(undefined);
      });
    });
  }

  writeScope(input: Parameters<Replica["writeScope"]>[0]): Promise<void> {
    return this.transaction(["scopes", input.scope.entity], "readwrite", (tx, done, guard) => {
      const key = scopeKey(input.scope);
      const store = tx.objectStore(input.scope.entity);
      const index = store.index(SCOPE_INDEX[input.scope.entity]);
      read<IDBValidKey[]>(index.getAllKeys(scopeValue(input.scope)), guard, (previous) => {
        for (const id of previous) store.delete(id);
        for (const record of input.records) {
          recordKey(input.scope.entity, record);
          store.put(record);
        }
        if (input.partial) tx.objectStore("scopes").delete(key);
        else tx.objectStore("scopes").put(input.scope, key);
        done(undefined);
      });
    });
  }

  loadScope(scope: Scope): Promise<{ loaded: boolean; records: readonly object[] }> {
    type Result = { loaded: boolean; records: readonly object[] };
    return this.transaction<Result>(["scopes", scope.entity], "readonly", (tx, done, guard) => {
      const key = scopeKey(scope);
      let loaded: boolean | undefined;
      let records: readonly object[] | undefined;
      const finish = () => {
        if (loaded !== undefined && records !== undefined) done({ loaded, records });
      };
      read<unknown>(tx.objectStore("scopes").get(key), guard, (value) => {
        loaded = value !== undefined;
        finish();
      });
      const index = tx.objectStore(scope.entity).index(SCOPE_INDEX[scope.entity]);
      read<object[]>(index.getAll(scopeValue(scope)), guard, (value) => {
        records = value;
        finish();
      });
    });
  }

  appendMutation(build: Parameters<Replica["appendMutation"]>[0]): Promise<PendingMutation> {
    return this.transaction(["meta", "outbox"], "readwrite", (tx, done, guard) => {
      read<ReplicaMeta>(tx.objectStore("meta").get(META_KEY), guard, (meta) => {
        const id = meta.nextMutationId;
        const mutation = structuredClone({ ...build(id), id });
        tx.objectStore("outbox").add(mutation);
        tx.objectStore("meta").put({ ...meta, nextMutationId: id + 1 }, META_KEY);
        done(mutation);
      });
    });
  }

  confirm(ids: readonly number[], rejected: readonly Rejection[] = []): Promise<void> {
    return this.transaction(["meta", "outbox", "rejected"], "readwrite", (tx, done, guard) => {
      for (const rejection of rejected) tx.objectStore("rejected").put(rejection);
      read<ReplicaMeta>(tx.objectStore("meta").get(META_KEY), guard, (meta) => {
        const outbox = tx.objectStore("outbox");
        for (const id of ids) {
          if (id <= meta.lastMutationId) {
            outbox.delete(id);
            continue;
          }
          read<StoredMutation | undefined>(outbox.get(id), guard, (row) => {
            if (row !== undefined) outbox.put({ ...row, confirmed: true });
          });
        }
        done(undefined);
      });
    });
  }

  discard(rejections: readonly Rejection[]): Promise<void> {
    return this.transaction(["outbox", "rejected"], "readwrite", (tx, done) => {
      for (const rejection of rejections) {
        tx.objectStore("rejected").put(structuredClone(rejection));
        tx.objectStore("outbox").delete(rejection.id);
      }
      done(undefined);
    });
  }

  setAccessLost(lost: boolean): Promise<void> {
    return this.transaction(["meta"], "readwrite", (tx, done, guard) => {
      read<ReplicaMeta>(tx.objectStore("meta").get(META_KEY), guard, (meta) => {
        tx.objectStore("meta").put({ ...meta, accessLost: lost }, META_KEY);
        done(undefined);
      });
    });
  }

  resolveRejection(id: number): Promise<void> {
    return this.transaction(["rejected"], "readwrite", (tx, done) => {
      tx.objectStore("rejected").delete(id);
      done(undefined);
    });
  }

  close(): void {
    this.closed = true;
    this.db.close();
  }
}

export interface IndexedDBStorageOptions {
  indexedDB?: IDBFactory;
  /** Bump when changing the object store layout. Upgrades keep meta ids and the outbox. */
  version?: number;
  onClose?: ReplicaCloseListener;
}

export class IndexedDBReplicaStorage implements ReplicaStorage {
  private readonly factory: IDBFactory;
  private readonly version: number;
  private readonly onClose: ReplicaCloseListener | undefined;

  constructor(options: IndexedDBStorageOptions = {}) {
    this.factory = options.indexedDB ?? indexedDB;
    this.version = options.version ?? IDB_VERSION;
    this.onClose = options.onClose;
  }

  async open(input: ReplicaOpenInput): Promise<Replica> {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = this.factory.open(replicaName(input), this.version);
      let failed = false;
      request.onblocked = () => {
        failed = true;
        reject(new Error(`replica open blocked: ${replicaName(input)}`));
      };
      request.onerror = () => reject(storageFailure(request.error));
      request.onupgradeneeded = () => {
        if (failed) {
          request.transaction?.abort();
          return;
        }
        const db = request.result;
        const tx = request.transaction;
        if (tx === null) throw new Error("replica upgrade transaction is missing");
        // Changing the format of a kept store requires an explicit migration.
        for (const name of [...db.objectStoreNames]) {
          if (!KEPT_STORES.includes(name)) db.deleteObjectStore(name);
        }
        if (db.objectStoreNames.contains("meta")) {
          const guard: Guard = (fn) => {
            try {
              fn();
            } catch (error) {
              tx.abort();
              reject(error);
            }
          };
          read<ReplicaMeta>(tx.objectStore("meta").get(META_KEY), guard, (meta) => {
            tx.objectStore("meta").put(
              { ...meta, schema: input.schema, serverSchema: 0, cursor: null },
              META_KEY,
            );
          });
        } else db.createObjectStore("meta").put(initialMeta(input), META_KEY);
        for (const entity of ENTITIES) {
          const store = db.createObjectStore(entity, { keyPath: keyPath(entity) });
          if (entity === "comments" || entity === "activity")
            store.createIndex(SCOPE_INDEX[entity], SCOPE_INDEX[entity]);
        }
        if (!db.objectStoreNames.contains("outbox"))
          db.createObjectStore("outbox", { keyPath: "id" });
        if (!db.objectStoreNames.contains("rejected"))
          db.createObjectStore("rejected", { keyPath: "id" });
        db.createObjectStore("scopes");
      };
      request.onsuccess = () => {
        if (failed) request.result.close();
        else resolve(request.result);
      };
    });
    return new IndexedDBReplica(
      db,
      input.schema,
      { userId: input.userId, workspaceId: input.workspaceId },
      (event) => {
        input.onClose?.(
          event.reason,
          event.reason === "versionchange" ? event.newVersion : undefined,
        );
        this.onClose?.(event);
      },
    );
  }

  async list(): Promise<readonly ReplicaIdentity[]> {
    const replicas: ReplicaIdentity[] = [];
    for (const database of await this.factory.databases()) {
      const identity = database.name === undefined ? null : replicaIdentity(database.name);
      if (identity !== null) replicas.push(identity);
    }
    return replicas;
  }

  delete(input: ReplicaIdentity): Promise<void> {
    return new Promise((resolve, reject) => {
      const request = this.factory.deleteDatabase(replicaName(input));
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error(`replica delete blocked: ${replicaName(input)}`));
    });
  }
}
