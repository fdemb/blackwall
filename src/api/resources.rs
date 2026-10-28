use super::*;
use crate::{
    domain::{
        Comment, Label, Milestone, Project, ProjectHealth, ProjectStatus, Role, Sprint, Stage,
        StageKind, Team,
    },
    http::MemberProfile,
    store::CollectionQuery,
};
use axum::extract::{Path, Query};
use chrono::NaiveDate;

/// Records whose version is their ETag.
pub trait Versioned {
    fn version(&self) -> i64;
}

macro_rules! versioned {
    ($($ty:ty),*) => {
        $(impl Versioned for $ty {
            fn version(&self) -> i64 {
                self.version
            }
        })*
    };
}

versioned!(Team, Stage, Label, Project, Comment, Milestone, Sprint);

pub fn one<T: Serialize + Versioned>(status: StatusCode, record: T) -> Response {
    tagged(status, record.version(), record)
}

pub async fn list_collection<T: serde::de::DeserializeOwned>(
    store: &Store,
    scope: Scope,
    kind: &str,
    params: &PageParams,
    issue_id: Option<Uuid>,
) -> Result<Page<T>> {
    page_of(
        store
            .collection(
                scope.workspace,
                scope.user,
                kind,
                CollectionQuery {
                    limit: params.limit()?,
                    offset: params.offset()?,
                    issue_id,
                    entity_id: None,
                },
            )
            .await?,
    )
}

pub async fn record<T: serde::de::DeserializeOwned>(
    store: &Store,
    scope: Scope,
    kind: &str,
    id: Uuid,
) -> Result<T> {
    Ok(serde_json::from_value(
        store
            .collection_record(scope.workspace, scope.user, kind, id)
            .await?,
    )?)
}

#[derive(Serialize, utoipa::ToSchema)]
pub struct ApiMe {
    pub id: Uuid,
    pub email: String,
    pub display_name: String,
    pub token: TokenInfo,
}

#[derive(Serialize, utoipa::ToSchema)]
pub struct TokenInfo {
    pub id: Uuid,
    pub access: Access,
    /// Null allows every workspace the user belongs to.
    pub workspace_ids: Option<Vec<Uuid>>,
}

#[utoipa::path(
    get,
    path = "/api/v1/me",
    tag = "workspaces",
    responses((status = 200, body = ApiMe))
)]
pub async fn me(State(store): State<Store>, actor: ApiActor) -> Result<Json<ApiMe>> {
    let profile = store.profile(actor.user()).await?;
    Ok(Json(ApiMe {
        id: profile.id,
        email: profile.email,
        display_name: profile.display_name,
        token: TokenInfo {
            id: actor.0.token_id,
            access: actor.0.access,
            workspace_ids: actor.0.workspaces,
        },
    }))
}

#[derive(Serialize, utoipa::ToSchema)]
pub struct ApiWorkspace {
    pub id: Uuid,
    pub name: String,
    /// Names the workspace in app URLs.
    pub slug: String,
    /// The token user's role, which bounds what the token can do.
    pub role: Role,
}

async fn workspace_rows(
    store: &Store,
    actor: &ApiActor,
    only: Option<Uuid>,
) -> Result<Vec<ApiWorkspace>> {
    sqlx::query!(
        "SELECT w.id,w.name,w.slug,m.role FROM workspaces w \
         JOIN workspace_members m ON m.workspace_id=w.id \
         WHERE m.user_id=$1 AND ($2::uuid[] IS NULL OR w.id=ANY($2)) AND ($3::uuid IS NULL OR w.id=$3) \
         ORDER BY w.name,w.id",
        actor.user(),
        actor.0.workspaces.as_deref(),
        only,
    )
    .fetch_all(&store.pool)
    .await?
    .into_iter()
    .map(|row| {
        Ok(ApiWorkspace {
            id: row.id,
            name: row.name,
            slug: row.slug,
            role: serde_json::from_value(serde_json::Value::String(row.role))?,
        })
    })
    .collect()
}

/// Workspaces the token can reach.
pub async fn workspace_list(store: &Store, actor: &ApiActor) -> Result<Vec<ApiWorkspace>> {
    workspace_rows(store, actor, None).await
}

#[utoipa::path(
    get,
    path = "/api/v1/workspaces",
    tag = "workspaces",
    responses((status = 200, body = Page<ApiWorkspace>))
)]
pub async fn workspaces(
    State(store): State<Store>,
    actor: ApiActor,
) -> Result<Json<Page<ApiWorkspace>>> {
    Ok(Json(Page {
        data: workspace_list(&store, &actor).await?,
        next_cursor: None,
        total: None,
    }))
}

#[utoipa::path(
    get,
    path = "/api/v1/workspaces/{workspace}",
    tag = "workspaces",
    params(("workspace" = Uuid, Path)),
    responses((status = 200, body = ApiWorkspace))
)]
pub async fn workspace(
    State(store): State<Store>,
    actor: ApiActor,
    Path(workspace): Path<Uuid>,
) -> Result<Json<ApiWorkspace>> {
    actor.read(workspace)?;
    workspace_rows(&store, &actor, Some(workspace))
        .await?
        .pop()
        .map(Json)
        .ok_or(Error::Forbidden)
}

pub async fn member_list(store: &Store, scope: Scope) -> Result<Vec<MemberProfile>> {
    Ok(serde_json::from_value(
        store
            .member_profiles(scope.workspace, scope.user, None)
            .await?,
    )?)
}

#[utoipa::path(
    get,
    path = "/api/v1/workspaces/{workspace}/members",
    tag = "workspaces",
    params(("workspace" = Uuid, Path)),
    responses((status = 200, body = Page<MemberProfile>))
)]
pub async fn members(
    State(store): State<Store>,
    actor: ApiActor,
    Path(workspace): Path<Uuid>,
) -> Result<Json<Page<MemberProfile>>> {
    Ok(Json(Page {
        data: member_list(&store, actor.read(workspace)?).await?,
        next_cursor: None,
        total: None,
    }))
}

#[utoipa::path(
    get,
    path = "/api/v1/workspaces/{workspace}/teams",
    tag = "teams",
    params(("workspace" = Uuid, Path), PageParams),
    responses((status = 200, body = Page<Team>))
)]
pub async fn teams(
    State(store): State<Store>,
    actor: ApiActor,
    Path(workspace): Path<Uuid>,
    Query(params): Query<PageParams>,
) -> Result<Json<Page<Team>>> {
    Ok(Json(
        list_collection(&store, actor.read(workspace)?, "teams", &params, None).await?,
    ))
}

#[utoipa::path(
    get,
    path = "/api/v1/workspaces/{workspace}/teams/{team}",
    tag = "teams",
    params(("workspace" = Uuid, Path), ("team" = Uuid, Path)),
    responses((status = 200, body = Team))
)]
pub async fn team(
    State(store): State<Store>,
    actor: ApiActor,
    Path((workspace, team)): Path<(Uuid, Uuid)>,
) -> Result<Response> {
    let team: Team = record(&store, actor.read(workspace)?, "teams", team).await?;
    Ok(one(StatusCode::OK, team))
}

#[derive(Deserialize, utoipa::ToSchema)]
pub struct CreateTeam {
    pub name: String,
    /// Prefixes the team's issue numbers, as in `ENG-42`: an uppercase letter,
    /// then up to three uppercase letters or digits. Unique in the workspace.
    pub key: String,
    /// Member user ids. The creator joins automatically.
    #[serde(default)]
    pub members: Vec<Uuid>,
}

#[utoipa::path(
    post,
    path = "/api/v1/workspaces/{workspace}/teams",
    tag = "teams",
    params(("workspace" = Uuid, Path)),
    request_body = CreateTeam,
    responses((status = 201, body = Team))
)]
pub async fn create_team(
    State(store): State<Store>,
    actor: ApiActor,
    Path(workspace): Path<Uuid>,
    options: WriteOptions,
    Json(body): Json<CreateTeam>,
) -> Result<Response> {
    let scope = actor.write(workspace)?;
    let result = run(
        &store,
        scope,
        async {
            Ok(Command::CreateTeam {
                id: None,
                name: body.name,
                key: body.key,
                members: body.members,
                default_stage_ids: None,
            })
        },
        None,
        options,
    )
    .await?;
    let team: Team = record(&store, scope, "teams", created_id(&result)?).await?;
    Ok(one(StatusCode::CREATED, team))
}

#[derive(Deserialize, utoipa::ToSchema)]
pub struct UpdateTeam {
    pub name: Option<String>,
    /// A new key. Issue keys under the old one keep resolving, and no other
    /// team can take it.
    pub key: Option<String>,
}

#[utoipa::path(
    patch,
    path = "/api/v1/workspaces/{workspace}/teams/{team}",
    tag = "teams",
    params(("workspace" = Uuid, Path), ("team" = Uuid, Path)),
    request_body = UpdateTeam,
    responses((status = 200, body = Team), (status = 412, body = crate::error::ErrorBody))
)]
pub async fn update_team(
    State(store): State<Store>,
    actor: ApiActor,
    Path((workspace, team)): Path<(Uuid, Uuid)>,
    options: WriteOptions,
    Json(body): Json<UpdateTeam>,
) -> Result<Response> {
    let scope = actor.write(workspace)?;
    run(
        &store,
        scope,
        async {
            let current: Team = record(&store, scope, "teams", team).await?;
            Ok(Command::UpdateTeam {
                id: team,
                name: body.name.unwrap_or(current.name),
                key: body.key.unwrap_or(current.key),
            })
        },
        Some(team),
        options,
    )
    .await?;
    let team: Team = record(&store, scope, "teams", team).await?;
    Ok(one(StatusCode::OK, team))
}

#[utoipa::path(
    delete,
    path = "/api/v1/workspaces/{workspace}/teams/{team}",
    tag = "teams",
    params(("workspace" = Uuid, Path), ("team" = Uuid, Path)),
    responses((status = 204), (status = 409, body = crate::error::ErrorBody))
)]
pub async fn delete_team(
    State(store): State<Store>,
    actor: ApiActor,
    Path((workspace, team)): Path<(Uuid, Uuid)>,
    options: WriteOptions,
) -> Result<StatusCode> {
    run(
        &store,
        actor.write(workspace)?,
        async { Ok(Command::DeleteTeam { id: team }) },
        Some(team),
        options,
    )
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn team_stage(store: &Store, scope: Scope, team: Uuid, stage: Uuid) -> Result<Stage> {
    let team: Team = record(store, scope, "teams", team).await?;
    team.stages
        .into_iter()
        .find(|s| s.id == stage)
        .ok_or(Error::NotFound)
}

#[utoipa::path(
    get,
    path = "/api/v1/workspaces/{workspace}/teams/{team}/stages",
    tag = "teams",
    params(("workspace" = Uuid, Path), ("team" = Uuid, Path)),
    responses((status = 200, body = Page<Stage>))
)]
pub async fn stages(
    State(store): State<Store>,
    actor: ApiActor,
    Path((workspace, team)): Path<(Uuid, Uuid)>,
) -> Result<Json<Page<Stage>>> {
    let team: Team = record(&store, actor.read(workspace)?, "teams", team).await?;
    Ok(Json(Page {
        data: team.stages,
        next_cursor: None,
        total: None,
    }))
}

#[utoipa::path(
    get,
    path = "/api/v1/workspaces/{workspace}/teams/{team}/stages/{stage}",
    tag = "teams",
    params(("workspace" = Uuid, Path), ("team" = Uuid, Path), ("stage" = Uuid, Path)),
    responses((status = 200, body = Stage))
)]
pub async fn stage(
    State(store): State<Store>,
    actor: ApiActor,
    Path((workspace, team, stage)): Path<(Uuid, Uuid, Uuid)>,
) -> Result<Response> {
    let stage = team_stage(&store, actor.read(workspace)?, team, stage).await?;
    Ok(one(StatusCode::OK, stage))
}

#[derive(Deserialize, utoipa::ToSchema)]
pub struct CreateStage {
    pub name: String,
    pub kind: StageKind,
    /// Board order. Defaults to after the team's last stage.
    pub position: Option<i64>,
}

#[utoipa::path(
    post,
    path = "/api/v1/workspaces/{workspace}/teams/{team}/stages",
    tag = "teams",
    params(("workspace" = Uuid, Path), ("team" = Uuid, Path)),
    request_body = CreateStage,
    responses((status = 201, body = Stage))
)]
pub async fn create_stage(
    State(store): State<Store>,
    actor: ApiActor,
    Path((workspace, team)): Path<(Uuid, Uuid)>,
    options: WriteOptions,
    Json(body): Json<CreateStage>,
) -> Result<Response> {
    let scope = actor.write(workspace)?;
    let result = run(
        &store,
        scope,
        async {
            let position = match body.position {
                Some(position) => position,
                None => {
                    let current: Team = record(&store, scope, "teams", team).await?;
                    current
                        .stages
                        .iter()
                        .map(|s| s.position + 1)
                        .max()
                        .unwrap_or(0)
                }
            };
            Ok(Command::CreateStage {
                id: None,
                team_id: team,
                name: body.name,
                kind: body.kind,
                position,
            })
        },
        None,
        options,
    )
    .await?;
    let stage = team_stage(&store, scope, team, created_id(&result)?).await?;
    Ok(one(StatusCode::CREATED, stage))
}

#[derive(Deserialize, utoipa::ToSchema)]
pub struct UpdateStage {
    pub name: Option<String>,
    pub kind: Option<StageKind>,
    pub position: Option<i64>,
}

#[utoipa::path(
    patch,
    path = "/api/v1/workspaces/{workspace}/teams/{team}/stages/{stage}",
    tag = "teams",
    params(("workspace" = Uuid, Path), ("team" = Uuid, Path), ("stage" = Uuid, Path)),
    request_body = UpdateStage,
    responses((status = 200, body = Stage), (status = 412, body = crate::error::ErrorBody))
)]
pub async fn update_stage(
    State(store): State<Store>,
    actor: ApiActor,
    Path((workspace, team, stage)): Path<(Uuid, Uuid, Uuid)>,
    options: WriteOptions,
    Json(body): Json<UpdateStage>,
) -> Result<Response> {
    let scope = actor.write(workspace)?;
    run(
        &store,
        scope,
        async {
            let current = team_stage(&store, scope, team, stage).await?;
            Ok(Command::UpdateStage {
                team_id: team,
                id: stage,
                name: body.name.unwrap_or(current.name),
                kind: body.kind.unwrap_or(current.kind),
                position: body.position.unwrap_or(current.position),
            })
        },
        Some(stage),
        options,
    )
    .await?;
    let stage = team_stage(&store, scope, team, stage).await?;
    Ok(one(StatusCode::OK, stage))
}

#[derive(Deserialize, utoipa::IntoParams)]
#[into_params(parameter_in = Query)]
pub struct DeleteStage {
    /// Stage of the same team that receives the deleted stage's issues.
    pub replacement: Uuid,
}

#[utoipa::path(
    delete,
    path = "/api/v1/workspaces/{workspace}/teams/{team}/stages/{stage}",
    tag = "teams",
    params(("workspace" = Uuid, Path), ("team" = Uuid, Path), ("stage" = Uuid, Path), DeleteStage),
    responses((status = 204))
)]
pub async fn delete_stage(
    State(store): State<Store>,
    actor: ApiActor,
    Path((workspace, team, stage)): Path<(Uuid, Uuid, Uuid)>,
    Query(query): Query<DeleteStage>,
    options: WriteOptions,
) -> Result<StatusCode> {
    run(
        &store,
        actor.write(workspace)?,
        async {
            Ok(Command::DeleteStage {
                team_id: team,
                id: stage,
                replacement: query.replacement,
            })
        },
        Some(stage),
        options,
    )
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

#[utoipa::path(
    get,
    path = "/api/v1/workspaces/{workspace}/labels",
    tag = "labels",
    params(("workspace" = Uuid, Path), PageParams),
    responses((status = 200, body = Page<Label>))
)]
pub async fn labels(
    State(store): State<Store>,
    actor: ApiActor,
    Path(workspace): Path<Uuid>,
    Query(params): Query<PageParams>,
) -> Result<Json<Page<Label>>> {
    Ok(Json(
        list_collection(&store, actor.read(workspace)?, "labels", &params, None).await?,
    ))
}

#[utoipa::path(
    get,
    path = "/api/v1/workspaces/{workspace}/labels/{label}",
    tag = "labels",
    params(("workspace" = Uuid, Path), ("label" = Uuid, Path)),
    responses((status = 200, body = Label))
)]
pub async fn label(
    State(store): State<Store>,
    actor: ApiActor,
    Path((workspace, label)): Path<(Uuid, Uuid)>,
) -> Result<Response> {
    let label: Label = record(&store, actor.read(workspace)?, "labels", label).await?;
    Ok(one(StatusCode::OK, label))
}

#[derive(Deserialize, utoipa::ToSchema)]
pub struct CreateLabel {
    pub name: String,
    pub color: String,
}

#[utoipa::path(
    post,
    path = "/api/v1/workspaces/{workspace}/labels",
    tag = "labels",
    params(("workspace" = Uuid, Path)),
    request_body = CreateLabel,
    responses((status = 201, body = Label))
)]
pub async fn create_label(
    State(store): State<Store>,
    actor: ApiActor,
    Path(workspace): Path<Uuid>,
    options: WriteOptions,
    Json(body): Json<CreateLabel>,
) -> Result<Response> {
    let scope = actor.write(workspace)?;
    let result = run(
        &store,
        scope,
        async {
            Ok(Command::CreateLabel {
                id: None,
                name: body.name,
                color: body.color,
            })
        },
        None,
        options,
    )
    .await?;
    let label: Label = record(&store, scope, "labels", created_id(&result)?).await?;
    Ok(one(StatusCode::CREATED, label))
}

#[derive(Deserialize, utoipa::ToSchema)]
pub struct UpdateLabel {
    pub name: Option<String>,
    pub color: Option<String>,
}

#[utoipa::path(
    patch,
    path = "/api/v1/workspaces/{workspace}/labels/{label}",
    tag = "labels",
    params(("workspace" = Uuid, Path), ("label" = Uuid, Path)),
    request_body = UpdateLabel,
    responses((status = 200, body = Label), (status = 412, body = crate::error::ErrorBody))
)]
pub async fn update_label(
    State(store): State<Store>,
    actor: ApiActor,
    Path((workspace, label)): Path<(Uuid, Uuid)>,
    options: WriteOptions,
    Json(body): Json<UpdateLabel>,
) -> Result<Response> {
    let scope = actor.write(workspace)?;
    run(
        &store,
        scope,
        async {
            let current: Label = record(&store, scope, "labels", label).await?;
            Ok(Command::UpdateLabel {
                id: label,
                name: body.name.unwrap_or(current.name),
                color: body.color.unwrap_or(current.color),
            })
        },
        Some(label),
        options,
    )
    .await?;
    let label: Label = record(&store, scope, "labels", label).await?;
    Ok(one(StatusCode::OK, label))
}

#[utoipa::path(
    delete,
    path = "/api/v1/workspaces/{workspace}/labels/{label}",
    tag = "labels",
    params(("workspace" = Uuid, Path), ("label" = Uuid, Path)),
    responses((status = 204))
)]
pub async fn delete_label(
    State(store): State<Store>,
    actor: ApiActor,
    Path((workspace, label)): Path<(Uuid, Uuid)>,
    options: WriteOptions,
) -> Result<StatusCode> {
    run(
        &store,
        actor.write(workspace)?,
        async { Ok(Command::DeleteLabel { id: label }) },
        Some(label),
        options,
    )
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

#[utoipa::path(
    get,
    path = "/api/v1/workspaces/{workspace}/projects",
    tag = "projects",
    params(("workspace" = Uuid, Path), PageParams),
    responses((status = 200, body = Page<Project>))
)]
pub async fn projects(
    State(store): State<Store>,
    actor: ApiActor,
    Path(workspace): Path<Uuid>,
    Query(params): Query<PageParams>,
) -> Result<Json<Page<Project>>> {
    Ok(Json(
        list_collection(&store, actor.read(workspace)?, "projects", &params, None).await?,
    ))
}

#[utoipa::path(
    get,
    path = "/api/v1/workspaces/{workspace}/projects/{project}",
    tag = "projects",
    params(("workspace" = Uuid, Path), ("project" = Uuid, Path)),
    responses((status = 200, body = Project))
)]
pub async fn project(
    State(store): State<Store>,
    actor: ApiActor,
    Path((workspace, project)): Path<(Uuid, Uuid)>,
) -> Result<Response> {
    let project: Project = record(&store, actor.read(workspace)?, "projects", project).await?;
    Ok(one(StatusCode::OK, project))
}

#[derive(Deserialize, utoipa::ToSchema)]
pub struct CreateProject {
    pub name: String,
    #[serde(default)]
    pub description: String,
    pub team_ids: Vec<Uuid>,
}

#[utoipa::path(
    post,
    path = "/api/v1/workspaces/{workspace}/projects",
    tag = "projects",
    params(("workspace" = Uuid, Path)),
    request_body = CreateProject,
    responses((status = 201, body = Project))
)]
pub async fn create_project(
    State(store): State<Store>,
    actor: ApiActor,
    Path(workspace): Path<Uuid>,
    options: WriteOptions,
    Json(body): Json<CreateProject>,
) -> Result<Response> {
    let scope = actor.write(workspace)?;
    let result = run(
        &store,
        scope,
        async {
            Ok(Command::CreateProject {
                id: None,
                name: body.name,
                description: body.description,
                team_ids: body.team_ids,
            })
        },
        None,
        options,
    )
    .await?;
    let project: Project = record(&store, scope, "projects", created_id(&result)?).await?;
    Ok(one(StatusCode::CREATED, project))
}

/// Merge-patch: omitted fields stay, `null` clears `lead_id`, `health`, `start_date` and
/// `target_date`.
#[derive(Deserialize, utoipa::ToSchema)]
pub struct UpdateProject {
    pub name: Option<String>,
    pub description: Option<String>,
    pub team_ids: Option<Vec<Uuid>>,
    /// A member's user id.
    #[serde(default, deserialize_with = "super::issues::nullable")]
    #[schema(value_type = Option<Uuid>)]
    pub lead_id: Option<Option<Uuid>>,
    pub status: Option<ProjectStatus>,
    #[serde(default, deserialize_with = "super::issues::nullable")]
    #[schema(value_type = Option<ProjectHealth>)]
    pub health: Option<Option<ProjectHealth>>,
    /// `YYYY-MM-DD`.
    #[serde(default, deserialize_with = "super::issues::nullable")]
    #[schema(value_type = Option<NaiveDate>)]
    pub start_date: Option<Option<NaiveDate>>,
    /// `YYYY-MM-DD`, not before `start_date`.
    #[serde(default, deserialize_with = "super::issues::nullable")]
    #[schema(value_type = Option<NaiveDate>)]
    pub target_date: Option<Option<NaiveDate>>,
}

#[utoipa::path(
    patch,
    path = "/api/v1/workspaces/{workspace}/projects/{project}",
    tag = "projects",
    params(("workspace" = Uuid, Path), ("project" = Uuid, Path)),
    request_body = UpdateProject,
    responses((status = 200, body = Project), (status = 412, body = crate::error::ErrorBody))
)]
pub async fn update_project(
    State(store): State<Store>,
    actor: ApiActor,
    Path((workspace, project)): Path<(Uuid, Uuid)>,
    mut options: WriteOptions,
    Json(body): Json<UpdateProject>,
) -> Result<Response> {
    let scope = actor.write(workspace)?;
    let current: Project = record(&store, scope, "projects", project).await?;
    let plan = (body.lead_id.is_some()
        || body.status.is_some()
        || body.health.is_some()
        || body.start_date.is_some()
        || body.target_date.is_some())
    .then(|| Command::SetProjectPlan {
        id: project,
        lead_id: body.lead_id.unwrap_or(current.lead_id),
        status: body.status.unwrap_or(current.status),
        health: body.health.unwrap_or(current.health),
        start_date: body.start_date.unwrap_or(current.start_date),
        target_date: body.target_date.unwrap_or(current.target_date),
    });
    let details = body.name.is_some() || body.description.is_some() || body.team_ids.is_some();
    if details || plan.is_none() {
        let update = Command::UpdateProject {
            id: project,
            name: body.name.unwrap_or(current.name),
            description: body.description.unwrap_or(current.description),
            team_ids: body.team_ids.unwrap_or(current.team_ids),
        };
        let result = run(
            &store,
            scope,
            async {
                // The plan runs after these details commit, so check it first.
                if let Some(Command::SetProjectPlan {
                    lead_id,
                    start_date,
                    target_date,
                    ..
                }) = &plan
                {
                    crate::domain::validate_project_dates(*start_date, *target_date)?;
                    if let Some(lead) = lead_id {
                        let member: bool = sqlx::query_scalar!(
                            "SELECT EXISTS(SELECT 1 FROM workspace_members WHERE workspace_id=$1 AND user_id=$2) AS \"exists!\"",
                            workspace,
                            *lead,
                        )
                        .fetch_one(&store.pool)
                        .await?;
                        if !member {
                            return Err(Error::Forbidden);
                        }
                    }
                }
                Ok(update)
            },
            Some(project),
            WriteOptions {
                if_match: options.if_match,
                idempotency_key: options.idempotency_key.clone(),
                sent: options.sent.clone(),
                legacy_key: None,
            },
        )
        .await?;
        options.if_match = options
            .if_match
            .and_then(|_| result.versions.get(&project).copied());
        options = options.step("plan");
    }
    if let Some(plan) = plan {
        run(&store, scope, async { Ok(plan) }, Some(project), options).await?;
    }
    let project: Project = record(&store, scope, "projects", project).await?;
    Ok(one(StatusCode::OK, project))
}

#[utoipa::path(
    delete,
    path = "/api/v1/workspaces/{workspace}/projects/{project}",
    tag = "projects",
    params(("workspace" = Uuid, Path), ("project" = Uuid, Path)),
    responses((status = 204))
)]
pub async fn delete_project(
    State(store): State<Store>,
    actor: ApiActor,
    Path((workspace, project)): Path<(Uuid, Uuid)>,
    options: WriteOptions,
) -> Result<StatusCode> {
    run(
        &store,
        actor.write(workspace)?,
        async { Ok(Command::DeleteProject { id: project }) },
        Some(project),
        options,
    )
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

#[utoipa::path(
    get,
    path = "/api/v1/workspaces/{workspace}/milestones",
    tag = "projects",
    params(("workspace" = Uuid, Path), PageParams),
    responses((status = 200, body = Page<Milestone>))
)]
pub async fn milestones(
    State(store): State<Store>,
    actor: ApiActor,
    Path(workspace): Path<Uuid>,
    Query(params): Query<PageParams>,
) -> Result<Json<Page<Milestone>>> {
    Ok(Json(
        list_collection(&store, actor.read(workspace)?, "milestones", &params, None).await?,
    ))
}

#[utoipa::path(
    get,
    path = "/api/v1/workspaces/{workspace}/milestones/{milestone}",
    tag = "projects",
    params(("workspace" = Uuid, Path), ("milestone" = Uuid, Path)),
    responses((status = 200, body = Milestone))
)]
pub async fn milestone(
    State(store): State<Store>,
    actor: ApiActor,
    Path((workspace, milestone)): Path<(Uuid, Uuid)>,
) -> Result<Response> {
    let milestone: Milestone =
        record(&store, actor.read(workspace)?, "milestones", milestone).await?;
    Ok(one(StatusCode::OK, milestone))
}

#[utoipa::path(
    delete,
    path = "/api/v1/workspaces/{workspace}/milestones/{milestone}",
    tag = "projects",
    params(("workspace" = Uuid, Path), ("milestone" = Uuid, Path)),
    responses((status = 204))
)]
pub async fn delete_milestone(
    State(store): State<Store>,
    actor: ApiActor,
    Path((workspace, milestone)): Path<(Uuid, Uuid)>,
    options: WriteOptions,
) -> Result<StatusCode> {
    run(
        &store,
        actor.write(workspace)?,
        async { Ok(Command::DeleteMilestone { id: milestone }) },
        Some(milestone),
        options,
    )
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

#[utoipa::path(
    get,
    path = "/api/v1/workspaces/{workspace}/sprints",
    tag = "teams",
    description = "Every team's sprints, oldest first.",
    params(("workspace" = Uuid, Path), PageParams),
    responses((status = 200, body = Page<Sprint>))
)]
pub async fn sprints(
    State(store): State<Store>,
    actor: ApiActor,
    Path(workspace): Path<Uuid>,
    Query(params): Query<PageParams>,
) -> Result<Json<Page<Sprint>>> {
    Ok(Json(
        list_collection(&store, actor.read(workspace)?, "sprints", &params, None).await?,
    ))
}

#[utoipa::path(
    get,
    path = "/api/v1/workspaces/{workspace}/sprints/{sprint}",
    tag = "teams",
    params(("workspace" = Uuid, Path), ("sprint" = Uuid, Path)),
    responses((status = 200, body = Sprint))
)]
pub async fn sprint(
    State(store): State<Store>,
    actor: ApiActor,
    Path((workspace, sprint)): Path<(Uuid, Uuid)>,
) -> Result<Response> {
    let sprint: Sprint = record(&store, actor.read(workspace)?, "sprints", sprint).await?;
    Ok(one(StatusCode::OK, sprint))
}
