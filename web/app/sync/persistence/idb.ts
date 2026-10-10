import { ENTITIES } from "../records";
import type { PendingMutation } from "../store";
import {
  acceptsChange,
  initialMeta,
  keyPath,
  recordKey,
  recordScope,
  replicaIdentity,
  replicaName,
  scopeKey,
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
export const IDB_VERSION = 1;
const META_KEY = "replica";
const STORES = ["meta", ...ENTITIES, "outbox", "scopes"];

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
      tx.onerror = () => reject(failure ?? tx.error ?? new Error("IndexedDB transaction failed"));
      tx.onabort = () => reject(failure ?? tx.error ?? new Error("IndexedDB transaction aborted"));
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
      let outbox: PendingMutation[] = [];
      let scopes: Scope[] = [];
      let remaining = ENTITIES.length + 3;
      const received = () => {
        remaining -= 1;
        if (remaining === 0) done({ meta, records, outbox, scopes });
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
      read<PendingMutation[]>(tx.objectStore("outbox").getAll(), guard, (value) => {
        outbox = value;
        received();
      });
      read<Scope[]>(tx.objectStore("scopes").getAll(), guard, (value) => {
        scopes = value;
        received();
      });
    });
  }

  loadOutbox(): Promise<readonly PendingMutation[]> {
    return this.transaction<readonly PendingMutation[]>(
      ["outbox"],
      "readonly",
      (tx, done, guard) => {
        read<PendingMutation[]>(tx.objectStore("outbox").getAll(), guard, done);
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
          {
            ...meta,
            cursor: input.cursor,
            lastMutationId,
            serverSchema: input.serverSchema,
          },
          META_KEY,
        );
        tx.objectStore("outbox").delete(IDBKeyRange.upperBound(lastMutationId));
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
        tx.objectStore("meta").put(
          {
            ...meta,
            cursor: input.cursor,
            lastMutationId,
          },
          META_KEY,
        );
        if (input.acknowledgedUpTo !== null) {
          tx.objectStore("outbox").delete(IDBKeyRange.upperBound(lastMutationId));
        }
        done(undefined);
      });
    });
  }

  writeScope(input: Parameters<Replica["writeScope"]>[0]): Promise<void> {
    return this.transaction(["scopes", input.scope.entity], "readwrite", (tx, done, guard) => {
      const key = scopeKey(input.scope);
      const store = tx.objectStore(input.scope.entity);
      read<object[]>(store.getAll(), guard, (previous) => {
        for (const record of previous) {
          const scope = recordScope(input.scope.entity, record);
          if (scope !== null && scopeKey(scope) === key)
            store.delete(recordKey(input.scope.entity, record));
        }
        for (const record of input.records) {
          recordKey(input.scope.entity, record);
          store.put(record);
        }
        tx.objectStore("scopes").put(input.scope, key);
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
      read<object[]>(tx.objectStore(scope.entity).getAll(), guard, (all) => {
        records = all.filter((record) => {
          const current = recordScope(scope.entity, record);
          return current !== null && scopeKey(current) === key;
        });
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
      request.onerror = () => reject(request.error);
      request.onupgradeneeded = () => {
        if (failed) {
          request.transaction?.abort();
          return;
        }
        const db = request.result;
        const tx = request.transaction;
        if (tx === null) throw new Error("replica upgrade transaction is missing");
        // Changing the meta or outbox format requires an explicit migration.
        for (const name of [...db.objectStoreNames]) {
          if (name !== "meta" && name !== "outbox") db.deleteObjectStore(name);
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
        for (const entity of ENTITIES) db.createObjectStore(entity, { keyPath: keyPath(entity) });
        if (!db.objectStoreNames.contains("outbox"))
          db.createObjectStore("outbox", { keyPath: "id" });
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
      { sessionId: input.sessionId, workspaceId: input.workspaceId },
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

  async deleteAllExcept(sessionId: string | null): Promise<void> {
    for (const identity of await this.list()) {
      if (identity.sessionId !== sessionId) await this.delete(identity);
    }
  }
}
