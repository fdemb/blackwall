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

function queueMarkAll(store: ReturnType<typeof seedStore>, actor: Id = MEMBER): number {
  const result = admit(store, actor, { name: "mark_all_notifications_read", args: {}, at: AT });
  return mutate(store, "mark_all_notifications_read", result.args, AT, result.local);
}

/** Running a mutation twice leaves the same view as running it once, with no errors. */
function twice(name: string, args: unknown, actor: Id = MEMBER): void {
  const once = seedStore(actor);
  if (name === "mark_all_notifications_read") queueMarkAll(once, actor);
  else mutate(once, name, args);
  expect(once.replayErrors().size).toBe(0);
  const first = beforeAll(once);
  const both = seedStore(actor);
  if (name === "mark_all_notifications_read") {
    queueMarkAll(both, actor);
    queueMarkAll(both, actor);
  } else {
    mutate(both, name, args);
    mutate(both, name, args);
  }
  expect(both.replayErrors().size).toBe(0);
  expectSame(both, first);
}

describe("mark_notification_read / mark_notification_unread", () => {
  it("marks read and unread with whole records", () => {
    const store = seedStore();
    const unread = store.get("notifications", NOTIF_UNREAD);
    if (unread === undefined) throw new Error("missing notification");
    mutate(store, "mark_notification_read", { id: NOTIF_UNREAD });
    expect(store.get("notifications", NOTIF_UNREAD)).toEqual(
      normalize("notifications", { ...(unread as RecordOf["notifications"]), read_at: AT }),
    );
    mutate(store, "mark_notification_unread", { id: NOTIF_UNREAD });
    expect(store.get("notifications", NOTIF_UNREAD)).toEqual(
      normalize("notifications", { ...(unread as RecordOf["notifications"]), read_at: null }),
    );
  });

  it("replays an already-read notification as a no-op but admission succeeds", () => {
    const replayed = seedStore();
    const before = beforeAll(replayed);
    const id = mutate(replayed, "mark_notification_read", { id: NOTIF_READ });
    expect(replayed.replayErrors().get(id)).toBeUndefined();
    expectSame(replayed, before);
    let error: unknown;
    try {
      admit(replayed, MEMBER, { name: "mark_notification_read", args: { id: NOTIF_READ }, at: AT });
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
    twice("mark_notification_read", { id: NOTIF_UNREAD });
    twice("mark_notification_unread", { id: NOTIF_READ });
  });

  it("rejects missing and foreign notifications with 404", () => {
    admitsRejects("mark_notification_read", { id: "notif-ghost" }, 404, "not found");
    admitsRejects("mark_notification_read", { id: NOTIF_OTHER }, 404, "not found");
    admitsRejects("mark_notification_unread", { id: "notif-ghost" }, 404, "not found");
    // Replay over a missing row is a no-op without errors.
    const replayed = seedStore();
    const before = beforeAll(replayed);
    const id = mutate(replayed, "mark_notification_read", { id: "notif-ghost" });
    expect(replayed.replayErrors().get(id)).toBeUndefined();
    expectSame(replayed, before);
  });

  it("viewers may mark their own notifications", () => {
    const store = seedStore(VIEWER);
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
          created_at: "2026-10-08T12:00:00.000000Z",
          dedup_key: "dv",
        },
      },
    ]);
    mutate(store, "mark_notification_read", { id: "notif-v" });
    expect(store.replayErrors().size).toBe(0);
    expect(store.get("notifications", "notif-v")?.read_at).toBe(AT);
    // Reading someone else's notification fails admission as on the server;
    // replay treats the foreign row as absent and stays quiet.
    admitsRejects("mark_notification_read", { id: NOTIF_UNREAD }, 404, "not found", VIEWER);
    rejects("mark_notification_read", { id: NOTIF_UNREAD }, 403, "permission denied", GHOST);
  });
});

describe("mark_all_notifications_read", () => {
  it("marks every unread notification of the actor", () => {
    const store = seedStore();
    const unread = store.get("notifications", NOTIF_UNREAD);
    const read = store.get("notifications", NOTIF_READ);
    const other = store.get("notifications", NOTIF_OTHER);
    if (unread === undefined || read === undefined || other === undefined) {
      throw new Error("missing notifications");
    }
    queueMarkAll(store);
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

  it("replay marks only the notifications admitted, not newer ones", () => {
    const store = seedStore();
    const admitted = admit(store, MEMBER, {
      name: "mark_all_notifications_read",
      args: {},
      at: AT,
    });
    expect(admitted.local).toEqual({ ids: [NOTIF_UNREAD] });
    store.setPending([
      ...store.pending(),
      {
        id: store.pending().length + 1,
        name: "mark_all_notifications_read",
        args: admitted.args,
        at: AT,
        local: admitted.local,
      },
    ]);
    const unread = store.get("notifications", NOTIF_UNREAD);
    if (unread === undefined) throw new Error("missing notification");
    expect(unread.read_at).toBe(AT);
    const confirmed = {
      ...unread,
      version: unread.version + 1,
      read_at: "2026-10-09T12:00:01.000000Z",
    };
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
    // A notification created after the server applied mark-all arrives on an
    // intermediate pull while the mutation is still pending: it stays unread.
    store.applyBase([
      { entity: "notifications", id: NOTIF_UNREAD, record: confirmed },
      { entity: "notifications", id: newer.id, record: newer },
    ]);
    expect(store.replayErrors().size).toBe(0);
    expect(store.get("notifications", newer.id)).toEqual(normalize("notifications", newer));
    expect(store.get("notifications", NOTIF_UNREAD)).toEqual(normalize("notifications", confirmed));
    const once = beforeAll(store);
    store.setPending([...store.pending()]);
    expect(store.replayErrors().size).toBe(0);
    expectSame(store, once);
    twice("mark_all_notifications_read", {});
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
    const id = queueMarkAll(store, OWNER);
    expect(store.replayErrors().get(id)).toBeUndefined();
    expectSame(store, before);
    twice("mark_all_notifications_read", {});
  });

  it("does not expand mark-all during replay when local data is absent", () => {
    rejects("mark_all_notifications_read", {}, 400, "mark all read requires local.ids");
  });

  it("viewers may mark all read but ghosts may not", () => {
    const store = seedStore(VIEWER);
    const id = queueMarkAll(store, VIEWER);
    expect(store.replayErrors().get(id)).toBeUndefined();
    rejects("mark_all_notifications_read", {}, 403, "permission denied", GHOST);
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
    });
    expect(store.get("alert_preferences", MEMBER)).toEqual({
      ...(before as RecordOf["alert_preferences"]),
      assignment: false,
      reply: false,
      change: false,
      mention: false,
      deadline: false,
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
    });
  });

  it("is idempotent", () => {
    twice("configure_alerts", {
      assignment: false,
      reply: true,
      change: true,
      mention: true,
      deadline: true,
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
