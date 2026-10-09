import type {
  Activity,
  AlertPrefsWs,
  Comment,
  Id,
  Integration,
  Invitation,
  Issue,
  Label,
  MemberProfile,
  Milestone,
  Notification,
  Project,
  SavedView,
  Sprint,
  Team,
  TimeEntry,
} from "../lib/types";

/** Entities in the sync replica, in spec order. */
export interface RecordOf {
  workspace: SyncWorkspace;
  members: MemberProfile;
  teams: Team;
  labels: Label;
  projects: Project;
  milestones: Milestone;
  sprints: Sprint;
  views: SavedView;
  alert_preferences: AlertPrefsWs;
  notifications: SyncNotification;
  invitations: SyncInvitation;
  integrations: SyncIntegration;
  issues: SyncIssue;
  time_entries: TimeEntry;
  comments: Comment;
  activity: Activity;
}

export type Entity = keyof RecordOf;

export const ENTITIES: readonly Entity[] = [
  "workspace",
  "members",
  "teams",
  "labels",
  "projects",
  "milestones",
  "sprints",
  "views",
  "alert_preferences",
  "notifications",
  "invitations",
  "integrations",
  "issues",
  "time_entries",
  "comments",
  "activity",
];

/** Sync issue shape: the server shape without the derived counts. */
export type SyncIssue = Omit<Issue, "blocked_count" | "subtask_total" | "subtask_completed">;

/** Workspace pull shape: only the workspace row itself. */
export interface SyncWorkspace {
  id: Id;
  name: string;
  version: number;
}

/** Sync shapes carry server-built columns the UI types omit. */
export interface SyncNotification extends Notification {
  dedup_key: string;
}

export interface SyncInvitation extends Invitation {
  token_hash: string;
}

export interface SyncIntegration extends Integration {
  secret: string;
}

/** Wire shape of pull changes; null means deleted or no longer visible. */
export interface Change {
  entity: Entity;
  id: string;
  record: object | null;
}

/** Storage key per entity. Members arrive keyed by user id as `id`. */
export function keyOf<E extends Entity>(entity: E, record: RecordOf[E]): string {
  if (entity === "alert_preferences") return (record as AlertPrefsWs).user_id;
  return (record as { id: string }).id;
}

/** Timestamp fields per entity, taken from the server's sync shapes. */
const TIMESTAMP_FIELDS: Record<Entity, readonly string[]> = {
  workspace: [],
  members: [],
  teams: [],
  labels: [],
  projects: [],
  milestones: ["deadline"],
  sprints: ["starts_at", "ends_at"],
  views: [],
  alert_preferences: [],
  notifications: ["read_at", "created_at"],
  invitations: ["expires_at"],
  integrations: [],
  issues: ["deadline", "deleted_at", "archived_at", "done_at", "created_at", "updated_at"],
  time_entries: ["logged_at"],
  comments: ["created_at", "edited_at"],
  activity: ["at"],
};

/** Copy with every timestamp normalized to UTC ISO, so string comparison sorts correctly. */
export function normalize<E extends Entity>(entity: E, record: RecordOf[E]): RecordOf[E] {
  const copy = { ...record } as Record<string, unknown>;
  for (const field of TIMESTAMP_FIELDS[entity]) {
    const value = copy[field];
    if (value === null || value === undefined) continue;
    copy[field] = new Date(value as string).toISOString();
  }
  return copy as RecordOf[E];
}
