import { describe, expect, it } from "vite-plus/test";
import type { Id } from "../../lib/types";
import { normalize } from "../records";
import type { Comment } from "../../lib/types";
import type { Entity, RecordOf } from "../records";
import type { SyncStore } from "../store";
import {
  ADMIN,
  AT,
  COMMENT_ONE,
  COMMENT_OTHER_ISSUE,
  COMMENT_TWO,
  GHOST,
  MEMBER,
  OWNER,
  TIME_ONE,
  TIME_OTHER,
  VIEWER,
  mutate,
  seedStore,
  snapshot,
} from "./fixtures";
import { admit } from "./index";

function liveComment(store: SyncStore, id: string): Comment {
  const comment = store.get("comments", id);
  if (comment === undefined) throw new Error(`missing fixture comment ${id}`);
  return comment as Comment;
}

/** Asserts the whole resulting record against an explicit full expected record. */
function expectRecord<E extends Entity>(
  store: SyncStore,
  entity: E,
  id: string,
  expected: RecordOf[E],
): void {
  expect(store.get(entity, id)).toEqual(normalize(entity, expected));
}

const TOUCHED: readonly Entity[] = ["comments", "time_entries", "issues"];

function beforeAll(store: SyncStore): { entity: Entity; rows: RecordOf[Entity][] }[] {
  return TOUCHED.map((entity) => ({ entity, rows: snapshot(store, entity) }));
}

function expectSame(store: SyncStore, before: { entity: Entity; rows: unknown }[]): void {
  for (const { entity, rows } of before) {
    expect(snapshot(store, entity)).toEqual(rows);
  }
}

/**
 * Runs a mutation that must fail: asserts the replay error carries the
 * server's status and message, and that the view is unchanged.
 */
function rejects(
  name: string,
  args: unknown,
  status: number,
  message: string,
  actor: Id = MEMBER,
): void {
  const store = seedStore(actor);
  const before = beforeAll(store);
  const id = mutate(store, name, args);
  const error = store.replayErrors().get(id);
  expect(error?.status).toBe(status);
  expect(error?.message).toBe(message);
  expectSame(store, before);
}

/**
 * Admission rejects without writing: asserts `admit` throws the server's
 * status and message and leaves the view unchanged.
 */
function admitsRejects(
  name: string,
  args: unknown,
  status: number,
  message: string,
  actor: Id = MEMBER,
): void {
  const store = seedStore(actor);
  const before = beforeAll(store);
  let error: unknown;
  try {
    admit(store, actor, { name, args, at: AT });
  } catch (caught) {
    error = caught;
  }
  const record = error as { status?: number; message?: string } | undefined;
  expect(record?.status).toBe(status);
  expect(record?.message).toBe(message);
  expectSame(store, before);
  expect(store.replayErrors().size).toBe(0);
}

/** Running a mutation twice leaves the same view as running it once, with no errors. */
function twice(name: string, args: unknown, actor: Id = MEMBER): void {
  const once = seedStore(actor);
  mutate(once, name, args);
  expect(once.replayErrors().size).toBe(0);
  const first = beforeAll(once);
  const both = seedStore(actor);
  mutate(both, name, args);
  mutate(both, name, args);
  expect(both.replayErrors().size).toBe(0);
  expectSame(both, first);
}

describe("add_comment", () => {
  it("makes the author and mentioned members followers", () => {
    const store = seedStore();
    mutate(store, "add_comment", {
      id: "comment-follow",
      issue_id: "issue-2",
      body: "Looping in",
      mentions: [ADMIN],
    });
    const followers = store.get("issues", "issue-2")?.followers;
    expect(followers).toContain(MEMBER);
    expect(followers).toContain(ADMIN);
  });
  it("materializes omitted mentions and attachments", () => {
    const args = { id: "comment-defaults", issue_id: "issue-1", body: "Defaults" };
    const store = seedStore();
    admit(store, MEMBER, { name: "add_comment", args, at: AT });
    mutate(store, "add_comment", args);
    expectRecord(store, "comments", args.id, {
      id: args.id,
      version: 1,
      issue_id: args.issue_id,
      author: MEMBER,
      body: args.body,
      mentions: [],
      attachments: [],
      created_at: AT,
      edited_at: null,
      via: null,
      tracker: null,
    });
    twice("add_comment", args);
  });
  it("creates with the actor as author and sorted mentions", () => {
    const store = seedStore();
    mutate(store, "add_comment", {
      id: "comment-new",
      issue_id: "issue-1",
      body: "Hey",
      mentions: [OWNER, ADMIN, ADMIN],
      attachments: [],
    });
    expectRecord(store, "comments", "comment-new", {
      id: "comment-new",
      version: 1,
      issue_id: "issue-1",
      author: MEMBER,
      body: "Hey",
      mentions: [ADMIN, OWNER],
      attachments: [],
      created_at: AT,
      edited_at: null,
      via: null,
      tracker: null,
    });
  });

  it("writes comments for issues without loaded comments", () => {
    const store = seedStore();
    store.applyBase([
      { entity: "comments", id: COMMENT_ONE, record: null },
      { entity: "comments", id: COMMENT_TWO, record: null },
    ]);
    mutate(store, "add_comment", {
      id: "comment-new",
      issue_id: "issue-1",
      body: "First here",
      mentions: [],
      attachments: [],
    });
    expect(liveComment(store, "comment-new").body).toBe("First here");
  });

  it("moves attachments from the issue to the comment, using stored metadata", () => {
    const store = seedStore();
    store.applyBase([
      {
        entity: "issues",
        id: "issue-attached",
        record: {
          ...(store.get("issues", "issue-attached") as object),
          attachments: [
            { id: "att-1", name: "spec.txt", content_type: "text/plain", size: 12 },
            { id: "att-2", name: "plan.txt", content_type: "text/plain", size: 7 },
          ],
        },
      },
    ]);
    const before = store.get("issues", "issue-attached");
    if (before === undefined) throw new Error("missing issue");
    const args = {
      id: "comment-move",
      issue_id: "issue-attached",
      body: "See attached",
      mentions: [],
      // Argument metadata is ignored: the server moves the stored uploads,
      // ordered by attachment id.
      attachments: [
        { id: "att-2", name: "wrong.txt", content_type: "text/plain", size: 1 },
        { id: "att-1", name: "wrong.txt", content_type: "text/plain", size: 1 },
      ],
    };
    admit(store, MEMBER, { name: "add_comment", args, at: AT });
    mutate(store, "add_comment", args);
    const expectedAttachments = [
      { id: "att-1", name: "spec.txt", content_type: "text/plain", size: 12 },
      { id: "att-2", name: "plan.txt", content_type: "text/plain", size: 7 },
    ];
    expectRecord(store, "comments", args.id, {
      id: args.id,
      version: 1,
      issue_id: args.issue_id,
      author: MEMBER,
      body: args.body,
      mentions: [],
      attachments: expectedAttachments,
      created_at: AT,
      edited_at: null,
      via: null,
      tracker: null,
    });
    expect(store.get("issues", "issue-attached")).toEqual({
      ...before,
      attachments: [],
      followers: [...new Set([...before.followers, MEMBER])].sort(),
    });
    const once = beforeAll(store);
    mutate(store, "add_comment", args);
    expect(store.replayErrors().size).toBe(0);
    expectSame(store, once);
  });

  it("rejects attachments that are not on the issue", () => {
    rejects(
      "add_comment",
      {
        id: "comment-missing",
        issue_id: "issue-attached",
        body: "B",
        mentions: [],
        attachments: [{ id: "att-ghost", name: "g.txt", content_type: "text/plain", size: 1 }],
      },
      400,
      "attachment must be uploaded to this issue first",
    );
  });

  it("allows archived issues", () => {
    const store = seedStore();
    mutate(store, "add_comment", {
      id: "comment-arch",
      issue_id: "issue-archived",
      body: "On archived",
      mentions: [],
      attachments: [],
    });
    expect(liveComment(store, "comment-arch").body).toBe("On archived");
  });

  it("creates are upserts", () => {
    twice("add_comment", {
      id: "comment-new",
      issue_id: "issue-1",
      body: "Hey",
      mentions: [],
      attachments: [],
    });
  });

  it("validates the issue, body, mentions and id", () => {
    const base = { id: "c", issue_id: "issue-1", body: "B", mentions: [], attachments: [] };
    rejects("add_comment", { ...base, issue_id: "issue-ghost" }, 404, "not found");
    rejects("add_comment", { ...base, issue_id: "issue-deleted" }, 404, "not found");
    rejects("add_comment", { ...base, body: "  " }, 400, "text must contain 1 to 100000 bytes");
    rejects("add_comment", { ...base, mentions: [GHOST] }, 403, "permission denied");
    rejects(
      "add_comment",
      { issue_id: "issue-1", body: "B", mentions: [], attachments: [] },
      400,
      "id is required",
    );
    rejects(
      "add_comment",
      { ...base, id: "00000000-0000-0000-0000-000000000000" },
      400,
      "id must not be nil",
    );
  });

  it("enforces the viewer rule", () => {
    const base = { id: "c", issue_id: "issue-1", body: "B", mentions: [], attachments: [] };
    rejects("add_comment", base, 403, "permission denied", VIEWER);
    rejects("add_comment", base, 403, "permission denied", GHOST);
  });
});

describe("edit_comment", () => {
  it("edits the body and mentions and stamps edited_at", () => {
    const store = seedStore();
    const before = liveComment(store, COMMENT_ONE);
    mutate(store, "edit_comment", { id: COMMENT_ONE, body: "Edited", mentions: [] });
    expectRecord(store, "comments", COMMENT_ONE, {
      ...before,
      body: "Edited",
      mentions: [],
      edited_at: AT,
    });
  });

  it("admins may edit others' comments without touching attachments", () => {
    const store = seedStore(ADMIN);
    const before = liveComment(store, COMMENT_TWO);
    mutate(store, "edit_comment", { id: COMMENT_TWO, body: "Fixed", mentions: [MEMBER] });
    expectRecord(store, "comments", COMMENT_TWO, {
      ...before,
      body: "Fixed",
      mentions: [MEMBER],
      edited_at: AT,
    });
  });

  it("makes newly mentioned members followers", () => {
    const store = seedStore(OWNER);
    mutate(store, "edit_comment", { id: COMMENT_OTHER_ISSUE, body: "cc", mentions: [ADMIN] });
    expect(store.get("issues", "issue-2")?.followers).toEqual([ADMIN]);
  });

  it("is idempotent", () => {
    twice("edit_comment", { id: COMMENT_ONE, body: "Edited", mentions: [] });
  });

  it("validates the body before the lookup", () => {
    rejects(
      "edit_comment",
      { id: "comment-ghost", body: "", mentions: [] },
      400,
      "text must contain 1 to 100000 bytes",
    );
    rejects("edit_comment", { id: "comment-ghost", body: "B", mentions: [] }, 404, "not found");
    admitsRejects(
      "edit_comment",
      { id: "comment-ghost", body: "B", mentions: [] },
      404,
      "not found",
    );
  });

  it("enforces author or admin and member mentions", () => {
    rejects("edit_comment", { id: COMMENT_TWO, body: "B", mentions: [] }, 403, "permission denied");
    rejects(
      "edit_comment",
      { id: COMMENT_ONE, body: "B", mentions: [GHOST] },
      403,
      "permission denied",
    );
    rejects(
      "edit_comment",
      { id: COMMENT_ONE, body: "B", mentions: [] },
      403,
      "permission denied",
      VIEWER,
    );
    rejects(
      "edit_comment",
      { id: COMMENT_ONE, body: "B", mentions: [] },
      403,
      "permission denied",
      GHOST,
    );
  });
});

describe("delete_comment", () => {
  it("deletes the comment", () => {
    const store = seedStore();
    mutate(store, "delete_comment", { id: COMMENT_ONE });
    expect(store.get("comments", COMMENT_ONE)).toBeUndefined();
    expect(liveComment(store, COMMENT_TWO).body).toBe("Reply");
  });

  it("admins may delete others' comments", () => {
    const store = seedStore(ADMIN);
    mutate(store, "delete_comment", { id: COMMENT_ONE });
    expect(store.replayErrors().size).toBe(0);
    expect(store.get("comments", COMMENT_ONE)).toBeUndefined();
  });

  it("running twice keeps the view", () => {
    twice("delete_comment", { id: COMMENT_ONE });
  });

  it("replays a missing comment as a no-op but admission fails", () => {
    const replayed = seedStore();
    replayed.applyBase([{ entity: "comments", id: COMMENT_ONE, record: null }]);
    const before = beforeAll(replayed);
    const id = mutate(replayed, "delete_comment", { id: COMMENT_ONE });
    expect(replayed.replayErrors().get(id)).toBeUndefined();
    expectSame(replayed, before);
    admitsRejects("delete_comment", { id: "comment-ghost" }, 404, "not found");
  });

  it("enforces author or admin", () => {
    rejects("delete_comment", { id: COMMENT_TWO }, 403, "permission denied");
    rejects("delete_comment", { id: COMMENT_ONE }, 403, "permission denied", VIEWER);
    rejects("delete_comment", { id: COMMENT_ONE }, 403, "permission denied", GHOST);
  });
});

describe("log_time", () => {
  it("materializes an omitted note", () => {
    const args = { id: "time-defaults", issue_id: "issue-1", minutes: 15, logged_at: AT };
    const store = seedStore();
    admit(store, MEMBER, { name: "log_time", args, at: AT });
    mutate(store, "log_time", args);
    expectRecord(store, "time_entries", args.id, {
      ...args,
      version: 1,
      user_id: MEMBER,
      note: "",
    });
    twice("log_time", args);
  });
  it("logs with the actor as user", () => {
    const store = seedStore();
    mutate(store, "log_time", {
      id: "time-new",
      issue_id: "issue-1",
      minutes: 45,
      note: "More",
      logged_at: "2026-10-09T08:00:00.000Z",
    });
    expectRecord(store, "time_entries", "time-new", {
      id: "time-new",
      version: 1,
      issue_id: "issue-1",
      user_id: MEMBER,
      minutes: 45,
      note: "More",
      logged_at: "2026-10-09T08:00:00.000Z",
    });
  });

  it("allows archived issues", () => {
    const store = seedStore();
    mutate(store, "log_time", {
      id: "time-arch",
      issue_id: "issue-archived",
      minutes: 15,
      note: "",
      logged_at: "2026-10-09T08:00:00.000Z",
    });
    expect(store.replayErrors().size).toBe(0);
  });

  it("creates are upserts", () => {
    twice("log_time", {
      id: "time-new",
      issue_id: "issue-1",
      minutes: 45,
      note: "",
      logged_at: "2026-10-09T08:00:00.000Z",
    });
  });

  it("validates the issue, entry and id", () => {
    const base = {
      id: "t",
      issue_id: "issue-1",
      minutes: 30,
      note: "",
      logged_at: "2026-10-09T08:00:00.000Z",
    };
    rejects("log_time", { ...base, issue_id: "issue-ghost" }, 404, "not found");
    rejects("log_time", { ...base, issue_id: "issue-deleted" }, 404, "not found");
    rejects("log_time", { ...base, minutes: 0 }, 400, "time entry must contain 1 to 1440 minutes");
    rejects(
      "log_time",
      { ...base, minutes: 1441 },
      400,
      "time entry must contain 1 to 1440 minutes",
    );
    rejects(
      "log_time",
      { ...base, note: "n".repeat(10_001) },
      400,
      "time entry must contain 1 to 1440 minutes",
    );
    rejects(
      "log_time",
      { ...base, logged_at: "tomorrow" },
      400,
      "timestamp year must be between 1 and 9999",
    );
    rejects(
      "log_time",
      { issue_id: "issue-1", minutes: 30, note: "", logged_at: base.logged_at },
      400,
      "id is required",
    );
    rejects(
      "log_time",
      { ...base, id: "00000000-0000-0000-0000-000000000000" },
      400,
      "id must not be nil",
    );
  });

  it("enforces the viewer rule", () => {
    const base = {
      id: "t",
      issue_id: "issue-1",
      minutes: 30,
      note: "",
      logged_at: "2026-10-09T08:00:00.000Z",
    };
    rejects("log_time", base, 403, "permission denied", VIEWER);
    rejects("log_time", base, 403, "permission denied", GHOST);
  });
});

describe("update_time", () => {
  it("updates minutes, note and logged_at", () => {
    const store = seedStore();
    const before = store.get("time_entries", TIME_ONE);
    if (before === undefined) throw new Error("missing time entry");
    mutate(store, "update_time", {
      id: TIME_ONE,
      minutes: 60,
      note: "Revised",
      logged_at: "2026-10-10T08:00:00.000Z",
    });
    expectRecord(store, "time_entries", TIME_ONE, {
      ...(before as RecordOf["time_entries"]),
      minutes: 60,
      note: "Revised",
      logged_at: "2026-10-10T08:00:00.000Z",
    });
  });

  it("admins may update others' entries", () => {
    const store = seedStore(ADMIN);
    mutate(store, "update_time", {
      id: TIME_ONE,
      minutes: 60,
      note: "",
      logged_at: "2026-10-10T08:00:00.000Z",
    });
    expect(store.replayErrors().size).toBe(0);
    expect(store.get("time_entries", TIME_ONE)?.minutes).toBe(60);
  });

  it("is idempotent", () => {
    twice("update_time", {
      id: TIME_ONE,
      minutes: 60,
      note: "R",
      logged_at: "2026-10-10T08:00:00.000Z",
    });
  });

  it("validates the entry before the lookup", () => {
    const base = { id: "time-ghost", minutes: 30, note: "", logged_at: "2026-10-09T08:00:00.000Z" };
    rejects(
      "update_time",
      { ...base, minutes: 0 },
      400,
      "time entry must contain 1 to 1440 minutes",
    );
    rejects("update_time", base, 404, "not found");
    admitsRejects("update_time", base, 404, "not found");
  });

  it("enforces author or admin", () => {
    const base = { id: TIME_OTHER, minutes: 30, note: "", logged_at: "2026-10-09T08:00:00.000Z" };
    rejects("update_time", base, 403, "permission denied");
    rejects("update_time", { ...base, id: TIME_ONE }, 403, "permission denied", VIEWER);
    rejects("update_time", { ...base, id: TIME_ONE }, 403, "permission denied", GHOST);
  });
});

describe("delete_time", () => {
  it("deletes the entry", () => {
    const store = seedStore();
    mutate(store, "delete_time", { id: TIME_ONE });
    expect(store.get("time_entries", TIME_ONE)).toBeUndefined();
  });

  it("admins may delete others' entries", () => {
    const store = seedStore(ADMIN);
    mutate(store, "delete_time", { id: TIME_ONE });
    expect(store.replayErrors().size).toBe(0);
  });

  it("running twice keeps the view", () => {
    twice("delete_time", { id: TIME_ONE });
  });

  it("replays a missing entry as a no-op but admission fails", () => {
    const replayed = seedStore();
    replayed.applyBase([{ entity: "time_entries", id: TIME_ONE, record: null }]);
    const before = beforeAll(replayed);
    const id = mutate(replayed, "delete_time", { id: TIME_ONE });
    expect(replayed.replayErrors().get(id)).toBeUndefined();
    expectSame(replayed, before);
    admitsRejects("delete_time", { id: "time-ghost" }, 404, "not found");
  });

  it("enforces author or admin", () => {
    rejects("delete_time", { id: TIME_OTHER }, 403, "permission denied");
    rejects("delete_time", { id: TIME_ONE }, 403, "permission denied", VIEWER);
    rejects("delete_time", { id: TIME_ONE }, 403, "permission denied", GHOST);
  });
});
