use super::*;
use crate::store::{PullResponse, PushRequest, PushResponse, ScopeResponse, SyncScope};
use axum::response::sse::{Event, KeepAlive, Sse};
use tokio_stream::Stream;
use tokio_stream::wrappers::ReceiverStream;

#[derive(Debug, Deserialize, utoipa::IntoParams)]
#[into_params(parameter_in = Query)]
pub struct PullQuery {
    /// Client replica id. A client_id owned by another user or workspace is 400.
    pub client_id: Option<String>,
    /// Cursor from a previous pull. Omit for a starting cursor. Must be a
    /// snapshot in `xmin:xmax:xip` text form from this server; anything else
    /// is 400.
    pub cursor: Option<String>,
}

#[utoipa::path(
    get,
    path = "/internal-api/workspaces/{id}/sync/pull",
    params(("id" = Uuid, Path), PullQuery),
    responses((status = 200, body = PullResponse)),
    description = "Changed records since a cursor in sync shapes, with issue counts omitted. Omit cursor for a starting cursor. Intermediate pages set last_mutation_id null; only the final page reports it. When reset is true, bootstrap again and continue from the returned cursor."
)]
pub(super) async fn pull(
    State(store): State<Store>,
    actor: Actor,
    Path(id): Path<Uuid>,
    Query(query): Query<PullQuery>,
) -> Result<Json<PullResponse>> {
    let client_id = client_id(query.client_id.as_deref())?;
    Ok(Json(
        store
            .sync_pull(id, actor.profile.id, client_id, query.cursor.as_deref())
            .await?,
    ))
}

#[utoipa::path(
    post,
    path = "/internal-api/workspaces/{id}/sync/push",
    params(("id" = Uuid, Path)),
    request_body = PushRequest,
    responses(
        (status = 200, body = PushResponse),
        (status = 503, body = PushResponse)
    ),
    description = "Applies one client's ordered mutations through the same store code as the command endpoint. Each mutation runs in its own transaction; business errors reject that mutation while transient failures stop the batch."
)]
pub(super) async fn push(
    State(store): State<Store>,
    actor: Actor,
    Path(id): Path<Uuid>,
    Json(input): Json<PushRequest>,
) -> Result<Response> {
    let outcome = store
        .sync_push(id, actor.profile.id, input.client_id, input.mutations)
        .await?;

    let status = if outcome.truncated {
        StatusCode::SERVICE_UNAVAILABLE
    } else {
        StatusCode::OK
    };

    Ok((status, Json(outcome.response)).into_response())
}

fn client_id(value: Option<&str>) -> Result<Uuid> {
    let value = value.ok_or_else(|| Error::BadRequest("client_id is required".into()))?;
    Uuid::parse_str(value).map_err(|_| Error::BadRequest("client_id must be a UUID".into()))
}

#[derive(Debug, Deserialize, utoipa::IntoParams)]
#[into_params(parameter_in = Query)]
pub struct BootstrapQuery {
    pub client_id: Option<String>,
}

#[utoipa::path(
    get,
    path = "/internal-api/workspaces/{id}/sync/bootstrap",
    params(("id" = Uuid, Path), BootstrapQuery),
    responses((status = 200, content_type = "application/x-ndjson")),
    description = "Streams the always-loaded records from one snapshot. A header carries cursor, last_mutation_id and schema; a trailer confirms the record count. Accept-Encoding negotiates gzip."
)]
pub(super) async fn bootstrap(
    State(store): State<Store>,
    actor: Actor,
    Path(id): Path<Uuid>,
    Query(query): Query<BootstrapQuery>,
) -> Result<Response> {
    let receiver = store
        .sync_bootstrap(id, actor.profile.id, client_id(query.client_id.as_deref())?)
        .await?;
    let body = axum::body::Body::from_stream(tokio_stream::wrappers::ReceiverStream::new(receiver));
    Ok(([(header::CONTENT_TYPE, "application/x-ndjson")], body).into_response())
}

#[derive(Debug, Deserialize, utoipa::IntoParams)]
#[into_params(parameter_in = Query)]
pub struct ScopeQuery {
    pub client_id: Option<String>,
    pub entity: Option<String>,
    pub issue_id: Option<String>,
    pub entity_id: Option<String>,
}

#[utoipa::path(
    get,
    path = "/internal-api/workspaces/{id}/sync/scope",
    params(("id" = Uuid, Path), ScopeQuery),
    responses((status = 200, body = ScopeResponse)),
    description = "All comments for issue_id, or all activity for entity_id, from one snapshot."
)]
pub(super) async fn scope(
    State(store): State<Store>,
    actor: Actor,
    Path(id): Path<Uuid>,
    Query(query): Query<ScopeQuery>,
) -> Result<Json<ScopeResponse>> {
    let client_id = client_id(query.client_id.as_deref())?;
    let (value, name) = match query.entity.as_deref() {
        Some("comments") => (query.issue_id.as_deref(), "issue_id"),
        Some("activity") => (query.entity_id.as_deref(), "entity_id"),
        _ => {
            return Err(Error::BadRequest(
                "entity must be comments or activity".into(),
            ));
        }
    };
    let value = value.ok_or_else(|| Error::BadRequest(format!("{name} is required")))?;
    let value =
        Uuid::parse_str(value).map_err(|_| Error::BadRequest(format!("{name} must be a UUID")))?;
    let scope = if name == "issue_id" {
        SyncScope::Comments(value)
    } else {
        SyncScope::Activity(value)
    };
    Ok(Json(
        store
            .sync_scope(id, actor.profile.id, client_id, scope)
            .await?,
    ))
}

#[derive(Debug, Deserialize, utoipa::IntoParams)]
#[into_params(parameter_in = Query)]
pub struct EventsQuery {
    /// Client replica id. A client_id owned by another user or workspace is 400.
    pub client_id: Option<String>,
}

fn poke_event() -> Event {
    Event::default().event("poke").data("{}")
}

#[utoipa::path(
    get,
    path = "/internal-api/workspaces/{id}/sync/events",
    params(("id" = Uuid, Path), EventsQuery),
    responses((status = 200, content_type = "text/event-stream")),
    description = "Server-sent pokes for workspace commits. Sends one poke on connect and one per commit, coalesced to one per 250 ms with keep-alive comments every 15 seconds. Each stream ends after 30 minutes; clients reconnect."
)]
pub(super) async fn events(
    State(store): State<Store>,
    actor: Actor,
    Path(id): Path<Uuid>,
    Query(query): Query<EventsQuery>,
) -> Result<Sse<impl Stream<Item = std::result::Result<Event, std::convert::Infallible>> + Send>> {
    let client_id = client_id(query.client_id.as_deref())?;
    store
        .sync_events_check(id, actor.profile.id, client_id)
        .await?;
    let workspace = id;
    let subscriber = store.sync_broadcast.subscribe();
    let shutdown = store.sync_shutdown.subscribe();
    let config = store.sync_events.clone();
    let keepalive = config.keepalive;
    // Capacity 1: at most one poke waits for the reader. `try_send` never
    // blocks, so a slow reader cannot hold the task past its lifetime; a
    // `Full` failure means a poke is already queued and loses nothing.
    let (sender, receiver) =
        tokio::sync::mpsc::channel::<std::result::Result<Event, std::convert::Infallible>>(1);
    tokio::spawn(forward_pokes(
        sender, subscriber, shutdown, workspace, config,
    ));
    Ok(Sse::new(ReceiverStream::new(receiver)).keep_alive(KeepAlive::new().interval(keepalive)))
}

type PokeSender = tokio::sync::mpsc::Sender<std::result::Result<Event, std::convert::Infallible>>;

/// Sends one poke at once, then one per commit to `workspace`, at most one
/// per coalesce window, until the stream's lifetime ends, the client leaves,
/// or the server shuts down.
async fn forward_pokes(
    sender: PokeSender,
    mut subscriber: tokio::sync::broadcast::Receiver<Uuid>,
    mut shutdown: tokio::sync::watch::Receiver<bool>,
    workspace: Uuid,
    config: crate::store::SyncEventsConfig,
) {
    if sender.try_send(Ok(poke_event())).is_err() {
        return;
    }
    let mut last_send = tokio::time::Instant::now();
    let mut pending = false;
    let deadline = tokio::time::Instant::now() + config.lifetime;
    loop {
        let window_end = last_send + config.coalesce;
        tokio::select! {
            biased;
            _ = tokio::time::sleep_until(deadline) => break,
            _ = sender.closed() => break,
            _ = shutdown.wait_for(|stop| *stop) => break,
            _ = tokio::time::sleep_until(window_end), if pending => {
                // A full channel already holds a poke that covers the burst.
                if !try_poke(&sender) {
                    break;
                }
                last_send = tokio::time::Instant::now();
                pending = false;
            },
            received = subscriber.recv() => {
                let poke = match received {
                    Ok(changed) => changed == workspace || changed.is_nil(),
                    // A gap means something was missed: pull.
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => true,
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                };
                if !poke {
                    continue;
                }
                if pending || last_send.elapsed() < config.coalesce {
                    pending = true;
                    continue;
                }
                match sender.try_send(Ok(poke_event())) {
                    Ok(()) => last_send = tokio::time::Instant::now(),
                    // A poke is already queued for delivery.
                    Err(tokio::sync::mpsc::error::TrySendError::Full(_)) => {}
                    Err(tokio::sync::mpsc::error::TrySendError::Closed(_)) => break,
                }
            },
        }
    }
}

/// Queues a poke unless one is already waiting. False once the client is gone.
fn try_poke(sender: &PokeSender) -> bool {
    !matches!(
        sender.try_send(Ok(poke_event())),
        Err(tokio::sync::mpsc::error::TrySendError::Closed(_))
    )
}
