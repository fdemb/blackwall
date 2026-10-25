import type { TEAM_COLORS, TEAM_ICONS } from "./teams";

export type Id = string;
export type Role = "owner" | "admin" | "member" | "viewer";
export type StageKind = "backlog" | "planned" | "active" | "done" | "cancelled";
export type Priority = "none" | "low" | "normal" | "high" | "urgent";
export type SprintState = "planned" | "active" | "completed" | "archived";
export type AlertKind = "assignment" | "reply" | "change" | "mention" | "deadline";
export type InvitationState = "pending" | "accepted" | "cancelled" | "expired";
export type IssueSort = "position" | "deadline" | "updated" | "priority";
export type IssueGroup = "stage" | "priority" | "assignee" | "none";
export type Language = "en" | "pl";
export type Theme = "light" | "dark" | "system";

export type TeamIcon = (typeof TEAM_ICONS)[number];
export type TeamColor = (typeof TEAM_COLORS)[number];

export interface Stage {
  id: Id;
  version: number;
  name: string;
  kind: StageKind;
  position: number;
}
export interface Team {
  id: Id;
  version: number;
  name: string;
  /** Prefixes the team's issue numbers, as in `ENG-42`. Unique in the workspace. */
  key: string;
  members: Id[];
  stages: Stage[];
  /** Days after Done before auto-archive. Null means never. */
  archive_after_days: number | null;
  icon: TeamIcon;
  color: TeamColor;
}
export interface Label {
  id: Id;
  version: number;
  name: string;
  color: string;
}
export type ProjectStatus = "planned" | "in_progress" | "completed" | "cancelled";
export type ProjectHealth = "on_track" | "at_risk" | "off_track";
export type IsoDate = string;
export interface Project {
  id: Id;
  version: number;
  name: string;
  description: string;
  team_ids: Id[];
  lead_id: Id | null;
  status: ProjectStatus;
  health: ProjectHealth | null;
  start_date: IsoDate | null;
  target_date: IsoDate | null;
}
export interface Milestone {
  id: Id;
  version: number;
  project_id: Id;
  name: string;
  deadline: string | null;
}
export interface Sprint {
  id: Id;
  version: number;
  team_id: Id;
  /** Counts up per team. Null until the server confirms a create. */
  number: number | null;
  name: string;
  goal: string;
  starts_at: string;
  ends_at: string;
  state: SprintState;
  outcome: { total: number; completed: number; effort: number } | null;
}
export interface Attachment {
  id: Id;
  name: string;
  content_type: string;
  size: number;
}
export interface SourceLink {
  url: string;
  title: string;
}
export interface TrackerLink {
  provider: TrackerProviderKind;
  connection_id: Id;
  remote_id: string;
  project_id: string;
  parent_remote_id?: string | null;
  status_name: string;
  url: string;
  push_error?: string | null;
}
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
export interface FormerKey {
  team_id: Id;
  number: number;
}
export interface Issue {
  tracker?: TrackerLink | null;
  id: Id;
  version: number;
  blocked_count: number;
  subtask_total: number;
  subtask_completed: number;
  /**
   * Counts up per team. A locally created issue carries the client's
   * prediction until the pull brings the server's.
   */
  number: number;
  /** Teams and numbers the issue held before it moved. Their keys still name it. */
  former_keys: readonly FormerKey[];
  /** The team key and number, as in `ENG-42`. Derived on the client. */
  key: string;
  /** What URLs name the issue by: its confirmed key, or its id until the server confirms it. */
  ref: string;
  title: string;
  description: string;
  team_id: Id;
  stage_id: Id;
  assignee: Id | null;
  /** Null for synced issues without a mapped author and issues created before creators were stored. */
  created_by: Id | null;
  priority: Priority;
  labels: readonly Id[];
  estimate: number | null;
  deadline: string | null;
  project_id: Id | null;
  milestone_id: Id | null;
  sprint_id: Id | null;
  parent_id: Id | null;
  dependencies: readonly Id[];
  position: number;
  followers: readonly Id[];
  attachments: readonly Attachment[];
  source_links: readonly SourceLink[];
  deleted_at: string | null;
  archived_at: string | null;
  done_at: string | null;
  created_at: string;
  updated_at: string;
}
export interface Comment {
  id: Id;
  version: number;
  issue_id: Id;
  author: Id;
  body: string;
  mentions: readonly Id[];
  attachments: readonly Attachment[];
  created_at: string;
  edited_at: string | null;
  /** Set on comments imported from an issue tracker; older servers omit it. */
  tracker?: CommentTracker | null;
  /** The API token that wrote the comment for its author, if one did. */
  via?: Via | null;
}
export interface CommentTracker {
  provider: string;
  author_name?: string | null;
}
/** The personal access token behind a write: an integration or agent acting for the actor. */
export interface Via {
  kind: "api" | "mcp";
  token_id: Id;
  name: string;
}
export interface TimeEntry {
  id: Id;
  version: number;
  issue_id: Id;
  user_id: Id;
  minutes: number;
  note: string;
  logged_at: string;
}
export interface Invitation {
  id: Id;
  version: number;
  email: string;
  role: Role;
  expires_at: string;
  state: InvitationState;
}
export type FilterField =
  | "assignee"
  | "created_by"
  | "team_id"
  | "stage_id"
  | "stage_kind"
  | "priority"
  | "labels"
  | "project_id"
  | "sprint_id"
  | "parent_id"
  | "dependencies"
  | "estimate"
  | "deadline"
  | "created_at"
  | "updated_at";
export type FilterOp = "is" | "is_not" | "lt" | "lte" | "gt" | "gte";
/** Strings or null; null is an empty field. See docs/filters.md for each field's values. */
export type FilterValue = string | null;
export interface FilterClause {
  field: FilterField;
  op: FilterOp;
  values: readonly FilterValue[];
}
export interface IssueFilter {
  /** Clauses ANDed together. */
  where?: readonly FilterClause[];
  search?: string;
  trash?: boolean;
  archived?: boolean;
  ids?: string;
  sort?: IssueSort;
  group_by?: IssueGroup;
  /** Paging cursor for ungrouped Updated pages. Stored as given. */
  after?: string;
  /** Record shape. The server defaults it to full. */
  projection?: "full" | "summary";
}
export interface SavedView {
  id: Id;
  version: number;
  owner: Id;
  name: string;
  shared: boolean;
  filter: IssueFilter;
}
export interface Notification {
  id: Id;
  version: number;
  user_id: Id;
  issue_id: Id | null;
  kind: AlertKind;
  message: string;
  read_at: string | null;
  created_at: string;
  actor_id?: Id | null;
  fields?: readonly string[];
}
export interface AlertPrefsWs {
  user_id: Id;
  version: number;
  assignment: boolean;
  reply: boolean;
  change: boolean;
  mention: boolean;
  deadline: boolean;
}
export interface Integration {
  id: Id;
  version: number;
  name: string;
  webhook_url: string;
  enabled: boolean;
}
export interface SessionInfo {
  id: Id;
  created_at: string;
  last_seen_at: string | null;
  user_agent: string | null;
  current: boolean;
}
/** A personal access token for /api/v1 and /mcp. The secret is only returned at creation. */
export interface ApiToken {
  id: Id;
  name: string;
  prefix: string;
  access: "read" | "comment" | "write";
  workspace_ids: Id[] | null;
  created_at: string;
  expires_at: string | null;
  last_used_at: string | null;
}
export interface Activity {
  id: Id;
  actor: Id;
  action: string;
  entity_id: Id | null;
  at: string;
  fields?: readonly string[];
  via?: Via | null;
}

/** Workspace metadata assembled from the current replica view. */
export interface Workspace {
  id: Id;
  name: string;
  /** Names the workspace in app URLs. */
  slug: string;
  members: { user_id: Id; role: Role; version: number }[];
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
export interface WorkspaceSummary {
  id: Id;
  name: string;
  /** Names the workspace in app URLs. */
  slug: string;
  version: number;
}
export interface MemberProfile {
  id: Id;
  role: Role;
  version: number;
  email: string;
  display_name: string;
  avatar_url: string | null;
  contact: string;
  team_ids: Id[];
}
export interface Profile {
  id: Id;
  email: string;
  display_name: string;
  avatar_url: string | null;
  contact: string;
  language: Language;
  theme: Theme;
  alerts: { assignments: boolean; replies: boolean; changes: boolean; deadlines: boolean };
}
export interface ImportSummary {
  issues: number;
  comments: number;
  time_entries: number;
  identities: { source: Id; target: Id; fallback: boolean }[];
}
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
export interface IssueInput {
  id?: Id;
  title: string;
  description?: string;
  team_id: Id;
  stage_id?: Id | null;
  assignee?: Id | null;
  priority?: Priority;
  labels?: Id[];
  estimate?: number | null;
  deadline?: string | null;
  project_id?: Id | null;
  milestone_id?: Id | null;
  sprint_id?: Id | null;
  parent_id?: Id | null;
  dependencies?: Id[];
}
export interface IssuePatch {
  title?: string;
  description?: string;
  team_id?: Id;
  stage_id?: Id;
  assignee?: Id;
  clear_assignee?: boolean;
  priority?: Priority;
  labels?: Id[];
  estimate?: number;
  clear_estimate?: boolean;
  deadline?: string;
  clear_deadline?: boolean;
  project_id?: Id;
  clear_project?: boolean;
  milestone_id?: Id;
  clear_milestone?: boolean;
  sprint_id?: Id;
  clear_sprint?: boolean;
  parent_id?: Id;
  clear_parent?: boolean;
  dependencies?: Id[];
}
export type Command =
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
    }
  | { type: "create_integration"; id?: Id; name: string; webhook_url: string; secret: string }
  | { type: "update_integration"; id: Id; enabled: boolean }
  | { type: "delete_integration"; id: Id }
  | { type: "add_source_link"; issue_id: Id; url: string; title: string }
  | { type: "import_issues"; issues: IssueInput[] };

export type EntityVersions = Record<Id, number>;
export interface CommandResult {
  result: { id: Id | null };
  versions: EntityVersions;
}
