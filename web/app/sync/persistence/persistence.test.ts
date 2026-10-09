import "fake-indexeddb/auto";
import { forceCloseDatabase, IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { BOOTSTRAP_ENTITIES, ENTITIES } from "../records";
import type { Entity } from "../records";
import type { PendingMutation } from "../store";
import { IDB_VERSION, IndexedDBReplicaStorage } from "./idb";
import { MemoryReplicaStorage } from "./memory";
import { replicaName } from "./shared";
import type { Replica, ReplicaCloseListener, ReplicaStorage, Scope } from "./types";

const INPUT = { sessionId: "session-1", workspaceId: "workspace-1", schema: 7 };
const COMMENT_SCOPE = { entity: "comments", issueId: "issue-1" } satisfies Scope;
const ACTIVITY_SCOPE = { entity: "activity", entityId: "issue-1" } satisfies Scope;
const COMMENT = {
  id: "comment-1",
  issue_id: "issue-1",
  body: "Hello",
  created_at: "2026-10-08T14:00:00+02:00",
};
const ACTIVITY = { id: "activity-1", entity_id: "issue-1", at: "2026-10-08T14:00:00+02:00" };
const mutation = (id: number): Omit<PendingMutation, "id"> => ({
  name: "update_issue",
  args: { id: "issue-1", patch: { title: `Title ${id}` } },
  at: "2026-10-08T12:00:00Z",
  local: { notificationIds: ["notification-1"] },
});
function bootstrap(
  records: Parameters<Replica["writeBootstrap"]>[0]["records"] = {},
  entities: readonly Entity[] = BOOTSTRAP_ENTITIES,
): Parameters<Replica["writeBootstrap"]>[0] {
  return { cursor: "bootstrap", lastMutationId: 0, serverSchema: 3, records, entities };
}

for (const backend of ["memory", "idb"]) {
  describe(`${backend} replica contract`, () => {
    let storage: ReplicaStorage;
    let replica: Replica;
    let handles: Replica[];
    async function open(input = INPUT): Promise<Replica> {
      const handle = await storage.open(input);
      handles.push(handle);
      return handle;
    }
    beforeEach(async () => {
      storage =
        backend === "memory"
          ? new MemoryReplicaStorage()
          : new IndexedDBReplicaStorage({ indexedDB: new IDBFactory() });
      handles = [];
      replica = await open();
    });
    afterEach(() => {
      for (const handle of handles) handle.close();
    });

    it("creates fresh metadata and a distinct client id per replica", async () => {
      const loaded = await replica.load();
      expect(loaded.meta).toEqual({
        ...INPUT,
        serverSchema: 0,
        clientId: expect.any(String),
        cursor: null,
        lastMutationId: 0,
        nextMutationId: 1,
      });
      expect(loaded.meta.clientId).toMatch(/^[0-9a-f-]{36}$/);
      expect(loaded.outbox).toEqual([]);
      expect(loaded.scopes).toEqual([]);
      for (const entity of ENTITIES) expect(loaded.records[entity]).toEqual([]);
      const other = await open({ ...INPUT, workspaceId: "workspace-2" });
      expect((await other.load()).meta.clientId).not.toBe(loaded.meta.clientId);
    });

    it("reopens the same raw records, metadata, outbox and scopes", async () => {
      const issue = { id: "issue-1", created_at: "2026-10-08T14:00:00+02:00" };
      await replica.writeBootstrap(bootstrap({ issues: [issue] }));
      await replica.writeScope({ scope: COMMENT_SCOPE, records: [COMMENT] });
      await replica.writeScope({ scope: ACTIVITY_SCOPE, records: [ACTIVITY] });
      await replica.appendMutation(mutation);
      const before = await replica.load();
      replica.close();
      expect(await (await open()).load()).toEqual(before);
      expect(before.records.issues).toEqual([issue]);
      // The engine must be able to flush the old outbox before wiping on a schema mismatch.
      expect((await (await open({ ...INPUT, schema: 8 })).load()).meta.schema).toBe(7);
    });

    it("shares one client id across simultaneous first opens", async () => {
      const [a, b] = await Promise.all([
        open({ ...INPUT, workspaceId: "new" }),
        open({ ...INPUT, workspaceId: "new" }),
      ]);
      expect((await a.load()).meta.clientId).toBe((await b.load()).meta.clientId);
    });

    it("bootstrap replaces listed entities, empties omitted ones and preserves scopes and outbox", async () => {
      await replica.writeBootstrap(
        bootstrap({
          issues: [{ id: "old" }],
          teams: [{ id: "team-1" }],
          labels: [{ id: "label-1" }],
        }),
      );
      await replica.writeScope({ scope: COMMENT_SCOPE, records: [COMMENT] });
      await replica.writeScope({ scope: ACTIVITY_SCOPE, records: [ACTIVITY] });
      const pending = await replica.appendMutation(mutation);
      await replica.writeBootstrap({
        ...bootstrap({ issues: [{ id: "new" }] }, ["issues", "teams"]),
        cursor: "new-bootstrap",
        lastMutationId: 9,
        serverSchema: 4,
      });
      const loaded = await replica.load();
      expect(loaded.records.issues).toEqual([{ id: "new" }]);
      expect(loaded.records.teams).toEqual([]);
      expect(loaded.records.labels).toEqual([{ id: "label-1" }]);
      expect(loaded.records.comments).toEqual([COMMENT]);
      expect(loaded.records.activity).toEqual([ACTIVITY]);
      expect(loaded.scopes).toEqual(expect.arrayContaining([COMMENT_SCOPE, ACTIVITY_SCOPE]));
      expect(loaded.outbox).toEqual([pending]);
      expect(loaded.meta).toMatchObject({
        cursor: "new-bootstrap",
        lastMutationId: 9,
        serverSchema: 4,
        nextMutationId: 2,
      });
    });

    it("pull upserts and deletes, filters scopes and acknowledges only the specified outbox prefix", async () => {
      await replica.writeBootstrap(
        bootstrap({ issues: [{ id: "old" }, { id: "keep", title: "Before" }] }),
      );
      await replica.writeScope({ scope: COMMENT_SCOPE, records: [COMMENT] });
      await replica.writeScope({ scope: ACTIVITY_SCOPE, records: [ACTIVITY] });
      await replica.appendMutation(mutation);
      const second = await replica.appendMutation(mutation);
      await replica.applyPull({
        cursor: "pull-1",
        acknowledgedUpTo: 1,
        changes: [
          { entity: "issues", id: "old", record: null },
          { entity: "issues", id: "keep", record: { id: "keep", title: "After" } },
          { entity: "issues", id: "new", record: { id: "new" } },
          { entity: "comments", id: COMMENT.id, record: { ...COMMENT, body: "Updated" } },
          { entity: "activity", id: ACTIVITY.id, record: null },
          {
            entity: "comments",
            id: "unloaded-comment",
            record: { id: "unloaded-comment", issue_id: "issue-2" },
          },
          {
            entity: "activity",
            id: "unloaded-activity",
            record: { id: "unloaded-activity", entity_id: "issue-2" },
          },
          { entity: "comments", id: "unloaded-delete", record: null },
        ],
      });
      const loaded = await replica.load();
      expect(loaded.records.issues).toEqual(
        expect.arrayContaining([{ id: "keep", title: "After" }, { id: "new" }]),
      );
      expect(loaded.records.issues).toHaveLength(2);
      expect(loaded.records.comments).toEqual([{ ...COMMENT, body: "Updated" }]);
      expect(loaded.records.activity).toEqual([]);
      expect(loaded.outbox).toEqual([second]);
      expect(loaded.meta).toMatchObject({ cursor: "pull-1", lastMutationId: 1, nextMutationId: 3 });
      await replica.applyPull({ changes: [], cursor: "pull-2", acknowledgedUpTo: null });
      expect((await replica.load()).outbox).toEqual([second]);
      expect((await replica.load()).meta).toMatchObject({ cursor: "pull-2", lastMutationId: 1 });
      await replica.applyPull({ changes: [], cursor: "pull-3", acknowledgedUpTo: 2 });
      expect((await replica.load()).outbox).toEqual([]);
    });

    it("an empty loaded scope admits subsequent pulls and ordered scoped tombstones", async () => {
      await replica.writeScope({ scope: COMMENT_SCOPE, records: [] });
      await replica.writeScope({ scope: ACTIVITY_SCOPE, records: [] });
      await replica.applyPull({
        cursor: "scope-pull",
        acknowledgedUpTo: null,
        changes: [
          { entity: "comments", id: COMMENT.id, record: COMMENT },
          { entity: "activity", id: ACTIVITY.id, record: ACTIVITY },
          { entity: "comments", id: COMMENT.id, record: null },
          { entity: "comments", id: "comment-2", record: { ...COMMENT, id: "comment-2" } },
        ],
      });
      expect((await replica.load()).records.comments).toEqual([{ ...COMMENT, id: "comment-2" }]);
      expect((await replica.load()).records.activity).toEqual([ACTIVITY]);
    });

    it("scope snapshots remove stale rows while preserving other scopes", async () => {
      const otherComment = { ...COMMENT, id: "comment-2", issue_id: "issue-2" };
      await replica.writeScope({ scope: COMMENT_SCOPE, records: [COMMENT] });
      await replica.writeScope({
        scope: { entity: "comments", issueId: "issue-2" },
        records: [otherComment],
      });
      await replica.writeScope({ scope: COMMENT_SCOPE, records: [] });
      expect((await replica.load()).records.comments).toEqual([otherComment]);
      expect((await replica.load()).scopes).toHaveLength(2);
    });

    it("uses user_id for alert preferences and id for members", async () => {
      await replica.writeBootstrap(
        bootstrap({
          alert_preferences: [{ user_id: "user-1", assignment: true }],
          members: [{ id: "user-1", name: "Before" }],
        }),
      );
      await replica.applyPull({
        cursor: "preferences",
        acknowledgedUpTo: null,
        changes: [
          {
            entity: "alert_preferences",
            id: "user-1",
            record: { user_id: "user-1", assignment: false },
          },
          { entity: "members", id: "user-1", record: { id: "user-1", name: "After" } },
        ],
      });
      expect((await replica.load()).records.alert_preferences).toEqual([
        { user_id: "user-1", assignment: false },
      ]);
      expect((await replica.load()).records.members).toEqual([{ id: "user-1", name: "After" }]);
      await replica.applyPull({
        cursor: "deleted",
        acknowledgedUpTo: null,
        changes: [{ entity: "alert_preferences", id: "user-1", record: null }],
      });
      expect((await replica.load()).records.alert_preferences).toEqual([]);
    });

    it("allocates increasing ids across concurrent handles, persists local and allows online-only gaps", async () => {
      const other = await open();
      const [a, b] = await Promise.all([
        replica.appendMutation(mutation),
        other.appendMutation(mutation),
      ]);
      expect([a.id, b.id].sort()).toEqual([1, 2]);
      expect(await other.allocateMutationId()).toBe(3);
      expect((await replica.appendMutation(mutation)).id).toBe(4);
      const loaded = await other.load();
      expect(loaded.outbox.map((item) => item.id)).toEqual([1, 2, 4]);
      for (const item of loaded.outbox)
        expect(item.local).toEqual({ notificationIds: ["notification-1"] });
      expect(loaded.meta.nextMutationId).toBe(5);
    });

    it("isolates persisted values from input and loaded or returned objects", async () => {
      const record = { id: "issue-1", nested: { title: "Original" } };
      await replica.writeBootstrap(bootstrap({ issues: [record] }));
      record.nested.title = "Changed";
      const args = { title: "Original" };
      const returned = await replica.appendMutation(() => ({ ...mutation(1), args }));
      args.title = "Changed";
      returned.name = "changed";
      const loaded = await replica.load();
      loaded.meta.cursor = "changed";
      expect((await replica.load()).records.issues).toEqual([
        { id: "issue-1", nested: { title: "Original" } },
      ]);
      expect((await replica.load()).outbox[0]).toMatchObject({
        name: "update_issue",
        args: { title: "Original" },
      });
      expect((await replica.load()).meta.cursor).toBe("bootstrap");
    });

    it("a mid-pull clone failure rolls back records, cursor and acknowledgement", async () => {
      await replica.writeBootstrap(bootstrap({ issues: [{ id: "issue-1", title: "Before" }] }));
      await replica.appendMutation(mutation);
      const before = await replica.load();
      await expect(
        replica.applyPull({
          cursor: "failed",
          acknowledgedUpTo: 1,
          changes: [
            { entity: "issues", id: "issue-1", record: { id: "issue-1", title: "After" } },
            { entity: "issues", id: "uncloneable", record: { id: "uncloneable", fn: () => {} } },
          ],
        }),
      ).rejects.toThrow();
      expect(await replica.load()).toEqual(before);
    });

    it("a bootstrap clone failure rolls back cleared tables and metadata", async () => {
      await replica.writeBootstrap(bootstrap({ issues: [{ id: "old" }] }));
      const before = await replica.load();
      await expect(
        replica.writeBootstrap(bootstrap({ issues: [{ id: "new" }, { id: "bad", fn: () => {} }] })),
      ).rejects.toThrow();
      expect(await replica.load()).toEqual(before);
    });

    it("a scope clone failure rolls back its records and loaded marker", async () => {
      await replica.writeScope({ scope: COMMENT_SCOPE, records: [COMMENT] });
      const before = await replica.load();
      await expect(
        replica.writeScope({
          scope: { entity: "comments", issueId: "issue-2" },
          records: [
            { ...COMMENT, id: "comment-2", issue_id: "issue-2" },
            { id: "bad", fn: () => {} },
          ],
        }),
      ).rejects.toThrow();
      expect(await replica.load()).toEqual(before);
    });

    it("a failed mutation build or clone consumes no id and stores no mutation", async () => {
      await expect(
        replica.appendMutation(() => {
          throw new Error("admission failed");
        }),
      ).rejects.toThrow("admission failed");
      await expect(
        replica.appendMutation(() => ({ ...mutation(1), local: () => {} })),
      ).rejects.toThrow();
      expect((await replica.appendMutation(mutation)).id).toBe(1);
      expect((await replica.load()).outbox).toHaveLength(1);
    });

    it("lists, deletes and prunes replicas by exact session, including deleting everything", async () => {
      const otherWorkspace = { ...INPUT, workspaceId: "workspace-2" };
      const otherSession = { ...INPUT, sessionId: "session-10" };
      await open(otherWorkspace);
      const deleted = await open(otherSession);
      expect(await storage.list()).toEqual(
        expect.arrayContaining(
          [INPUT, otherWorkspace, otherSession].map(({ sessionId, workspaceId }) => ({
            sessionId,
            workspaceId,
          })),
        ),
      );
      expect(await storage.list()).toHaveLength(3);
      await storage.delete(otherWorkspace);
      await storage.delete(otherWorkspace);
      expect(await storage.list()).toHaveLength(2);
      await storage.deleteAllExcept(INPUT.sessionId);
      expect(await storage.list()).toEqual([
        { sessionId: INPUT.sessionId, workspaceId: INPUT.workspaceId },
      ]);
      await expect(deleted.load()).rejects.toThrow();
      const oldClient = (await replica.load()).meta.clientId;
      await storage.deleteAllExcept(null);
      expect(await storage.list()).toEqual([]);
      await expect(replica.load()).rejects.toThrow();
      expect((await (await open()).load()).meta.clientId).not.toBe(oldClient);
    });

    it("closing one handle preserves the replica and other handles", async () => {
      const other = await open();
      replica.close();
      replica.close();
      await expect(replica.load()).rejects.toThrow("replica is closed");
      await expect(replica.allocateMutationId()).rejects.toThrow("replica is closed");
      expect((await other.appendMutation(mutation)).id).toBe(1);
      expect((await (await open()).load()).outbox).toHaveLength(1);
    });
  });
}

function rawOpen(factory: IDBFactory, name: string, version?: number): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(name, version);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

describe("IndexedDB lifecycle", () => {
  it("a layout upgrade removes obsolete stores from a legacy database", async () => {
    const factory = new IDBFactory();
    const legacy = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open(replicaName(INPUT), IDB_VERSION);
      request.onupgradeneeded = () => {
        request.result.createObjectStore("obsolete").put({ stale: true }, "row");
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    legacy.close();
    const replica = await new IndexedDBReplicaStorage({
      indexedDB: factory,
      version: IDB_VERSION + 1,
    }).open(INPUT);
    try {
      const db = await rawOpen(factory, replicaName(INPUT));
      expect([...db.objectStoreNames].sort()).toEqual(
        ["meta", ...ENTITIES, "outbox", "scopes"].sort(),
      );
      db.close();
      expect((await replica.load()).meta.cursor).toBeNull();
    } finally {
      replica.close();
    }
  });

  it("a layout upgrade closes old handles, reports it and recreates every store empty", async () => {
    const factory = new IDBFactory();
    const events: Parameters<ReplicaCloseListener>[0][] = [];
    const storage = new IndexedDBReplicaStorage({
      indexedDB: factory,
      onClose: (event) => {
        events.push(event);
      },
    });
    const old = await storage.open(INPUT);
    const other = await storage.open(INPUT);
    const oldClient = (await old.load()).meta.clientId;
    await old.writeBootstrap(bootstrap({ issues: [{ id: "old" }] }));
    await old.writeScope({ scope: COMMENT_SCOPE, records: [COMMENT] });
    await old.appendMutation(mutation);
    const upgraded = await new IndexedDBReplicaStorage({
      indexedDB: factory,
      version: IDB_VERSION + 1,
    }).open({ ...INPUT, schema: 8 });
    try {
      expect(events).toHaveLength(2);
      for (const event of events)
        expect(event).toMatchObject({
          sessionId: INPUT.sessionId,
          workspaceId: INPUT.workspaceId,
          reason: "versionchange",
        });
      await expect(old.load()).rejects.toThrow("replica is closed");
      await expect(other.load()).rejects.toThrow("replica is closed");
      const loaded = await upgraded.load();
      expect(loaded.meta).toMatchObject({
        schema: 8,
        serverSchema: 0,
        cursor: null,
        lastMutationId: 0,
        nextMutationId: 1,
      });
      expect(loaded.meta.clientId).not.toBe(oldClient);
      expect(loaded.outbox).toEqual([]);
      expect(loaded.scopes).toEqual([]);
      for (const entity of ENTITIES) expect(loaded.records[entity]).toEqual([]);
      const db = await rawOpen(factory, replicaName(INPUT));
      expect([...db.objectStoreNames].sort()).toEqual(
        ["meta", ...ENTITIES, "outbox", "scopes"].sort(),
      );
      db.close();
    } finally {
      upgraded.close();
      old.close();
      other.close();
    }
  });

  it("deletion closes and reports each live connection before resolving", async () => {
    const factory = new IDBFactory();
    const events: Parameters<ReplicaCloseListener>[0][] = [];
    const storage = new IndexedDBReplicaStorage({
      indexedDB: factory,
      onClose: (event) => {
        events.push(event);
      },
    });
    const replica = await storage.open(INPUT);
    await storage.delete(INPUT);
    expect(events).toHaveLength(1);
    expect(events[0].reason).toBe("versionchange");
    await expect(replica.load()).rejects.toThrow("replica is closed");
    expect(await storage.list()).toEqual([]);
  });

  it("an explicit close does not report an external closure", async () => {
    const events: Parameters<ReplicaCloseListener>[0][] = [];
    const storage = new IndexedDBReplicaStorage({
      indexedDB: new IDBFactory(),
      onClose: (event) => {
        events.push(event);
      },
    });
    const replica = await storage.open(INPUT);
    replica.close();
    await storage.delete(INPUT);
    expect(events).toEqual([]);
  });

  it("lists only replica names and pruning leaves unrelated databases intact", async () => {
    const factory = new IDBFactory();
    const unrelated = await rawOpen(factory, "another-app");
    const malformed = await rawOpen(factory, "blackwall:invalid");
    const storage = new IndexedDBReplicaStorage({ indexedDB: factory });
    const replica = await storage.open(INPUT);
    try {
      expect(await storage.list()).toEqual([
        { sessionId: INPUT.sessionId, workspaceId: INPUT.workspaceId },
      ]);
      await storage.deleteAllExcept(null);
      expect((await factory.databases()).map((db) => db.name).sort()).toEqual([
        "another-app",
        "blackwall:invalid",
      ]);
    } finally {
      unrelated.close();
      malformed.close();
      replica.close();
    }
  });

  it("a blocked upgrade rejects and leaves the old replica intact after the blocker closes", async () => {
    const factory = new IDBFactory();
    const storage = new IndexedDBReplicaStorage({ indexedDB: factory });
    const replica = await storage.open(INPUT);
    await replica.writeBootstrap(bootstrap({ issues: [{ id: "old" }] }));
    const before = await replica.load();
    replica.close();
    const blocker = await rawOpen(factory, replicaName(INPUT));
    try {
      await expect(
        new IndexedDBReplicaStorage({ indexedDB: factory, version: IDB_VERSION + 1 }).open(INPUT),
      ).rejects.toThrow("replica open blocked");
    } finally {
      blocker.close();
    }
    const reopened = await storage.open(INPUT);
    try {
      expect(await reopened.load()).toEqual(before);
    } finally {
      reopened.close();
    }
  });

  it("a blocked deletion reports the blocker instead of waiting indefinitely", async () => {
    const factory = new IDBFactory();
    const blocker = await rawOpen(factory, replicaName(INPUT));
    try {
      await expect(
        new IndexedDBReplicaStorage({ indexedDB: factory }).delete(INPUT),
      ).rejects.toThrow("replica delete blocked");
    } finally {
      blocker.close();
    }
    // IDB deletion cannot be cancelled; it completes once the blocker closes.
    await new IndexedDBReplicaStorage({ indexedDB: factory }).delete(INPUT);
    expect(await factory.databases()).toEqual([]);
  });

  it("an unexpected database termination reports closure and rejects future operations", async () => {
    const factory = new IDBFactory();
    const events: Parameters<ReplicaCloseListener>[0][] = [];
    let connection: IDBDatabase | undefined;
    const original = factory.open.bind(factory);
    factory.open = (...args) => {
      const request = original(...args);
      request.addEventListener("success", () => {
        connection = request.result;
      });
      return request;
    };
    const replica = await new IndexedDBReplicaStorage({
      indexedDB: factory,
      onClose: (event) => {
        events.push(event);
      },
    }).open(INPUT);
    if (connection === undefined) throw new Error("connection not captured");
    const closed = new Promise<void>((resolve) => {
      connection?.addEventListener("close", () => resolve());
    });
    // fake-indexeddb types this parameter as a constructor; it takes a connection.
    Reflect.apply(forceCloseDatabase, undefined, [connection]);
    await closed;
    expect(events).toHaveLength(1);
    expect(events[0].reason).toBe("terminated");
    await expect(replica.load()).rejects.toThrow("replica is closed");
  });
});
