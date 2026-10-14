import { describe, expect, it } from "vite-plus/test";
import type { Id, Project, Team } from "../../lib/types";
import { normalize } from "../records";
import type { Entity, RecordOf } from "../records";
import type { SyncStore } from "../store";
import {
  ADMIN,
  AT,
  GHOST,
  LABEL_ONE,
  MEMBER,
  MILESTONE,
  OWNER,
  PROJECT,
  SPRINT,
  SPRINT_FINISHED,
  SPRINT_OTHER,
  STAGE_ACTIVE,
  STAGE_BACKLOG,
  STAGE_CANCELLED,
  STAGE_DONE,
  STAGE_OTHER,
  TEAM,
  TEAM_OTHER,
  VIEWER,
  mutate,
  seedStore,
  snapshot,
} from "./fixtures";
import { admit } from "./index";

function liveTeam(store: SyncStore, id: string): Team {
  const team = store.get("teams", id);
  if (team === undefined) throw new Error(`missing fixture team ${id}`);
  return team as Team;
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

const TOUCHED: readonly Entity[] = [
  "teams",
  "members",
  "issues",
  "labels",
  "projects",
  "milestones",
  "sprints",
];

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
function twice(
  name: string,
  args: unknown,
  actor: Id = OWNER,
  setup?: (store: SyncStore) => void,
): void {
  const once = seedStore(actor);
  setup?.(once);
  mutate(once, name, args);
  expect(once.replayErrors().size).toBe(0);
  const first = beforeAll(once);
  const both = seedStore(actor);
  setup?.(both);
  mutate(both, name, args);
  mutate(both, name, args);
  expect(both.replayErrors().size).toBe(0);
  expectSame(both, first);
}

describe("create_team", () => {
  const STAGES_NEW = ["stage-new-backlog", "stage-new-todo", "stage-new-active", "stage-new-done"];

  it("creates with sorted members, default stages and the server default archive", () => {
    const store = seedStore(OWNER);
    mutate(store, "create_team", {
      id: "team-new",
      name: "New",
      key: "NEW",
      members: [MEMBER, ADMIN],
      default_stage_ids: STAGES_NEW,
    });
    expectRecord(store, "teams", "team-new", {
      id: "team-new",
      version: 1,
      name: "New",
      key: "NEW",
      members: [ADMIN, MEMBER],
      // The default stages are predicted from the client-chosen ids, in the
      // server's order; issue creates for the pending team resolve them.
      stages: [
        { id: STAGES_NEW[0]!, version: 1, name: "Backlog", kind: "backlog", position: 0 },
        { id: STAGES_NEW[1]!, version: 1, name: "Todo", kind: "planned", position: 1 },
        { id: STAGES_NEW[2]!, version: 1, name: "In progress", kind: "active", position: 2 },
        { id: STAGES_NEW[3]!, version: 1, name: "Done", kind: "done", position: 3 },
      ],
      archive_after_days: 30,
      // The seeded teams are violet and blue, so the next color is sky.
      icon: "users",
      color: "sky",
    });
    expect(store.get("members", ADMIN)?.team_ids).toEqual([TEAM, "team-new"]);
    expect(store.get("members", MEMBER)?.team_ids).toEqual([TEAM, "team-new"]);
    expect(store.get("members", OWNER)?.team_ids).toEqual([TEAM]);
  });

  it("predicts stages so issues can be created for a pending team", () => {
    const store = seedStore(OWNER);
    const stages = [
      "team-pending-backlog",
      "team-pending-todo",
      "team-pending-active",
      "team-pending-done",
    ];
    mutate(store, "create_team", {
      id: "team-pending",
      name: "Pending",
      key: "PEN",
      members: [],
      default_stage_ids: stages,
    });
    expect(store.replayErrors().size).toBe(0);
    // Without a stage the server picks the generated Backlog stage: the
    // prediction resolves the same first stage by position.
    const defaulted = mutate(store, "create_issue", {
      input: { id: "issue-pending", title: "P", team_id: "team-pending" },
    });
    expect(store.replayErrors().get(defaulted)).toBeUndefined();
    const expected = {
      tracker: null,
      id: "issue-pending",
      version: 1,
      number: 1,
      title: "P",
      description: "",
      team_id: "team-pending",
      stage_id: "team-pending-backlog",
      assignee: null,
      created_by: OWNER,
      priority: "none",
      labels: [],
      estimate: null,
      deadline: null,
      project_id: null,
      milestone_id: null,
      sprint_id: null,
      parent_id: null,
      dependencies: [],
      position: 0,
      followers: [OWNER],
      attachments: [],
      source_links: [],
      deleted_at: null,
      archived_at: null,
      done_at: null,
      created_at: AT,
      updated_at: AT,
    } satisfies RecordOf["issues"];
    expectRecord(store, "issues", expected.id, expected);
    const placed = mutate(store, "create_issue", {
      input: { id: "issue-placed", title: "Q", team_id: "team-pending", stage_id: stages[2] },
    });
    expect(store.replayErrors().get(placed)).toBeUndefined();
    expectRecord(store, "issues", "issue-placed", {
      ...expected,
      id: "issue-placed",
      number: 2,
      title: "Q",
      stage_id: "team-pending-active",
    });
    const once = beforeAll(store);
    store.setPending([...store.pending()]);
    expect(store.replayErrors().size).toBe(0);
    expectSame(store, once);
    twice("create_team", {
      id: "team-pending",
      name: "Pending",
      key: "PEN",
      default_stage_ids: stages,
    });
  });

  it("keeps a stored never-archive setting on replay", () => {
    const store = seedStore(OWNER);
    const stages = [
      "team-never-backlog",
      "team-never-todo",
      "team-never-active",
      "team-never-done",
    ];
    mutate(store, "create_team", {
      id: "team-never",
      name: "Never",
      key: "NEV",
      members: [],
      default_stage_ids: stages,
    });
    // The server confirms the team with archiving disabled; replaying the
    // create must not turn the stored null back into the 30-day default.
    store.applyBase([
      {
        entity: "teams",
        id: "team-never",
        record: { ...(liveTeam(store, "team-never") as object), archive_after_days: null },
      },
    ]);
    const id = mutate(store, "create_team", {
      id: "team-never",
      name: "Never",
      key: "NEV",
      members: [],
      default_stage_ids: stages,
    });
    expect(store.replayErrors().get(id)).toBeUndefined();
    const expected = { ...liveTeam(store, "team-never"), archive_after_days: null };
    expectRecord(store, "teams", "team-never", expected);
    const once = beforeAll(store);
    store.setPending([...store.pending()]);
    expect(store.replayErrors().size).toBe(0);
    expectSame(store, once);
  });

  it("is idempotent and keeps pulled stages on replay", () => {
    twice("create_team", {
      id: "team-new",
      name: "New",
      key: "NEW",
      members: [MEMBER],
      default_stage_ids: STAGES_NEW,
    });
    const store = seedStore(OWNER);
    mutate(store, "create_team", {
      id: "team-new",
      name: "New",
      key: "NEW",
      members: [MEMBER],
      default_stage_ids: STAGES_NEW,
    });
    const created = liveTeam(store, "team-new");
    store.applyBase([
      {
        entity: "teams",
        id: "team-new",
        record: {
          ...created,
          stages: [
            ...created.stages.map((stage) => ({
              ...stage,
              name: `${stage.name} updated`,
              version: 2,
            })),
            { id: "stage-added", version: 1, name: "Cancelled", kind: "cancelled", position: 4 },
          ],
        },
      },
    ]);
    const id = mutate(store, "create_team", {
      id: "team-new",
      name: "New",
      key: "NEW",
      members: [MEMBER],
      default_stage_ids: STAGES_NEW,
    });
    expect(store.replayErrors().get(id)).toBeUndefined();
    expect(liveTeam(store, "team-new").stages).toEqual([
      ...created.stages.map((stage) => ({ ...stage, name: `${stage.name} updated`, version: 2 })),
      { id: "stage-added", version: 1, name: "Cancelled", kind: "cancelled", position: 4 },
    ]);
  });

  it("validates the name, key, members, stage ids and id", () => {
    const base = {
      id: "t",
      name: "N",
      key: "N",
      members: [] as string[],
      default_stage_ids: ["s1", "s2", "s3", "s4"],
    };
    rejects("create_team", { ...base, name: "  " }, 400, "text must contain 1 to 200 bytes");
    for (const key of ["", "ENGIN", "1AB", "eng", "E-1"])
      rejects(
        "create_team",
        { ...base, key },
        400,
        "team key must be 1 to 4 uppercase letters or digits, starting with a letter",
      );
    rejects("create_team", { ...base, key: "TEAM" }, 409, "team key already exists");
    rejects("create_team", { ...base, members: [GHOST] }, 403, "permission denied");
    rejects(
      "create_team",
      { ...base, default_stage_ids: ["s1", "s2", "s3"] },
      400,
      "default_stage_ids must contain exactly 4 ids",
    );
    rejects(
      "create_team",
      { ...base, default_stage_ids: ["s1", "s2", "s3", "s4", "s5"] },
      400,
      "default_stage_ids must contain exactly 4 ids",
    );
    rejects(
      "create_team",
      { id: "t", name: "N", key: "N", members: [] },
      400,
      "default_stage_ids is required",
    );
    rejects(
      "create_team",
      { name: "N", key: "N", members: [], default_stage_ids: base.default_stage_ids },
      400,
      "id is required",
    );
    rejects(
      "create_team",
      { ...base, id: "00000000-0000-0000-0000-000000000000" },
      400,
      "id must not be nil",
    );
  });

  it("requires owner or admin", () => {
    const args = {
      id: "t",
      name: "N",
      key: "N",
      members: [],
      default_stage_ids: ["s1", "s2", "s3", "s4"],
    };
    rejects("create_team", args, 403, "permission denied", MEMBER);
    rejects("create_team", args, 403, "permission denied", VIEWER);
    rejects("create_team", args, 403, "permission denied", GHOST);
    const admin = seedStore(ADMIN);
    mutate(admin, "create_team", args);
    expect(admin.replayErrors().size).toBe(0);
  });
});

describe("set_team_members", () => {
  it("replaces members and maintains team_ids", () => {
    const store = seedStore(OWNER);
    mutate(store, "set_team_members", { id: TEAM, members: [OWNER, MEMBER] });
    expect(liveTeam(store, TEAM).members).toEqual([MEMBER, OWNER]);
    expect(store.get("members", OWNER)?.team_ids).toEqual([TEAM]);
    expect(store.get("members", MEMBER)?.team_ids).toEqual([TEAM]);
    expect(store.get("members", ADMIN)?.team_ids).toEqual([]);
    expect(store.get("members", VIEWER)?.team_ids).toEqual([]);
  });

  it("is idempotent", () => {
    twice("set_team_members", { id: TEAM, members: [OWNER, MEMBER, MEMBER] });
  });

  it("validates the team and members", () => {
    rejects("set_team_members", { id: "team-ghost", members: [] }, 404, "not found");
    rejects("set_team_members", { id: TEAM, members: [GHOST] }, 403, "permission denied");
  });

  it("requires owner or admin", () => {
    const args = { id: TEAM, members: [OWNER] };
    rejects("set_team_members", args, 403, "permission denied", MEMBER);
    rejects("set_team_members", args, 403, "permission denied", VIEWER);
    rejects("set_team_members", args, 403, "permission denied", GHOST);
  });
});

describe("set_team_appearance", () => {
  it("sets the icon and color", () => {
    const store = seedStore(OWNER);
    const before = liveTeam(store, TEAM);
    mutate(store, "set_team_appearance", { id: TEAM, icon: "rocket", color: "teal" });
    expectRecord(store, "teams", TEAM, { ...before, icon: "rocket", color: "teal" });
    twice("set_team_appearance", { id: TEAM, icon: "rocket", color: "teal" });
  });

  it("validates the icon, color and team", () => {
    rejects(
      "set_team_appearance",
      { id: TEAM, icon: "nope", color: "teal" },
      400,
      "unknown team icon",
    );
    rejects(
      "set_team_appearance",
      { id: TEAM, icon: "rocket", color: "nope" },
      400,
      "unknown team color",
    );
    rejects(
      "set_team_appearance",
      { id: "team-ghost", icon: "rocket", color: "teal" },
      404,
      "not found",
    );
  });
});

describe("set_team_archive", () => {
  it("distinguishes omitted archive days from explicit null", () => {
    const store = seedStore(OWNER);
    const before = liveTeam(store, TEAM);
    store.applyBase([
      { entity: "teams", id: TEAM, record: { ...before, archive_after_days: null } },
    ]);
    const args = { id: TEAM };
    expect(admit(store, OWNER, { name: "set_team_archive", args, at: AT }).args).toEqual({
      ...args,
      archive_after_days: 30,
    });
    mutate(store, "set_team_archive", args);
    expectRecord(store, "teams", TEAM, { ...before, archive_after_days: 30 });
    mutate(store, "set_team_archive", { ...args, archive_after_days: null });
    expectRecord(store, "teams", TEAM, { ...before, archive_after_days: null });
    twice("set_team_archive", args);
    twice("set_team_archive", { ...args, archive_after_days: null });
  });
  it("sets days and null", () => {
    const store = seedStore(OWNER);
    const before = liveTeam(store, TEAM);
    mutate(store, "set_team_archive", { id: TEAM, archive_after_days: 60 });
    expectRecord(store, "teams", TEAM, { ...before, archive_after_days: 60 });
    mutate(store, "set_team_archive", { id: TEAM, archive_after_days: null });
    expectRecord(store, "teams", TEAM, { ...before, archive_after_days: null });
  });

  it("is idempotent", () => {
    twice("set_team_archive", { id: TEAM, archive_after_days: 60 });
  });

  it("validates days and the team", () => {
    for (const days of [0, 3651]) {
      rejects(
        "set_team_archive",
        { id: TEAM, archive_after_days: days },
        400,
        "archive_after_days must be between 1 and 3650 days or null",
      );
    }
    rejects("set_team_archive", { id: "team-ghost", archive_after_days: 7 }, 404, "not found");
  });

  it("requires owner or admin", () => {
    const args = { id: TEAM, archive_after_days: 7 };
    rejects("set_team_archive", args, 403, "permission denied", MEMBER);
    rejects("set_team_archive", args, 403, "permission denied", VIEWER);
    rejects("set_team_archive", args, 403, "permission denied", GHOST);
  });
});

describe("create_stage", () => {
  it("appends in position order", () => {
    const store = seedStore(OWNER);
    const before = liveTeam(store, TEAM);
    mutate(store, "create_stage", {
      id: "stage-new",
      team_id: TEAM,
      name: "Review",
      kind: "planned",
      position: 5,
    });
    expectRecord(store, "teams", TEAM, {
      ...before,
      stages: [
        ...before.stages,
        { id: "stage-new", version: 1, name: "Review", kind: "planned", position: 5 },
      ],
    });
  });

  it("sorts by position then id", () => {
    const store = seedStore(OWNER);
    mutate(store, "create_stage", {
      id: "stage-aaa",
      team_id: TEAM,
      name: "First",
      kind: "backlog",
      position: 0,
    });
    expect(liveTeam(store, TEAM).stages.map((stage) => stage.id)).toEqual([
      "stage-aaa",
      STAGE_BACKLOG,
      STAGE_ACTIVE,
      STAGE_DONE,
      STAGE_CANCELLED,
    ]);
  });

  it("is idempotent", () => {
    twice("create_stage", {
      id: "stage-new",
      team_id: TEAM,
      name: "N",
      kind: "active",
      position: 9,
    });
  });

  it("validates the name, team and id", () => {
    const base = { id: "s", team_id: TEAM, name: "N", kind: "active", position: 0 };
    rejects("create_stage", { ...base, name: "" }, 400, "text must contain 1 to 200 bytes");
    rejects("create_stage", { ...base, team_id: "team-ghost" }, 404, "not found");
    rejects(
      "create_stage",
      { team_id: TEAM, name: "N", kind: "active", position: 0 },
      400,
      "id is required",
    );
    rejects(
      "create_stage",
      { ...base, id: "00000000-0000-0000-0000-000000000000" },
      400,
      "id must not be nil",
    );
  });

  it("requires owner or admin", () => {
    const args = { id: "s", team_id: TEAM, name: "N", kind: "active", position: 0 };
    rejects("create_stage", args, 403, "permission denied", MEMBER);
    rejects("create_stage", args, 403, "permission denied", VIEWER);
    rejects("create_stage", args, 403, "permission denied", GHOST);
  });
});

describe("update_stage", () => {
  it("renames and reorders without touching issues when the kind is unchanged", () => {
    const store = seedStore(OWNER);
    const before = liveTeam(store, TEAM);
    const beforeIssues = snapshot(store, "issues");
    mutate(store, "update_stage", {
      team_id: TEAM,
      id: STAGE_ACTIVE,
      name: "Doing",
      kind: "active",
      position: 10,
    });
    expectRecord(store, "teams", TEAM, {
      ...before,
      stages: [
        before.stages[0]!,
        before.stages[2]!,
        before.stages[3]!,
        { ...before.stages[1]!, name: "Doing", position: 10 },
      ],
    });
    expect(snapshot(store, "issues")).toEqual(beforeIssues);
  });

  it("stamps done_at when entering done", () => {
    const store = seedStore(OWNER);
    mutate(store, "update_stage", {
      team_id: TEAM,
      id: STAGE_CANCELLED,
      name: "Cancelled",
      kind: "done",
      position: 3,
    });
    const cancelled = store.get("issues", "issue-cancelled");
    expect(cancelled?.done_at).toBe(AT);
    expect(cancelled?.updated_at).toBe(AT);
  });

  it("takes issues out of their sprints when the stage becomes a backlog", () => {
    const store = seedStore(OWNER);
    expect(store.get("issues", "issue-1")?.sprint_id).toBe(SPRINT);
    mutate(store, "update_stage", {
      team_id: TEAM,
      id: STAGE_ACTIVE,
      name: "Later",
      kind: "backlog",
      position: 1,
    });
    const issue = store.get("issues", "issue-1");
    expect(issue?.sprint_id).toBeNull();
    expect(issue?.updated_at).toBe(AT);
  });

  it("clears done_at when leaving done and skips archived issues", () => {
    const store = seedStore(OWNER);
    mutate(store, "update_stage", {
      team_id: TEAM,
      id: STAGE_DONE,
      name: "Done",
      kind: "active",
      position: 2,
    });
    const done = store.get("issues", "issue-3");
    expect(done?.done_at).toBeNull();
    expect(done?.updated_at).toBe(AT);
    const imported = store.get("issues", "issue-op-done");
    expect(imported?.done_at).toBeNull();
    const archived = store.get("issues", "issue-archived");
    expect(archived?.done_at).toBe("2026-10-08T12:00:00.000000Z");
    expect(archived?.updated_at).toBe("2026-10-08T12:00:00.000000Z");
  });

  it("is idempotent", () => {
    twice("update_stage", {
      team_id: TEAM,
      id: STAGE_DONE,
      name: "Done",
      kind: "active",
      position: 2,
    });
    twice("update_stage", {
      team_id: TEAM,
      id: STAGE_ACTIVE,
      name: "Doing",
      kind: "active",
      position: 1,
    });
  });

  it("rejects unknown teams and stages with 404", () => {
    const base = { team_id: TEAM, id: STAGE_ACTIVE, name: "N", kind: "active", position: 1 };
    rejects("update_stage", { ...base, name: "" }, 400, "text must contain 1 to 200 bytes");
    rejects("update_stage", { ...base, team_id: "team-ghost" }, 404, "not found");
    rejects("update_stage", { ...base, id: "stage-ghost" }, 404, "not found");
    rejects("update_stage", { ...base, team_id: TEAM_OTHER, id: STAGE_ACTIVE }, 404, "not found");
  });

  it("fails workflow when the new kind leaves unfinished dependencies", () => {
    // issue-cancelled gains an unfinished dependency; entering done then
    // strands it, as the server's global check would report.
    const store = seedStore(OWNER);
    store.applyBase([
      {
        entity: "issues",
        id: "issue-cancelled",
        record: {
          ...(store.get("issues", "issue-cancelled") as object),
          dependencies: ["issue-1"],
        },
      },
    ]);
    const before = beforeAll(store);
    const id = mutate(store, "update_stage", {
      team_id: TEAM,
      id: STAGE_CANCELLED,
      name: "Cancelled",
      kind: "done",
      position: 3,
    });
    expect(store.replayErrors().get(id)?.status).toBe(409);
    expect(store.replayErrors().get(id)?.message).toBe(
      "workflow would leave an issue with unfinished dependencies",
    );
    expectSame(store, before);
  });

  it("admits done to backlog when an active issue depends into the stage", () => {
    // The server validates the touched stage before restamping the Done-entry
    // clock: the dependent is untouched by the kind change, so the move
    // succeeds and the restamp clears the clock afterwards.
    const setup = (store: SyncStore) => {
      const issue = store.get("issues", "issue-1");
      if (issue === undefined) throw new Error("missing issue");
      store.applyBase([
        { entity: "issues", id: issue.id, record: { ...issue, dependencies: ["issue-3"] } },
      ]);
    };
    const store = seedStore(OWNER);
    setup(store);
    const team = liveTeam(store, TEAM);
    const done = store.get("issues", "issue-3");
    const dependent = store.get("issues", "issue-1");
    const args = { team_id: TEAM, id: STAGE_DONE, name: "Done", kind: "backlog", position: 2 };
    admit(store, OWNER, { name: "update_stage", args, at: AT });
    mutate(store, "update_stage", args);
    expect(store.replayErrors().size).toBe(0);
    expect(store.get("issues", "issue-3")).toEqual({ ...done, done_at: null, updated_at: AT });
    expect(store.get("issues", "issue-1")).toEqual(dependent);
    expectRecord(store, "teams", TEAM, {
      ...team,
      stages: team.stages.map((stage) =>
        stage.id === STAGE_DONE ? { ...stage, kind: "backlog" } : stage,
      ),
    });
    twice("update_stage", args, OWNER, setup);
  });

  it("rejects backlog to active when the stage holds unfinished dependencies", () => {
    // issue-x sits in backlog depending on the unfinished issue-y; entering
    // active strands it, and the server reports 409 before restamping.
    const args = { team_id: TEAM, id: STAGE_BACKLOG, name: "Backlog", kind: "active", position: 0 };
    admitsRejects(
      "update_stage",
      args,
      409,
      "workflow would leave an issue with unfinished dependencies",
    );
    rejects(
      "update_stage",
      args,
      409,
      "workflow would leave an issue with unfinished dependencies",
    );
  });

  it("requires owner or admin", () => {
    const args = { team_id: TEAM, id: STAGE_ACTIVE, name: "N", kind: "active", position: 1 };
    rejects("update_stage", args, 403, "permission denied", MEMBER);
    rejects("update_stage", args, 403, "permission denied", VIEWER);
    rejects("update_stage", args, 403, "permission denied", GHOST);
  });
});

describe("delete_stage", () => {
  it("does not validate untouched replacement-stage issues merely restamped after a delete", () => {
    const store = seedStore(OWNER);
    const active = store.get("issues", "issue-1");
    if (active === undefined) throw new Error("missing issue");
    store.applyBase([
      { entity: "issues", id: active.id, record: { ...active, dependencies: ["issue-y"] } },
    ]);
    // This state is reachable after the server allows a dependency's stage
    // to leave Done without touching its active dependents.
    const before = store.get("issues", active.id);
    const moved = store.get("issues", "issue-3");
    const args = { team_id: TEAM, id: STAGE_DONE, replacement: STAGE_ACTIVE };
    admit(store, OWNER, { name: "delete_stage", args, at: AT });
    mutate(store, "delete_stage", args);
    expect(store.replayErrors().size).toBe(0);
    expect(store.get("issues", active.id)).toEqual({ ...before, done_at: null, updated_at: AT });
    expect(store.get("issues", "issue-3")).toEqual({
      ...moved,
      stage_id: STAGE_ACTIVE,
      done_at: null,
      updated_at: AT,
    });
    const once = beforeAll(store);
    store.setPending([...store.pending()]);
    expect(store.replayErrors().size).toBe(0);
    expectSame(store, once);
    twice("delete_stage", args, OWNER, (target) => {
      const issue = target.get("issues", active.id);
      if (issue === undefined) throw new Error("missing issue");
      target.applyBase([
        { entity: "issues", id: issue.id, record: { ...issue, dependencies: ["issue-y"] } },
      ]);
    });
  });

  it("moves its issues to the replacement", () => {
    const store = seedStore(OWNER);
    const before = liveTeam(store, TEAM);
    // Backlog holds issue-x, which depends on the unfinished issue-y; the
    // cancelled kind exempts both, so the move passes workflow.
    mutate(store, "delete_stage", {
      team_id: TEAM,
      id: STAGE_BACKLOG,
      replacement: STAGE_CANCELLED,
    });
    expectRecord(store, "teams", TEAM, {
      ...before,
      stages: before.stages.filter((stage) => stage.id !== STAGE_BACKLOG),
    });
    for (const id of ["issue-x", "issue-y"]) {
      const issue = store.get("issues", id);
      expect(issue?.stage_id).toBe(STAGE_CANCELLED);
      expect(issue?.updated_at).toBe(AT);
      expect(issue?.done_at).toBeNull();
    }
  });

  it("stamps done_at when the replacement is done", () => {
    const store = seedStore(OWNER);
    mutate(store, "delete_stage", { team_id: TEAM, id: STAGE_CANCELLED, replacement: STAGE_DONE });
    const moved = store.get("issues", "issue-cancelled");
    expect(moved?.stage_id).toBe(STAGE_DONE);
    expect(moved?.done_at).toBe(AT);
    expect(moved?.updated_at).toBe(AT);
  });

  it("clears done_at when leaving done and skips archived issues", () => {
    const store = seedStore(OWNER);
    // The cancelled replacement holds no active-stage rows, so the restamp
    // cannot pick up the fixture's latent active-stage violation.
    mutate(store, "delete_stage", { team_id: TEAM, id: STAGE_DONE, replacement: STAGE_CANCELLED });
    expect(store.get("issues", "issue-3")?.done_at).toBeNull();
    expect(store.get("issues", "issue-3")?.stage_id).toBe(STAGE_CANCELLED);
    expect(store.get("issues", "issue-op-done")?.done_at).toBeNull();
    expect(store.get("issues", "issue-archived")?.done_at).toBe("2026-10-08T12:00:00.000000Z");
    expect(store.get("issues", "issue-archived")?.updated_at).toBe(AT);
    // Leaving done restamps every unarchived row now in the replacement.
    expect(store.get("issues", "issue-cancelled")?.done_at).toBeNull();
    expect(store.get("issues", "issue-cancelled")?.updated_at).toBe(AT);
  });

  it("running twice keeps the view", () => {
    twice("delete_stage", { team_id: TEAM, id: STAGE_BACKLOG, replacement: STAGE_CANCELLED });
  });

  it("replays a missing stage as a no-op but admission fails", () => {
    const store = seedStore(OWNER);
    mutate(store, "delete_stage", {
      team_id: TEAM,
      id: STAGE_BACKLOG,
      replacement: STAGE_CANCELLED,
    });
    expect(store.replayErrors().size).toBe(0);
    const first = beforeAll(store);
    mutate(store, "delete_stage", {
      team_id: TEAM,
      id: STAGE_BACKLOG,
      replacement: STAGE_CANCELLED,
    });
    expect(store.replayErrors().size).toBe(0);
    expectSame(store, first);
    // Admission against a view that already dropped the stage fails as on
    // the server: rebuild that view in a fresh store and admit there.
    const rebased = seedStore(OWNER);
    const team = liveTeam(rebased, TEAM);
    rebased.applyBase([
      {
        entity: "teams",
        id: TEAM,
        record: { ...team, stages: team.stages.filter((s) => s.id !== STAGE_BACKLOG) },
      },
    ]);
    let error: unknown;
    try {
      admit(rebased, OWNER, {
        name: "delete_stage",
        args: { team_id: TEAM, id: STAGE_BACKLOG, replacement: STAGE_CANCELLED },
        at: AT,
      });
    } catch (caught) {
      error = caught;
    }
    expect((error as { status?: number })?.status).toBe(400);
    expect((error as { message?: string })?.message).toBe("invalid replacement stage");
  });

  it("validates the replacement", () => {
    const base = { team_id: TEAM, id: STAGE_BACKLOG, replacement: STAGE_CANCELLED };
    rejects(
      "delete_stage",
      { ...base, replacement: STAGE_BACKLOG },
      400,
      "invalid replacement stage",
    );
    // A missing stage is a replay no-op (twice needs it); admission fails.
    admitsRejects("delete_stage", { ...base, id: "stage-ghost" }, 400, "invalid replacement stage");
    rejects(
      "delete_stage",
      { ...base, replacement: STAGE_OTHER },
      400,
      "invalid replacement stage",
    );
    rejects("delete_stage", { ...base, team_id: "team-ghost" }, 404, "not found");
  });

  it("fails workflow when the move leaves unfinished dependencies", () => {
    const store = seedStore(OWNER);
    store.applyBase([
      {
        entity: "issues",
        id: "issue-cancelled",
        record: {
          ...(store.get("issues", "issue-cancelled") as object),
          dependencies: ["issue-1"],
        },
      },
    ]);
    const before = beforeAll(store);
    const id = mutate(store, "delete_stage", {
      team_id: TEAM,
      id: STAGE_CANCELLED,
      replacement: STAGE_DONE,
    });
    expect(store.replayErrors().get(id)?.status).toBe(409);
    expect(store.replayErrors().get(id)?.message).toBe(
      "workflow would leave an issue with unfinished dependencies",
    );
    expectSame(store, before);
  });

  it("requires owner or admin", () => {
    const args = { team_id: TEAM, id: STAGE_BACKLOG, replacement: STAGE_ACTIVE };
    rejects("delete_stage", args, 403, "permission denied", MEMBER);
    rejects("delete_stage", args, 403, "permission denied", VIEWER);
    rejects("delete_stage", args, 403, "permission denied", GHOST);
  });
});

describe("create_label / update_label", () => {
  it("creates and updates whole records", () => {
    const store = seedStore(MEMBER);
    mutate(store, "create_label", { id: "label-new", name: "Chore", color: "#00ff00" });
    expectRecord(store, "labels", "label-new", {
      id: "label-new",
      version: 1,
      name: "Chore",
      color: "#00ff00",
    });
    mutate(store, "update_label", { id: LABEL_ONE, name: "Defect", color: "#ff0000" });
    expectRecord(store, "labels", LABEL_ONE, {
      id: LABEL_ONE,
      version: 1,
      name: "Defect",
      color: "#ff0000",
    });
  });

  it("is idempotent", () => {
    twice("create_label", { id: "label-new", name: "N", color: "#fff" }, MEMBER);
    twice("update_label", { id: LABEL_ONE, name: "N", color: "#fff" }, MEMBER);
  });

  it("validates names, colors and ids", () => {
    rejects(
      "create_label",
      { id: "l", name: "", color: "#fff" },
      400,
      "text must contain 1 to 100 bytes",
      MEMBER,
    );
    rejects(
      "create_label",
      { id: "l", name: "N", color: "#".padEnd(42, "f") },
      400,
      "invalid color",
      MEMBER,
    );
    rejects("create_label", { name: "N", color: "#fff" }, 400, "id is required", MEMBER);
    rejects(
      "create_label",
      { id: "00000000-0000-0000-0000-000000000000", name: "N", color: "#fff" },
      400,
      "id must not be nil",
      MEMBER,
    );
    rejects(
      "update_label",
      { id: "label-ghost", name: "N", color: "#fff" },
      404,
      "not found",
      MEMBER,
    );
    rejects(
      "update_label",
      { id: LABEL_ONE, name: "N", color: "#".padEnd(42, "f") },
      400,
      "invalid color",
      MEMBER,
    );
  });

  it("members may manage labels but viewers may not", () => {
    const admin = seedStore(ADMIN);
    mutate(admin, "create_label", { id: "l", name: "N", color: "#fff" });
    expect(admin.replayErrors().size).toBe(0);
    rejects(
      "create_label",
      { id: "l", name: "N", color: "#fff" },
      403,
      "permission denied",
      VIEWER,
    );
    rejects(
      "update_label",
      { id: LABEL_ONE, name: "N", color: "#fff" },
      403,
      "permission denied",
      VIEWER,
    );
    rejects("create_label", { id: "l", name: "N", color: "#fff" }, 403, "permission denied", GHOST);
  });
});

describe("create_project / update_project", () => {
  it("creates and updates with sorted team ids", () => {
    const store = seedStore(MEMBER);
    mutate(store, "create_project", {
      id: "project-new",
      name: "New",
      description: "Body",
      team_ids: [TEAM_OTHER, TEAM],
    });
    expectRecord(store, "projects", "project-new", {
      id: "project-new",
      version: 1,
      name: "New",
      description: "Body",
      team_ids: [TEAM, TEAM_OTHER],
    });
    const before = store.get("projects", PROJECT);
    if (before === undefined) throw new Error("missing project");
    mutate(store, "update_project", {
      id: PROJECT,
      name: "Renamed",
      description: "",
      team_ids: [TEAM],
    });
    expectRecord(store, "projects", PROJECT, {
      ...(before as unknown as Project),
      name: "Renamed",
    });
  });

  it("is idempotent", () => {
    twice(
      "create_project",
      { id: "project-new", name: "N", description: "", team_ids: [TEAM] },
      MEMBER,
    );
    twice("update_project", { id: PROJECT, name: "N", description: "", team_ids: [TEAM] }, MEMBER);
  });

  it("validates names, descriptions, teams and ids", () => {
    const base = { id: "p", name: "N", description: "", team_ids: [TEAM] };
    rejects(
      "create_project",
      { ...base, name: " " },
      400,
      "text must contain 1 to 200 bytes",
      MEMBER,
    );
    rejects(
      "create_project",
      { ...base, description: "y".repeat(100_001) },
      400,
      "project description too long",
      MEMBER,
    );
    rejects("create_project", { ...base, team_ids: ["team-ghost"] }, 404, "not found", MEMBER);
    rejects(
      "create_project",
      { name: "N", description: "", team_ids: [] },
      400,
      "id is required",
      MEMBER,
    );
    rejects("update_project", { ...base, id: "project-ghost" }, 404, "not found", MEMBER);
  });

  it("refuses to drop a team that still holds the project's issues", () => {
    rejects(
      "update_project",
      { id: PROJECT, name: "N", description: "", team_ids: [TEAM_OTHER] },
      409,
      "project teams still contain issues",
      MEMBER,
    );
  });

  it("members may manage projects but viewers may not", () => {
    rejects(
      "create_project",
      { id: "p", name: "N", description: "", team_ids: [] },
      403,
      "permission denied",
      VIEWER,
    );
    rejects(
      "update_project",
      { id: PROJECT, name: "N", description: "", team_ids: [TEAM] },
      403,
      "permission denied",
      VIEWER,
    );
    rejects(
      "create_project",
      { id: "p", name: "N", description: "", team_ids: [] },
      403,
      "permission denied",
      GHOST,
    );
  });
});

describe("create_milestone / update_milestone", () => {
  it("creates and updates whole records", () => {
    const store = seedStore(MEMBER);
    mutate(store, "create_milestone", {
      id: "milestone-new",
      project_id: PROJECT,
      name: "M2",
      deadline: "2026-11-01T00:00:00.000Z",
    });
    expectRecord(store, "milestones", "milestone-new", {
      id: "milestone-new",
      version: 1,
      project_id: PROJECT,
      name: "M2",
      deadline: "2026-11-01T00:00:00.000Z",
    });
    mutate(store, "update_milestone", { id: MILESTONE, name: "Renamed", deadline: null });
    const renamed = store.get("milestones", MILESTONE);
    expect(renamed?.name).toBe("Renamed");
    expect(renamed?.deadline).toBeNull();
  });

  it("is idempotent", () => {
    twice("create_milestone", { id: "m", project_id: PROJECT, name: "N", deadline: null }, MEMBER);
    twice("update_milestone", { id: MILESTONE, name: "N", deadline: null }, MEMBER);
  });

  it("validates names, deadlines, projects and ids", () => {
    const base = { id: "m", project_id: PROJECT, name: "N", deadline: null };
    rejects(
      "create_milestone",
      { ...base, name: "" },
      400,
      "text must contain 1 to 200 bytes",
      MEMBER,
    );
    rejects(
      "create_milestone",
      { ...base, deadline: "not a timestamp" },
      400,
      "timestamp year must be between 1 and 9999",
      MEMBER,
    );
    rejects("create_milestone", { ...base, project_id: "project-ghost" }, 404, "not found", MEMBER);
    rejects(
      "create_milestone",
      { project_id: PROJECT, name: "N", deadline: null },
      400,
      "id is required",
      MEMBER,
    );
    rejects(
      "update_milestone",
      { id: "milestone-ghost", name: "N", deadline: null },
      404,
      "not found",
      MEMBER,
    );
  });

  it("members may manage milestones but viewers may not", () => {
    rejects(
      "create_milestone",
      { id: "m", project_id: PROJECT, name: "N", deadline: null },
      403,
      "permission denied",
      VIEWER,
    );
    rejects(
      "update_milestone",
      { id: MILESTONE, name: "N", deadline: null },
      403,
      "permission denied",
      VIEWER,
    );
    rejects(
      "create_milestone",
      { id: "m", project_id: PROJECT, name: "N", deadline: null },
      403,
      "permission denied",
      GHOST,
    );
  });
});

describe("create_sprint / update_sprint", () => {
  const STARTS = "2026-10-01T00:00:00.000Z";
  const ENDS = "2026-10-20T00:00:00.000Z";

  it("creates planned sprints and updates them", () => {
    const store = seedStore(MEMBER);
    mutate(store, "create_sprint", {
      id: "sprint-new",
      team_id: TEAM,
      name: "Next",
      goal: "Ship",
      starts_at: STARTS,
      ends_at: ENDS,
    });
    expectRecord(store, "sprints", "sprint-new", {
      id: "sprint-new",
      version: 1,
      team_id: TEAM,
      number: null,
      name: "Next",
      goal: "Ship",
      starts_at: STARTS,
      ends_at: ENDS,
      state: "planned",
      outcome: null,
    });
    mutate(store, "update_sprint", {
      id: "sprint-new",
      name: "Next up",
      goal: "",
      starts_at: STARTS,
      ends_at: ENDS,
      state: "active",
    });
    expect(store.get("sprints", "sprint-new")?.state).toBe("active");
  });

  it("is idempotent", () => {
    const args = { id: "s", team_id: TEAM, name: "N", goal: "", starts_at: STARTS, ends_at: ENDS };
    twice("create_sprint", args, MEMBER);
    twice("update_sprint", { ...args, id: SPRINT, state: "active" }, MEMBER);
  });

  it("validates sprints", () => {
    const base = { id: "s", team_id: TEAM, name: "N", goal: "", starts_at: STARTS, ends_at: ENDS };
    rejects(
      "create_sprint",
      { ...base, name: "" },
      400,
      "text must contain 1 to 200 bytes",
      MEMBER,
    );
    rejects(
      "create_sprint",
      { ...base, starts_at: ENDS, ends_at: STARTS },
      400,
      "sprint end must follow start",
      MEMBER,
    );
    rejects(
      "create_sprint",
      { ...base, goal: "g".repeat(100_001) },
      400,
      "sprint goal too long",
      MEMBER,
    );
    rejects(
      "create_sprint",
      { ...base, starts_at: "yesterday" },
      400,
      "timestamp year must be between 1 and 9999",
      MEMBER,
    );
    rejects("create_sprint", { ...base, team_id: "team-ghost" }, 404, "not found", MEMBER);
    rejects(
      "create_sprint",
      { team_id: TEAM, name: "N", goal: "", starts_at: STARTS, ends_at: ENDS },
      400,
      "id is required",
      MEMBER,
    );
    rejects(
      "update_sprint",
      { ...base, id: "sprint-ghost", state: "active" },
      404,
      "not found",
      MEMBER,
    );
    rejects(
      "update_sprint",
      { ...base, id: SPRINT, state: "completed" },
      400,
      "use completion or archive command",
      MEMBER,
    );
    rejects(
      "update_sprint",
      { ...base, id: SPRINT_FINISHED, state: "active" },
      409,
      "sprint already completed",
      MEMBER,
    );
  });

  it("members may manage sprints but viewers may not", () => {
    const base = { id: "s", team_id: TEAM, name: "N", goal: "", starts_at: STARTS, ends_at: ENDS };
    rejects("create_sprint", base, 403, "permission denied", VIEWER);
    rejects(
      "update_sprint",
      { ...base, id: SPRINT, state: "active" },
      403,
      "permission denied",
      VIEWER,
    );
    rejects("create_sprint", base, 403, "permission denied", GHOST);
  });
});

describe("complete_sprint", () => {
  it("completes, counts the outcome and clears unfinished issues", () => {
    const store = seedStore(MEMBER);
    mutate(store, "complete_sprint", { id: SPRINT, carryover_sprint_id: null });
    expectRecord(store, "sprints", SPRINT, {
      ...(store.baseGet("sprints", SPRINT) as unknown as RecordOf["sprints"]),
      state: "completed",
      outcome: { total: 1, completed: 0, effort: 0 },
    });
    const issue = store.get("issues", "issue-1");
    expect(issue?.sprint_id).toBeNull();
    expect(issue?.updated_at).toBe(AT);
  });

  it("carries unfinished issues over and keeps finished ones", () => {
    const store = seedStore(MEMBER);
    mutate(store, "create_sprint", {
      id: "sprint-next",
      team_id: TEAM,
      name: "Next",
      goal: "",
      starts_at: "2026-10-20T00:00:00.000Z",
      ends_at: "2026-11-01T00:00:00.000Z",
    });
    store.applyBase([
      {
        entity: "issues",
        id: "issue-3",
        record: { ...(store.get("issues", "issue-3") as object), sprint_id: SPRINT },
      },
    ]);
    mutate(store, "complete_sprint", { id: SPRINT, carryover_sprint_id: "sprint-next" });
    const sprint = store.get("sprints", SPRINT);
    expect(sprint?.outcome).toEqual({ total: 2, completed: 1, effort: 0 });
    expect(store.get("issues", "issue-1")?.sprint_id).toBe("sprint-next");
    expect(store.get("issues", "issue-3")?.sprint_id).toBe(SPRINT);
  });

  it("completing a completed sprint is a no-op in both modes", () => {
    const store = seedStore(MEMBER);
    const before = beforeAll(store);
    const id = mutate(store, "complete_sprint", { id: SPRINT_FINISHED, carryover_sprint_id: null });
    expect(store.replayErrors().get(id)).toBeUndefined();
    expectSame(store, before);
    twice("complete_sprint", { id: SPRINT, carryover_sprint_id: null }, MEMBER);
  });

  it("validates the sprint and the carryover", () => {
    rejects(
      "complete_sprint",
      { id: "sprint-ghost", carryover_sprint_id: null },
      404,
      "not found",
      MEMBER,
    );
    const archived = seedStore(MEMBER);
    archived.applyBase([
      {
        entity: "sprints",
        id: SPRINT_FINISHED,
        record: { ...(archived.get("sprints", SPRINT_FINISHED) as object), state: "archived" },
      },
    ]);
    const bad = mutate(archived, "complete_sprint", {
      id: SPRINT_FINISHED,
      carryover_sprint_id: null,
    });
    expect(archived.replayErrors().get(bad)?.status).toBe(409);
    expect(archived.replayErrors().get(bad)?.message).toBe("sprint archived");
    const base = { id: SPRINT, carryover_sprint_id: "sprint-ghost" };
    rejects("complete_sprint", base, 404, "not found", MEMBER);
    rejects(
      "complete_sprint",
      { ...base, carryover_sprint_id: SPRINT },
      400,
      "invalid carryover sprint",
      MEMBER,
    );
    rejects(
      "complete_sprint",
      { ...base, carryover_sprint_id: SPRINT_OTHER },
      400,
      "invalid carryover sprint",
      MEMBER,
    );
    rejects(
      "complete_sprint",
      { ...base, carryover_sprint_id: SPRINT_FINISHED },
      400,
      "invalid carryover sprint",
      MEMBER,
    );
  });

  it("members may complete sprints but viewers may not", () => {
    rejects(
      "complete_sprint",
      { id: SPRINT, carryover_sprint_id: null },
      403,
      "permission denied",
      VIEWER,
    );
    rejects(
      "complete_sprint",
      { id: SPRINT, carryover_sprint_id: null },
      403,
      "permission denied",
      GHOST,
    );
  });
});

describe("archive_sprint", () => {
  it("archives completed sprints", () => {
    const store = seedStore(MEMBER);
    const before = store.get("sprints", SPRINT_FINISHED);
    if (before === undefined) throw new Error("missing sprint");
    mutate(store, "archive_sprint", { id: SPRINT_FINISHED });
    expectRecord(store, "sprints", SPRINT_FINISHED, {
      ...(before as RecordOf["sprints"]),
      state: "archived",
    });
  });

  it("is idempotent", () => {
    twice("archive_sprint", { id: SPRINT_FINISHED }, MEMBER);
  });

  it("validates the sprint", () => {
    rejects("archive_sprint", { id: "sprint-ghost" }, 404, "not found", MEMBER);
    rejects("archive_sprint", { id: SPRINT }, 400, "complete sprint before archiving", MEMBER);
    admitsRejects("archive_sprint", { id: "sprint-ghost" }, 404, "not found", MEMBER);
  });

  it("members may archive sprints but viewers may not", () => {
    rejects("archive_sprint", { id: SPRINT_FINISHED }, 403, "permission denied", VIEWER);
    rejects("archive_sprint", { id: SPRINT_FINISHED }, 403, "permission denied", GHOST);
  });
});
