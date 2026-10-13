use super::resources::{Versioned, list_collection, one, record};
use super::*;
use crate::domain::{
    Comment, FilterClause, Issue, IssueFilter, IssueInput, IssuePatch, IssueSort, Priority,
    deserialize_where,
};
use axum::extract::{Path, Query};
use chrono::{DateTime, Utc};

/// Issue keys are the workspace-wide number behind this prefix, as the app shows them.
pub const ISSUE_KEY_PREFIX: &str = "BW-";

#[derive(Serialize, utoipa::ToSchema)]
pub struct ApiIssue {
    /// Human-readable key such as `BW-42`. Accepted wherever an issue id is.
    pub key: String,
    #[serde(flatten)]
    pub issue: Issue,
}

impl From<Issue> for ApiIssue {
    fn from(issue: Issue) -> Self {
        Self {
            key: format!("{ISSUE_KEY_PREFIX}{}", issue.number),
            issue,
        }
    }
}

impl Versioned for ApiIssue {
    fn version(&self) -> i64 {
        self.issue.version
    }
}

/// An issue's UUID, from a UUID, a key such as `BW-42`, or a bare number.
pub async fn resolve(store: &Store, scope: Scope, reference: &str) -> Result<Uuid> {
    if let Ok(id) = Uuid::parse_str(reference) {
        return Ok(id);
    }
    let digits = reference
        .get(..ISSUE_KEY_PREFIX.len())
        .filter(|prefix| prefix.eq_ignore_ascii_case(ISSUE_KEY_PREFIX))
        .map_or(reference, |_| &reference[ISSUE_KEY_PREFIX.len()..]);
    let number = digits
        .parse::<i64>()
        .ok()
        .filter(|n| *n > 0)
        .ok_or_else(|| {
            Error::BadRequest(format!(
                "issue must be a UUID or a key such as {ISSUE_KEY_PREFIX}42"
            ))
        })?;
    store
        .issue_by_number(scope.workspace, scope.user, number)
        .await
}

pub async fn fetch(store: &Store, scope: Scope, id: Uuid) -> Result<ApiIssue> {
    Ok(store
        .get_issue(scope.workspace, scope.user, id)
        .await?
        .into())
}

#[derive(Default, Deserialize, utoipa::IntoParams)]
#[into_params(parameter_in = Query)]
pub struct IssueQuery {
    /// Filter clauses ANDed together, as a JSON array; see docs/filters.md.
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

pub async fn search(store: &Store, scope: Scope, query: IssueQuery) -> Result<Page<ApiIssue>> {
    let params = PageParams {
        limit: query.limit,
        cursor: query.cursor,
    };
    let (offset, after) = match Cursor::decode(params.cursor.as_deref())? {
        Cursor::Offset(offset) => (offset, None),
        Cursor::After(after) => (0, Some(after)),
    };
    let value = store
        .list_issues(
            scope.workspace,
            scope.user,
            IssueFilter {
                clauses: query.clauses,
                search: query.search,
                archived: query.archived,
                trash: query.trash,
                sort: query.sort,
                after,
                ..Default::default()
            },
            params.limit()?,
            offset,
        )
        .await?;
    // Updated-order lists page by keyset, which stays stable under concurrent edits.
    let next_cursor = match (value["next_cursor"].as_str(), value["next_offset"].as_i64()) {
        (Some(after), _) => Some(Cursor::After(after.into()).encode()),
        (None, Some(offset)) => Some(Cursor::Offset(offset).encode()),
        (None, None) => None,
    };
    let issues: Vec<Issue> = serde_json::from_value(value["items"].clone())?;
    Ok(Page {
        data: issues.into_iter().map(ApiIssue::from).collect(),
        next_cursor,
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
    params(("workspace" = Uuid, Path), ("issue" = String, Path, description = "UUID or key such as BW-42")),
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

pub async fn create_issue(
    store: &Store,
    scope: Scope,
    input: IssueInput,
    options: WriteOptions,
) -> Result<ApiIssue> {
    let result = run(store, scope, Command::CreateIssue { input }, None, options).await?;
    fetch(store, scope, created_id(&result)?).await
}

#[utoipa::path(
    post,
    path = "/api/v1/workspaces/{workspace}/issues",
    tag = "issues",
    params(("workspace" = Uuid, Path)),
    request_body = IssueInput,
    responses((status = 201, body = ApiIssue))
)]
pub async fn create(
    State(store): State<Store>,
    actor: ApiActor,
    Path(workspace): Path<Uuid>,
    options: WriteOptions,
    Json(input): Json<IssueInput>,
) -> Result<Response> {
    let issue = create_issue(&store, actor.write(workspace)?, input, options).await?;
    Ok(one(StatusCode::CREATED, issue))
}

/// Present as `Some(None)` when the JSON says `null`, so `null` can clear a field.
fn nullable<'de, D, T>(deserializer: D) -> std::result::Result<Option<Option<T>>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer).map(Some)
}

/// Merge-patch: omitted fields stay, `null` clears a nullable field.
#[derive(Default, Deserialize, utoipa::ToSchema)]
#[serde(deny_unknown_fields)]
pub struct UpdateIssue {
    pub title: Option<String>,
    pub description: Option<String>,
    pub stage_id: Option<Uuid>,
    #[serde(default, deserialize_with = "nullable")]
    #[schema(value_type = Option<Uuid>)]
    pub assignee: Option<Option<Uuid>>,
    pub priority: Option<Priority>,
    pub labels: Option<Vec<Uuid>>,
    #[serde(default, deserialize_with = "nullable")]
    #[schema(value_type = Option<u32>)]
    pub estimate: Option<Option<u32>>,
    #[serde(default, deserialize_with = "nullable")]
    #[schema(value_type = Option<DateTime<Utc>>)]
    pub deadline: Option<Option<DateTime<Utc>>>,
    #[serde(default, deserialize_with = "nullable")]
    #[schema(value_type = Option<Uuid>)]
    pub project_id: Option<Option<Uuid>>,
    #[serde(default, deserialize_with = "nullable")]
    #[schema(value_type = Option<Uuid>)]
    pub milestone_id: Option<Option<Uuid>>,
    #[serde(default, deserialize_with = "nullable")]
    #[schema(value_type = Option<Uuid>)]
    pub sprint_id: Option<Option<Uuid>>,
    #[serde(default, deserialize_with = "nullable")]
    #[schema(value_type = Option<Uuid>)]
    pub parent_id: Option<Option<Uuid>>,
    pub dependencies: Option<Vec<Uuid>>,
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
            && self.stage_id.is_none()
            && self.assignee.is_none()
            && self.priority.is_none()
            && self.labels.is_none()
            && self.estimate.is_none()
            && self.deadline.is_none()
            && self.project_id.is_none()
            && self.milestone_id.is_none()
            && self.sprint_id.is_none()
            && self.parent_id.is_none()
            && self.dependencies.is_none()
    }

    fn into_patch(self) -> IssuePatch {
        let (assignee, clear_assignee) = split(self.assignee);
        let (estimate, clear_estimate) = split(self.estimate);
        let (deadline, clear_deadline) = split(self.deadline);
        let (project_id, clear_project) = split(self.project_id);
        let (milestone_id, clear_milestone) = split(self.milestone_id);
        let (sprint_id, clear_sprint) = split(self.sprint_id);
        let (parent_id, clear_parent) = split(self.parent_id);
        IssuePatch {
            title: self.title,
            description: self.description,
            stage_id: self.stage_id,
            assignee,
            clear_assignee,
            priority: self.priority,
            labels: self.labels,
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
            dependencies: self.dependencies,
        }
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
        let patch = update.into_patch();
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
    params(("workspace" = Uuid, Path), ("issue" = String, Path, description = "UUID or key such as BW-42")),
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

#[utoipa::path(
    delete,
    path = "/api/v1/workspaces/{workspace}/issues/{issue}",
    tag = "issues",
    description = "Moves the issue to the trash. Restore it with POST .../restore.",
    params(("workspace" = Uuid, Path), ("issue" = String, Path, description = "UUID or key such as BW-42")),
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
    run(
        &store,
        scope,
        Command::DeleteIssue { id },
        Some(id),
        options,
    )
    .await?;
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
    run(store, scope, command(id), Some(id), options).await?;
    Ok(one(StatusCode::OK, fetch(store, scope, id).await?))
}

#[utoipa::path(
    post,
    path = "/api/v1/workspaces/{workspace}/issues/{issue}/restore",
    tag = "issues",
    params(("workspace" = Uuid, Path), ("issue" = String, Path, description = "UUID or key such as BW-42")),
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
    params(("workspace" = Uuid, Path), ("issue" = String, Path, description = "UUID or key such as BW-42")),
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
    params(("workspace" = Uuid, Path), ("issue" = String, Path, description = "UUID or key such as BW-42")),
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

pub async fn issue_comments(
    store: &Store,
    scope: Scope,
    issue: Uuid,
    params: &PageParams,
) -> Result<Page<Comment>> {
    // Comments of a missing or trashed issue are not listed.
    store.get_issue(scope.workspace, scope.user, issue).await?;
    list_collection(store, scope, "comments", params, Some(issue)).await
}

#[utoipa::path(
    get,
    path = "/api/v1/workspaces/{workspace}/issues/{issue}/comments",
    tag = "comments",
    params(("workspace" = Uuid, Path), ("issue" = String, Path, description = "UUID or key such as BW-42"), PageParams),
    responses((status = 200, body = Page<Comment>))
)]
pub async fn comments(
    State(store): State<Store>,
    actor: ApiActor,
    Path((workspace, issue)): Path<(Uuid, String)>,
    Query(params): Query<PageParams>,
) -> Result<Json<Page<Comment>>> {
    let scope = actor.read(workspace)?;
    let id = resolve(&store, scope, &issue).await?;
    Ok(Json(issue_comments(&store, scope, id, &params).await?))
}

#[utoipa::path(
    get,
    path = "/api/v1/workspaces/{workspace}/comments/{comment}",
    tag = "comments",
    params(("workspace" = Uuid, Path), ("comment" = Uuid, Path)),
    responses((status = 200, body = Comment))
)]
pub async fn comment(
    State(store): State<Store>,
    actor: ApiActor,
    Path((workspace, comment)): Path<(Uuid, Uuid)>,
) -> Result<Response> {
    let comment: Comment = record(&store, actor.read(workspace)?, "comments", comment).await?;
    Ok(one(StatusCode::OK, comment))
}

#[derive(Deserialize, utoipa::ToSchema)]
pub struct CreateComment {
    /// Markdown.
    pub body: String,
    /// Users to notify as mentioned.
    #[serde(default)]
    pub mentions: Vec<Uuid>,
}

pub async fn add_comment(
    store: &Store,
    scope: Scope,
    issue: Uuid,
    body: CreateComment,
    options: WriteOptions,
) -> Result<Comment> {
    let result = run(
        store,
        scope,
        Command::AddComment {
            id: None,
            issue_id: issue,
            body: body.body,
            mentions: body.mentions,
            attachments: vec![],
        },
        None,
        options,
    )
    .await?;
    record(store, scope, "comments", created_id(&result)?).await
}

#[utoipa::path(
    post,
    path = "/api/v1/workspaces/{workspace}/issues/{issue}/comments",
    tag = "comments",
    params(("workspace" = Uuid, Path), ("issue" = String, Path, description = "UUID or key such as BW-42")),
    request_body = CreateComment,
    responses((status = 201, body = Comment))
)]
pub async fn create_comment(
    State(store): State<Store>,
    actor: ApiActor,
    Path((workspace, issue)): Path<(Uuid, String)>,
    options: WriteOptions,
    Json(body): Json<CreateComment>,
) -> Result<Response> {
    let scope = actor.write(workspace)?;
    let id = resolve(&store, scope, &issue).await?;
    let comment = add_comment(&store, scope, id, body, options).await?;
    Ok(one(StatusCode::CREATED, comment))
}

#[derive(Deserialize, utoipa::ToSchema)]
pub struct UpdateComment {
    pub body: String,
    /// Replaces the mentioned users. Omit to keep them.
    pub mentions: Option<Vec<Uuid>>,
}

#[utoipa::path(
    patch,
    path = "/api/v1/workspaces/{workspace}/comments/{comment}",
    tag = "comments",
    description = "Authors may edit their comments; administrators may edit any.",
    params(("workspace" = Uuid, Path), ("comment" = Uuid, Path)),
    request_body = UpdateComment,
    responses((status = 200, body = Comment), (status = 412, body = crate::error::ErrorBody))
)]
pub async fn update_comment(
    State(store): State<Store>,
    actor: ApiActor,
    Path((workspace, comment)): Path<(Uuid, Uuid)>,
    options: WriteOptions,
    Json(body): Json<UpdateComment>,
) -> Result<Response> {
    let scope = actor.write(workspace)?;
    let mentions = match body.mentions {
        Some(mentions) => mentions,
        None => {
            record::<Comment>(&store, scope, "comments", comment)
                .await?
                .mentions
        }
    };
    run(
        &store,
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
    let comment: Comment = record(&store, scope, "comments", comment).await?;
    Ok(one(StatusCode::OK, comment))
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
    run(
        &store,
        actor.write(workspace)?,
        Command::DeleteComment { id: comment },
        Some(comment),
        options,
    )
    .await?;
    Ok(StatusCode::NO_CONTENT)
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
