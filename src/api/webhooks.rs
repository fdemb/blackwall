use super::resources::{Versioned, one};
use super::*;
use crate::domain::{Role, WEBHOOK_EVENTS};
use axum::extract::Path;

/// An outgoing webhook. Its signing secret is only ever returned at creation.
#[derive(Serialize, Deserialize, utoipa::ToSchema)]
pub struct ApiWebhook {
    pub id: Uuid,
    pub version: i64,
    pub name: String,
    #[serde(rename(deserialize = "webhook_url"))]
    pub url: String,
    pub enabled: bool,
    /// Subscribed event types. Empty means every event.
    pub events: Vec<String>,
}

impl Versioned for ApiWebhook {
    fn version(&self) -> i64 {
        self.version
    }
}

#[derive(Serialize, utoipa::ToSchema)]
pub struct CreatedWebhook {
    #[serde(flatten)]
    pub webhook: ApiWebhook,
    /// HMAC-SHA256 key for `X-Blackwall-Signature`. Shown once.
    pub secret: String,
}

/// Webhooks are workspace administration.
async fn admin(store: &Store, scope: Scope) -> Result<()> {
    match store.member_role(scope.workspace, scope.user).await? {
        Role::Owner | Role::Admin => Ok(()),
        _ => Err(Error::Denied(
            "webhooks require a workspace owner or administrator".into(),
        )),
    }
}

async fn webhook(store: &Store, scope: Scope, id: Uuid) -> Result<ApiWebhook> {
    Ok(serde_json::from_value(
        store
            .collection_record(scope.workspace, scope.user, "integrations", id)
            .await?,
    )?)
}

#[derive(Serialize, utoipa::ToSchema)]
pub struct WebhookEvents {
    pub data: Vec<String>,
}

#[utoipa::path(
    get,
    path = "/api/v1/webhook-events",
    tag = "webhooks",
    security(()),
    description = "Every event type a webhook can subscribe to. Each delivery is a POST of \
        `{id, type, workspace_id, occurred_at, actor_id, entity_type, entity_id, fields?}` \
        with `X-Blackwall-Event`, `Idempotency-Key` and \
        `X-Blackwall-Signature: sha256=<hex HMAC-SHA256 of the body>` headers. Fetch the \
        entity through the API for its current state.",
    responses((status = 200, body = WebhookEvents))
)]
pub async fn events() -> Json<WebhookEvents> {
    Json(WebhookEvents {
        data: WEBHOOK_EVENTS.iter().map(|e| (*e).to_owned()).collect(),
    })
}

#[utoipa::path(
    get,
    path = "/api/v1/workspaces/{workspace}/webhooks",
    tag = "webhooks",
    params(("workspace" = Uuid, Path), PageParams),
    responses((status = 200, body = Page<ApiWebhook>))
)]
pub async fn list(
    State(store): State<Store>,
    actor: ApiActor,
    Path(workspace): Path<Uuid>,
    axum::extract::Query(params): axum::extract::Query<PageParams>,
) -> Result<Json<Page<ApiWebhook>>> {
    let scope = actor.read(workspace)?;
    admin(&store, scope).await?;
    Ok(Json(
        resources::list_collection(&store, scope, "integrations", &params, None).await?,
    ))
}

#[utoipa::path(
    get,
    path = "/api/v1/workspaces/{workspace}/webhooks/{webhook}",
    tag = "webhooks",
    params(("workspace" = Uuid, Path), ("webhook" = Uuid, Path)),
    responses((status = 200, body = ApiWebhook))
)]
pub async fn get(
    State(store): State<Store>,
    actor: ApiActor,
    Path((workspace, id)): Path<(Uuid, Uuid)>,
) -> Result<Response> {
    let scope = actor.read(workspace)?;
    admin(&store, scope).await?;
    Ok(one(StatusCode::OK, webhook(&store, scope, id).await?))
}

#[derive(Deserialize, utoipa::ToSchema)]
pub struct CreateWebhook {
    pub name: String,
    /// HTTPS endpoint on a public address.
    pub url: String,
    /// Event types from /api/v1/webhook-events. Omit or leave empty for every event.
    #[serde(default)]
    pub events: Vec<String>,
    /// Signing secret. Omit to have one generated.
    pub secret: Option<String>,
}

#[utoipa::path(
    post,
    path = "/api/v1/workspaces/{workspace}/webhooks",
    tag = "webhooks",
    params(("workspace" = Uuid, Path)),
    request_body = CreateWebhook,
    responses((status = 201, body = CreatedWebhook))
)]
pub async fn create(
    State(store): State<Store>,
    actor: ApiActor,
    Path(workspace): Path<Uuid>,
    options: WriteOptions,
    Json(body): Json<CreateWebhook>,
) -> Result<Response> {
    let scope = actor.write(workspace)?;
    let secret = body
        .secret
        .unwrap_or_else(|| format!("whsec_{}", crate::auth::token()));
    let result = run(
        &store,
        scope,
        Command::CreateIntegration {
            id: None,
            name: body.name,
            webhook_url: body.url,
            secret: secret.clone(),
            events: body.events,
        },
        None,
        options,
    )
    .await?;
    let webhook = webhook(&store, scope, created_id(&result)?).await?;
    Ok(tagged(
        StatusCode::CREATED,
        webhook.version,
        CreatedWebhook { webhook, secret },
    ))
}

#[derive(Deserialize, utoipa::ToSchema)]
pub struct UpdateWebhook {
    pub enabled: Option<bool>,
    /// Replaces the subscribed event types. Empty means every event.
    pub events: Option<Vec<String>>,
}

#[utoipa::path(
    patch,
    path = "/api/v1/workspaces/{workspace}/webhooks/{webhook}",
    tag = "webhooks",
    params(("workspace" = Uuid, Path), ("webhook" = Uuid, Path)),
    request_body = UpdateWebhook,
    responses((status = 200, body = ApiWebhook), (status = 412, body = crate::error::ErrorBody))
)]
pub async fn update(
    State(store): State<Store>,
    actor: ApiActor,
    Path((workspace, id)): Path<(Uuid, Uuid)>,
    options: WriteOptions,
    Json(body): Json<UpdateWebhook>,
) -> Result<Response> {
    let scope = actor.write(workspace)?;
    admin(&store, scope).await?;
    let current = webhook(&store, scope, id).await?;
    run(
        &store,
        scope,
        Command::UpdateIntegration {
            id,
            enabled: body.enabled.unwrap_or(current.enabled),
            events: body.events,
        },
        Some(id),
        options,
    )
    .await?;
    Ok(one(StatusCode::OK, webhook(&store, scope, id).await?))
}

#[utoipa::path(
    delete,
    path = "/api/v1/workspaces/{workspace}/webhooks/{webhook}",
    tag = "webhooks",
    params(("workspace" = Uuid, Path), ("webhook" = Uuid, Path)),
    responses((status = 204))
)]
pub async fn delete(
    State(store): State<Store>,
    actor: ApiActor,
    Path((workspace, id)): Path<(Uuid, Uuid)>,
    options: WriteOptions,
) -> Result<StatusCode> {
    run(
        &store,
        actor.write(workspace)?,
        Command::DeleteIntegration { id },
        Some(id),
        options,
    )
    .await?;
    Ok(StatusCode::NO_CONTENT)
}
