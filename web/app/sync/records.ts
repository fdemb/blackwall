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
    copy[field] = parseTimestamp(value);
  }
  return copy as RecordOf[E];
}

/**
 * RFC 3339 parser shared by mutator validation and base ingestion, mirroring
 * the server's chrono parser: case-insensitive `T`/`Z`, `+HH:MM`/`+HHMM`/`+HH`
 * offsets, fractional seconds of any length, and leap second 60.
 *
 * Leap seconds normalize the way PostgreSQL stores them: `23:59:60Z` becomes
 * `00:00:00Z` the next day (verified with `SELECT '2016-12-31T23:59:60Z'::timestamptz`
 * reading back `2017-01-01 00:00:00+00`; `12:34:60Z` becomes `12:35:00Z`).
 * Fractional leap seconds (`60.xxx`) keep their fraction, even though
 * PostgreSQL rejects them; chrono accepts the shape and the prediction only
 * needs to be storable for the non-fractional case the server can persist.
 */
export function parseTimestamp(value: unknown): string {
  if (typeof value !== "string") throw new Error(`unparseable timestamp ${String(value)}`);
  const match =
    /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?([Zz]|[+-]\d{2}:?\d{2}|[+-]\d{4}|[+-]\d{2})?$/.exec(
      value,
    );
  if (match === null) throw new Error(`unparseable timestamp ${value}`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const fractionRaw = match[7] ?? "";
  const zoneRaw = match[8];

  if (month < 1 || month > 12) throw new Error(`unparseable timestamp ${value}`);
  if (hour > 23 || minute > 59 || second > 60) throw new Error(`unparseable timestamp ${value}`);
  const leap = second === 60;
  const dim = daysInMonth(year, month);
  if (day < 1 || day > dim) throw new Error(`unparseable timestamp ${value}`);

  let zoneForProbe = "Z";
  if (zoneRaw !== undefined) {
    if (/^[Zz]$/.test(zoneRaw)) {
      zoneForProbe = "Z";
    } else {
      const sign = zoneRaw[0] === "-" ? "-" : "+";
      const digits = zoneRaw.slice(1).replace(":", "");
      let zh: number;
      let zm: number;
      if (digits.length === 2) {
        zh = Number(digits);
        zm = 0;
      } else if (digits.length === 4) {
        zh = Number(digits.slice(0, 2));
        zm = Number(digits.slice(2, 4));
      } else {
        throw new Error(`unparseable timestamp ${value}`);
      }
      if (!Number.isInteger(zh) || !Number.isInteger(zm) || zh > 23 || zm > 59) {
        throw new Error(`unparseable timestamp ${value}`);
      }
      const pad2 = (n: number): string => String(n).padStart(2, "0");
      zoneForProbe = `${sign}${pad2(zh)}:${pad2(zm)}`;
    }
  }

  const pad = (n: number, width: number): string => String(n).padStart(width, "0");
  const datePart =
    `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}` +
    `T${pad(hour, 2)}:${pad(minute, 2)}:${pad(leap ? 59 : second, 2)}`;
  const probe = new Date(`${datePart}${zoneForProbe}`);
  if (Number.isNaN(probe.getTime())) throw new Error(`unparseable timestamp ${value}`);
  const utcMillis = probe.getTime() + (leap ? 1000 : 0);
  const utc = new Date(utcMillis);
  const out =
    `${pad(utc.getUTCFullYear(), 4)}-${pad(utc.getUTCMonth() + 1, 2)}-${pad(utc.getUTCDate(), 2)}` +
    `T${pad(utc.getUTCHours(), 2)}:${pad(utc.getUTCMinutes(), 2)}:${pad(utc.getUTCSeconds(), 2)}`;
  const fraction = fractionRaw.slice(0, 6).padEnd(6, "0");
  return `${out}.${fraction}Z`;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return leapYear ? 29 : 28;
  }
  if (month === 4 || month === 6 || month === 9 || month === 11) return 30;
  return 31;
}
