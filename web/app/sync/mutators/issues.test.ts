import { describe, expect, it } from "vite-plus/test";
import type { Id } from "../../lib/types";
import { normalize } from "../records";
import type { SyncIssue } from "../records";
import type { SyncStore } from "../store";
import {
  ADMIN,
  AT,
  GHOST,
  LABEL_ONE,
  LABEL_TWO,
  MEMBER,
  MILESTONE,
  MILESTONE_OTHER,
  OWNER,
  PROJECT,
  PROJECT_OTHER,
  SPRINT,
  SPRINT_FINISHED,
  SPRINT_OTHER,
  STAGE_ACTIVE,
  STAGE_BACKLOG,
  STAGE_CANCELLED,
  STAGE_DONE,
  TEAM,
  TEAM_OTHER,
  VIEWER,
  mutate,
  seedStore,
  snapshotIssues,
} from "./fixtures";
import { admit } from "./index";

function live(store: SyncStore, id: string): SyncIssue {
  const issue = store.get("issues", id);
  if (issue === undefined) throw new Error(`missing fixture issue ${id}`);
  return issue as SyncIssue;
}

/** Asserts the whole resulting record against an explicit full expected record. */
function expectRecord(store: SyncStore, id: string, expected: SyncIssue): void {
  expect(store.get("issues", id)).toEqual(normalize("issues", expected));
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
  const before = snapshotIssues(store);
  const id = mutate(store, name, args);
  const error = store.replayErrors().get(id);
  expect(error?.status).toBe(status);
  expect(error?.message).toBe(message);
  expect(snapshotIssues(store)).toEqual(before);
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
  const before = snapshotIssues(store);
  let error: unknown;
  try {
    admit(store, actor, { name, args, at: AT });
  } catch (caught) {
    error = caught;
  }
  const record = error as { status?: number; message?: string } | undefined;
  expect(record?.status).toBe(status);
  expect(record?.message).toBe(message);
  expect(snapshotIssues(store)).toEqual(before);
  expect(store.replayErrors().size).toBe(0);
}

/** Running a mutation twice leaves the same view as running it once, with no errors. */
function twice(name: string, args: unknown, actor: Id = MEMBER): void {
  const once = seedStore(actor);
  mutate(once, name, args);
  expect(once.replayErrors().size).toBe(0);
  const first = snapshotIssues(once);
  const both = seedStore(actor);
  mutate(both, name, args);
  mutate(both, name, args);
  expect(both.replayErrors().size).toBe(0);
  expect(snapshotIssues(both)).toEqual(first);
}

describe("create_issue", () => {
  it("makes members the description mentions followers", () => {
    const store = seedStore();
    const input = {
      id: "issue-new",
      title: "New",
      team_id: TEAM,
      description: `cc [@Admin](mention:${ADMIN})`,
    };
    mutate(store, "create_issue", { input });
    expect(live(store, "issue-new").followers).toEqual([ADMIN, MEMBER]);
  });

  it("creates with defaults and the actor as follower", () => {
    const store = seedStore();
    mutate(store, "create_issue", { input: { id: "issue-new", title: "New", team_id: TEAM } });
    expect(store.get("issues", "issue-new")).toEqual(
      normalize("issues", {
        tracker: null,
        id: "issue-new",
        version: 1,
        // The team's issues, including trash and archive, go up to 15.
        number: 16,
        title: "New",
        description: "",
        team_id: TEAM,
        stage_id: STAGE_BACKLOG,
        assignee: null,
        created_by: MEMBER,
        priority: "none",
        labels: [],
        estimate: null,
        deadline: null,
        project_id: null,
        milestone_id: null,
        sprint_id: null,
        parent_id: null,
        dependencies: [],
        // Backlog holds issue-x at 0 and issue-y at 1024: max + 1024.
        position: 2048,
        followers: [MEMBER],
        attachments: [],
        source_links: [],
        deleted_at: null,
        archived_at: null,
        done_at: null,
        created_at: AT,
        updated_at: AT,
      }),
    );
  });

  it("creates with every field and stamps done_at in a done stage", () => {
    const store = seedStore();
    const before = live(store, "issue-1");
    mutate(store, "create_issue", {
      input: {
        id: "issue-full",
        title: "Full",
        description: "Body",
        team_id: TEAM,
        stage_id: STAGE_DONE,
        assignee: ADMIN,
        priority: "high",
        labels: [LABEL_ONE, LABEL_TWO],
        estimate: 5,
        deadline: "2026-11-01T00:00:00.000Z",
        project_id: PROJECT,
        milestone_id: MILESTONE,
        sprint_id: SPRINT,
        parent_id: "issue-1",
        dependencies: ["issue-3"],
      },
    });
    expect(store.get("issues", "issue-full")).toEqual(
      normalize("issues", {
        ...before,
        id: "issue-full",
        number: 16,
        title: "Full",
        description: "Body",
        stage_id: STAGE_DONE,
        assignee: ADMIN,
        created_by: MEMBER,
        priority: "high",
        labels: [LABEL_ONE, LABEL_TWO],
        estimate: 5,
        deadline: "2026-11-01T00:00:00.000Z",
        project_id: PROJECT,
        milestone_id: MILESTONE,
        sprint_id: SPRINT,
        parent_id: "issue-1",
        dependencies: ["issue-3"],
        // Done holds issue-3 at 0, issue-archived at 1024 and issue-op-done at 2048.
        position: 3072,
        followers: [ADMIN, MEMBER],
        done_at: AT,
        created_at: AT,
        updated_at: AT,
      }),
    );
  });

  it("overwrites an existing id with the same result when run twice", () => {
    twice("create_issue", { input: { id: "issue-new", title: "New", team_id: TEAM } });
  });

  it("numbers after the team's highest and renumbers when a pull takes the number", () => {
    const store = seedStore();
    for (const [id, team] of [
      ["issue-new", TEAM],
      ["issue-other", TEAM_OTHER],
      ["issue-next", TEAM],
    ])
      mutate(store, "create_issue", { input: { id, title: id, team_id: team } });
    const number = (id: string) => store.get("issues", id)?.number;
    expect([number("issue-new"), number("issue-next"), number("issue-other")]).toEqual([16, 17, 1]);
    // Another client created first, so the server will give the pending issues later numbers.
    store.applyBase([
      {
        entity: "issues",
        id: "issue-remote",
        record: { ...live(store, "issue-1"), id: "issue-remote", number: 16 },
      },
    ]);
    expect([number("issue-new"), number("issue-next"), number("issue-other")]).toEqual([17, 18, 1]);
  });

  it("requires an id, rejects nil, and validates text", () => {
    rejects("create_issue", { input: { title: "No id", team_id: TEAM } }, 400, "id is required");
    rejects(
      "create_issue",
      { input: { id: "00000000-0000-0000-0000-000000000000", title: "Nil", team_id: TEAM } },
      400,
      "id must not be nil",
    );
    rejects(
      "create_issue",
      { input: { id: "x", title: "  ", team_id: TEAM } },
      400,
      "text must contain 1 to 500 bytes",
    );
    rejects(
      "create_issue",
      { input: { id: "x", title: "T", team_id: TEAM, description: "y".repeat(100_001) } },
      400,
      "description too long",
    );
  });

  it("resolves the default stage and validates stages", () => {
    rejects(
      "create_issue",
      { input: { id: "x", title: "T", team_id: TEAM, stage_id: "stage-ghost" } },
      400,
      "stage belongs to another team",
    );
    rejects(
      "create_issue",
      { input: { id: "x", title: "T", team_id: TEAM, stage_id: "stage-2-todo" } },
      400,
      "stage belongs to another team",
    );
    rejects(
      "create_issue",
      { input: { id: "x", title: "T", team_id: "team-ghost" } },
      404,
      "not found",
    );
  });

  it("validates references", () => {
    const base = { id: "x", title: "T", team_id: TEAM };
    rejects("create_issue", { input: { ...base, assignee: GHOST } }, 403, "permission denied");
    rejects("create_issue", { input: { ...base, labels: ["label-ghost"] } }, 400, "unknown label");
    rejects(
      "create_issue",
      { input: { ...base, project_id: PROJECT_OTHER } },
      400,
      "project does not include team",
    );
    rejects(
      "create_issue",
      { input: { ...base, project_id: "project-ghost" } },
      400,
      "project does not include team",
    );
    rejects(
      "create_issue",
      { input: { ...base, milestone_id: "milestone-ghost" } },
      404,
      "not found",
    );
    rejects(
      "create_issue",
      { input: { ...base, project_id: PROJECT, milestone_id: MILESTONE_OTHER } },
      400,
      "milestone belongs to another project",
    );
    rejects(
      "create_issue",
      { input: { ...base, milestone_id: MILESTONE } },
      400,
      "milestone belongs to another project",
    );
    rejects("create_issue", { input: { ...base, sprint_id: "sprint-ghost" } }, 404, "not found");
    rejects(
      "create_issue",
      { input: { ...base, sprint_id: SPRINT_OTHER } },
      400,
      "sprint is unavailable for this team",
    );
    rejects(
      "create_issue",
      { input: { ...base, sprint_id: SPRINT_FINISHED } },
      400,
      "sprint is unavailable for this team",
    );
    rejects("create_issue", { input: { ...base, parent_id: "issue-ghost" } }, 404, "not found");
    rejects("create_issue", { input: { ...base, parent_id: "issue-deleted" } }, 404, "not found");
    rejects(
      "create_issue",
      { input: { ...base, dependencies: ["issue-ghost"] } },
      404,
      "not found",
    );
    rejects(
      "create_issue",
      { input: { ...base, dependencies: ["issue-deleted"] } },
      400,
      "invalid dependency",
    );
    rejects(
      "create_issue",
      { input: { ...base, stage_id: STAGE_ACTIVE, dependencies: ["issue-1"] } },
      409,
      "issue has unfinished dependencies",
    );
  });

  it("accepts tracker-linked issues as parents and dependencies", () => {
    const store = seedStore();
    mutate(store, "create_issue", {
      input: { id: "issue-new", title: "New", team_id: TEAM, parent_id: "issue-op" },
    });
    mutate(store, "update_issue", { id: "issue-2", patch: { dependencies: ["issue-op-done"] } });
    expect(store.replayErrors().size).toBe(0);
    expect(live(store, "issue-new").parent_id).toBe("issue-op");
    expect(live(store, "issue-2").dependencies).toEqual(["issue-op-done"]);
  });

  it("enforces viewer rules", () => {
    rejects(
      "create_issue",
      { input: { id: "x", title: "T", team_id: TEAM } },
      403,
      "permission denied",
      VIEWER,
    );
    rejects(
      "create_issue",
      { input: { id: "x", title: "T", team_id: TEAM } },
      403,
      "permission denied",
      GHOST,
    );
  });
});

describe("update_issue", () => {
  it("makes members the description newly mentions followers", () => {
    const store = seedStore();
    const text = `Ask [@Someone](mention:${ADMIN}) and [@Gone](mention:${GHOST})`;
    mutate(store, "update_issue", { id: "issue-2", patch: { description: text } });
    expect(live(store, "issue-2").followers).toEqual([ADMIN]);
    mutate(store, "follow", { issue_id: "issue-2", user_id: ADMIN, following: false });
    mutate(store, "update_issue", { id: "issue-2", patch: { description: `${text}, soon` } });
    expect(live(store, "issue-2").followers).toEqual([]);
  });

  it("makes a new assignee a follower and keeps them after unassigning", () => {
    const store = seedStore();
    mutate(store, "update_issue", { id: "issue-2", patch: { assignee: ADMIN } });
    expect(live(store, "issue-2").followers).toContain(ADMIN);
    mutate(store, "update_issue", { id: "issue-2", patch: { clear_assignee: true } });
    expect(live(store, "issue-2").followers).toContain(ADMIN);
  });

  it("patches named fields and stamps updated_at", () => {
    const store = seedStore();
    const before = live(store, "issue-2");
    mutate(store, "update_issue", {
      id: "issue-2",
      patch: { title: "Renamed", description: "New body", priority: "urgent", estimate: 8 },
    });
    expectRecord(store, "issue-2", {
      ...before,
      title: "Renamed",
      description: "New body",
      priority: "urgent",
      estimate: 8,
      updated_at: AT,
    });
  });

  it("clears fields and clears the milestone with the project", () => {
    const store = seedStore();
    mutate(store, "update_issue", {
      id: "issue-1",
      patch: {
        clear_assignee: true,
        clear_estimate: true,
        clear_project: true,
        clear_sprint: true,
      },
    });
    const view = live(store, "issue-1");
    expect(view.assignee).toBeNull();
    expect(view.project_id).toBeNull();
    expect(view.milestone_id).toBeNull();
    expect(view.sprint_id).toBeNull();
  });

  it("sets done_at when entering done and clears it when leaving", () => {
    const intoDone = seedStore();
    mutate(intoDone, "update_issue", { id: "issue-2", patch: { stage_id: STAGE_DONE } });
    expect(live(intoDone, "issue-2").done_at).toBe(AT);

    const outOfDone = seedStore();
    mutate(outOfDone, "update_issue", { id: "issue-3", patch: { stage_id: STAGE_ACTIVE } });
    expect(live(outOfDone, "issue-3").done_at).toBeNull();
  });

  it("is idempotent", () => {
    twice("update_issue", { id: "issue-2", patch: { title: "Renamed", labels: [LABEL_TWO] } });
  });

  it("rejects missing, deleted and archived issues", () => {
    rejects("update_issue", { id: "issue-ghost", patch: { title: "T" } }, 404, "not found");
    rejects("update_issue", { id: "issue-deleted", patch: { title: "T" } }, 404, "not found");
    rejects(
      "update_issue",
      { id: "issue-archived", patch: { title: "T" } },
      409,
      "issue is archived",
    );
  });

  it("validates the patched references", () => {
    rejects(
      "update_issue",
      { id: "issue-2", patch: { title: "" } },
      400,
      "text must contain 1 to 500 bytes",
    );
    rejects(
      "update_issue",
      { id: "issue-2", patch: { stage_id: "stage-2-todo" } },
      400,
      "stage belongs to another team",
    );
    rejects(
      "update_issue",
      { id: "issue-2", patch: { assignee: GHOST } },
      403,
      "permission denied",
    );
    rejects(
      "update_issue",
      { id: "issue-2", patch: { labels: [LABEL_ONE, "label-ghost"] } },
      400,
      "unknown label",
    );
    rejects(
      "update_issue",
      { id: "issue-2", patch: { project_id: PROJECT_OTHER } },
      400,
      "project does not include team",
    );
    rejects(
      "update_issue",
      { id: "issue-2", patch: { milestone_id: MILESTONE } },
      400,
      "milestone belongs to another project",
    );
    rejects(
      "update_issue",
      { id: "issue-2", patch: { sprint_id: SPRINT_OTHER } },
      400,
      "sprint is unavailable for this team",
    );
    rejects(
      "update_issue",
      { id: "issue-2", patch: { sprint_id: SPRINT_FINISHED } },
      400,
      "sprint is unavailable for this team",
    );
    rejects(
      "update_issue",
      { id: "issue-2", patch: { parent_id: "issue-ghost" } },
      404,
      "not found",
    );
    rejects(
      "update_issue",
      { id: "issue-2", patch: { parent_id: "issue-2" } },
      400,
      "parent cycle",
    );
    rejects(
      "update_issue",
      { id: "issue-1", patch: { parent_id: "issue-child" } },
      400,
      "parent cycle",
    );
    rejects(
      "update_issue",
      { id: "issue-2", patch: { dependencies: ["issue-ghost"] } },
      404,
      "not found",
    );
    rejects(
      "update_issue",
      { id: "issue-2", patch: { dependencies: ["issue-2"] } },
      400,
      "invalid dependency",
    );
    rejects(
      "update_issue",
      { id: "issue-2", patch: { dependencies: ["issue-deleted"] } },
      400,
      "invalid dependency",
    );
    rejects(
      "update_issue",
      { id: "issue-2", patch: { dependencies: ["issue-1"] } },
      409,
      "issue has unfinished dependencies",
    );
    rejects(
      "update_issue",
      { id: "issue-y", patch: { dependencies: ["issue-x"] } },
      400,
      "dependency cycle",
    );
  });

  it("edits tracker-linked issues and keeps their link", () => {
    const store = seedStore();
    const before = live(store, "issue-op");
    mutate(store, "update_issue", { id: "issue-op", patch: { title: "Local title" } });
    expect(store.replayErrors().size).toBe(0);
    expect(live(store, "issue-op").title).toBe("Local title");
    expect(live(store, "issue-op").tracker).toEqual(before.tracker);
  });

  it("enforces viewer rules", () => {
    rejects(
      "update_issue",
      { id: "issue-2", patch: { title: "T" } },
      403,
      "permission denied",
      VIEWER,
    );
    rejects(
      "update_issue",
      { id: "issue-2", patch: { title: "T" } },
      403,
      "permission denied",
      GHOST,
    );
  });
});

describe("move_issue", () => {
  it("moves to the end of the stage and stamps done_at on entering done", () => {
    const store = seedStore();
    mutate(store, "move_issue", { id: "issue-2", stage_id: STAGE_DONE, before_id: null });
    const view = live(store, "issue-2");
    // Stage done holds issue-3 at 0, issue-archived at 1024 and issue-op-done at 2048.
    expect(view.position).toBe(3072);
    expect(view.stage_id).toBe(STAGE_DONE);
    expect(view.done_at).toBe(AT);
    expect(view.updated_at).toBe(AT);
  });

  it("slots before the neighbor at the midpoint", () => {
    const store = seedStore();
    mutate(store, "move_issue", { id: "issue-1", stage_id: STAGE_ACTIVE, before_id: "issue-2" });
    // No live row sits below issue-2 at 1024, so lower is 1024 - 2048.
    expect(live(store, "issue-1").position).toBe(0);
  });

  it("keeps done_at when reordering within the stage", () => {
    const store = seedStore();
    const before = live(store, "issue-3").done_at;
    mutate(store, "move_issue", { id: "issue-3", stage_id: STAGE_DONE, before_id: null });
    expect(live(store, "issue-3").done_at).toBe(before);
  });

  it("is idempotent", () => {
    twice("move_issue", { id: "issue-2", stage_id: STAGE_DONE, before_id: null });
    twice("move_issue", { id: "issue-1", stage_id: STAGE_ACTIVE, before_id: "issue-2" });
  });

  it("rejects missing, deleted and archived issues", () => {
    rejects(
      "move_issue",
      { id: "issue-ghost", stage_id: STAGE_DONE, before_id: null },
      404,
      "not found",
    );
    rejects(
      "move_issue",
      { id: "issue-deleted", stage_id: STAGE_DONE, before_id: null },
      404,
      "not found",
    );
    rejects(
      "move_issue",
      { id: "issue-archived", stage_id: STAGE_DONE, before_id: null },
      409,
      "issue is archived",
    );
  });

  it("validates the stage and the neighbor", () => {
    rejects(
      "move_issue",
      { id: "issue-2", stage_id: "stage-2-todo", before_id: null },
      400,
      "stage belongs to another team",
    );
    rejects(
      "move_issue",
      { id: "issue-2", stage_id: STAGE_DONE, before_id: "issue-ghost" },
      404,
      "not found",
    );
    rejects(
      "move_issue",
      { id: "issue-2", stage_id: STAGE_DONE, before_id: "issue-deleted" },
      404,
      "not found",
    );
    rejects(
      "move_issue",
      { id: "issue-2", stage_id: STAGE_ACTIVE, before_id: "issue-2" },
      400,
      "invalid ordering neighbor",
    );
    rejects(
      "move_issue",
      { id: "issue-2", stage_id: STAGE_ACTIVE, before_id: "issue-3" },
      400,
      "invalid ordering neighbor",
    );
    rejects(
      "move_issue",
      { id: "issue-2", stage_id: STAGE_DONE, before_id: "issue-1" },
      400,
      "invalid ordering neighbor",
    );
  });

  it("revalidates dependencies in the new stage", () => {
    rejects(
      "move_issue",
      { id: "issue-a", stage_id: STAGE_DONE, before_id: null },
      409,
      "issue has unfinished dependencies",
    );
  });

  it("enforces viewer rules", () => {
    rejects(
      "move_issue",
      { id: "issue-2", stage_id: STAGE_DONE, before_id: null },
      403,
      "permission denied",
      VIEWER,
    );
    rejects(
      "move_issue",
      { id: "issue-2", stage_id: STAGE_DONE, before_id: null },
      403,
      "permission denied",
      GHOST,
    );
  });
});

describe("backlog and sprints", () => {
  const placement = (store: SyncStore, id: string) => {
    const { stage_id, sprint_id } = live(store, id);
    return { stage_id, sprint_id };
  };

  it("takes an issue out of its sprint when it enters a backlog stage", () => {
    const patched = seedStore();
    mutate(patched, "update_issue", { id: "issue-1", patch: { stage_id: STAGE_BACKLOG } });
    expect(placement(patched, "issue-1")).toEqual({ stage_id: STAGE_BACKLOG, sprint_id: null });

    const moved = seedStore();
    mutate(moved, "move_issue", { id: "issue-1", stage_id: STAGE_BACKLOG, before_id: null });
    expect(placement(moved, "issue-1")).toEqual({ stage_id: STAGE_BACKLOG, sprint_id: null });
  });

  it("moves a backlog issue that joins a sprint to the sprint stage", () => {
    // The fixture team has no planned stage, so its first active stage takes sprint work.
    const store = seedStore();
    mutate(store, "update_issue", { id: "issue-y", patch: { sprint_id: SPRINT } });
    expect(placement(store, "issue-y")).toEqual({ stage_id: STAGE_ACTIVE, sprint_id: SPRINT });
  });

  it("lets a named backlog stage win over the sprint", () => {
    const store = seedStore();
    mutate(store, "update_issue", {
      id: "issue-2",
      patch: { stage_id: STAGE_BACKLOG, sprint_id: SPRINT },
    });
    expect(placement(store, "issue-2")).toEqual({ stage_id: STAGE_BACKLOG, sprint_id: null });
  });

  it("creates sprint work outside the default backlog stage", () => {
    const store = seedStore();
    const input = { title: "Sprint work", team_id: TEAM, sprint_id: SPRINT };
    mutate(store, "create_issue", { input: { ...input, id: "issue-default" } });
    expect(placement(store, "issue-default")).toEqual({
      stage_id: STAGE_ACTIVE,
      sprint_id: SPRINT,
    });

    mutate(store, "create_issue", {
      input: { ...input, id: "issue-named", stage_id: STAGE_BACKLOG },
    });
    expect(placement(store, "issue-named")).toEqual({ stage_id: STAGE_BACKLOG, sprint_id: null });
  });
});

describe("delete_issue / restore_issue", () => {
  it("deletes and restores with timestamps", () => {
    const store = seedStore();
    const before = live(store, "issue-2");
    mutate(store, "delete_issue", { id: "issue-2" });
    expectRecord(store, "issue-2", { ...before, deleted_at: AT, updated_at: AT });

    mutate(store, "restore_issue", { id: "issue-2" });
    expectRecord(store, "issue-2", { ...before, deleted_at: null, updated_at: AT });
  });

  it("deletes archived issues", () => {
    const store = seedStore();
    mutate(store, "delete_issue", { id: "issue-archived" });
    expect(live(store, "issue-archived").deleted_at).toBe(AT);
  });

  it("restores the trashed fixture", () => {
    const store = seedStore();
    mutate(store, "restore_issue", { id: "issue-deleted" });
    expect(live(store, "issue-deleted").deleted_at).toBeNull();
  });

  it("is idempotent in effect", () => {
    twice("delete_issue", { id: "issue-2" });
    const restored = seedStore();
    mutate(restored, "delete_issue", { id: "issue-2" });
    mutate(restored, "restore_issue", { id: "issue-2" });
    expect(restored.replayErrors().size).toBe(0);
    const first = snapshotIssues(restored);
    mutate(restored, "restore_issue", { id: "issue-2" });
    expect(restored.replayErrors().size).toBe(0);
    expect(snapshotIssues(restored)).toEqual(first);
  });

  it("rejects bad trash transitions", () => {
    rejects("delete_issue", { id: "issue-ghost" }, 404, "not found");
    admitsRejects("delete_issue", { id: "issue-deleted" }, 404, "not found");
    rejects("restore_issue", { id: "issue-ghost" }, 404, "not found");
    admitsRejects("restore_issue", { id: "issue-1" }, 400, "issue is not deleted");
  });

  it("enforces viewer rules", () => {
    rejects("delete_issue", { id: "issue-2" }, 403, "permission denied", VIEWER);
    rejects("restore_issue", { id: "issue-deleted" }, 403, "permission denied", VIEWER);
    rejects("delete_issue", { id: "issue-2" }, 403, "permission denied", GHOST);
  });
});

describe("archive_issue / unarchive_issue", () => {
  it("archives done issues and restarts the done clock on unarchive", () => {
    const store = seedStore();
    const before = live(store, "issue-3");
    mutate(store, "archive_issue", { id: "issue-3" });
    expectRecord(store, "issue-3", { ...before, archived_at: AT, updated_at: AT });

    mutate(store, "unarchive_issue", { id: "issue-3" });
    expectRecord(store, "issue-3", { ...before, archived_at: null, done_at: AT, updated_at: AT });
  });

  it("archives and unarchives imported issues like local ones", () => {
    const store = seedStore();
    const before = live(store, "issue-op-done");
    mutate(store, "archive_issue", { id: "issue-op-done" });
    expect(store.replayErrors().size).toBe(0);
    expectRecord(store, "issue-op-done", { ...before, archived_at: AT, updated_at: AT });
    mutate(store, "unarchive_issue", { id: "issue-op-done" });
    expect(store.replayErrors().size).toBe(0);
    expect(live(store, "issue-op-done").archived_at).toBeNull();
  });

  it("is idempotent in effect", () => {
    twice("archive_issue", { id: "issue-3" });
    const unarchived = seedStore();
    mutate(unarchived, "unarchive_issue", { id: "issue-archived" });
    expect(unarchived.replayErrors().size).toBe(0);
    const first = snapshotIssues(unarchived);
    mutate(unarchived, "unarchive_issue", { id: "issue-archived" });
    expect(unarchived.replayErrors().size).toBe(0);
    expect(snapshotIssues(unarchived)).toEqual(first);
  });

  it("rejects bad archive transitions", () => {
    rejects("archive_issue", { id: "issue-ghost" }, 404, "not found");
    rejects("archive_issue", { id: "issue-deleted" }, 404, "not found");
    rejects("archive_issue", { id: "issue-2" }, 400, "only issues in a Done stage can be archived");
    rejects(
      "archive_issue",
      { id: "issue-cancelled" },
      400,
      "only issues in a Done stage can be archived",
    );
    admitsRejects("archive_issue", { id: "issue-archived" }, 400, "issue is already archived");
    rejects("unarchive_issue", { id: "issue-ghost" }, 404, "not found");
    rejects("unarchive_issue", { id: "issue-deleted" }, 404, "not found");
    admitsRejects("unarchive_issue", { id: "issue-1" }, 400, "issue is not archived");
  });

  it("enforces the viewer rule", () => {
    rejects("archive_issue", { id: "issue-3" }, 403, "permission denied", VIEWER);
    rejects("unarchive_issue", { id: "issue-archived" }, 403, "permission denied", VIEWER);
    rejects("archive_issue", { id: "issue-3" }, 403, "permission denied", GHOST);
  });
});

describe("bulk_issues", () => {
  it("updates many issues at once", () => {
    const store = seedStore();
    mutate(store, "bulk_issues", {
      ids: ["issue-2", "issue-1"],
      action: { update: { title: "Bulk" } },
    });
    expect(live(store, "issue-1").title).toBe("Bulk");
    expect(live(store, "issue-2").title).toBe("Bulk");
    expect(live(store, "issue-1").updated_at).toBe(AT);
  });

  it("deletes, restores, archives and unarchives", () => {
    const store = seedStore();
    mutate(store, "bulk_issues", { ids: ["issue-1", "issue-2"], action: "delete" });
    expect(live(store, "issue-1").deleted_at).toBe(AT);
    expect(live(store, "issue-2").deleted_at).toBe(AT);

    mutate(store, "bulk_issues", { ids: ["issue-1", "issue-deleted"], action: "restore" });
    expect(live(store, "issue-1").deleted_at).toBeNull();
    expect(live(store, "issue-deleted").deleted_at).toBeNull();

    mutate(store, "bulk_issues", { ids: ["issue-3"], action: "archive" });
    expect(live(store, "issue-3").archived_at).toBe(AT);

    mutate(store, "bulk_issues", { ids: ["issue-3", "issue-archived"], action: "unarchive" });
    expect(live(store, "issue-3").archived_at).toBeNull();
    expect(live(store, "issue-archived").archived_at).toBeNull();
  });

  it("is idempotent in effect", () => {
    twice("bulk_issues", { ids: ["issue-1", "issue-2"], action: { update: { title: "Bulk" } } });
    twice("bulk_issues", { ids: ["issue-1", "issue-2"], action: "delete" });
    twice("bulk_issues", { ids: ["issue-3"], action: "archive" });
  });

  it("limits batch size and fails whole batches on missing ids", () => {
    rejects("bulk_issues", { ids: [], action: "delete" }, 400, "select 1 to 500 issues");
    rejects(
      "bulk_issues",
      { ids: Array.from({ length: 501 }, (_, n) => `issue-${n}`), action: "delete" },
      400,
      "select 1 to 500 issues",
    );
    const store = seedStore();
    const before = snapshotIssues(store);
    const id = mutate(store, "bulk_issues", { ids: ["issue-1", "issue-ghost"], action: "delete" });
    expect(store.replayErrors().get(id)?.status).toBe(404);
    expect(snapshotIssues(store)).toEqual(before);
  });

  it("applies single-command rules per id", () => {
    rejects(
      "bulk_issues",
      { ids: ["issue-2"], action: "archive" },
      400,
      "only issues in a Done stage can be archived",
    );
    rejects(
      "bulk_issues",
      { ids: ["issue-archived"], action: { update: { title: "T" } } },
      409,
      "issue is archived",
    );
    admitsRejects("bulk_issues", { ids: ["issue-deleted"], action: "delete" }, 404, "not found");
  });

  it("enforces viewer rules", () => {
    rejects(
      "bulk_issues",
      { ids: ["issue-1"], action: "delete" },
      403,
      "permission denied",
      VIEWER,
    );
    rejects("bulk_issues", { ids: ["issue-1"], action: "delete" }, 403, "permission denied", GHOST);
  });
});

describe("follow", () => {
  it("adds and removes the actor without touching other fields", () => {
    const store = seedStore();
    const before = live(store, "issue-2");
    mutate(store, "follow", { issue_id: "issue-2", following: true });
    expectRecord(store, "issue-2", { ...before, followers: [MEMBER] });

    const followed = live(store, "issue-followed");
    mutate(store, "follow", { issue_id: "issue-followed", following: false });
    expect(store.get("issues", "issue-followed")).toEqual(
      normalize("issues", { ...followed, followers: ["user-owner"] }),
    );
  });

  it("repeats are no-ops", () => {
    twice("follow", { issue_id: "issue-followed", following: true });
    twice("follow", { issue_id: "issue-followed", following: false });
  });

  it("rejects missing and deleted issues", () => {
    rejects("follow", { issue_id: "issue-ghost", following: true }, 404, "not found");
    rejects("follow", { issue_id: "issue-deleted", following: true }, 404, "not found");
  });

  it("viewers may follow; imported issues may be followed", () => {
    const store = seedStore(VIEWER);
    mutate(store, "follow", { issue_id: "issue-2", following: true });
    expect(live(store, "issue-2").followers).toEqual([VIEWER]);

    const imported = seedStore();
    mutate(imported, "follow", { issue_id: "issue-op", following: true });
    expect(live(imported, "issue-op").followers).toContain(MEMBER);

    rejects("follow", { issue_id: "issue-2", following: true }, 403, "permission denied", GHOST);
  });

  it("adds and removes another member", () => {
    const store = seedStore();
    mutate(store, "follow", { issue_id: "issue-2", following: true, user_id: ADMIN });
    expect(live(store, "issue-2").followers).toEqual([ADMIN]);
    mutate(store, "follow", { issue_id: "issue-2", following: false, user_id: ADMIN });
    expect(live(store, "issue-2").followers).toEqual([]);
  });

  it("lets viewers change only their own follow, and only for members", () => {
    const store = seedStore(VIEWER);
    mutate(store, "follow", { issue_id: "issue-2", following: true, user_id: VIEWER });
    expect(live(store, "issue-2").followers).toEqual([VIEWER]);
    const others = { issue_id: "issue-2", following: true, user_id: MEMBER };
    rejects("follow", others, 403, "permission denied", VIEWER);
    const outsider = { issue_id: "issue-2", following: true, user_id: GHOST };
    rejects("follow", outsider, 403, "permission denied");
  });
});

describe("add_source_link", () => {
  it("appends the link without touching other fields", () => {
    const store = seedStore();
    const before = live(store, "issue-2");
    mutate(store, "add_source_link", {
      issue_id: "issue-2",
      url: "https://example.com/spec",
      title: "Spec",
    });
    expectRecord(store, "issue-2", {
      ...before,
      source_links: [{ url: "https://example.com/spec", title: "Spec" }],
    });
  });

  it("repeats are no-ops", () => {
    const store = seedStore();
    const args = { issue_id: "issue-2", url: "https://example.com/spec", title: "Spec" };
    mutate(store, "add_source_link", args);
    const first = snapshotIssues(store);
    mutate(store, "add_source_link", args);
    expect(snapshotIssues(store)).toEqual(first);
    expect(store.replayErrors().size).toBe(0);
  });

  it("validates the title and url", () => {
    const base = { issue_id: "issue-2", url: "https://example.com/a", title: "A" };
    rejects("add_source_link", { ...base, title: "" }, 400, "text must contain 1 to 500 bytes");
    rejects("add_source_link", { ...base, url: "not a url" }, 400, "invalid URL");
    rejects("add_source_link", { ...base, url: "ftp://example.com/a" }, 400, "invalid URL");
  });

  it("rejects missing, deleted and archived issues", () => {
    const base = { url: "https://example.com/a", title: "A" };
    rejects("add_source_link", { ...base, issue_id: "issue-ghost" }, 404, "not found");
    rejects("add_source_link", { ...base, issue_id: "issue-deleted" }, 404, "not found");
    rejects("add_source_link", { ...base, issue_id: "issue-archived" }, 409, "issue is archived");
  });

  it("enforces viewer rules", () => {
    const base = { url: "https://example.com/a", title: "A" };
    rejects("add_source_link", { ...base, issue_id: "issue-2" }, 403, "permission denied", VIEWER);
    rejects("add_source_link", { ...base, issue_id: "issue-2" }, 403, "permission denied", GHOST);
  });
});

describe("remove_attachment", () => {
  it("removes the attachment without touching other fields", () => {
    const store = seedStore();
    const before = live(store, "issue-attached");
    mutate(store, "remove_attachment", { issue_id: "issue-attached", attachment_id: "att-1" });
    expectRecord(store, "issue-attached", { ...before, attachments: [] });
  });

  it("rejects missing rows before and after the archived check", () => {
    const args = { issue_id: "issue-attached", attachment_id: "att-1" };
    rejects("remove_attachment", { ...args, issue_id: "issue-ghost" }, 404, "not found");
    admitsRejects("remove_attachment", { ...args, attachment_id: "att-ghost" }, 404, "not found");
    rejects(
      "remove_attachment",
      { issue_id: "issue-deleted", attachment_id: "att-1" },
      404,
      "not found",
    );
    rejects(
      "remove_attachment",
      { issue_id: "issue-archived", attachment_id: "att-1" },
      409,
      "issue is archived",
    );
  });

  it("rejects archived issues even when deleted", () => {
    const store = seedStore();
    mutate(store, "delete_issue", { id: "issue-archived" });
    const before = snapshotIssues(store);
    const id = mutate(store, "remove_attachment", {
      issue_id: "issue-archived",
      attachment_id: "att-1",
    });
    expect(store.replayErrors().get(id)?.status).toBe(409);
    expect(store.replayErrors().get(id)?.message).toBe("issue is archived");
    expect(snapshotIssues(store)).toEqual(before);
  });

  it("running twice keeps the view", () => {
    twice("remove_attachment", { issue_id: "issue-attached", attachment_id: "att-1" });
  });

  it("enforces viewer rules", () => {
    const args = { issue_id: "issue-attached", attachment_id: "att-1" };
    rejects("remove_attachment", args, 403, "permission denied", VIEWER);
    rejects("remove_attachment", args, 403, "permission denied", GHOST);
  });
});

describe("team and stage references", () => {
  it("reads the default stage from a second team", () => {
    const store = seedStore();
    mutate(store, "create_issue", { input: { id: "issue-t2", title: "T2", team_id: TEAM_OTHER } });
    expect(live(store, "issue-t2").stage_id).toBe("stage-2-todo");
  });

  it("moves within backlog and cancelled stages", () => {
    const store = seedStore();
    mutate(store, "move_issue", { id: "issue-x", stage_id: STAGE_CANCELLED, before_id: null });
    const view = live(store, "issue-x");
    expect(view.stage_id).toBe(STAGE_CANCELLED);
    expect(view.done_at).toBeNull();
  });
});

describe("review findings", () => {
  it("F1: deleting a completed dependency leaves the dependent editable", () => {
    const store = seedStore();
    // Active A depends on completed B (issue-3 is done).
    mutate(store, "create_issue", {
      input: {
        id: "issue-f1-a",
        title: "A",
        team_id: TEAM,
        stage_id: STAGE_ACTIVE,
        dependencies: ["issue-3"],
      },
    });
    const deleteId = mutate(store, "delete_issue", { id: "issue-3" });
    expect(store.replayErrors().get(deleteId)).toBeUndefined();
    const renameId = mutate(store, "update_issue", {
      id: "issue-f1-a",
      patch: { title: "Valid rename" },
    });
    expect(store.replayErrors().get(renameId)).toBeUndefined();
    expect(live(store, "issue-f1-a").title).toBe("Valid rename");
  });

  it("reopening a dependency leaves the dependent blocked but editable", () => {
    const store = seedStore();
    mutate(store, "create_issue", {
      input: {
        id: "issue-blocked",
        title: "Blocked",
        team_id: TEAM,
        stage_id: STAGE_ACTIVE,
        dependencies: ["issue-3"],
      },
    });
    const reopen = mutate(store, "move_issue", {
      id: "issue-3",
      stage_id: STAGE_BACKLOG,
      before_id: null,
    });
    expect(store.replayErrors().get(reopen)).toBeUndefined();
    const rename = mutate(store, "update_issue", {
      id: "issue-blocked",
      patch: { title: "Renamed" },
    });
    expect(store.replayErrors().get(rename)).toBeUndefined();
    const finish = mutate(store, "move_issue", {
      id: "issue-blocked",
      stage_id: STAGE_DONE,
      before_id: null,
    });
    expect(store.replayErrors().get(finish)?.message).toBe("issue has unfinished dependencies");
  });

  it("F2: replay over a base already containing the effect is a no-op", () => {
    const store = seedStore();
    const pending = mutate(store, "delete_issue", { id: "issue-2" });
    expect(store.replayErrors().get(pending)).toBeUndefined();
    const deletedView = live(store, "issue-2");
    expect(deletedView.deleted_at).toBe(AT);
    // An intermediate pull page already contains the deletion while the
    // mutation is still pending; rebasing over it must not record 404.
    store.applyBase([{ entity: "issues", id: "issue-2", record: { ...deletedView } }]);
    expect(store.replayErrors().get(pending)).toBeUndefined();
    expect(live(store, "issue-2").deleted_at).toBe(AT);
  });

  it("F3: explicit null patch fields are treated as absent", () => {
    const first = seedStore();
    mutate(first, "update_issue", {
      id: "issue-2",
      patch: { stage_id: null, title: "Valid rename" } as unknown as Record<string, unknown>,
    } as unknown as never);
    expect(first.replayErrors().size).toBe(0);
    expect(live(first, "issue-2").title).toBe("Valid rename");

    const second = seedStore();
    mutate(second, "update_issue", {
      id: "issue-2",
      patch: { labels: null, title: "Valid rename" } as unknown as Record<string, unknown>,
    } as unknown as never);
    expect(second.replayErrors().size).toBe(0);
    expect(live(second, "issue-2").title).toBe("Valid rename");

    const third = seedStore();
    mutate(third, "update_issue", {
      id: "issue-2",
      patch: { title: null, description: "Valid body" } as unknown as Record<string, unknown>,
    } as unknown as never);
    expect(third.replayErrors().size).toBe(0);
    expect(live(third, "issue-2").description).toBe("Valid body");
    expect(live(third, "issue-2").title).toBe("Issue two");
  });

  it("F3: null inside an array is preserved", () => {
    const store = seedStore();
    const id = mutate(store, "update_issue", {
      id: "issue-2",
      patch: { labels: [null] } as unknown as Record<string, unknown>,
    } as unknown as never);
    // Preserved nulls fail reference validation instead of being stripped.
    expect(store.replayErrors().get(id)?.status).toBe(400);
  });

  it("F4: accepts chrono RFC 3339 timestamps and normalizes leap seconds like Postgres", () => {
    const lower = seedStore();
    mutate(lower, "update_issue", {
      id: "issue-2",
      patch: { deadline: "2026-11-01t00:00:00z" },
    });
    expect(lower.replayErrors().size).toBe(0);
    expect(live(lower, "issue-2").deadline).toBe("2026-11-01T00:00:00.000000Z");

    const leap = seedStore();
    mutate(leap, "update_issue", {
      id: "issue-2",
      patch: { deadline: "2016-12-31T23:59:60Z" },
    });
    expect(leap.replayErrors().size).toBe(0);
    // PostgreSQL stores 23:59:60Z as midnight the next day.
    expect(live(leap, "issue-2").deadline).toBe("2017-01-01T00:00:00.000000Z");

    const offset = seedStore();
    mutate(offset, "update_issue", {
      id: "issue-2",
      patch: { deadline: "2026-11-01T02:00:00.123456789+02:00" },
    });
    expect(offset.replayErrors().size).toBe(0);
    expect(live(offset, "issue-2").deadline).toBe("2026-11-01T00:00:00.123456Z");
  });

  it("F5: trims with Rust whitespace and measures byte limits in UTF-8 bytes", () => {
    // BOM-only titles are blank under JS trim but non-blank under Rust trim.
    const bom = seedStore();
    mutate(bom, "create_issue", { input: { id: "issue-bom", title: "\uFEFF", team_id: TEAM } });
    expect(bom.replayErrors().size).toBe(0);
    expect(live(bom, "issue-bom").title).toBe("\uFEFF");

    // 30k emoji: 60k UTF-16 units (under 100k) but 120k UTF-8 bytes (over).
    const long = seedStore();
    const emoji30k = "😀".repeat(30_000);
    const longId = mutate(long, "create_issue", {
      input: { id: "issue-long", title: "Long", team_id: TEAM, description: emoji30k },
    });
    expect(long.replayErrors().get(longId)?.status).toBe(400);
    expect(long.replayErrors().get(longId)?.message).toBe("description too long");

    // URL with 1500 emoji: 3020 units (under 4096) but 6020 bytes (over).
    const url = seedStore();
    const bigUrl = `https://example.com/${"😀".repeat(1500)}`;
    const urlId = mutate(url, "add_source_link", {
      issue_id: "issue-2",
      url: bigUrl,
      title: "Big",
    });
    expect(url.replayErrors().get(urlId)?.status).toBe(400);
    expect(url.replayErrors().get(urlId)?.message).toBe("invalid URL");
  });

  it("F6: create uses none as the default priority", () => {
    const store = seedStore();
    mutate(store, "create_issue", { input: { id: "issue-prio", title: "P", team_id: TEAM } });
    expect(store.replayErrors().size).toBe(0);
    expect(live(store, "issue-prio").priority).toBe("none");
  });

  it("F7: create appends at max+1024 and midpoints use known predecessors", () => {
    const store = seedStore();
    mutate(store, "create_issue", { input: { id: "issue-f7", title: "F7", team_id: TEAM } });
    // Backlog max is 1024 (issue-y), so the new row lands at 2048.
    expect(live(store, "issue-f7").position).toBe(2048);
    // Replay gives the same position (the created id is excluded).
    mutate(store, "create_issue", { input: { id: "issue-f7", title: "F7", team_id: TEAM } });
    expect(store.replayErrors().size).toBe(0);
    expect(live(store, "issue-f7").position).toBe(2048);

    const staged = seedStore();
    staged.applyBase([
      {
        entity: "issues",
        id: "issue-neg",
        record: {
          ...(staged.get("issues", "issue-x") as SyncIssue),
          id: "issue-neg",
          title: "Neg",
          stage_id: STAGE_BACKLOG,
          position: -5000,
          dependencies: [],
          parent_id: null,
        },
      },
    ]);
    mutate(staged, "move_issue", { id: "issue-y", stage_id: STAGE_BACKLOG, before_id: "issue-x" });
    // Predecessor -5000 sits below the synthetic -2048 bound; the server
    // uses the real predecessor, so the midpoint is (-5000+0)/2.
    expect(live(staged, "issue-y").position).toBe(-2500);
  });

  it("F8: relation arrays dedupe and sort in UUID order", () => {
    const store = seedStore();
    mutate(store, "create_issue", {
      input: {
        id: "issue-f8",
        title: "F8",
        team_id: TEAM,
        stage_id: STAGE_BACKLOG,
        labels: [LABEL_TWO, LABEL_ONE, LABEL_ONE],
        dependencies: ["issue-y", "issue-x", "issue-y"],
      },
    });
    expect(store.replayErrors().size).toBe(0);
    expect(live(store, "issue-f8").labels).toEqual([LABEL_ONE, LABEL_TWO]);
    expect(live(store, "issue-f8").dependencies).toEqual(["issue-x", "issue-y"]);

    const followed = seedStore(ADMIN);
    mutate(followed, "follow", { issue_id: "issue-followed", following: true });
    expect(followed.replayErrors().size).toBe(0);
    // UUID byte order: admin < member < owner.
    expect(live(followed, "issue-followed").followers).toEqual([ADMIN, MEMBER, OWNER]);
  });

  it("F10: source-link validation runs before the issue lookup", () => {
    const base = { issue_id: "issue-ghost", url: "https://example.com/a", title: "A" };
    rejects("add_source_link", { ...base, title: "" }, 400, "text must contain 1 to 500 bytes");
    rejects("add_source_link", { ...base, url: "not a url" }, 400, "invalid URL");
  });

  it("F11: registry dispatch rejects inherited properties", () => {
    const store = seedStore();
    const before = snapshotIssues(store);
    const id = mutate(store, "toString", {});
    expect(store.replayErrors().get(id)?.status).toBe(400);
    expect(store.replayErrors().get(id)?.message).toBe("unknown command toString");
    expect(snapshotIssues(store)).toEqual(before);
  });
});

describe("admission vs replay", () => {
  it("delete of an already-deleted issue is a replay no-op but admission rejects", () => {
    const replayed = seedStore();
    const before = snapshotIssues(replayed);
    const id = mutate(replayed, "delete_issue", { id: "issue-deleted" });
    expect(replayed.replayErrors().get(id)).toBeUndefined();
    expect(snapshotIssues(replayed)).toEqual(before);
    admitsRejects("delete_issue", { id: "issue-deleted" }, 404, "not found");
  });

  it("restore of a live issue is a replay no-op but admission rejects", () => {
    const replayed = seedStore();
    const before = snapshotIssues(replayed);
    const id = mutate(replayed, "restore_issue", { id: "issue-1" });
    expect(replayed.replayErrors().get(id)).toBeUndefined();
    expect(snapshotIssues(replayed)).toEqual(before);
    admitsRejects("restore_issue", { id: "issue-1" }, 400, "issue is not deleted");
  });

  it("archive of an archived issue is a replay no-op but admission rejects", () => {
    const replayed = seedStore();
    const before = snapshotIssues(replayed);
    const id = mutate(replayed, "archive_issue", { id: "issue-archived" });
    expect(replayed.replayErrors().get(id)).toBeUndefined();
    expect(snapshotIssues(replayed)).toEqual(before);
    admitsRejects("archive_issue", { id: "issue-archived" }, 400, "issue is already archived");
  });

  it("unarchive of a live issue is a replay no-op but admission rejects", () => {
    const replayed = seedStore();
    const before = snapshotIssues(replayed);
    const id = mutate(replayed, "unarchive_issue", { id: "issue-1" });
    expect(replayed.replayErrors().get(id)).toBeUndefined();
    expect(snapshotIssues(replayed)).toEqual(before);
    admitsRejects("unarchive_issue", { id: "issue-1" }, 400, "issue is not archived");
  });

  it("removing a missing attachment is a replay no-op but admission rejects", () => {
    const replayed = seedStore();
    const before = snapshotIssues(replayed);
    const id = mutate(replayed, "remove_attachment", {
      issue_id: "issue-attached",
      attachment_id: "att-ghost",
    });
    expect(replayed.replayErrors().get(id)).toBeUndefined();
    expect(snapshotIssues(replayed)).toEqual(before);
    admitsRejects(
      "remove_attachment",
      { issue_id: "issue-attached", attachment_id: "att-ghost" },
      404,
      "not found",
    );
  });

  it("follow already in the target state is a no-op in both modes", () => {
    const replayed = seedStore();
    const before = snapshotIssues(replayed);
    const id = mutate(replayed, "follow", { issue_id: "issue-followed", following: true });
    expect(replayed.replayErrors().get(id)).toBeUndefined();
    expect(snapshotIssues(replayed)).toEqual(before);
  });

  it("create with an existing id replays without error", () => {
    const replayed = seedStore();
    const before = live(replayed, "issue-1");
    const id = mutate(replayed, "create_issue", {
      input: { id: "issue-1", title: before.title, team_id: before.team_id },
    });
    expect(replayed.replayErrors().get(id)).toBeUndefined();
  });
});
