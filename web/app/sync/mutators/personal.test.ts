import { describe, expect, it } from "vite-plus/test";
import type { Id } from "../../lib/types";
import { normalize } from "../records";
import type { Entity, RecordOf } from "../records";
import {
  AT,
  GHOST,
  MEMBER,
  NOTIF_OTHER,
  NOTIF_READ,
  NOTIF_UNREAD,
  OWNER,
  VIEWER,
  mutate,
  seedStore,
  snapshot,
} from "./fixtures";
import { admit } from "./index";

const TOUCHED: readonly Entity[] = ["notifications", "alert_preferences"];

function beforeAll(
  store: ReturnType<typeof seedStore>,
): { entity: Entity; rows: RecordOf[Entity][] }[] {
  return TOUCHED.map((entity) => ({ entity, rows: snapshot(store, entity) }));
}

function expectSame(
  store: ReturnType<typeof seedStore>,
  before: { entity: Entity; rows: unknown }[],
): void {
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

/** The notification as the reader sees it now, the way the inbox sends it. */
function seen(store: ReturnType<typeof seedStore>, id: Id): { id: Id; created_at: string } {
  const notification = store.get("notifications", id);
  return { id, created_at: notification?.created_at ?? AT };
}

function unreadSeen(store: ReturnType<typeof seedStore>, actor: Id = MEMBER) {
  return store
    .all("notifications")
    .filter((row) => row.user_id === actor && row.read_at === null)
    .map((row) => seen(store, row.id));
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

/** The server bumped a change notification after the reader saw it. */
function bump(store: ReturnType<typeof seedStore>, id: Id): RecordOf["notifications"] {
  const current = store.get("notifications", id);
  if (current === undefined) throw new Error("missing notification");
  const bumped = {
    ...(current as RecordOf["notifications"]),
    version: current.version + 1,
    read_at: null,
    created_at: "2026-10-09T12:30:00.000000Z",
  };
  store.applyBase([{ entity: "notifications", id, record: bumped }]);
  return normalize("notifications", bumped);
}

describe("mark_notification_read / mark_notification_unread", () => {
  it("marks read and unread with whole records", () => {
    const store = seedStore();
    const unread = store.get("notifications", NOTIF_UNREAD);
    if (unread === undefined) throw new Error("missing notification");
    mutate(store, "mark_notification_read", seen(store, NOTIF_UNREAD));
    expect(store.get("notifications", NOTIF_UNREAD)).toEqual(
      normalize("notifications", { ...(unread as RecordOf["notifications"]), read_at: AT }),
    );
    mutate(store, "mark_notification_unread", { id: NOTIF_UNREAD });
    expect(store.get("notifications", NOTIF_UNREAD)).toEqual(
      normalize("notifications", { ...(unread as RecordOf["notifications"]), read_at: null }),
    );
  });

  it("keeps a notification changed after the read unread", () => {
    const store = seedStore();
    const id = mutate(store, "mark_notification_read", seen(store, NOTIF_UNREAD));
    expect(store.get("notifications", NOTIF_UNREAD)?.read_at).toBe(AT);
    const bumped = bump(store, NOTIF_UNREAD);
    expect(store.replayErrors().get(id)).toBeUndefined();
    expect(store.get("notifications", NOTIF_UNREAD)).toEqual(bumped);
  });

  it("reads a notification changed since, for an older client's command without created_at", () => {
    const store = seedStore();
    const id = mutate(store, "mark_notification_read", { id: NOTIF_UNREAD });
    const bumped = bump(store, NOTIF_UNREAD);
    expect(store.replayErrors().get(id)).toBeUndefined();
    expect(store.get("notifications", NOTIF_UNREAD)).toEqual({ ...bumped, read_at: AT });
  });

  it("replays an already-read notification as a no-op but admission succeeds", () => {
    const replayed = seedStore();
    const before = beforeAll(replayed);
    const args = seen(replayed, NOTIF_READ);
    const id = mutate(replayed, "mark_notification_read", args);
    expect(replayed.replayErrors().get(id)).toBeUndefined();
    expectSame(replayed, before);
    let error: unknown;
    try {
      admit(replayed, MEMBER, { name: "mark_notification_read", args, at: AT });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeUndefined();
  });

  it("replays an already-unread notification as a no-op", () => {
    const replayed = seedStore();
    const before = beforeAll(replayed);
    const id = mutate(replayed, "mark_notification_unread", { id: NOTIF_UNREAD });
    expect(replayed.replayErrors().get(id)).toBeUndefined();
    expectSame(replayed, before);
  });

  it("running twice keeps the view", () => {
    twice("mark_notification_read", seen(seedStore(), NOTIF_UNREAD));
    twice("mark_notification_unread", { id: NOTIF_READ });
  });

  it("rejects missing and foreign notifications with 404", () => {
    admitsRejects(
      "mark_notification_read",
      { id: "notif-ghost", created_at: AT },
      404,
      "not found",
    );
    admitsRejects("mark_notification_read", { id: NOTIF_OTHER, created_at: AT }, 404, "not found");
    admitsRejects("mark_notification_unread", { id: "notif-ghost" }, 404, "not found");
    // Replay over a missing row is a no-op without errors.
    const replayed = seedStore();
    const before = beforeAll(replayed);
    const id = mutate(replayed, "mark_notification_read", { id: "notif-ghost", created_at: AT });
    expect(replayed.replayErrors().get(id)).toBeUndefined();
    expectSame(replayed, before);
  });

  it("viewers may mark their own notifications", () => {
    const store = seedStore(VIEWER);
    const createdAt = "2026-10-08T12:00:00.000000Z";
    store.applyBase([
      {
        entity: "notifications",
        id: "notif-v",
        record: {
          id: "notif-v",
          version: 1,
          user_id: VIEWER,
          issue_id: null,
          kind: "mention",
          message: "Hi",
          read_at: null,
          created_at: createdAt,
          dedup_key: "dv",
        },
      },
    ]);
    mutate(store, "mark_notification_read", { id: "notif-v", created_at: createdAt });
    expect(store.replayErrors().size).toBe(0);
    expect(store.get("notifications", "notif-v")?.read_at).toBe(AT);
    // Reading someone else's notification fails admission as on the server;
    // replay treats the foreign row as absent and stays quiet.
    const foreign = seen(seedStore(), NOTIF_UNREAD);
    admitsRejects("mark_notification_read", foreign, 404, "not found", VIEWER);
    rejects("mark_notification_read", foreign, 403, "permission denied", GHOST);
  });
});

describe("mark_all_notifications_read", () => {
  it("marks every unread notification the reader saw", () => {
    const store = seedStore();
    const unread = store.get("notifications", NOTIF_UNREAD);
    const read = store.get("notifications", NOTIF_READ);
    const other = store.get("notifications", NOTIF_OTHER);
    if (unread === undefined || read === undefined || other === undefined) {
      throw new Error("missing notifications");
    }
    mutate(store, "mark_all_notifications_read", {
      notifications: [...unreadSeen(store), seen(store, NOTIF_READ), seen(store, NOTIF_OTHER)],
    });
    expect(store.replayErrors().size).toBe(0);
    expect(store.get("notifications", NOTIF_UNREAD)).toEqual(
      normalize("notifications", { ...(unread as RecordOf["notifications"]), read_at: AT }),
    );
    // Already-read rows keep their timestamp; others' rows are untouched.
    expect(store.get("notifications", NOTIF_READ)).toEqual(
      normalize("notifications", { ...(read as RecordOf["notifications"]) }),
    );
    expect(store.get("notifications", NOTIF_OTHER)).toEqual(
      normalize("notifications", { ...(other as RecordOf["notifications"]) }),
    );
  });

  it("leaves notifications the reader did not see, or that changed since, unread", () => {
    const store = seedStore();
    const id = mutate(store, "mark_all_notifications_read", { notifications: unreadSeen(store) });
    expect(store.get("notifications", NOTIF_UNREAD)?.read_at).toBe(AT);
    const bumped = bump(store, NOTIF_UNREAD);
    const newer: RecordOf["notifications"] = {
      id: "notif-new",
      version: 1,
      user_id: MEMBER,
      issue_id: "issue-1",
      kind: "mention",
      message: "Later",
      read_at: null,
      created_at: AT,
      dedup_key: "d-new",
    };
    store.applyBase([{ entity: "notifications", id: newer.id, record: newer }]);
    expect(store.replayErrors().get(id)).toBeUndefined();
    expect(store.get("notifications", NOTIF_UNREAD)).toEqual(bumped);
    expect(store.get("notifications", newer.id)).toEqual(normalize("notifications", newer));
  });

  it("reads every unread notification, changed or not, for an older client's command", () => {
    const store = seedStore();
    const read = store.get("notifications", NOTIF_READ);
    const other = store.get("notifications", NOTIF_OTHER);
    const id = mutate(store, "mark_all_notifications_read", {});
    const bumped = bump(store, NOTIF_UNREAD);
    expect(store.replayErrors().get(id)).toBeUndefined();
    expect(store.get("notifications", NOTIF_UNREAD)).toEqual({ ...bumped, read_at: AT });
    expect(store.get("notifications", NOTIF_READ)).toEqual(read);
    expect(store.get("notifications", NOTIF_OTHER)).toEqual(other);
  });

  it("running twice keeps the view", () => {
    twice("mark_all_notifications_read", { notifications: unreadSeen(seedStore()) });
  });

  it("is a no-op when all notifications are already read", () => {
    const store = seedStore(OWNER);
    store.applyBase([
      {
        entity: "notifications",
        id: NOTIF_OTHER,
        record: { ...(store.get("notifications", NOTIF_OTHER) as object), read_at: AT },
      },
    ]);
    const before = beforeAll(store);
    const id = mutate(store, "mark_all_notifications_read", {
      notifications: [seen(store, NOTIF_OTHER)],
    });
    expect(store.replayErrors().get(id)).toBeUndefined();
    expectSame(store, before);
  });

  it("viewers may mark all read but ghosts may not", () => {
    const store = seedStore(VIEWER);
    const id = mutate(store, "mark_all_notifications_read", { notifications: [] });
    expect(store.replayErrors().get(id)).toBeUndefined();
    rejects("mark_all_notifications_read", { notifications: [] }, 403, "permission denied", GHOST);
  });
});

describe("configure_alerts", () => {
  it("updates existing preferences with whole records", () => {
    const store = seedStore();
    const before = store.get("alert_preferences", MEMBER);
    if (before === undefined) throw new Error("missing preferences");
    mutate(store, "configure_alerts", {
      assignment: false,
      reply: false,
      change: false,
      mention: false,
      deadline: false,
      email_assignment: false,
      email_reply: true,
      email_change: true,
      email_mention: true,
      email_deadline: false,
    });
    expect(store.get("alert_preferences", MEMBER)).toEqual({
      ...(before as RecordOf["alert_preferences"]),
      assignment: false,
      reply: false,
      change: false,
      mention: false,
      deadline: false,
      email_assignment: false,
      email_reply: true,
      email_change: true,
      email_mention: true,
      email_deadline: false,
    });
  });

  it("inserts preferences for first-time users", () => {
    const store = seedStore(OWNER);
    mutate(store, "configure_alerts", {
      assignment: true,
      reply: true,
      change: true,
      mention: true,
      deadline: true,
      email_assignment: true,
      email_reply: true,
      email_change: false,
      email_mention: true,
      email_deadline: true,
    });
    expect(store.replayErrors().size).toBe(0);
    expect(store.get("alert_preferences", OWNER)).toEqual({
      user_id: OWNER,
      version: 1,
      assignment: true,
      reply: true,
      change: true,
      mention: true,
      deadline: true,
      email_assignment: true,
      email_reply: true,
      email_change: false,
      email_mention: true,
      email_deadline: true,
    });
  });

  it("is idempotent", () => {
    twice("configure_alerts", {
      assignment: false,
      reply: true,
      change: true,
      mention: true,
      deadline: true,
      email_assignment: true,
      email_reply: true,
      email_change: false,
      email_mention: true,
      email_deadline: true,
    });
  });

  it("viewers may configure alerts but ghosts may not", () => {
    const store = seedStore(VIEWER);
    mutate(store, "configure_alerts", {
      assignment: true,
      reply: true,
      change: true,
      mention: true,
      deadline: true,
      email_assignment: true,
      email_reply: true,
      email_change: false,
      email_mention: true,
      email_deadline: true,
    });
    expect(store.replayErrors().size).toBe(0);
    rejects(
      "configure_alerts",
      { assignment: true, reply: true, change: true, mention: true, deadline: true },
      403,
      "permission denied",
      GHOST,
    );
  });
});
