//! Local changes queued for the provider. Commands enqueue inside their own transaction;
//! tracker jobs send them (see `push`). Tracker writes never reach these functions, so imports
//! cannot echo back.
use super::{TrackerField, TrackerOptions, runner};
use crate::{domain::Issue, error::Result};
use sqlx::PgConnection;
use std::collections::{BTreeMap, BTreeSet};
use uuid::Uuid;

/// Rows a job may send now: new, or past their retry time (see `push::backoff`).
pub(super) const DUE: &str = "(o.retry_at IS NULL OR o.retry_at<=clock_timestamp())";

/// Issue fields that can be sent, by their `persistence::changed_fields` names.
const FIELDS: [(&str, TrackerField); 5] = [
    ("stage", TrackerField::Status),
    ("title", TrackerField::Title),
    ("description", TrackerField::Description),
    ("assignee", TrackerField::Assignee),
    ("deadline", TrackerField::DueDate),
];

/// The connection's options while it is enabled and still maps the issue's project.
async fn exporting(
    conn: &mut PgConnection,
    workspace: Uuid,
    connection: Uuid,
    project: &str,
) -> Result<Option<TrackerOptions>> {
    let options: Option<serde_json::Value> = sqlx::query_scalar!("SELECT options FROM tracker_connections WHERE workspace_id=$1 AND id=$2 AND enabled AND NOT deleted AND projects @> jsonb_build_array(jsonb_build_object('project_id',$3::text))", workspace, connection, project)
        .fetch_optional(&mut *conn).await?;
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
    let Some(link) = &after.tracker else {
        return Ok(());
    };
    let changed = before.changed_fields(after);
    let candidates: Vec<TrackerField> = FIELDS
        .iter()
        .filter(|(name, _)| changed.iter().any(|field| field == name))
        .map(|(_, field)| *field)
        .collect();
    if candidates.is_empty() {
        return Ok(());
    }
    let Some(options) = exporting(conn, workspace, link.connection_id, &link.project_id).await?
    else {
        return Ok(());
    };
    let fields: Vec<&str> = candidates
        .into_iter()
        .filter(|field| options.get(*field).export)
        .map(TrackerField::key)
        .collect();
    if fields.is_empty() {
        return Ok(());
    }
    // A new edit restarts the backoff of a failing row.
    sqlx::query!("INSERT INTO tracker_outbox(id,workspace_id,connection_id,issue_id,kind,fields) VALUES($1,$2,$3,$4,'fields',$5) ON CONFLICT(connection_id,issue_id) WHERE kind='fields' DO UPDATE SET fields=ARRAY(SELECT DISTINCT field FROM unnest(tracker_outbox.fields||EXCLUDED.fields) AS field ORDER BY field),revision=tracker_outbox.revision+1,attempts=0,retry_at=NULL",
        Uuid::new_v4(), workspace, link.connection_id, after.id, &fields as _)
        .execute(&mut *conn).await?;
    tracing::debug!(issue_id = %after.id, connection_id = %link.connection_id, fields = ?fields, "Tracker push queued");
    wake(conn, link.connection_id).await
}

/// Queues a new comment on a synced issue.
pub(crate) async fn enqueue_comment(
    conn: &mut PgConnection,
    workspace: Uuid,
    issue: Uuid,
    comment: Uuid,
) -> Result<()> {
    let connection = sqlx::query!(
        r#"SELECT (tracker->>'connection_id')::uuid AS "connection_id!",tracker->>'project_id' AS "project_id!" FROM issues WHERE workspace_id=$1 AND id=$2 AND tracker IS NOT NULL"#,
        workspace,
        issue,
    )
    .fetch_optional(&mut *conn)
    .await?;
    let Some(row) = connection else {
        return Ok(());
    };
    let (id, project) = (row.connection_id, row.project_id);
    let Some(options) = exporting(conn, workspace, id, &project).await? else {
        return Ok(());
    };
    if !options.get(TrackerField::Comments).export {
        return Ok(());
    }
    sqlx::query!("INSERT INTO tracker_outbox(id,workspace_id,connection_id,issue_id,kind,comment_id) VALUES($1,$2,$3,$4,'comment',$5)",
        Uuid::new_v4(), workspace, id, issue, comment)
        .execute(&mut *conn).await?;
    tracing::debug!(issue_id = %issue, connection_id = %id, "Tracker comment queued");
    wake(conn, id).await
}

/// Makes a tracker job due now so the push does not wait for the next poll. Only one job
/// per connection may be active: a pending one is pulled forward, and an idle slot gets
/// the job the scheduler would start, a scan when one is overdue so continuous edits
/// cannot starve it. When a job is already running, the scheduler starts another for the
/// rows it left behind.
async fn wake(conn: &mut PgConnection, connection: Uuid) -> Result<()> {
    let pending = sqlx::query!("UPDATE jobs SET run_at=LEAST(run_at,clock_timestamp()) WHERE queue='tracker' AND state='pending' AND payload->>'connection_id'=$1", connection.to_string())
        .execute(&mut *conn).await?.rows_affected();
    if pending == 0 {
        runner::schedule_due(conn, Some(connection)).await?;
    }
    Ok(())
}

/// Fields of each issue that wait to be sent.
pub(super) async fn pending_fields(
    conn: &mut PgConnection,
    issues: &[Uuid],
) -> Result<BTreeMap<Uuid, BTreeSet<TrackerField>>> {
    let rows = sqlx::query!(
        "SELECT issue_id,fields FROM tracker_outbox WHERE kind='fields' AND issue_id=ANY($1)",
        issues,
    )
    .fetch_all(conn)
    .await?;
    Ok(rows
        .into_iter()
        .map(|row| {
            let fields = row.fields.iter().filter_map(|key| TrackerField::parse(key));
            (row.issue_id, fields.collect())
        })
        .collect())
}
