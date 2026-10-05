use super::*;
use crate::store::NewAttachment;
use axum::{body::Bytes, extract::Multipart, http::HeaderMap};

#[utoipa::path(
    post,
    path = "/api/workspaces/{id}/issues/{issue}/attachments",
    params(("id" = Uuid, Path), ("issue" = Uuid, Path)),
    responses((status = 200, body = CommandResponse)),
    description = "Multipart file up to 5 MiB, expected_versions JSON map, optional idempotency_key and comment_id."
)]
pub(super) async fn upload(
    State(store): State<Store>,
    actor: Actor,
    Path((id, issue)): Path<(Uuid, Uuid)>,
    mut multipart: Multipart,
) -> Result<Json<CommandResponse>> {
    let mut uploaded = None;
    let mut expected = BTreeMap::new();
    let mut comment_id = None;
    let mut key = None;

    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|e| Error::BadRequest(e.to_string()))?
    {
        match field.name() {
            Some("expected_versions") => {
                let value = field
                    .text()
                    .await
                    .map_err(|e| Error::BadRequest(e.to_string()))?;
                expected = serde_json::from_str(&value)
                    .map_err(|_| Error::BadRequest("invalid expected_versions JSON".into()))?;
            }
            Some("idempotency_key") => {
                key = Some(
                    field
                        .text()
                        .await
                        .map_err(|e| Error::BadRequest(e.to_string()))?,
                );
            }
            Some("comment_id") => {
                comment_id = Some(
                    field
                        .text()
                        .await
                        .map_err(|e| Error::BadRequest(e.to_string()))?
                        .parse::<Uuid>()
                        .map_err(|_| Error::BadRequest("invalid comment_id".into()))?,
                );
            }
            Some("file") if uploaded.is_none() => {
                let filename = field
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
                    filename,
                    content_type,
                    bytes: bytes.to_vec(),
                });
            }
            _ => {
                return Err(Error::BadRequest(
                    "upload one file and valid metadata fields".into(),
                ));
            }
        }
    }

    let file = uploaded.ok_or_else(|| Error::BadRequest("file field required".into()))?;
    let metadata = Attachment {
        id: file.id,
        name: file.filename.clone(),
        content_type: file.content_type.clone(),
        size: file.bytes.len() as u64,
    };

    let command = if let Some(comment_id) = comment_id {
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

    Ok(Json(
        store
            .operation(id, actor.profile.id, command, expected, key, Some(file))
            .await?,
    ))
}

#[utoipa::path(
    get,
    path = "/api/workspaces/{id}/attachments/{attachment}",
    params(
        ("id" = Uuid, Path),
        ("attachment" = Uuid, Path)
    ),
    responses((status = 200, description = "Authenticated binary attachment"))
)]
pub(super) async fn download(
    State(store): State<Store>,
    actor: Actor,
    Path((id, attachment)): Path<(Uuid, Uuid)>,
) -> Result<Response> {
    let row = sqlx::query(
        "SELECT a.filename, a.bytes FROM attachments a \
         JOIN issues i ON i.id = a.issue_id \
         JOIN workspace_members m ON m.workspace_id = a.workspace_id \
         WHERE a.workspace_id = $1 AND a.id = $2 AND m.user_id = $3 \
         AND i.deleted_at IS NULL",
    )
    .bind(id)
    .bind(attachment)
    .bind(actor.profile.id)
    .fetch_optional(&store.pool)
    .await?
    .ok_or(Error::NotFound)?;

    let name: String = row.try_get("filename")?;
    let bytes: Vec<u8> = row.try_get("bytes")?;

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

#[utoipa::path(
    get,
    path = "/api/workspaces/{id}/export",
    params(("id" = Uuid, Path)),
    responses((status = 200, body = crate::exchange::Transfer))
)]
pub(super) async fn export(
    State(store): State<Store>,
    actor: Actor,
    Path(id): Path<Uuid>,
) -> Result<Json<crate::exchange::Transfer>> {
    Ok(Json(store.export_transfer(id, actor.profile.id).await?))
}

#[utoipa::path(
    post,
    path = "/api/workspaces/{id}/import",
    params(("id" = Uuid, Path)),
    request_body = ImportRequest,
    responses((status = 200, body = ImportResponse))
)]
pub(super) async fn import(
    State(store): State<Store>,
    actor: Actor,
    Path(id): Path<Uuid>,
    Json(input): Json<ImportRequest>,
) -> Result<Json<ImportResponse>> {
    match (input.issues, input.transfer) {
        (Some(issues), None) => {
            let out = store
                .operation(
                    id,
                    actor.profile.id,
                    Command::ImportIssues { issues },
                    input.expected_versions,
                    input.idempotency_key,
                    None,
                )
                .await?;
            Ok(Json(ImportResponse {
                versions: out.versions,
                summary: None,
            }))
        }
        (None, Some(transfer)) => {
            let (summary, versions) = store
                .import_transfer(
                    id,
                    actor.profile.id,
                    transfer,
                    input.expected_versions,
                    input.idempotency_key,
                )
                .await?;
            Ok(Json(ImportResponse {
                versions,
                summary: Some(summary),
            }))
        }
        _ => Err(Error::BadRequest(
            "provide either issues or transfer".into(),
        )),
    }
}

#[utoipa::path(
    post,
    path = "/api/workspaces/{id}/integrations/{integration}/webhook",
    params(("id" = Uuid, Path), ("integration" = Uuid, Path)),
    request_body = IncomingLink,
    responses((status = 200, body = CommandResponse)),
    description = "HMAC-SHA256 X-Blackwall-Signature over raw request bytes, with delivery_id idempotency."
)]
pub(super) async fn incoming(
    State(store): State<Store>,
    Path((id, integration_id)): Path<(Uuid, Uuid)>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Json<CommandResponse>> {
    use hmac::{Hmac, Mac};
    use sha2::{Digest, Sha256};

    let owner: Uuid = sqlx::query_scalar(
        "SELECT user_id FROM workspace_members \
         WHERE workspace_id = $1 AND role = 'owner' \
         ORDER BY user_id LIMIT 1",
    )
    .bind(id)
    .fetch_optional(&store.pool)
    .await?
    .ok_or(Error::NotFound)?;

    let mut op = store
        .begin_operation(id, owner, BTreeMap::new(), false)
        .await?;
    let row = sqlx::query(
        "SELECT secret FROM integrations WHERE workspace_id=$1 AND id=$2 AND enabled FOR SHARE",
    )
    .bind(id)
    .bind(integration_id)
    .fetch_optional(&mut *op.tx)
    .await?
    .ok_or(Error::NotFound)?;
    let secret: String = row.try_get("secret")?;

    let signature = headers
        .get("x-blackwall-signature")
        .and_then(|s| s.to_str().ok())
        .and_then(|s| hex::decode(s.strip_prefix("sha256=").unwrap_or(s)).ok())
        .ok_or(Error::Unauthorized)?;

    let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes())
        .map_err(|e| Error::Internal(e.to_string()))?;
    mac.update(&body);
    mac.verify_slice(&signature)
        .map_err(|_| Error::Unauthorized)?;

    let input: IncomingLink =
        serde_json::from_slice(&body).map_err(|e| Error::BadRequest(e.to_string()))?;
    let hash = hex::encode(Sha256::digest(&body));

    sqlx::query(
        "INSERT INTO inbound_deliveries(workspace_id, integration_id, delivery_id, request_hash) \
         VALUES($1, $2, $3, $4) ON CONFLICT DO NOTHING",
    )
    .bind(id)
    .bind(integration_id)
    .bind(input.delivery_id)
    .bind(&hash)
    .execute(&mut *op.tx)
    .await?;

    let row = sqlx::query(
        "SELECT request_hash, result FROM inbound_deliveries \
         WHERE integration_id = $1 AND delivery_id = $2 FOR UPDATE",
    )
    .bind(integration_id)
    .bind(input.delivery_id)
    .fetch_one(&mut *op.tx)
    .await?;

    if row.try_get::<String, _>("request_hash")? != hash {
        return Err(Error::Conflict(
            "delivery ID reused for a different request".into(),
        ));
    }
    if let Some(result) = row.try_get::<Option<Value>, _>("result")? {
        return Ok(Json(serde_json::from_value(result)?));
    }

    let command = Command::AddSourceLink {
        issue_id: input.issue_id,
        url: input.url,
        title: input.title,
    };
    op.authorize_issue_ownership(&command).await?;
    let version: i64 =
        sqlx::query_scalar("SELECT version FROM issues WHERE workspace_id=$1 AND id=$2 FOR UPDATE")
            .bind(id)
            .bind(input.issue_id)
            .fetch_optional(&mut *op.tx)
            .await?
            .ok_or(Error::NotFound)?;

    op.expected.insert(input.issue_id, version);

    let entity = op.issues(command).await?;
    op.activity("integration.source_link", entity, vec![])
        .await?;

    let result = OperationResult {
        result: CommandResult { id: entity },
        versions: op.versions,
        changes: Vec::new(),
    };
    sqlx::query(
        "UPDATE inbound_deliveries SET result=$3 WHERE integration_id=$1 AND delivery_id=$2",
    )
    .bind(integration_id)
    .bind(input.delivery_id)
    .bind(serde_json::to_value(&result)?)
    .execute(&mut *op.tx)
    .await?;

    op.tx.commit().await?;
    store.outbox.ready();

    Ok(Json(result))
}
