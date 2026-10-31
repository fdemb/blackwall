import "fake-indexeddb/auto";
import { forceCloseDatabase, IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { BOOTSTRAP_ENTITIES, BOOTSTRAP_REPLACED_ENTITIES, ENTITIES } from "../records";
import type { Entity } from "../records";
import { SyncStore } from "../store";
import type { PendingMutation } from "../store";
import { IDB_VERSION, IndexedDBReplicaStorage } from "./idb";
import { MemoryReplicaStorage } from "./memory";
import { replicaName } from "./shared";
import type { Replica, ReplicaCloseListener, ReplicaStorage, Scope } from "./types";

const INPUT = { userId: "user-1", workspaceId: "workspace-1", schema: 7 };
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
      // A schema mismatch remains visible until the engine calls resetBase.
      expect((await (await open({ ...INPUT, schema: 8 })).load()).meta.schema).toBe(7);
    });

    it("shares one client id across simultaneous first opens", async () => {
      const [a, b] = await Promise.all([
        open({ ...INPUT, workspaceId: "new" }),
        open({ ...INPUT, workspaceId: "new" }),
      ]);
      expect((await a.load()).meta.clientId).toBe((await b.load()).meta.clientId);
    });

    it("resetBase clears all records and scopes but keeps meta ids and the outbox", async () => {
      await replica.writeBootstrap(
        bootstrap(
          Object.fromEntries(ENTITIES.map((entity) => [entity, [{ id: entity, user_id: entity }]])),
        ),
      );
      await replica.writeScope({ scope: COMMENT_SCOPE, records: [COMMENT] });
      await replica.writeScope({ scope: ACTIVITY_SCOPE, records: [ACTIVITY] });
      await replica.appendMutation(mutation);
      await replica.appendMutation(mutation);
      await replica.applyPull({ changes: [], cursor: "pull", acknowledgedUpTo: 1 });
      const before = await replica.load();
      const other = await open({ ...INPUT, schema: INPUT.schema + 1 });
      await other.resetBase();
      const loaded = await replica.load();
      expect(loaded.meta).toEqual({
        ...before.meta,
        schema: INPUT.schema + 1,
        serverSchema: 0,
        cursor: null,
      });
      expect(loaded.outbox).toEqual(before.outbox);
      expect(loaded.scopes).toEqual([]);
      for (const entity of ENTITIES) expect(loaded.records[entity]).toEqual([]);
      expect((await other.appendMutation(mutation)).id).toBe(before.meta.nextMutationId);
      await replica.writeBootstrap(bootstrap());
      expect((await replica.load()).meta.lastMutationId).toBe(1);
      expect((await replica.load()).outbox).toHaveLength(2);
    });

    it("discard keeps the rejection and removes its mutation from the outbox for good", async () => {
      await replica.appendMutation(mutation);
      await replica.appendMutation(mutation);
      const rejection = {
        id: 1,
        status: 500,
        message: "kept",
        command: { name: "update_issue", args: { id: "issue-1" } },
      };
      await replica.discard([rejection]);
      const loaded = await replica.load();
      expect(loaded.outbox.map((m) => m.id)).toEqual([2]);
      expect(loaded.rejected).toEqual([rejection]);
      expect(loaded.meta.nextMutationId).toBe(3);
    });

    it("keeps the access-lost marker across writes and handles until it is cleared", async () => {
      expect((await replica.load()).meta.accessLost).toBeUndefined();
      await replica.setAccessLost(true);
      await replica.appendMutation(mutation);
      await replica.writeBootstrap(bootstrap());
      replica.close();
      replica = await open();
      expect((await replica.load()).meta.accessLost).toBe(true);
      await replica.setAccessLost(false);
      expect((await replica.load()).meta.accessLost).toBe(false);
    });

    it("bootstrap replaces listed entities, empties omitted ones and clears scopes", async () => {
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
      const unacknowledged = await replica.appendMutation(mutation);
      await replica.writeBootstrap({
        ...bootstrap({ issues: [{ id: "new" }] }, ["issues", "teams"]),
        cursor: "new-bootstrap",
        lastMutationId: pending.id,
        serverSchema: 4,
      });
      const loaded = await replica.load();
      expect(loaded.records.issues).toEqual([{ id: "new" }]);
      expect(loaded.records.teams).toEqual([]);
      expect(loaded.records.labels).toEqual([{ id: "label-1" }]);
      expect(loaded.records.comments).toEqual([]);
      expect(loaded.records.activity).toEqual([]);
      expect(loaded.scopes).toEqual([]);
      expect(loaded.outbox).toEqual([unacknowledged]);
      expect(loaded.meta).toMatchObject({
        cursor: "new-bootstrap",
        lastMutationId: 1,
        serverSchema: 4,
        nextMutationId: 3,
      });
      const store = new SyncStore(() => {});
      store.replaceBase({ comments: [COMMENT], activity: [ACTIVITY] }, ["comments", "activity"]);
      store.replaceBase(
        { comments: loaded.records.comments, activity: loaded.records.activity },
        BOOTSTRAP_REPLACED_ENTITIES,
      );
      expect(store.all("comments")).toEqual([]);
      expect(store.all("activity")).toEqual([]);
      await replica.applyPull({
        cursor: "after-bootstrap",
        acknowledgedUpTo: null,
        changes: [
          { entity: "comments", id: COMMENT.id, record: COMMENT },
          { entity: "activity", id: ACTIVITY.id, record: ACTIVITY },
        ],
      });
      expect((await replica.load()).records.comments).toEqual([]);
      expect((await replica.load()).records.activity).toEqual([]);
      await replica.writeScope({
        scope: COMMENT_SCOPE,
        records: [{ ...COMMENT, body: "Reloaded" }],
      });
      expect((await replica.load()).records.comments).toEqual([{ ...COMMENT, body: "Reloaded" }]);
    });

    it.each(["pull", "bootstrap"])("%s acknowledgements never move backwards", async (source) => {
      const pending = [];
      for (let index = 0; index < 8; index += 1)
        pending.push(await replica.appendMutation(mutation));
      await replica.applyPull({ changes: [], cursor: "ack-7", acknowledgedUpTo: 7 });
      if (source === "pull") {
        await replica.applyPull({ changes: [], cursor: "ack-3", acknowledgedUpTo: 3 });
      } else await replica.writeBootstrap({ ...bootstrap(), lastMutationId: 3 });
      const loaded = await replica.load();
      expect(loaded.meta.lastMutationId).toBe(7);
      expect(loaded.meta.nextMutationId).toBe(9);
      expect(loaded.outbox).toEqual([pending[7]]);
    });

    it.each(["pull", "bootstrap"])(
      "a stale %s acknowledgement trims to the stored high-water mark",
      async (source) => {
        await replica.writeBootstrap({ ...bootstrap(), lastMutationId: 7 });
        const pending = [];
        for (let index = 0; index < 8; index += 1)
          pending.push(await replica.appendMutation(mutation));
        if (source === "pull") {
          await replica.applyPull({ changes: [], cursor: "ack-3", acknowledgedUpTo: 3 });
        } else await replica.writeBootstrap({ ...bootstrap(), lastMutationId: 3 });
        const loaded = await replica.load();
        expect(loaded.meta.lastMutationId).toBe(7);
        expect(loaded.outbox).toEqual([pending[7]]);
      },
    );

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

    it("keeps acknowledged mutations until their results are confirmed", async () => {
      const first = await replica.appendMutation(() => mutation(1));
      const second = await replica.appendMutation(() => mutation(2));
      const third = await replica.appendMutation(() => mutation(3));
      await replica.confirm([second.id]);
      await replica.applyPull({ changes: [], cursor: "pull-1", acknowledgedUpTo: 2 });
      let loaded = await replica.load();
      expect(loaded.outbox).toEqual([third]);
      expect(loaded.unconfirmed).toEqual([first]);
      expect(await replica.loadOutbox()).toEqual([third]);
      await replica.confirm([first.id, third.id]);
      loaded = await replica.load();
      expect(loaded.unconfirmed).toEqual([]);
      expect(loaded.outbox).toEqual([third]);
      await replica.applyPull({ changes: [], cursor: "pull-2", acknowledgedUpTo: 3 });
      loaded = await replica.load();
      expect(loaded.outbox).toEqual([]);
      expect(loaded.unconfirmed).toEqual([]);
    });

    it("replaces and reads one scope without touching other scopes' records", async () => {
      const other = { id: "comment-2", issue_id: "issue-2", body: "Other" };
      await replica.writeScope({
        scope: { entity: "comments", issueId: "issue-2" },
        records: [other],
      });
      await replica.writeScope({ scope: COMMENT_SCOPE, records: [COMMENT] });
      await replica.writeScope({ scope: COMMENT_SCOPE, records: [] });
      expect(await replica.loadScope(COMMENT_SCOPE)).toEqual({ loaded: true, records: [] });
      expect(await replica.loadScope({ entity: "comments", issueId: "issue-2" })).toEqual({
        loaded: true,
        records: [other],
      });
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

    it("loadScope returns the marker and only the records of that scope", async () => {
      const otherComment = { ...COMMENT, id: "comment-2", issue_id: "issue-2" };
      expect(await replica.loadScope(COMMENT_SCOPE)).toEqual({ loaded: false, records: [] });
      await replica.writeScope({ scope: COMMENT_SCOPE, records: [COMMENT] });
      await replica.writeScope({
        scope: { entity: "comments", issueId: "issue-2" },
        records: [otherComment],
      });
      expect(await replica.loadScope(COMMENT_SCOPE)).toEqual({
        loaded: true,
        records: [COMMENT],
      });
      await replica.writeScope({ scope: ACTIVITY_SCOPE, records: [ACTIVITY] });
      expect(await replica.loadScope(ACTIVITY_SCOPE)).toEqual({
        loaded: true,
        records: [ACTIVITY],
      });
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

    it("allocates increasing ids across concurrent handles and persists local", async () => {
      const other = await open();
      const [a, b] = await Promise.all([
        replica.appendMutation(mutation),
        other.appendMutation(mutation),
      ]);
      expect([a.id, b.id].sort()).toEqual([1, 2]);
      await replica.applyPull({ changes: [], cursor: "flushed", acknowledgedUpTo: 2 });
      expect((await replica.appendMutation(mutation)).id).toBe(3);
      const loaded = await other.load();
      expect(loaded.outbox.map((item) => item.id)).toEqual([3]);
      for (const item of loaded.outbox)
        expect(item.local).toEqual({ notificationIds: ["notification-1"] });
      expect(loaded.meta.nextMutationId).toBe(4);
    });

    it("reports a deleted replica to its open handles, but not to a handle closed explicitly", async () => {
      const reports: string[] = [];
      const closed = await storage.open({ ...INPUT, onClose: () => reports.push("closed") });
      await storage.open({ ...INPUT, onClose: (reason) => reports.push(reason) });
      closed.close();
      await storage.delete(INPUT);
      expect(reports).toEqual(["versionchange"]);
    });

    it("loads only the outbox, ascending by id, and matches the outbox of a full load", async () => {
      for (let index = 0; index < 3; index += 1) await replica.appendMutation(mutation);
      await replica.applyPull({ changes: [], cursor: "flushed", acknowledgedUpTo: 1 });
      const outbox = await replica.loadOutbox();
      expect(outbox.map((item) => item.id)).toEqual([2, 3]);
      expect(outbox).toEqual((await replica.load()).outbox);
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
      await replica.writeScope({ scope: COMMENT_SCOPE, records: [COMMENT] });
      await replica.writeScope({ scope: ACTIVITY_SCOPE, records: [ACTIVITY] });
      await replica.appendMutation(mutation);
      const before = await replica.load();
      await expect(
        replica.writeBootstrap({
          ...bootstrap({ issues: [{ id: "new" }, { id: "bad", fn: () => {} }] }),
          lastMutationId: 1,
        }),
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

    it("lists and deletes replicas by exact user and workspace", async () => {
      const otherWorkspace = { ...INPUT, workspaceId: "workspace-2" };
      const otherUser = { ...INPUT, userId: "user-10" };
      await open(otherWorkspace);
      const deleted = await open(otherUser);
      expect(await storage.list()).toEqual(
        expect.arrayContaining(
          [INPUT, otherWorkspace, otherUser].map(({ userId, workspaceId }) => ({
            userId,
            workspaceId,
          })),
        ),
      );
      expect(await storage.list()).toHaveLength(3);
      await storage.delete(otherWorkspace);
      await storage.delete(otherWorkspace);
      expect(await storage.list()).toHaveLength(2);
      await storage.delete(otherUser);
      expect(await storage.list()).toEqual([
        { userId: INPUT.userId, workspaceId: INPUT.workspaceId },
      ]);
      await expect(deleted.load()).rejects.toThrow();
      const oldClient = (await replica.load()).meta.clientId;
      await storage.delete(INPUT);
      expect(await storage.list()).toEqual([]);
      await expect(replica.load()).rejects.toThrow();
      expect((await (await open()).load()).meta.clientId).not.toBe(oldClient);
    });

    it("closing one handle preserves the replica and other handles", async () => {
      const other = await open();
      replica.close();
      replica.close();
      await expect(replica.load()).rejects.toThrow("replica is closed");
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
        ["meta", ...ENTITIES, "outbox", "scopes", "rejected"].sort(),
      );
      db.close();
      expect((await replica.load()).meta.cursor).toBeNull();
    } finally {
      replica.close();
    }
  });

  it("a layout upgrade closes old handles and preserves meta ids and the outbox", async () => {
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
    await old.writeBootstrap(
      bootstrap(
        Object.fromEntries(ENTITIES.map((entity) => [entity, [{ id: entity, user_id: entity }]])),
      ),
    );
    await old.writeScope({ scope: COMMENT_SCOPE, records: [COMMENT] });
    await old.writeScope({ scope: ACTIVITY_SCOPE, records: [ACTIVITY] });
    await old.appendMutation(mutation);
    await old.appendMutation(mutation);
    await old.applyPull({ changes: [], cursor: "old-pull", acknowledgedUpTo: 1 });
    const before = await old.load();
    const upgraded = await new IndexedDBReplicaStorage({
      indexedDB: factory,
      version: IDB_VERSION + 1,
    }).open({ ...INPUT, schema: 8 });
    try {
      expect(events).toHaveLength(2);
      for (const event of events)
        expect(event).toMatchObject({
          userId: INPUT.userId,
          workspaceId: INPUT.workspaceId,
          reason: "versionchange",
          newVersion: IDB_VERSION + 1,
        });
      await expect(old.load()).rejects.toThrow("replica is closed");
      await expect(other.load()).rejects.toThrow("replica is closed");
      const loaded = await upgraded.load();
      expect(loaded.meta).toEqual({
        ...before.meta,
        schema: 8,
        serverSchema: 0,
        cursor: null,
      });
      expect(loaded.outbox).toEqual(before.outbox);
      expect(loaded.scopes).toEqual([]);
      for (const entity of ENTITIES) expect(loaded.records[entity]).toEqual([]);
      const db = await rawOpen(factory, replicaName(INPUT));
      expect([...db.objectStoreNames].sort()).toEqual(
        ["meta", ...ENTITIES, "outbox", "scopes", "rejected"].sort(),
      );
      db.close();
      expect((await upgraded.appendMutation(mutation)).id).toBe(before.meta.nextMutationId);
      const after = await upgraded.load();
      upgraded.close();
      const reopened = await new IndexedDBReplicaStorage({
        indexedDB: factory,
        version: IDB_VERSION + 1,
      }).open({ ...INPUT, schema: 8 });
      try {
        expect(await reopened.load()).toEqual(after);
      } finally {
        reopened.close();
      }
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
    expect(events[0]).toMatchObject({ reason: "versionchange", newVersion: null });
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

  it("lists only replica names and deleting leaves unrelated databases intact", async () => {
    const factory = new IDBFactory();
    const unrelated = await rawOpen(factory, "another-app");
    const malformed = await rawOpen(factory, "blackwall:invalid");
    const storage = new IndexedDBReplicaStorage({ indexedDB: factory });
    const replica = await storage.open(INPUT);
    try {
      expect(await storage.list()).toEqual([
        { userId: INPUT.userId, workspaceId: INPUT.workspaceId },
      ]);
      await storage.delete(INPUT);
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
