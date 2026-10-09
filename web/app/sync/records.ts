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

/**
 * Every always-loaded entity from the spec's table: everything except
 * `comments` and `activity`, which load per scope. The orchestrator passes
 * this to `replaceBase` on bootstrap so an empty scope clears stale rows.
 */
export const BOOTSTRAP_ENTITIES: readonly Entity[] = [
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
];

/** Sync issue shape: the server shape without the derived counts. */
export type SyncIssue = Omit<
  Issue,
  "blocked_count" | "subtask_total" | "subtask_completed" | "number"
> & {
  /** Null until the server confirms a locally created issue and assigns a number. */
  number: number | null;
};

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
    copy[field] = normalizeTimestamp(value);
  }
  return copy as RecordOf[E];
}

/**
 * Timestamps to UTC with fixed-width microseconds: YYYY-MM-DDTHH:MM:SS.ffffffZ.
 * Keeps up to 6 fraction digits (pads short fractions with zeros), so Date's
 * millisecond truncation can't collapse distinct server timestamps. Throws on
 * unparseable input instead of producing Invalid Date.
 */
function normalizeTimestamp(value: unknown): string {
  if (typeof value !== "string") throw new Error(`unparseable timestamp ${String(value)}`);
  const match =
    /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:?\d{2}|[+-]\d{4}|[+-]\d{2})?$/.exec(
      value,
    );
  if (match === null) throw new Error(`unparseable timestamp ${value}`);
  const datePart = match[1] as string;
  const fractionRaw = match[2] ?? "";
  const zoneRaw = match[3] ?? "Z";
  let zone = zoneRaw;
  if (zone !== "Z") {
    const sign = zone[0] as string;
    const digits = zone.slice(1).replace(":", "");
    const hour = digits.slice(0, 2);
    const minute = digits.length <= 2 ? "00" : digits.slice(2, 4);
    zone = `${sign}${hour}:${minute}`;
  }
  const probe = new Date(`${datePart}${zone}`);
  if (Number.isNaN(probe.getTime())) throw new Error(`unparseable timestamp ${value}`);
  const pad = (n: number, width: number): string => String(n).padStart(width, "0");
  const utc =
    `${pad(probe.getUTCFullYear(), 4)}-${pad(probe.getUTCMonth() + 1, 2)}-${pad(probe.getUTCDate(), 2)}` +
    `T${pad(probe.getUTCHours(), 2)}:${pad(probe.getUTCMinutes(), 2)}:${pad(probe.getUTCSeconds(), 2)}`;
  const fraction = fractionRaw.slice(0, 6).padEnd(6, "0");
  return `${utc}.${fraction}Z`;
}
