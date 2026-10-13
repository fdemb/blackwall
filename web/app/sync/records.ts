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
 * `comments` and `activity`, which load per scope. Persistence receives
 * these entities in the bootstrap snapshot.
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

/** Pass to SyncStore.replaceBase on bootstrap, with comments and activity empty. */
export const BOOTSTRAP_REPLACED_ENTITIES: readonly Entity[] = [
  ...BOOTSTRAP_ENTITIES,
  "comments",
  "activity",
];

/** Sync issue shape: the server shape without the derived counts. */
export type SyncIssue = Omit<
  Issue,
  | "blocked_count"
  | "subtask_total"
  | "subtask_completed"
  | "key"
  | "labels"
  | "dependencies"
  | "followers"
  | "attachments"
  | "source_links"
> & {
  labels: Id[];
  dependencies: Id[];
  followers: Id[];
  attachments: Issue["attachments"][number][];
  source_links: Issue["source_links"][number][];
};

/** Workspace pull shape: only the workspace row itself. */
export interface SyncWorkspace {
  id: Id;
  name: string;
  slug: string;
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
 * the server's chrono parser: case-insensitive `T`/`Z`, `+HH:MM`/`+HHMM`
 * offsets, UTC, whitespace, fractional seconds of any length, and leap second 60.
 * Strict mode requires a complete explicit timezone for command arguments.
 *
 * Leap seconds normalize the way PostgreSQL stores them: `23:59:60Z` becomes
 * `00:00:00Z` the next day (verified with `SELECT '2016-12-31T23:59:60Z'::timestamptz`
 * reading back `2017-01-01 00:00:00+00`; `12:34:60Z` becomes `12:35:00Z`).
 * Fractional leap seconds (`60.xxx`) keep their fraction, even though
 * PostgreSQL rejects them; chrono accepts the shape and the prediction only
 * needs to be storable for the non-fractional case the server can persist.
 */
export function parseTimestamp(
  value: unknown,
  strict = false,
  format: "microseconds" | "chrono" = "microseconds",
): string {
  if (typeof value !== "string") throw new Error(`unparseable timestamp ${String(value)}`);
  const syntax =
    /^\p{White_Space}*([+-]\d+|\d{1,4})\p{White_Space}*-\p{White_Space}*(\d{1,2})\p{White_Space}*-\p{White_Space}*(\d{1,2})[Tt ]\p{White_Space}*(\d{1,2})\p{White_Space}*:\p{White_Space}*(\d{1,2})\p{White_Space}*:\p{White_Space}*(\d{1,2})(?:\.(\d+))?\p{White_Space}*([Zz]|[Uu][Tt][Cc]|[+\-−]\d{2}[:\p{White_Space}]*\d{2}|[+\-−]\d{2})?\p{White_Space}*$/u;
  const match = syntax.exec(value);
  if (match === null) throw new Error(`unparseable timestamp ${value}`);
  if (strict && (match[8] === undefined || /^[+\-−]\d{2}$/.test(match[8]))) {
    throw new Error("premature end of input");
  }
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const fractionRaw = match[7] ?? "";
  const outOfRange = () =>
    new Error(strict ? "input is out of range" : `unparseable timestamp ${value}`);

  checkFields({ year, month, day, hour, minute, second }, outOfRange);
  const leap = second === 60;
  const zone = probeZone(match[8], value, outOfRange);

  const datePart =
    `${probeYear(year)}-${pad(month, 2)}-${pad(day, 2)}` +
    `T${pad(hour, 2)}:${pad(minute, 2)}:${pad(leap ? 59 : second, 2)}`;
  const probe = new Date(`${datePart}${zone}`);
  if (Number.isNaN(probe.getTime())) throw new Error(`unparseable timestamp ${value}`);
  return formatUtc(probe.getTime(), leap, fractionRaw, format);
}

function checkFields(
  fields: Record<"year" | "month" | "day" | "hour" | "minute" | "second", number>,
  outOfRange: () => Error,
): void {
  const { year, month, day, hour, minute, second } = fields;
  if (month < 1 || month > 12) throw outOfRange();
  if (hour > 23 || minute > 59 || second > 60) throw outOfRange();
  if (day < 1 || day > daysInMonth(year, month)) throw outOfRange();
}

function formatUtc(
  probeMillis: number,
  leap: boolean,
  fractionRaw: string,
  format: "microseconds" | "chrono",
): string {
  const utcMillis = probeMillis + (leap && format === "microseconds" ? 1000 : 0);
  const utc = new Date(utcMillis);
  const out =
    `${pad(utc.getUTCFullYear(), 4)}-${pad(utc.getUTCMonth() + 1, 2)}-${pad(utc.getUTCDate(), 2)}` +
    `T${pad(utc.getUTCHours(), 2)}:${pad(utc.getUTCMinutes(), 2)}:${pad(leap && format === "chrono" ? 60 : utc.getUTCSeconds(), 2)}`;
  return format === "chrono"
    ? `${out}${chronoFraction(fractionRaw)}Z`
    : `${out}.${fractionRaw.slice(0, 6).padEnd(6, "0")}Z`;
}

function pad(n: number, width: number): string {
  return String(n).padStart(width, "0");
}

/** ISO year form `Date` parses: four digits, or six with a sign outside 0-9999. */
function probeYear(year: number): string {
  if (year < 0) return `-${pad(-year, 6)}`;
  if (year > 9999) return `+${pad(year, 6)}`;
  return pad(year, 4);
}

/** The zone as a `Date`-parsable suffix; a missing zone reads as UTC. */
function probeZone(zone: string | undefined, value: string, outOfRange: () => Error): string {
  if (zone === undefined || /^(?:[Zz]|UTC)$/i.test(zone)) return "Z";
  const sign = zone[0] === "-" || zone[0] === "−" ? "-" : "+";
  const digits = zone.slice(1).replace(/[:\p{White_Space}]/gu, "");
  if (digits.length !== 2 && digits.length !== 4) throw new Error(`unparseable timestamp ${value}`);
  const hours = Number(digits.slice(0, 2));
  const minutes = digits.length === 4 ? Number(digits.slice(2, 4)) : 0;
  if (!Number.isInteger(hours) || !Number.isInteger(minutes) || hours > 23 || minutes > 59) {
    throw outOfRange();
  }
  return `${sign}${pad(hours, 2)}:${pad(minutes, 2)}`;
}

/** chrono's fraction: trimmed to 0, 3, 6 or 9 digits, empty when zero. */
function chronoFraction(fraction: string): string {
  const nanos = fraction.slice(0, 9).padEnd(9, "0");
  if (Number(nanos) === 0) return "";
  const width = nanos.endsWith("000000") ? 3 : nanos.endsWith("000") ? 6 : 9;
  return `.${nanos.slice(0, width)}`;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return leapYear ? 29 : 28;
  }
  if (month === 4 || month === 6 || month === 9 || month === 11) return 30;
  return 31;
}
