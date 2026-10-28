//! The public `/api/v1` surface. Personal access tokens authenticate it; each
//! request acts as the token's user, narrowed by the token's access level and
//! workspace allowlist. Writes translate to the same `Command`s the app runs,
//! so validation, permissions, activity and webhooks match the app exactly.

use crate::{
    domain::{Command, ViaKind, ViaToken},
    error::{Error, Result},
    ids::WorkspaceId,
    store::{OperationResult, Store},
};
use axum::{
    Json, Router,
    extract::{FromRequestParts, Request, State},
    http::{HeaderMap, HeaderValue, StatusCode, header, request::Parts},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use utoipa::OpenApi;
use uuid::Uuid;

pub mod directory;
pub mod issues;
pub mod resources;
pub mod tokens;
pub(crate) mod webhooks;

pub use issues::{ApiComment, ApiIssue, CreateComment, CreateIssue, IssueQuery, UpdateIssue};
pub use tokens::{Access, TokenGrant};

/// The authenticated token behind a public API request, and whether it came through
/// `/api/v1` or `/mcp`.
#[derive(Clone, Debug)]
pub struct ApiActor(pub TokenGrant, pub ViaKind);

/// A workspace the token may act in, at the access level it was checked for.
/// Handlers take one of these, so a token's scope can't be skipped.
#[derive(Clone, Copy, Debug)]
pub struct Scope {
    pub workspace: WorkspaceId,
    pub user: Uuid,
    /// Recorded on every write, so activity and comments say which token acted.
    pub token: ViaToken,
}

impl ApiActor {
    pub fn user(&self) -> Uuid {
        self.0.user
    }

    pub fn allows(&self, workspace: WorkspaceId) -> bool {
        self.0
            .workspaces
            .as_ref()
            .is_none_or(|ids| ids.contains(&workspace.0))
    }

    pub fn read(&self, workspace: WorkspaceId) -> Result<Scope> {
        if !self.allows(workspace) {
            return Err(Error::Denied(
                "this token is not allowed to access the workspace".into(),
            ));
        }
        Ok(Scope {
            workspace,
            user: self.0.user,
            token: ViaToken {
                kind: self.1,
                token_id: self.0.token_id,
            },
        })
    }

    pub fn write(&self, workspace: WorkspaceId) -> Result<Scope> {
        match self.0.access {
            Access::Write => self.read(workspace),
            Access::Comment => Err(Error::Denied(
                "this token may only read and write comments".into(),
            )),
            Access::Read => Err(Error::Denied("this token is read-only".into())),
        }
    }

    /// Writing, editing or deleting comments, which comment tokens may also do.
    pub fn comment(&self, workspace: WorkspaceId) -> Result<Scope> {
        match self.0.access {
            Access::Write | Access::Comment => self.read(workspace),
            Access::Read => Err(Error::Denied("this token is read-only".into())),
        }
    }
}

impl FromRequestParts<Store> for ApiActor {
    type Rejection = Error;

    async fn from_request_parts(parts: &mut Parts, _: &Store) -> Result<Self> {
        parts
            .extensions
            .get::<ApiActor>()
            .cloned()
            .ok_or(Error::Unauthorized)
    }
}

/// Authenticates the bearer token, applies its rate limit and reports the limit.
async fn authenticate(State(store): State<Store>, mut request: Request, next: Next) -> Response {
    let secret = request
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|h| h.to_str().ok())
        .and_then(|h| h.strip_prefix("Bearer "))
        .map(str::trim);
    let grant = match secret {
        Some(secret) => store.authenticate_api_token(secret).await,
        None => Err(Error::Unauthorized),
    };
    let grant = match grant {
        Ok(grant) => grant,
        Err(error) => {
            let mut response = error.into_response();
            if response.status() == StatusCode::UNAUTHORIZED {
                response.headers_mut().insert(
                    header::WWW_AUTHENTICATE,
                    HeaderValue::from_static("Bearer realm=\"blackwall\""),
                );
            }
            return response;
        }
    };

    let window = rate_limit(grant.token_id);
    if window.remaining.is_none() {
        let mut response = (
            StatusCode::TOO_MANY_REQUESTS,
            Json(crate::error::ErrorBody {
                error: "rate limit exceeded".into(),
            }),
        )
            .into_response();
        window.write(response.headers_mut());
        response
            .headers_mut()
            .insert(header::RETRY_AFTER, HeaderValue::from(window.reset));
        return response;
    }

    let kind = if request.uri().path() == "/mcp" {
        ViaKind::Mcp
    } else {
        ViaKind::Api
    };
    request.extensions_mut().insert(ApiActor(grant, kind));
    let mut response = next.run(request).await;
    window.write(response.headers_mut());
    response
}

struct Window {
    limit: u32,
    /// None once the window is exhausted.
    remaining: Option<u32>,
    /// Seconds until the window resets.
    reset: u64,
}

impl Window {
    fn write(&self, headers: &mut HeaderMap) {
        headers.insert("x-ratelimit-limit", HeaderValue::from(self.limit));
        headers.insert(
            "x-ratelimit-remaining",
            HeaderValue::from(self.remaining.unwrap_or(0)),
        );
        headers.insert("x-ratelimit-reset", HeaderValue::from(self.reset));
    }
}

/// Per-token fixed one-minute windows, held in this process. Several server
/// processes each enforce the limit separately.
fn rate_limit(token: Uuid) -> Window {
    use std::{
        collections::HashMap,
        sync::{Mutex, OnceLock},
    };

    static LIMIT: OnceLock<u32> = OnceLock::new();
    static WINDOWS: OnceLock<Mutex<HashMap<Uuid, (i64, u32)>>> = OnceLock::new();

    let limit = *LIMIT.get_or_init(|| {
        std::env::var("API_RATE_LIMIT_PER_MINUTE")
            .ok()
            .and_then(|v| v.parse().ok())
            .filter(|v| *v > 0)
            .unwrap_or(600)
    });
    let now = chrono::Utc::now().timestamp();
    let minute = now - now.rem_euclid(60);
    let count = {
        let mut windows = WINDOWS
            .get_or_init(|| Mutex::new(HashMap::new()))
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if windows.len() > 10_000 {
            windows.retain(|_, (start, _)| *start == minute);
        }
        let entry = windows.entry(token).or_insert((minute, 0));
        if entry.0 != minute {
            *entry = (minute, 0);
        }
        entry.1 = entry.1.saturating_add(1);
        entry.1
    };

    Window {
        limit,
        remaining: limit.checked_sub(count),
        reset: (minute + 60 - now) as u64,
    }
}

/// `limit` and `cursor` for list endpoints.
#[derive(Deserialize, utoipa::IntoParams)]
#[into_params(parameter_in = Query)]
pub struct PageParams {
    /// 1 to 200; defaults to 50.
    pub limit: Option<i64>,
    /// `next_cursor` from the previous page.
    pub cursor: Option<String>,
}

#[derive(Serialize, utoipa::ToSchema)]
pub struct Page<T> {
    pub data: Vec<T>,
    /// Pass as `cursor` for the next page. Null on the last page.
    pub next_cursor: Option<String>,
    /// How many records match across every page. Issue lists report it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total: Option<i64>,
}

#[derive(Serialize, Deserialize)]
enum Cursor {
    #[serde(rename = "o")]
    Offset(i64),
    /// The store's own keyset cursor for updated-order issue lists.
    #[serde(rename = "a")]
    After(String),
}

impl Cursor {
    fn encode(&self) -> String {
        URL_SAFE_NO_PAD.encode(serde_json::to_vec(self).unwrap_or_default())
    }

    fn decode(text: Option<&str>) -> Result<Self> {
        let Some(text) = text else {
            return Ok(Self::Offset(0));
        };
        URL_SAFE_NO_PAD
            .decode(text)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .filter(|c| !matches!(c, Self::Offset(o) if *o < 0))
            .ok_or_else(|| Error::BadRequest("invalid cursor".into()))
    }
}

impl PageParams {
    fn limit(&self) -> Result<i64> {
        match self.limit {
            None => Ok(50),
            Some(limit @ 1..=200) => Ok(limit),
            Some(_) => Err(Error::BadRequest("limit must be between 1 and 200".into())),
        }
    }

    fn offset(&self) -> Result<i64> {
        match Cursor::decode(self.cursor.as_deref())? {
            Cursor::Offset(offset) => Ok(offset),
            Cursor::After(_) => Err(Error::BadRequest("invalid cursor".into())),
        }
    }
}

/// Converts a store page (`{items, has_more, next_offset}`) into typed records.
fn page_of<T: serde::de::DeserializeOwned>(value: serde_json::Value) -> Result<Page<T>> {
    let next_cursor = value["next_offset"]
        .as_i64()
        .map(|offset| Cursor::Offset(offset).encode());
    Ok(Page {
        data: serde_json::from_value(value["items"].clone())?,
        next_cursor,
        total: None,
    })
}

/// `If-Match` and `Idempotency-Key` on writes.
#[derive(Default)]
pub struct WriteOptions {
    pub if_match: Option<i64>,
    pub idempotency_key: Option<String>,
    /// What a keyed request sent, recorded by `fingerprint`.
    pub sent: Option<serde_json::Value>,
    /// The key this step ran under before requests were fingerprinted.
    pub legacy_key: Option<String>,
}

impl WriteOptions {
    /// Options for a later command of a request that runs several. Header values can't
    /// carry `·`, so no client key collides with the step's key, and hashing keeps it short.
    pub fn step(&self, step: &str) -> Self {
        use sha2::{Digest, Sha256};

        Self {
            if_match: self.if_match,
            idempotency_key: self
                .idempotency_key
                .as_ref()
                .map(|key| format!("{step}·{}", hex::encode(Sha256::digest(key)))),
            sent: self.sent.clone().map(|mut sent| {
                sent["step"] = step.into();
                sent
            }),
            legacy_key: self
                .idempotency_key
                .as_ref()
                .map(|key| format!("{key}:{step}")),
        }
    }
}

#[derive(Clone)]
struct SentRequest(serde_json::Value);

/// Records the method, path and body hash of a request carrying an `Idempotency-Key`.
/// Replays are matched against this rather than the command, because PATCH handlers
/// fill omitted fields from the record as it is when the request arrives.
async fn fingerprint(request: Request, next: Next) -> Response {
    use axum::{body::Bytes, extract::FromRequest};
    use sha2::{Digest, Sha256};

    if !request.headers().contains_key("idempotency-key") {
        return next.run(request).await;
    }
    let (mut parts, body) = request.into_parts();
    // Buffer through the extractor handlers use, so limits and read errors answer the same.
    let mut buffered = Request::new(body);
    *buffered.extensions_mut() = parts.extensions.clone();
    let bytes = match Bytes::from_request(buffered, &()).await {
        Ok(bytes) => bytes,
        Err(rejection) => return rejection.into_response(),
    };
    let canonical = serde_json::from_slice::<serde_json::Value>(&bytes)
        .map(|value| canonical_json(&value).into_bytes());
    let hashed = canonical.as_deref().unwrap_or(&bytes[..]);
    parts.extensions.insert(SentRequest(serde_json::json!({
        "method": parts.method.as_str(),
        "path": parts.uri.path_and_query().map(|p| p.as_str()),
        "body_sha256": hex::encode(Sha256::digest(hashed)),
    })));
    next.run(Request::from_parts(parts, axum::body::Body::from(bytes)))
        .await
}

/// JSON text with object keys sorted at every depth and no whitespace, so bodies that
/// differ only in key order or formatting hash the same.
fn canonical_json(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::Object(map) => {
            let mut entries: Vec<_> = map.iter().collect();
            entries.sort_by_key(|(key, _)| *key);
            let fields: Vec<String> = entries
                .into_iter()
                .map(|(key, value)| {
                    format!(
                        "{}:{}",
                        serde_json::Value::String(key.clone()),
                        canonical_json(value)
                    )
                })
                .collect();
            format!("{{{}}}", fields.join(","))
        }
        serde_json::Value::Array(items) => {
            let items: Vec<String> = items.iter().map(canonical_json).collect();
            format!("[{}]", items.join(","))
        }
        scalar => scalar.to_string(),
    }
}

impl FromRequestParts<Store> for WriteOptions {
    type Rejection = Error;

    async fn from_request_parts(parts: &mut Parts, _: &Store) -> Result<Self> {
        let text = |name| {
            parts
                .headers
                .get(name)
                .map(|h| {
                    h.to_str()
                        .map(str::trim)
                        .map_err(|_| Error::BadRequest(format!("invalid {name} header")))
                })
                .transpose()
        };
        let if_match = match text(header::IF_MATCH.as_str())? {
            None | Some("*") => None,
            Some(tag) => Some(parse_etag(tag)?),
        };
        let idempotency_key = text("idempotency-key")?.map(str::to_owned);
        if idempotency_key
            .as_ref()
            .is_some_and(|key| key.is_empty() || key.len() > 200)
        {
            return Err(Error::BadRequest(
                "Idempotency-Key must contain 1 to 200 bytes".into(),
            ));
        }
        Ok(Self {
            if_match,
            idempotency_key,
            sent: parts
                .extensions
                .get::<SentRequest>()
                .map(|sent| sent.0.clone()),
            legacy_key: None,
        })
    }
}

fn parse_etag(tag: &str) -> Result<i64> {
    tag.trim_start_matches("W/")
        .trim_matches('"')
        .parse()
        .map_err(|_| Error::BadRequest("If-Match must be an ETag from this API".into()))
}

pub fn etag(version: i64) -> HeaderValue {
    HeaderValue::from_str(&format!("\"{version}\"")).expect("digits are a valid header")
}

/// A JSON body with the record's version as its ETag.
pub fn tagged<T: Serialize>(status: StatusCode, version: i64, body: T) -> Response {
    let mut response = (status, Json(body)).into_response();
    response.headers_mut().insert(header::ETAG, etag(version));
    response
}

/// Runs one command as the scope's user. `If-Match`, when sent, guards `target`.
/// A keyed request that already completed replays before `command` runs, so merging
/// and resolving against records that changed since can't fail the replay.
pub async fn run(
    store: &Store,
    scope: Scope,
    command: impl Future<Output = Result<Command>>,
    target: Option<Uuid>,
    options: WriteOptions,
) -> Result<OperationResult> {
    let mut expected = BTreeMap::new();
    if let (Some(id), Some(version)) = (target, options.if_match) {
        expected.insert(id, version);
    }
    let guarded = !expected.is_empty();
    if let (Some(key), Some(sent)) = (&options.idempotency_key, &options.sent)
        && let Some(result) = store
            .replay(scope.workspace, scope.user, key, sent.clone(), &expected)
            .await?
    {
        return Ok(result);
    }
    let command = command.await?;
    store
        .operation_via(
            scope.workspace,
            scope.user,
            command,
            expected,
            options.idempotency_key,
            options.legacy_key,
            options.sent,
            None,
            Some(scope.token),
        )
        .await
        .map_err(|error| match error {
            Error::Stale(message) if guarded => Error::PreconditionFailed(message),
            error => error,
        })
}

/// The id a create command returned.
fn created_id(result: &OperationResult) -> Result<Uuid> {
    result
        .result
        .id
        .ok_or_else(|| Error::Internal("create returned no id".into()))
}

pub fn router(store: Store) -> Router<Store> {
    let workspace = "/api/v1/workspaces/{workspace}";
    let authenticated = Router::new()
        .route("/api/v1/me", get(resources::me))
        .route("/api/v1/workspaces", get(resources::workspaces))
        .route(workspace, get(resources::workspace))
        .route(&format!("{workspace}/members"), get(resources::members))
        .route(
            &format!("{workspace}/teams"),
            get(resources::teams).post(resources::create_team),
        )
        .route(
            &format!("{workspace}/teams/{{team}}"),
            get(resources::team)
                .patch(resources::update_team)
                .delete(resources::delete_team),
        )
        .route(
            &format!("{workspace}/teams/{{team}}/stages"),
            get(resources::stages).post(resources::create_stage),
        )
        .route(
            &format!("{workspace}/teams/{{team}}/stages/{{stage}}"),
            get(resources::stage)
                .patch(resources::update_stage)
                .delete(resources::delete_stage),
        )
        .route(
            &format!("{workspace}/labels"),
            get(resources::labels).post(resources::create_label),
        )
        .route(
            &format!("{workspace}/labels/{{label}}"),
            get(resources::label)
                .patch(resources::update_label)
                .delete(resources::delete_label),
        )
        .route(
            &format!("{workspace}/projects"),
            get(resources::projects).post(resources::create_project),
        )
        .route(
            &format!("{workspace}/projects/{{project}}"),
            get(resources::project)
                .patch(resources::update_project)
                .delete(resources::delete_project),
        )
        .route(
            &format!("{workspace}/milestones"),
            get(resources::milestones),
        )
        .route(
            &format!("{workspace}/milestones/{{milestone}}"),
            get(resources::milestone).delete(resources::delete_milestone),
        )
        .route(&format!("{workspace}/sprints"), get(resources::sprints))
        .route(
            &format!("{workspace}/sprints/{{sprint}}"),
            get(resources::sprint),
        )
        .route(
            &format!("{workspace}/issues"),
            get(issues::list).post(issues::create),
        )
        .route(
            &format!("{workspace}/issues/{{issue}}"),
            get(issues::get)
                .patch(issues::update)
                .delete(issues::delete),
        )
        .route(
            &format!("{workspace}/issues/{{issue}}/restore"),
            post(issues::restore),
        )
        .route(
            &format!("{workspace}/issues/{{issue}}/archive"),
            post(issues::archive),
        )
        .route(
            &format!("{workspace}/issues/{{issue}}/unarchive"),
            post(issues::unarchive),
        )
        .route(
            &format!("{workspace}/issues/{{issue}}/activity"),
            get(issues::activity),
        )
        .route(
            &format!("{workspace}/issues/{{issue}}/comments"),
            get(issues::comments).post(issues::create_comment),
        )
        .route(
            &format!("{workspace}/comments/{{comment}}"),
            get(issues::comment)
                .patch(issues::update_comment)
                .delete(issues::delete_comment),
        )
        .route(
            &format!("{workspace}/attachments/{{attachment}}"),
            get(issues::attachment),
        )
        .route(
            &format!("{workspace}/webhooks"),
            get(webhooks::list).post(webhooks::create),
        )
        .route(
            &format!("{workspace}/webhooks/{{webhook}}"),
            get(webhooks::get)
                .patch(webhooks::update)
                .delete(webhooks::delete),
        )
        .layer(middleware::from_fn(fingerprint))
        .layer(middleware::from_fn_with_state(store.clone(), authenticate));
    let v1 = Router::new()
        .route("/api/v1/openapi.json", get(openapi))
        .route("/api/v1/webhook-events", get(webhooks::events))
        .merge(authenticated)
        .layer(cors());

    // Layers run outside in: origin guard, then CORS, then the token.
    let mcp = Router::new()
        .route("/mcp", post(crate::mcp::handle).get(crate::mcp::stream))
        .layer(middleware::from_fn_with_state(store, authenticate))
        .layer(crate::mcp::cors())
        .layer(middleware::from_fn(crate::mcp::guard_origin));

    v1.merge(mcp)
}

/// Response headers browser clients may read.
pub(crate) const EXPOSED_HEADERS: [header::HeaderName; 6] = [
    header::ETAG,
    header::RETRY_AFTER,
    header::WWW_AUTHENTICATE,
    header::HeaderName::from_static("x-ratelimit-limit"),
    header::HeaderName::from_static("x-ratelimit-remaining"),
    header::HeaderName::from_static("x-ratelimit-reset"),
];

/// Any origin may call the API. Only bearer tokens authenticate it, which
/// browsers never attach on their own, so cross-origin calls carry no ambient
/// authority; credentials (cookies) are never allowed.
fn cors() -> tower_http::cors::CorsLayer {
    use axum::http::Method;
    tower_http::cors::CorsLayer::new()
        .allow_origin(tower_http::cors::Any)
        .allow_methods([Method::GET, Method::POST, Method::PATCH, Method::DELETE])
        .allow_headers([
            header::AUTHORIZATION,
            header::CONTENT_TYPE,
            header::IF_MATCH,
            header::HeaderName::from_static("idempotency-key"),
        ])
        .expose_headers(EXPOSED_HEADERS)
        .max_age(std::time::Duration::from_secs(600))
}

#[derive(OpenApi)]
#[openapi(
    paths(
        resources::me,
        resources::workspaces,
        resources::workspace,
        resources::members,
        resources::teams,
        resources::team,
        resources::create_team,
        resources::update_team,
        resources::delete_team,
        resources::stages,
        resources::stage,
        resources::create_stage,
        resources::update_stage,
        resources::delete_stage,
        resources::labels,
        resources::label,
        resources::create_label,
        resources::update_label,
        resources::delete_label,
        resources::projects,
        resources::project,
        resources::create_project,
        resources::update_project,
        resources::delete_project,
        resources::milestones,
        resources::milestone,
        resources::delete_milestone,
        resources::sprints,
        resources::sprint,
        issues::list,
        issues::get,
        issues::create,
        issues::update,
        issues::delete,
        issues::restore,
        issues::archive,
        issues::unarchive,
        issues::activity,
        issues::comments,
        issues::comment,
        issues::create_comment,
        issues::update_comment,
        issues::delete_comment,
        issues::attachment,
        webhooks::events,
        webhooks::list,
        webhooks::get,
        webhooks::create,
        webhooks::update,
        webhooks::delete,
    ),
    components(schemas(crate::error::ErrorBody, crate::domain::FilterClause)),
    modifiers(&BearerAuth),
    security(("token" = [])),
    info(
        title = "Blackwall API",
        version = "1.0.0-beta",
        description = "Beta: breaking changes are possible and will be announced. \
            Authenticate with `Authorization: Bearer bw_pat_...`, a personal access token \
            created under Settings → API tokens. A token acts as its user, limited to read \
            access, comment access or write access, and optionally to listed workspaces. \
            Writes record the token as `via`, so they show which integration acted. Records \
            name what they point at, and writes and filters take names, keys and emails \
            wherever they take ids. Lists return `{data, next_cursor}`. Single records carry \
            an `ETag`; send it back as `If-Match` to fail with 412 instead of overwriting a concurrent change. Writes accept an \
            `Idempotency-Key` header. Responses report `X-RateLimit-Limit`, \
            `X-RateLimit-Remaining` and `X-RateLimit-Reset`. Errors are `{error}`."
    )
)]
pub struct ApiDoc;

struct BearerAuth;

impl utoipa::Modify for BearerAuth {
    fn modify(&self, openapi: &mut utoipa::openapi::OpenApi) {
        use utoipa::openapi::security::{HttpAuthScheme, HttpBuilder, SecurityScheme};
        openapi
            .components
            .get_or_insert_default()
            .add_security_scheme(
                "token",
                SecurityScheme::Http(
                    HttpBuilder::new()
                        .scheme(HttpAuthScheme::Bearer)
                        .bearer_format("bw_pat_")
                        .build(),
                ),
            );
    }
}

async fn openapi() -> Json<utoipa::openapi::OpenApi> {
    Json(ApiDoc::openapi())
}
