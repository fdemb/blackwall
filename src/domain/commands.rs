use super::*;

#[derive(Clone, Debug, Serialize, Deserialize, ToSchema)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Command {
    CreateTeam {
        id: Option<Uuid>,
        name: String,
        #[serde(default)]
        members: Vec<Uuid>,
        /// Client-chosen ids for the default stages, in stage order
        /// (Backlog, Todo, In progress, Done). Absent means the server
        /// generates them.
        #[serde(default)]
        default_stage_ids: Option<Vec<Uuid>>,
    },
    SetTeamMembers {
        id: Uuid,
        members: Vec<Uuid>,
    },
    SetTeamArchive {
        id: Uuid,
        /// Days after Done before auto-archive. Null means never.
        #[serde(default = "super::default_archive_days")]
        archive_after_days: Option<u32>,
    },
    SetTeamAppearance {
        id: Uuid,
        icon: String,
        color: String,
    },
    CreateStage {
        id: Option<Uuid>,
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
        id: Option<Uuid>,
        name: String,
        color: String,
    },
    UpdateLabel {
        id: Uuid,
        name: String,
        color: String,
    },
    CreateProject {
        id: Option<Uuid>,
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
        id: Option<Uuid>,
        project_id: Uuid,
        name: String,
        deadline: Option<DateTime<Utc>>,
    },
    UpdateMilestone {
        id: Uuid,
        name: String,
        deadline: Option<DateTime<Utc>>,
    },
    CreateSprint {
        id: Option<Uuid>,
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
    ArchiveIssue {
        id: Uuid,
    },
    UnarchiveIssue {
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
        id: Option<Uuid>,
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
        id: Option<Uuid>,
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
        id: Option<Uuid>,
        name: String,
        shared: bool,
        filter: IssueFilter,
    },
    UpdateView {
        id: Uuid,
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
    MarkNotificationUnread {
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
        id: Option<Uuid>,
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

/// Commands grouped the way the store and the in-memory model split their handlers.
pub(crate) enum CommandFamily {
    Planning,
    Issues,
    Discussion,
}

impl Command {
    /// Personal commands only touch the actor's own state, so viewers may run them.
    pub(crate) fn is_personal(&self) -> bool {
        matches!(
            self,
            Self::MarkNotificationRead { .. }
                | Self::MarkNotificationUnread { .. }
                | Self::MarkAllNotificationsRead
                | Self::ConfigureAlerts { .. }
                | Self::SaveView { shared: false, .. }
                | Self::UpdateView { shared: false, .. }
                | Self::DeleteView { .. }
                | Self::Follow { .. }
        )
    }

    pub(crate) fn family(&self) -> CommandFamily {
        match self {
            Self::CreateTeam { .. }
            | Self::SetTeamMembers { .. }
            | Self::SetTeamArchive { .. }
            | Self::SetTeamAppearance { .. }
            | Self::CreateStage { .. }
            | Self::UpdateStage { .. }
            | Self::DeleteStage { .. }
            | Self::CreateLabel { .. }
            | Self::UpdateLabel { .. }
            | Self::CreateProject { .. }
            | Self::UpdateProject { .. }
            | Self::CreateMilestone { .. }
            | Self::UpdateMilestone { .. }
            | Self::CreateSprint { .. }
            | Self::UpdateSprint { .. }
            | Self::CompleteSprint { .. }
            | Self::ArchiveSprint { .. } => CommandFamily::Planning,
            Self::CreateIssue { .. }
            | Self::UpdateIssue { .. }
            | Self::MoveIssue { .. }
            | Self::BulkIssues { .. }
            | Self::DeleteIssue { .. }
            | Self::RestoreIssue { .. }
            | Self::ArchiveIssue { .. }
            | Self::UnarchiveIssue { .. }
            | Self::Follow { .. }
            | Self::AddSourceLink { .. }
            | Self::ImportIssues { .. } => CommandFamily::Issues,
            _ => CommandFamily::Discussion,
        }
    }

    pub(crate) fn kind(&self) -> &'static str {
        match self {
            Self::CreateTeam { .. } => "create_team",
            Self::SetTeamMembers { .. } => "set_team_members",
            Self::SetTeamArchive { .. } => "set_team_archive",
            Self::SetTeamAppearance { .. } => "set_team_appearance",
            Self::CreateStage { .. } => "create_stage",
            Self::UpdateStage { .. } => "update_stage",
            Self::DeleteStage { .. } => "delete_stage",
            Self::CreateLabel { .. } => "create_label",
            Self::UpdateLabel { .. } => "update_label",
            Self::CreateProject { .. } => "create_project",
            Self::UpdateProject { .. } => "update_project",
            Self::CreateMilestone { .. } => "create_milestone",
            Self::UpdateMilestone { .. } => "update_milestone",
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
            Self::ArchiveIssue { .. } => "archive_issue",
            Self::UnarchiveIssue { .. } => "unarchive_issue",
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
            Self::UpdateView { .. } => "update_view",
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
            Self::MarkNotificationUnread { .. } => "mark_notification_unread",
            Self::MarkAllNotificationsRead => "mark_all_notifications_read",
        }
    }
}
