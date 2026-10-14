//! Local changes queued for the provider. Commands enqueue inside their own transaction;
//! sync jobs send them (see `push`). Sync writes never reach these functions, so imports
//! cannot echo back.
use super::{SyncField, SyncOptions, runner};
use crate::{domain::Issue, error::Result, store::persistence};
use sqlx::PgConnection;
use std::collections::{BTreeMap, BTreeSet};
use uuid::Uuid;

/// Rows a job may send now: new, or past their retry time (see `push::backoff`).
pub(super) const DUE: &str = "(o.retry_at IS NULL OR o.retry_at<=clock_timestamp())";

/// Issue fields that can be sent, by their `persistence::changed_fields` names.
const FIELDS: [(&str, SyncField); 5] = [
    ("stage", SyncField::Status),
    ("title", SyncField::Title),
    ("description", SyncField::Description),
    ("assignee", SyncField::Assignee),
    ("deadline", SyncField::DueDate),
];

/// The connection's options while it is enabled.
async fn exporting(
    conn: &mut PgConnection,
    workspace: Uuid,
    connection: Uuid,
) -> Result<Option<SyncOptions>> {
    let options: Option<serde_json::Value> = sqlx::query_scalar("SELECT options FROM sync_connections WHERE workspace_id=$1 AND id=$2 AND enabled AND NOT deleted")
        .bind(workspace).bind(connection).fetch_optional(&mut *conn).await?;
    Ok(options.map(serde_json::from_value).transpose()?)
}

/// Queues the exported fields a local edit of a synced issue changed, coalescing them
/// into the issue's pending row.
pub(crate) async fn enqueue_fields(
    conn: &mut PgConnection,
    workspace: Uuid,
    before: &Issue,
    after: &Issue,
) -> Result<()> {
    let Some(link) = &after.sync else {
        return Ok(());
    };
    let changed = persistence::changed_fields(before, after);
    let candidates: Vec<SyncField> = FIELDS
        .iter()
        .filter(|(name, _)| changed.iter().any(|field| field == name))
        .map(|(_, field)| *field)
        .collect();
    if candidates.is_empty() {
        return Ok(());
    }
    let Some(options) = exporting(conn, workspace, link.connection_id).await? else {
        return Ok(());
    };
    let fields: Vec<&str> = candidates
        .into_iter()
        .filter(|field| options.get(*field).export)
        .map(SyncField::key)
        .collect();
    if fields.is_empty() {
        return Ok(());
    }
    // A new edit restarts the backoff of a failing row.
    sqlx::query("INSERT INTO sync_outbox(id,workspace_id,connection_id,issue_id,kind,fields) VALUES($1,$2,$3,$4,'fields',$5) ON CONFLICT(connection_id,issue_id) WHERE kind='fields' DO UPDATE SET fields=ARRAY(SELECT DISTINCT field FROM unnest(sync_outbox.fields||EXCLUDED.fields) AS field ORDER BY field),revision=sync_outbox.revision+1,attempts=0,retry_at=NULL")
        .bind(Uuid::new_v4()).bind(workspace).bind(link.connection_id).bind(after.id).bind(&fields)
        .execute(&mut *conn).await?;
    tracing::debug!(issue_id = %after.id, connection_id = %link.connection_id, fields = ?fields, "Sync push queued");
    wake(conn, link.connection_id).await
}

/// Queues a new comment on a synced issue.
pub(crate) async fn enqueue_comment(
    conn: &mut PgConnection,
    workspace: Uuid,
    issue: Uuid,
    comment: Uuid,
) -> Result<()> {
    let connection: Option<Uuid> = sqlx::query_scalar(
        "SELECT (sync->>'connection_id')::uuid FROM issues WHERE workspace_id=$1 AND id=$2 AND sync IS NOT NULL",
    )
    .bind(workspace)
    .bind(issue)
    .fetch_optional(&mut *conn)
    .await?;
    let Some(id) = connection else {
        return Ok(());
    };
    let Some(options) = exporting(conn, workspace, id).await? else {
        return Ok(());
    };
    if !options.get(SyncField::Comments).export {
        return Ok(());
    }
    sqlx::query("INSERT INTO sync_outbox(id,workspace_id,connection_id,issue_id,kind,comment_id) VALUES($1,$2,$3,$4,'comment',$5)")
        .bind(Uuid::new_v4()).bind(workspace).bind(id).bind(issue).bind(comment)
        .execute(&mut *conn).await?;
    tracing::debug!(issue_id = %issue, connection_id = %id, "Sync comment queued");
    wake(conn, id).await
}

/// Makes a sync job due now so the push does not wait for the next poll. Only one job
/// per connection may be active: a pending one is pulled forward, and an idle slot gets
/// the job the scheduler would start, a scan when one is overdue so continuous edits
/// cannot starve it. When a job is already running, the scheduler starts another for the
/// rows it left behind.
async fn wake(conn: &mut PgConnection, connection: Uuid) -> Result<()> {
    let pending = sqlx::query("UPDATE jobs SET run_at=LEAST(run_at,clock_timestamp()) WHERE queue='sync' AND state='pending' AND payload->>'connection_id'=$1")
        .bind(connection.to_string()).execute(&mut *conn).await?.rows_affected();
    if pending == 0 {
        runner::schedule_due(conn, Some(connection)).await?;
    }
    Ok(())
}

/// Fields of each issue that wait to be sent.
pub(super) async fn pending_fields(
    conn: &mut PgConnection,
    issues: &[Uuid],
) -> Result<BTreeMap<Uuid, BTreeSet<SyncField>>> {
    let rows: Vec<(Uuid, Vec<String>)> = sqlx::query_as(
        "SELECT issue_id,fields FROM sync_outbox WHERE kind='fields' AND issue_id=ANY($1)",
    )
    .bind(issues)
    .fetch_all(conn)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(issue, fields)| {
            let fields = fields.iter().filter_map(|key| SyncField::parse(key));
            (issue, fields.collect())
        })
        .collect())
}
