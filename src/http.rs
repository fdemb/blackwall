use crate::{
    auth::{self, *},
    domain::*,
    error::{Error, Result},
    ids::WorkspaceId,
    store::{CollectionQuery, OperationResult, Store},
};
use axum::{
    Json, Router,
    extract::Request,
    extract::{DefaultBodyLimit, FromRequestParts, Path, Query, State},
    http::{HeaderMap, HeaderValue, StatusCode, header, request::Parts},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use utoipa::OpenApi;
use uuid::Uuid;

mod files;
pub(crate) use files::attachment_response;
use files::{download, export, import, incoming, upload};
mod sync;
use sync::{bootstrap, events, pull, push, scope};

pub struct Actor {
    pub profile: Profile,
    /// Non-secret replica name from the session row. Never a credential.
    pub session_id: Uuid,
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

        let user_agent = parts
            .headers
            .get(header::USER_AGENT)
            .and_then(|h| h.to_str().ok());
        let (profile, session_id) = store.authenticate(token, user_agent).await?;
        Ok(Self {
            profile,
            session_id,
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
    /// Names the workspace in app URLs. Unique across the server.
    pub slug: String,
    pub version: i64,
}

#[derive(Serialize, utoipa::ToSchema)]
pub struct WorkspaceResponse {
    pub workspace: WorkspaceSummary,
}

#[derive(Deserialize, utoipa::ToSchema)]
pub struct CreateWorkspace {
    pub name: String,
    /// Lowercase letters, digits and single hyphens, at most 48 bytes.
    pub slug: String,
    pub idempotency_key: Option<String>,
}

#[derive(Deserialize, utoipa::ToSchema)]
pub struct CommandRequest {
    #[serde(default)]
    pub expected_versions: Option<BTreeMap<Uuid, i64>>,
    pub idempotency_key: Option<String>,
    pub command: Command,
}

pub type CommandResponse = OperationResult;

#[derive(Deserialize, utoipa::ToSchema)]
pub struct AcceptInvitation {
    pub token: String,
}

#[derive(Deserialize, utoipa::ToSchema)]
pub struct ImportRequest {
    #[serde(default)]
    pub expected_versions: Option<BTreeMap<Uuid, i64>>,
    pub idempotency_key: Option<String>,
    pub issues: Option<Vec<IssueInput>>,
    pub transfer: Option<crate::exchange::Transfer>,
}

#[derive(Serialize, utoipa::ToSchema)]
pub struct ImportResponse {
    pub versions: BTreeMap<Uuid, i64>,
    pub summary: Option<crate::exchange::ImportSummary>,
}

#[derive(Deserialize, utoipa::IntoParams)]
#[into_params(parameter_in = Query)]
pub struct PageQuery {
    #[serde(default = "default_limit")]
    pub limit: i64,
    #[serde(default)]
    pub offset: i64,
    pub issue_id: Option<Uuid>,
    pub entity_id: Option<Uuid>,
}

fn default_limit() -> i64 {
    100
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

#[derive(Serialize, Deserialize, utoipa::ToSchema)]
pub struct MemberProfile {
    pub role: Role,
    pub version: i64,
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

/// Sync reads compress when the request accepts gzip. The event stream route
/// has no layer, so an encoder never buffers its frames.
fn gzip() -> tower_http::compression::CompressionLayer {
    tower_http::compression::CompressionLayer::new().gzip(true)
}

pub fn router(store: Store) -> Router {
    router_with_web(store, crate::web::default_dir())
}

pub fn router_with_web(store: Store, web_dir: std::path::PathBuf) -> Router {
    Router::new()
        .merge(crate::tracker::router())
        .merge(crate::api::router(store.clone()))
        .route("/health", get(health))
        .route("/internal-api/schema.json", get(schema))
        .route("/internal-api/auth/options", get(auth_options))
        .route("/internal-api/auth/register", post(register))
        .route("/internal-api/auth/login", post(login))
        .route("/internal-api/auth/login/totp", post(login_totp))
        .route("/internal-api/auth/totp", get(totp_status))
        .route("/internal-api/auth/totp/setup", post(setup_totp))
        .route("/internal-api/auth/totp/enable", post(enable_totp))
        .route("/internal-api/auth/totp/disable", post(disable_totp))
        .route(
            "/internal-api/auth/totp/recovery-codes",
            post(regenerate_recovery_codes),
        )
        .route("/internal-api/auth/logout", post(logout))
        .route("/internal-api/auth/password", post(change_password))
        .route("/internal-api/auth/reset-request", post(reset_request))
        .route("/internal-api/auth/reset", post(reset_password))
        .route("/internal-api/auth/verify", post(verify_email))
        .route("/internal-api/me", get(me).patch(edit_profile))
        .route("/internal-api/me/sessions", get(sessions))
        .route(
            "/internal-api/me/sessions/revoke-others",
            post(revoke_other_sessions),
        )
        .route(
            "/internal-api/me/sessions/{session}",
            axum::routing::delete(revoke_session),
        )
        .route(
            "/internal-api/me/tokens",
            get(crate::api::tokens::list).post(crate::api::tokens::create),
        )
        .route(
            "/internal-api/me/tokens/{token}",
            axum::routing::delete(crate::api::tokens::revoke),
        )
        .route(
            "/internal-api/workspaces",
            get(workspaces).post(create_workspace),
        )
        .route("/internal-api/workspaces/{id}", get(workspace))
        .route("/internal-api/workspaces/{id}/commands", post(command))
        .route("/internal-api/workspaces/{id}/sync/push", post(push))
        .route(
            "/internal-api/workspaces/{id}/sync/pull",
            get(pull).layer(gzip()),
        )
        .route(
            "/internal-api/workspaces/{id}/sync/bootstrap",
            get(bootstrap).layer(gzip()),
        )
        .route(
            "/internal-api/workspaces/{id}/sync/scope",
            get(scope).layer(gzip()),
        )
        .route("/internal-api/workspaces/{id}/sync/events", get(events))
        .route("/internal-api/workspaces/{id}/issues", get(issues))
        .route(
            "/internal-api/workspaces/{id}/issues/{issue}",
            get(issue_detail),
        )
        .route("/internal-api/workspaces/{id}/members", get(members))
        .route("/internal-api/workspaces/{id}/search", get(search))
        .route("/internal-api/workspaces/{id}/report", get(report))
        .route("/internal-api/workspaces/{id}/usage", get(usage))
        .route(
            "/internal-api/workspaces/{id}/{collection}",
            get(collection),
        )
        .route(
            "/internal-api/workspaces/{id}/invitations/accept",
            post(accept_invitation),
        )
        .route(
            "/internal-api/workspaces/{id}/issues/{issue}/attachments",
            post(upload),
        )
        .route(
            "/api/workspaces/{id}/attachments/{attachment}",
            get(download),
        )
        .route("/internal-api/workspaces/{id}/export", get(export))
        .route(
            "/internal-api/workspaces/{id}/import",
            post(import).layer(DefaultBodyLimit::max(20 * 1024 * 1024)),
        )
        .route(
            "/api/workspaces/{id}/integrations/{integration}/webhook",
            post(incoming),
        )
        .route("/internal-api/markdown", post(markdown))
        .fallback_service(crate::web::service(web_dir))
        .layer(DefaultBodyLimit::max(6 * 1024 * 1024))
        .layer(middleware::from_fn(security_headers))
        .layer(middleware::from_fn(auth_rate_limit))
        .with_state(store)
}

/// Whether the request carries an `Origin` other than this host. Requests
/// without an `Origin` come from non-browser clients and are not cross-origin.
pub(crate) fn cross_origin(headers: &HeaderMap) -> bool {
    let Some(origin) = headers.get(header::ORIGIN) else {
        return false;
    };
    let origin = origin
        .to_str()
        .ok()
        .and_then(|s| reqwest::Url::parse(s).ok());
    let host = headers.get(header::HOST).and_then(|s| s.to_str().ok());
    let origin_host = origin.as_ref().and_then(|url| {
        url.host_str().map(|host| {
            if let Some(port) = url.port() {
                format!("{host}:{port}")
            } else {
                host.to_owned()
            }
        })
    });
    host.is_none() || origin_host.as_deref() != host
}

async fn security_headers(request: Request, next: Next) -> Response {
    // Cookie-authenticated routes refuse cross-origin writes. The token-only
    // public API and MCP endpoint apply their own CORS and origin rules.
    let path = request.uri().path();
    let token_only = path.starts_with("/api/v1/") || path == "/mcp";
    if !token_only
        && !matches!(
            *request.method(),
            axum::http::Method::GET | axum::http::Method::HEAD | axum::http::Method::OPTIONS
        )
        && cross_origin(request.headers())
    {
        return Error::Forbidden.into_response();
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
    if !headers.contains_key(header::CONTENT_SECURITY_POLICY) {
        headers.insert(
            header::CONTENT_SECURITY_POLICY,
            HeaderValue::from_static(
                "default-src 'self'; script-src 'self'; style-src 'self'; \
                 img-src 'self' https:; frame-ancestors 'none'; \
                 base-uri 'none'; form-action 'self'",
            ),
        );
    }
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));

    response
}

async fn auth_rate_limit(request: Request, next: Next) -> Response {
    use std::{
        collections::HashMap,
        sync::{Mutex, OnceLock},
    };

    static LIMIT: OnceLock<Mutex<HashMap<String, (i64, u32)>>> = OnceLock::new();

    if request.uri().path().starts_with("/internal-api/auth/")
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

#[utoipa::path(
    get,
    path = "/internal-api/auth/options",
    responses((status = 200, body = AuthOptions))
)]
async fn auth_options(State(store): State<Store>) -> Json<AuthOptions> {
    Json(AuthOptions {
        registration: store.registration,
        email_verification: store.mail_enabled,
    })
}

#[derive(Serialize, utoipa::ToSchema)]
struct VerificationSent {
    verification_sent: bool,
}

#[utoipa::path(
    post,
    path = "/internal-api/auth/register",
    request_body = Register,
    responses(
        (status = 200, body = Session),
        (status = 202, description = "The account signs in once its email address is verified", body = VerificationSent),
        (status = 400, body = crate::error::ErrorBody),
        (status = 403, description = "Registration is by invitation only", body = crate::error::ErrorBody),
        (status = 409, body = crate::error::ErrorBody)
    )
)]
async fn register(State(store): State<Store>, Json(input): Json<Register>) -> Result<Response> {
    match store.register(input).await? {
        Registered::Session(session) => session_response(session),
        Registered::VerificationSent => Ok((
            StatusCode::ACCEPTED,
            Json(VerificationSent {
                verification_sent: true,
            }),
        )
            .into_response()),
    }
}

#[utoipa::path(
    post,
    path = "/internal-api/auth/login",
    request_body = Login,
    responses(
        (status = 200, body = Session),
        (status = 202, description = "The account needs a TOTP or recovery code at /internal-api/auth/login/totp", body = PendingLogin),
        (status = 401, body = crate::error::ErrorBody),
        (status = 403, description = "The email address is not verified yet", body = crate::error::ErrorBody)
    )
)]
async fn login(State(store): State<Store>, Json(input): Json<Login>) -> Result<Response> {
    match store.login(input).await? {
        SignIn::Session(session) => session_response(session),
        SignIn::TotpRequired(pending) => Ok((StatusCode::ACCEPTED, Json(pending)).into_response()),
    }
}

#[utoipa::path(
    post,
    path = "/internal-api/auth/login/totp",
    request_body = TotpLogin,
    responses(
        (status = 200, body = Session),
        (status = 400, description = "The pending sign-in expired or took too many wrong codes", body = crate::error::ErrorBody),
        (status = 401, description = "The code is wrong or already used", body = crate::error::ErrorBody)
    )
)]
async fn login_totp(State(store): State<Store>, Json(input): Json<TotpLogin>) -> Result<Response> {
    session_response(store.login_totp(input).await?)
}

#[utoipa::path(
    get,
    path = "/internal-api/auth/totp",
    responses((status = 200, body = TotpStatus))
)]
async fn totp_status(State(store): State<Store>, actor: Actor) -> Result<Json<TotpStatus>> {
    Ok(Json(store.totp_status(actor.profile.id).await?))
}

/// Starts TOTP setup with a new secret. TOTP stays off until enabled with a code.
#[utoipa::path(
    post,
    path = "/internal-api/auth/totp/setup",
    responses((status = 200, body = TotpSetup), (status = 409, body = crate::error::ErrorBody))
)]
async fn setup_totp(State(store): State<Store>, actor: Actor) -> Result<Json<TotpSetup>> {
    Ok(Json(
        store.setup_totp(&actor.profile, actor.session_id).await?,
    ))
}

/// Turns TOTP on and signs out every other session.
#[utoipa::path(
    post,
    path = "/internal-api/auth/totp/enable",
    request_body = TotpEnable,
    responses((status = 200, body = RecoveryCodes), (status = 400, body = crate::error::ErrorBody))
)]
async fn enable_totp(
    State(store): State<Store>,
    actor: Actor,
    Json(input): Json<TotpEnable>,
) -> Result<Json<RecoveryCodes>> {
    Ok(Json(
        store
            .enable_totp(actor.profile.id, actor.session_id, input)
            .await?,
    ))
}

/// Turns TOTP off and signs out every other session.
#[utoipa::path(
    post,
    path = "/internal-api/auth/totp/disable",
    request_body = TotpConfirm,
    responses((status = 204), (status = 400, body = crate::error::ErrorBody))
)]
async fn disable_totp(
    State(store): State<Store>,
    actor: Actor,
    Json(input): Json<TotpConfirm>,
) -> Result<StatusCode> {
    store
        .disable_totp(actor.profile.id, actor.session_id, input)
        .await?;

    Ok(StatusCode::NO_CONTENT)
}

#[utoipa::path(
    post,
    path = "/internal-api/auth/totp/recovery-codes",
    request_body = TotpConfirm,
    responses((status = 200, body = RecoveryCodes), (status = 400, body = crate::error::ErrorBody))
)]
async fn regenerate_recovery_codes(
    State(store): State<Store>,
    actor: Actor,
    Json(input): Json<TotpConfirm>,
) -> Result<Json<RecoveryCodes>> {
    Ok(Json(
        store
            .regenerate_recovery_codes(actor.profile.id, input)
            .await?,
    ))
}

#[utoipa::path(
    post,
    path = "/internal-api/auth/logout",
    responses((status = 204))
)]
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

#[derive(Serialize, utoipa::ToSchema)]
pub struct MeResponse {
    #[serde(flatten)]
    pub profile: Profile,
    pub session_id: Uuid,
}

#[utoipa::path(
    get,
    path = "/internal-api/me",
    responses((status = 200, body = MeResponse))
)]
async fn me(actor: Actor) -> Result<Response> {
    let csrf = HeaderValue::from_str(&auth::csrf(&actor.token))
        .map_err(|e| Error::Internal(e.to_string()))?;
    let mut response = Json(MeResponse {
        profile: actor.profile,
        session_id: actor.session_id,
    })
    .into_response();
    response.headers_mut().insert("x-csrf-token", csrf);

    Ok(response)
}

#[utoipa::path(
    patch,
    path = "/internal-api/me",
    request_body = ProfileEdit,
    responses((status = 200, body = Profile))
)]
async fn edit_profile(
    State(store): State<Store>,
    actor: Actor,
    Json(input): Json<ProfileEdit>,
) -> Result<Json<Profile>> {
    Ok(Json(store.edit_profile(actor.profile, input).await?))
}

#[utoipa::path(
    post,
    path = "/internal-api/auth/password",
    request_body = PasswordChange,
    responses((status = 204))
)]
async fn change_password(
    State(store): State<Store>,
    actor: Actor,
    Json(input): Json<PasswordChange>,
) -> Result<StatusCode> {
    store
        .change_password(actor.profile.id, actor.session_id, input)
        .await?;

    Ok(StatusCode::NO_CONTENT)
}

#[utoipa::path(
    get,
    path = "/internal-api/me/sessions",
    responses((status = 200, body = Vec<SessionInfo>))
)]
async fn sessions(State(store): State<Store>, actor: Actor) -> Result<Json<Vec<SessionInfo>>> {
    Ok(Json(
        store.sessions(actor.profile.id, actor.session_id).await?,
    ))
}

#[utoipa::path(
    delete,
    path = "/internal-api/me/sessions/{session}",
    params(("session" = Uuid, Path)),
    responses((status = 204), (status = 404, body = crate::error::ErrorBody))
)]
async fn revoke_session(
    State(store): State<Store>,
    actor: Actor,
    Path(id): Path<Uuid>,
) -> Result<StatusCode> {
    store.revoke_session(actor.profile.id, id).await?;

    Ok(StatusCode::NO_CONTENT)
}

/// Signs out every session of the user except the one making the request.
#[utoipa::path(
    post,
    path = "/internal-api/me/sessions/revoke-others",
    responses((status = 200, body = RevokedSessions))
)]
async fn revoke_other_sessions(
    State(store): State<Store>,
    actor: Actor,
) -> Result<Json<RevokedSessions>> {
    Ok(Json(RevokedSessions {
        revoked: store
            .revoke_other_sessions(actor.profile.id, actor.session_id)
            .await?,
    }))
}

#[utoipa::path(
    post,
    path = "/internal-api/auth/reset-request",
    request_body = ResetRequest,
    responses((status = 202))
)]
async fn reset_request(
    State(store): State<Store>,
    Json(input): Json<ResetRequest>,
) -> Result<StatusCode> {
    store.request_reset(input).await?;

    Ok(StatusCode::ACCEPTED)
}

#[utoipa::path(
    post,
    path = "/internal-api/auth/reset",
    request_body = ResetPassword,
    responses((status = 204))
)]
async fn reset_password(
    State(store): State<Store>,
    Json(input): Json<ResetPassword>,
) -> Result<StatusCode> {
    store.reset_password(input).await?;

    Ok(StatusCode::NO_CONTENT)
}

#[utoipa::path(
    post,
    path = "/internal-api/auth/verify",
    request_body = VerifyEmail,
    responses(
        (status = 204),
        (status = 400, body = crate::error::ErrorBody)
    )
)]
async fn verify_email(
    State(store): State<Store>,
    Json(input): Json<VerifyEmail>,
) -> Result<StatusCode> {
    store.verify_email(input).await?;

    Ok(StatusCode::NO_CONTENT)
}

#[utoipa::path(
    get,
    path = "/health",
    responses((status = 200, body = Health))
)]
async fn health(State(store): State<Store>) -> Result<Json<Health>> {
    sqlx::query("SELECT 1").execute(&store.pool).await?;

    Ok(Json(Health {
        status: "ok".into(),
    }))
}

#[utoipa::path(
    get,
    path = "/internal-api/workspaces",
    responses((status = 200, body = Vec<WorkspaceSummary>))
)]
async fn workspaces(State(store): State<Store>, actor: Actor) -> Result<Json<Vec<Value>>> {
    Ok(Json(store.list_workspaces(actor.profile.id).await?))
}

#[utoipa::path(
    post,
    path = "/internal-api/workspaces",
    request_body = CreateWorkspace,
    responses((status = 200, body = WorkspaceResponse))
)]
async fn create_workspace(
    State(store): State<Store>,
    actor: Actor,
    Json(input): Json<CreateWorkspace>,
) -> Result<Json<Value>> {
    Ok(Json(json!({
        "workspace": store
            .create_workspace_with_key(
                input.name,
                input.slug,
                actor.profile.id,
                input.idempotency_key
            )
            .await?
    })))
}

#[utoipa::path(
    get,
    path = "/internal-api/workspaces/{id}",
    params(("id" = Uuid, Path)),
    responses((status = 200, body = WorkspaceResponse))
)]
async fn workspace(
    State(store): State<Store>,
    actor: Actor,
    Path(id): Path<WorkspaceId>,
) -> Result<Json<Value>> {
    Ok(Json(store.workspace_metadata(id, actor.profile.id).await?))
}

#[utoipa::path(
    post,
    path = "/internal-api/workspaces/{id}/commands",
    params(("id" = Uuid, Path)),
    request_body = CommandRequest,
    responses(
        (status = 200, body = CommandResponse),
        (status = 409, body = crate::error::ErrorBody)
    )
)]
async fn command(
    State(store): State<Store>,
    actor: Actor,
    Path(id): Path<WorkspaceId>,
    Json(input): Json<CommandRequest>,
) -> Result<Json<CommandResponse>> {
    if matches!(
        input.command,
        Command::AddAttachment { .. } | Command::AttachCommentFile { .. }
    ) {
        return Err(Error::BadRequest(
            "use the attachment upload endpoint".into(),
        ));
    }

    Ok(Json(
        store
            .operation(
                id,
                actor.profile.id,
                input.command,
                input.expected_versions.unwrap_or_default(),
                input.idempotency_key,
                None,
            )
            .await?,
    ))
}

#[utoipa::path(
    get,
    path = "/internal-api/workspaces/{id}/issues",
    params(("id" = Uuid, Path), IssueFilter, PageQuery),
    responses((status = 200, body = Value))
)]
async fn issues(
    State(store): State<Store>,
    actor: Actor,
    Path(id): Path<WorkspaceId>,
    Query(filter): Query<IssueFilter>,
    Query(input): Query<PageQuery>,
) -> Result<Json<Value>> {
    Ok(Json(
        store
            .list_issues(id, actor.profile.id, filter, input.limit, input.offset)
            .await?,
    ))
}

#[utoipa::path(
    get,
    path = "/internal-api/workspaces/{id}/issues/{issue}",
    params(
        ("id" = Uuid, Path),
        ("issue" = Uuid, Path)
    ),
    responses((status = 200, body = Issue))
)]
async fn issue_detail(
    State(store): State<Store>,
    actor: Actor,
    Path((id, issue)): Path<(WorkspaceId, Uuid)>,
) -> Result<Json<Issue>> {
    Ok(Json(store.get_issue(id, actor.profile.id, issue).await?))
}

#[utoipa::path(
    get,
    path = "/internal-api/workspaces/{id}/{collection}",
    params(("id" = Uuid, Path), ("collection" = String, Path), PageQuery),
    responses((status = 200, body = Value)),
    description = "Paginated teams, labels, projects, milestones, sprints, views, notifications, alert_preferences, invitations, integrations, activity, comments or time_entries. Private records are restricted to their owner or workspace administrators."
)]
async fn collection(
    State(store): State<Store>,
    actor: Actor,
    Path((id, kind)): Path<(WorkspaceId, String)>,
    Query(input): Query<PageQuery>,
) -> Result<Json<Value>> {
    Ok(Json(
        store
            .collection(
                id,
                actor.profile.id,
                &kind,
                CollectionQuery {
                    limit: input.limit,
                    offset: input.offset,
                    issue_id: input.issue_id,
                    entity_id: input.entity_id,
                },
            )
            .await?,
    ))
}

#[utoipa::path(
    get,
    path = "/internal-api/workspaces/{id}/members",
    params(("id" = Uuid, Path)),
    responses((status = 200, body = Vec<MemberProfile>))
)]
async fn members(
    State(store): State<Store>,
    actor: Actor,
    Path(id): Path<WorkspaceId>,
) -> Result<Json<Value>> {
    Ok(Json(
        store.member_profiles(id, actor.profile.id, None).await?,
    ))
}

#[utoipa::path(
    get,
    path = "/internal-api/workspaces/{id}/search",
    params(
        ("id" = Uuid, Path),
        ("q" = String, Query)
    ),
    responses((status = 200, body = SearchResult))
)]
async fn search(
    State(store): State<Store>,
    actor: Actor,
    Path(id): Path<WorkspaceId>,
    Query(input): Query<SearchQuery>,
) -> Result<Json<Value>> {
    if input.q.len() > 200 {
        return Err(Error::BadRequest("search query too long".into()));
    }

    let mut live_page = store
        .list_issues(
            id,
            actor.profile.id,
            IssueFilter {
                search: Some(input.q.clone()),
                ..Default::default()
            },
            100,
            0,
        )
        .await?;
    // Global search spans the archive; live matches rank first.
    let archived_page = store
        .list_issues(
            id,
            actor.profile.id,
            IssueFilter {
                search: Some(input.q.clone()),
                archived: true,
                ..Default::default()
            },
            100,
            0,
        )
        .await?;
    let mut items = live_page["items"].as_array().cloned().unwrap_or_default();
    items.extend(
        archived_page["items"]
            .as_array()
            .cloned()
            .unwrap_or_default(),
    );
    items.truncate(100);
    live_page["items"] = Value::Array(items);
    let issue_page = live_page;
    let people = store
        .member_profiles(id, actor.profile.id, Some(&input.q))
        .await?;

    Ok(Json(
        json!({"issues": issue_page["items"], "people": people}),
    ))
}

#[utoipa::path(
    get,
    path = "/internal-api/workspaces/{id}/report",
    params(("id" = Uuid, Path)),
    responses((status = 200, body = Value))
)]
async fn report(
    State(store): State<Store>,
    actor: Actor,
    Path(id): Path<WorkspaceId>,
) -> Result<Json<Value>> {
    Ok(Json(store.report_sql(id, actor.profile.id).await?))
}

#[utoipa::path(
    get,
    path = "/internal-api/workspaces/{id}/usage",
    params(("id" = Uuid, Path)),
    responses((status = 200, body = [crate::limits::Usage]))
)]
async fn usage(
    State(store): State<Store>,
    actor: Actor,
    Path(id): Path<WorkspaceId>,
) -> Result<Json<Vec<crate::limits::Usage>>> {
    Ok(Json(store.usage(id, actor.profile.id).await?))
}

#[utoipa::path(
    post,
    path = "/internal-api/workspaces/{id}/invitations/accept",
    params(("id" = Uuid, Path)),
    request_body = AcceptInvitation,
    responses((status = 200, body = WorkspaceResponse))
)]
async fn accept_invitation(
    State(store): State<Store>,
    actor: Actor,
    Path(id): Path<WorkspaceId>,
    Json(input): Json<AcceptInvitation>,
) -> Result<Json<Value>> {
    store
        .accept_invitation(id, actor.profile.id, &actor.profile.email, &input.token)
        .await?;

    Ok(Json(store.workspace_metadata(id, actor.profile.id).await?))
}

#[utoipa::path(
    post,
    path = "/internal-api/markdown",
    request_body = MarkdownRequest,
    responses((status = 200, body = MarkdownResponse))
)]
async fn markdown(
    _actor: Actor,
    Json(input): Json<MarkdownRequest>,
) -> Result<Json<MarkdownResponse>> {
    if input.text.len() > 100_000 {
        return Err(Error::BadRequest("markdown exceeds 100 KB".into()));
    }

    use pulldown_cmark::{Event, Parser, Tag, TagEnd};
    static SANITIZER: std::sync::LazyLock<ammonia::Builder<'static>> =
        std::sync::LazyLock::new(|| {
            let mut builder = ammonia::Builder::default();
            builder.add_allowed_classes("span", ["mention"]);
            builder
        });

    // Links cannot nest, so one flag pairs each mention's end with its start.
    let mut in_mention = false;
    let events = Parser::new_ext(&input.text, MARKDOWN_OPTIONS).map(|event| match event {
        Event::Start(Tag::Link { ref dest_url, .. }) if dest_url.starts_with(MENTION_SCHEME) => {
            in_mention = true;
            Event::Html(r#"<span class="mention">"#.into())
        }
        Event::End(TagEnd::Link) if in_mention => {
            in_mention = false;
            Event::Html("</span>".into())
        }
        event => event,
    });
    let mut html = String::new();
    pulldown_cmark::html::push_html(&mut html, events);

    Ok(Json(MarkdownResponse {
        html: SANITIZER.clean(&html).to_string(),
    }))
}

#[derive(OpenApi)]
#[openapi(
    paths(
        health,
        auth_options,
        register,
        login,
        login_totp,
        totp_status,
        setup_totp,
        enable_totp,
        disable_totp,
        regenerate_recovery_codes,
        logout,
        me,
        edit_profile,
        change_password,
        sessions,
        revoke_session,
        revoke_other_sessions,
        reset_request,
        reset_password,
        verify_email,
        workspaces,
        create_workspace,
        workspace,
        command,
        sync::push,
        sync::pull,
        sync::bootstrap,
        sync::scope,
        sync::events,
        issues,
        issue_detail,
        members,
        search,
        report,
        usage,
        collection,
        accept_invitation,
        markdown,
        files::upload,
        files::download,
        files::export,
        files::import,
        files::incoming,
        crate::api::tokens::list,
        crate::api::tokens::create,
        crate::api::tokens::revoke
    ),
    components(schemas(
        CommandRequest,
        CommandResponse,
        crate::store::Change,
        Command,
        WorkspaceResponse,
        Workspace,
        IssueFilter,
        crate::domain::FilterClause,
        MeResponse,
        crate::store::PushRequest,
        crate::store::PushResponse,
        crate::store::SyncMutation,
        crate::store::MutationResult,
        crate::store::MutationError,
        crate::store::MutationStatus,
        crate::store::PullResponse,
        crate::store::ScopeResponse,
        crate::error::ErrorBody,
        crate::limits::Usage,
        crate::limits::Resource,
        AuthOptions,
        RegistrationMode,
        InvitationProof,
        VerificationSent,
        VerifyEmail
    )),
    info(
        title = "Blackwall internal API",
        version = "0.1.0",
        description = "The web app's own API. It may change without notice; integrations should use /api/v1 (see /api/v1/openapi.json). Workspace-scoped work management. Commands require versions of affected entities. Authenticate with Authorization: Bearer <token> or the HttpOnly session cookie plus X-CSRF-Token for mutations."
    )
)]
pub struct ApiDoc;

async fn schema() -> Json<utoipa::openapi::OpenApi> {
    Json(ApiDoc::openapi())
}
