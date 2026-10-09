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
        Error::Database(_)
        | Error::Internal(_)
        | Error::Unauthorized
        | Error::ServiceUnavailable(_) => false,
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
        Error::Database(_)
        | Error::Internal(_)
        | Error::Unauthorized
        | Error::ServiceUnavailable(_) => (500, "internal server error".to_owned()),
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
            let remembered = match sqlx::query_as::<_, (i16, String)>(
                "SELECT status, message FROM sync_rejections WHERE client_id = $1 AND mutation_id = $2",
            )
            .bind(client_id)
            .bind(mutation.id)
            .fetch_optional(&mut *op.tx)
            .await
            {
                Ok(row) => row,
                Err(error) => {
                    return Err(abort(op, error.into(), "rejection lookup", mutation.id).await);
                }
            };
            let error = remembered.map(|(status, message)| MutationError {
                status: status as u16,
                message,
            });
            let tx = op.tx;
            return match tx.rollback().await {
                Ok(()) => Ok((
                    stored,
                    MutationResult {
                        id: mutation.id,
                        status: if error.is_some() {
                            MutationStatus::Rejected
                        } else {
                            MutationStatus::Duplicate
                        },
                        error,
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

        if let Some(error) = &result.error {
            if let Err(error) = sqlx::query(
                "INSERT INTO sync_rejections (client_id, mutation_id, status, message) \
                 VALUES ($1, $2, $3, $4)",
            )
            .bind(client_id)
            .bind(mutation.id)
            .bind(error.status as i16)
            .bind(&error.message)
            .execute(&mut *op.tx)
            .await
            {
                return Err(abort(op, error.into(), "remember rejection", mutation.id).await);
            }
            if let Err(error) = sqlx::query(
                "DELETE FROM sync_rejections WHERE client_id = $1 AND mutation_id IN (\
                 SELECT mutation_id FROM sync_rejections WHERE client_id = $1 \
                 ORDER BY mutation_id DESC OFFSET 1000)",
            )
            .bind(client_id)
            .execute(&mut *op.tx)
            .await
            {
                return Err(abort(op, error.into(), "prune rejections", mutation.id).await);
            }
        }

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
const PULL_PAIRS: usize = 1000;
/// Stop before the next txid once this many raw rows have been exceeded.
const PULL_ROWS: usize = 20_000;
/// Change rows read per round trip while scanning the pull window.
const PULL_BATCH: i64 = 2000;
/// Most in-flight txids a request cursor may list. Longer cursors are 400.
const MAX_XIP: usize = 10_000;

/// Ordered batches from the pull window at or above the request's xmax.
pub const PULL_BATCH_RANGE_SQL: &str = "SELECT txid, id, entity, entity_id FROM changes \
     WHERE workspace_id = $1 AND txid >= $2 AND (txid, id) > ($3, $4) \
       AND (user_id IS NULL OR user_id = $5) \
     ORDER BY txid, id LIMIT $6";

/// Ordered batches from the request's in-flight transactions, below xmax.
pub const PULL_BATCH_XIP_SQL: &str = "SELECT txid, id, entity, entity_id FROM changes \
     WHERE workspace_id = $1 AND txid = ANY($2::bigint[]) AND (txid, id) > ($3, $4) \
       AND (user_id IS NULL OR user_id = $5) \
     ORDER BY txid, id LIMIT $6";

/// Ordered, limited probes keep generic plans from scanning historical roles.
/// The limits sit inside subqueries so EXISTS does not discard their ordering.
pub const PULL_ROLE_CHANGED_SQL: &str = "SELECT EXISTS(SELECT 1 FROM (SELECT 1 FROM changes \
     WHERE workspace_id = $1 AND entity = 'roles' AND entity_id = $2 \
       AND (user_id IS NULL OR user_id = $2) AND txid >= $3 \
     ORDER BY txid LIMIT 1) markers) \
     OR EXISTS(SELECT 1 FROM (SELECT 1 FROM changes \
     WHERE workspace_id = $1 AND entity = 'roles' AND entity_id = $2 \
       AND (user_id IS NULL OR user_id = $2) AND txid = ANY($4::bigint[]) \
     ORDER BY txid LIMIT 1) markers)";

/// A PostgreSQL snapshot in its `xmin:xmax:xip` text form. A cursor `C`
/// promises that every txid below `C.xmax` except those in `C.xip` is
/// reflected in the client's base.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Snapshot {
    xmin: i64,
    xmax: i64,
    /// Sorted, unique, every entry in `[xmin, xmax)`.
    xip: Vec<i64>,
}

fn snapshot_text(snapshot: &Snapshot) -> String {
    let xip = snapshot
        .xip
        .iter()
        .map(i64::to_string)
        .collect::<Vec<_>>()
        .join(",");
    format!("{}:{}:{xip}", snapshot.xmin, snapshot.xmax)
}

/// Strictly parses a request cursor. Anything that is not a snapshot the
/// server could have produced is 400.
fn parse_cursor(cursor: &str, snapshot_xmax: i64) -> Result<Snapshot> {
    let invalid = || Error::BadRequest("cursor must be a cursor from this server".into());
    let (xmin_s, xmax_s, xip_s) = match cursor.split(':').collect::<Vec<_>>().as_slice() {
        [xmin, xmax, xip] => (*xmin, *xmax, *xip),
        _ => return Err(invalid()),
    };
    let integer = |value: &str| {
        if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
            return Err(invalid());
        }
        value.parse::<i64>().map_err(|_| invalid())
    };
    let xmin = integer(xmin_s)?;
    let xmax = integer(xmax_s)?;
    let mut xip: Vec<i64> = Vec::new();
    if !xip_s.is_empty() {
        for entry in xip_s.split(',') {
            if xip.len() == MAX_XIP {
                return Err(invalid());
            }
            xip.push(integer(entry)?);
        }
    }
    if xmin > xmax
        || xmax > snapshot_xmax
        || xip.windows(2).any(|pair| pair[0] >= pair[1])
        || xip.first().is_some_and(|first| *first != xmin)
        || xip.is_empty() && xmin != xmax
        || xip.last().is_some_and(|last| *last >= xmax)
    {
        return Err(invalid());
    }
    Ok(Snapshot { xmin, xmax, xip })
}

/// The cursor after a page that stopped before txid `T`: everything below `T`
/// visible in the pull's snapshot joins what the request cursor promised.
/// `xmax'` moves at least to `T`, and in-flight txids stay listed, so every
/// `more: true` page strictly grows the reflected set.
fn advance_cursor(current: &Snapshot, snapshot: &Snapshot, excluded: i64) -> Snapshot {
    let xmax = current.xmax.max(excluded);
    let mut xip: Vec<i64> = current
        .xip
        .iter()
        .filter(|x| **x >= excluded || snapshot.xip.binary_search(*x).is_ok())
        .copied()
        .collect();
    for x in &snapshot.xip {
        if *x >= current.xmax && *x < xmax {
            xip.push(*x);
        }
    }
    xip.sort_unstable();
    xip.dedup();
    let xmin = xip.first().copied().unwrap_or(xmax);
    Snapshot { xmin, xmax, xip }
}

#[derive(Debug, Serialize, utoipa::ToSchema)]
pub struct PullResponse {
    /// Snapshot in `xmin:xmax:xip` text form. Every txid below its xmax
    /// except those listed is reflected.
    pub cursor: String,
    /// True when more pages remain. `last_mutation_id` is null then.
    pub more: bool,
    /// True when the client must bootstrap again.
    pub reset: bool,
    /// The client's high-water mark on a final page. Null on intermediate
    /// pages so the outbox is dropped only once all effects have arrived,
    /// and null on resets and cursorless responses, which must not
    /// acknowledge the outbox.
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
        let (mut tx, last_mutation_id) = self.sync_read(workspace_id, actor, client_id).await?;

        // The pull's own snapshot. Rows committed after it are invisible to
        // the queries below, so the window is exactly "visible here but not
        // in the request cursor". A transaction open elsewhere only sits in
        // xip lists; it never holds the cursor back.
        let (snap_text, snapshot_xmin, snapshot_xmax, snapshot_xip, horizon): (
            String,
            i64,
            i64,
            Vec<i64>,
            i64,
        ) = sqlx::query_as(
            "SELECT pg_current_snapshot()::text, \
              pg_snapshot_xmin(pg_current_snapshot())::text::bigint, \
              pg_snapshot_xmax(pg_current_snapshot())::text::bigint, \
              COALESCE((SELECT array_agg(x::text::bigint) \
                        FROM pg_snapshot_xip(pg_current_snapshot()) AS t(x)), '{}'::bigint[]), \
              (SELECT txid FROM change_horizon)",
        )
        .fetch_one(&mut *tx)
        .await?;
        let mut snapshot_xip = snapshot_xip;
        snapshot_xip.sort_unstable();
        snapshot_xip.dedup();
        let snapshot = Snapshot {
            xmin: snapshot_xmin,
            xmax: snapshot_xmax,
            xip: snapshot_xip,
        };

        let Some(cursor) = cursor else {
            let response = PullResponse {
                cursor: snap_text,
                more: false,
                reset: false,
                last_mutation_id: None,
                changes: Vec::new(),
            };
            tx.commit().await?;
            return Ok(response);
        };
        let requested = parse_cursor(cursor, snapshot.xmax)?;
        if requested.xmin < horizon {
            let response = PullResponse {
                cursor: snap_text,
                more: false,
                reset: true,
                last_mutation_id: None,
                changes: Vec::new(),
            };
            tx.commit().await?;
            return Ok(response);
        }

        // Check the full window, even when a role change sits beyond this page.
        let role_changed: bool = sqlx::query_scalar(PULL_ROLE_CHANGED_SQL)
            .bind(workspace_id)
            .bind(actor)
            .bind(requested.xmax)
            .bind(&requested.xip)
            .fetch_one(&mut *tx)
            .await?;
        if role_changed {
            tx.commit().await?;
            return Ok(PullResponse {
                cursor: snap_text,
                more: false,
                reset: true,
                last_mutation_id: None,
                changes: Vec::new(),
            });
        }

        // Every xip txid is below xmax, so scanning xip first preserves
        // (txid, id) order without merging or sorting the two index ranges.
        let mut scanning_xip = !requested.xip.is_empty();
        let mut last = (-1i64, -1i64);
        let mut pairs = std::collections::BTreeSet::new();
        let mut group = std::collections::BTreeSet::new();
        let mut group_txid = None;
        let mut included_txids = 0;
        let mut scanned = 0;
        let mut excluded = None;

        'scan: loop {
            let query = if scanning_xip {
                sqlx::query_as(PULL_BATCH_XIP_SQL)
                    .bind(workspace_id)
                    .bind(&requested.xip)
            } else {
                sqlx::query_as(PULL_BATCH_RANGE_SQL)
                    .bind(workspace_id)
                    .bind(requested.xmax)
            };
            let rows: Vec<(i64, i64, String, Uuid)> = query
                .bind(last.0)
                .bind(last.1)
                .bind(actor)
                .bind(PULL_BATCH)
                .fetch_all(&mut *tx)
                .await?;
            let batch_full = rows.len() as i64 == PULL_BATCH;
            for (txid, id, entity, entity_id) in rows {
                last = (txid, id);
                if group_txid != Some(txid) {
                    if group_txid.is_some() {
                        pairs.append(&mut group);
                        included_txids += 1;
                    }
                    if scanned > PULL_ROWS {
                        excluded = Some(txid);
                        break 'scan;
                    }
                    group_txid = Some(txid);
                }
                scanned += 1;
                if entity != "roles" {
                    let pair = (entity, entity_id);
                    if !pairs.contains(&pair) {
                        group.insert(pair);
                    }
                    // Exclude the entire transaction as soon as it cannot fit.
                    // Its remaining rows need not be read or retained.
                    if pairs.len() + group.len() > PULL_PAIRS {
                        excluded = Some(txid);
                        break 'scan;
                    }
                }
            }
            if !batch_full {
                if scanning_xip {
                    scanning_xip = false;
                    continue;
                }
                pairs.append(&mut group);
                break;
            }
        }

        if excluded.is_some() && included_txids == 0 {
            tx.commit().await?;
            return Ok(PullResponse {
                cursor: snap_text,
                more: false,
                reset: true,
                last_mutation_id: None,
                changes: Vec::new(),
            });
        }

        let mut changes: Vec<super::changes::Change> = pairs
            .into_iter()
            .map(|(entity, id)| super::changes::Change {
                entity,
                id,
                record: None,
            })
            .collect();
        super::changes::render(
            &mut tx,
            workspace_id,
            actor,
            &mut changes,
            super::changes::RecordShape::Sync,
        )
        .await?;
        let more = excluded.is_some();
        let next = excluded
            .map(|txid| snapshot_text(&advance_cursor(&requested, &snapshot, txid)))
            .unwrap_or(snap_text);
        let response = PullResponse {
            cursor: next,
            more,
            reset: false,
            last_mutation_id: (!more).then_some(last_mutation_id),
            changes,
        };
        tx.commit().await?;
        Ok(response)
    }
}

impl Store {
    async fn sync_read(
        &self,
        workspace_id: Uuid,
        actor: Uuid,
        client_id: Uuid,
    ) -> Result<(Transaction<'static, Postgres>, i64)> {
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

        Ok((tx, last_mutation_id))
    }

    /// The same membership and client checks as pull, done once when an
    /// event stream connects. Streams hold no database connection afterwards.
    pub async fn sync_events_check(
        &self,
        workspace_id: Uuid,
        actor: Uuid,
        client_id: Uuid,
    ) -> Result<()> {
        let mut conn = self.pool.acquire().await?;
        super::reads::authorize(&mut conn, workspace_id, actor).await?;

        if let Some(row) =
            sqlx::query("SELECT workspace_id, user_id FROM sync_clients WHERE client_id = $1")
                .bind(client_id)
                .fetch_optional(&mut *conn)
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
        Ok(())
    }
}

/// Bump whenever a sync record shape changes.
pub const SYNC_SCHEMA: u32 = 1;

/// How long a bootstrap waits for a concurrency permit before answering 503.
pub const BOOTSTRAP_PERMIT_WAIT: std::time::Duration = std::time::Duration::from_secs(5);
/// Deadline for each channel send while streaming a bootstrap. A slow reader
/// that stops consuming ends the body without a trailer after this long.
pub const BOOTSTRAP_SEND_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);
/// Deadline for a whole bootstrap, from permit acquisition to trailer.
pub const BOOTSTRAP_OVERALL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(300);

/// Concurrent bootstraps are capped at a quarter of the pool's connections,
/// at least one, so slow readers cannot hold every shared connection.
pub(crate) fn bootstrap_permits(max_connections: u32) -> usize {
    ((max_connections / 4).max(1)) as usize
}

const BOOTSTRAP_ENTITIES: &[&str] = &[
    "workspace",
    "members",
    "teams",
    "labels",
    "projects",
    "milestones",
    "sprints",
    "views",
    "alert_preferences",
    "notifications",
    "invitations",
    "integrations",
    "issues",
    "time_entries",
];

pub enum SyncScope {
    Comments(Uuid),
    Activity(Uuid),
}

#[derive(Debug, Serialize, utoipa::ToSchema)]
pub struct ScopeResponse {
    pub records: Vec<Value>,
}

enum SendOutcome {
    Sent,
    /// The receiver stopped reading but is still open; the body ends without
    /// a trailer after the send deadline.
    Timeout,
    /// The receiver was dropped; the body ends silently.
    Closed,
}

async fn send_value(
    sender: &tokio::sync::mpsc::Sender<Result<Vec<u8>>>,
    value: Value,
    timeout: std::time::Duration,
) -> Result<SendOutcome> {
    let mut bytes = serde_json::to_vec(&value)?;
    bytes.push(b'\n');
    Ok(
        match tokio::time::timeout(timeout, sender.send(Ok(bytes))).await {
            Ok(Ok(())) => SendOutcome::Sent,
            Ok(Err(_)) => SendOutcome::Closed,
            Err(_) => SendOutcome::Timeout,
        },
    )
}

#[allow(clippy::too_many_arguments)]
async fn bootstrap_on(
    mut tx: Transaction<'static, Postgres>,
    workspace: Uuid,
    actor: Uuid,
    client_id: Uuid,
    header: Value,
    sender: &tokio::sync::mpsc::Sender<Result<Vec<u8>>>,
    send_timeout: std::time::Duration,
    sent: &std::sync::atomic::AtomicU64,
) -> Result<()> {
    use std::sync::atomic::Ordering;
    use tokio_stream::StreamExt;

    match send_value(sender, header, send_timeout).await? {
        SendOutcome::Sent => {}
        SendOutcome::Timeout => {
            tracing::warn!(
                workspace_id = %workspace,
                client_id = %client_id,
                records = 0,
                deadline = "send",
                "sync bootstrap timed out"
            );
            return Ok(());
        }
        SendOutcome::Closed => return Ok(()),
    }
    let mut records = 0u64;
    for entity in BOOTSTRAP_ENTITIES {
        let mut query =
            super::changes::select(workspace, actor, entity, super::changes::RecordShape::Sync)?;
        query.push(" ORDER BY 1");
        let mut rows = query.build_query_as::<(Uuid, Value)>().fetch(&mut *tx);
        loop {
            let row = tokio::select! {
                _ = sender.closed() => return Ok(()),
                row = rows.next() => row,
            };
            let Some((_, record)) = row.transpose()? else {
                break;
            };
            match send_value(
                sender,
                serde_json::json!({"entity": entity, "record": record}),
                send_timeout,
            )
            .await?
            {
                SendOutcome::Sent => {
                    records += 1;
                    sent.store(records, Ordering::Relaxed);
                }
                SendOutcome::Timeout => {
                    tracing::warn!(
                        workspace_id = %workspace,
                        client_id = %client_id,
                        records = records,
                        deadline = "send",
                        "sync bootstrap timed out"
                    );
                    return Ok(());
                }
                SendOutcome::Closed => return Ok(()),
            }
        }
    }
    tx.commit().await?;
    match send_value(
        sender,
        serde_json::json!({"end": true, "records": records}),
        send_timeout,
    )
    .await?
    {
        SendOutcome::Sent => {}
        SendOutcome::Timeout => {
            tracing::warn!(
                workspace_id = %workspace,
                client_id = %client_id,
                records = records,
                deadline = "send",
                "sync bootstrap timed out"
            );
        }
        SendOutcome::Closed => {}
    }
    Ok(())
}

impl Store {
    pub async fn sync_bootstrap(
        &self,
        workspace: Uuid,
        actor: Uuid,
        client_id: Uuid,
    ) -> Result<tokio::sync::mpsc::Receiver<Result<Vec<u8>>>> {
        // The permit comes before the connection and is held until the task
        // ends, so queued bootstraps wait here instead of holding pool
        // connections while unread.
        let permit = match tokio::time::timeout(
            self.bootstrap_permit_wait,
            self.bootstrap_permits.clone().acquire_owned(),
        )
        .await
        {
            Err(_) => {
                return Err(Error::ServiceUnavailable(
                    "bootstrap busy, retry later".into(),
                ));
            }
            Ok(Err(_)) => {
                return Err(Error::Internal("bootstrap limiter closed".into()));
            }
            Ok(Ok(permit)) => permit,
        };
        let store = self.clone();
        let (sender, receiver) = tokio::sync::mpsc::channel(16);
        let (ready, started) = tokio::sync::oneshot::channel();
        tokio::spawn(async move {
            let _permit = permit;
            let prepared: Result<_> = async {
                let (mut tx, last_mutation_id) =
                    store.sync_read(workspace, actor, client_id).await?;
                let cursor: String = sqlx::query_scalar("SELECT pg_current_snapshot()::text")
                    .fetch_one(&mut *tx)
                    .await?;
                Ok((
                    tx,
                    serde_json::json!({
                        "cursor": cursor,
                        "last_mutation_id": last_mutation_id,
                        "schema": SYNC_SCHEMA,
                    }),
                ))
            }
            .await;
            match prepared {
                Err(error) => {
                    let _ = ready.send(Err(error));
                }
                Ok((tx, header)) => {
                    if ready.send(Ok(())).is_err() {
                        return;
                    }
                    let send_timeout = store.bootstrap_send_timeout;
                    let overall_timeout = store.bootstrap_overall_timeout;
                    let sent = std::sync::atomic::AtomicU64::new(0);
                    match tokio::time::timeout(
                        overall_timeout,
                        bootstrap_on(
                            tx,
                            workspace,
                            actor,
                            client_id,
                            header,
                            &sender,
                            send_timeout,
                            &sent,
                        ),
                    )
                    .await
                    {
                        Ok(Ok(())) => {}
                        Ok(Err(error)) => {
                            if !sender.is_closed() {
                                tracing::error!(%workspace, %error, "sync bootstrap failed");
                                let _ = sender.send(Err(error)).await;
                            }
                        }
                        Err(_) => {
                            tracing::warn!(
                                workspace_id = %workspace,
                                client_id = %client_id,
                                records = sent
                                    .load(std::sync::atomic::Ordering::Relaxed),
                                deadline = "overall",
                                "sync bootstrap timed out"
                            );
                        }
                    }
                }
            }
        });
        started
            .await
            .map_err(|_| Error::Internal("bootstrap task stopped".into()))??;
        Ok(receiver)
    }

    pub async fn sync_scope(
        &self,
        workspace: Uuid,
        actor: Uuid,
        client_id: Uuid,
        scope: SyncScope,
    ) -> Result<ScopeResponse> {
        let (mut tx, _) = self.sync_read(workspace, actor, client_id).await?;
        let (entity, column, id) = match scope {
            SyncScope::Comments(id) => ("comments", "issue_id", id),
            SyncScope::Activity(id) => ("activity", "entity_id", id),
        };
        let mut query =
            super::changes::select(workspace, actor, entity, super::changes::RecordShape::Sync)?;
        query.push(format!(" AND t.{column}=")).push_bind(id);
        query.push(" ORDER BY t.id");
        let rows: Vec<(Uuid, Value)> = query.build_query_as().fetch_all(&mut *tx).await?;
        tx.commit().await?;
        Ok(ScopeResponse {
            records: rows.into_iter().map(|(_, record)| record).collect(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::{MAX_XIP, Snapshot, advance_cursor, parse_cursor, snapshot_text};

    fn snapshot(xmin: i64, xmax: i64, xip: &[i64]) -> Snapshot {
        Snapshot {
            xmin,
            xmax,
            xip: xip.to_vec(),
        }
    }

    #[test]
    fn cursor_round_trip() {
        for text in ["847:847:", "845:847:845,846", "0:0:"] {
            let parsed = parse_cursor(text, 1000).unwrap();
            assert_eq!(snapshot_text(&parsed), text);
        }
    }

    #[test]
    fn cursor_rejects_garbage() {
        for bad in [
            "",
            "845",
            "845:847",
            "845:847::",
            "845:847:845,",
            "845:847:,845",
            "nope",
            "845:x:847",
            "-1:5:",
            "+0:0:",
            "0:+0:",
            "0:5:+0",
            "0:5:",
            "5:5:5",
            "847:845:",
            "845:847:847",
            "846:847:845,846",
            "845:847:846,845",
            "845:847:845,845",
            "845:847:844",
        ] {
            assert!(parse_cursor(bad, 1000).is_err(), "{bad:?}");
        }
        // Beyond the pull's own snapshot: from the future.
        assert!(parse_cursor("990:1010:", 1000).is_err());
        assert!(parse_cursor("990:1000:990", 1000).is_ok());
        // Over the xip cap.
        let huge = format!(
            "1:20000:{}",
            (1..=MAX_XIP as i64 + 1)
                .map(|x| x.to_string())
                .collect::<Vec<_>>()
                .join(",")
        );
        assert!(parse_cursor(&huge, 1_000_000).is_err());
    }

    #[test]
    fn advance_below_request_xmax_keeps_later_xip() {
        // The page delivered only transactions from the request xip; T sits
        // below the request xmax, so xmax stays and later xip entries stay.
        let current = snapshot(12, 20, &[12, 15]);
        let pulled = snapshot(18, 22, &[18, 21]);
        assert_eq!(
            advance_cursor(&current, &pulled, 15),
            snapshot(15, 20, &[15])
        );
    }

    #[test]
    fn advance_above_request_xmax_absorbs_inflight() {
        // T moves past the request xmax; in-flight transactions below it
        // stay listed, committed ones drop.
        let current = snapshot(12, 20, &[12]);
        let pulled = snapshot(21, 25, &[21, 24]);
        assert_eq!(
            advance_cursor(&current, &pulled, 23),
            snapshot(21, 23, &[21])
        );
    }

    #[test]
    fn advance_drops_snapshot_xip_below_request_xmax() {
        // 18 was already reflected in the request cursor (below its xmax
        // and not listed), so it stays dropped even though still in flight.
        let current = snapshot(20, 20, &[]);
        let pulled = snapshot(18, 30, &[18, 25]);
        assert_eq!(advance_cursor(&current, &pulled, 22), snapshot(22, 22, &[]));
    }

    #[test]
    fn advance_keeps_unresolved_request_xip() {
        // The page delivered 15, but 12 is still in flight and 18 is
        // excluded. Both unresolved request entries must stay listed.
        let current = snapshot(12, 20, &[12, 15, 18]);
        let pulled = snapshot(12, 22, &[12, 21]);
        assert_eq!(
            advance_cursor(&current, &pulled, 18),
            snapshot(12, 20, &[12, 18])
        );
    }

    #[test]
    fn advance_empty_xips() {
        let current = snapshot(20, 20, &[]);
        let pulled = snapshot(25, 25, &[]);
        assert_eq!(advance_cursor(&current, &pulled, 23), snapshot(23, 23, &[]));
    }
}
