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
    /// The highest mutation id the client has seen acknowledged by a pull or bootstrap.
    /// A stored high-water mark below it means the server lost the client's state, so
    /// the batch is refused with 409 instead of re-running mutations. Defaults to 0.
    #[serde(default)]
    pub acknowledged: i64,
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
    /// The stored high-water mark is below what the client already holds; answer 409.
    StateLost,
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

/// Turns a fatal push failure into the request error. A transient failure
/// is logged and returns Ok, so the caller truncates the batch instead.
fn fatal(failure: PushFailure, workspace_id: Uuid, client_id: Uuid) -> Result<()> {
    match failure {
        PushFailure::Forbidden => Err(Error::Forbidden),
        PushFailure::ClientTaken => Err(Error::BadRequest(
            "client_id belongs to another user or workspace".into(),
        )),
        PushFailure::StateLost => Err(Error::Conflict("client state lost".into())),
        PushFailure::Transient {
            error,
            phase,
            mutation_id,
        } => {
            log_transient(workspace_id, client_id, mutation_id, phase, &error);
            Ok(())
        }
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

/// A deterministic server failure rejected one mutation. Ids only, as above.
fn log_defect(workspace_id: Uuid, client_id: Uuid, mutation_id: i64, error: &Error) {
    tracing::error!(
        workspace_id = %workspace_id,
        client_id = %client_id,
        mutation_id = mutation_id,
        error = %error,
        "sync push rejected a mutation on a server failure"
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

/// What a failed mutation does to its batch.
#[derive(Debug, PartialEq, Eq)]
enum Disposition {
    /// The command was refused for a reason the client can see.
    Business,
    /// A server-side failure a retry would repeat, such as a bug or a bad
    /// schema state. One mutation is rejected so the client's queue moves on.
    Defect,
    /// A retry can succeed. The batch stops and the client resends it.
    Retry,
}

fn disposition(error: &Error) -> Disposition {
    match error {
        Error::BadRequest(_)
        | Error::NotFound
        | Error::Conflict(_)
        | Error::Stale(_)
        | Error::PreconditionFailed(_)
        | Error::Denied(_)
        | Error::Forbidden
        | Error::Json(_) => Disposition::Business,
        Error::Unauthorized | Error::AccountChanged | Error::ServiceUnavailable(_) => {
            Disposition::Retry
        }
        Error::Internal(_) => Disposition::Defect,
        Error::Database(error) => database_disposition(error),
    }
}

fn database_disposition(error: &sqlx::Error) -> Disposition {
    match error {
        sqlx::Error::Database(db) => match db.code().as_deref() {
            Some(code) if code.starts_with("22") || code.starts_with("23") => Disposition::Business,
            Some("40001" | "40P01" | "55P03" | "57014" | "57P01" | "57P02" | "57P03") => {
                Disposition::Retry
            }
            Some(code) if code.starts_with("08") || code.starts_with("53") => Disposition::Retry,
            _ => Disposition::Defect,
        },
        sqlx::Error::Io(_)
        | sqlx::Error::Tls(_)
        | sqlx::Error::Protocol(_)
        | sqlx::Error::PoolTimedOut
        | sqlx::Error::PoolClosed
        | sqlx::Error::WorkerCrashed => Disposition::Retry,
        _ => Disposition::Defect,
    }
}

/// Commands push never runs, with the message the rejection carries.
fn refusal(command: &Command) -> Option<&'static str> {
    match command {
        // Uploads need their bytes.
        Command::AddAttachment { .. } | Command::AttachCommentFile { .. } => {
            Some("use the attachment upload endpoint")
        }
        // An invitation's token can't ride in a push result, and an
        // integration's secret must not sit in the client's outbox. The
        // rest are online-only per docs/sync.md.
        Command::Invite { .. }
        | Command::ResendInvitation { .. }
        | Command::CreateIntegration { .. }
        | Command::UpdateWorkspace { .. }
        | Command::SetRole { .. }
        | Command::RemoveMember { .. }
        | Command::TransferOwnership { .. }
        | Command::DeleteTeam { .. }
        | Command::ImportIssues { .. } => Some("use the commands endpoint"),
        _ => None,
    }
}

/// The `{status, message}` the REST command endpoint would return for this error.
fn rejection(error: &Error) -> MutationError {
    let (status, message) = match error {
        Error::BadRequest(message) => (400, message.clone()),
        Error::Forbidden | Error::Denied(_) => (403, error.to_string()),
        Error::PreconditionFailed(message) => (412, message.clone()),
        Error::NotFound => (404, error.to_string()),
        Error::Conflict(message) | Error::Stale(message) => (409, message.clone()),
        Error::Json(error) => (400, error.to_string()),
        Error::Database(_)
        | Error::Internal(_)
        | Error::Unauthorized
        | Error::AccountChanged
        | Error::ServiceUnavailable(_) => (500, "internal server error".to_owned()),
    };
    MutationError { status, message }
}

/// What a pushed mutation did inside its transaction.
enum PushStep {
    /// The client row belongs to another user or workspace.
    ClientTaken,
    /// The row's high-water mark is below the client's acknowledged id.
    StateLost,
    /// Already processed: the stored high-water mark and the remembered result.
    Seen(i64, MutationResult),
    /// Applied or rejected now; the transaction should commit.
    Applied(MutationResult),
}

/// Tags a failure with the push phase it happened in, for the transient log line.
trait Phase<T> {
    fn phase(self, phase: &'static str) -> std::result::Result<T, (Error, &'static str)>;
}

impl<T, E: Into<Error>> Phase<T> for std::result::Result<T, E> {
    fn phase(self, phase: &'static str) -> std::result::Result<T, (Error, &'static str)> {
        self.map_err(|error| (error.into(), phase))
    }
}

/// Claims the client row, then replays a remembered result or runs the
/// command in a savepoint and advances the client's high-water mark.
async fn apply_mutation(
    op: &mut Operation<'_>,
    client_id: Uuid,
    acknowledged: i64,
    mutation: &SyncMutation,
    built: Result<Command>,
) -> std::result::Result<PushStep, (Error, &'static str)> {
    sqlx::query!(
        "INSERT INTO sync_clients (client_id, workspace_id, user_id) VALUES ($1, $2, $3) \
         ON CONFLICT (client_id) DO NOTHING",
        client_id,
        op.workspace_id,
        op.actor,
    )
    .execute(&mut *op.tx)
    .await
    .phase("client row")?;

    let row = sqlx::query!(
        "SELECT workspace_id, user_id, last_mutation_id FROM sync_clients \
         WHERE client_id = $1 FOR UPDATE",
        client_id,
    )
    .fetch_one(&mut *op.tx)
    .await
    .phase("client row")?;
    let stored = row.last_mutation_id;
    if row.workspace_id != op.workspace_id || row.user_id != op.actor {
        return Ok(PushStep::ClientTaken);
    }
    // A row this transaction just inserted reads 0, and the rollback removes it.
    if stored < acknowledged {
        return Ok(PushStep::StateLost);
    }
    if mutation.id <= stored {
        let result = remembered_result(op, client_id, mutation.id).await?;
        return Ok(PushStep::Seen(stored, result));
    }

    sqlx::query("SAVEPOINT sync_mutation")
        .execute(&mut *op.tx)
        .await
        .phase("savepoint")?;
    let result = match run_in_savepoint(op, built).await {
        Ok(()) => MutationResult {
            id: mutation.id,
            status: MutationStatus::Applied,
            error: None,
        },
        Err(error) => {
            let disposition = disposition(&error);
            if disposition == Disposition::Retry {
                return Err((error, "command"));
            }
            // Any failed statement aborts the transaction until this runs, so
            // the client row can only advance after it succeeds.
            sqlx::query("ROLLBACK TO SAVEPOINT sync_mutation")
                .execute(&mut *op.tx)
                .await
                .phase("rollback")?;
            if disposition == Disposition::Defect {
                log_defect(op.workspace_id, client_id, mutation.id, &error);
            }
            MutationResult {
                id: mutation.id,
                status: MutationStatus::Rejected,
                error: Some(rejection(&error)),
            }
        }
    };
    if let Some(error) = &result.error {
        remember_rejection(op, client_id, mutation.id, error).await?;
    }

    sqlx::query!(
        "UPDATE sync_clients SET last_mutation_id = $1, updated_at = now() \
         WHERE client_id = $2",
        mutation.id,
        client_id,
    )
    .execute(&mut *op.tx)
    .await
    .phase("advance")?;
    Ok(PushStep::Applied(result))
}

/// A mutation at or below the high-water mark was a duplicate, or a
/// rejection the server remembers.
async fn remembered_result(
    op: &mut Operation<'_>,
    client_id: Uuid,
    mutation_id: i64,
) -> std::result::Result<MutationResult, (Error, &'static str)> {
    let remembered = sqlx::query!(
        "SELECT status, message FROM sync_rejections WHERE client_id = $1 AND mutation_id = $2",
        client_id,
        mutation_id,
    )
    .fetch_optional(&mut *op.tx)
    .await
    .phase("rejection lookup")?;
    let error = remembered.map(|row| MutationError {
        status: row.status as u16,
        message: row.message,
    });
    Ok(MutationResult {
        id: mutation_id,
        status: if error.is_some() {
            MutationStatus::Rejected
        } else {
            MutationStatus::Duplicate
        },
        error,
    })
}

/// Runs the command inside the savepoint. The caller rolls back on failure.
async fn run_in_savepoint(op: &mut Operation<'_>, built: Result<Command>) -> Result<()> {
    let command = built?;
    if let Some(message) = refusal(&command) {
        return Err(Error::BadRequest(message.into()));
    }
    op.run_command(command, None).await?;
    Ok(())
}

/// Keeps the newest 1000 rejections per client for replay.
async fn remember_rejection(
    op: &mut Operation<'_>,
    client_id: Uuid,
    mutation_id: i64,
    error: &MutationError,
) -> std::result::Result<(), (Error, &'static str)> {
    sqlx::query!(
        "INSERT INTO sync_rejections (client_id, mutation_id, status, message) \
         VALUES ($1, $2, $3, $4)",
        client_id,
        mutation_id,
        error.status as i16,
        &error.message,
    )
    .execute(&mut *op.tx)
    .await
    .phase("remember rejection")?;
    sqlx::query!(
        "DELETE FROM sync_rejections WHERE client_id = $1 AND mutation_id IN (\
         SELECT mutation_id FROM sync_rejections WHERE client_id = $1 \
         ORDER BY mutation_id DESC OFFSET 1000)",
        client_id,
    )
    .execute(&mut *op.tx)
    .await
    .phase("prune rejections")?;
    Ok(())
}

impl Store {
    pub async fn sync_push(
        &self,
        workspace_id: WorkspaceId,
        actor: Uuid,
        client_id: Uuid,
        acknowledged: i64,
        mutations: Vec<SyncMutation>,
    ) -> Result<PushOutcome> {
        let workspace_id = workspace_id.0;
        if mutations.is_empty() || mutations.len() > MAX_MUTATIONS {
            return Err(Error::BadRequest("push 1 to 100 mutations".into()));
        }
        if acknowledged < 0 {
            return Err(Error::BadRequest(
                "acknowledged must not be negative".into(),
            ));
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

        let truncated = |last_mutation_id, results| PushOutcome {
            response: PushResponse {
                last_mutation_id,
                results,
            },
            truncated: true,
        };
        // Preflight failures carry no transaction, so they truncate the
        // batch with the high-water mark as known (0 here: nothing has
        // been read yet). Membership and ownership rejections stay 400/403.
        let last = match self.push_preflight(workspace_id, actor, client_id).await {
            Ok(last) => last,
            Err(failure) => {
                fatal(failure, workspace_id, client_id)?;
                return Ok(truncated(0, Vec::new()));
            }
        };

        let mut last_mutation_id = last;
        let mut results = Vec::with_capacity(mutations.len());
        for mutation in &mutations {
            match self
                .push_mutation(workspace_id, actor, client_id, acknowledged, mutation)
                .await
            {
                Ok((current, result)) => {
                    last_mutation_id = current;
                    results.push(result);
                }
                Err(failure) => {
                    fatal(failure, workspace_id, client_id)?;
                    return Ok(truncated(last_mutation_id, results));
                }
            }
        }

        Ok(PushOutcome {
            response: PushResponse {
                last_mutation_id,
                results,
            },
            truncated: false,
        })
    }

    /// Checks membership and client ownership outside any transaction and
    /// reads the client's high-water mark, 0 for a new client.
    async fn push_preflight(
        &self,
        workspace_id: Uuid,
        actor: Uuid,
        client_id: Uuid,
    ) -> std::result::Result<i64, PushFailure> {
        let transient = |error: Error| PushFailure::Transient {
            error,
            phase: "preflight",
            mutation_id: None,
        };
        {
            let mut conn = self.pool.acquire().await.map_err(|e| transient(e.into()))?;
            match super::reads::authorize(&mut conn, workspace_id, actor).await {
                Ok(_) => {}
                Err(Error::Forbidden) => return Err(PushFailure::Forbidden),
                Err(error) => return Err(transient(error)),
            }
        }

        let row = sqlx::query!(
            "SELECT workspace_id, user_id, last_mutation_id FROM sync_clients WHERE client_id = $1",
            client_id,
        )
        .fetch_optional(&self.pool)
        .await
        .map_err(|e| transient(e.into()))?;
        let Some(row) = row else {
            return Ok(0);
        };
        if row.workspace_id != workspace_id || row.user_id != actor {
            return Err(PushFailure::ClientTaken);
        }
        Ok(row.last_mutation_id)
    }

    async fn push_mutation(
        &self,
        workspace_id: Uuid,
        actor: Uuid,
        client_id: Uuid,
        acknowledged: i64,
        mutation: &SyncMutation,
    ) -> std::result::Result<(i64, MutationResult), PushFailure> {
        // Pure deserialization first; the variant decides the operation's lock.
        let built = build_command(&mutation.name, &mutation.args);
        let exclusive = built
            .as_ref()
            .map(|command| refusal(command).is_none() && super::membership_exclusive(command))
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

        let step = match apply_mutation(&mut op, client_id, acknowledged, mutation, built).await {
            Ok(step) => step,
            Err((error, phase)) => return Err(abort(op, error, phase, mutation.id).await),
        };
        let (finish, phase, outcome) = match step {
            PushStep::ClientTaken => {
                let _ = op.tx.rollback().await;
                return Err(PushFailure::ClientTaken);
            }
            PushStep::StateLost => {
                let _ = op.tx.rollback().await;
                return Err(PushFailure::StateLost);
            }
            PushStep::Seen(stored, result) => {
                (op.tx.rollback().await, "client row", (stored, result))
            }
            PushStep::Applied(result) => (op.tx.commit().await, "commit", (mutation.id, result)),
        };
        finish
            .map(|()| outcome)
            .map_err(|error| PushFailure::Transient {
                error: error.into(),
                phase,
                mutation_id: Some(mutation.id),
            })
    }
}

/// Most distinct `(entity, id)` pairs one pull page may carry.
const PULL_PAIRS: usize = 1000;
/// Most raw change rows one pull page accepts. Repeats of one record count.
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

/// A transaction delivered only up to one of its change rows. It is in the
/// cursor snapshot's window, so the snapshot alone would deliver all of it
/// again.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Partial {
    txid: i64,
    /// Rows of `txid` with an id at or below this reached the client.
    row: i64,
}

/// What a request cursor promises: everything visible in `snapshot`, plus
/// the rows of `partial`.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Cursor {
    snapshot: Snapshot,
    partial: Option<Partial>,
}

impl Cursor {
    /// Whether the pull's snapshot can have followed this cursor. A cursor
    /// that reaches past it, with its xmax or a partial transaction, came
    /// from another history.
    fn within(&self, snapshot: &Snapshot) -> bool {
        self.snapshot.xmax <= snapshot.xmax
            && self
                .partial
                .is_none_or(|partial| partial.txid < snapshot.xmax)
    }
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

fn cursor_text(cursor: &Cursor) -> String {
    let snapshot = snapshot_text(&cursor.snapshot);
    match cursor.partial {
        Some(partial) => format!("{snapshot}:{}.{}", partial.txid, partial.row),
        None => snapshot,
    }
}

fn invalid_cursor() -> Error {
    Error::BadRequest("cursor must be a cursor from this server".into())
}

/// Splits a request cursor into the epoch that issued it and its snapshot
/// text. Cursors from before epochs existed have no epoch.
fn split_epoch(cursor: &str) -> Result<(Option<Uuid>, &str)> {
    let Some((epoch, rest)) = cursor.split_once('@') else {
        return Ok((None, cursor));
    };
    if epoch.len() != 32 {
        return Err(invalid_cursor());
    }
    let epoch = Uuid::try_parse(epoch).map_err(|_| invalid_cursor())?;
    Ok((Some(epoch), rest))
}

fn with_epoch(epoch: Uuid, cursor: &str) -> String {
    format!("{}@{cursor}", epoch.simple())
}

/// Strictly parses a request cursor's snapshot. Anything that is not a
/// cursor the server could have produced is 400. Whether this database can
/// honor a well-formed one is `Cursor::within`.
fn parse_cursor(cursor: &str) -> Result<Cursor> {
    let invalid = invalid_cursor;
    let parts = cursor.split(':').collect::<Vec<_>>();
    let (xmin_s, xmax_s, xip_s, partial_s) = match parts.as_slice() {
        [xmin, xmax, xip] => (*xmin, *xmax, *xip, None),
        [xmin, xmax, xip, partial] => (*xmin, *xmax, *xip, Some(*partial)),
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
        || xip.windows(2).any(|pair| pair[0] >= pair[1])
        || xip.first().is_some_and(|first| *first != xmin)
        || xip.is_empty() && xmin != xmax
        || xip.last().is_some_and(|last| *last >= xmax)
    {
        return Err(invalid());
    }
    let partial = partial_s
        .map(|text| {
            let (txid, row) = text.split_once('.').ok_or_else(invalid)?;
            let (txid, row) = (integer(txid)?, integer(row)?);
            // The transaction must be one the snapshot's window holds.
            let in_window = txid >= xmax || xip.binary_search(&txid).is_ok();
            if !in_window || row < 1 {
                return Err(invalid());
            }
            Ok(Partial { txid, row })
        })
        .transpose()?;
    Ok(Cursor {
        snapshot: Snapshot { xmin, xmax, xip },
        partial,
    })
}

/// The pull's own snapshot, as cursor text and parsed, plus the change
/// horizon and the history it was taken in. Rows committed after it are
/// invisible to the pull's queries, so the window is exactly "visible here
/// but not in the request cursor". A transaction open elsewhere only sits in
/// xip lists; it never holds the cursor back.
struct PullSnapshot {
    text: String,
    snapshot: Snapshot,
    horizon: i64,
    /// Issues every cursor handed out from this snapshot.
    epoch: Uuid,
    /// False when this database is another history than the one `epoch`
    /// names, so `adopt_sync_history` has to rotate it first.
    current: bool,
}

/// Where a full page stopped.
#[derive(Debug, PartialEq, Eq)]
enum Cut {
    /// This transaction waits whole for the next page.
    Before(i64),
    /// The page ends inside this transaction, after its change row `row`.
    Inside { txid: i64, row: i64 },
}

/// Distinct changed records, from whole transactions where they fit, and
/// where the page stopped, if it did.
#[derive(Default)]
struct PullPage {
    pairs: std::collections::BTreeSet<(String, Uuid)>,
    /// Records of the transaction being read; joins `pairs` once it fits.
    group: std::collections::BTreeSet<(String, Uuid)>,
    group_txid: Option<i64>,
    /// Id of the last row of the current transaction that made the page.
    group_row: i64,
    included_txids: usize,
    scanned: usize,
    cut: Option<Cut>,
}

impl PullPage {
    /// The cut for a row of `txid` that does not fit. Inside the page's first
    /// transaction the rows accepted so far stay, and the transaction resumes
    /// after the last of them. Otherwise the transaction waits whole.
    fn cut_here(&mut self, txid: i64) -> Cut {
        if self.included_txids == 0 {
            self.pairs.append(&mut self.group);
            Cut::Inside {
                txid,
                row: self.group_row,
            }
        } else {
            Cut::Before(txid)
        }
    }

    /// Adds one change row. Returns false once the page is full. A
    /// transaction that does not fit waits for the next page, unless it is
    /// the first one on this page: then no whole transaction fits, and the
    /// page ends inside it. The raw-row cap works the same way, so a page
    /// never reads more than `PULL_ROWS` rows to accept them.
    fn add(&mut self, txid: i64, row: i64, entity: String, entity_id: Uuid) -> bool {
        if self.group_txid != Some(txid) {
            if self.group_txid.is_some() {
                self.pairs.append(&mut self.group);
                self.included_txids += 1;
            }
            self.group_txid = Some(txid);
        }
        if self.scanned == PULL_ROWS {
            self.cut = Some(self.cut_here(txid));
            return false;
        }
        self.scanned += 1;
        if entity != "roles" {
            let pair = (entity, entity_id);
            let fresh = !self.pairs.contains(&pair) && !self.group.contains(&pair);
            if fresh && self.pairs.len() + self.group.len() >= PULL_PAIRS {
                self.cut = Some(self.cut_here(txid));
                return false;
            }
            if fresh {
                self.group.insert(pair);
            }
        }
        self.group_row = row;
        true
    }
}

/// Reads the window's change rows in (txid, id) order until the page is full.
async fn scan_window(
    tx: &mut PgConnection,
    workspace_id: Uuid,
    actor: Uuid,
    requested: &Cursor,
) -> Result<PullPage> {
    let snapshot = &requested.snapshot;
    // Every xip txid is below xmax, so scanning xip first preserves
    // (txid, id) order without merging or sorting the two index ranges.
    let mut scanning_xip = !snapshot.xip.is_empty();
    let mut last = (-1i64, -1i64);
    let mut page = PullPage::default();
    loop {
        let query = if scanning_xip {
            sqlx::query_as(PULL_BATCH_XIP_SQL)
                .bind(workspace_id)
                .bind(&snapshot.xip)
        } else {
            sqlx::query_as(PULL_BATCH_RANGE_SQL)
                .bind(workspace_id)
                .bind(snapshot.xmax)
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
            let delivered = requested
                .partial
                .is_some_and(|partial| partial.txid == txid && id <= partial.row);
            if !delivered && !page.add(txid, id, entity, entity_id) {
                return Ok(page);
            }
        }
        // The delivered rows are one contiguous run in (txid, id) order. A
        // batch that ends inside it resumes after it instead of reading it again.
        if let Some(partial) = requested.partial
            && last.0 == partial.txid
            && last.1 < partial.row
        {
            last.1 = partial.row;
        }
        if !batch_full {
            if scanning_xip {
                scanning_xip = false;
                continue;
            }
            let mut group = std::mem::take(&mut page.group);
            page.pairs.append(&mut group);
            return Ok(page);
        }
    }
}

/// The snapshot after a page that stopped at txid `T`: everything below `T`
/// visible in the pull's snapshot joins what the request cursor promised.
/// `xmax'` moves at least to `T`, and in-flight txids stay listed, so `T`
/// stays in the window and every `more: true` page strictly grows the
/// reflected set.
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

/// The cursor after a page that stopped at `cut`. A transaction the page
/// leaves whole keeps whatever the request already held of it. The cursor
/// names at most one partial transaction. When the page cuts a new one while
/// the request's lies further on, that one is dropped and delivered again,
/// which costs bandwidth but never correctness.
fn next_cursor(requested: &Cursor, snapshot: &Snapshot, cut: Cut) -> Cursor {
    let (txid, partial) = match cut {
        Cut::Before(txid) => (
            txid,
            requested.partial.filter(|partial| partial.txid >= txid),
        ),
        Cut::Inside { txid, row } => (txid, Some(Partial { txid, row })),
    };
    Cursor {
        snapshot: advance_cursor(&requested.snapshot, snapshot, txid),
        partial,
    }
}

#[derive(Debug, Serialize, utoipa::ToSchema)]
pub struct PullResponse {
    /// Opaque cursor, `epoch@` and a snapshot in `xmin:xmax:xip` text form.
    /// Every txid below the snapshot's xmax except those listed is reflected.
    /// An unfinished page may append `:txid.row`, the one transaction
    /// delivered only up to that change row.
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

impl PullResponse {
    /// An empty page that hands the client a fresh cursor. With `reset`,
    /// the client must bootstrap again from it.
    fn restart(cursor: String, reset: bool) -> Self {
        Self {
            cursor,
            more: false,
            reset,
            last_mutation_id: None,
            changes: Vec::new(),
        }
    }
}

impl Store {
    /// Changed records since `cursor` from one `REPEATABLE READ READ ONLY`
    /// snapshot, so the cursor, the changed rows, the rendered records and
    /// `last_mutation_id` are mutually consistent. A mutation committed
    /// during the pull is either fully reflected with its id reported, or
    /// entirely absent from both.
    pub async fn sync_pull(
        &self,
        workspace_id: WorkspaceId,
        actor: Uuid,
        client_id: Uuid,
        cursor: Option<&str>,
    ) -> Result<PullResponse> {
        // Adoption deletes change rows, so a snapshot taken before it must
        // never be paired with the new epoch. The retry reads a fresh one.
        if let Some(response) = self
            .pull_once(workspace_id, actor, client_id, cursor)
            .await?
        {
            return Ok(response);
        }
        self.adopt_sync_history().await?;
        self.pull_once(workspace_id, actor, client_id, cursor)
            .await?
            .ok_or_else(|| Error::ServiceUnavailable("database history changed, retry".into()))
    }

    /// One pull in one snapshot. `None` means the database is another
    /// history than the one that issued the epoch.
    async fn pull_once(
        &self,
        workspace_id: WorkspaceId,
        actor: Uuid,
        client_id: Uuid,
        cursor: Option<&str>,
    ) -> Result<Option<PullResponse>> {
        let workspace_id = workspace_id.0;
        let ReadStart {
            mut tx,
            last_mutation_id,
            pulled,
        } = self.open_read(workspace_id, actor, client_id).await?;
        let snapshot = pulled.snapshot;

        let requested = cursor
            .map(|cursor| {
                let (epoch, text) = split_epoch(cursor)?;
                Ok::<_, Error>((epoch, parse_cursor(text)?))
            })
            .transpose()?;
        if !pulled.current {
            tx.commit().await?;
            return Ok(None);
        }
        let snap_text = with_epoch(pulled.epoch, &pulled.text);
        let Some((epoch, requested)) = requested else {
            tx.commit().await?;
            return Ok(Some(PullResponse::restart(snap_text, false)));
        };
        // A cursor this database can't honor is a reset, never a 400: its
        // client did nothing wrong, the history under it changed.
        if epoch != Some(pulled.epoch)
            || !requested.within(&snapshot)
            || requested.snapshot.xmin < pulled.horizon
        {
            tx.commit().await?;
            return Ok(Some(PullResponse::restart(snap_text, true)));
        }

        // Check the full window, even when a role change sits beyond this
        // page or inside a transaction the client already holds part of.
        let role_changed: bool = sqlx::query_scalar(PULL_ROLE_CHANGED_SQL)
            .bind(workspace_id)
            .bind(actor)
            .bind(requested.snapshot.xmax)
            .bind(&requested.snapshot.xip)
            .fetch_one(&mut *tx)
            .await?;
        if role_changed {
            tx.commit().await?;
            return Ok(Some(PullResponse::restart(snap_text, true)));
        }

        let page = scan_window(&mut tx, workspace_id, actor, &requested).await?;

        let mut changes: Vec<super::changes::Change> = page
            .pairs
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
        let more = page.cut.is_some();
        let next = match page.cut {
            None => snap_text,
            Some(cut) => with_epoch(
                pulled.epoch,
                &cursor_text(&next_cursor(&requested, &snapshot, cut)),
            ),
        };
        let response = PullResponse {
            cursor: next,
            more,
            reset: false,
            last_mutation_id: (!more).then_some(last_mutation_id),
            changes,
        };
        tx.commit().await?;
        Ok(Some(response))
    }
}

/// A read transaction after its opening query, which took the snapshot.
struct ReadStart {
    tx: Transaction<'static, Postgres>,
    last_mutation_id: i64,
    pulled: PullSnapshot,
}

impl Store {
    /// Rotates the sync epoch when this database is another history than the
    /// one that issued it, such as after a restore into a new cluster or a
    /// failover, and returns the epoch in force. Every cursor then resets.
    /// The change rows go too: a restore can leave rows with txids the new
    /// cluster hasn't reached, which no window could ever deliver cleanly.
    /// Concurrent callers serialize on the `sync_history` row, so one rotates
    /// and the rest find it done.
    ///
    /// Event streams stamp pokes with the epoch the listener published, so a
    /// rotation withdraws it before the change rows go. Pokes stay wildcards
    /// until the listener reconnects and publishes the new one.
    pub async fn adopt_sync_history(&self) -> Result<Uuid> {
        let mut tx = self.pool.begin().await?;
        let rotated = sqlx::query_scalar!(
            "UPDATE sync_history SET epoch = gen_random_uuid(), cluster = sync_identity() \
             WHERE cluster <> sync_identity() RETURNING epoch AS \"epoch!\"",
        )
        .fetch_optional(&mut *tx)
        .await?;
        let epoch = match rotated {
            Some(epoch) => {
                tracing::warn!(%epoch, "sync history changed, resetting every cursor");
                self.sync_pokes.withdraw_epoch();
                sqlx::query!("DELETE FROM changes")
                    .execute(&mut *tx)
                    .await?;
                sqlx::query!("UPDATE change_horizon SET txid = 0")
                    .execute(&mut *tx)
                    .await?;
                epoch
            }
            None => {
                sqlx::query_scalar!("SELECT epoch AS \"epoch!\" FROM sync_history")
                    .fetch_one(&mut *tx)
                    .await?
            }
        };
        tx.commit().await?;
        Ok(epoch)
    }

    async fn sync_read(
        &self,
        workspace_id: Uuid,
        actor: Uuid,
        client_id: Uuid,
    ) -> Result<(Transaction<'static, Postgres>, i64)> {
        let start = self.open_read(workspace_id, actor, client_id).await?;
        Ok((start.tx, start.last_mutation_id))
    }

    /// Begins a `REPEATABLE READ READ ONLY` transaction and, in one query,
    /// checks membership, reads the client's row and takes the snapshot.
    async fn open_read(
        &self,
        workspace_id: Uuid,
        actor: Uuid,
        client_id: Uuid,
    ) -> Result<ReadStart> {
        let mut tx = self.pool.begin().await?;
        // Not `begin_with`: sqlx counts the transaction only after BEGIN
        // returns, so a request cancelled meanwhile leaves a READ ONLY
        // transaction open on a pooled connection.
        sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
            .execute(&mut *tx)
            .await?;

        let row = sqlx::query!(
            "SELECT c.workspace_id AS \"client_workspace?\", \
                    c.user_id AS \"client_user?\", \
                    c.last_mutation_id AS \"last_mutation_id?\", \
                    pg_current_snapshot()::text AS \"snapshot_text!\", \
                    pg_snapshot_xmin(pg_current_snapshot())::text::bigint AS \"xmin!\", \
                    pg_snapshot_xmax(pg_current_snapshot())::text::bigint AS \"xmax!\", \
                    COALESCE((SELECT array_agg(x::text::bigint) \
                              FROM pg_snapshot_xip(pg_current_snapshot()) AS t(x)), '{}'::bigint[]) AS \"xip!\", \
                    (SELECT txid FROM change_horizon) AS \"horizon!\", \
                    (SELECT epoch FROM sync_history) AS \"epoch!\", \
                    (SELECT cluster = sync_identity() FROM sync_history) AS \"current!\" \
             FROM workspace_members m \
             LEFT JOIN sync_clients c ON c.client_id = $3 \
             WHERE m.workspace_id = $1 AND m.user_id = $2",
            workspace_id,
            actor,
            client_id,
        )
        .fetch_optional(&mut *tx)
        .await?
        .ok_or(Error::Forbidden)?;

        if row
            .client_workspace
            .is_some_and(|owner| owner != workspace_id)
            || row.client_user.is_some_and(|owner| owner != actor)
        {
            return Err(Error::BadRequest(
                "client_id belongs to another user or workspace".into(),
            ));
        }
        let mut xip = row.xip;
        xip.sort_unstable();
        xip.dedup();
        Ok(ReadStart {
            tx,
            last_mutation_id: row.last_mutation_id.unwrap_or(0),
            pulled: PullSnapshot {
                text: row.snapshot_text,
                snapshot: Snapshot {
                    xmin: row.xmin,
                    xmax: row.xmax,
                    xip,
                },
                horizon: row.horizon,
                epoch: row.epoch,
                current: row.current,
            },
        })
    }

    /// The same membership and client checks as pull, done once when an
    /// event stream connects. Streams hold no database connection afterwards.
    pub async fn sync_events_check(
        &self,
        workspace_id: WorkspaceId,
        actor: Uuid,
        client_id: Uuid,
    ) -> Result<()> {
        let workspace_id = workspace_id.0;
        let mut conn = self.pool.acquire().await?;
        super::reads::authorize(&mut conn, workspace_id, actor).await?;

        let owner = sqlx::query!(
            "SELECT workspace_id, user_id FROM sync_clients WHERE client_id = $1",
            client_id,
        )
        .fetch_optional(&mut *conn)
        .await?;
        if owner.is_some_and(|row| row.workspace_id != workspace_id || row.user_id != actor) {
            return Err(Error::BadRequest(
                "client_id belongs to another user or workspace".into(),
            ));
        }
        Ok(())
    }
}

/// Bump whenever a sync record shape changes.
pub const SYNC_SCHEMA: u32 = 9;

/// How long a bootstrap waits for a concurrency permit before answering 503.
pub const BOOTSTRAP_PERMIT_WAIT: std::time::Duration = std::time::Duration::from_secs(5);
/// Deadline for each channel send while streaming a bootstrap. A slow reader
/// that stops consuming ends the body without a trailer after this long.
/// Until then it holds a permit and a `REPEATABLE READ` snapshot.
pub const BOOTSTRAP_SEND_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);
/// Deadline for a whole bootstrap, from permit acquisition to trailer.
pub const BOOTSTRAP_OVERALL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(300);

/// Concurrent bootstraps are capped at a quarter of the pool's connections,
/// at least one, so slow readers cannot hold every shared connection. Each
/// user also holds at most one, see `BootstrapUsers`.
pub(crate) fn bootstrap_permits(max_connections: u32) -> usize {
    ((max_connections / 4).max(1)) as usize
}

/// Users with a bootstrap running. A user holds at most one, so a client
/// that retries or opens many tabs can't take every permit.
#[derive(Default)]
pub(crate) struct BootstrapUsers(std::sync::Mutex<std::collections::HashSet<Uuid>>);

/// A user's claim on the one bootstrap they may run. Dropping it releases it.
struct BootstrapClaim {
    users: std::sync::Arc<BootstrapUsers>,
    user: Uuid,
}

impl BootstrapClaim {
    fn take(users: &std::sync::Arc<BootstrapUsers>, user: Uuid) -> Option<Self> {
        let mut held = users.0.lock().unwrap_or_else(|e| e.into_inner());
        held.insert(user).then(|| Self {
            users: users.clone(),
            user,
        })
    }
}

impl Drop for BootstrapClaim {
    fn drop(&mut self) {
        let mut held = self.users.0.lock().unwrap_or_else(|e| e.into_inner());
        held.remove(&self.user);
    }
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

async fn send_line(
    sender: &tokio::sync::mpsc::Sender<Result<Vec<u8>>>,
    bytes: Vec<u8>,
    timeout: std::time::Duration,
) -> SendOutcome {
    match tokio::time::timeout(timeout, sender.send(Ok(bytes))).await {
        Ok(Ok(())) => SendOutcome::Sent,
        Ok(Err(_)) => SendOutcome::Closed,
        Err(_) => SendOutcome::Timeout,
    }
}

async fn send_value(
    sender: &tokio::sync::mpsc::Sender<Result<Vec<u8>>>,
    value: Value,
    timeout: std::time::Duration,
) -> Result<SendOutcome> {
    let mut bytes = serde_json::to_vec(&value)?;
    bytes.push(b'\n');
    Ok(send_line(sender, bytes, timeout).await)
}

/// One record line. `record` is the JSON text PostgreSQL produced, written
/// as is; `entity` comes from `BOOTSTRAP_ENTITIES`, so it needs no escaping.
fn record_line(entity: &str, record: &str) -> Vec<u8> {
    let mut line = Vec::with_capacity(entity.len() + record.len() + 32);
    line.extend_from_slice(br#"{"entity":""#);
    line.extend_from_slice(entity.as_bytes());
    line.extend_from_slice(br#"","record":"#);
    line.extend_from_slice(record.as_bytes());
    line.extend_from_slice(b"}\n");
    line
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

    let outcome = send_value(sender, header, send_timeout).await?;
    if !delivered(outcome, workspace, client_id, 0) {
        return Ok(());
    }
    let mut records = 0u64;
    for entity in BOOTSTRAP_ENTITIES {
        let mut query = super::changes::select(
            workspace,
            actor,
            entity,
            super::changes::RecordShape::Sync,
            super::changes::Column::Text,
        )?;
        query.push(" ORDER BY 1");
        let mut rows = query.build_query_as::<(Uuid, String)>().fetch(&mut *tx);
        loop {
            let row = tokio::select! {
                _ = sender.closed() => return Ok(()),
                row = rows.next() => row,
            };
            let Some((_, record)) = row.transpose()? else {
                break;
            };
            let outcome = send_line(sender, record_line(entity, &record), send_timeout).await;
            if !delivered(outcome, workspace, client_id, records) {
                return Ok(());
            }
            records += 1;
            sent.store(records, Ordering::Relaxed);
        }
    }
    tx.commit().await?;
    let outcome = send_value(
        sender,
        serde_json::json!({"end": true, "records": records}),
        send_timeout,
    )
    .await?;
    delivered(outcome, workspace, client_id, records);
    Ok(())
}

/// Whether the bootstrap may keep sending. Logs a send timeout.
fn delivered(outcome: SendOutcome, workspace: Uuid, client_id: Uuid, records: u64) -> bool {
    match outcome {
        SendOutcome::Sent => true,
        SendOutcome::Timeout => {
            tracing::warn!(
                workspace_id = %workspace,
                client_id = %client_id,
                records = records,
                deadline = "send",
                "sync bootstrap timed out"
            );
            false
        }
        SendOutcome::Closed => false,
    }
}

impl Store {
    pub async fn sync_bootstrap(
        &self,
        workspace: WorkspaceId,
        actor: Uuid,
        client_id: Uuid,
    ) -> Result<tokio::sync::mpsc::Receiver<Result<Vec<u8>>>> {
        let workspace = workspace.0;
        let claim = BootstrapClaim::take(&self.bootstrap_users, actor).ok_or_else(|| {
            Error::ServiceUnavailable("a bootstrap is already running, retry later".into())
        })?;
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
            let _claim = claim;
            let prepared: Result<_> = async {
                let ReadStart {
                    tx,
                    last_mutation_id,
                    pulled,
                } = store.open_read(workspace, actor, client_id).await?;
                if !pulled.current {
                    tx.rollback().await?;
                    store.adopt_sync_history().await?;
                    return Err(Error::ServiceUnavailable(
                        "database history changed, retry".into(),
                    ));
                }
                Ok((
                    tx,
                    serde_json::json!({
                        "cursor": with_epoch(pulled.epoch, &pulled.text),
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
                                let _ = tokio::time::timeout(send_timeout, sender.send(Err(error)))
                                    .await;
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
        workspace: WorkspaceId,
        actor: Uuid,
        client_id: Uuid,
        scope: SyncScope,
    ) -> Result<ScopeResponse> {
        let workspace = workspace.0;
        let (mut tx, _) = self.sync_read(workspace, actor, client_id).await?;
        let (entity, column, id) = match scope {
            SyncScope::Comments(id) => ("comments", "issue_id", id),
            SyncScope::Activity(id) => ("activity", "entity_id", id),
        };
        let mut query = super::changes::select(
            workspace,
            actor,
            entity,
            super::changes::RecordShape::Sync,
            super::changes::Column::Json,
        )?;
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
    use super::{
        Cursor, Cut, MAX_XIP, PULL_PAIRS, Partial, PullPage, Snapshot, advance_cursor, cursor_text,
        next_cursor, parse_cursor, snapshot_text, split_epoch, with_epoch,
    };
    use uuid::Uuid;

    fn snapshot(xmin: i64, xmax: i64, xip: &[i64]) -> Snapshot {
        Snapshot {
            xmin,
            xmax,
            xip: xip.to_vec(),
        }
    }

    #[test]
    fn cursor_round_trip() {
        for text in [
            "847:847:",
            "845:847:845,846",
            "0:0:",
            "847:847::847.12",
            "845:847:845,846:846.3",
            "845:847:845,846:900.3",
        ] {
            let parsed = parse_cursor(text).unwrap();
            assert_eq!(cursor_text(&parsed), text);
        }
        let parsed = parse_cursor("845:847:845,846:846.3").unwrap();
        assert_eq!(parsed.snapshot, snapshot(845, 847, &[845, 846]));
        assert_eq!(parsed.partial, Some(Partial { txid: 846, row: 3 }));
        assert_eq!(snapshot_text(&parsed.snapshot), "845:847:845,846");
    }

    #[test]
    fn cursor_rejects_malformed_partials() {
        for bad in [
            // Not `txid.row`.
            "845:847:845:",
            "845:847:845:846",
            "845:847:845:846.",
            "845:847:845:.3",
            "845:847:845:846.3.4",
            "845:847:845:846,3",
            "845:847:845:+846.3",
            "845:847:845:846.+3",
            "845:847:845:-846.3",
            "845:847:845:846.-3",
            "845:847:845:x.3",
            "845:847:845:846.x",
            "845:847:845:846.3:1",
            // Row ids start at 1.
            "845:847:845:846.0",
            // A transaction below xmax that the snapshot does not list
            // is already reflected, so it has no window to be partial in.
            "845:847:845:846.3",
            "847:847::846.3",
            // Past i64.
            "845:847:845:846.99999999999999999999",
        ] {
            assert!(parse_cursor(bad).is_err(), "{bad:?}");
        }
        assert!(parse_cursor("845:847:845:845.1").is_ok());
        assert!(parse_cursor("845:847:845:847.1").is_ok());
        assert!(parse_cursor("845:847:845:999.1").is_ok());
    }

    #[test]
    fn cursor_from_the_future_parses_but_is_not_within_the_snapshot() {
        let pulled = snapshot(990, 1000, &[990]);
        for (text, within) in [
            ("990:1000:990", true),
            ("990:1000:990:990.1", true),
            ("990:995:990:996.1", true),
            ("1010:1010:", false),
            ("99999999:99999999:", false),
            ("990:1000:990:1000.1", false),
            ("845:847:845:99999999.1", false),
        ] {
            let parsed = parse_cursor(text).unwrap();
            assert_eq!(parsed.within(&pulled), within, "{text:?}");
        }
    }

    #[test]
    fn cursor_epoch_prefix() {
        let epoch = Uuid::parse_str("0123456789abcdef0123456789abcdef").unwrap();
        let text = with_epoch(epoch, "845:847:845,846:846.3");
        assert_eq!(
            text,
            "0123456789abcdef0123456789abcdef@845:847:845,846:846.3"
        );
        assert_eq!(
            split_epoch(&text).unwrap(),
            (Some(epoch), "845:847:845,846:846.3")
        );
        assert_eq!(split_epoch("845:847:").unwrap(), (None, "845:847:"));
        for bad in [
            "@845:847:",
            "nope@845:847:",
            "0123456789abcdef0123456789abcde@845:847:",
            "0123456789abcdef0123456789abcdef0@845:847:",
            "0123456789abcdef-123456789abcdef@845:847:",
            "01234567-89ab-cdef-0123-456789abcdef@845:847:",
        ] {
            assert!(split_epoch(bad).is_err(), "{bad:?}");
        }
        // Only the snapshot part is parsed after the split.
        assert!(parse_cursor("0123456789abcdef0123456789abcdef@845:847:").is_err());
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
            assert!(parse_cursor(bad).is_err(), "{bad:?}");
        }
        assert!(parse_cursor("1010:1010:").is_ok());
        assert!(parse_cursor("990:1000:990").is_ok());
        // Over the xip cap.
        let huge = format!(
            "1:20000:{}",
            (1..=MAX_XIP as i64 + 1)
                .map(|x| x.to_string())
                .collect::<Vec<_>>()
                .join(",")
        );
        assert!(parse_cursor(&huge).is_err());
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

    fn feed(page: &mut PullPage, txid: i64, rows: impl IntoIterator<Item = i64>) -> bool {
        rows.into_iter()
            .all(|row| page.add(txid, row, "issues".into(), Uuid::from_u128(row as u128)))
    }

    #[test]
    fn page_cuts_inside_a_first_transaction_over_the_limit() {
        let mut page = PullPage::default();
        assert!(!feed(&mut page, 10, 1..=PULL_PAIRS as i64 + 5));
        assert_eq!(
            page.cut,
            Some(Cut::Inside {
                txid: 10,
                row: PULL_PAIRS as i64
            })
        );
        assert_eq!(page.pairs.len(), PULL_PAIRS);
    }

    #[test]
    fn page_cuts_before_a_later_transaction_that_does_not_fit() {
        let mut page = PullPage::default();
        assert!(feed(&mut page, 10, 1..=600));
        assert!(!feed(&mut page, 11, 601..=1300));
        assert_eq!(page.cut, Some(Cut::Before(11)));
        assert_eq!(page.pairs.len(), 600);
    }

    #[test]
    fn page_repeated_records_cost_no_budget() {
        let mut page = PullPage::default();
        assert!(feed(&mut page, 10, 1..=PULL_PAIRS as i64));
        // The same records again in the same transaction.
        assert!((1..=PULL_PAIRS as i64).all(|row| page.add(
            10,
            2000 + row,
            "issues".into(),
            Uuid::from_u128(row as u128)
        )));
        assert_eq!(page.cut, None);
    }

    #[test]
    fn partial_follows_the_cut_and_drops_once_passed() {
        let current = snapshot(20, 20, &[]);
        let pulled = snapshot(25, 25, &[]);
        let held = Partial { txid: 22, row: 7 };
        let requested = Cursor {
            snapshot: current,
            partial: Some(held),
        };
        // A later transaction waits: the one the client holds part of stays.
        let next = next_cursor(&requested, &pulled, Cut::Before(22));
        assert_eq!(next.partial, Some(held));
        let next = next_cursor(&requested, &pulled, Cut::Before(21));
        assert_eq!(next.partial, Some(held));
        // The page got past it, so the client holds all of it.
        let next = next_cursor(&requested, &pulled, Cut::Before(23));
        assert_eq!(next.partial, None);
        // A new cut replaces it.
        let next = next_cursor(&requested, &pulled, Cut::Inside { txid: 21, row: 40 });
        assert_eq!(next.partial, Some(Partial { txid: 21, row: 40 }));
        assert_eq!(next.snapshot, snapshot(21, 21, &[]));
    }

    #[test]
    fn cut_inside_keeps_the_transaction_in_the_window() {
        // T above the request xmax becomes the new xmax.
        let requested = Cursor {
            snapshot: snapshot(20, 20, &[]),
            partial: None,
        };
        let pulled = snapshot(30, 30, &[]);
        let next = next_cursor(&requested, &pulled, Cut::Inside { txid: 24, row: 5 });
        assert_eq!(next.snapshot, snapshot(24, 24, &[]));
        // T listed in the request xip stays listed.
        let requested = Cursor {
            snapshot: snapshot(22, 30, &[22, 24]),
            partial: None,
        };
        let next = next_cursor(&requested, &pulled, Cut::Inside { txid: 24, row: 5 });
        assert_eq!(next.snapshot, snapshot(24, 30, &[24]));
        assert_eq!(cursor_text(&next), "24:30:24:24.5");
        assert!(parse_cursor(&cursor_text(&next)).is_ok());
    }
}
