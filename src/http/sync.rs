use super::*;
use crate::store::{PushRequest, PushResponse};

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
