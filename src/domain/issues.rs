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

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct OpenProjectSource {
    pub connection_id: Uuid,
    pub work_package_id: i64,
    pub project_id: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_work_package_id: Option<i64>,
    pub status_name: String,
    pub url: String,
    pub unavailable: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, ToSchema)]
pub struct Issue {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub openproject: Option<OpenProjectSource>,
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
    /// None for OpenProject issues and for issues logged before creators were stored.
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

impl Issue {
    /// Apply field values and clear flags; callers validate and persist the result.
    pub(crate) fn apply_patch(&mut self, p: IssuePatch) {
        if let Some(v) = p.title {
            self.title = v
        }
        if let Some(v) = p.description {
            self.description = v
        }

        if let Some(v) = p.stage_id {
            self.stage_id = v
        }
        if p.clear_assignee {
            self.assignee = None
        } else if let Some(v) = p.assignee {
            self.assignee = Some(v)
        }

        if let Some(v) = p.priority {
            self.priority = v
        }
        if let Some(v) = p.labels {
            self.labels = v
        }

        if p.clear_estimate {
            self.estimate = None;
        } else if let Some(v) = p.estimate {
            self.estimate = Some(v)
        }
        if p.clear_deadline {
            self.deadline = None
        } else if let Some(v) = p.deadline {
            self.deadline = Some(v)
        }

        if p.clear_project {
            self.project_id = None;
            self.milestone_id = None;
        } else if let Some(v) = p.project_id {
            self.project_id = Some(v)
        }
        if p.clear_milestone {
            self.milestone_id = None;
        } else if let Some(v) = p.milestone_id {
            self.milestone_id = Some(v)
        }
        if p.clear_sprint {
            self.sprint_id = None
        } else if let Some(v) = p.sprint_id {
            self.sprint_id = Some(v)
        }

        if p.clear_parent {
            self.parent_id = None
        } else if let Some(v) = p.parent_id {
            self.parent_id = Some(v)
        }
        if let Some(v) = p.dependencies {
            self.dependencies = v
        }
    }

    /// Editable fields changed by the supplied replacement, in activity order.
    pub(crate) fn changed_fields(&self, after: &Issue) -> Vec<String> {
        [
            ("title", self.title != after.title),
            ("description", self.description != after.description),
            ("stage", self.stage_id != after.stage_id),
            ("assignee", self.assignee != after.assignee),
            ("priority", self.priority != after.priority),
            ("labels", self.labels != after.labels),
            ("estimate", self.estimate != after.estimate),
            ("deadline", self.deadline != after.deadline),
            ("project", self.project_id != after.project_id),
            ("milestone", self.milestone_id != after.milestone_id),
            ("sprint", self.sprint_id != after.sprint_id),
            ("parent", self.parent_id != after.parent_id),
            ("dependencies", self.dependencies != after.dependencies),
        ]
        .into_iter()
        .filter(|(_, changed)| *changed)
        .map(|(name, _)| name.to_string())
        .collect()
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, ToSchema)]
pub struct IssueInput {
    pub id: Option<Uuid>,
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
