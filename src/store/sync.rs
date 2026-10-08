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
    /// Database or internal failure; stop and answer 503.
    Transient,
    /// The client row belongs to another user or workspace; answer 400.
    ClientTaken,
}

async fn abort(op: Operation<'_>) -> PushFailure {
    let tx = op.tx;
    let _ = tx.rollback().await;
    PushFailure::Transient
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

        {
            let mut conn = self.pool.acquire().await?;
            super::reads::authorize(&mut conn, workspace_id, actor).await?;
        }

        if let Some(row) =
            sqlx::query("SELECT workspace_id, user_id FROM sync_clients WHERE client_id = $1")
                .bind(client_id)
                .fetch_optional(&self.pool)
                .await?
        {
            let owner_ws: Uuid = row.try_get("workspace_id")?;
            let owner: Uuid = row.try_get("user_id")?;
            if owner_ws != workspace_id || owner != actor {
                return Err(Error::BadRequest(
                    "client_id belongs to another user or workspace".into(),
                ));
            }
        }

        let last: i64 =
            sqlx::query_scalar("SELECT last_mutation_id FROM sync_clients WHERE client_id = $1")
                .bind(client_id)
                .fetch_optional(&self.pool)
                .await?
                .unwrap_or(0);

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
                Err(PushFailure::Transient) => {
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
            Err(_) => return Err(PushFailure::Transient),
        };

        if sqlx::query(
            "INSERT INTO sync_clients (client_id, workspace_id, user_id) VALUES ($1, $2, $3) \
             ON CONFLICT (client_id) DO NOTHING",
        )
        .bind(client_id)
        .bind(workspace_id)
        .bind(actor)
        .execute(&mut *op.tx)
        .await
        .is_err()
        {
            return Err(abort(op).await);
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
            Err(_) => return Err(abort(op).await),
        };

        let owner_ws: Uuid = row
            .try_get("workspace_id")
            .map_err(|_| PushFailure::Transient)?;
        let owner: Uuid = row.try_get("user_id").map_err(|_| PushFailure::Transient)?;
        let stored: i64 = row
            .try_get("last_mutation_id")
            .map_err(|_| PushFailure::Transient)?;
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
                Err(_) => Err(PushFailure::Transient),
            };
        }

        if sqlx::query("SAVEPOINT sync_mutation")
            .execute(&mut *op.tx)
            .await
            .is_err()
        {
            return Err(abort(op).await);
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
            Err(_) => return Err(abort(op).await),
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
                Err(_) => Err(PushFailure::Transient),
            },
            Err(_) => Err(abort(op).await),
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
