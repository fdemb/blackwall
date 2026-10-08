use super::*;
use crate::store::{PullResponse, PushRequest, PushResponse};

#[derive(Debug, Deserialize, utoipa::IntoParams)]
#[into_params(parameter_in = Query)]
pub struct PullQuery {
    /// Client replica id. A client_id owned by another user or workspace is 400.
    pub client_id: Option<String>,
    /// Cursor from a previous pull. Omit for a starting cursor. Must be an
    /// integer in `[0, snapshot xmax]`; anything else is 400.
    pub cursor: Option<String>,
}

#[utoipa::path(
    get,
    path = "/api/workspaces/{id}/sync/pull",
    params(("id" = Uuid, Path), PullQuery),
    responses((status = 200, body = PullResponse)),
    description = "Changed records since a cursor, rendered as the list endpoints render them. Omit cursor for a starting cursor. Intermediate pages set last_mutation_id null; only the final page reports it. When reset is true, bootstrap again and continue from the returned cursor."
)]
pub(super) async fn pull(
    State(store): State<Store>,
    actor: Actor,
    Path(id): Path<Uuid>,
    Query(query): Query<PullQuery>,
) -> Result<Json<PullResponse>> {
    let client_id = query
        .client_id
        .as_deref()
        .ok_or_else(|| Error::BadRequest("client_id is required".into()))?;
    let client_id = Uuid::parse_str(client_id)
        .map_err(|_| Error::BadRequest("client_id must be a UUID".into()))?;
    Ok(Json(
        store
            .sync_pull(id, actor.profile.id, client_id, query.cursor.as_deref())
            .await?,
    ))
}

#[utoipa::path(
    post,
    path = "/api/workspaces/{id}/sync/push",
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
