use super::initial_version;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;
use uuid::Uuid;

#[derive(Clone, Debug, Default, Serialize, Deserialize, ToSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Priority {
    #[default]
    None,
    Low,
    Normal,
    High,
    Urgent,
}

#[derive(Clone, Debug, Serialize, Deserialize, ToSchema)]
pub struct Attachment {
    pub id: Uuid,
    pub name: String,
    pub content_type: String,
    pub size: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, ToSchema)]
pub struct SourceLink {
    pub url: String,
    pub title: String,
}

/// Links an issue to the remote item it was imported from.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct TrackerLink {
    pub provider: String,
    pub connection_id: Uuid,
    pub remote_id: String,
    pub project_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_remote_id: Option<String>,
    /// Last seen remote status name, for display.
    pub status_name: String,
    pub url: String,
    /// The remote item as last imported or pushed, for the three-way merge.
    /// None for links created before the merge: the remote wins once.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schema(ignore)]
    pub baseline: Option<Baseline>,
    /// Last failed outbound push, cleared on success.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub push_error: Option<String>,
    /// The remote modification time when every comment was last imported; None when the
    /// provider omits it and while comment import is off.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schema(ignore)]
    pub comments_at: Option<DateTime<Utc>>,
    /// Comment history was imported completely once, silently; later comments notify.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    #[schema(ignore)]
    pub comments_imported: bool,
    /// When comments were last listed, successfully or not; listings go stalest first.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schema(ignore)]
    pub comments_tried_at: Option<DateTime<Utc>>,
}

/// Remote field values projected onto local IDs through the connection's mappings,
/// so mapping changes count as remote changes and unresolved parents stay `None`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Baseline {
    pub title: String,
    pub description: String,
    pub team_id: Uuid,
    pub stage_id: Uuid,
    pub assignee: Option<Uuid>,
    pub priority: Priority,
    pub deadline: Option<DateTime<Utc>>,
    pub parent_id: Option<Uuid>,
}

#[derive(Clone, Debug, Serialize, Deserialize, ToSchema)]
pub struct Issue {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tracker: Option<TrackerLink>,
    #[serde(default)]
    pub blocked_count: u64,
    #[serde(default)]
    pub subtask_total: u64,
    #[serde(default)]
    pub subtask_completed: u64,
    #[serde(default = "initial_version")]
    pub version: i64,
    pub id: Uuid,
    pub number: u64,
    pub title: String,
    pub description: String,
    pub team_id: Uuid,
    pub stage_id: Uuid,
    pub assignee: Option<Uuid>,
    /// None for synced issues without a mapped author and for issues logged before creators were stored.
    #[serde(default)]
    pub created_by: Option<Uuid>,
    pub priority: Priority,
    pub labels: Vec<Uuid>,
    pub estimate: Option<u32>,
    pub deadline: Option<DateTime<Utc>>,
    pub project_id: Option<Uuid>,
    pub milestone_id: Option<Uuid>,
    pub sprint_id: Option<Uuid>,
    pub parent_id: Option<Uuid>,
    pub dependencies: Vec<Uuid>,
    pub position: i64,
    pub followers: Vec<Uuid>,
    pub attachments: Vec<Attachment>,
    pub source_links: Vec<SourceLink>,
    pub deleted_at: Option<DateTime<Utc>>,
    #[serde(default)]
    pub archived_at: Option<DateTime<Utc>>,
    #[serde(default)]
    pub done_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Clone, Debug, Serialize, Deserialize, ToSchema)]
pub struct IssueInput {
    pub title: String,
    #[serde(default)]
    pub description: String,
    pub team_id: Uuid,
    pub stage_id: Option<Uuid>,
    pub assignee: Option<Uuid>,
    #[serde(default)]
    pub priority: Priority,
    #[serde(default)]
    pub labels: Vec<Uuid>,
    pub estimate: Option<u32>,
    pub deadline: Option<DateTime<Utc>>,
    pub project_id: Option<Uuid>,
    pub milestone_id: Option<Uuid>,
    pub sprint_id: Option<Uuid>,
    pub parent_id: Option<Uuid>,
    #[serde(default)]
    pub dependencies: Vec<Uuid>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, ToSchema)]
pub struct IssuePatch {
    pub title: Option<String>,
    pub description: Option<String>,
    pub stage_id: Option<Uuid>,
    pub assignee: Option<Uuid>,
    #[serde(default)]
    pub clear_assignee: bool,
    pub priority: Option<Priority>,
    pub labels: Option<Vec<Uuid>>,
    pub estimate: Option<u32>,
    #[serde(default)]
    pub clear_estimate: bool,
    pub deadline: Option<DateTime<Utc>>,
    #[serde(default)]
    pub clear_deadline: bool,
    pub project_id: Option<Uuid>,
    #[serde(default)]
    pub clear_project: bool,
    pub milestone_id: Option<Uuid>,
    #[serde(default)]
    pub clear_milestone: bool,
    pub sprint_id: Option<Uuid>,
    #[serde(default)]
    pub clear_sprint: bool,
    pub parent_id: Option<Uuid>,
    #[serde(default)]
    pub clear_parent: bool,
    pub dependencies: Option<Vec<Uuid>>,
}

#[derive(Clone, Debug, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum BulkAction {
    Update(Box<IssuePatch>),
    Delete,
    Restore,
    Archive,
    Unarchive,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, ToSchema, utoipa::IntoParams)]
#[into_params(parameter_in = Query)]
pub struct IssueFilter {
    pub parent_id: Option<Uuid>,
    pub dependency_id: Option<Uuid>,
    pub ids: Option<String>,
    #[serde(default)]
    pub no_sprint: bool,
    #[serde(default)]
    pub open: bool,
    pub assignee: Option<Uuid>,
    pub created_by: Option<Uuid>,
    pub team_id: Option<Uuid>,
    pub stage_id: Option<Uuid>,
    pub priority: Option<Priority>,
    pub label_id: Option<Uuid>,
    pub sprint_id: Option<Uuid>,
    pub project_id: Option<Uuid>,
    pub due_before: Option<DateTime<Utc>>,
    pub search: Option<String>,
    #[serde(default)]
    pub unassigned: bool,
    #[serde(default)]
    pub trash: bool,
    #[serde(default)]
    pub archived: bool,
    #[serde(default)]
    pub sort: IssueSort,
    pub group_by: Option<IssueGroup>,
    /// Continue an ungrouped Updated page using its next_cursor. Requires offset=0.
    pub after: Option<String>,
    /// Summary omits description and detail-only relations. Full is the offline sync shape.
    #[serde(default)]
    pub projection: IssueProjection,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum IssueProjection {
    #[default]
    Full,
    Summary,
}

#[derive(Clone, Debug, Serialize, Deserialize, ToSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum IssueGroup {
    Stage,
    Priority,
    Assignee,
    None,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum IssueSort {
    #[default]
    Position,
    Deadline,
    Updated,
    Priority,
}
