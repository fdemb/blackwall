use super::filter::{Compiled, FilterClause, compile, deserialize_where};
use super::initial_version;
use crate::error::Result;
use crate::ids::{IssueId, TeamId};
use chrono::{DateTime, SubsecRound, Utc};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
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

/// A team and number an issue held before it moved to another team. Its key still names the issue.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct FormerKey {
    pub team_id: Uuid,
    pub number: u64,
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
    #[serde(default)]
    pub former_keys: Vec<FormerKey>,
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

/// The link scheme a mention uses in markdown: `[@Name](mention:<user id>)`.
pub const MENTION_SCHEME: &str = "mention:";

/// The markdown dialect descriptions and comments are rendered with.
pub const MARKDOWN_OPTIONS: pulldown_cmark::Options =
    pulldown_cmark::Options::ENABLE_TABLES.union(pulldown_cmark::Options::ENABLE_STRIKETHROUGH);

/// Users mentioned in `markdown`, by the id in each mention link.
pub fn mentioned_users(markdown: &str) -> BTreeSet<Uuid> {
    use pulldown_cmark::{Event, Parser, Tag};
    // Entities and escapes can spell the colon, so look for the bare word.
    if !markdown.contains("mention") {
        return BTreeSet::new();
    }
    Parser::new_ext(markdown, MARKDOWN_OPTIONS)
        .filter_map(|event| match event {
            Event::Start(Tag::Link { dest_url, .. }) => {
                let id = dest_url.strip_prefix(MENTION_SCHEME)?;
                (id.len() == 36).then(|| Uuid::try_parse(id).ok())?
            }
            _ => None,
        })
        .collect()
}

impl Issue {
    pub(crate) fn new_mentions(&self, before: Option<&Issue>) -> Vec<Uuid> {
        let old = match before {
            Some(old) if old.description == self.description => return vec![],
            Some(old) => mentioned_users(&old.description),
            None => BTreeSet::new(),
        };
        mentioned_users(&self.description)
            .difference(&old)
            .copied()
            .collect()
    }

    /// Subscribes `user`; repeat calls change nothing.
    pub(crate) fn follow(&mut self, user: Uuid) {
        if !self.followers.contains(&user) {
            self.followers.push(user);
        }
    }

    /// Work with no sprint that enters an active stage joins the team's active
    /// sprint. Planned stages wait for planning.
    pub(crate) fn joins_active_sprint(&self, in_active: bool, entered_stage: bool) -> bool {
        self.sprint_id.is_none() && in_active && entered_stage
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
        match p.labels {
            Some(LabelChange::Set(labels)) => self.labels = id_set(labels),
            Some(LabelChange::Edit { add, remove }) => {
                let kept = self.labels.iter().chain(&add);
                let labels = kept.filter(|id| !remove.contains(id)).copied();
                self.labels = id_set(labels.collect());
            }
            None => {}
        }
        set_or_clear(&mut self.estimate, p.estimate, p.clear_estimate);
        set_or_clear(
            &mut self.deadline,
            p.deadline.map(stored_instant),
            p.clear_deadline,
        );
        set_or_clear(&mut self.project_id, p.project_id, p.clear_project);
        // Leaving the project also leaves its milestone, unless the patch names one.
        if p.clear_project {
            self.milestone_id = None;
        }
        set_or_clear(&mut self.milestone_id, p.milestone_id, p.clear_milestone);
        set_or_clear(&mut self.sprint_id, p.sprint_id, p.clear_sprint);
        set_or_clear(
            &mut self.parent_id,
            p.parent_id.map(|id| id.0),
            p.clear_parent,
        );
        set(
            &mut self.dependencies,
            p.dependencies
                .map(|ids| id_set(ids.into_iter().map(|id| id.0).collect())),
        );
    }

    /// Starts a move to `team`: the current key becomes a former key, and a sprint the patch
    /// didn't name is left, since sprints belong to one team.
    pub(crate) fn leave_team(&mut self, before: &Issue, team: Uuid) {
        self.former_keys.push(FormerKey {
            team_id: before.team_id,
            number: before.number,
        });
        self.team_id = team;
        if self.sprint_id == before.sprint_id {
            self.sprint_id = None;
        }
    }

    /// Editable fields changed by the supplied replacement, in activity order.
    pub(crate) fn changed_fields(&self, after: &Issue) -> Vec<String> {
        self.changes(after)
            .iter()
            .map(|change| change.field().to_owned())
            .collect()
    }

    /// What the supplied replacement changed, in activity order.
    pub(crate) fn changes(&self, after: &Issue) -> Vec<FieldChange> {
        let (old, new) = (self, after);
        let mut changes = Vec::new();
        macro_rules! diff {
            ($field:ident, $variant:ident) => {
                if old.$field != new.$field {
                    changes.push(FieldChange::$variant {
                        from: old.$field.clone(),
                        to: new.$field.clone(),
                    });
                }
            };
            (copy $field:ident, $variant:ident) => {
                if old.$field != new.$field {
                    changes.push(FieldChange::$variant {
                        from: old.$field,
                        to: new.$field,
                    });
                }
            };
        }
        diff!(title, Title);
        if old.description != new.description {
            changes.push(FieldChange::Description);
        }
        diff!(copy team_id, Team);
        diff!(copy stage_id, Stage);
        diff!(copy assignee, Assignee);
        diff!(priority, Priority);
        diff!(labels, Labels);
        diff!(copy estimate, Estimate);
        diff!(copy deadline, Deadline);
        diff!(copy project_id, Project);
        diff!(copy milestone_id, Milestone);
        diff!(copy sprint_id, Sprint);
        diff!(copy parent_id, Parent);
        if old.dependencies != new.dependencies {
            changes.push(FieldChange::Dependencies);
        }
        changes
    }
}

/// One field an issue update changed. References hold ids, so a later rename shows the new
/// name. The description and dependencies carry no values: the text can be large, and
/// consecutive description edits share one activity row.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, ToSchema)]
#[serde(tag = "field", rename_all = "snake_case")]
pub enum FieldChange {
    Title {
        from: String,
        to: String,
    },
    Description,
    Team {
        from: Uuid,
        to: Uuid,
    },
    Stage {
        from: Uuid,
        to: Uuid,
    },
    Assignee {
        from: Option<Uuid>,
        to: Option<Uuid>,
    },
    Priority {
        from: Priority,
        to: Priority,
    },
    Labels {
        from: Vec<Uuid>,
        to: Vec<Uuid>,
    },
    Estimate {
        from: Option<u32>,
        to: Option<u32>,
    },
    Deadline {
        from: Option<DateTime<Utc>>,
        to: Option<DateTime<Utc>>,
    },
    Project {
        from: Option<Uuid>,
        to: Option<Uuid>,
    },
    Milestone {
        from: Option<Uuid>,
        to: Option<Uuid>,
    },
    Sprint {
        from: Option<Uuid>,
        to: Option<Uuid>,
    },
    Parent {
        from: Option<Uuid>,
        to: Option<Uuid>,
    },
    Dependencies,
}

impl FieldChange {
    pub fn field(&self) -> &'static str {
        match self {
            Self::Title { .. } => "title",
            Self::Description => "description",
            Self::Team { .. } => "team",
            Self::Stage { .. } => "stage",
            Self::Assignee { .. } => "assignee",
            Self::Priority { .. } => "priority",
            Self::Labels { .. } => "labels",
            Self::Estimate { .. } => "estimate",
            Self::Deadline { .. } => "deadline",
            Self::Project { .. } => "project",
            Self::Milestone { .. } => "milestone",
            Self::Sprint { .. } => "sprint",
            Self::Parent { .. } => "parent",
            Self::Dependencies => "dependencies",
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, ToSchema)]
pub struct IssueInput {
    pub id: Option<IssueId>,
    pub title: String,
    #[serde(default)]
    pub description: String,
    pub team_id: TeamId,
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
    pub parent_id: Option<IssueId>,
    #[serde(default)]
    pub dependencies: Vec<IssueId>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, ToSchema)]
pub struct IssuePatch {
    pub title: Option<String>,
    pub description: Option<String>,
    /// Moves the issue to another team under that team's next number. Its old key keeps
    /// resolving. Without `stage_id` it lands in the team's first stage of the same kind. It
    /// leaves its sprint, and its project when the project doesn't include the team.
    pub team_id: Option<TeamId>,
    pub stage_id: Option<Uuid>,
    pub assignee: Option<Uuid>,
    #[serde(default)]
    pub clear_assignee: bool,
    pub priority: Option<Priority>,
    pub labels: Option<LabelChange>,
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
    pub parent_id: Option<IssueId>,
    #[serde(default)]
    pub clear_parent: bool,
    pub dependencies: Option<Vec<IssueId>>,
}

/// A list replaces every label. `{add, remove}` changes only the labels it names, and a
/// label in both is removed. Servers from before `{add, remove}` reject it as a type error
/// instead of acknowledging an edit they can't apply.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, ToSchema)]
#[serde(untagged)]
pub enum LabelChange {
    Set(Vec<Uuid>),
    Edit {
        #[serde(default)]
        add: Vec<Uuid>,
        #[serde(default)]
        remove: Vec<Uuid>,
    },
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

pub(crate) fn id_set(mut ids: Vec<Uuid>) -> Vec<Uuid> {
    ids.sort();
    ids.dedup();
    ids
}

/// Postgres keeps microseconds, so a finer timestamp would read back as a different value.
pub(crate) fn stored_instant(at: DateTime<Utc>) -> DateTime<Utc> {
    at.trunc_subsecs(6)
}

/// `clear` wins over a supplied value.
fn set_or_clear<T>(field: &mut Option<T>, value: Option<T>, clear: bool) {
    if clear {
        *field = None;
    } else if value.is_some() {
        *field = value;
    }
}

#[cfg(test)]
mod mention_tests {
    use super::*;

    #[derive(serde::Deserialize)]
    struct Case {
        name: String,
        markdown: String,
        mentions: BTreeSet<Uuid>,
    }

    #[test]
    fn mentions_match_the_shared_cases() {
        let cases: Vec<Case> =
            serde_json::from_str(include_str!("../../web/app/lib/mention-cases.json")).unwrap();
        for case in cases {
            assert_eq!(
                mentioned_users(&case.markdown),
                case.mentions,
                "{}",
                case.name
            );
        }
    }
}
