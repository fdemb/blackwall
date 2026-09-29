use super::*;
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
}
#[derive(Clone, Debug, Serialize, Deserialize, ToSchema)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Command {
    CreateTeam {
        name: String,
        #[serde(default)]
        members: Vec<Uuid>,
    },
    SetTeamMembers {
        id: Uuid,
        members: Vec<Uuid>,
    },
    CreateStage {
        team_id: Uuid,
        name: String,
        kind: StageKind,
        position: i64,
    },
    UpdateStage {
        team_id: Uuid,
        id: Uuid,
        name: String,
        kind: StageKind,
        position: i64,
    },
    DeleteStage {
        team_id: Uuid,
        id: Uuid,
        replacement: Uuid,
    },
    CreateLabel {
        name: String,
        color: String,
    },
    CreateProject {
        name: String,
        #[serde(default)]
        description: String,
        team_ids: Vec<Uuid>,
    },
    UpdateProject {
        id: Uuid,
        name: String,
        description: String,
        team_ids: Vec<Uuid>,
    },
    CreateMilestone {
        project_id: Uuid,
        name: String,
        deadline: Option<DateTime<Utc>>,
    },
    CreateSprint {
        team_id: Uuid,
        name: String,
        goal: String,
        starts_at: DateTime<Utc>,
        ends_at: DateTime<Utc>,
    },
    UpdateSprint {
        id: Uuid,
        name: String,
        goal: String,
        starts_at: DateTime<Utc>,
        ends_at: DateTime<Utc>,
        state: SprintState,
    },
    CompleteSprint {
        id: Uuid,
        carryover_sprint_id: Option<Uuid>,
    },
    ArchiveSprint {
        id: Uuid,
    },
    CreateIssue {
        input: IssueInput,
    },
    UpdateIssue {
        id: Uuid,
        patch: IssuePatch,
    },
    MoveIssue {
        id: Uuid,
        stage_id: Uuid,
        before_id: Option<Uuid>,
    },
    BulkIssues {
        ids: Vec<Uuid>,
        action: BulkAction,
    },
    DeleteIssue {
        id: Uuid,
    },
    RestoreIssue {
        id: Uuid,
    },
    AddAttachment {
        issue_id: Uuid,
        attachment: Attachment,
    },
    AttachCommentFile {
        comment_id: Uuid,
        attachment: Attachment,
    },
    RemoveAttachment {
        issue_id: Uuid,
        attachment_id: Uuid,
    },
    AddComment {
        issue_id: Uuid,
        body: String,
        #[serde(default)]
        mentions: Vec<Uuid>,
        #[serde(default)]
        attachments: Vec<Attachment>,
    },
    EditComment {
        id: Uuid,
        body: String,
        #[serde(default)]
        mentions: Vec<Uuid>,
    },
    DeleteComment {
        id: Uuid,
    },
    Follow {
        issue_id: Uuid,
        following: bool,
    },
    LogTime {
        issue_id: Uuid,
        minutes: u32,
        #[serde(default)]
        note: String,
        logged_at: DateTime<Utc>,
    },
    UpdateTime {
        id: Uuid,
        minutes: u32,
        note: String,
        logged_at: DateTime<Utc>,
    },
    DeleteTime {
        id: Uuid,
    },
    SaveView {
        name: String,
        shared: bool,
        filter: IssueFilter,
    },
    DeleteView {
        id: Uuid,
    },
    Invite {
        email: String,
        role: Role,
        token_hash: String,
    },
    ResendInvitation {
        id: Uuid,
        token_hash: String,
    },
    CancelInvitation {
        id: Uuid,
    },
    SetRole {
        user_id: Uuid,
        role: Role,
    },
    RemoveMember {
        user_id: Uuid,
    },
    MarkNotificationRead {
        id: Uuid,
    },
    MarkAllNotificationsRead,
    ConfigureAlerts {
        assignment: bool,
        reply: bool,
        change: bool,
        mention: bool,
        deadline: bool,
    },
    CreateIntegration {
        name: String,
        webhook_url: String,
        secret: String,
    },
    UpdateIntegration {
        id: Uuid,
        enabled: bool,
    },
    DeleteIntegration {
        id: Uuid,
    },
    AddSourceLink {
        issue_id: Uuid,
        url: String,
        title: String,
    },
    ImportIssues {
        issues: Vec<IssueInput>,
    },
}

impl Command {
    pub(crate) fn kind(&self) -> &'static str {
        match self {
            Self::CreateTeam { .. } => "create_team",
            Self::SetTeamMembers { .. } => "set_team_members",
            Self::CreateStage { .. } => "create_stage",
            Self::UpdateStage { .. } => "update_stage",
            Self::DeleteStage { .. } => "delete_stage",
            Self::CreateLabel { .. } => "create_label",
            Self::CreateProject { .. } => "create_project",
            Self::UpdateProject { .. } => "update_project",
            Self::CreateMilestone { .. } => "create_milestone",
            Self::CreateSprint { .. } => "create_sprint",
            Self::UpdateSprint { .. } => "update_sprint",
            Self::CompleteSprint { .. } => "complete_sprint",
            Self::ArchiveSprint { .. } => "archive_sprint",
            Self::CreateIssue { .. } => "create_issue",
            Self::UpdateIssue { .. } => "update_issue",
            Self::MoveIssue { .. } => "move_issue",
            Self::BulkIssues { .. } => "bulk_issues",
            Self::DeleteIssue { .. } => "delete_issue",
            Self::RestoreIssue { .. } => "restore_issue",
            Self::AddAttachment { .. } => "add_attachment",
            Self::AttachCommentFile { .. } => "attach_comment_file",
            Self::RemoveAttachment { .. } => "remove_attachment",
            Self::AddComment { .. } => "add_comment",
            Self::EditComment { .. } => "edit_comment",
            Self::DeleteComment { .. } => "delete_comment",
            Self::Follow { .. } => "follow",
            Self::LogTime { .. } => "log_time",
            Self::UpdateTime { .. } => "update_time",
            Self::DeleteTime { .. } => "delete_time",
            Self::SaveView { .. } => "save_view",
            Self::DeleteView { .. } => "delete_view",
            Self::Invite { .. } => "invite",
            Self::ResendInvitation { .. } => "resend_invitation",
            Self::CancelInvitation { .. } => "cancel_invitation",
            Self::SetRole { .. } => "set_role",
            Self::RemoveMember { .. } => "remove_member",
            Self::MarkNotificationRead { .. } => "mark_notification_read",
            Self::ConfigureAlerts { .. } => "configure_alerts",
            Self::CreateIntegration { .. } => "create_integration",
            Self::UpdateIntegration { .. } => "update_integration",
            Self::DeleteIntegration { .. } => "delete_integration",
            Self::AddSourceLink { .. } => "add_source_link",
            Self::ImportIssues { .. } => "import_issues",
            Self::MarkAllNotificationsRead => "mark_all_notifications_read",
        }
    }
}
