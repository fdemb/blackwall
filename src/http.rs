use crate::{
    auth::{self, *},
    domain::*,
    error::{Error, Result},
    store::{NewAttachment, NewJob, Store},
};
use axum::{
    Json, Router,
    body::Bytes,
    extract::Request,
    extract::{DefaultBodyLimit, FromRequestParts, Multipart, Path, Query, State},
    http::{HeaderMap, HeaderValue, StatusCode, header, request::Parts},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use sqlx::Row;
use utoipa::OpenApi;
use uuid::Uuid;

pub struct Actor {
    pub profile: Profile,
    pub token: String,
}
impl FromRequestParts<Store> for Actor {
    type Rejection = Error;
    async fn from_request_parts(parts: &mut Parts, store: &Store) -> Result<Self> {
        let bearer = parts
            .headers
            .get(header::AUTHORIZATION)
            .and_then(|h| h.to_str().ok())
            .and_then(|h| h.strip_prefix("Bearer "));
        let cookie = parts
            .headers
            .get(header::COOKIE)
            .and_then(|h| h.to_str().ok())
            .and_then(|h| {
                h.split(';')
                    .find_map(|p| p.trim().strip_prefix("blackwall_session="))
            });
        let token = bearer.or(cookie).ok_or(Error::Unauthorized)?;
        if bearer.is_none()
            && !matches!(
                parts.method,
                axum::http::Method::GET | axum::http::Method::HEAD | axum::http::Method::OPTIONS
            )
        {
            let supplied = parts
                .headers
                .get("x-csrf-token")
                .and_then(|h| h.to_str().ok())
                .unwrap_or("");
            if !constant_eq(supplied.as_bytes(), auth::csrf(token).as_bytes()) {
                return Err(Error::Forbidden);
            }
        }
        Ok(Self {
            profile: store.authenticate(token).await?,
            token: token.into(),
        })
    }
}
fn constant_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.iter()
        .zip(right)
        .fold(0u8, |diff, (a, b)| diff | (a ^ b))
        == 0
}
#[derive(Serialize, utoipa::ToSchema)]
pub struct WorkspaceSummary {
    pub id: Uuid,
    pub name: String,
    pub revision: i64,
}
#[derive(Serialize, utoipa::ToSchema)]
pub struct WorkspaceResponse {
    pub revision: i64,
    pub workspace: Workspace,
}
#[derive(Deserialize, utoipa::ToSchema)]
pub struct CreateWorkspace {
    pub name: String,
}
#[derive(Deserialize, utoipa::ToSchema)]
pub struct CommandRequest {
    pub revision: i64,
    pub command: Command,
}
#[derive(Serialize, utoipa::ToSchema)]
pub struct CommandResponse {
    pub revision: i64,
    pub result: CommandResult,
}
#[derive(Deserialize, utoipa::ToSchema)]
pub struct AcceptInvitation {
    pub token: String,
}
#[derive(Deserialize, utoipa::ToSchema)]
pub struct ImportRequest {
    pub revision: i64,
    pub issues: Option<Vec<IssueInput>>,
    pub transfer: Option<crate::exchange::Transfer>,
}
#[derive(Serialize, utoipa::ToSchema)]
pub struct ImportResponse {
    pub revision: i64,
    pub summary: Option<crate::exchange::ImportSummary>,
}
#[derive(Deserialize)]
pub struct SearchQuery {
    pub q: String,
}
#[derive(Serialize, utoipa::ToSchema)]
pub struct SearchResult {
    pub issues: Vec<Issue>,
    pub people: Vec<MemberProfile>,
}
#[derive(Serialize, utoipa::ToSchema)]
pub struct MemberProfile {
    pub id: Uuid,
    pub email: String,
    pub display_name: String,
    pub avatar_url: Option<String>,
    pub contact: String,
    pub team_ids: Vec<Uuid>,
}
#[derive(Deserialize, utoipa::ToSchema)]
pub struct MarkdownRequest {
    pub text: String,
}
#[derive(Serialize, utoipa::ToSchema)]
pub struct MarkdownResponse {
    pub html: String,
}
#[derive(Serialize, utoipa::ToSchema)]
pub struct Health {
    pub status: String,
}
#[derive(Deserialize, utoipa::ToSchema)]
pub struct IncomingLink {
    pub delivery_id: Uuid,
    pub issue_id: Uuid,
    pub url: String,
    pub title: String,
}

pub fn router(store: Store) -> Router {
    Router::new()
        .route("/", get(crate::ui::index))
        .route("/static/app.js", get(crate::ui::js))
        .route("/static/style.css", get(crate::ui::css))
        .route("/health", get(health))
        .route("/api/schema.json", get(schema))
        .route("/api/auth/register", post(register))
        .route("/api/auth/login", post(login))
        .route("/api/auth/logout", post(logout))
        .route("/api/auth/password", post(change_password))
        .route("/api/auth/reset-request", post(reset_request))
        .route("/api/auth/reset", post(reset_password))
        .route("/api/me", get(me).patch(edit_profile))
        .route("/api/workspaces", get(workspaces).post(create_workspace))
        .route("/api/workspaces/{id}", get(workspace))
        .route("/api/workspaces/{id}/commands", post(command))
        .route("/api/workspaces/{id}/issues", get(issues))
        .route("/api/workspaces/{id}/issues/{issue}", get(issue_detail))
        .route("/api/workspaces/{id}/members", get(members))
        .route("/api/workspaces/{id}/search", get(search))
        .route("/api/workspaces/{id}/report", get(report))
        .route(
            "/api/workspaces/{id}/invitations/accept",
            post(accept_invitation),
        )
        .route(
            "/api/workspaces/{id}/issues/{issue}/attachments",
            post(upload),
        )
        .route(
            "/api/workspaces/{id}/attachments/{attachment}",
            get(download),
        )
        .route("/api/workspaces/{id}/export", get(export))
        .route(
            "/api/workspaces/{id}/import",
            post(import).layer(DefaultBodyLimit::max(20 * 1024 * 1024)),
        )
        .route(
            "/api/workspaces/{id}/integrations/{integration}/webhook",
            post(incoming),
        )
        .route("/api/markdown", post(markdown))
        .layer(DefaultBodyLimit::max(6 * 1024 * 1024))
        .layer(middleware::from_fn(security_headers))
        .layer(middleware::from_fn(auth_rate_limit))
        .with_state(store)
}
async fn security_headers(request: Request, next: Next) -> Response {
    if !matches!(
        *request.method(),
        axum::http::Method::GET | axum::http::Method::HEAD | axum::http::Method::OPTIONS
    ) && let Some(origin) = request.headers().get(header::ORIGIN)
    {
        let origin = origin
            .to_str()
            .ok()
            .and_then(|s| reqwest::Url::parse(s).ok());
        let host = request
            .headers()
            .get(header::HOST)
            .and_then(|s| s.to_str().ok());
        let origin_host = origin.as_ref().and_then(|url| {
            url.host_str().map(|host| {
                if let Some(port) = url.port() {
                    format!("{host}:{port}")
                } else {
                    host.to_owned()
                }
            })
        });
        if host.is_none() || origin_host.as_deref() != host {
            return Error::Forbidden.into_response();
        }
    }
    let mut response = next.run(request).await;
    if response.status().is_client_error()
        && !response
            .headers()
            .get(header::CONTENT_TYPE)
            .is_some_and(|h| h.as_bytes().starts_with(b"application/json"))
    {
        let status = response.status();
        let body = std::mem::replace(response.body_mut(), axum::body::Body::empty());
        let message = axum::body::to_bytes(body, 16384)
            .await
            .ok()
            .and_then(|b| String::from_utf8(b.to_vec()).ok())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| status.to_string());
        response = (status, Json(crate::error::ErrorBody { error: message })).into_response();
    }
    let headers = response.headers_mut();
    headers.insert(
        "x-content-type-options",
        HeaderValue::from_static("nosniff"),
    );
    headers.insert("referrer-policy", HeaderValue::from_static("same-origin"));
    headers.insert("content-security-policy", HeaderValue::from_static("default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' https:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"));
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}
async fn auth_rate_limit(request: Request, next: Next) -> Response {
    use std::{
        collections::HashMap,
        sync::{Mutex, OnceLock},
    };
    static LIMIT: OnceLock<Mutex<HashMap<String, (i64, u32)>>> = OnceLock::new();
    if request.uri().path().starts_with("/api/auth/")
        && request.method() == axum::http::Method::POST
    {
        let ip = request
            .extensions()
            .get::<axum::extract::ConnectInfo<std::net::SocketAddr>>()
            .map(|i| i.0.ip().to_string())
            .unwrap_or_else(|| "local".into());
        let now = Utc::now().timestamp();
        let limited = {
            let mut limits = LIMIT
                .get_or_init(|| Mutex::new(HashMap::new()))
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            limits.retain(|_, (start, _)| now - *start < 60);
            let entry = limits.entry(ip).or_insert((now, 0));
            entry.1 += 1;
            entry.1 > 30
        };
        if limited {
            return (
                StatusCode::TOO_MANY_REQUESTS,
                Json(crate::error::ErrorBody {
                    error: "too many authentication attempts".into(),
                }),
            )
                .into_response();
        }
    }
    next.run(request).await
}
fn cookie(token: &str) -> Result<HeaderValue> {
    let secure = if std::env::var("COOKIE_SECURE").as_deref() == Ok("true") {
        "; Secure"
    } else {
        ""
    };
    HeaderValue::from_str(&format!(
        "blackwall_session={token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000{secure}"
    ))
    .map_err(|e| Error::Internal(e.to_string()))
}
fn session_response(session: Session) -> Result<Response> {
    let header = cookie(&session.token)?;
    let mut response = Json(session).into_response();
    response.headers_mut().insert(header::SET_COOKIE, header);
    Ok(response)
}
#[utoipa::path(post,path="/api/auth/register",request_body=Register,responses((status=200,body=Session),(status=409,body=crate::error::ErrorBody)))]
async fn register(State(store): State<Store>, Json(input): Json<Register>) -> Result<Response> {
    session_response(store.register(input).await?)
}
#[utoipa::path(post,path="/api/auth/login",request_body=Login,responses((status=200,body=Session),(status=401,body=crate::error::ErrorBody)))]
async fn login(State(store): State<Store>, Json(input): Json<Login>) -> Result<Response> {
    session_response(store.login(input).await?)
}
#[utoipa::path(post,path="/api/auth/logout",responses((status=204)))]
async fn logout(State(store): State<Store>, actor: Actor) -> Result<Response> {
    store.logout(&actor.token).await?;
    let mut response = StatusCode::NO_CONTENT.into_response();
    response.headers_mut().insert(
        header::SET_COOKIE,
        HeaderValue::from_static(
            "blackwall_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0",
        ),
    );
    Ok(response)
}
#[utoipa::path(get,path="/api/me",responses((status=200,body=Profile)))]
async fn me(actor: Actor) -> Result<Response> {
    let csrf = HeaderValue::from_str(&auth::csrf(&actor.token))
        .map_err(|e| Error::Internal(e.to_string()))?;
    let mut response = Json(actor.profile).into_response();
    response.headers_mut().insert("x-csrf-token", csrf);
    Ok(response)
}
#[utoipa::path(patch,path="/api/me",request_body=ProfileEdit,responses((status=200,body=Profile)))]
async fn edit_profile(
    State(store): State<Store>,
    actor: Actor,
    Json(input): Json<ProfileEdit>,
) -> Result<Json<Profile>> {
    Ok(Json(store.edit_profile(actor.profile, input).await?))
}
#[utoipa::path(post,path="/api/auth/password",request_body=PasswordChange,responses((status=204)))]
async fn change_password(
    State(store): State<Store>,
    actor: Actor,
    Json(input): Json<PasswordChange>,
) -> Result<StatusCode> {
    store.change_password(actor.profile.id, input).await?;
    Ok(StatusCode::NO_CONTENT)
}
#[utoipa::path(post,path="/api/auth/reset-request",request_body=ResetRequest,responses((status=202)))]
async fn reset_request(
    State(store): State<Store>,
    Json(input): Json<ResetRequest>,
) -> Result<StatusCode> {
    store.request_reset(input).await?;
    Ok(StatusCode::ACCEPTED)
}
#[utoipa::path(post,path="/api/auth/reset",request_body=ResetPassword,responses((status=204)))]
async fn reset_password(
    State(store): State<Store>,
    Json(input): Json<ResetPassword>,
) -> Result<StatusCode> {
    store.reset_password(input).await?;
    Ok(StatusCode::NO_CONTENT)
}
#[utoipa::path(get,path="/health",responses((status=200,body=Health)))]
async fn health(State(store): State<Store>) -> Result<Json<Health>> {
    sqlx::query("SELECT 1").execute(&store.pool).await?;
    Ok(Json(Health {
        status: "ok".into(),
    }))
}
#[utoipa::path(get,path="/api/workspaces",responses((status=200,body=Vec<WorkspaceSummary>)))]
async fn workspaces(
    State(store): State<Store>,
    actor: Actor,
) -> Result<Json<Vec<WorkspaceSummary>>> {
    let mut out = Vec::new();
    for id in store.workspace_ids(Some(actor.profile.id)).await? {
        let (w, revision) = store.load_workspace(id).await?;
        if w.member(actor.profile.id).is_ok() {
            out.push(WorkspaceSummary {
                id,
                name: w.name,
                revision,
            });
        }
    }
    Ok(Json(out))
}
#[utoipa::path(post,path="/api/workspaces",request_body=CreateWorkspace,responses((status=200,body=WorkspaceResponse)))]
async fn create_workspace(
    State(store): State<Store>,
    actor: Actor,
    Json(input): Json<CreateWorkspace>,
) -> Result<Json<WorkspaceResponse>> {
    let workspace = Workspace::new(input.name, actor.profile.id)?;
    store.insert_workspace(&workspace, actor.profile.id).await?;
    Ok(Json(WorkspaceResponse {
        revision: 0,
        workspace,
    }))
}
#[utoipa::path(get,path="/api/workspaces/{id}",params(("id"=Uuid,Path)),responses((status=200,body=WorkspaceResponse)))]
async fn workspace(
    State(store): State<Store>,
    actor: Actor,
    Path(id): Path<Uuid>,
) -> Result<Json<WorkspaceResponse>> {
    let (w, revision) = store.load_workspace(id).await?;
    w.member(actor.profile.id)?;
    Ok(Json(WorkspaceResponse {
        revision,
        workspace: w.public(actor.profile.id)?,
    }))
}

fn outgoing(before: &Workspace, after: &Workspace) -> Vec<NewJob> {
    let mut jobs = Vec::new();
    let previous: std::collections::HashSet<_> =
        before.activity.iter().map(|event| event.id).collect();
    for event in after.activity.iter().filter(|e| !previous.contains(&e.id)) {
        for integration in after.integrations.iter().filter(|i| i.enabled) {
            jobs.push(NewJob{id:format!("{}:{}",event.id,integration.id),kind:"webhook".into(),payload:serde_json::json!({"workspace_id":after.id,"integration_id":integration.id,"url":integration.webhook_url,"secret":integration.secret,"event":{"workspace_id":after.id,"activity":event}}),due_at:Utc::now().timestamp()});
        }
    }
    jobs
}
async fn validate_attachments(
    store: &Store,
    workspace: Uuid,
    issue: Uuid,
    attachments: &mut [Attachment],
) -> Result<()> {
    for attachment in attachments {
        let row=sqlx::query("SELECT filename,content_type,bytes_hex FROM attachments WHERE id=$1 AND workspace_id=$2 AND issue_id=$3").bind(attachment.id.to_string()).bind(workspace.to_string()).bind(issue.to_string()).fetch_optional(&store.pool).await?.ok_or(Error::BadRequest("attachment must be uploaded to this issue first".into()))?;
        attachment.name = row.try_get("filename")?;
        attachment.content_type = row.try_get("content_type")?;
        attachment.size = (row.try_get::<String, _>("bytes_hex")?.len() / 2) as u64;
    }
    Ok(())
}
#[utoipa::path(post,path="/api/workspaces/{id}/commands",params(("id"=Uuid,Path)),request_body=CommandRequest,responses((status=200,body=CommandResponse),(status=409,body=crate::error::ErrorBody)))]
async fn command(
    State(store): State<Store>,
    actor: Actor,
    Path(id): Path<Uuid>,
    Json(mut input): Json<CommandRequest>,
) -> Result<Json<CommandResponse>> {
    let (before, revision) = store.load_workspace(id).await?;
    before.member(actor.profile.id)?;
    if revision != input.revision {
        return Err(Error::Conflict(
            "workspace changed; reload and retry".into(),
        ));
    }
    let mut workspace = before.clone();
    let mut jobs = Vec::new();
    let invite_token = match &mut input.command {
        Command::Invite { token_hash, .. } | Command::ResendInvitation { token_hash, .. } => {
            let raw = auth::token();
            *token_hash = auth::hash(&raw);
            Some(raw)
        }
        Command::AddAttachment { .. } | Command::AttachCommentFile { .. } => {
            return Err(Error::BadRequest(
                "use the attachment upload endpoint".into(),
            ));
        }
        Command::AddComment {
            issue_id,
            attachments,
            ..
        } => {
            validate_attachments(&store, id, *issue_id, attachments).await?;
            None
        }
        _ => None,
    };
    // Referenced members must exist in the global identity store before membership commit.
    if let Command::CreateTeam { members, .. } | Command::SetTeamMembers { members, .. } =
        &input.command
    {
        for user in members {
            store.profile(*user).await?;
        }
    }
    let result = workspace.apply(actor.profile.id, input.command, Utc::now())?;
    if let Some(token) = invite_token {
        let invitation = workspace
            .invitations
            .iter()
            .find(|i| Some(i.id) == result.id)
            .ok_or_else(|| Error::Internal("invitation result missing".into()))?;
        jobs.push(NewJob{id:Uuid::new_v4().to_string(),kind:"email".into(),payload:serde_json::json!({"to":invitation.email,"subject":"Join a Blackwall workspace","workspace_id":id,"invitation_id":invitation.id,"token_hash":invitation.token_hash,"token":token}),due_at:Utc::now().timestamp()});
    }
    auth::filter_notifications(&store, &before, &mut workspace).await?;
    jobs.extend(outgoing(&before, &workspace));
    let revision = store
        .commit_workspace(&workspace, revision, &jobs, None)
        .await?;
    Ok(Json(CommandResponse { revision, result }))
}
#[utoipa::path(get,path="/api/workspaces/{id}/issues",params(("id"=Uuid,Path), IssueFilter),responses((status=200,body=Vec<Issue>)))]
async fn issues(
    State(store): State<Store>,
    actor: Actor,
    Path(id): Path<Uuid>,
    Query(filter): Query<IssueFilter>,
) -> Result<Json<Vec<Issue>>> {
    let (w, _) = store.load_workspace(id).await?;
    Ok(Json(w.query(actor.profile.id, filter)?))
}
#[utoipa::path(get,path="/api/workspaces/{id}/issues/{issue}",params(("id"=Uuid,Path),("issue"=Uuid,Path)),responses((status=200,body=Issue)))]
async fn issue_detail(
    State(store): State<Store>,
    actor: Actor,
    Path((id, issue)): Path<(Uuid, Uuid)>,
) -> Result<Json<Issue>> {
    let (w, _) = store.load_workspace(id).await?;
    w.member(actor.profile.id)?;
    Ok(Json(
        w.issues
            .into_iter()
            .find(|i| i.id == issue && i.deleted_at.is_none())
            .ok_or(Error::NotFound)?,
    ))
}
#[utoipa::path(get,path="/api/workspaces/{id}/members",params(("id"=Uuid,Path)),responses((status=200,body=Vec<MemberProfile>)))]
async fn members(
    State(store): State<Store>,
    actor: Actor,
    Path(id): Path<Uuid>,
) -> Result<Json<Vec<MemberProfile>>> {
    let (w, _) = store.load_workspace(id).await?;
    w.member(actor.profile.id)?;
    let mut out = Vec::new();
    for m in &w.members {
        out.push(public_profile(store.profile(m.user_id).await?, &w));
    }
    Ok(Json(out))
}
#[utoipa::path(get,path="/api/workspaces/{id}/search",params(("id"=Uuid,Path),("q"=String,Query)),responses((status=200,body=SearchResult)))]
async fn search(
    State(store): State<Store>,
    actor: Actor,
    Path(id): Path<Uuid>,
    Query(query): Query<SearchQuery>,
) -> Result<Json<SearchResult>> {
    if query.q.len() > 200 {
        return Err(Error::BadRequest("search query too long".into()));
    }
    let (w, _) = store.load_workspace(id).await?;
    w.member(actor.profile.id)?;
    let q = query.q.to_lowercase();
    let mut people = Vec::new();
    for m in &w.members {
        let p = store.profile(m.user_id).await?;
        if p.email.to_lowercase().contains(&q) || p.display_name.to_lowercase().contains(&q) {
            people.push(public_profile(p, &w));
        }
    }
    let issues = w.query(
        actor.profile.id,
        IssueFilter {
            search: Some(query.q),
            ..Default::default()
        },
    )?;
    Ok(Json(SearchResult { issues, people }))
}
#[utoipa::path(get,path="/api/workspaces/{id}/report",params(("id"=Uuid,Path)),responses((status=200,body=Report)))]
async fn report(
    State(store): State<Store>,
    actor: Actor,
    Path(id): Path<Uuid>,
) -> Result<Json<Report>> {
    let (w, _) = store.load_workspace(id).await?;
    Ok(Json(w.report(actor.profile.id)?))
}
#[utoipa::path(post,path="/api/workspaces/{id}/invitations/accept",params(("id"=Uuid,Path)),request_body=AcceptInvitation,responses((status=200,body=WorkspaceResponse)))]
async fn accept_invitation(
    State(store): State<Store>,
    actor: Actor,
    Path(id): Path<Uuid>,
    Json(input): Json<AcceptInvitation>,
) -> Result<Json<WorkspaceResponse>> {
    let (mut w, revision) = store.load_workspace(id).await?;
    w.accept_invitation(
        actor.profile.id,
        &actor.profile.email,
        &auth::hash(&input.token),
        Utc::now(),
    )?;
    let revision = store.save_workspace(&w, revision).await?;
    Ok(Json(WorkspaceResponse {
        revision,
        workspace: w.public(actor.profile.id)?,
    }))
}
#[utoipa::path(post,path="/api/markdown",request_body=MarkdownRequest,responses((status=200,body=MarkdownResponse)))]
async fn markdown(
    _actor: Actor,
    Json(input): Json<MarkdownRequest>,
) -> Result<Json<MarkdownResponse>> {
    if input.text.len() > 100_000 {
        return Err(Error::BadRequest("markdown exceeds 100 KB".into()));
    }
    let mut html = String::new();
    pulldown_cmark::html::push_html(
        &mut html,
        pulldown_cmark::Parser::new_ext(
            &input.text,
            pulldown_cmark::Options::ENABLE_TABLES | pulldown_cmark::Options::ENABLE_STRIKETHROUGH,
        ),
    );
    Ok(Json(MarkdownResponse {
        html: ammonia::clean(&html),
    }))
}
#[utoipa::path(post,path="/api/workspaces/{id}/issues/{issue}/attachments",params(("id"=Uuid,Path),("issue"=Uuid,Path)),responses((status=200,body=CommandResponse)),description="Upload a multipart file field, at most 5 MiB. The optional revision field detects stale uploads.")]
async fn upload(
    State(store): State<Store>,
    actor: Actor,
    Path((id, issue)): Path<(Uuid, Uuid)>,
    mut multipart: Multipart,
) -> Result<Json<CommandResponse>> {
    let (before, revision) = store.load_workspace(id).await?;
    before.member(actor.profile.id)?;
    let mut uploaded = None;
    let mut expected = None;
    let mut comment_id = None;
    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|e| Error::BadRequest(e.to_string()))?
    {
        if field.name() == Some("comment_id") {
            comment_id = Some(
                Uuid::parse_str(
                    &field
                        .text()
                        .await
                        .map_err(|e| Error::BadRequest(e.to_string()))?,
                )
                .map_err(|_| Error::BadRequest("invalid comment_id".into()))?,
            );
            continue;
        }
        if field.name() == Some("revision") {
            expected = Some(
                field
                    .text()
                    .await
                    .map_err(|e| Error::BadRequest(e.to_string()))?
                    .parse::<i64>()
                    .map_err(|_| Error::BadRequest("invalid revision".into()))?,
            );
            continue;
        }
        if field.name() != Some("file") || uploaded.is_some() {
            return Err(Error::BadRequest("upload one file field".into()));
        }
        let name = field
            .file_name()
            .unwrap_or("attachment")
            .rsplit(['/', '\\'])
            .next()
            .unwrap_or("attachment")
            .chars()
            .filter(|c| !c.is_control())
            .take(200)
            .collect::<String>();
        let content_type = field
            .content_type()
            .unwrap_or("application/octet-stream")
            .to_owned();
        let bytes = field
            .bytes()
            .await
            .map_err(|e| Error::BadRequest(e.to_string()))?;
        if bytes.len() > 5 * 1024 * 1024 {
            return Err(Error::BadRequest("attachment limit is 5 MiB".into()));
        }
        uploaded = Some(NewAttachment {
            id: Uuid::new_v4(),
            issue_id: issue,
            uploader_id: actor.profile.id,
            filename: name,
            content_type,
            bytes: bytes.to_vec(),
        });
    }
    if expected.is_some_and(|e| e != revision) {
        return Err(Error::Conflict(
            "workspace changed; reload and retry".into(),
        ));
    }
    let attachment = uploaded.ok_or_else(|| Error::BadRequest("file field required".into()))?;
    let mut workspace = before.clone();
    let metadata = Attachment {
        id: attachment.id,
        name: attachment.filename.clone(),
        content_type: attachment.content_type.clone(),
        size: attachment.bytes.len() as u64,
    };
    let command = if let Some(comment_id) = comment_id {
        if !before
            .comments
            .iter()
            .any(|c| c.id == comment_id && c.issue_id == issue)
        {
            return Err(Error::BadRequest("comment belongs to another issue".into()));
        }
        Command::AttachCommentFile {
            comment_id,
            attachment: metadata,
        }
    } else {
        Command::AddAttachment {
            issue_id: issue,
            attachment: metadata,
        }
    };
    let result = workspace.apply(actor.profile.id, command, Utc::now())?;
    let jobs = outgoing(&before, &workspace);
    let revision = store
        .commit_workspace(&workspace, revision, &jobs, Some(attachment))
        .await?;
    Ok(Json(CommandResponse { revision, result }))
}
#[utoipa::path(get,path="/api/workspaces/{id}/attachments/{attachment}",params(("id"=Uuid,Path),("attachment"=Uuid,Path)),responses((status=200,description="Authenticated binary attachment")))]
async fn download(
    State(store): State<Store>,
    actor: Actor,
    Path((id, attachment)): Path<(Uuid, Uuid)>,
) -> Result<Response> {
    let (w, _) = store.load_workspace(id).await?;
    w.member(actor.profile.id)?;
    let attached = w.issues.iter().any(|i| {
        i.deleted_at.is_none()
            && (i.attachments.iter().any(|a| a.id == attachment)
                || w.comments.iter().any(|c| {
                    c.issue_id == i.id && c.attachments.iter().any(|a| a.id == attachment)
                }))
    });
    if !attached {
        return Err(Error::NotFound);
    }
    let row =
        sqlx::query("SELECT filename,bytes_hex FROM attachments WHERE id=$1 AND workspace_id=$2")
            .bind(attachment.to_string())
            .bind(id.to_string())
            .fetch_optional(&store.pool)
            .await?
            .ok_or(Error::NotFound)?;
    let name: String = row.try_get("filename")?;
    let bytes = hex::decode(row.try_get::<&str, _>("bytes_hex")?)
        .map_err(|e| Error::Internal(e.to_string()))?;
    let mut response = bytes.into_response();
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/octet-stream"),
    );
    let safe_name: String = name
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | ' '))
        .collect();
    response.headers_mut().insert(
        header::CONTENT_DISPOSITION,
        HeaderValue::from_str(&format!("attachment; filename=\"{safe_name}\""))
            .map_err(|e| Error::Internal(e.to_string()))?,
    );
    Ok(response)
}
#[utoipa::path(get,path="/api/workspaces/{id}/export",params(("id"=Uuid,Path)),responses((status=200,body=crate::exchange::Transfer)))]
async fn export(
    State(store): State<Store>,
    actor: Actor,
    Path(id): Path<Uuid>,
) -> Result<Json<crate::exchange::Transfer>> {
    use std::collections::BTreeSet;
    let (w, _) = store.load_workspace(id).await?;
    let w = w.public(actor.profile.id)?;
    let users: BTreeSet<_> = w
        .members
        .iter()
        .map(|m| m.user_id)
        .chain(w.comments.iter().map(|c| c.author))
        .chain(w.time_entries.iter().map(|t| t.user_id))
        .chain(w.activity.iter().map(|a| a.actor))
        .collect();
    let mut members = Vec::new();
    for user in users {
        let p = store.profile(user).await?;
        members.push(crate::exchange::TransferMember {
            id: user,
            email: p.email,
        });
    }
    Ok(Json(crate::exchange::Transfer::export(&w, members)))
}
#[utoipa::path(post,path="/api/workspaces/{id}/import",params(("id"=Uuid,Path)),request_body=ImportRequest,responses((status=200,body=ImportResponse)))]
async fn import(
    State(store): State<Store>,
    actor: Actor,
    Path(id): Path<Uuid>,
    Json(input): Json<ImportRequest>,
) -> Result<Json<ImportResponse>> {
    match (input.issues, input.transfer) {
        (Some(issues), None) => {
            let response = command(
                State(store),
                actor,
                Path(id),
                Json(CommandRequest {
                    revision: input.revision,
                    command: Command::ImportIssues { issues },
                }),
            )
            .await?;
            Ok(Json(ImportResponse {
                revision: response.0.revision,
                summary: None,
            }))
        }
        (None, Some(transfer)) => {
            let (before, revision) = store.load_workspace(id).await?;
            before.member(actor.profile.id)?;
            if input.revision != revision {
                return Err(Error::Conflict(
                    "workspace changed; reload and retry".into(),
                ));
            }
            let mut emails = std::collections::HashMap::new();
            for member in &before.members {
                let p = store.profile(member.user_id).await?;
                emails.insert(p.email.to_lowercase(), p.id);
            }
            let mut mapping = std::collections::BTreeMap::new();
            for member in &transfer.members {
                if let Some(user) = emails.get(&member.email.to_lowercase()) {
                    mapping.insert(member.id, *user);
                }
            }
            let mut workspace = before.clone();
            let summary =
                transfer.import(&mut workspace, actor.profile.id, &mapping, Utc::now())?;
            // Historical imported events do not trigger outbound integrations.
            let revision = store.save_workspace(&workspace, revision).await?;
            Ok(Json(ImportResponse {
                revision,
                summary: Some(summary),
            }))
        }
        _ => Err(Error::BadRequest(
            "provide either issues or transfer".into(),
        )),
    }
}
#[utoipa::path(post,path="/api/workspaces/{id}/integrations/{integration}/webhook",params(("id"=Uuid,Path),("integration"=Uuid,Path)),request_body=IncomingLink,responses((status=200,body=CommandResponse)),description="Sign raw body bytes with HMAC-SHA256 in X-Blackwall-Signature. delivery_id provides deduplication.")]
async fn incoming(
    State(store): State<Store>,
    Path((id, integration_id)): Path<(Uuid, Uuid)>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Json<CommandResponse>> {
    use hmac::{Hmac, Mac};
    use sha2::Sha256;
    let (before, revision) = store.load_workspace(id).await?;
    let integration = before
        .integrations
        .iter()
        .find(|i| i.id == integration_id && i.enabled)
        .ok_or(Error::NotFound)?;
    let signature = headers
        .get("x-blackwall-signature")
        .and_then(|s| s.to_str().ok())
        .and_then(|s| hex::decode(s.strip_prefix("sha256=").unwrap_or(s)).ok())
        .ok_or(Error::Unauthorized)?;
    let mut mac = Hmac::<Sha256>::new_from_slice(integration.secret.as_bytes())
        .map_err(|e| Error::Internal(e.to_string()))?;
    mac.update(&body);
    mac.verify_slice(&signature)
        .map_err(|_| Error::Unauthorized)?;
    let input: IncomingLink =
        serde_json::from_slice(&body).map_err(|e| Error::BadRequest(e.to_string()))?;
    if before.activity.iter().any(|a| a.id == input.delivery_id) {
        return Ok(Json(CommandResponse {
            revision,
            result: CommandResult {
                id: Some(input.issue_id),
            },
        }));
    }
    let owner = before
        .members
        .iter()
        .find(|m| m.role == Role::Owner)
        .ok_or(Error::Forbidden)?
        .user_id;
    let mut w = before.clone();
    let result = w.apply(
        owner,
        Command::AddSourceLink {
            issue_id: input.issue_id,
            url: input.url,
            title: input.title,
        },
        Utc::now(),
    )?;
    if let Some(activity) = w.activity.last_mut() {
        activity.id = input.delivery_id;
        activity.action = "integration.source_link".into();
    }
    let jobs = outgoing(&before, &w);
    let revision = store.commit_workspace(&w, revision, &jobs, None).await?;
    Ok(Json(CommandResponse { revision, result }))
}
#[derive(OpenApi)]
#[openapi(
    paths(
        health,
        register,
        login,
        logout,
        me,
        edit_profile,
        change_password,
        reset_request,
        reset_password,
        workspaces,
        create_workspace,
        workspace,
        command,
        issues,
        issue_detail,
        members,
        search,
        report,
        accept_invitation,
        markdown,
        upload,
        download,
        export,
        import,
        incoming
    ),
    components(schemas(
        CommandRequest,
        CommandResponse,
        Command,
        WorkspaceResponse,
        Workspace,
        IssueFilter,
        crate::error::ErrorBody
    )),
    info(
        title = "Blackwall API",
        version = "0.1.0",
        description = "Workspace-scoped work management. Commands require the current workspace revision. Authenticate with Authorization: Bearer <token> or the HttpOnly session cookie plus X-CSRF-Token for mutations."
    )
)]
pub struct ApiDoc;
async fn schema() -> Json<utoipa::openapi::OpenApi> {
    Json(ApiDoc::openapi())
}
fn public_profile(p: Profile, w: &Workspace) -> MemberProfile {
    MemberProfile {
        id: p.id,
        email: p.email,
        display_name: p.display_name,
        avatar_url: p.avatar_url,
        contact: p.contact,
        team_ids: w
            .teams
            .iter()
            .filter(|t| t.members.contains(&p.id))
            .map(|t| t.id)
            .collect(),
    }
}
