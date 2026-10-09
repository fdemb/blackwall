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
    identity: ReplicaIdentity,
    onClose: ReplicaCloseListener | undefined,
  ) {
    db.onversionchange = () => {
      this.close();
      onClose?.({ ...identity, reason: "versionchange" });
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

  writeBootstrap(input: Parameters<Replica["writeBootstrap"]>[0]): Promise<void> {
    return this.transaction(["meta", ...input.entities], "readwrite", (tx, done, guard) => {
      for (const entity of input.entities) {
        const store = tx.objectStore(entity);
        store.clear();
        for (const record of input.records[entity] ?? []) {
          recordKey(entity, record);
          store.put(record);
        }
      }
      read<ReplicaMeta>(tx.objectStore("meta").get(META_KEY), guard, (meta) => {
        tx.objectStore("meta").put(
          {
            ...meta,
            cursor: input.cursor,
            lastMutationId: input.lastMutationId,
            serverSchema: input.serverSchema,
          },
          META_KEY,
        );
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
        tx.objectStore("meta").put(
          {
            ...meta,
            cursor: input.cursor,
            lastMutationId: input.acknowledgedUpTo ?? meta.lastMutationId,
          },
          META_KEY,
        );
        if (input.acknowledgedUpTo !== null && input.acknowledgedUpTo >= 0) {
          tx.objectStore("outbox").delete(IDBKeyRange.upperBound(input.acknowledgedUpTo));
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

  allocateMutationId(): Promise<number> {
    return this.transaction(["meta"], "readwrite", (tx, done, guard) => {
      read<ReplicaMeta>(tx.objectStore("meta").get(META_KEY), guard, (meta) => {
        tx.objectStore("meta").put({ ...meta, nextMutationId: meta.nextMutationId + 1 }, META_KEY);
        done(meta.nextMutationId);
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
  /** Bump when changing the object store layout. Upgrades discard the old replica. */
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

  async open(input: ReplicaIdentity & { schema: number }): Promise<Replica> {
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
        for (const name of [...db.objectStoreNames]) db.deleteObjectStore(name);
        db.createObjectStore("meta").put(initialMeta(input), META_KEY);
        for (const entity of ENTITIES) db.createObjectStore(entity, { keyPath: keyPath(entity) });
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
      { sessionId: input.sessionId, workspaceId: input.workspaceId },
      this.onClose,
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
