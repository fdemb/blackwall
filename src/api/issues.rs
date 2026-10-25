use super::directory::{
    Directory, IssueRef, LabelRef, NamedRef, Person, SprintRef, StageRef, TeamRef,
};
use super::resources::{Versioned, list_collection, one, record};
use super::*;
use crate::domain::{
    Activity, Attachment, Comment, CommentTracker, FilterClause, Issue, IssueFilter, IssueInput,
    IssuePatch, IssueSort, Priority, SourceLink, TrackerLink, Via, deserialize_where,
};
use crate::store::CollectionQuery;
use axum::extract::{Path, Query};
use chrono::{DateTime, Utc};

/// The remote item a synced issue links to, without sync bookkeeping.
#[derive(Serialize, utoipa::ToSchema)]
pub struct ApiTrackerLink {
    /// Such as `openproject`.
    pub provider: String,
    pub connection_id: Uuid,
    pub remote_id: String,
    pub project_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_remote_id: Option<String>,
    /// Last seen remote status name.
    pub status_name: String,
    pub url: String,
    /// Why the last change could not be sent to the tracker; cleared on success.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub push_error: Option<String>,
}

impl From<TrackerLink> for ApiTrackerLink {
    fn from(link: TrackerLink) -> Self {
        Self {
            provider: link.provider,
            connection_id: link.connection_id,
            remote_id: link.remote_id,
            project_id: link.project_id,
            parent_remote_id: link.parent_remote_id,
            status_name: link.status_name,
            url: link.url,
            push_error: link.push_error,
        }
    }
}

/// An issue with the records it points at named, so callers need no second lookup.
#[derive(Serialize, utoipa::ToSchema)]
pub struct ApiIssue {
    pub id: Uuid,
    /// Human-readable key such as `ENG-42`: the team's key and the issue's
    /// number in that team. Accepted wherever an issue id is.
    pub key: String,
    pub number: u64,
    /// Keys the issue held in teams it moved out of. They still resolve to it.
    pub former_keys: Vec<String>,
    pub title: String,
    /// Markdown.
    pub description: String,
    pub team: TeamRef,
    pub stage: StageRef,
    pub assignee: Option<Person>,
    /// Null for synced issues without a mapped author and for issues logged before creators were stored.
    pub created_by: Option<Person>,
    /// The token that created the issue for `created_by`, if one did.
    pub created_via: Option<Via>,
    pub priority: Priority,
    pub estimate: Option<u32>,
    pub deadline: Option<DateTime<Utc>>,
    pub labels: Vec<LabelRef>,
    pub project: Option<NamedRef>,
    pub milestone: Option<NamedRef>,
    pub sprint: Option<SprintRef>,
    pub parent: Option<IssueRef>,
    /// Issues this one depends on.
    pub dependencies: Vec<IssueRef>,
    /// How many dependencies are not done or cancelled yet.
    pub blocked_count: u64,
    pub subtask_total: u64,
    pub subtask_completed: u64,
    pub followers: Vec<Person>,
    pub attachments: Vec<Attachment>,
    pub source_links: Vec<SourceLink>,
    /// The issue tracker item this issue syncs with, if any.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tracker: Option<ApiTrackerLink>,
    /// Board order within the stage.
    pub position: i64,
    pub version: i64,
    pub archived_at: Option<DateTime<Utc>>,
    /// Set while the issue is in the trash.
    pub deleted_at: Option<DateTime<Utc>>,
    pub done_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl Versioned for ApiIssue {
    fn version(&self) -> i64 {
        self.version
    }
}

/// Names the records issues point at, with one directory and one query per relation.
pub async fn render(store: &Store, scope: Scope, issues: Vec<Issue>) -> Result<Vec<ApiIssue>> {
    let mut dir = Directory::load(store, scope).await?;
    dir.include_people(
        store,
        issues.iter().flat_map(|i| {
            i.assignee
                .into_iter()
                .chain(i.created_by)
                .chain(i.followers.iter().copied())
        }),
    )
    .await?;
    let refs = dir
        .issue_refs(
            store,
            scope,
            issues.iter().flat_map(|i| {
                i.parent_id
                    .into_iter()
                    .chain(i.dependencies.iter().copied())
            }),
        )
        .await?;
    let ids: Vec<Uuid> = issues.iter().map(|i| i.id).collect();
    let created_via: BTreeMap<Uuid, Via> = sqlx::query_as::<_, (Uuid, serde_json::Value)>(
        "SELECT DISTINCT ON (entity_id) entity_id,via FROM activity \
         WHERE workspace_id=$1 AND entity_id=ANY($2) AND action='create_issue' AND via IS NOT NULL \
         ORDER BY entity_id,at",
    )
    .bind(scope.workspace)
    .bind(&ids)
    .fetch_all(&store.pool)
    .await?
    .into_iter()
    .filter_map(|(id, via)| Some((id, serde_json::from_value(via).ok()?)))
    .collect();

    Ok(issues
        .into_iter()
        .map(|i| ApiIssue {
            key: dir.issue_key(i.team_id, i.number),
            former_keys: i
                .former_keys
                .iter()
                .map(|k| dir.issue_key(k.team_id, k.number))
                .collect(),
            team: dir.team(i.team_id),
            stage: dir.stage(i.stage_id).unwrap_or_else(|| StageRef {
                id: i.stage_id,
                name: String::new(),
                kind: crate::domain::StageKind::Backlog,
            }),
            assignee: i.assignee.map(|id| dir.person(id)),
            created_by: i.created_by.map(|id| dir.person(id)),
            created_via: created_via.get(&i.id).cloned(),
            labels: i.labels.iter().filter_map(|id| dir.label(*id)).collect(),
            project: i.project_id.and_then(|id| dir.project(id)),
            milestone: i.milestone_id.and_then(|id| dir.milestone(id)),
            sprint: i.sprint_id.and_then(|id| dir.sprint(id)),
            parent: i.parent_id.and_then(|id| refs.get(&id).cloned()),
            dependencies: i
                .dependencies
                .iter()
                .filter_map(|id| refs.get(id).cloned())
                .collect(),
            followers: i.followers.iter().map(|id| dir.person(*id)).collect(),
            id: i.id,
            number: i.number,
            title: i.title,
            description: i.description,
            priority: i.priority,
            estimate: i.estimate,
            deadline: i.deadline,
            blocked_count: i.blocked_count,
            subtask_total: i.subtask_total,
            subtask_completed: i.subtask_completed,
            attachments: i.attachments,
            source_links: i.source_links,
            tracker: i.tracker.map(ApiTrackerLink::from),
            position: i.position,
            version: i.version,
            archived_at: i.archived_at,
            deleted_at: i.deleted_at,
            done_at: i.done_at,
            created_at: i.created_at,
            updated_at: i.updated_at,
        })
        .collect())
}

/// An issue's UUID, from a UUID or a key such as `ENG-42`.
pub async fn resolve(store: &Store, scope: Scope, reference: &str) -> Result<Uuid> {
    if let Ok(id) = Uuid::parse_str(reference) {
        return Ok(id);
    }
    let (key, number) = crate::domain::parse_issue_key(reference)
        .ok_or_else(|| Error::BadRequest("issue must be a UUID or a key such as ENG-42".into()))?;
    store
        .issue_by_key(scope.workspace, scope.user, &key, number)
        .await
}

pub async fn fetch(store: &Store, scope: Scope, id: Uuid) -> Result<ApiIssue> {
    let issue = store.get_issue(scope.workspace, scope.user, id).await?;
    render(store, scope, vec![issue])
        .await?
        .pop()
        .ok_or(Error::NotFound)
}

#[derive(Default, Deserialize, utoipa::IntoParams)]
#[into_params(parameter_in = Query)]
pub struct IssueQuery {
    /// Filter clauses ANDed together, as a JSON array of `{field, op, values}`. Values may
    /// name records as well as give their ids; see docs/filters.md.
    #[serde(default, rename = "where", deserialize_with = "deserialize_where")]
    #[param(value_type = Option<String>)]
    pub clauses: Vec<FilterClause>,
    /// Full-text, substring or issue-number search.
    pub search: Option<String>,
    /// List archived issues instead of live ones.
    #[serde(default)]
    pub archived: bool,
    /// List trashed issues instead of live ones.
    #[serde(default)]
    pub trash: bool,
    #[serde(default)]
    #[param(inline)]
    pub sort: IssueSort,
    /// 1 to 200; defaults to 50.
    pub limit: Option<i64>,
    /// `next_cursor` from the previous page.
    pub cursor: Option<String>,
}

/// Replaces names, keys and emails in filter values with the ids they name.
async fn resolve_clauses(
    store: &Store,
    scope: Scope,
    clauses: Vec<FilterClause>,
) -> Result<Vec<FilterClause>> {
    use crate::domain::FilterField as F;
    let named = |c: &FilterClause| {
        !matches!(
            c.field,
            F::StageKind | F::Priority | F::Estimate | F::Deadline | F::CreatedAt | F::UpdatedAt
        ) && c
            .values
            .iter()
            .flatten()
            .any(|v| Uuid::parse_str(v).is_err())
    };
    if !clauses.iter().any(named) {
        return Ok(clauses);
    }
    let dir = Directory::load(store, scope).await?;
    let mut resolved = Vec::with_capacity(clauses.len());
    for clause in clauses {
        if !named(&clause) {
            resolved.push(clause);
            continue;
        }
        let mut values = Vec::with_capacity(clause.values.len());
        for value in &clause.values {
            match value {
                None => values.push(None),
                Some(value) => values.extend(
                    dir.filter_ids(store, scope, clause.field, value)
                        .await?
                        .into_iter()
                        .map(|id| Some(id.to_string())),
                ),
            }
        }
        values.dedup();
        resolved.push(FilterClause { values, ..clause });
    }
    Ok(resolved)
}

pub async fn search(store: &Store, scope: Scope, query: IssueQuery) -> Result<Page<ApiIssue>> {
    let params = PageParams {
        limit: query.limit,
        cursor: query.cursor,
    };
    let (offset, after) = match Cursor::decode(params.cursor.as_deref())? {
        Cursor::Offset(offset) => (offset, None),
        Cursor::After(after) => (0, Some(after)),
    };
    let filter = IssueFilter {
        clauses: resolve_clauses(store, scope, query.clauses).await?,
        search: query.search,
        archived: query.archived,
        trash: query.trash,
        sort: query.sort,
        after,
        ..Default::default()
    };
    let total = store
        .count_issues(scope.workspace, scope.user, &filter)
        .await?;
    let value = store
        .list_issues(scope.workspace, scope.user, filter, params.limit()?, offset)
        .await?;
    // Updated-order lists page by keyset, which stays stable under concurrent edits.
    let next_cursor = match (value["next_cursor"].as_str(), value["next_offset"].as_i64()) {
        (Some(after), _) => Some(Cursor::After(after.into()).encode()),
        (None, Some(offset)) => Some(Cursor::Offset(offset).encode()),
        (None, None) => None,
    };
    let issues: Vec<Issue> = serde_json::from_value(value["items"].clone())?;
    Ok(Page {
        data: render(store, scope, issues).await?,
        next_cursor,
        total: Some(total),
    })
}

#[utoipa::path(
    get,
    path = "/api/v1/workspaces/{workspace}/issues",
    tag = "issues",
    params(("workspace" = Uuid, Path), IssueQuery),
    responses((status = 200, body = Page<ApiIssue>))
)]
pub async fn list(
    State(store): State<Store>,
    actor: ApiActor,
    Path(workspace): Path<Uuid>,
    Query(query): Query<IssueQuery>,
) -> Result<Json<Page<ApiIssue>>> {
    Ok(Json(search(&store, actor.read(workspace)?, query).await?))
}

#[utoipa::path(
    get,
    path = "/api/v1/workspaces/{workspace}/issues/{issue}",
    tag = "issues",
    params(("workspace" = Uuid, Path), ("issue" = String, Path, description = "UUID or key such as ENG-42")),
    responses((status = 200, body = ApiIssue))
)]
pub async fn get(
    State(store): State<Store>,
    actor: ApiActor,
    Path((workspace, issue)): Path<(Uuid, String)>,
) -> Result<Response> {
    let scope = actor.read(workspace)?;
    let id = resolve(&store, scope, &issue).await?;
    Ok(one(StatusCode::OK, fetch(&store, scope, id).await?))
}

/// A new issue. Fields that point at a record take its UUID or its name, as listed.
#[derive(Clone, Debug, Default, Deserialize, Serialize, utoipa::ToSchema)]
#[serde(deny_unknown_fields)]
pub struct CreateIssue {
    pub title: String,
    /// Markdown.
    #[serde(default)]
    pub description: String,
    /// Team UUID, key or name.
    pub team: String,
    /// Stage UUID or name within the team. Defaults to the team's first stage.
    pub stage: Option<String>,
    /// User UUID, email or display name, or `me` for the token's user.
    pub assignee: Option<String>,
    #[serde(default)]
    pub priority: Priority,
    /// Label UUIDs or names.
    #[serde(default)]
    pub labels: Vec<String>,
    pub estimate: Option<u32>,
    pub deadline: Option<DateTime<Utc>>,
    /// Project UUID or name.
    pub project: Option<String>,
    /// Milestone UUID or name, within the project when one is given.
    pub milestone: Option<String>,
    /// Sprint UUID, name or number (`12` or `#12`) within the team.
    pub sprint: Option<String>,
    /// Parent issue key or UUID.
    pub parent: Option<String>,
    /// Keys or UUIDs of issues this one depends on.
    #[serde(default)]
    pub dependencies: Vec<String>,
}

async fn issue_ids(store: &Store, scope: Scope, references: &[String]) -> Result<Vec<Uuid>> {
    let mut ids = Vec::with_capacity(references.len());
    for reference in references {
        ids.push(resolve(store, scope, reference).await?);
    }
    Ok(ids)
}

fn label_ids(dir: &Directory, references: &[String]) -> Result<Vec<Uuid>> {
    references.iter().map(|r| dir.find_label(r)).collect()
}

impl CreateIssue {
    async fn into_input(self, store: &Store, scope: Scope) -> Result<IssueInput> {
        let dir = Directory::load(store, scope).await?;
        let team_id = dir.find_team(&self.team)?;
        let project_id = self.project.map(|p| dir.find_project(&p)).transpose()?;
        let parent_id = match self.parent {
            Some(parent) => Some(resolve(store, scope, &parent).await?),
            None => None,
        };
        Ok(IssueInput {
            id: None,
            title: self.title,
            description: self.description,
            team_id,
            stage_id: self
                .stage
                .map(|s| dir.find_stage(team_id, &s))
                .transpose()?,
            assignee: self.assignee.map(|a| dir.find_person(&a)).transpose()?,
            priority: self.priority,
            labels: label_ids(&dir, &self.labels)?,
            estimate: self.estimate,
            deadline: self.deadline,
            project_id,
            milestone_id: self
                .milestone
                .map(|m| dir.find_milestone(project_id, &m))
                .transpose()?,
            sprint_id: self
                .sprint
                .map(|s| dir.find_sprint(team_id, &s))
                .transpose()?,
            parent_id,
            dependencies: issue_ids(store, scope, &self.dependencies).await?,
        })
    }
}

pub async fn create_issue(
    store: &Store,
    scope: Scope,
    input: CreateIssue,
    options: WriteOptions,
) -> Result<ApiIssue> {
    let input = input.into_input(store, scope).await?;
    let result = run(store, scope, Command::CreateIssue { input }, None, options).await?;
    fetch(store, scope, created_id(&result)?).await
}

#[utoipa::path(
    post,
    path = "/api/v1/workspaces/{workspace}/issues",
    tag = "issues",
    params(("workspace" = Uuid, Path)),
    request_body = CreateIssue,
    responses((status = 201, body = ApiIssue))
)]
pub async fn create(
    State(store): State<Store>,
    actor: ApiActor,
    Path(workspace): Path<Uuid>,
    options: WriteOptions,
    Json(input): Json<CreateIssue>,
) -> Result<Response> {
    let issue = create_issue(&store, actor.write(workspace)?, input, options).await?;
    Ok(one(StatusCode::CREATED, issue))
}

/// Present as `Some(None)` when the JSON says `null`, so `null` can clear a field.
pub(super) fn nullable<'de, D, T>(
    deserializer: D,
) -> std::result::Result<Option<Option<T>>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer).map(Some)
}

/// Merge-patch: omitted fields stay, `null` clears a nullable field. Fields that point at
/// a record take the same references as on create.
#[derive(Clone, Debug, Default, Deserialize, Serialize, utoipa::ToSchema)]
#[serde(deny_unknown_fields)]
pub struct UpdateIssue {
    pub title: Option<String>,
    pub description: Option<String>,
    /// Team UUID, key or name. Moving gives the issue a new key in that team, and the old key
    /// keeps resolving. Without `stage` the issue lands in the team's first stage of the same
    /// kind. It leaves its sprint, and its project when the project doesn't include the team.
    /// Synced issues can't move.
    pub team: Option<String>,
    /// Stage UUID or name within the issue's team, or within `team` when it moves.
    pub stage: Option<String>,
    #[serde(default, deserialize_with = "nullable")]
    #[schema(value_type = Option<String>)]
    pub assignee: Option<Option<String>>,
    pub priority: Option<Priority>,
    /// Replaces every label; `[]` removes them all.
    pub labels: Option<Vec<String>>,
    /// Labels to add, keeping the rest.
    pub add_labels: Option<Vec<String>>,
    /// Labels to remove, keeping the rest.
    pub remove_labels: Option<Vec<String>>,
    #[serde(default, deserialize_with = "nullable")]
    #[schema(value_type = Option<u32>)]
    pub estimate: Option<Option<u32>>,
    #[serde(default, deserialize_with = "nullable")]
    #[schema(value_type = Option<DateTime<Utc>>)]
    pub deadline: Option<Option<DateTime<Utc>>>,
    #[serde(default, deserialize_with = "nullable")]
    #[schema(value_type = Option<String>)]
    pub project: Option<Option<String>>,
    #[serde(default, deserialize_with = "nullable")]
    #[schema(value_type = Option<String>)]
    pub milestone: Option<Option<String>>,
    #[serde(default, deserialize_with = "nullable")]
    #[schema(value_type = Option<String>)]
    pub sprint: Option<Option<String>>,
    #[serde(default, deserialize_with = "nullable")]
    #[schema(value_type = Option<String>)]
    pub parent: Option<Option<String>>,
    /// Replaces the issues this one depends on.
    pub dependencies: Option<Vec<String>>,
}

/// Splits a merge-patch field into the command's value and clear flag.
fn split<T>(field: Option<Option<T>>) -> (Option<T>, bool) {
    match field {
        None => (None, false),
        Some(None) => (None, true),
        Some(value) => (value, false),
    }
}

impl UpdateIssue {
    fn is_empty(&self) -> bool {
        self.title.is_none()
            && self.description.is_none()
            && self.team.is_none()
            && self.stage.is_none()
            && self.assignee.is_none()
            && self.priority.is_none()
            && self.labels.is_none()
            && self.add_labels.is_none()
            && self.remove_labels.is_none()
            && self.estimate.is_none()
            && self.deadline.is_none()
            && self.project.is_none()
            && self.milestone.is_none()
            && self.sprint.is_none()
            && self.parent.is_none()
            && self.dependencies.is_none()
    }

    async fn into_patch(self, store: &Store, scope: Scope, current: &Issue) -> Result<IssuePatch> {
        let dir = Directory::load(store, scope).await?;
        let team_id = self.team.map(|t| dir.find_team(&t)).transpose()?;
        let team = team_id.unwrap_or(current.team_id);
        let labels = match (self.labels, self.add_labels, self.remove_labels) {
            (Some(_), Some(_), _) | (Some(_), _, Some(_)) => {
                return Err(Error::BadRequest(
                    "send labels, or add_labels and remove_labels, not both".into(),
                ));
            }
            (Some(labels), None, None) => Some(label_ids(&dir, &labels)?),
            (None, None, None) => None,
            (None, add, remove) => {
                let add = label_ids(&dir, &add.unwrap_or_default())?;
                let remove = label_ids(&dir, &remove.unwrap_or_default())?;
                let mut labels: Vec<Uuid> = current
                    .labels
                    .iter()
                    .copied()
                    .filter(|id| !remove.contains(id))
                    .collect();
                labels.extend(add.into_iter().filter(|id| !remove.contains(id)));
                labels.dedup();
                Some(labels)
            }
        };
        let resolve_with = |field: Option<Option<String>>, find: &dyn Fn(&str) -> Result<Uuid>| {
            field
                .map(|value| value.map(|r| find(&r)).transpose())
                .transpose()
        };
        let project = resolve_with(self.project, &|r| dir.find_project(r))?;
        let milestone_project = match project {
            Some(chosen) => chosen,
            None => current.project_id,
        };
        let milestone = resolve_with(self.milestone, &|r| {
            dir.find_milestone(milestone_project, r)
        })?;
        let sprint = resolve_with(self.sprint, &|r| dir.find_sprint(team, r))?;
        let assignee = resolve_with(self.assignee, &|r| dir.find_person(r))?;
        let parent = match self.parent {
            Some(Some(parent)) => Some(Some(resolve(store, scope, &parent).await?)),
            Some(None) => Some(None),
            None => None,
        };
        let dependencies = match self.dependencies {
            Some(references) => Some(issue_ids(store, scope, &references).await?),
            None => None,
        };

        let (assignee, clear_assignee) = split(assignee);
        let (estimate, clear_estimate) = split(self.estimate);
        let (deadline, clear_deadline) = split(self.deadline);
        let (project_id, clear_project) = split(project);
        let (milestone_id, clear_milestone) = split(milestone);
        let (sprint_id, clear_sprint) = split(sprint);
        let (parent_id, clear_parent) = split(parent);
        Ok(IssuePatch {
            title: self.title,
            description: self.description,
            team_id,
            stage_id: self.stage.map(|s| dir.find_stage(team, &s)).transpose()?,
            assignee,
            clear_assignee,
            priority: self.priority,
            labels,
            estimate,
            clear_estimate,
            deadline,
            clear_deadline,
            project_id,
            clear_project,
            milestone_id,
            clear_milestone,
            sprint_id,
            clear_sprint,
            parent_id,
            clear_parent,
            dependencies,
        })
    }
}

pub async fn update_issue(
    store: &Store,
    scope: Scope,
    id: Uuid,
    update: UpdateIssue,
    options: WriteOptions,
) -> Result<ApiIssue> {
    // An empty patch changes nothing, so it records no activity either.
    if !update.is_empty() {
        let current = store.get_issue(scope.workspace, scope.user, id).await?;
        let patch = update.into_patch(store, scope, &current).await?;
        run(
            store,
            scope,
            Command::UpdateIssue { id, patch },
            Some(id),
            options,
        )
        .await?;
    }
    fetch(store, scope, id).await
}

#[utoipa::path(
    patch,
    path = "/api/v1/workspaces/{workspace}/issues/{issue}",
    tag = "issues",
    params(("workspace" = Uuid, Path), ("issue" = String, Path, description = "UUID or key such as ENG-42")),
    request_body = UpdateIssue,
    responses((status = 200, body = ApiIssue), (status = 412, body = crate::error::ErrorBody))
)]
pub async fn update(
    State(store): State<Store>,
    actor: ApiActor,
    Path((workspace, issue)): Path<(Uuid, String)>,
    options: WriteOptions,
    Json(update): Json<UpdateIssue>,
) -> Result<Response> {
    let scope = actor.write(workspace)?;
    let id = resolve(&store, scope, &issue).await?;
    let issue = update_issue(&store, scope, id, update, options).await?;
    Ok(one(StatusCode::OK, issue))
}

/// Runs a lifecycle command on an issue: trash, restore, archive or unarchive.
pub async fn transition_issue(
    store: &Store,
    scope: Scope,
    id: Uuid,
    command: Command,
    options: WriteOptions,
) -> Result<()> {
    run(store, scope, command, Some(id), options).await?;
    Ok(())
}

#[utoipa::path(
    delete,
    path = "/api/v1/workspaces/{workspace}/issues/{issue}",
    tag = "issues",
    description = "Moves the issue to the trash. Restore it with POST .../restore.",
    params(("workspace" = Uuid, Path), ("issue" = String, Path, description = "UUID or key such as ENG-42")),
    responses((status = 204))
)]
pub async fn delete(
    State(store): State<Store>,
    actor: ApiActor,
    Path((workspace, issue)): Path<(Uuid, String)>,
    options: WriteOptions,
) -> Result<StatusCode> {
    let scope = actor.write(workspace)?;
    let id = resolve(&store, scope, &issue).await?;
    transition_issue(&store, scope, id, Command::DeleteIssue { id }, options).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn transition(
    store: &Store,
    actor: &ApiActor,
    workspace: Uuid,
    issue: &str,
    options: WriteOptions,
    command: fn(Uuid) -> Command,
) -> Result<Response> {
    let scope = actor.write(workspace)?;
    let id = resolve(store, scope, issue).await?;
    transition_issue(store, scope, id, command(id), options).await?;
    Ok(one(StatusCode::OK, fetch(store, scope, id).await?))
}

#[utoipa::path(
    post,
    path = "/api/v1/workspaces/{workspace}/issues/{issue}/restore",
    tag = "issues",
    params(("workspace" = Uuid, Path), ("issue" = String, Path, description = "UUID or key such as ENG-42")),
    responses((status = 200, body = ApiIssue))
)]
pub async fn restore(
    State(store): State<Store>,
    actor: ApiActor,
    Path((workspace, issue)): Path<(Uuid, String)>,
    options: WriteOptions,
) -> Result<Response> {
    transition(&store, &actor, workspace, &issue, options, |id| {
        Command::RestoreIssue { id }
    })
    .await
}

#[utoipa::path(
    post,
    path = "/api/v1/workspaces/{workspace}/issues/{issue}/archive",
    tag = "issues",
    description = "Archives an issue in a Done stage.",
    params(("workspace" = Uuid, Path), ("issue" = String, Path, description = "UUID or key such as ENG-42")),
    responses((status = 200, body = ApiIssue))
)]
pub async fn archive(
    State(store): State<Store>,
    actor: ApiActor,
    Path((workspace, issue)): Path<(Uuid, String)>,
    options: WriteOptions,
) -> Result<Response> {
    transition(&store, &actor, workspace, &issue, options, |id| {
        Command::ArchiveIssue { id }
    })
    .await
}

#[utoipa::path(
    post,
    path = "/api/v1/workspaces/{workspace}/issues/{issue}/unarchive",
    tag = "issues",
    params(("workspace" = Uuid, Path), ("issue" = String, Path, description = "UUID or key such as ENG-42")),
    responses((status = 200, body = ApiIssue))
)]
pub async fn unarchive(
    State(store): State<Store>,
    actor: ApiActor,
    Path((workspace, issue)): Path<(Uuid, String)>,
    options: WriteOptions,
) -> Result<Response> {
    transition(&store, &actor, workspace, &issue, options, |id| {
        Command::UnarchiveIssue { id }
    })
    .await
}

/// A comment with its author and mentions named.
#[derive(Serialize, utoipa::ToSchema)]
pub struct ApiComment {
    pub id: Uuid,
    pub issue_id: Uuid,
    pub author: Person,
    /// The token that wrote the comment for its author, if one did.
    pub via: Option<Via>,
    /// Markdown.
    pub body: String,
    pub mentions: Vec<Person>,
    pub attachments: Vec<Attachment>,
    pub created_at: DateTime<Utc>,
    pub edited_at: Option<DateTime<Utc>>,
    /// The issue tracker comment this one was sent to or imported from, if any.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tracker: Option<CommentTracker>,
    pub version: i64,
}

impl Versioned for ApiComment {
    fn version(&self) -> i64 {
        self.version
    }
}

async fn render_comments(
    store: &Store,
    scope: Scope,
    comments: Vec<Comment>,
) -> Result<Vec<ApiComment>> {
    let mut dir = Directory::people(store, scope).await?;
    dir.include_people(
        store,
        comments
            .iter()
            .flat_map(|c| std::iter::once(c.author).chain(c.mentions.iter().copied())),
    )
    .await?;
    Ok(comments
        .into_iter()
        .map(|c| ApiComment {
            id: c.id,
            issue_id: c.issue_id,
            author: dir.person(c.author),
            via: c.via,
            body: c.body,
            mentions: c.mentions.iter().map(|id| dir.person(*id)).collect(),
            attachments: c.attachments,
            created_at: c.created_at,
            edited_at: c.edited_at,
            tracker: c.tracker,
            version: c.version,
        })
        .collect())
}

pub async fn fetch_comment(store: &Store, scope: Scope, id: Uuid) -> Result<ApiComment> {
    let comment: Comment = record(store, scope, "comments", id).await?;
    render_comments(store, scope, vec![comment])
        .await?
        .pop()
        .ok_or(Error::NotFound)
}

/// Oldest first.
pub async fn issue_comments(
    store: &Store,
    scope: Scope,
    issue: Uuid,
    params: &PageParams,
) -> Result<Page<ApiComment>> {
    // Comments of a missing or trashed issue are not listed.
    store.get_issue(scope.workspace, scope.user, issue).await?;
    let page: Page<Comment> =
        list_collection(store, scope, "comments", params, Some(issue)).await?;
    Ok(Page {
        data: render_comments(store, scope, page.data).await?,
        next_cursor: page.next_cursor,
        total: None,
    })
}

#[utoipa::path(
    get,
    path = "/api/v1/workspaces/{workspace}/issues/{issue}/comments",
    tag = "comments",
    description = "Oldest first.",
    params(("workspace" = Uuid, Path), ("issue" = String, Path, description = "UUID or key such as ENG-42"), PageParams),
    responses((status = 200, body = Page<ApiComment>))
)]
pub async fn comments(
    State(store): State<Store>,
    actor: ApiActor,
    Path((workspace, issue)): Path<(Uuid, String)>,
    Query(params): Query<PageParams>,
) -> Result<Json<Page<ApiComment>>> {
    let scope = actor.read(workspace)?;
    let id = resolve(&store, scope, &issue).await?;
    Ok(Json(issue_comments(&store, scope, id, &params).await?))
}

#[utoipa::path(
    get,
    path = "/api/v1/workspaces/{workspace}/comments/{comment}",
    tag = "comments",
    params(("workspace" = Uuid, Path), ("comment" = Uuid, Path)),
    responses((status = 200, body = ApiComment))
)]
pub async fn comment(
    State(store): State<Store>,
    actor: ApiActor,
    Path((workspace, comment)): Path<(Uuid, Uuid)>,
) -> Result<Response> {
    let comment = fetch_comment(&store, actor.read(workspace)?, comment).await?;
    Ok(one(StatusCode::OK, comment))
}

#[derive(Clone, Debug, Deserialize, Serialize, utoipa::ToSchema)]
#[serde(deny_unknown_fields)]
pub struct CreateComment {
    /// Markdown.
    pub body: String,
    /// Users to notify as mentioned: UUIDs, emails or display names.
    #[serde(default)]
    pub mentions: Vec<String>,
}

async fn mention_ids(store: &Store, scope: Scope, references: &[String]) -> Result<Vec<Uuid>> {
    if references.is_empty() {
        return Ok(vec![]);
    }
    let dir = Directory::people(store, scope).await?;
    references.iter().map(|r| dir.find_person(r)).collect()
}

pub async fn add_comment(
    store: &Store,
    scope: Scope,
    issue: Uuid,
    body: CreateComment,
    options: WriteOptions,
) -> Result<ApiComment> {
    let mentions = mention_ids(store, scope, &body.mentions).await?;
    let result = run(
        store,
        scope,
        Command::AddComment {
            id: None,
            issue_id: issue,
            body: body.body,
            mentions,
            attachments: vec![],
        },
        None,
        options,
    )
    .await?;
    fetch_comment(store, scope, created_id(&result)?).await
}

#[utoipa::path(
    post,
    path = "/api/v1/workspaces/{workspace}/issues/{issue}/comments",
    tag = "comments",
    params(("workspace" = Uuid, Path), ("issue" = String, Path, description = "UUID or key such as ENG-42")),
    request_body = CreateComment,
    responses((status = 201, body = ApiComment))
)]
pub async fn create_comment(
    State(store): State<Store>,
    actor: ApiActor,
    Path((workspace, issue)): Path<(Uuid, String)>,
    options: WriteOptions,
    Json(body): Json<CreateComment>,
) -> Result<Response> {
    let scope = actor.comment(workspace)?;
    let id = resolve(&store, scope, &issue).await?;
    let comment = add_comment(&store, scope, id, body, options).await?;
    Ok(one(StatusCode::CREATED, comment))
}

#[derive(Clone, Debug, Deserialize, Serialize, utoipa::ToSchema)]
#[serde(deny_unknown_fields)]
pub struct UpdateComment {
    pub body: String,
    /// Replaces the mentioned users. Omit to keep them.
    pub mentions: Option<Vec<String>>,
}

pub async fn edit_comment(
    store: &Store,
    scope: Scope,
    comment: Uuid,
    body: UpdateComment,
    options: WriteOptions,
) -> Result<ApiComment> {
    let mentions = match body.mentions {
        Some(mentions) => mention_ids(store, scope, &mentions).await?,
        None => {
            record::<Comment>(store, scope, "comments", comment)
                .await?
                .mentions
        }
    };
    run(
        store,
        scope,
        Command::EditComment {
            id: comment,
            body: body.body,
            mentions,
        },
        Some(comment),
        options,
    )
    .await?;
    fetch_comment(store, scope, comment).await
}

#[utoipa::path(
    patch,
    path = "/api/v1/workspaces/{workspace}/comments/{comment}",
    tag = "comments",
    description = "Authors may edit their comments; administrators may edit any.",
    params(("workspace" = Uuid, Path), ("comment" = Uuid, Path)),
    request_body = UpdateComment,
    responses((status = 200, body = ApiComment), (status = 412, body = crate::error::ErrorBody))
)]
pub async fn update_comment(
    State(store): State<Store>,
    actor: ApiActor,
    Path((workspace, comment)): Path<(Uuid, Uuid)>,
    options: WriteOptions,
    Json(body): Json<UpdateComment>,
) -> Result<Response> {
    let comment = edit_comment(&store, actor.comment(workspace)?, comment, body, options).await?;
    Ok(one(StatusCode::OK, comment))
}

pub async fn remove_comment(
    store: &Store,
    scope: Scope,
    comment: Uuid,
    options: WriteOptions,
) -> Result<()> {
    run(
        store,
        scope,
        Command::DeleteComment { id: comment },
        Some(comment),
        options,
    )
    .await?;
    Ok(())
}

#[utoipa::path(
    delete,
    path = "/api/v1/workspaces/{workspace}/comments/{comment}",
    tag = "comments",
    params(("workspace" = Uuid, Path), ("comment" = Uuid, Path)),
    responses((status = 204))
)]
pub async fn delete_comment(
    State(store): State<Store>,
    actor: ApiActor,
    Path((workspace, comment)): Path<(Uuid, Uuid)>,
    options: WriteOptions,
) -> Result<StatusCode> {
    remove_comment(&store, actor.comment(workspace)?, comment, options).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// One entry of an issue's history.
#[derive(Serialize, utoipa::ToSchema)]
pub struct ApiActivity {
    pub id: Uuid,
    pub actor: Person,
    /// The token that acted for `actor`, if one did.
    pub via: Option<Via>,
    /// What happened, such as `create_issue`, `update_issue`, `add_comment` or `issue_completed`.
    pub action: String,
    /// Fields an `update_issue` changed.
    pub fields: Vec<String>,
    pub at: DateTime<Utc>,
}

/// Newest first.
pub async fn issue_activity(
    store: &Store,
    scope: Scope,
    issue: Uuid,
    params: &PageParams,
) -> Result<Page<ApiActivity>> {
    store.get_issue(scope.workspace, scope.user, issue).await?;
    let page: Page<Activity> = page_of(
        store
            .collection(
                scope.workspace,
                scope.user,
                "activity",
                CollectionQuery {
                    limit: params.limit()?,
                    offset: params.offset()?,
                    issue_id: None,
                    entity_id: Some(issue),
                },
            )
            .await?,
    )?;
    let mut dir = Directory::people(store, scope).await?;
    dir.include_people(store, page.data.iter().map(|a| a.actor))
        .await?;
    Ok(Page {
        data: page
            .data
            .into_iter()
            .map(|a| ApiActivity {
                id: a.id,
                actor: dir.person(a.actor),
                via: a.via,
                action: a.action,
                fields: a.fields,
                at: a.at,
            })
            .collect(),
        next_cursor: page.next_cursor,
        total: None,
    })
}

#[utoipa::path(
    get,
    path = "/api/v1/workspaces/{workspace}/issues/{issue}/activity",
    tag = "issues",
    description = "The issue's history, newest first, with the token behind each change.",
    params(("workspace" = Uuid, Path), ("issue" = String, Path, description = "UUID or key such as ENG-42"), PageParams),
    responses((status = 200, body = Page<ApiActivity>))
)]
pub async fn activity(
    State(store): State<Store>,
    actor: ApiActor,
    Path((workspace, issue)): Path<(Uuid, String)>,
    Query(params): Query<PageParams>,
) -> Result<Json<Page<ApiActivity>>> {
    let scope = actor.read(workspace)?;
    let id = resolve(&store, scope, &issue).await?;
    Ok(Json(issue_activity(&store, scope, id, &params).await?))
}

#[utoipa::path(
    get,
    path = "/api/v1/workspaces/{workspace}/attachments/{attachment}",
    tag = "issues",
    params(("workspace" = Uuid, Path), ("attachment" = Uuid, Path)),
    responses((status = 200, description = "The attachment's bytes"))
)]
pub async fn attachment(
    State(store): State<Store>,
    actor: ApiActor,
    Path((workspace, attachment)): Path<(Uuid, Uuid)>,
) -> Result<Response> {
    let scope = actor.read(workspace)?;
    crate::http::attachment_response(&store, scope.workspace, scope.user, attachment).await
}
