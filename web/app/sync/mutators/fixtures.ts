import type { Id, Label, MemberProfile, Milestone, Project, Sprint, Team } from "../../lib/types";
import type { SyncIssue } from "../records";
import { NOW } from "../fixtures";
import { SyncStore } from "../store";
import { createReplay } from "./index";

/** Mutation time used by tests, already in the store's normalized form. */
export const AT = "2026-10-09T12:00:00.000000Z";

/** Normalized form of NOW, for whole-record expectations. */
export const STAMP = "2026-10-08T12:00:00.000000Z";

export const OWNER = "user-owner";
export const ADMIN = "user-admin";
export const MEMBER = "user-member";
export const VIEWER = "user-viewer";
export const GHOST = "user-ghost";

export const TEAM = "team-1";
export const TEAM_OTHER = "team-2";
export const STAGE_BACKLOG = "stage-backlog";
export const STAGE_ACTIVE = "stage-active";
export const STAGE_DONE = "stage-done";
export const STAGE_CANCELLED = "stage-cancelled";
export const STAGE_OTHER = "stage-2-todo";
export const LABEL_ONE = "label-1";
export const LABEL_TWO = "label-2";
export const PROJECT = "project-1";
export const PROJECT_OTHER = "project-other";
export const MILESTONE = "milestone-1";
export const MILESTONE_OTHER = "milestone-other";
export const SPRINT = "sprint-1";
export const SPRINT_FINISHED = "sprint-finished";
export const SPRINT_OTHER = "sprint-2";

function member(id: Id, role: MemberProfile["role"]): MemberProfile {
  return {
    id,
    role,
    version: 1,
    email: `${id}@example.com`,
    display_name: id,
    avatar_url: null,
    contact: "",
    team_ids: [TEAM],
  };
}

function team(): Team {
  return {
    id: TEAM,
    version: 1,
    name: "Team",
    members: [OWNER, ADMIN, MEMBER, VIEWER],
    stages: [
      { id: STAGE_BACKLOG, version: 1, name: "Backlog", kind: "backlog", position: 0 },
      { id: STAGE_ACTIVE, version: 1, name: "Active", kind: "active", position: 1 },
      { id: STAGE_DONE, version: 1, name: "Done", kind: "done", position: 2 },
      { id: STAGE_CANCELLED, version: 1, name: "Cancelled", kind: "cancelled", position: 3 },
    ],
    archive_after_days: 30,
  };
}

function otherTeam(): Team {
  return {
    id: TEAM_OTHER,
    version: 1,
    name: "Other",
    members: [],
    stages: [{ id: STAGE_OTHER, version: 1, name: "Todo", kind: "active", position: 0 }],
    archive_after_days: null,
  };
}

function labels(): Label[] {
  return [
    { id: LABEL_ONE, version: 1, name: "Bug", color: "#ff0000" },
    { id: LABEL_TWO, version: 1, name: "Feature", color: "#0000ff" },
  ];
}

function projects(): Project[] {
  return [
    { id: PROJECT, version: 1, name: "Project", description: "", team_ids: [TEAM] },
    { id: PROJECT_OTHER, version: 1, name: "Other", description: "", team_ids: [TEAM_OTHER] },
  ];
}

function milestones(): Milestone[] {
  return [
    { id: MILESTONE, version: 1, project_id: PROJECT, name: "M1", deadline: null },
    { id: MILESTONE_OTHER, version: 1, project_id: PROJECT_OTHER, name: "M2", deadline: null },
  ];
}

function sprints(): Sprint[] {
  return [
    {
      id: SPRINT,
      version: 1,
      team_id: TEAM,
      name: "Sprint",
      goal: "",
      starts_at: "2026-10-01T00:00:00.000Z",
      ends_at: "2026-10-15T00:00:00.000Z",
      state: "active",
      outcome: null,
    },
    {
      id: SPRINT_FINISHED,
      version: 1,
      team_id: TEAM,
      name: "Finished",
      goal: "",
      starts_at: "2026-09-01T00:00:00.000Z",
      ends_at: "2026-09-15T00:00:00.000Z",
      state: "completed",
      outcome: null,
    },
    {
      id: SPRINT_OTHER,
      version: 1,
      team_id: TEAM_OTHER,
      name: "Other sprint",
      goal: "",
      starts_at: "2026-10-01T00:00:00.000Z",
      ends_at: "2026-10-15T00:00:00.000Z",
      state: "active",
      outcome: null,
    },
  ];
}

function issue(id: string, overrides: Partial<SyncIssue> = {}): SyncIssue {
  return {
    openproject: null,
    id,
    version: 1,
    number: 1,
    title: `Issue ${id}`,
    description: "",
    team_id: TEAM,
    stage_id: STAGE_ACTIVE,
    assignee: null,
    created_by: OWNER,
    priority: "normal",
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
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function issues(): SyncIssue[] {
  return [
    issue("issue-1", {
      number: 1,
      title: "Issue one",
      assignee: MEMBER,
      labels: [LABEL_ONE],
      project_id: PROJECT,
      milestone_id: MILESTONE,
      sprint_id: SPRINT,
      position: 0,
    }),
    issue("issue-2", {
      number: 2,
      title: "Issue two",
      followers: [],
      position: 1024,
    }),
    issue("issue-3", {
      number: 3,
      title: "Issue three",
      stage_id: STAGE_DONE,
      done_at: NOW,
      position: 0,
    }),
    issue("issue-child", { number: 4, parent_id: "issue-1", position: 2048 }),
    issue("issue-a", { number: 5, dependencies: ["issue-b"], position: 3072 }),
    issue("issue-b", { number: 6, position: 4096 }),
    issue("issue-x", {
      number: 14,
      stage_id: STAGE_BACKLOG,
      dependencies: ["issue-y"],
      position: 0,
    }),
    issue("issue-y", { number: 15, stage_id: STAGE_BACKLOG, position: 1024 }),
    issue("issue-op-done", {
      number: 13,
      stage_id: STAGE_DONE,
      done_at: NOW,
      position: 2048,
      openproject: {
        connection_id: "conn-1",
        work_package_id: 9,
        project_id: 9,
        status_name: "Closed",
        url: "https://op.example.com/work_packages/9",
        unavailable: false,
      },
    }),
    issue("issue-op", {
      number: 7,
      openproject: {
        connection_id: "conn-1",
        work_package_id: 7,
        project_id: 9,
        status_name: "New",
        url: "https://op.example.com/work_packages/7",
        unavailable: false,
      },
      position: 5120,
    }),
    issue("issue-archived", {
      number: 8,
      stage_id: STAGE_DONE,
      done_at: NOW,
      archived_at: NOW,
      position: 1024,
    }),
    issue("issue-deleted", { number: 9, deleted_at: NOW }),
    issue("issue-cancelled", { number: 10, stage_id: STAGE_CANCELLED }),
    issue("issue-attached", {
      number: 11,
      position: 6144,
      attachments: [{ id: "att-1", name: "spec.txt", content_type: "text/plain", size: 12 }],
    }),
    issue("issue-followed", { number: 12, followers: [OWNER, MEMBER], position: 7168 }),
  ];
}

/** A store seeded with the full fixture, replaying mutations as `actor`. */
export function seedStore(actor: Id = MEMBER): SyncStore {
  const store = new SyncStore(createReplay(actor));
  store.replaceBase(
    {
      members: [
        member(OWNER, "owner"),
        member(ADMIN, "admin"),
        member(MEMBER, "member"),
        member(VIEWER, "viewer"),
      ],
      teams: [team(), otherTeam()],
      labels: labels(),
      projects: projects(),
      milestones: milestones(),
      sprints: sprints(),
      issues: issues(),
    },
    ["members", "teams", "labels", "projects", "milestones", "sprints", "issues"],
  );
  return store;
}

/** Appends one mutation to the outbox, replaying synchronously. */
export function mutate(store: SyncStore, name: string, args: unknown, at: string = AT): number {
  const id = store.pending().length + 1;
  store.setPending([...store.pending(), { id, name, args, at }]);
  return id;
}

/** Detached copy of every issue in the view, for before/after comparisons. */
export function snapshotIssues(store: SyncStore): SyncIssue[] {
  return store.all("issues").map((issue) => ({ ...(issue as SyncIssue) }));
}
