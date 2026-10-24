use super::filter::{Compiled, FilterClause, compile, deserialize_where};
use super::initial_version;
use crate::error::Result;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;
use uuid::Uuid;

#[derive(
    Clone, Debug, Default, Serialize, Deserialize, ToSchema, PartialEq, Eq, PartialOrd, Ord,
)]
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

/// What an edit does to keep backlog work out of sprints.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum SprintFit {
    Keep,
    /// The issue entered a backlog stage, so it leaves its sprint.
    LeaveSprint,
    /// The issue joined a sprint from the backlog, so it moves to the team's sprint stage.
    Plan,
}

impl Issue {
    /// Subscribes `user`; repeat calls change nothing.
    pub(crate) fn follow(&mut self, user: Uuid) {
        if !self.followers.contains(&user) {
            self.followers.push(user);
        }
    }

    /// Backlog issues have no sprint. `entered_stage` says whether the edit chose
    /// the stage, which then wins over the sprint.
    pub(crate) fn sprint_fit(&self, in_backlog: bool, entered_stage: bool) -> SprintFit {
        if self.sprint_id.is_none() || !in_backlog {
            SprintFit::Keep
        } else if entered_stage {
            SprintFit::LeaveSprint
        } else {
            SprintFit::Plan
        }
    }

    /// Apply field values and clear flags; callers validate and persist the result.
    pub(crate) fn apply_patch(&mut self, p: IssuePatch) {
        set(&mut self.title, p.title);
        set(&mut self.description, p.description);
        set(&mut self.stage_id, p.stage_id);
        set_or_clear(&mut self.assignee, p.assignee, p.clear_assignee);
        set(&mut self.priority, p.priority);
        set(&mut self.labels, p.labels);
        set_or_clear(&mut self.estimate, p.estimate, p.clear_estimate);
        set_or_clear(&mut self.deadline, p.deadline, p.clear_deadline);
        set_or_clear(&mut self.project_id, p.project_id, p.clear_project);
        // Leaving the project also leaves its milestone, unless the patch names one.
        if p.clear_project {
            self.milestone_id = None;
        }
        set_or_clear(&mut self.milestone_id, p.milestone_id, p.clear_milestone);
        set_or_clear(&mut self.sprint_id, p.sprint_id, p.clear_sprint);
        set_or_clear(&mut self.parent_id, p.parent_id, p.clear_parent);
        set(&mut self.dependencies, p.dependencies);
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
    /// Clauses ANDed together; see docs/filters.md. In a query string, the JSON array as text.
    #[serde(default, rename = "where", deserialize_with = "deserialize_where")]
    #[param(value_type = Option<String>)]
    pub clauses: Vec<FilterClause>,
    pub ids: Option<String>,
    pub search: Option<String>,
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

impl IssueFilter {
    /// Parses the clauses, resolving relative days against `now`.
    pub fn compile(&self, now: DateTime<Utc>) -> Result<Vec<Compiled>> {
        compile(&self.clauses, now)
    }

    /// Rejects a filter the list query could not run.
    pub fn validate(&self) -> Result<()> {
        self.compile(Utc::now()).map(drop)
    }
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

fn set<T>(field: &mut T, value: Option<T>) {
    if let Some(value) = value {
        *field = value;
    }
}

/// `clear` wins over a supplied value.
fn set_or_clear<T>(field: &mut Option<T>, value: Option<T>, clear: bool) {
    if clear {
        *field = None;
    } else if value.is_some() {
        *field = value;
    }
}
