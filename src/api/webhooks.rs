use super::directory::{Directory, Person};
use super::issues::{render_comments_on, render_on};
use super::resources::{Versioned, one};
use super::*;
use crate::domain::{Comment, Role, TimeEntry, WEBHOOK_EVENTS};
use axum::extract::Path;
use chrono::{DateTime, Utc};
use serde_json::Value;
use sqlx::PgConnection;

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
    /// Whether deliveries carry the changed record as `data`.
    pub include_data: bool,
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
    /// HMAC-SHA256 key for `Blackwall-Signature` and `X-Blackwall-Signature`. Shown once.
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
        `{id, type, workspace_id, occurred_at, actor_id, entity_type, entity_id, fields?, \
        changes?, via?, data?, truncated?}`. `changes` holds the old and new value of each \
        field in `fields`. `data` is the issue, comment or time entry as the API returns it, read \
        right after the change, and only webhooks with `include_data` receive it. Headers are \
        `X-Blackwall-Event`, `Idempotency-Key`, \
        `Blackwall-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of t.body>` and \
        `X-Blackwall-Signature: sha256=<hex HMAC-SHA256 of the body>`. Verify \
        `Blackwall-Signature` and reject timestamps more than 5 minutes away from your clock.",
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
    /// Send the changed record as `data`. Defaults to true.
    pub include_data: Option<bool>,
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
    let result = run(
        &store,
        scope,
        async {
            Ok(Command::CreateIntegration {
                id: None,
                name: body.name,
                webhook_url: body.url,
                secret: body
                    .secret
                    .unwrap_or_else(|| format!("whsec_{}", crate::auth::token())),
                events: body.events,
                include_data: body.include_data.unwrap_or(true),
            })
        },
        None,
        options,
    )
    .await?;
    let id = created_id(&result)?;
    // A replay never builds the command, so read the secret the webhook keeps.
    let secret: String =
        sqlx::query_scalar("SELECT secret FROM integrations WHERE workspace_id=$1 AND id=$2")
            .bind(scope.workspace)
            .bind(id)
            .fetch_optional(&store.pool)
            .await?
            .ok_or(Error::NotFound)?;
    let webhook = webhook(&store, scope, id).await?;
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
    /// Send the changed record as `data`.
    pub include_data: Option<bool>,
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
    run(
        &store,
        scope,
        async {
            let current = webhook(&store, scope, id).await?;
            Ok(Command::UpdateIntegration {
                id,
                enabled: body.enabled.unwrap_or(current.enabled),
                events: body.events,
                include_data: body.include_data,
            })
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
        async { Ok(Command::DeleteIntegration { id }) },
        Some(id),
        options,
    )
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Markdown longer than this many bytes is cut to it, so stored deliveries stay small.
const TEXT_LIMIT: usize = 16 * 1024;
/// `data` still larger than this many bytes once serialized is left out.
const DATA_LIMIT: usize = 64 * 1024;

/// A time entry with its person named. Only webhook deliveries carry it.
#[derive(Serialize)]
pub struct ApiTimeEntry {
    pub id: Uuid,
    pub issue_id: Uuid,
    pub user: Person,
    pub minutes: u32,
    pub note: String,
    pub logged_at: DateTime<Utc>,
    pub version: i64,
}

/// What a delivery says about its entity: `data`, and the parts of it `truncated` to fit.
#[derive(Debug, Default, PartialEq)]
pub(crate) struct Snapshot {
    pub data: Option<Value>,
    pub truncated: Vec<&'static str>,
}

/// The entity as the API returns it, read inside the transaction that changed it, so every
/// retry sends the state right after the change. Only issues, comments and time entries have
/// one, and a comment or time entry the change deleted has none.
pub(crate) async fn snapshot(
    conn: &mut PgConnection,
    names: &mut Names,
    workspace: Uuid,
    actor: Uuid,
    entity_type: &str,
    id: Uuid,
) -> Result<Snapshot> {
    let (data, markdown) = match entity_type {
        "issue" => {
            let issue = match crate::store::issue_on(conn, workspace, id, true).await {
                Err(Error::NotFound) => return Ok(Snapshot::default()),
                issue => issue?,
            };
            let dir = names.workspace(conn, workspace).await?;
            let rendered = render_on(conn, dir, workspace, vec![issue]).await?;
            (serde_json::to_value(&rendered[0])?, "description")
        }
        "comment" => {
            let Some(row) = crate::store::record_on(conn, workspace, actor, "comments", id).await?
            else {
                return Ok(Snapshot::default());
            };
            let comment: Comment = serde_json::from_value(row)?;
            let dir = names.people(conn, workspace).await?;
            let rendered = render_comments_on(conn, dir, vec![comment]).await?;
            (serde_json::to_value(&rendered[0])?, "body")
        }
        "time_entry" => {
            let Some(row) =
                crate::store::record_on(conn, workspace, actor, "time_entries", id).await?
            else {
                return Ok(Snapshot::default());
            };
            let entry: TimeEntry = serde_json::from_value(row)?;
            let dir = names.people(conn, workspace).await?;
            dir.include_people(conn, [entry.user_id]).await?;
            let rendered = ApiTimeEntry {
                id: entry.id,
                issue_id: entry.issue_id,
                user: dir.person(entry.user_id),
                minutes: entry.minutes,
                note: entry.note,
                logged_at: entry.logged_at,
                version: entry.version,
            };
            (serde_json::to_value(&rendered)?, "note")
        }
        _ => return Ok(Snapshot::default()),
    };
    Ok(bound(data, markdown))
}

/// The directory snapshots name records from, loaded on the first snapshot and kept for later
/// ones. Comments and time entries name only people, so it holds only members until an issue
/// needs the rest.
#[derive(Default)]
pub(crate) struct Names {
    directory: Option<Directory>,
    records: bool,
}

impl Names {
    async fn people(&mut self, conn: &mut PgConnection, workspace: Uuid) -> Result<&mut Directory> {
        let dir = match self.directory.take() {
            Some(dir) => dir,
            None => Directory::members(conn, workspace).await?,
        };
        Ok(self.directory.insert(dir))
    }

    async fn workspace(
        &mut self,
        conn: &mut PgConnection,
        workspace: Uuid,
    ) -> Result<&mut Directory> {
        let dir = match self.directory.take() {
            Some(dir) if self.records => dir,
            Some(dir) => dir.with_records(conn, workspace).await?,
            None => Directory::workspace(conn, workspace).await?,
        };
        self.records = true;
        Ok(self.directory.insert(dir))
    }
}

/// Cuts the `markdown` field to `TEXT_LIMIT`, then leaves `data` out if it is still over
/// `DATA_LIMIT`.
fn bound(mut data: Value, markdown: &'static str) -> Snapshot {
    let mut truncated = Vec::new();
    if let Some(Value::String(text)) = data.get_mut(markdown)
        && text.len() > TEXT_LIMIT
    {
        let mut end = TEXT_LIMIT;
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        text.truncate(end);
        truncated.push(markdown);
    }
    if data.to_string().len() > DATA_LIMIT {
        return Snapshot {
            data: None,
            truncated: vec!["data"],
        };
    }
    Snapshot {
        data: Some(data),
        truncated,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn short_markdown_is_kept_whole() {
        let data = json!({"id": "a", "description": "Short"});
        assert_eq!(
            bound(data.clone(), "description"),
            Snapshot {
                data: Some(data),
                truncated: vec![],
            }
        );
    }

    #[test]
    fn long_markdown_is_cut_on_a_character_boundary() {
        // Three-byte characters put the limit inside one, so the cut lands before it.
        let text = "€".repeat(TEXT_LIMIT);
        let snapshot = bound(json!({"id": "a", "body": text}), "body");
        assert_eq!(snapshot.truncated, ["body"]);
        let body = snapshot.data.unwrap()["body"].as_str().unwrap().to_owned();
        assert!(body.len() <= TEXT_LIMIT && body.len() > TEXT_LIMIT - 3);
        assert!(text.starts_with(&body));
    }

    #[test]
    fn oversized_data_is_left_out() {
        let followers: Vec<String> = (0..DATA_LIMIT / 8).map(|n| format!("{n:08}")).collect();
        let snapshot = bound(
            json!({"id": "a", "description": "", "followers": followers}),
            "description",
        );
        assert_eq!(
            snapshot,
            Snapshot {
                data: None,
                truncated: vec!["data"],
            }
        );
    }
}
