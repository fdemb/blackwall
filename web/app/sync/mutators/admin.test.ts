import { describe, expect, it } from "vite-plus/test";
import type { Id } from "../../lib/types";
import type { Entity, RecordOf } from "../records";
import {
  AT,
  GHOST,
  INTEGRATION_DISABLED,
  INTEGRATION_ONE,
  INVITE_ACCEPTED,
  INVITE_CANCELLED,
  INVITE_PENDING,
  MEMBER,
  OWNER,
  VIEWER,
  mutate,
  seedStore,
  snapshot,
} from "./fixtures";
import { admit } from "./index";

const TOUCHED: readonly Entity[] = ["invitations", "integrations"];

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
  actor: Id = OWNER,
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
  actor: Id = OWNER,
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
function twice(name: string, args: unknown, actor: Id = OWNER): void {
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

describe("cancel_invitation", () => {
  it("cancels a pending invitation and clears its token", () => {
    const store = seedStore(OWNER);
    const before = store.get("invitations", INVITE_PENDING);
    if (before === undefined) throw new Error("missing invitation");
    mutate(store, "cancel_invitation", { id: INVITE_PENDING });
    expect(store.get("invitations", INVITE_PENDING)).toEqual({
      ...(before as RecordOf["invitations"]),
      state: "cancelled",
      token_hash: "",
    });
  });

  it("cancelling a cancelled invitation succeeds without changes", () => {
    const store = seedStore(OWNER);
    const before = beforeAll(store);
    const id = mutate(store, "cancel_invitation", { id: INVITE_CANCELLED });
    expect(store.replayErrors().get(id)).toBeUndefined();
    expectSame(store, before);
    twice("cancel_invitation", { id: INVITE_PENDING });
  });

  it("rejects accepted invitations and missing ids", () => {
    rejects("cancel_invitation", { id: INVITE_ACCEPTED }, 409, "invitation already accepted");
    admitsRejects("cancel_invitation", { id: INVITE_ACCEPTED }, 409, "invitation already accepted");
    rejects("cancel_invitation", { id: "invite-ghost" }, 404, "not found");
    admitsRejects("cancel_invitation", { id: "invite-ghost" }, 404, "not found");
  });

  it("requires owner or admin", () => {
    const args = { id: INVITE_PENDING };
    rejects("cancel_invitation", args, 403, "permission denied", MEMBER);
    rejects("cancel_invitation", args, 403, "permission denied", VIEWER);
    rejects("cancel_invitation", args, 403, "permission denied", GHOST);
  });
});

describe("update_integration", () => {
  it("flips the flag without touching other fields", () => {
    const store = seedStore(OWNER);
    const before = store.get("integrations", INTEGRATION_ONE);
    if (before === undefined) throw new Error("missing integration");
    mutate(store, "update_integration", { id: INTEGRATION_ONE, enabled: false });
    expect(store.get("integrations", INTEGRATION_ONE)).toEqual({
      ...(before as RecordOf["integrations"]),
      enabled: false,
    });
    mutate(store, "update_integration", { id: INTEGRATION_DISABLED, enabled: true });
    expect(store.get("integrations", INTEGRATION_DISABLED)?.enabled).toBe(true);
  });

  it("is idempotent", () => {
    twice("update_integration", { id: INTEGRATION_ONE, enabled: false });
  });

  it("rejects missing integrations", () => {
    rejects("update_integration", { id: "integration-ghost", enabled: true }, 404, "not found");
    admitsRejects(
      "update_integration",
      { id: "integration-ghost", enabled: true },
      404,
      "not found",
    );
  });

  it("requires owner or admin", () => {
    const args = { id: INTEGRATION_ONE, enabled: false };
    rejects("update_integration", args, 403, "permission denied", MEMBER);
    rejects("update_integration", args, 403, "permission denied", VIEWER);
    rejects("update_integration", args, 403, "permission denied", GHOST);
  });
});

describe("delete_integration", () => {
  it("deletes the integration", () => {
    const store = seedStore(OWNER);
    mutate(store, "delete_integration", { id: INTEGRATION_ONE });
    expect(store.get("integrations", INTEGRATION_ONE)).toBeUndefined();
    expect(store.get("integrations", INTEGRATION_DISABLED)).toBeDefined();
  });

  it("running twice keeps the view", () => {
    twice("delete_integration", { id: INTEGRATION_ONE });
  });

  it("replays a missing integration as a no-op but admission fails", () => {
    const replayed = seedStore(OWNER);
    replayed.applyBase([{ entity: "integrations", id: INTEGRATION_ONE, record: null }]);
    const before = beforeAll(replayed);
    const id = mutate(replayed, "delete_integration", { id: INTEGRATION_ONE });
    expect(replayed.replayErrors().get(id)).toBeUndefined();
    expectSame(replayed, before);
    admitsRejects("delete_integration", { id: "integration-ghost" }, 404, "not found");
  });

  it("requires owner or admin", () => {
    const args = { id: INTEGRATION_ONE };
    rejects("delete_integration", args, 403, "permission denied", MEMBER);
    rejects("delete_integration", args, 403, "permission denied", VIEWER);
    rejects("delete_integration", args, 403, "permission denied", GHOST);
  });
});
