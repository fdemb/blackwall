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

export interface Stage { id: Id; name: string; kind: StageKind; position: number }
export interface Team { id: Id; name: string; members: Id[]; stages: Stage[] }
export interface Label { id: Id; name: string; color: string }
export interface Project { id: Id; name: string; description: string; team_ids: Id[] }
export interface Milestone { id: Id; project_id: Id; name: string; deadline: string | null }
export interface Sprint {
  id: Id; team_id: Id; name: string; goal: string; starts_at: string; ends_at: string;
  state: SprintState; outcome: { total: number; completed: number; effort: number } | null;
}
export interface Attachment { id: Id; name: string; content_type: string; size: number }
export interface SourceLink { url: string; title: string }
export interface Issue {
  id: Id; number: number; title: string; description: string; team_id: Id; stage_id: Id;
  assignee: Id | null; priority: Priority; labels: Id[]; estimate: number | null;
  deadline: string | null; project_id: Id | null; milestone_id: Id | null; sprint_id: Id | null;
  parent_id: Id | null; dependencies: Id[]; position: number; followers: Id[];
  attachments: Attachment[]; source_links: SourceLink[]; deleted_at: string | null;
  created_at: string; updated_at: string;
}
export interface Comment {
  id: Id; issue_id: Id; author: Id; body: string; mentions: Id[]; attachments: Attachment[];
  created_at: string; edited_at: string | null;
}
export interface TimeEntry { id: Id; issue_id: Id; user_id: Id; minutes: number; note: string; logged_at: string }
export interface Invitation { id: Id; email: string; role: Role; expires_at: string; state: InvitationState }
export interface IssueFilter {
  assignee?: Id; team_id?: Id; stage_id?: Id; priority?: Priority; label_id?: Id;
  sprint_id?: Id; project_id?: Id; due_before?: string; search?: string; trash?: boolean; sort?: IssueSort;
  unassigned?: boolean; group_by?: IssueGroup;
}
export interface SavedView { id: Id; owner: Id; name: string; shared: boolean; filter: IssueFilter }
export interface Notification {
  id: Id; user_id: Id; issue_id: Id | null; kind: AlertKind; message: string;
  read_at: string | null; created_at: string;
}
export interface AlertPrefsWs { user_id: Id; assignment: boolean; reply: boolean; change: boolean; mention: boolean; deadline: boolean }
export interface Integration { id: Id; name: string; webhook_url: string; enabled: boolean }
export interface Activity { id: Id; actor: Id; action: string; entity_id: Id | null; at: string; fields?: string[] }

export interface Workspace {
  id: Id; name: string; members: { user_id: Id; role: Role }[]; teams: Team[]; labels: Label[];
  projects: Project[]; milestones: Milestone[]; sprints: Sprint[]; issues: Issue[]; comments: Comment[];
  time_entries: TimeEntry[]; invitations: Invitation[]; views: SavedView[]; notifications: Notification[];
  alert_preferences: AlertPrefsWs[]; integrations: Integration[]; activity: Activity[];
}
export interface WorkspaceSummary { id: Id; name: string; revision: number }
export interface MemberProfile {
  id: Id; email: string; display_name: string; avatar_url: string | null; contact: string; team_ids: Id[];
}
export interface Profile {
  id: Id; email: string; display_name: string; avatar_url: string | null; contact: string;
  language: Language; theme: Theme;
  alerts: { assignments: boolean; replies: boolean; changes: boolean; deadlines: boolean };
}
export interface ImportSummary {
  issues: number; comments: number; time_entries: number; identities: { source: Id; target: Id; fallback: boolean }[];
}
export interface Total { id: Id; minutes: number; open_issues: number; effort: number }
export interface Report {
  total_minutes: number; issues: Total[]; people: Total[]; teams: Total[]; projects: Total[];
  sprints: { id: Id; total: number; completed: number; effort: number }[];
  delivery: { date: string; completed: number }[];
}
export interface IssueInput {
  title: string; description?: string; team_id: Id; stage_id?: Id | null; assignee?: Id | null;
  priority?: Priority; labels?: Id[]; estimate?: number | null; deadline?: string | null;
  project_id?: Id | null; milestone_id?: Id | null; sprint_id?: Id | null; parent_id?: Id | null;
  dependencies?: Id[];
}
export interface IssuePatch {
  title?: string; description?: string; stage_id?: Id; assignee?: Id; clear_assignee?: boolean;
  priority?: Priority; labels?: Id[]; estimate?: number; clear_estimate?: boolean;
  deadline?: string; clear_deadline?: boolean; project_id?: Id; clear_project?: boolean;
  milestone_id?: Id; clear_milestone?: boolean; sprint_id?: Id; clear_sprint?: boolean;
  parent_id?: Id; clear_parent?: boolean; dependencies?: Id[];
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
  | { type: "create_sprint"; team_id: Id; name: string; goal: string; starts_at: string; ends_at: string }
  | { type: "update_sprint"; id: Id; name: string; goal: string; starts_at: string; ends_at: string; state: SprintState }
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
  | { type: "configure_alerts"; assignment: boolean; reply: boolean; change: boolean; mention: boolean; deadline: boolean }
  | { type: "create_integration"; name: string; webhook_url: string; secret: string }
  | { type: "update_integration"; id: Id; enabled: boolean }
  | { type: "delete_integration"; id: Id }
  | { type: "add_source_link"; issue_id: Id; url: string; title: string }
  | { type: "import_issues"; issues: IssueInput[] };
