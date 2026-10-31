import type { Rejection } from "../engine-types";
import { ENTITIES } from "../records";
import type { Entity } from "../records";
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
  writeStaged,
} from "./shared";
import type {
  BootstrapStage,
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
export const IDB_VERSION = 4;
const META_KEY = "replica";
/** Which of the two sets of swapped stores holds the live base. Absent means the first. */
const GENERATION_KEY = "generation";
/** The token of the bootstrap stage allowed to write, in the `stage` store. */
const STAGE_KEY = "token";
/**
 * Entities a bootstrap replaces. Each has two stores: a bootstrap fills the idle one in chunks
 * and swaps it in with the generation in meta, so a reload mid-bootstrap sees the old base whole.
 */
const SWAPPED: readonly Entity[] = ENTITIES.filter(
  (entity) => entity !== "comments" && entity !== "activity",
);
type Generation = 0 | 1;

function idle(live: Generation): Generation {
  return live === 0 ? 1 : 0;
}

function storeOf(entity: Entity, generation: Generation): string {
  return generation === 1 && SWAPPED.includes(entity) ? `${entity}:1` : entity;
}

const SWAPPED_STORES = SWAPPED.flatMap((entity) => [storeOf(entity, 0), storeOf(entity, 1)]);
const ENTITY_STORES = [...ENTITIES, ...SWAPPED.map((entity) => storeOf(entity, 1))];
const STORES = ["meta", ...ENTITY_STORES, "outbox", "scopes", "rejected", "stage"];
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

function readGeneration(tx: IDBTransaction, guard: Guard, receive: (live: Generation) => void) {
  read<Generation | undefined>(tx.objectStore("meta").get(GENERATION_KEY), guard, (value) =>
    receive(value ?? 0),
  );
}

/** Fails the transaction unless `token` still names the current stage. */
function checkStage(tx: IDBTransaction, guard: Guard, token: string, then: () => void): void {
  read<string | undefined>(tx.objectStore("stage").get(STAGE_KEY), guard, (current) => {
    if (current !== token) throw new Error("bootstrap stage was replaced");
    then();
  });
}

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
      // Every store is read up front, both copies included, and the live copy picked at the end:
      // a request issued after a callback can run after an upgrade has replaced the stores.
      const contents = new Map<string, object[]>();
      let live: Generation = 0;
      let meta: ReplicaMeta;
      let stored: StoredMutation[] = [];
      let scopes: Scope[] = [];
      let rejected: Rejection[] = [];
      let remaining = ENTITY_STORES.length + 5;
      const received = () => {
        remaining -= 1;
        if (remaining > 0) return;
        const acknowledged = (mutation: PendingMutation) => mutation.id <= meta.lastMutationId;
        const rows = stored.map(pendingOf);
        const records: LoadedReplica["records"] = {};
        for (const entity of ENTITIES) records[entity] = contents.get(storeOf(entity, live)) ?? [];
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
      readGeneration(tx, guard, (generation) => {
        live = generation;
        received();
      });
      for (const store of ENTITY_STORES)
        read<object[]>(tx.objectStore(store).getAll(), guard, (value) => {
          contents.set(store, value);
          received();
        });
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
    const stores = ["meta", ...ENTITY_STORES, "scopes", "stage"];
    return this.transaction(stores, "readwrite", (tx, done, guard) => {
      for (const store of ENTITY_STORES) tx.objectStore(store).clear();
      tx.objectStore("scopes").clear();
      tx.objectStore("stage").clear();
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
    return writeStaged(this, input);
  }

  async stageBootstrap(): Promise<BootstrapStage> {
    const token = crypto.randomUUID();
    const live = await this.transaction<Generation>(
      ["meta", "stage", ...SWAPPED_STORES],
      "readwrite",
      (tx, done, guard) => {
        readGeneration(tx, guard, (current) => {
          for (const entity of SWAPPED) tx.objectStore(storeOf(entity, idle(current))).clear();
          tx.objectStore("stage").put(token, STAGE_KEY);
          done(current);
        });
      },
    );
    const target = idle(live);
    return {
      write: (records) => {
        const entities = Object.keys(records) as Entity[];
        const stores = ["stage", ...entities.map((entity) => storeOf(entity, target))];
        return this.transaction(stores, "readwrite", (tx, done, guard) => {
          checkStage(tx, guard, token, () => {
            for (const entity of entities) {
              if (!SWAPPED.includes(entity)) throw new Error(`${entity} is not bootstrapped`);
              const store = tx.objectStore(storeOf(entity, target));
              for (const record of records[entity] ?? []) {
                recordKey(entity, record);
                store.put(record);
              }
            }
            done(undefined);
          });
        });
      },
      commit: (input) => {
        const stores = ["meta", "outbox", "scopes", "stage", "comments", "activity"];
        stores.push(...SWAPPED_STORES);
        return this.transaction(stores, "readwrite", (tx, done, guard) => {
          checkStage(tx, guard, token, () =>
            readGeneration(tx, guard, (current) => {
              if (current !== live) throw new Error("bootstrap stage was replaced");
              // An entity the bootstrap doesn't list keeps its records.
              for (const entity of SWAPPED) {
                const old = tx.objectStore(storeOf(entity, live));
                if (input.entities.includes(entity)) {
                  old.clear();
                  continue;
                }
                read<object[]>(old.getAll(), guard, (kept) => {
                  const store = tx.objectStore(storeOf(entity, target));
                  for (const record of kept) store.put(record);
                  old.clear();
                });
              }
              tx.objectStore("comments").clear();
              tx.objectStore("activity").clear();
              tx.objectStore("scopes").clear();
              tx.objectStore("stage").delete(STAGE_KEY);
              tx.objectStore("meta").put(target, GENERATION_KEY);
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
            }),
          );
        });
      },
    };
  }

  applyPull(input: Parameters<Replica["applyPull"]>[0]): Promise<void> {
    const stores = ["meta", "scopes"];
    for (const { entity } of input.changes) stores.push(storeOf(entity, 0), storeOf(entity, 1));
    if (input.acknowledgedUpTo !== null) stores.push("outbox");
    return this.transaction(stores, "readwrite", (tx, done, guard) => {
      read<Scope[]>(tx.objectStore("scopes").getAll(), guard, (loaded) => {
        const scopes = new Map(loaded.map((scope) => [scopeKey(scope), scope]));
        readGeneration(tx, guard, (live) => {
          // A scoped tombstone needs the stored row; resume after its point read.
          const apply = (start: number): void => {
            for (let index = start; index < input.changes.length; index += 1) {
              const change = input.changes[index];
              const store = tx.objectStore(storeOf(change.entity, live));
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
          tx.objectStore("meta").delete(GENERATION_KEY);
        } else db.createObjectStore("meta").put(initialMeta(input), META_KEY);
        for (const entity of ENTITIES) {
          const store = db.createObjectStore(entity, { keyPath: keyPath(entity) });
          if (entity === "comments" || entity === "activity")
            store.createIndex(SCOPE_INDEX[entity], SCOPE_INDEX[entity]);
        }
        for (const entity of SWAPPED)
          db.createObjectStore(storeOf(entity, 1), { keyPath: keyPath(entity) });
        if (!db.objectStoreNames.contains("outbox"))
          db.createObjectStore("outbox", { keyPath: "id" });
        if (!db.objectStoreNames.contains("rejected"))
          db.createObjectStore("rejected", { keyPath: "id" });
        db.createObjectStore("scopes");
        db.createObjectStore("stage");
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
