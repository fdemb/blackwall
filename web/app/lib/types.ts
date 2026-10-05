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
  members: Id[];
  stages: Stage[];
}
export interface Label {
  id: Id;
  version: number;
  name: string;
  color: string;
}
export interface Project {
  id: Id;
  version: number;
  name: string;
  description: string;
  team_ids: Id[];
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
export interface OpenProjectIssue {
  connection_id: Id;
  work_package_id: number;
  project_id: number;
  status_name: string;
  url: string;
  unavailable: boolean;
}
export interface OpenProjectMapping {
  project_id: number;
  team_id: Id;
  stage_mapping?: Record<string, Id>;
}
export interface OpenProjectStatus {
  id: number;
  name: string;
  is_closed: boolean;
}
export interface OpenProjectPerson {
  id: number;
  name: string;
  email: string | null;
}
export interface OpenProjectConnection {
  id: Id;
  name: string;
  base_url: string;
  enabled: boolean;
  generation: number;
  projects: OpenProjectMapping[];
  cached_projects: { id: number; name: string }[];
  cached_statuses: OpenProjectStatus[];
  cached_people: OpenProjectPerson[];
  people_mapping: Record<string, Id>;
  status: "pending" | "syncing" | "idle" | "error";
  last_error: string;
  last_checked_at: string | null;
  last_synced_at: string | null;
}
export interface OpenProjectConnectionInput {
  name: string;
  base_url: string;
  token: string;
  enabled?: boolean;
  projects?: OpenProjectMapping[];
  people_mapping?: Record<string, Id>;
}
export interface Issue {
  openproject?: OpenProjectIssue | null;
  id: Id;
  version: number;
  blocked_count: number;
  subtask_total: number;
  subtask_completed: number;
  number: number;
  title: string;
  description: string;
  team_id: Id;
  stage_id: Id;
  assignee: Id | null;
  priority: Priority;
  labels: Id[];
  estimate: number | null;
  deadline: string | null;
  project_id: Id | null;
  milestone_id: Id | null;
  sprint_id: Id | null;
  parent_id: Id | null;
  dependencies: Id[];
  position: number;
  followers: Id[];
  attachments: Attachment[];
  source_links: SourceLink[];
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}
export interface Comment {
  id: Id;
  version: number;
  issue_id: Id;
  author: Id;
  body: string;
  mentions: Id[];
  attachments: Attachment[];
  created_at: string;
  edited_at: string | null;
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
export interface IssueFilter {
  assignee?: Id;
  team_id?: Id;
  stage_id?: Id;
  priority?: Priority;
  label_id?: Id;
  sprint_id?: Id;
  project_id?: Id;
  due_before?: string;
  search?: string;
  trash?: boolean;
  parent_id?: Id;
  dependency_id?: Id;
  ids?: string;
  no_sprint?: boolean;
  open?: boolean;
  sort?: IssueSort;
  unassigned?: boolean;
  group_by?: IssueGroup;
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
export interface Activity {
  id: Id;
  actor: Id;
  action: string;
  entity_id: Id | null;
  at: string;
  fields?: string[];
}

/** Workspace records loaded once and kept current. Issues and their discussion load per page. */
export interface Workspace {
  id: Id;
  name: string;
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
  issues: (Total & { number: number; title: string })[];
  people: Total[];
  teams: Total[];
  projects: Total[];
  sprints: { id: Id; total: number; completed: number; effort: number }[];
  delivery: { date: string; completed: number }[];
}
export interface IssueInput {
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
  | { type: "create_team"; name: string; members: Id[] }
  | { type: "set_team_members"; id: Id; members: Id[] }
  | { type: "create_stage"; team_id: Id; name: string; kind: StageKind; position: number }
  | { type: "update_stage"; team_id: Id; id: Id; name: string; kind: StageKind; position: number }
  | { type: "delete_stage"; team_id: Id; id: Id; replacement: Id }
  | { type: "create_label"; name: string; color: string }
  | { type: "update_label"; id: Id; name: string; color: string }
  | { type: "create_project"; name: string; description: string; team_ids: Id[] }
  | { type: "update_project"; id: Id; name: string; description: string; team_ids: Id[] }
  | { type: "create_milestone"; project_id: Id; name: string; deadline: string | null }
  | { type: "update_milestone"; id: Id; name: string; deadline: string | null }
  | {
      type: "create_sprint";
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
  | { type: "bulk_issues"; ids: Id[]; action: { update: IssuePatch } | "delete" | "restore" }
  | { type: "delete_issue"; id: Id }
  | { type: "restore_issue"; id: Id }
  | { type: "remove_attachment"; issue_id: Id; attachment_id: Id }
  | { type: "add_comment"; issue_id: Id; body: string; mentions: Id[]; attachments: Attachment[] }
  | { type: "edit_comment"; id: Id; body: string; mentions: Id[] }
  | { type: "delete_comment"; id: Id }
  | { type: "follow"; issue_id: Id; following: boolean }
  | { type: "log_time"; issue_id: Id; minutes: number; note: string; logged_at: string }
  | { type: "update_time"; id: Id; minutes: number; note: string; logged_at: string }
  | { type: "delete_time"; id: Id }
  | { type: "save_view"; name: string; shared: boolean; filter: IssueFilter }
  | { type: "update_view"; id: Id; name: string; shared: boolean; filter: IssueFilter }
  | { type: "delete_view"; id: Id }
  | { type: "invite"; email: string; role: Role; token_hash: string }
  | { type: "resend_invitation"; id: Id; token_hash: string }
  | { type: "cancel_invitation"; id: Id }
  | { type: "set_role"; user_id: Id; role: Role }
  | { type: "remove_member"; user_id: Id }
  | { type: "mark_notification_read"; id: Id }
  | { type: "mark_notification_unread"; id: Id }
  | { type: "mark_all_notifications_read" }
  | {
      type: "configure_alerts";
      assignment: boolean;
      reply: boolean;
      change: boolean;
      mention: boolean;
      deadline: boolean;
    }
  | { type: "create_integration"; name: string; webhook_url: string; secret: string }
  | { type: "update_integration"; id: Id; enabled: boolean }
  | { type: "delete_integration"; id: Id }
  | { type: "add_source_link"; issue_id: Id; url: string; title: string }
  | { type: "import_issues"; issues: IssueInput[] };

export type EntityVersions = Record<Id, number>;
export interface PageResult<T> {
  items: T[];
  has_more: boolean;
  next_offset: number | null;
}
/** A changed record in the shape its list endpoint returns. `null` means deleted or no longer visible. */
export interface Change {
  entity: "workspace" | "members" | "issues" | keyof WorkspaceResources;
  id: Id;
  record: unknown;
}
export interface CommandResult {
  result: { id: Id | null };
  versions: EntityVersions;
  /** Every record the command changed, including side effects such as a parent's subtask counts. */
  changes: Change[];
}
/** When `reset` is true, reload everything and continue from `cursor`. */
export interface ChangeFeed {
  cursor: string;
  reset: boolean;
  changes: Change[];
}
export interface WorkspaceResources {
  teams: Team;
  labels: Label;
  projects: Project;
  milestones: Milestone;
  sprints: Sprint;
  views: SavedView;
  notifications: Notification;
  alert_preferences: AlertPrefsWs;
  invitations: Invitation;
  integrations: Integration;
  activity: Activity;
  comments: Comment;
  time_entries: TimeEntry;
}
