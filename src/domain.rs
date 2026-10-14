use crate::error::{Error, Result};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;
use uuid::Uuid;

mod commands;
mod issues;
mod operations;

pub use commands::*;
pub use issues::*;

#[derive(Clone, Debug, Serialize, Deserialize, ToSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Role {
    Owner,
    Admin,
    Member,
    Viewer,
}

#[derive(Clone, Debug, Serialize, Deserialize, ToSchema)]
pub struct Member {
    #[serde(default = "initial_version")]
    pub version: i64,
    pub user_id: Uuid,
    pub role: Role,
}

#[derive(Clone, Debug, Serialize, Deserialize, ToSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum StageKind {
    Backlog,
    Planned,
    Active,
    Done,
    Cancelled,
}

#[derive(Clone, Debug, Serialize, Deserialize, ToSchema)]
pub struct Stage {
    #[serde(default = "initial_version")]
    pub version: i64,
    pub id: Uuid,
    pub name: String,
    pub kind: StageKind,
    pub position: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize, ToSchema)]
pub struct Team {
    #[serde(default = "initial_version")]
    pub version: i64,
    pub id: Uuid,
    pub name: String,
    pub members: Vec<Uuid>,
    pub stages: Vec<Stage>,
    /// Days after entering Done before auto-archive. Null means never.
    #[serde(default = "default_archive_days")]
    pub archive_after_days: Option<u32>,
}

#[derive(Clone, Debug, Serialize, Deserialize, ToSchema)]
pub struct Label {
    #[serde(default = "initial_version")]
    pub version: i64,
    pub id: Uuid,
    pub name: String,
    pub color: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, ToSchema)]
pub struct Project {
    #[serde(default = "initial_version")]
    pub version: i64,
    pub id: Uuid,
    pub name: String,
    pub description: String,
    pub team_ids: Vec<Uuid>,
}

#[derive(Clone, Debug, Serialize, Deserialize, ToSchema)]
pub struct Milestone {
    #[serde(default = "initial_version")]
    pub version: i64,
    pub id: Uuid,
    pub project_id: Uuid,
    pub name: String,
    pub deadline: Option<DateTime<Utc>>,
}

#[derive(Clone, Debug, Serialize, Deserialize, ToSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SprintState {
    Planned,
    Active,
    Completed,
    Archived,
}

#[derive(Clone, Debug, Serialize, Deserialize, ToSchema)]
pub struct Sprint {
    #[serde(default = "initial_version")]
    pub version: i64,
    pub id: Uuid,
    pub team_id: Uuid,
    pub name: String,
    pub goal: String,
    pub starts_at: DateTime<Utc>,
    pub ends_at: DateTime<Utc>,
    pub state: SprintState,
    pub outcome: Option<SprintOutcome>,
}

#[derive(Clone, Debug, Serialize, Deserialize, ToSchema)]
pub struct SprintOutcome {
    pub total: u64,
    pub completed: u64,
    pub effort: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, ToSchema)]
pub struct Comment {
    #[serde(default = "initial_version")]
    pub version: i64,
    pub id: Uuid,
    pub issue_id: Uuid,
    pub author: Uuid,
    pub body: String,
    pub mentions: Vec<Uuid>,
    pub attachments: Vec<Attachment>,
    pub created_at: DateTime<Utc>,
    pub edited_at: Option<DateTime<Utc>>,
    /// Set on comments sent to or imported from a sync provider.
    #[serde(default)]
    pub sync: Option<CommentSync>,
}

/// The remote comment a local comment corresponds to.
#[derive(Clone, Debug, Serialize, Deserialize, ToSchema)]
pub struct CommentSync {
    pub provider: String,
    pub connection_id: Uuid,
    pub remote_id: String,
    /// The remote author's name when no member maps to them; None for sent comments.
    pub author_name: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, ToSchema)]
pub struct TimeEntry {
    #[serde(default = "initial_version")]
    pub version: i64,
    pub id: Uuid,
    pub issue_id: Uuid,
    pub user_id: Uuid,
    pub minutes: u32,
    pub note: String,
    pub logged_at: DateTime<Utc>,
}

#[derive(Clone, Debug, Serialize, Deserialize, ToSchema)]
pub struct Invitation {
    #[serde(default = "initial_version")]
    pub version: i64,
    pub id: Uuid,
    pub email: String,
    pub role: Role,
    pub token_hash: String,
    pub expires_at: DateTime<Utc>,
    pub state: InvitationState,
}

#[derive(Clone, Debug, Serialize, Deserialize, ToSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum InvitationState {
    Pending,
    Accepted,
    Cancelled,
    Expired,
}

#[derive(Clone, Debug, Serialize, Deserialize, ToSchema)]
pub struct SavedView {
    #[serde(default = "initial_version")]
    pub version: i64,
    pub id: Uuid,
    pub owner: Uuid,
    pub name: String,
    pub shared: bool,
    pub filter: IssueFilter,
}

#[derive(Clone, Debug, Serialize, Deserialize, ToSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AlertKind {
    Assignment,
    Reply,
    Change,
    Mention,
    Deadline,
}

#[derive(Clone, Debug, Serialize, Deserialize, ToSchema)]
pub struct AlertPreferences {
    #[serde(default = "initial_version")]
    pub version: i64,
    pub user_id: Uuid,
    pub assignment: bool,
    pub reply: bool,
    pub change: bool,
    pub mention: bool,
    pub deadline: bool,
}

impl AlertPreferences {
    fn enabled(&self, kind: &AlertKind) -> bool {
        match kind {
            AlertKind::Assignment => self.assignment,
            AlertKind::Reply => self.reply,
            AlertKind::Change => self.change,
            AlertKind::Mention => self.mention,
            AlertKind::Deadline => self.deadline,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, ToSchema)]
pub struct Notification {
    #[serde(default = "initial_version")]
    pub version: i64,
    pub id: Uuid,
    pub user_id: Uuid,
    pub issue_id: Option<Uuid>,
    pub kind: AlertKind,
    pub message: String,
    pub read_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub dedup_key: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, ToSchema)]
pub struct Activity {
    pub id: Uuid,
    pub actor: Uuid,
    pub action: String,
    pub entity_id: Option<Uuid>,
    pub at: DateTime<Utc>,
    /// Issue fields an update changed, so the timeline can say what moved.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub fields: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, ToSchema)]
pub struct Integration {
    #[serde(default = "initial_version")]
    pub version: i64,
    pub id: Uuid,
    pub name: String,
    pub webhook_url: String,
    pub secret: String,
    pub enabled: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, ToSchema)]
pub struct Workspace {
    #[serde(default = "initial_version")]
    pub version: i64,
    pub id: Uuid,
    pub name: String,
    pub members: Vec<Member>,
    pub teams: Vec<Team>,
    pub labels: Vec<Label>,
    pub projects: Vec<Project>,
    pub milestones: Vec<Milestone>,
    pub sprints: Vec<Sprint>,
    pub issues: Vec<Issue>,
    pub comments: Vec<Comment>,
    pub time_entries: Vec<TimeEntry>,
    pub invitations: Vec<Invitation>,
    pub views: Vec<SavedView>,
    pub notifications: Vec<Notification>,
    pub alert_preferences: Vec<AlertPreferences>,
    pub integrations: Vec<Integration>,
    pub activity: Vec<Activity>,
}

#[derive(Clone, Debug, Serialize, Deserialize, ToSchema)]
pub struct CommandResult {
    pub id: Option<Uuid>,
}

#[derive(Clone, Debug, Serialize, Deserialize, ToSchema)]
pub struct Total {
    pub id: Uuid,
    pub minutes: u64,
    pub open_issues: u64,
    pub effort: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, ToSchema)]
pub struct SprintReport {
    pub id: Uuid,
    pub total: u64,
    pub completed: u64,
    pub effort: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, ToSchema)]
pub struct DeliveryDay {
    pub date: String,
    pub completed: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, ToSchema)]
pub struct Report {
    pub total_minutes: u64,
    pub issues: Vec<Total>,
    pub people: Vec<Total>,
    pub teams: Vec<Total>,
    pub projects: Vec<Total>,
    pub sprints: Vec<SprintReport>,
    pub delivery: Vec<DeliveryDay>,
}

pub fn initial_version() -> i64 {
    1
}

pub fn default_archive_days() -> Option<u32> {
    Some(30)
}

pub(crate) fn validate_archive_days(value: Option<u32>) -> Result<()> {
    if let Some(days) = value
        && !(1..=3650).contains(&days)
    {
        return Err(Error::BadRequest(
            "archive_after_days must be between 1 and 3650 days or null".into(),
        ));
    }
    Ok(())
}

pub(crate) fn text(value: &str, max: usize) -> Result<()> {
    if value.trim().is_empty() || value.len() > max {
        Err(Error::BadRequest(format!(
            "text must contain 1 to {max} bytes"
        )))
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup() -> (Workspace, Uuid, Uuid) {
        let owner = Uuid::new_v4();
        let mut w = Workspace::new("Blackwall".into(), owner).unwrap();

        let team = w
            .apply(
                owner,
                Command::CreateTeam {
                    name: "Infra".into(),
                    members: vec![owner],
                },
                Utc::now(),
            )
            .unwrap()
            .id
            .unwrap();

        (w, owner, team)
    }

    fn input(team_id: Uuid) -> IssueInput {
        IssueInput {
            title: "Rotate keys".into(),
            description: String::new(),
            team_id,
            stage_id: None,
            assignee: None,
            priority: Priority::Normal,
            labels: vec![],
            estimate: Some(3),
            deadline: None,
            project_id: None,
            milestone_id: None,
            sprint_id: None,
            parent_id: None,
            dependencies: vec![],
        }
    }

    #[test]
    fn bulk_rolls_back_when_a_target_is_invalid() {
        let (mut w, owner, team) = setup();
        let id = w
            .apply(
                owner,
                Command::CreateIssue { input: input(team) },
                Utc::now(),
            )
            .unwrap()
            .id
            .unwrap();
        let before = serde_json::to_string(&w).unwrap();

        assert!(
            w.apply(
                owner,
                Command::BulkIssues {
                    ids: vec![id, Uuid::new_v4()],
                    action: BulkAction::Delete
                },
                Utc::now()
            )
            .is_err()
        );
        assert_eq!(before, serde_json::to_string(&w).unwrap());
    }

    #[test]
    fn rejects_dependency_and_parent_cycles() {
        let (mut w, owner, team) = setup();
        let first = w
            .apply(
                owner,
                Command::CreateIssue { input: input(team) },
                Utc::now(),
            )
            .unwrap()
            .id
            .unwrap();

        let mut next = input(team);
        next.dependencies.push(first);
        next.parent_id = Some(first);

        let second = w
            .apply(owner, Command::CreateIssue { input: next }, Utc::now())
            .unwrap()
            .id
            .unwrap();

        assert!(
            w.apply(
                owner,
                Command::UpdateIssue {
                    id: first,
                    patch: IssuePatch {
                        dependencies: Some(vec![second]),
                        ..Default::default()
                    }
                },
                Utc::now()
            )
            .is_err()
        );
        assert!(
            w.apply(
                owner,
                Command::UpdateIssue {
                    id: first,
                    patch: IssuePatch {
                        parent_id: Some(second),
                        ..Default::default()
                    }
                },
                Utc::now()
            )
            .is_err()
        );
    }

    #[test]
    fn protects_last_owner_and_read_only_member() {
        let (mut w, owner, team) = setup();

        assert!(
            w.apply(owner, Command::RemoveMember { user_id: owner }, Utc::now())
                .is_err()
        );
        assert!(
            w.apply(
                owner,
                Command::SetRole {
                    user_id: owner,
                    role: Role::Member
                },
                Utc::now()
            )
            .is_err()
        );

        let viewer = Uuid::new_v4();
        w.members.push(Member {
            version: 1,
            user_id: viewer,
            role: Role::Viewer,
        });

        assert!(
            w.apply(
                viewer,
                Command::CreateIssue { input: input(team) },
                Utc::now()
            )
            .is_err()
        );
        assert!(w.query(viewer, IssueFilter::default()).is_ok());
    }

    #[test]
    fn views_update_and_filter_unassigned() {
        let (mut w, owner, team) = setup();
        let now = Utc::now();
        let mut mine = input(team);
        mine.assignee = Some(owner);

        w.apply(owner, Command::CreateIssue { input: mine }, now)
            .unwrap();
        w.apply(owner, Command::CreateIssue { input: input(team) }, now)
            .unwrap();

        let open = w
            .query(
                owner,
                IssueFilter {
                    unassigned: true,
                    ..Default::default()
                },
            )
            .unwrap();

        assert_eq!(open.len(), 1);
        assert!(open[0].assignee.is_none());

        let view = w
            .apply(
                owner,
                Command::SaveView {
                    name: "Mine".into(),
                    shared: false,
                    filter: IssueFilter {
                        assignee: Some(owner),
                        ..Default::default()
                    },
                },
                now,
            )
            .unwrap()
            .id
            .unwrap();

        w.apply(
            owner,
            Command::UpdateView {
                id: view,
                name: "Renamed".into(),
                shared: true,
                filter: IssueFilter {
                    group_by: Some(IssueGroup::Priority),
                    ..Default::default()
                },
            },
            now,
        )
        .unwrap();

        assert_eq!(w.views[0].name, "Renamed");
        assert!(w.views[0].shared);
        assert_eq!(w.views[0].filter.group_by, Some(IssueGroup::Priority));

        let viewer = Uuid::new_v4();
        w.members.push(Member {
            version: 1,
            user_id: viewer,
            role: Role::Viewer,
        });

        let personal = w
            .apply(
                viewer,
                Command::SaveView {
                    name: "Mine".into(),
                    shared: false,
                    filter: IssueFilter::default(),
                },
                now,
            )
            .unwrap()
            .id
            .unwrap();

        assert!(
            w.apply(
                viewer,
                Command::UpdateView {
                    id: personal,
                    name: "Shared".into(),
                    shared: true,
                    filter: IssueFilter::default(),
                },
                now,
            )
            .is_err()
        );
        assert!(
            w.apply(
                viewer,
                Command::UpdateView {
                    id: view,
                    name: "Hijack".into(),
                    shared: false,
                    filter: IssueFilter::default(),
                },
                now,
            )
            .is_err()
        );
    }

    #[test]
    fn corrects_labels_milestones_and_unread_state() {
        let (mut w, owner, _) = setup();
        let now = Utc::now();
        let label = w
            .apply(
                owner,
                Command::CreateLabel {
                    name: "bug".into(),
                    color: "#ef4444".into(),
                },
                now,
            )
            .unwrap()
            .id
            .unwrap();

        w.apply(
            owner,
            Command::UpdateLabel {
                id: label,
                name: "defect".into(),
                color: "#f97316".into(),
            },
            now,
        )
        .unwrap();

        assert_eq!(w.labels[0].name, "defect");

        let project = w
            .apply(
                owner,
                Command::CreateProject {
                    name: "Launch".into(),
                    description: String::new(),
                    team_ids: vec![],
                },
                now,
            )
            .unwrap()
            .id
            .unwrap();
        let milestone = w
            .apply(
                owner,
                Command::CreateMilestone {
                    project_id: project,
                    name: "Beta".into(),
                    deadline: None,
                },
                now,
            )
            .unwrap()
            .id
            .unwrap();

        w.apply(
            owner,
            Command::UpdateMilestone {
                id: milestone,
                name: "Public beta".into(),
                deadline: Some(now),
            },
            now,
        )
        .unwrap();

        assert_eq!(w.milestones[0].name, "Public beta");
        assert!(w.milestones[0].deadline.is_some());
        assert!(
            w.apply(
                owner,
                Command::UpdateMilestone {
                    id: Uuid::new_v4(),
                    name: "Ghost".into(),
                    deadline: None,
                },
                now,
            )
            .is_err()
        );

        let note = Uuid::new_v4();
        w.notifications.push(Notification {
            version: 1,
            id: note,
            user_id: owner,
            issue_id: None,
            kind: AlertKind::Assignment,
            message: "Assigned".into(),
            read_at: Some(now),
            created_at: now,
            dedup_key: String::new(),
        });

        w.apply(owner, Command::MarkNotificationUnread { id: note }, now)
            .unwrap();

        assert!(w.notifications[0].read_at.is_none());
    }

    #[test]
    fn invitation_is_one_use_and_public_snapshot_hides_hash() {
        let (mut w, owner, _) = setup();
        let hash = "a".repeat(64);
        let now = Utc::now();

        w.apply(
            owner,
            Command::Invite {
                email: "colleague@example.com".into(),
                role: Role::Member,
                token_hash: hash.clone(),
            },
            now,
        )
        .unwrap();

        assert!(
            w.public(owner).unwrap().invitations[0]
                .token_hash
                .is_empty()
        );

        let user = Uuid::new_v4();
        w.accept_invitation(user, "colleague@example.com", &hash, now)
            .unwrap();

        assert!(
            w.accept_invitation(user, "colleague@example.com", &hash, now)
                .is_err()
        );
    }

    #[test]
    fn completion_carries_unfinished_work_only() {
        let (mut w, owner, team) = setup();
        let now = Utc::now();
        let sprint = w
            .apply(
                owner,
                Command::CreateSprint {
                    team_id: team,
                    name: "Sprint".into(),
                    goal: "Ship".into(),
                    starts_at: now,
                    ends_at: now + chrono::Duration::days(14),
                },
                now,
            )
            .unwrap()
            .id
            .unwrap();

        let mut i = input(team);
        i.sprint_id = Some(sprint);

        let unfinished = w
            .apply(owner, Command::CreateIssue { input: i.clone() }, now)
            .unwrap()
            .id
            .unwrap();

        i.stage_id = Some(w.teams[0].stages[3].id);

        let finished = w
            .apply(owner, Command::CreateIssue { input: i }, now)
            .unwrap()
            .id
            .unwrap();

        w.apply(
            owner,
            Command::CompleteSprint {
                id: sprint,
                carryover_sprint_id: None,
            },
            now,
        )
        .unwrap();

        assert!(
            w.issues
                .iter()
                .find(|i| i.id == unfinished)
                .unwrap()
                .sprint_id
                .is_none()
        );
        assert_eq!(
            w.issues
                .iter()
                .find(|i| i.id == finished)
                .unwrap()
                .sprint_id,
            Some(sprint)
        );
    }

    #[test]
    fn filters_and_workflow_respect_blockers() {
        let (mut w, owner, team) = setup();
        let now = Utc::now();
        let blocker = w
            .apply(owner, Command::CreateIssue { input: input(team) }, now)
            .unwrap()
            .id
            .unwrap();

        let mut dependent = input(team);
        dependent.title = "Renew certificates".into();
        dependent.dependencies = vec![blocker];
        dependent.assignee = Some(owner);
        dependent.priority = Priority::High;

        let id = w
            .apply(owner, Command::CreateIssue { input: dependent }, now)
            .unwrap()
            .id
            .unwrap();

        let done = w.teams[0].stages[3].id;
        assert!(
            w.apply(
                owner,
                Command::MoveIssue {
                    id,
                    stage_id: done,
                    before_id: None
                },
                now
            )
            .is_err()
        );

        let rows = w
            .query(
                owner,
                IssueFilter {
                    assignee: Some(owner),
                    priority: Some(Priority::High),
                    search: Some("certificates".into()),
                    ..Default::default()
                },
            )
            .unwrap();

        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].id, id);

        w.apply(
            owner,
            Command::MoveIssue {
                id: blocker,
                stage_id: done,
                before_id: None,
            },
            now,
        )
        .unwrap();
        w.apply(
            owner,
            Command::MoveIssue {
                id,
                stage_id: done,
                before_id: None,
            },
            now,
        )
        .unwrap();

        assert_eq!(w.report(owner).unwrap().delivery[0].completed, 2);

        w.apply(
            owner,
            Command::UpdateIssue {
                id,
                patch: IssuePatch {
                    title: Some("Certificates renewed".into()),
                    ..Default::default()
                },
            },
            now + chrono::Duration::days(2),
        )
        .unwrap();

        assert_eq!(w.report(owner).unwrap().delivery.len(), 1);
    }
}
