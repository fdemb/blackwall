import type { components } from "./api.gen";
import type { TEAM_COLORS, TEAM_ICONS } from "./teams";

type Schemas = components["schemas"];

/**
 * A record as serde writes it. utoipa marks `Option` and `#[serde(default)]` fields optional,
 * but serde writes them every time. `Optional` names the fields that can really be absent.
 */
type Written<T, Optional extends keyof T = never> = T extends unknown
  ? Omit<Required<T>, Optional> & Pick<T, Optional>
  : never;
/** `Omit` that fails when a key leaves the schema, so an override can't outlive its field. */
type Without<T, K extends keyof T> = Omit<T, K>;
/** The client never sends null for these fields, so reads don't have to handle it. */
type NoNull<T> = { [K in keyof T]: Exclude<T[K], null> };
/** Arrays become readonly at every depth, as the replica hands records out frozen. */
type Frozen<T> = T extends readonly (infer U)[]
  ? readonly Frozen<U>[]
  : T extends object
    ? { [K in keyof T]: Frozen<T[K]> }
    : T;

export type Id = string;
export type Role = Schemas["Role"];
export type StageKind = Schemas["StageKind"];
export type Priority = Schemas["Priority"];
export type SprintState = Schemas["SprintState"];
export type AlertKind = Schemas["AlertKind"];
export type InvitationState = Schemas["InvitationState"];
export type IssueSort = Schemas["IssueSort"];
export type IssueGroup = Schemas["IssueGroup"];
/** A list's grouping. Milestone grouping is client-only, so saved views and the server lack it. */
export type ListGroup = IssueGroup | "milestone";
export type Language = Schemas["Language"];
export type Theme = Schemas["Theme"];

export type TeamIcon = (typeof TEAM_ICONS)[number];
export type TeamColor = (typeof TEAM_COLORS)[number];

export type Stage = Written<Schemas["Stage"]>;
/** The server stores any string as icon and color; the client only draws its own sets. */
export type Team = Without<Written<Schemas["Team"]>, "icon" | "color" | "stages"> & {
  icon: TeamIcon;
  color: TeamColor;
  stages: Stage[];
};
export type Label = Written<Schemas["Label"]>;
export type ProjectStatus = Schemas["ProjectStatus"];
export type ProjectHealth = Schemas["ProjectHealth"];
export type IsoDate = string;
export type Project = Written<Schemas["Project"]>;
export type Milestone = Written<Schemas["Milestone"]>;
export type Sprint = Without<Written<Schemas["Sprint"]>, "number"> & {
  /** Counts up per team. Null until the server confirms a create. */
  number: number | null;
};
export type Attachment = Schemas["Attachment"];
export type SourceLink = Schemas["SourceLink"];
export type TrackerLink = Schemas["TrackerLink"];
export type TrackerProviderKind = "openproject";
export type TrackerField =
  | "status"
  | "title"
  | "description"
  | "assignee"
  | "due_date"
  | "priority"
  | "parent"
  | "comments";
export interface TrackerDirection {
  import: boolean;
  export: boolean;
}
export type TrackerOptions = Partial<Record<TrackerField, TrackerDirection>>;
export interface TrackerProvider {
  kind: TrackerProviderKind;
  name: string;
  /** Directions the provider supports. */
  fields: TrackerOptions;
  /** Options for new connections. */
  defaults: TrackerOptions;
}
export interface TrackerMapping {
  project_id: string;
  team_id: Id;
  stage_mapping?: Record<string, Id>;
}
export interface TrackerStatus {
  id: string;
  name: string;
  is_closed: boolean;
}
export interface TrackerPerson {
  id: string;
  name: string;
  email: string | null;
}
export interface TrackerConnection {
  id: Id;
  provider: TrackerProviderKind;
  name: string;
  base_url: string;
  enabled: boolean;
  generation: number;
  options: TrackerOptions;
  projects: TrackerMapping[];
  cached_projects: { id: string; name: string }[];
  cached_statuses: TrackerStatus[];
  cached_people: TrackerPerson[];
  people_mapping: Record<string, Id>;
  status: "pending" | "syncing" | "idle" | "error";
  last_error: string;
  last_checked_at: string | null;
  last_synced_at: string | null;
  /** Local changes waiting to be sent; older servers omit it. */
  pending_pushes?: number;
  /** Why waiting changes can't be sent (credentials or permissions); older servers omit it. */
  push_error?: string | null;
}
export interface TrackerConnectionInput {
  provider: TrackerProviderKind;
  name: string;
  base_url: string;
  token: string;
  enabled?: boolean;
  options?: TrackerOptions;
  projects?: TrackerMapping[];
  people_mapping?: Record<string, Id>;
}
export type FormerKey = Schemas["FormerKey"];
/**
 * `number` counts up per team. A locally created issue carries the client's prediction until
 * the pull brings the server's.
 */
export type Issue = Frozen<Written<Schemas["Issue"], "tracker">> & {
  /** The team key and number, as in `ENG-42`. Derived on the client. */
  key: string;
  /** What URLs name the issue by: its confirmed key, or its id until the server confirms it. */
  ref: string;
};
/** `tracker` stays optional because comments cached from older servers lack it. */
export type Comment = Frozen<Written<Schemas["Comment"], "tracker" | "via">>;
export type CommentTracker = Schemas["CommentTracker"];
/** The personal access token behind a write: an integration or agent acting for the actor. */
export type Via = Schemas["Via"];
export type TimeEntry = Written<Schemas["TimeEntry"]>;
/** The sync shape adds `token_hash`; see SyncInvitation. */
export type Invitation = Without<Written<Schemas["Invitation"]>, "token_hash">;
export type FilterField = Schemas["FilterField"];
export type FilterOp = Schemas["FilterOp"];
/** Strings or null; null is an empty field. See docs/filters.md for each field's values. */
export type FilterValue = string | null;
export type FilterClause = Frozen<Schemas["FilterClause"]>;
export type IssueFilter = Frozen<NoNull<Schemas["IssueFilter"]>>;
export type SavedView = Without<Written<Schemas["SavedView"]>, "filter"> & { filter: IssueFilter };
/** The sync shape adds `dedup_key`; see SyncNotification. Older servers omit `actor_id` and `fields`. */
export type Notification = Frozen<
  Without<Written<Schemas["Notification"], "actor_id" | "fields">, "dedup_key">
>;
export type AlertPrefsWs = Written<Schemas["AlertPreferences"]>;
/** The sync shape adds `secret`; see SyncIntegration. */
export type Integration = Without<Written<Schemas["Integration"]>, "secret" | "events">;
export type SessionInfo = Written<Schemas["SessionInfo"]>;
/** A personal access token for /api/v1 and /mcp. The secret is only returned at creation. */
export type ApiToken = Written<Schemas["ApiToken"]>;
/** One field an issue update changed. References are ids, so they show the current name. */
export type FieldChange = Frozen<Written<Schemas["FieldChange"]>>;

export type Activity = Frozen<
  Without<Written<Schemas["Activity"], "fields" | "via">, "changes">
> & {
  /** Absent or empty on rows written before values were stored. */
  changes?: readonly FieldChange[];
};

/** Workspace metadata assembled from the current replica view. */
export interface Workspace {
  id: Id;
  name: string;
  /** Names the workspace in app URLs. */
  slug: string;
  members: Written<Schemas["Member"]>[];
  teams: Team[];
  labels: Label[];
  projects: Project[];
  milestones: Milestone[];
  sprints: Sprint[];
  invitations: Invitation[];
  views: SavedView[];
  alert_preferences: AlertPrefsWs[];
  integrations: Integration[];
}
export type WorkspaceSummary = Schemas["WorkspaceSummary"];
export type MemberProfile = Written<Schemas["MemberProfile"]>;
export type Profile = Written<Schemas["Profile"]>;
export type LimitedResource = Schemas["Resource"];
/** How many of one resource the workspace holds; a null limit is unlimited. */
export type Usage = Written<Schemas["Usage"]>;
export type ImportSummary = Schemas["ImportSummary"];
export interface Total {
  id: Id;
  minutes: number;
  open_issues: number;
  effort: number;
}
export interface ProjectStats {
  id: Id;
  total: number;
  completed: number;
  updated_at: string | null;
  teams: { id: Id; total: number; completed: number }[];
  milestones: { id: Id; total: number; completed: number }[];
}
export interface Report {
  issue_count: number;
  inbox_unread: number;
  label_counts: Record<Id, number>;
  project_stats: ProjectStats[];
  total_minutes: number;
  issues: (Total & { number: number; key: string; title: string })[];
  people: Total[];
  teams: Total[];
  projects: Total[];
  sprints: { id: Id; total: number; completed: number; effort: number }[];
  delivery: { date: string; completed: number }[];
}
/** The client always picks the id of an offline create, or leaves it out. */
export type IssueInput = Without<Schemas["IssueInput"], "id"> & { id?: Id };
/** A list in `labels` replaces every label. `{add, remove}` changes only the labels it names. */
export type IssuePatch = NoNull<Schemas["IssuePatch"]>;
/** Fails the build when a client command stops matching one the server accepts. */
type Sendable<T extends Frozen<Schemas["Command"]>> = T;
/**
 * Commands the client sends. Hand-written because the mutators read fields that the server
 * accepts as absent, such as `members` on `create_team`.
 */
export type Command = Sendable<
  | {
      type: "create_team";
      id?: Id;
      name: string;
      key: string;
      members: Id[];
      default_stage_ids?: Id[];
    }
  | { type: "set_team_members"; id: Id; members: Id[] }
  | { type: "set_team_archive"; id: Id; archive_after_days: number | null }
  | { type: "set_team_appearance"; id: Id; icon: TeamIcon; color: TeamColor }
  | { type: "set_team_sprints"; id: Id; sprints: boolean }
  | { type: "update_team"; id: Id; name: string; key: string }
  | { type: "delete_team"; id: Id }
  | { type: "create_stage"; id?: Id; team_id: Id; name: string; kind: StageKind; position: number }
  | { type: "update_stage"; team_id: Id; id: Id; name: string; kind: StageKind; position: number }
  | { type: "delete_stage"; team_id: Id; id: Id; replacement: Id }
  | { type: "create_label"; id?: Id; name: string; color: string }
  | { type: "update_label"; id: Id; name: string; color: string }
  | { type: "delete_label"; id: Id }
  | { type: "create_project"; id?: Id; name: string; description: string; team_ids: Id[] }
  | { type: "update_project"; id: Id; name: string; description: string; team_ids: Id[] }
  | { type: "delete_project"; id: Id }
  | {
      type: "set_project_plan";
      id: Id;
      lead_id: Id | null;
      status: ProjectStatus;
      health: ProjectHealth | null;
      start_date: IsoDate | null;
      target_date: IsoDate | null;
    }
  | { type: "create_milestone"; id?: Id; project_id: Id; name: string; deadline: string | null }
  | { type: "update_milestone"; id: Id; name: string; deadline: string | null }
  | { type: "delete_milestone"; id: Id }
  | {
      type: "create_sprint";
      id?: Id;
      team_id: Id;
      name: string;
      goal: string;
      starts_at: string;
      ends_at: string;
    }
  | {
      type: "update_sprint";
      id: Id;
      name: string;
      goal: string;
      starts_at: string;
      ends_at: string;
      state: SprintState;
    }
  | { type: "complete_sprint"; id: Id; carryover_sprint_id: Id | null }
  | { type: "archive_sprint"; id: Id }
  | { type: "create_issue"; input: IssueInput }
  | { type: "update_issue"; id: Id; patch: IssuePatch }
  | { type: "move_issue"; id: Id; stage_id: Id; before_id: Id | null }
  | {
      type: "bulk_issues";
      ids: Id[];
      action: { update: IssuePatch } | "delete" | "restore" | "archive" | "unarchive";
    }
  | { type: "delete_issue"; id: Id }
  | { type: "restore_issue"; id: Id }
  | { type: "archive_issue"; id: Id }
  | { type: "unarchive_issue"; id: Id }
  | { type: "remove_attachment"; issue_id: Id; attachment_id: Id }
  | {
      type: "add_comment";
      id?: Id;
      issue_id: Id;
      body: string;
      mentions: Id[];
      attachments: Attachment[];
    }
  | { type: "edit_comment"; id: Id; body: string; mentions: Id[] }
  | { type: "delete_comment"; id: Id }
  | { type: "follow"; issue_id: Id; following: boolean; user_id?: Id | null }
  | { type: "log_time"; id?: Id; issue_id: Id; minutes: number; note: string; logged_at: string }
  | { type: "update_time"; id: Id; minutes: number; note: string; logged_at: string }
  | { type: "delete_time"; id: Id }
  | { type: "save_view"; id?: Id; name: string; shared: boolean; filter: IssueFilter }
  | { type: "update_view"; id: Id; name: string; shared: boolean; filter: IssueFilter }
  | { type: "delete_view"; id: Id }
  | { type: "invite"; email: string; role: Role; token_hash: string }
  | { type: "resend_invitation"; id: Id; token_hash: string }
  | { type: "cancel_invitation"; id: Id }
  | { type: "update_workspace"; name: string; slug: string }
  | { type: "set_role"; user_id: Id; role: Role }
  | { type: "remove_member"; user_id: Id }
  | { type: "transfer_ownership"; user_id: Id }
  // Clients older than coalesced change notifications omit `created_at` and
  // `notifications`; their queued commands keep the old read-regardless meaning.
  | { type: "mark_notification_read"; id: Id; created_at?: string }
  | { type: "mark_notification_unread"; id: Id }
  | {
      type: "mark_all_notifications_read";
      notifications?: { id: Id; created_at: string }[];
    }
  | {
      type: "configure_alerts";
      assignment: boolean;
      reply: boolean;
      change: boolean;
      mention: boolean;
      deadline: boolean;
      email_assignment: boolean;
      email_reply: boolean;
      email_change: boolean;
      email_mention: boolean;
      email_deadline: boolean;
    }
  | {
      type: "create_integration";
      id?: Id;
      name: string;
      webhook_url: string;
      secret: string;
      include_data?: boolean;
    }
  | { type: "update_integration"; id: Id; enabled: boolean; include_data?: boolean }
  | { type: "delete_integration"; id: Id }
  | { type: "add_source_link"; issue_id: Id; url: string; title: string }
  | { type: "import_issues"; issues: IssueInput[] }
>;

export type EntityVersions = Record<Id, number>;
/** The server's OperationResult. `changes` only matters to the sync engine. */
export type CommandResult = Without<Schemas["OperationResult"], "result"> & {
  result: Written<Schemas["CommandResult"], "invitation">;
};
