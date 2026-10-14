import { describe, expect, it } from "vite-plus/test";
import type { Id } from "../../lib/types";
import { normalize } from "../records";
import type { Entity, RecordOf } from "../records";
import {
  ADMIN,
  AT,
  GHOST,
  MEMBER,
  OWNER,
  VIEWER,
  VIEW_OTHER_PRIVATE,
  VIEW_PRIVATE,
  VIEW_SHARED,
  mutate,
  seedStore,
  snapshot,
} from "./fixtures";
import { admit } from "./index";

/** Asserts the whole resulting record against an explicit full expected record. */
const TOUCHED: readonly Entity[] = ["views"];

function beforeAll(
  store: ReturnType<typeof seedStore>,
): { entity: Entity; rows: RecordOf[Entity][] }[] {
  return TOUCHED.map((entity) => ({ entity, rows: snapshot(store, entity) }));
}

function expectView(
  store: ReturnType<typeof seedStore>,
  id: string,
  expected: RecordOf["views"],
): void {
  expect(store.get("views", id)).toEqual(normalize("views", expected));
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
 * The filter as the server stores it: every default filled. Expected fields
 * come from Rust `IssueFilter`.
 */
// Fixture ids are not UUIDs, and clause values must be.
const TEAM_UUID = "11111111-1111-4111-8111-000000000001";

function canonical(filter: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    where: [],
    ids: null,
    search: null,
    trash: false,
    archived: false,
    sort: "position",
    group_by: null,
    after: null,
    projection: "full",
    ...filter,
  };
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

describe("save_view", () => {
  it("stores filter defaults and clause values as sent", () => {
    const where = [{ field: "deadline", op: "lte", values: ["2026-10-09T15:30:00.123456+02:00"] }];
    const args = { id: "view-defaults", name: "Due", shared: false, filter: { where } };
    const store = seedStore();
    admit(store, MEMBER, { name: "save_view", args, at: AT });
    mutate(store, "save_view", args);
    expect(store.get("views", args.id)).toEqual({
      ...args,
      version: 1,
      owner: MEMBER,
      filter: canonical({ where }),
    });
    twice("save_view", args);
  });
  it("saves with the actor as owner", () => {
    const store = seedStore();
    mutate(store, "save_view", {
      id: "view-new",
      name: "Mine",
      shared: false,
      filter: { search: "foo" },
    });
    expectView(store, "view-new", {
      id: "view-new",
      version: 1,
      owner: MEMBER,
      name: "Mine",
      shared: false,
      filter: canonical({ search: "foo" }),
    });
  });

  it("viewers may save private views but not shared ones", () => {
    const store = seedStore(VIEWER);
    mutate(store, "save_view", { id: "view-v", name: "V", shared: false, filter: {} });
    expect(store.replayErrors().size).toBe(0);
    expect(store.get("views", "view-v")?.owner).toBe(VIEWER);
    rejects(
      "save_view",
      { id: "view-w", name: "W", shared: true, filter: {} },
      403,
      "permission denied",
      VIEWER,
    );
  });

  it("creates are upserts", () => {
    twice("save_view", { id: "view-new", name: "N", shared: false, filter: {} });
  });

  it("validates the name, filter and id", () => {
    const base = { id: "v", name: "N", shared: false, filter: {} };
    rejects("save_view", { ...base, name: " " }, 400, "text must contain 1 to 200 bytes");
    rejects(
      "save_view",
      { ...base, filter: { where: [{ field: "deadline", op: "lte", values: ["soon"] }] } },
      400,
      'filter value "soon" is not valid for deadline',
    );
    rejects(
      "save_view",
      { ...base, filter: { where: [{ field: "assignee", op: "gt", values: [MEMBER] }] } },
      400,
      "filter op gt does not apply to assignee",
    );
    rejects("save_view", { name: "N", shared: false, filter: {} }, 400, "id is required");
    rejects(
      "save_view",
      { ...base, id: "00000000-0000-0000-0000-000000000000" },
      400,
      "id must not be nil",
    );
    rejects("save_view", base, 403, "permission denied", GHOST);
  });
});

describe("update_view", () => {
  it("canonicalizes updated filters just like saved filters", () => {
    const store = seedStore();
    const before = store.get("views", VIEW_PRIVATE);
    if (before === undefined) throw new Error("missing view");
    const where = [{ field: "deadline", op: "lte", values: ["+7d"] }];
    const args = { id: VIEW_PRIVATE, name: "Due", shared: false, filter: { where } };
    mutate(store, "update_view", args);
    expect(store.get("views", args.id)).toEqual({
      ...before,
      ...args,
      filter: canonical({ where }),
    });
    twice("update_view", args);
  });
  it("updates name, sharing and filter", () => {
    const store = seedStore();
    const before = store.get("views", VIEW_PRIVATE);
    if (before === undefined) throw new Error("missing view");
    mutate(store, "update_view", {
      id: VIEW_PRIVATE,
      name: "Renamed",
      shared: true,
      filter: { where: [{ field: "team_id", op: "is", values: [TEAM_UUID] }] },
    });
    expectView(store, VIEW_PRIVATE, {
      ...(before as RecordOf["views"]),
      name: "Renamed",
      shared: true,
      filter: canonical({ where: [{ field: "team_id", op: "is", values: [TEAM_UUID] }] }),
    });
  });

  it("admins may update others' views while they stay visible", () => {
    const store = seedStore(ADMIN);
    mutate(store, "update_view", {
      id: VIEW_SHARED,
      name: "Taken",
      shared: true,
      filter: {},
    });
    expect(store.replayErrors().size).toBe(0);
    expect(store.get("views", VIEW_SHARED)?.name).toBe("Taken");
  });

  it("unsharing another owner's view deletes it locally", () => {
    const store = seedStore(ADMIN);
    const args = { id: VIEW_SHARED, name: "Taken", shared: false, filter: {} };
    admit(store, ADMIN, { name: "update_view", args, at: AT });
    const before = beforeAll(store);
    mutate(store, "update_view", args);
    expect(store.replayErrors().size).toBe(0);
    expectSame(
      store,
      before.map(({ entity, rows }) => ({
        entity,
        rows:
          entity === "views" ? rows.filter((row) => "id" in row && row.id !== VIEW_SHARED) : rows,
      })),
    );
    // The server's visibility removal arrives before acknowledgement.
    store.applyBase([{ entity: "views", id: VIEW_SHARED, record: null }]);
    expect(store.replayErrors().size).toBe(0);
    expect(store.get("views", VIEW_SHARED)).toBeUndefined();
    twice("update_view", args, ADMIN);
  });

  it("viewers may update their own private views but not share them", () => {
    const store = seedStore(VIEWER);
    mutate(store, "save_view", { id: "view-v", name: "V", shared: false, filter: {} });
    expect(store.replayErrors().size).toBe(0);
    mutate(store, "update_view", { id: "view-v", name: "V2", shared: false, filter: {} });
    expect(store.replayErrors().size).toBe(0);
    expect(store.get("views", "view-v")?.name).toBe("V2");
    const id = mutate(store, "update_view", { id: "view-v", name: "V3", shared: true, filter: {} });
    expect(store.replayErrors().get(id)?.status).toBe(403);
  });

  it("is idempotent", () => {
    twice("update_view", { id: VIEW_PRIVATE, name: "N", shared: false, filter: {} });
  });

  it("validates the view", () => {
    const base = { id: VIEW_PRIVATE, name: "N", shared: false, filter: {} };
    rejects("update_view", { ...base, name: "" }, 400, "text must contain 1 to 200 bytes");
    rejects(
      "update_view",
      {
        ...base,
        filter: { where: [{ field: "deadline", op: "lte", values: ["2026-10-08T12:00:00"] }] },
      },
      400,
      'filter value "2026-10-08T12:00:00" is not valid for deadline',
    );
    rejects(
      "update_view",
      { ...base, filter: { where: [{ field: "team_id", op: "is", values: [null] }] } },
      400,
      "filter value null does not apply to team_id",
    );
    admitsRejects("update_view", { ...base, id: "view-ghost" }, 404, "not found");
  });

  it("replays a missing view as a no-op but admission fails", () => {
    const replayed = seedStore();
    replayed.applyBase([{ entity: "views", id: VIEW_PRIVATE, record: null }]);
    const before = beforeAll(replayed);
    const id = mutate(replayed, "update_view", {
      id: VIEW_PRIVATE,
      name: "Renamed",
      shared: false,
      filter: {},
    });
    expect(replayed.replayErrors().get(id)).toBeUndefined();
    expectSame(replayed, before);
    admitsRejects(
      "update_view",
      { id: "view-ghost", name: "N", shared: false, filter: {} },
      404,
      "not found",
    );
  });

  it("enforces owner or admin", () => {
    const base = { id: VIEW_OTHER_PRIVATE, name: "N", shared: false, filter: {} };
    rejects("update_view", base, 403, "permission denied");
    rejects("update_view", { ...base, id: VIEW_SHARED }, 403, "permission denied", MEMBER);
    rejects("update_view", base, 403, "permission denied", VIEWER);
    rejects("update_view", base, 403, "permission denied", GHOST);
  });
});

describe("delete_view", () => {
  it("deletes the view", () => {
    const store = seedStore();
    mutate(store, "delete_view", { id: VIEW_PRIVATE });
    expect(store.get("views", VIEW_PRIVATE)).toBeUndefined();
    expect(store.get("views", VIEW_SHARED)).toBeDefined();
  });

  it("owners may delete shared views and admins may delete others'", () => {
    const owned = seedStore(OWNER);
    mutate(owned, "delete_view", { id: VIEW_SHARED });
    expect(owned.replayErrors().size).toBe(0);
    const admin = seedStore(ADMIN);
    mutate(admin, "delete_view", { id: VIEW_OTHER_PRIVATE });
    expect(admin.replayErrors().size).toBe(0);
  });

  it("running twice keeps the view", () => {
    twice("delete_view", { id: VIEW_PRIVATE });
  });

  it("replays a missing view as a no-op but admission fails", () => {
    const replayed = seedStore();
    replayed.applyBase([{ entity: "views", id: VIEW_PRIVATE, record: null }]);
    const before = beforeAll(replayed);
    const id = mutate(replayed, "delete_view", { id: VIEW_PRIVATE });
    expect(replayed.replayErrors().get(id)).toBeUndefined();
    expectSame(replayed, before);
    admitsRejects("delete_view", { id: "view-ghost" }, 404, "not found");
  });

  it("enforces owner or admin", () => {
    rejects("delete_view", { id: VIEW_OTHER_PRIVATE }, 403, "permission denied");
    rejects("delete_view", { id: VIEW_OTHER_PRIVATE }, 403, "permission denied", VIEWER);
    rejects("delete_view", { id: VIEW_PRIVATE }, 403, "permission denied", GHOST);
  });
});
