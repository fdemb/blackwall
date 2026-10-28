use crate::error::{Error, Result};
use chrono::{DateTime, Datelike, NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;
use uuid::Uuid;

mod commands;
mod events;
mod filter;
mod issues;
mod operations;

pub use commands::*;
pub use events::*;
pub use filter::*;
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
    /// Prefixes the team's issue numbers, as in `ENG-42`. Unique in the workspace.
    /// Transfers without one get a key derived from the name.
    #[serde(default)]
    pub key: String,
    /// Keys the team had before, sorted. Issue keys under them keep resolving,
    /// and no other team can take them.
    #[serde(default)]
    pub former_keys: Vec<String>,
    pub members: Vec<Uuid>,
    pub stages: Vec<Stage>,
    /// Days after entering Done before auto-archive. Null means never.
    #[serde(default = "default_archive_days")]
    pub archive_after_days: Option<u32>,
    #[serde(default = "default_team_icon")]
    pub icon: String,
    #[serde(default = "default_team_color")]
    pub color: String,
}

impl Team {
    /// Where backlog work lands when it joins a sprint: the first planned stage,
    /// else the first active one.
    pub(crate) fn sprint_stage(&self) -> Result<Uuid> {
        [StageKind::Planned, StageKind::Active]
            .iter()
            .find_map(|kind| {
                self.stages
                    .iter()
                    .filter(|s| s.kind == *kind)
                    .min_by_key(|s| (s.position, s.id))
            })
            .map(|s| s.id)
            .ok_or(Error::BadRequest(
                "team has no stage for sprint work".into(),
            ))
    }
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
    #[serde(default)]
    pub lead_id: Option<Uuid>,
    #[serde(default)]
    pub status: ProjectStatus,
    #[serde(default)]
    pub health: Option<ProjectHealth>,
    #[serde(default)]
    pub start_date: Option<NaiveDate>,
    #[serde(default)]
    pub target_date: Option<NaiveDate>,
}

#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, ToSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ProjectStatus {
    #[default]
    Planned,
    InProgress,
    Completed,
    Cancelled,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, ToSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ProjectHealth {
    OnTrack,
    AtRisk,
    OffTrack,
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

impl SprintState {
    /// Completed and archived sprints no longer accept planning changes.
    pub fn is_finished(&self) -> bool {
        matches!(self, Self::Completed | Self::Archived)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, ToSchema)]
pub struct Sprint {
    #[serde(default = "initial_version")]
    pub version: i64,
    pub id: Uuid,
    pub team_id: Uuid,
    /// Counts up per team. The store assigns it on insert, so imported values are ignored.
    #[serde(default)]
    pub number: u64,
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
    /// Set on comments sent to or imported from an issue tracker.
    #[serde(default)]
    pub tracker: Option<CommentTracker>,
    /// The token that wrote the comment for its author, if one did.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub via: Option<Via>,
}

/// The remote comment a local comment corresponds to.
#[derive(Clone, Debug, Serialize, Deserialize, ToSchema)]
pub struct CommentTracker {
    pub provider: String,
    pub connection_id: Uuid,
    pub remote_id: String,
    /// The remote author's name when no member maps to them; None for sent comments.
    pub author_name: Option<String>,
}

/// The personal access token a write went through. The actor is still the token's user;
/// this says an integration or agent acted for them.
#[derive(Clone, Debug, Serialize, Deserialize, ToSchema, PartialEq, Eq)]
pub struct Via {
    pub kind: ViaKind,
    pub token_id: Uuid,
    /// The token's name when it acted, such as `Claude Code`.
    pub name: String,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, ToSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ViaKind {
    Api,
    Mcp,
}

/// The token a write goes through; the store records it as a [`Via`] with the token's name.
#[derive(Clone, Copy, Debug)]
pub struct ViaToken {
    pub kind: ViaKind,
    pub token_id: Uuid,
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
    pub email_assignment: bool,
    pub email_reply: bool,
    pub email_change: bool,
    pub email_mention: bool,
    pub email_deadline: bool,
}

impl AlertPreferences {
    /// The email columns' defaults for assignment, reply, change, mention and deadline.
    pub const EMAIL_DEFAULTS: [bool; 5] = [true, true, false, true, true];

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
    #[serde(default)]
    pub actor_id: Option<Uuid>,
    #[serde(default)]
    pub fields: Vec<String>,
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
    /// Values before and after, for the `fields` that have them. Empty on rows written before
    /// values were stored.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub changes: Vec<FieldChange>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub via: Option<Via>,
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
    /// Public webhook event types to deliver. Empty means every event.
    #[serde(default)]
    pub events: Vec<String>,
    /// Whether deliveries carry the changed record as `data`.
    #[serde(default)]
    pub include_data: bool,
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
    /// Set by `invite` and `resend_invitation`. Idempotent replays leave it out.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub invitation: Option<IssuedInvitation>,
}

/// The only copy of a new invitation token. The database keeps its hash.
#[derive(Clone, Debug, Serialize, Deserialize, ToSchema)]
pub struct IssuedInvitation {
    pub token: String,
    /// False when this server has no mail configured, so the admin must share the link.
    pub emailed: bool,
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

/// Icons a team can show, as lucide names. The web client renders the same list.
pub const TEAM_ICONS: [&str; 24] = [
    "users",
    "rocket",
    "code",
    "palette",
    "megaphone",
    "shield",
    "server",
    "database",
    "bug",
    "flask",
    "briefcase",
    "headset",
    "globe",
    "zap",
    "book",
    "wrench",
    "chart",
    "heart",
    "cpu",
    "smartphone",
    "layers",
    "target",
    "compass",
    "leaf",
];

/// Team colors in assignment order. A new team takes the first least-used one.
pub const TEAM_COLORS: [&str; 12] = [
    "violet", "blue", "sky", "teal", "green", "lime", "amber", "orange", "red", "pink", "fuchsia",
    "slate",
];

pub fn default_team_icon() -> String {
    TEAM_ICONS[0].into()
}

pub fn default_team_color() -> String {
    TEAM_COLORS[0].into()
}

/// The first palette color used by the fewest of `taken`.
pub(crate) fn least_used_team_color<'a>(taken: impl IntoIterator<Item = &'a str>) -> &'static str {
    let mut counts = [0usize; TEAM_COLORS.len()];
    for color in taken {
        if let Some(i) = TEAM_COLORS.iter().position(|c| *c == color) {
            counts[i] += 1;
        }
    }
    let min = counts.iter().min().copied().unwrap_or(0);
    let index = counts.iter().position(|n| *n == min).unwrap_or(0);
    TEAM_COLORS[index]
}

pub(crate) fn validate_team_appearance(icon: &str, color: &str) -> Result<()> {
    if !TEAM_ICONS.contains(&icon) {
        return Err(Error::BadRequest("unknown team icon".into()));
    }
    if !TEAM_COLORS.contains(&color) {
        return Err(Error::BadRequest("unknown team color".into()));
    }
    Ok(())
}

/// Top-level app and server paths a workspace slug would shadow.
const RESERVED_SLUGS: [&str; 9] = [
    "api",
    "assets",
    "health",
    "internal-api",
    "login",
    "mcp",
    "recover",
    "register",
    "welcome",
];

/// Workspace slugs name the workspace in app URLs: lowercase letters and digits
/// in hyphen-separated runs, at most 48 bytes.
pub fn validate_workspace_slug(slug: &str) -> Result<()> {
    let valid = !slug.is_empty()
        && slug.len() <= 48
        && slug.split('-').all(|run| {
            !run.is_empty()
                && run
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
        });
    if !valid {
        return Err(Error::BadRequest(
            "slug must be 1 to 48 lowercase letters, digits and single hyphens".into(),
        ));
    }
    if RESERVED_SLUGS.contains(&slug) {
        return Err(Error::BadRequest("slug is reserved".into()));
    }
    Ok(())
}

/// The slug the app suggests for a workspace name.
pub fn workspace_slug(name: &str) -> String {
    let mut slug = String::with_capacity(name.len().min(48));
    for c in name.chars().map(|c| c.to_ascii_lowercase()) {
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            slug.push(c);
        } else if !slug.is_empty() && !slug.ends_with('-') {
            slug.push('-');
        }
        if slug.len() == 48 {
            break;
        }
    }
    let trimmed = slug.trim_end_matches('-').len();
    slug.truncate(trimmed);
    if slug.is_empty() {
        slug.push_str("workspace");
    } else if RESERVED_SLUGS.contains(&slug.as_str()) {
        slug.push_str("-workspace");
    }
    slug
}

/// Team keys prefix issue numbers, as in `ENG-42`: an uppercase letter, then
/// up to three uppercase letters or digits.
pub fn validate_team_key(key: &str) -> Result<()> {
    let bytes = key.as_bytes();
    let valid = (1..=4).contains(&bytes.len())
        && bytes[0].is_ascii_uppercase()
        && bytes[1..]
            .iter()
            .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit());
    if valid {
        Ok(())
    } else {
        Err(Error::BadRequest(
            "team key must be 1 to 4 uppercase letters or digits, starting with a letter".into(),
        ))
    }
}

/// The key the app suggests for a team name: its first three letters or digits,
/// skipping leading digits.
pub fn team_key(name: &str) -> String {
    let key: String = name
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .skip_while(char::is_ascii_digit)
        .take(3)
        .map(|c| c.to_ascii_uppercase())
        .collect();
    if key.is_empty() { "T".into() } else { key }
}

/// `base`, or `base` with a number replacing its tail, whichever `taken` lacks first.
pub(crate) fn unique_team_key(
    base: &str,
    taken: &std::collections::BTreeSet<String>,
) -> Result<String> {
    if !taken.contains(base) {
        return Ok(base.into());
    }
    (2..1000)
        .map(|n| {
            let suffix = n.to_string();
            format!("{}{suffix}", &base[..base.len().min(4 - suffix.len())])
        })
        .find(|key| !taken.contains(key))
        .ok_or(Error::Conflict("no free team key".into()))
}

/// An issue key such as `ENG-42`, split into its team key and number.
/// Case-insensitive; the key comes back uppercase.
pub fn parse_issue_key(reference: &str) -> Option<(String, u64)> {
    let (key, digits) = reference.split_once('-')?;
    let key = key.to_ascii_uppercase();
    validate_team_key(&key).ok()?;
    let number = digits
        .parse::<u64>()
        .ok()
        .filter(|n| *n > 0 && n.to_string() == digits)?;
    Some((key, number))
}

/// Default stages for a new team, in order. Positions are the index. The sync
/// client predicts them from client-chosen ids (`CreateTeam::default_stage_ids`).
pub(crate) fn default_stages() -> [(&'static str, StageKind); 4] {
    [
        ("Backlog", StageKind::Backlog),
        ("Todo", StageKind::Planned),
        ("In progress", StageKind::Active),
        ("Done", StageKind::Done),
    ]
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

pub(crate) fn validate_email(email: &str) -> Result<()> {
    if email.len() > 254
        || email.contains(char::is_whitespace)
        || !email
            .split_once('@')
            .is_some_and(|(a, b)| !a.is_empty() && b.contains('.'))
    {
        Err(Error::BadRequest("invalid email".into()))
    } else {
        Ok(())
    }
}

pub(crate) fn validate_url(url: &str) -> Result<()> {
    if url.len() > 2000
        || !(url.starts_with("https://") || url.starts_with("http://"))
        || url.contains(char::is_whitespace)
    {
        Err(Error::BadRequest("HTTP or HTTPS URL required".into()))
    } else {
        Ok(())
    }
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

/// Client-chosen id for a create command. Absent means the server generates one.
pub(crate) fn client_id(provided: Option<Uuid>) -> Result<Uuid> {
    match provided {
        Some(id) if id.is_nil() => Err(Error::BadRequest("id must not be nil".into())),
        Some(id) => Ok(id),
        None => Ok(Uuid::new_v4()),
    }
}

/// A timestamp a client wrote. PostgreSQL stores years outside 1-9999 that the
/// sync client cannot ingest, so every client-writable timestamp is rejected
/// unless its UTC value falls in years 1 through 9999.
pub(crate) fn timestamp(value: DateTime<Utc>) -> Result<()> {
    if (1..=9999).contains(&value.year()) {
        Ok(())
    } else {
        Err(Error::BadRequest(
            "timestamp year must be between 1 and 9999".into(),
        ))
    }
}

pub(crate) fn validate_project_dates(
    start: Option<NaiveDate>,
    target: Option<NaiveDate>,
) -> Result<()> {
    if [start, target]
        .into_iter()
        .flatten()
        .any(|date| !(1..=9999).contains(&date.year()))
    {
        return Err(Error::BadRequest(
            "date year must be between 1 and 9999".into(),
        ));
    }
    if let (Some(start), Some(target)) = (start, target)
        && target < start
    {
        return Err(Error::BadRequest(
            "target date must not be before start date".into(),
        ));
    }
    Ok(())
}

pub(crate) fn optional_timestamp(value: Option<DateTime<Utc>>) -> Result<()> {
    if let Some(value) = value {
        timestamp(value)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugs_and_keys_follow_the_url_rules() {
        assert_eq!(workspace_slug("  Acme -- R&D 2026 "), "acme-r-d-2026");
        assert_eq!(workspace_slug("Login"), "login-workspace");
        assert_eq!(workspace_slug("!!!"), "workspace");
        for slug in ["", "-acme", "acme-", "a--b", "Acme", "api", &"a".repeat(49)] {
            assert!(validate_workspace_slug(slug).is_err(), "{slug}");
        }

        assert_eq!(team_key("2nd line support"), "NDL");
        assert_eq!(team_key("!!"), "T");
        for key in ["", "eng", "1AB", "ENGIN", "E-1"] {
            assert!(validate_team_key(key).is_err(), "{key}");
        }
        let taken = ["OPSX".to_string(), "OPS2".to_string()].into();
        assert_eq!(unique_team_key("OPSX", &taken).unwrap(), "OPS3");

        assert_eq!(parse_issue_key("eng-42"), Some(("ENG".into(), 42)));
        for reference in ["42", "ENG-042", "ENG-0", "ENGIN-1", "ENG-+1"] {
            assert_eq!(parse_issue_key(reference), None, "{reference}");
        }
    }

    fn setup() -> (Workspace, Uuid, Uuid) {
        let owner = Uuid::new_v4();
        let mut w = Workspace::new("Blackwall".into(), owner).unwrap();

        let team = w
            .apply(
                owner,
                Command::CreateTeam {
                    id: None,
                    name: "Infra".into(),
                    key: "INF".into(),
                    members: vec![owner],
                    default_stage_ids: None,
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
            id: None,
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
    fn client_ids_are_honored_and_collisions_rejected() {
        let (mut w, owner, team) = setup();
        let now = Utc::now();

        let chosen = Uuid::new_v4();
        let mut named = input(team);
        named.id = Some(chosen);
        let created = w
            .apply(owner, Command::CreateIssue { input: named }, now)
            .unwrap()
            .id
            .unwrap();
        assert_eq!(created, chosen);

        let mut again = input(team);
        again.id = Some(chosen);
        assert!(matches!(
            w.apply(owner, Command::CreateIssue { input: again }, now),
            Err(Error::Conflict(_))
        ));

        let mut nil = input(team);
        nil.id = Some(Uuid::nil());
        assert!(matches!(
            w.apply(owner, Command::CreateIssue { input: nil }, now),
            Err(Error::BadRequest(_))
        ));

        assert!(
            matches!(
                w.apply(
                    owner,
                    Command::CreateLabel {
                        id: Some(chosen),
                        name: "bug".into(),
                        color: "#ef4444".into(),
                    },
                    now,
                ),
                Err(Error::Conflict(_))
            ),
            "ids are unique across entities in the domain model, as in SQL"
        );
        assert!(
            matches!(
                w.apply(
                    owner,
                    Command::CreateTeam {
                        id: Some(chosen),
                        name: "Taken".into(),
                        key: "TAK".into(),
                        members: vec![],
                        default_stage_ids: None,
                    },
                    now
                ),
                Err(Error::Conflict(_))
            ),
            "ids are unique across entities in the domain model, as in SQL"
        );
    }

    #[test]
    fn client_timestamps_outside_years_1_to_9999_are_rejected() {
        use chrono::NaiveDate;

        fn utc(year: i32, month: u32, day: u32, hour: u32, min: u32, sec: u32) -> DateTime<Utc> {
            DateTime::from_naive_utc_and_offset(
                NaiveDate::from_ymd_opt(year, month, day)
                    .unwrap()
                    .and_hms_opt(hour, min, sec)
                    .unwrap(),
                Utc,
            )
        }

        // 9999-12-31T23:30:00-01:00 lands in year 10000 UTC; PostgreSQL would
        // store it, but the sync client could never ingest it back.
        let after_range = utc(10000, 1, 1, 0, 30, 0);
        let before_range = utc(0, 12, 31, 23, 30, 0);
        let max_valid = utc(9999, 12, 31, 23, 59, 59);

        let (mut w, owner, team) = setup();
        let now = Utc::now();

        for deadline in [after_range, before_range] {
            let mut named = input(team);
            named.deadline = Some(deadline);
            assert!(
                matches!(
                    w.apply(owner, Command::CreateIssue { input: named }, now),
                    Err(Error::BadRequest(_))
                ),
                "deadline {deadline} must be rejected"
            );
        }

        let mut valid = input(team);
        valid.deadline = Some(max_valid);
        let issue = w
            .apply(owner, Command::CreateIssue { input: valid }, now)
            .unwrap()
            .id
            .unwrap();

        for deadline in [after_range, before_range] {
            assert!(
                matches!(
                    w.apply(
                        owner,
                        Command::UpdateIssue {
                            id: issue,
                            patch: IssuePatch {
                                deadline: Some(deadline),
                                ..Default::default()
                            }
                        },
                        now
                    ),
                    Err(Error::BadRequest(_))
                ),
                "patch deadline {deadline} must be rejected"
            );
        }

        let project = w
            .apply(
                owner,
                Command::CreateProject {
                    id: None,
                    name: "Launch".into(),
                    description: String::new(),
                    team_ids: vec![team],
                },
                now,
            )
            .unwrap()
            .id
            .unwrap();

        for deadline in [after_range, before_range] {
            assert!(
                matches!(
                    w.apply(
                        owner,
                        Command::CreateMilestone {
                            id: None,
                            project_id: project,
                            name: "Beta".into(),
                            deadline: Some(deadline),
                        },
                        now
                    ),
                    Err(Error::BadRequest(_))
                ),
                "milestone deadline {deadline} must be rejected"
            );
        }
        let milestone = w
            .apply(
                owner,
                Command::CreateMilestone {
                    id: None,
                    project_id: project,
                    name: "Beta".into(),
                    deadline: Some(max_valid),
                },
                now,
            )
            .unwrap()
            .id
            .unwrap();
        assert!(matches!(
            w.apply(
                owner,
                Command::UpdateMilestone {
                    id: milestone,
                    name: "Beta".into(),
                    deadline: Some(after_range),
                },
                now
            ),
            Err(Error::BadRequest(_))
        ));

        for instant in [after_range, before_range] {
            assert!(
                matches!(
                    w.apply(
                        owner,
                        Command::CreateSprint {
                            id: None,
                            team_id: team,
                            name: "Sprint".into(),
                            goal: "Ship".into(),
                            starts_at: instant,
                            ends_at: instant + chrono::Duration::days(14),
                        },
                        now
                    ),
                    Err(Error::BadRequest(_))
                ),
                "sprint start {instant} must be rejected"
            );
        }
        let sprint = w
            .apply(
                owner,
                Command::CreateSprint {
                    id: None,
                    team_id: team,
                    name: "Sprint".into(),
                    goal: "Ship".into(),
                    starts_at: max_valid - chrono::Duration::days(14),
                    ends_at: max_valid,
                },
                now,
            )
            .unwrap()
            .id
            .unwrap();
        assert!(matches!(
            w.apply(
                owner,
                Command::UpdateSprint {
                    id: sprint,
                    name: "Sprint".into(),
                    goal: "Ship".into(),
                    starts_at: max_valid - chrono::Duration::days(14),
                    ends_at: after_range,
                    state: SprintState::Planned,
                },
                now
            ),
            Err(Error::BadRequest(_))
        ));

        for logged_at in [after_range, before_range] {
            assert!(
                matches!(
                    w.apply(
                        owner,
                        Command::LogTime {
                            id: None,
                            issue_id: issue,
                            minutes: 30,
                            note: "Review".into(),
                            logged_at,
                        },
                        now
                    ),
                    Err(Error::BadRequest(_))
                ),
                "logged_at {logged_at} must be rejected"
            );
        }
        let entry = w
            .apply(
                owner,
                Command::LogTime {
                    id: None,
                    issue_id: issue,
                    minutes: 30,
                    note: "Review".into(),
                    logged_at: max_valid,
                },
                now,
            )
            .unwrap()
            .id
            .unwrap();
        assert!(matches!(
            w.apply(
                owner,
                Command::UpdateTime {
                    id: entry,
                    minutes: 30,
                    note: "Review".into(),
                    logged_at: before_range,
                },
                now
            ),
            Err(Error::BadRequest(_))
        ));

        assert!(matches!(
            w.apply(
                owner,
                Command::SaveView {
                    id: None,
                    name: "Late".into(),
                    shared: false,
                    filter: IssueFilter {
                        clauses: vec![FilterClause {
                            field: FilterField::Deadline,
                            op: FilterOp::Lte,
                            values: vec![Some(after_range.to_rfc3339())],
                        }],
                        ..Default::default()
                    },
                },
                now
            ),
            Err(Error::BadRequest(_))
        ));
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
    fn bulk_label_changes_keep_each_issues_other_labels() {
        let (mut w, owner, team) = setup();
        let now = Utc::now();
        let [x, y, z] = ["x", "y", "z"].map(|name| {
            w.apply(
                owner,
                Command::CreateLabel {
                    id: None,
                    name: name.into(),
                    color: "#ef4444".into(),
                },
                now,
            )
            .unwrap()
            .id
            .unwrap()
        });
        let [first, second] = [vec![x, y], vec![y]].map(|labels| {
            let mut issue = input(team);
            issue.labels = labels;
            w.apply(owner, Command::CreateIssue { input: issue }, now)
                .unwrap()
                .id
                .unwrap()
        });
        let labels = |w: &Workspace, id: Uuid| -> std::collections::BTreeSet<Uuid> {
            let issue = w.issues.iter().find(|i| i.id == id).unwrap();
            issue.labels.iter().copied().collect()
        };

        w.apply(
            owner,
            Command::BulkIssues {
                ids: vec![first, second],
                action: BulkAction::Update(Box::new(IssuePatch {
                    labels: Some(LabelChange::Edit {
                        add: vec![z],
                        remove: vec![y],
                    }),
                    ..Default::default()
                })),
            },
            now,
        )
        .unwrap();
        assert_eq!(labels(&w, first), [x, z].into());
        assert_eq!(labels(&w, second), [z].into());
    }

    #[test]
    fn label_lists_serialize_as_before_label_edits() {
        let id = Uuid::new_v4();
        let label = Uuid::new_v4();
        let stored = serde_json::json!({
            "type": "update_issue",
            "id": id,
            "patch": {
                "title": null, "description": null, "team_id": null, "stage_id": null,
                "assignee": null, "clear_assignee": false, "priority": null,
                "labels": [label],
                "estimate": null, "clear_estimate": false,
                "deadline": null, "clear_deadline": false,
                "project_id": null, "clear_project": false,
                "milestone_id": null, "clear_milestone": false,
                "sprint_id": null, "clear_sprint": false,
                "parent_id": null, "clear_parent": false,
                "dependencies": null,
            },
        });
        let command: Command = serde_json::from_value(stored.clone()).unwrap();
        assert_eq!(serde_json::to_value(&command).unwrap(), stored);
    }

    #[test]
    fn label_edits_are_a_type_error_to_servers_without_them() {
        #[derive(Debug, Deserialize)]
        struct PatchBeforeLabelEdits {
            #[allow(dead_code)]
            labels: Option<Vec<Uuid>>,
        }
        let patch = IssuePatch {
            labels: Some(LabelChange::Edit {
                add: vec![Uuid::new_v4()],
                remove: vec![],
            }),
            ..Default::default()
        };
        let sent = serde_json::to_value(&patch).unwrap();
        assert!(serde_json::from_value::<PatchBeforeLabelEdits>(sent).is_err());
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
    fn teams_rekey_without_freeing_old_keys_and_delete_only_when_empty() {
        let (mut w, owner, team) = setup();
        let now = Utc::now();
        let rekey = |key: &str| Command::UpdateTeam {
            id: team,
            name: "Platform".into(),
            key: key.into(),
        };
        w.apply(owner, rekey("PLAT"), now).unwrap();
        assert_eq!(
            (w.teams[0].name.as_str(), w.teams[0].key.as_str()),
            ("Platform", "PLAT")
        );
        assert_eq!(w.teams[0].former_keys, ["INF"]);
        let taken = Command::CreateTeam {
            id: None,
            name: "Infra again".into(),
            key: "INF".into(),
            members: vec![],
            default_stage_ids: None,
        };
        assert!(matches!(
            w.apply(owner, taken, now),
            Err(Error::Conflict(_))
        ));
        w.apply(owner, rekey("INF"), now).unwrap();
        assert_eq!(w.teams[0].former_keys, ["PLAT"]);

        let member = Uuid::new_v4();
        w.members.push(Member {
            version: 1,
            user_id: member,
            role: Role::Member,
        });
        assert!(matches!(
            w.apply(member, Command::DeleteTeam { id: team }, now),
            Err(Error::Forbidden)
        ));
        let issue = w
            .apply(owner, Command::CreateIssue { input: input(team) }, now)
            .unwrap()
            .id
            .unwrap();
        w.apply(owner, Command::DeleteIssue { id: issue }, now)
            .unwrap();
        assert!(matches!(
            w.apply(owner, Command::DeleteTeam { id: team }, now),
            Err(Error::Conflict(_)),
        ));
        w.issues.clear();
        w.apply(owner, Command::DeleteTeam { id: team }, now)
            .unwrap();
        assert!(w.teams.is_empty());
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

        w.apply(
            owner,
            Command::TransferOwnership { user_id: viewer },
            Utc::now(),
        )
        .unwrap();
        assert_eq!(w.member(owner).unwrap().role, Role::Admin);
        w.apply(owner, Command::RemoveMember { user_id: owner }, Utc::now())
            .unwrap();
        assert!(w.member(owner).is_err());
        assert!(
            w.apply(
                viewer,
                Command::RemoveMember { user_id: viewer },
                Utc::now()
            )
            .is_err()
        );
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
                    clauses: vec![FilterClause {
                        field: FilterField::Assignee,
                        op: FilterOp::Is,
                        values: vec![None],
                    }],
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
                    id: None,
                    name: "Mine".into(),
                    shared: false,
                    filter: IssueFilter {
                        clauses: vec![FilterClause {
                            field: FilterField::Assignee,
                            op: FilterOp::Is,
                            values: vec![Some(owner.to_string())],
                        }],
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
                    id: None,
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
                    id: None,
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
                    id: None,
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
                    id: None,
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
            actor_id: None,
            fields: vec![],
        });

        w.apply(owner, Command::MarkNotificationUnread { id: note }, now)
            .unwrap();

        assert!(w.notifications[0].read_at.is_none());
    }

    #[test]
    fn planning_deletes_clear_issue_references() {
        let (mut w, owner, team) = setup();
        let created = Utc::now();
        let id = |w: &mut Workspace, command| w.apply(owner, command, created).unwrap().id.unwrap();
        let label = id(
            &mut w,
            Command::CreateLabel {
                id: None,
                name: "bug".into(),
                color: "red".into(),
            },
        );
        let project = id(
            &mut w,
            Command::CreateProject {
                id: None,
                name: "Launch".into(),
                description: String::new(),
                team_ids: vec![team],
            },
        );
        let milestone = id(
            &mut w,
            Command::CreateMilestone {
                id: None,
                project_id: project,
                name: "Beta".into(),
                deadline: None,
            },
        );
        let other = id(
            &mut w,
            Command::CreateMilestone {
                id: None,
                project_id: project,
                name: "GA".into(),
                deadline: None,
            },
        );
        let mut tagged = input(team);
        tagged.labels = vec![label];
        tagged.project_id = Some(project);
        tagged.milestone_id = Some(milestone);
        let live = id(
            &mut w,
            Command::CreateIssue {
                input: tagged.clone(),
            },
        );
        let trashed = id(&mut w, Command::CreateIssue { input: tagged });
        id(&mut w, Command::DeleteIssue { id: trashed });

        let viewer = Uuid::new_v4();
        w.members.push(Member {
            version: 1,
            user_id: viewer,
            role: Role::Viewer,
        });
        assert!(matches!(
            w.apply(viewer, Command::DeleteLabel { id: label }, created),
            Err(Error::Forbidden)
        ));
        for ghost in [
            Command::DeleteLabel { id: Uuid::new_v4() },
            Command::DeleteProject { id: Uuid::new_v4() },
            Command::DeleteMilestone { id: Uuid::new_v4() },
        ] {
            assert!(matches!(
                w.apply(owner, ghost, created),
                Err(Error::NotFound)
            ));
        }

        let later = created + chrono::Duration::minutes(1);
        w.apply(owner, Command::DeleteLabel { id: label }, later)
            .unwrap();
        w.apply(owner, Command::DeleteMilestone { id: milestone }, later)
            .unwrap();
        assert!(w.labels.is_empty());
        assert_eq!(
            w.milestones.iter().map(|m| m.id).collect::<Vec<_>>(),
            [other]
        );
        for issue in [live, trashed] {
            let issue = w.issues.iter().find(|i| i.id == issue).unwrap();
            assert!(issue.labels.is_empty());
            assert_eq!(issue.milestone_id, None);
            assert_eq!(issue.project_id, Some(project));
            assert_eq!(issue.updated_at, later);
        }

        w.apply(owner, Command::DeleteProject { id: project }, later)
            .unwrap();
        assert!(w.projects.is_empty());
        assert!(w.milestones.is_empty());
        assert!(w.issues.iter().all(|i| i.project_id.is_none()));
    }

    #[test]
    fn issues_move_to_another_team_like_the_store_moves_them() {
        let (mut w, owner, infra) = setup();
        let now = Utc::now();
        let id = |w: &mut Workspace, command| w.apply(owner, command, now).unwrap().id.unwrap();
        let ops = id(
            &mut w,
            Command::CreateTeam {
                id: None,
                name: "Ops".into(),
                key: "OPS".into(),
                members: vec![owner],
                default_stage_ids: None,
            },
        );
        let project = id(
            &mut w,
            Command::CreateProject {
                id: None,
                name: "Infra only".into(),
                description: String::new(),
                team_ids: vec![infra],
            },
        );
        let active = |w: &Workspace, team: Uuid| {
            let stages = &w.teams.iter().find(|t| t.id == team).unwrap().stages;
            stages
                .iter()
                .find(|s| s.kind == StageKind::Active)
                .unwrap()
                .id
        };
        let mut filed = input(infra);
        filed.stage_id = Some(active(&w, infra));
        filed.project_id = Some(project);
        id(
            &mut w,
            Command::CreateIssue {
                input: input(infra),
            },
        );
        let issue = id(&mut w, Command::CreateIssue { input: filed });

        let patch = IssuePatch {
            team_id: Some(ops),
            ..Default::default()
        };
        id(&mut w, Command::UpdateIssue { id: issue, patch });
        let moved = w.issues.iter().find(|i| i.id == issue).unwrap();
        assert_eq!((moved.team_id, moved.number), (ops, 1));
        assert_eq!(moved.stage_id, active(&w, ops), "same kind of stage");
        assert_eq!(moved.project_id, None, "the project excludes Ops");
        assert_eq!(
            moved.former_keys,
            [FormerKey {
                team_id: infra,
                number: 2
            }]
        );
        assert_eq!(
            w.activity.last().unwrap().fields,
            ["team", "stage", "project"]
        );

        let next = id(
            &mut w,
            Command::CreateIssue {
                input: input(infra),
            },
        );
        let next = w.issues.iter().find(|i| i.id == next).unwrap();
        assert_eq!(next.number, 3, "the moved issue's number stays taken");
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
                    id: None,
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
                    clauses: vec![
                        FilterClause {
                            field: FilterField::Assignee,
                            op: FilterOp::Is,
                            values: vec![Some(owner.to_string())],
                        },
                        FilterClause {
                            field: FilterField::Priority,
                            op: FilterOp::Gte,
                            values: vec![Some("high".into())],
                        },
                    ],
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

        // Reopening the blocker leaves the done dependent blocked, still editable and
        // exportable.
        let todo = w.teams[0].stages[1].id;
        w.apply(
            owner,
            Command::MoveIssue {
                id: blocker,
                stage_id: todo,
                before_id: None,
            },
            now,
        )
        .unwrap();
        w.apply(
            owner,
            Command::UpdateIssue {
                id,
                patch: IssuePatch {
                    title: Some("Renew again".into()),
                    ..Default::default()
                },
            },
            now,
        )
        .unwrap();
        w.validate_imported().unwrap();
        let active = w.teams[0].stages[2].id;
        assert!(
            w.apply(
                owner,
                Command::MoveIssue {
                    id,
                    stage_id: active,
                    before_id: None
                },
                now
            )
            .is_err(),
            "entering another started stage waits for the blocker"
        );
    }
}
