use super::*;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Most mutations one push request may carry.
const MAX_MUTATIONS: usize = 100;

/// One client mutation. `name` plus `args` form a `Command`; `at` is the
/// client's timestamp, validated but otherwise unused by the server.
#[derive(Debug, Deserialize, utoipa::ToSchema)]
pub struct SyncMutation {
    pub id: i64,
    pub name: String,
    #[serde(default)]
    pub args: Value,
    pub at: DateTime<Utc>,
}

#[derive(Debug, Deserialize, utoipa::ToSchema)]
pub struct PushRequest {
    pub client_id: Uuid,
    pub mutations: Vec<SyncMutation>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum MutationStatus {
    Applied,
    Duplicate,
    Rejected,
}

#[derive(Debug, Serialize, utoipa::ToSchema)]
pub struct MutationError {
    pub status: u16,
    pub message: String,
}

#[derive(Debug, Serialize, utoipa::ToSchema)]
pub struct MutationResult {
    pub id: i64,
    pub status: MutationStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<MutationError>,
}

#[derive(Debug, Serialize, utoipa::ToSchema)]
pub struct PushResponse {
    pub last_mutation_id: i64,
    pub results: Vec<MutationResult>,
}

/// A push batch. `truncated` means a transient failure stopped the batch;
/// the handler answers 503 with the results committed so far.
#[derive(Debug)]
pub struct PushOutcome {
    pub response: PushResponse,
    pub truncated: bool,
}

enum PushFailure {
    /// Membership lost mid-batch; stop and answer 403.
    Forbidden,
    /// Database or internal failure; stop and answer 503. Carries the
    /// original error for the one log line the batch emits.
    Transient {
        error: Error,
        phase: &'static str,
        mutation_id: Option<i64>,
    },
    /// The client row belongs to another user or workspace; answer 400.
    ClientTaken,
}

async fn abort(
    op: Operation<'_>,
    error: Error,
    phase: &'static str,
    mutation_id: i64,
) -> PushFailure {
    let tx = op.tx;
    let _ = tx.rollback().await;
    PushFailure::Transient {
        error,
        phase,
        mutation_id: Some(mutation_id),
    }
}

/// One log line per truncated batch. Ids only: never mutation args,
/// tokens or session ids.
fn log_transient(
    workspace_id: Uuid,
    client_id: Uuid,
    mutation_id: Option<i64>,
    phase: &str,
    error: &Error,
) {
    tracing::error!(
        workspace_id = %workspace_id,
        client_id = %client_id,
        mutation_id = ?mutation_id,
        phase = phase,
        error = %error,
        "sync push transient failure"
    );
}

fn build_command(name: &str, args: &Value) -> Result<Command> {
    let mut object = match args {
        Value::Null => serde_json::Map::new(),
        Value::Object(map) => map.clone(),
        _ => {
            return Err(Error::Json(serde::de::Error::custom(
                "args must be an object",
            )));
        }
    };
    object.insert("type".into(), Value::String(name.into()));
    Ok(serde_json::from_value(Value::Object(object))?)
}

/// Business errors reject one mutation; everything else stops the batch.
fn is_business(error: &Error) -> bool {
    match error {
        Error::BadRequest(_)
        | Error::NotFound
        | Error::Conflict(_)
        | Error::Forbidden
        | Error::Json(_) => true,
        Error::Database(sqlx::Error::Database(db)) => db
            .code()
            .is_some_and(|code| code.starts_with("22") || code.starts_with("23")),
        Error::Database(_) | Error::Internal(_) | Error::Unauthorized => false,
    }
}

/// The `{status, message}` the REST command endpoint would return for this error.
fn rejection(error: &Error) -> MutationError {
    let (status, message) = match error {
        Error::BadRequest(message) => (400, message.clone()),
        Error::Forbidden => (403, error.to_string()),
        Error::NotFound => (404, error.to_string()),
        Error::Conflict(message) => (409, message.clone()),
        Error::Json(error) => (400, error.to_string()),
        Error::Database(sqlx::Error::Database(db))
            if db.code().as_deref() == Some("23514")
                && db.constraint() == Some(super::ownership::OWNERSHIP_CONSTRAINT) =>
        {
            (409, super::ownership::OWNERSHIP_MESSAGE.to_owned())
        }
        Error::Database(_) | Error::Internal(_) | Error::Unauthorized => {
            (500, "internal server error".to_owned())
        }
    };
    MutationError { status, message }
}

impl Store {
    pub async fn sync_push(
        &self,
        workspace_id: Uuid,
        actor: Uuid,
        client_id: Uuid,
        mutations: Vec<SyncMutation>,
    ) -> Result<PushOutcome> {
        if mutations.is_empty() || mutations.len() > MAX_MUTATIONS {
            return Err(Error::BadRequest("push 1 to 100 mutations".into()));
        }
        let mut previous = 0i64;
        for mutation in &mutations {
            if mutation.id < 1 || mutation.id <= previous {
                return Err(Error::BadRequest(
                    "mutation ids must be positive and strictly increasing".into(),
                ));
            }
            previous = mutation.id;
        }

        // Preflight failures carry no transaction, so they truncate the
        // batch with the high-water mark as known (0 here: nothing has
        // been read yet). Membership and ownership rejections stay 400/403.
        let preflight = |error: Error| {
            log_transient(workspace_id, client_id, None, "preflight", &error);
            PushOutcome {
                response: PushResponse {
                    last_mutation_id: 0,
                    results: Vec::new(),
                },
                truncated: true,
            }
        };

        {
            let mut conn = match self.pool.acquire().await {
                Ok(conn) => conn,
                Err(error) => return Ok(preflight(error.into())),
            };
            if let Err(error) = super::reads::authorize(&mut conn, workspace_id, actor).await {
                if matches!(error, Error::Forbidden) {
                    return Err(error);
                }
                return Ok(preflight(error));
            }
        }

        if let Some(row) =
            match sqlx::query("SELECT workspace_id, user_id FROM sync_clients WHERE client_id = $1")
                .bind(client_id)
                .fetch_optional(&self.pool)
                .await
            {
                Ok(row) => row,
                Err(error) => return Ok(preflight(error.into())),
            }
        {
            let owner_ws: Uuid = match row.try_get("workspace_id") {
                Ok(value) => value,
                Err(error) => return Ok(preflight(error.into())),
            };
            let owner: Uuid = match row.try_get("user_id") {
                Ok(value) => value,
                Err(error) => return Ok(preflight(error.into())),
            };
            if owner_ws != workspace_id || owner != actor {
                return Err(Error::BadRequest(
                    "client_id belongs to another user or workspace".into(),
                ));
            }
        }

        let last: i64 = match sqlx::query_scalar(
            "SELECT last_mutation_id FROM sync_clients WHERE client_id = $1",
        )
        .bind(client_id)
        .fetch_optional(&self.pool)
        .await
        {
            Ok(row) => row.unwrap_or(0),
            Err(error) => return Ok(preflight(error.into())),
        };

        let mut outcome = PushOutcome {
            response: PushResponse {
                last_mutation_id: last,
                results: Vec::with_capacity(mutations.len()),
            },
            truncated: false,
        };

        for mutation in &mutations {
            match self
                .push_mutation(workspace_id, actor, client_id, mutation)
                .await
            {
                Ok((current, result)) => {
                    outcome.response.last_mutation_id = current;
                    outcome.response.results.push(result);
                }
                Err(PushFailure::Forbidden) => return Err(Error::Forbidden),
                Err(PushFailure::ClientTaken) => {
                    return Err(Error::BadRequest(
                        "client_id belongs to another user or workspace".into(),
                    ));
                }
                Err(PushFailure::Transient {
                    error,
                    phase,
                    mutation_id,
                }) => {
                    log_transient(workspace_id, client_id, mutation_id, phase, &error);
                    outcome.truncated = true;
                    break;
                }
            }
        }

        Ok(outcome)
    }

    async fn push_mutation(
        &self,
        workspace_id: Uuid,
        actor: Uuid,
        client_id: Uuid,
        mutation: &SyncMutation,
    ) -> std::result::Result<(i64, MutationResult), PushFailure> {
        // Pure deserialization first; the variant decides the operation's lock.
        let built = build_command(&mutation.name, &mutation.args);
        let exclusive = built
            .as_ref()
            .map(super::membership_exclusive)
            .unwrap_or(false);

        let mut op = match self
            .begin_operation(workspace_id, actor, BTreeMap::new(), exclusive)
            .await
        {
            Ok(op) => op,
            Err(Error::Forbidden) => return Err(PushFailure::Forbidden),
            Err(error) => {
                return Err(PushFailure::Transient {
                    error,
                    phase: "begin",
                    mutation_id: Some(mutation.id),
                });
            }
        };

        if let Err(error) = sqlx::query(
            "INSERT INTO sync_clients (client_id, workspace_id, user_id) VALUES ($1, $2, $3) \
             ON CONFLICT (client_id) DO NOTHING",
        )
        .bind(client_id)
        .bind(workspace_id)
        .bind(actor)
        .execute(&mut *op.tx)
        .await
        {
            return Err(abort(op, error.into(), "client row", mutation.id).await);
        }

        let row = match sqlx::query(
            "SELECT workspace_id, user_id, last_mutation_id FROM sync_clients \
             WHERE client_id = $1 FOR UPDATE",
        )
        .bind(client_id)
        .fetch_one(&mut *op.tx)
        .await
        {
            Ok(row) => row,
            Err(error) => {
                return Err(abort(op, error.into(), "client row", mutation.id).await);
            }
        };

        let owner_ws: Uuid = match row.try_get("workspace_id") {
            Ok(value) => value,
            Err(error) => {
                return Err(abort(op, error.into(), "client row", mutation.id).await);
            }
        };
        let owner: Uuid = match row.try_get("user_id") {
            Ok(value) => value,
            Err(error) => {
                return Err(abort(op, error.into(), "client row", mutation.id).await);
            }
        };
        let stored: i64 = match row.try_get("last_mutation_id") {
            Ok(value) => value,
            Err(error) => {
                return Err(abort(op, error.into(), "client row", mutation.id).await);
            }
        };
        if owner_ws != workspace_id || owner != actor {
            let tx = op.tx;
            let _ = tx.rollback().await;
            return Err(PushFailure::ClientTaken);
        }

        if mutation.id <= stored {
            let tx = op.tx;
            return match tx.rollback().await {
                Ok(()) => Ok((
                    stored,
                    MutationResult {
                        id: mutation.id,
                        status: MutationStatus::Duplicate,
                        error: None,
                    },
                )),
                Err(error) => Err(PushFailure::Transient {
                    error: error.into(),
                    phase: "client row",
                    mutation_id: Some(mutation.id),
                }),
            };
        }

        if let Err(error) = sqlx::query("SAVEPOINT sync_mutation")
            .execute(&mut *op.tx)
            .await
        {
            return Err(abort(op, error.into(), "savepoint", mutation.id).await);
        }

        let run: Result<()> = async {
            let command = built?;
            // Uploads need their bytes; the client must use the upload endpoint.
            if matches!(
                command,
                Command::AddAttachment { .. } | Command::AttachCommentFile { .. }
            ) {
                return Err(Error::BadRequest(
                    "use the attachment upload endpoint".into(),
                ));
            }
            match op.run_command(command, None).await {
                Ok(_) => Ok(()),
                Err(error) if is_business(&error) => {
                    sqlx::query("ROLLBACK TO SAVEPOINT sync_mutation")
                        .execute(&mut *op.tx)
                        .await?;
                    Err(error)
                }
                Err(error) => Err(error),
            }
        }
        .await;

        let result = match run {
            Ok(()) => MutationResult {
                id: mutation.id,
                status: MutationStatus::Applied,
                error: None,
            },
            Err(error) if is_business(&error) => MutationResult {
                id: mutation.id,
                status: MutationStatus::Rejected,
                error: Some(rejection(&error)),
            },
            Err(error) => return Err(abort(op, error, "command", mutation.id).await),
        };

        match sqlx::query(
            "UPDATE sync_clients SET last_mutation_id = $1, updated_at = now() \
             WHERE client_id = $2",
        )
        .bind(mutation.id)
        .bind(client_id)
        .execute(&mut *op.tx)
        .await
        {
            Ok(_) => match op.tx.commit().await {
                Ok(()) => Ok((mutation.id, result)),
                Err(error) => Err(PushFailure::Transient {
                    error: error.into(),
                    phase: "commit",
                    mutation_id: Some(mutation.id),
                }),
            },
            Err(error) => Err(abort(op, error.into(), "advance", mutation.id).await),
        }
    }

    /// Deletes sync clients idle longer than the session lifetime. A pruned
    /// client cannot still have a live replica, because its session expired first.
    pub async fn prune_sync_clients(&self) -> Result<u64> {
        Ok(sqlx::query(
            "DELETE FROM sync_clients WHERE client_id IN (\
             SELECT client_id FROM sync_clients \
             WHERE updated_at < now() - make_interval(days => $1) \
             ORDER BY updated_at LIMIT 1000 FOR UPDATE SKIP LOCKED)",
        )
        .bind(crate::auth::SESSION_LIFETIME_DAYS as i32)
        .execute(&self.pool)
        .await?
        .rows_affected())
    }
}

/// Most distinct `(entity, id)` pairs one pull page may carry.
const PULL_LIMIT: usize = 1000;

#[derive(Debug, Serialize, utoipa::ToSchema)]
pub struct PullResponse {
    /// Snapshot xmin. Every transaction below it is reflected.
    pub cursor: String,
    /// True when more pages remain. `last_mutation_id` is null then.
    pub more: bool,
    /// True when the client must bootstrap again.
    pub reset: bool,
    /// The client's high-water mark, or 0 for a new client. Null on
    /// intermediate pages so the outbox is dropped only once all effects
    /// have arrived.
    pub last_mutation_id: Option<i64>,
    pub changes: Vec<super::changes::Change>,
}

impl Store {
    /// Changed records since `cursor` from one `REPEATABLE READ READ ONLY`
    /// snapshot, so the cursor, the changed rows, the rendered records and
    /// `last_mutation_id` are mutually consistent. A mutation committed
    /// during the pull is either fully reflected with its id reported, or
    /// entirely absent from both.
    pub async fn sync_pull(
        &self,
        workspace_id: Uuid,
        actor: Uuid,
        client_id: Uuid,
        cursor: Option<&str>,
    ) -> Result<PullResponse> {
        let mut tx = self.pool.begin().await?;
        sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
            .execute(&mut *tx)
            .await?;

        super::reads::authorize(&mut tx, workspace_id, actor).await?;

        let row = sqlx::query(
            "SELECT workspace_id, user_id, last_mutation_id FROM sync_clients \
             WHERE client_id = $1",
        )
        .bind(client_id)
        .fetch_optional(&mut *tx)
        .await?;
        let last_mutation_id = if let Some(row) = row {
            let owner_ws: Uuid = row.try_get("workspace_id")?;
            let owner: Uuid = row.try_get("user_id")?;
            if owner_ws != workspace_id || owner != actor {
                return Err(Error::BadRequest(
                    "client_id belongs to another user or workspace".into(),
                ));
            }
            row.try_get::<i64, _>("last_mutation_id")?
        } else {
            0
        };

        // Every transaction still in flight has a txid at or above xmin.
        let (xmin, xmax, horizon): (i64, i64, i64) = sqlx::query_as(
            "SELECT pg_snapshot_xmin(pg_current_snapshot())::text::bigint, \
             pg_snapshot_xmax(pg_current_snapshot())::text::bigint, \
             (SELECT txid FROM change_horizon)",
        )
        .fetch_one(&mut *tx)
        .await?;

        let Some(cursor) = cursor else {
            let response = PullResponse {
                cursor: xmin.to_string(),
                more: false,
                reset: false,
                last_mutation_id: Some(last_mutation_id),
                changes: Vec::new(),
            };
            tx.commit().await?;
            return Ok(response);
        };
        let requested: i64 = cursor
            .parse()
            .ok()
            .filter(|cursor| (0..=xmax).contains(cursor))
            .ok_or_else(|| Error::BadRequest("cursor must be a cursor from this server".into()))?;
        if requested < horizon {
            let response = PullResponse {
                cursor: xmin.to_string(),
                more: false,
                reset: true,
                last_mutation_id: Some(last_mutation_id),
                changes: Vec::new(),
            };
            tx.commit().await?;
            return Ok(response);
        }

        let own_change: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM changes WHERE workspace_id = $1 AND txid >= $2 \
             AND entity = 'members' AND entity_id = $3 \
             AND (user_id IS NULL OR user_id = $3))",
        )
        .bind(workspace_id)
        .bind(requested)
        .bind(actor)
        .fetch_one(&mut *tx)
        .await?;
        if own_change {
            let response = PullResponse {
                cursor: xmin.to_string(),
                more: false,
                reset: true,
                last_mutation_id: Some(last_mutation_id),
                changes: Vec::new(),
            };
            tx.commit().await?;
            return Ok(response);
        }

        // One row per distinct pair at its earliest txid in the window,
        // ordered by that txid. LIMIT 1001 bounds Rust memory: when more
        // than PULL_LIMIT pairs changed, the 1001st row's txid is the first
        // txid T whose cumulative count exceeds the limit.
        //
        // Pages cut only at txid boundaries, so every transaction below the
        // next cursor is fully included. The next cursor is capped at the
        // snapshot xmin, because transactions at or above xmin may still be
        // in flight and invisible; promising them would break the cursor
        // guarantee that every txid below the cursor is reflected. Repeats
        // across pages are harmless: records apply as current state.
        let rows: Vec<(String, Uuid, i64)> = sqlx::query_as(
            "SELECT entity, entity_id, MIN(txid) FROM changes \
             WHERE workspace_id = $1 AND txid >= $2 AND (user_id IS NULL OR user_id = $3) \
             GROUP BY entity, entity_id ORDER BY MIN(txid), entity, entity_id LIMIT 1001",
        )
        .bind(workspace_id)
        .bind(requested)
        .bind(actor)
        .fetch_all(&mut *tx)
        .await?;

        if rows.len() <= PULL_LIMIT {
            let mut changes: Vec<super::changes::Change> = rows
                .into_iter()
                .map(|(entity, id, _)| super::changes::Change {
                    entity,
                    id,
                    record: None,
                })
                .collect();
            super::changes::render(&mut tx, workspace_id, actor, &mut changes).await?;
            let response = PullResponse {
                cursor: xmin.to_string(),
                more: false,
                reset: false,
                last_mutation_id: Some(last_mutation_id),
                changes,
            };
            tx.commit().await?;
            return Ok(response);
        }

        let first_overflow = rows.last().map(|row| row.2).unwrap_or(requested);
        let page: Vec<(String, Uuid)> = rows
            .into_iter()
            .filter(|row| row.2 < first_overflow)
            .map(|row| (row.0, row.1))
            .collect();
        let next = first_overflow.min(xmin);
        if page.is_empty() || next == requested {
            let response = PullResponse {
                cursor: xmin.to_string(),
                more: false,
                reset: true,
                last_mutation_id: Some(last_mutation_id),
                changes: Vec::new(),
            };
            tx.commit().await?;
            return Ok(response);
        }

        let mut changes: Vec<super::changes::Change> = page
            .into_iter()
            .map(|(entity, id)| super::changes::Change {
                entity,
                id,
                record: None,
            })
            .collect();
        super::changes::render(&mut tx, workspace_id, actor, &mut changes).await?;
        let response = PullResponse {
            cursor: next.to_string(),
            more: true,
            reset: false,
            last_mutation_id: None,
            changes,
        };
        tx.commit().await?;
        Ok(response)
    }
}
