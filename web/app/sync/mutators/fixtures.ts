import type {
  AlertPrefsWs,
  Id,
  Label,
  MemberProfile,
  Milestone,
  Project,
  SavedView,
  Sprint,
  Team,
  TimeEntry,
} from "../../lib/types";
import type { Comment } from "../../lib/types";
import type { SyncInvitation, SyncIntegration, SyncIssue, SyncNotification } from "../records";
import type { Entity, RecordOf } from "../records";
import { NOW } from "../fixtures";
import { SyncStore } from "../store";
import { createReplay } from "./index";

/** Mutation time used by tests, already in the store's normalized form. */
export const AT = "2026-10-09T12:00:00.000000Z";

/** Normalized form of NOW, for whole-record expectations. */
export const STAMP = "2026-10-08T12:00:00.000000Z";

export const OWNER = "40000000-0000-4000-8000-000000000000";
export const ADMIN = "10000000-0000-4000-8000-000000000000";
export const MEMBER = "30000000-0000-4000-8000-000000000000";
export const VIEWER = "50000000-0000-4000-8000-000000000000";
export const GHOST = "20000000-0000-4000-8000-000000000000";

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
export const COMMENT_ONE = "comment-1";
export const COMMENT_TWO = "comment-2";
export const COMMENT_OTHER_ISSUE = "comment-other";
export const TIME_ONE = "time-1";
export const TIME_OTHER = "time-other";
export const VIEW_PRIVATE = "view-1";
export const VIEW_SHARED = "view-shared";
export const VIEW_OTHER_PRIVATE = "view-other";
export const NOTIF_UNREAD = "notif-1";
export const NOTIF_READ = "notif-read";
export const NOTIF_OTHER = "notif-other";
export const INVITE_PENDING = "invite-1";
export const INVITE_ACCEPTED = "invite-accepted";
export const INVITE_CANCELLED = "invite-cancelled";
export const INTEGRATION_ONE = "integration-1";
export const INTEGRATION_DISABLED = "integration-disabled";

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
    key: "TEAM",
    former_keys: [],
    members: [OWNER, ADMIN, MEMBER, VIEWER],
    stages: [
      { id: STAGE_BACKLOG, version: 1, name: "Backlog", kind: "backlog", position: 0 },
      { id: STAGE_ACTIVE, version: 1, name: "Active", kind: "active", position: 1 },
      { id: STAGE_DONE, version: 1, name: "Done", kind: "done", position: 2 },
      { id: STAGE_CANCELLED, version: 1, name: "Cancelled", kind: "cancelled", position: 3 },
    ],
    archive_after_days: 30,
    icon: "users",
    color: "violet",
    sprints: true,
  };
}

function otherTeam(): Team {
  return {
    id: TEAM_OTHER,
    version: 1,
    name: "Other",
    key: "OTH",
    former_keys: [],
    members: [],
    stages: [{ id: STAGE_OTHER, version: 1, name: "Todo", kind: "active", position: 0 }],
    archive_after_days: null,
    icon: "rocket",
    color: "blue",
    sprints: true,
  };
}

function labels(): Label[] {
  return [
    { id: LABEL_ONE, version: 1, name: "Bug", color: "#ff0000" },
    { id: LABEL_TWO, version: 1, name: "Feature", color: "#0000ff" },
  ];
}

const PLAN = {
  lead_id: null,
  status: "planned",
  health: null,
  start_date: null,
  target_date: null,
} as const;

function projects(): Project[] {
  return [
    { id: PROJECT, version: 1, name: "Project", description: "", team_ids: [TEAM], ...PLAN },
    {
      id: PROJECT_OTHER,
      version: 1,
      name: "Other",
      description: "",
      team_ids: [TEAM_OTHER],
      ...PLAN,
    },
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
      number: 2,
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
      number: 1,
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
      number: 1,
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
    tracker: null,
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
    former_keys: [],
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
      tracker: {
        provider: "openproject",
        connection_id: "conn-1",
        remote_id: "9",
        project_id: "9",
        status_name: "Closed",
        url: "https://op.example.com/work_packages/9",
      },
    }),
    issue("issue-op", {
      number: 7,
      tracker: {
        provider: "openproject",
        connection_id: "conn-1",
        remote_id: "7",
        project_id: "9",
        status_name: "New",
        url: "https://op.example.com/work_packages/7",
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

function comments(): Comment[] {
  return [
    {
      id: COMMENT_ONE,
      version: 1,
      issue_id: "issue-1",
      author: MEMBER,
      body: "First",
      mentions: [OWNER],
      attachments: [],
      created_at: NOW,
      edited_at: null,
    },
    {
      id: COMMENT_TWO,
      version: 1,
      issue_id: "issue-1",
      author: OWNER,
      body: "Reply",
      mentions: [],
      attachments: [{ id: "att-c1", name: "note.txt", content_type: "text/plain", size: 4 }],
      created_at: NOW,
      edited_at: null,
    },
    {
      id: COMMENT_OTHER_ISSUE,
      version: 1,
      issue_id: "issue-2",
      author: OWNER,
      body: "Other issue",
      mentions: [],
      attachments: [],
      created_at: NOW,
      edited_at: null,
    },
  ];
}

function timeEntries(): TimeEntry[] {
  return [
    {
      id: TIME_ONE,
      version: 1,
      issue_id: "issue-1",
      user_id: MEMBER,
      minutes: 30,
      note: "Work",
      logged_at: NOW,
    },
    {
      id: TIME_OTHER,
      version: 1,
      issue_id: "issue-2",
      user_id: OWNER,
      minutes: 60,
      note: "",
      logged_at: NOW,
    },
  ];
}

function views(): SavedView[] {
  return [
    { id: VIEW_PRIVATE, version: 1, owner: MEMBER, name: "Mine", shared: false, filter: {} },
    {
      id: VIEW_SHARED,
      version: 1,
      owner: OWNER,
      name: "Shared",
      shared: true,
      filter: { where: [{ field: "team_id", op: "is", values: [TEAM] }] },
    },
    { id: VIEW_OTHER_PRIVATE, version: 1, owner: OWNER, name: "Theirs", shared: false, filter: {} },
  ];
}

function notifications(): SyncNotification[] {
  return [
    {
      id: NOTIF_UNREAD,
      version: 1,
      user_id: MEMBER,
      issue_id: "issue-1",
      kind: "mention",
      message: "Hi",
      read_at: null,
      created_at: NOW,
      dedup_key: "d1",
    },
    {
      id: NOTIF_READ,
      version: 1,
      user_id: MEMBER,
      issue_id: "issue-2",
      kind: "reply",
      message: "Done",
      read_at: NOW,
      created_at: NOW,
      dedup_key: "d2",
    },
    {
      id: NOTIF_OTHER,
      version: 1,
      user_id: OWNER,
      issue_id: "issue-1",
      kind: "change",
      message: "Changed",
      read_at: null,
      created_at: NOW,
      dedup_key: "d3",
    },
  ];
}

function invitations(): SyncInvitation[] {
  return [
    {
      id: INVITE_PENDING,
      version: 1,
      email: "new@example.com",
      role: "member",
      expires_at: "2026-10-20T12:00:00.000Z",
      state: "pending",
      token_hash: "",
    },
    {
      id: INVITE_ACCEPTED,
      version: 1,
      email: "old@example.com",
      role: "member",
      expires_at: "2026-10-20T12:00:00.000Z",
      state: "accepted",
      token_hash: "",
    },
    {
      id: INVITE_CANCELLED,
      version: 1,
      email: "gone@example.com",
      role: "member",
      expires_at: "2026-10-20T12:00:00.000Z",
      state: "cancelled",
      token_hash: "",
    },
  ];
}

function integrations(): SyncIntegration[] {
  return [
    {
      id: INTEGRATION_ONE,
      version: 1,
      name: "Hooks",
      webhook_url: "https://example.com/hook",
      enabled: true,
      include_data: true,
      secret: "",
    },
    {
      id: INTEGRATION_DISABLED,
      version: 1,
      name: "Quiet",
      webhook_url: "https://example.com/quiet",
      enabled: false,
      include_data: false,
      secret: "",
    },
  ];
}

function alertPreferences(): AlertPrefsWs[] {
  return [
    {
      user_id: MEMBER,
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
    },
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
      comments: comments(),
      time_entries: timeEntries(),
      views: views(),
      notifications: notifications(),
      invitations: invitations(),
      integrations: integrations(),
      alert_preferences: alertPreferences(),
    },
    [
      "members",
      "teams",
      "labels",
      "projects",
      "milestones",
      "sprints",
      "issues",
      "comments",
      "time_entries",
      "views",
      "notifications",
      "invitations",
      "integrations",
      "alert_preferences",
    ],
  );
  return store;
}

/** Appends one mutation to the outbox, replaying synchronously. */
export function mutate(
  store: SyncStore,
  name: string,
  args: unknown,
  at: string = AT,
  local?: unknown,
): number {
  const id = store.pending().length + 1;
  store.setPending([
    ...store.pending(),
    { id, name, args, at, ...(local === undefined ? {} : { local }) },
  ]);
  return id;
}

/** Detached copy of every issue in the view, for before/after comparisons. */
export function snapshotIssues(store: SyncStore): SyncIssue[] {
  return store.all("issues").map((issue) => ({ ...(issue as SyncIssue) }));
}

/** Detached copies of every record of one entity, for before/after comparisons. */
export function snapshot<E extends Entity>(store: SyncStore, entity: E): RecordOf[E][] {
  return store.all(entity).map((record) => ({ ...(record as RecordOf[E]) }));
}
