//! Background scans: scheduling, one fenced page per lease, and failure recording.
use super::{
    Mapping, Metadata, ProviderKind, TrackerField, TrackerJob, comments, discovery,
    outbox::DUE,
    provider::{Endpoint, PageData, Poll, ScanContext, Step},
    push, reconciliation,
};
use crate::{
    error::{Error, Result},
    jobs::Job,
    store::{Claim, NewJob, Outbox, Store},
};
use chrono::{DateTime, Utc};
use serde_json::Value;
use sqlx::{Acquire, PgConnection, Row};
use std::time::{Duration, Instant};
use uuid::Uuid;

/// Recreates scheduled work independently of terminal queue jobs and retry exhaustion.
pub async fn schedule(store: &Store) -> Result<()> {
    let mut tx = store.pool.begin().await?;
    let scheduled_count = schedule_due(&mut tx, None).await?;
    tx.commit().await?;
    if scheduled_count > 0 {
        tracing::debug!(scheduled_count, "Tracker jobs scheduled");
    }
    Ok(())
}

/// Starts one job for each due connection without one, or only for `only`: a scan when
/// it is due (it pushes first), else a push-only job for due outbox rows.
pub(super) async fn schedule_due(tx: &mut PgConnection, only: Option<Uuid>) -> Result<usize> {
    // Connections with due outbox rows get a push-only job between scans.
    let rows=sqlx::query(&format!("SELECT id,provider,generation,status,checkpoint,poll_watermark,incremental_supported,jsonb_array_length(projects)>0 AS mapped,last_discovered_at IS NULL OR last_discovered_at<=clock_timestamp()-interval '30 minutes' AS discover,EXISTS(SELECT 1 FROM changes WHERE workspace_id=c.workspace_id AND entity IN ('members','teams') AND created_at>=c.poll_watermark) AS local_mapping_changed,next_run_at<=clock_timestamp() AS scan_due FROM tracker_connections c WHERE enabled AND NOT deleted AND ($1::uuid IS NULL OR c.id=$1) AND (next_run_at<=clock_timestamp() OR EXISTS(SELECT 1 FROM tracker_outbox o WHERE o.connection_id=c.id AND {DUE})) AND NOT EXISTS(SELECT 1 FROM jobs WHERE queue='tracker' AND payload->>'connection_id'=c.id::text AND state IN ('pending','running')) ORDER BY next_run_at,id FOR NO KEY UPDATE OF c SKIP LOCKED LIMIT 100")).bind(only).fetch_all(&mut *tx).await?;
    let mut scheduled_count = 0;
    for row in rows {
        let id: Uuid = match row.try_get("id") {
            Ok(id) => id,
            // Defensive: id is the primary key and is needed to mark the row.
            Err(error) => {
                tracing::warn!(error = %error, "Tracker scheduling skipped a connection");
                continue;
            }
        };
        match schedule_connection(tx, id, &row).await {
            Ok(()) => scheduled_count += 1,
            Err(error) => mark_schedule_failure(tx, id, &error).await,
        }
    }
    Ok(scheduled_count)
}

/// Queues one job in a savepoint, so a bad row cannot abort the batch.
async fn schedule_connection(
    tx: &mut PgConnection,
    id: Uuid,
    row: &sqlx::postgres::PgRow,
) -> Result<()> {
    let mut savepoint = tx.begin().await?;
    let generation = row.try_get("generation")?;
    if !row.try_get::<bool, _>("scan_due")? {
        Outbox::insert(&mut savepoint, &tracker_job(id, generation, true)).await?;
        savepoint.commit().await?;
        return Ok(());
    }
    let checkpoint = next_checkpoint(row)?;
    if !Outbox::insert(&mut savepoint, &tracker_job(id, generation, false)).await? {
        // A push queued meanwhile holds the connection's job slot; scan next tick.
        return Ok(());
    }
    sqlx::query("UPDATE tracker_connections SET checkpoint=$2,next_run_at=clock_timestamp()+interval '5 minutes' WHERE id=$1").bind(id).bind(checkpoint).execute(&mut *savepoint).await?;
    savepoint.commit().await?;
    Ok(())
}

/// The provider's next checkpoint for a due scan.
fn next_checkpoint(row: &sqlx::postgres::PgRow) -> Result<Value> {
    let provider = ProviderKind::parse(row.try_get("provider")?)?;
    let incremental = row.try_get::<bool, _>("incremental_supported")?
        && !row.try_get::<bool, _>("local_mapping_changed")?;
    let poll = Poll {
        idle: row.try_get::<String, _>("status")? == "idle",
        now: Utc::now(),
        discover: !row.try_get::<bool, _>("mapped")? || row.try_get::<bool, _>("discover")?,
        since: row
            .try_get::<Option<DateTime<Utc>>, _>("poll_watermark")?
            .filter(|_| incremental),
    };
    provider.poll(row.try_get("checkpoint")?, poll)
}

async fn mark_schedule_failure(tx: &mut PgConnection, id: Uuid, error: &Error) {
    match error {
        Error::Json(_) => {
            tracing::warn!(connection_id = %id, "Tracker scheduling failed for connection: invalid checkpoint")
        }
        _ => {
            tracing::warn!(connection_id = %id, error = %error, "Tracker scheduling failed for connection")
        }
    }
    let marked: Result<()> = async {
        let mut savepoint = tx.begin().await?;
        sqlx::query("UPDATE tracker_connections SET status='error',last_error=$2,next_run_at=clock_timestamp()+interval '5 minutes' WHERE id=$1").bind(id).bind("Tracker state is invalid; use Sync now to restart").execute(&mut *savepoint).await?;
        savepoint.commit().await?;
        Ok(())
    }
    .await;
    if let Err(error) = marked {
        tracing::warn!(connection_id = %id, error = %error, "Tracker scheduling failed to mark connection error");
    }
}

/// Comment fetching stops this long after the job started; unfetched items are fetched
/// when seen again. Within the 75s job timeout (`jobs.rs`), pushes end by 30s
/// (`push::BUDGET`), the page request takes at most 20s (the client timeout) and comments
/// stop at 45s, each listing taking at most 10s of that, leaving the page transaction at
/// least 25s.
pub(super) const COMMENTS_DEADLINE: Duration = Duration::from_secs(45);

fn tracker_job(connection_id: Uuid, generation: i64, push_only: bool) -> NewJob {
    NewJob::now(
        format!("tracker:{}", Uuid::new_v4()),
        Job::Tracker(TrackerJob {
            connection_id,
            generation,
            push_only,
        }),
    )
    .max_attempts(3)
}

#[tracing::instrument(name = "tracker", level = "debug", skip_all,
    fields(connection_id = %job.connection_id, generation = job.generation, job_id = %claim.id))]
pub async fn execute(store: &Store, claim: &Claim, job: &TrackerJob) -> Result<()> {
    let started = Instant::now();
    let row = sqlx::query("SELECT provider,base_url,token,workspace_id,projects,checkpoint FROM tracker_connections WHERE id=$1 AND generation=$2 AND enabled AND NOT deleted")
        .bind(job.connection_id).bind(job.generation).fetch_optional(&store.pool).await?;
    let Some(row) = row else {
        tracing::debug!("Tracker job skipped: connection disabled, deleted or superseded");
        store.outbox.complete(claim).await?;
        return Ok(());
    };
    let provider = ProviderKind::parse(row.try_get("provider")?)?;
    let base_url: String = row.try_get("base_url")?;
    let token: String = row.try_get("token")?;
    let workspace: Uuid = row.try_get("workspace_id")?;
    let mappings: Vec<Mapping> = serde_json::from_value(row.try_get("projects")?)?;
    let endpoint = Endpoint {
        client: &store.tracker_client,
        base_url: &base_url,
        token: &token,
    };
    // Queued local changes go first: they are cheap and user-visible.
    push::drain(
        store,
        &push::Connection {
            id: job.connection_id,
            generation: job.generation,
            workspace,
            provider,
            endpoint,
            mappings: &mappings,
        },
    )
    .await?;
    if job.push_only {
        store.outbox.complete(claim).await?;
        return Ok(());
    }
    let context = ScanContext {
        endpoint,
        mappings: &mappings,
    };
    let page = match provider.step(&context, row.try_get("checkpoint")?).await? {
        Step::Page(page) => page,
        Step::FullRescan(checkpoint) => {
            return restart_unfiltered(store, claim, job, checkpoint).await;
        }
    };
    // Loaded only for issue pages. Superseded generations still load; the page
    // transaction's fence discards their writes.
    let metadata = match &page.data {
        PageData::Issues { .. } => Some(
            Metadata::load(&store.pool, job.connection_id)
                .await?
                .ok_or(sqlx::Error::RowNotFound)?,
        ),
        _ => None,
    };
    let fetched = match (&page.data, &metadata) {
        (PageData::Issues { items, .. }, Some(metadata))
            if metadata.options.get(TrackerField::Comments).import =>
        {
            let deadline = tokio::time::Instant::from_std(started + COMMENTS_DEADLINE);
            let fetched = comments::fetch(
                store,
                job.connection_id,
                provider,
                &endpoint,
                items,
                page.started_at,
                deadline,
            )
            .await?;
            tracing::debug!(
                fetched = fetched.values().flatten().count(),
                elapsed_ms = started.elapsed().as_millis(),
                "Tracker comments fetched"
            );
            Some(fetched)
        }
        _ => None,
    };
    let pool_started = Instant::now();
    let mut tx = store.pool.begin().await?;
    let pool_ms = pool_started.elapsed().as_millis();
    sqlx::query(
        "SELECT set_config('lock_timeout','5s',true),set_config('statement_timeout','10s',true)",
    )
    .execute(&mut *tx)
    .await?;
    let mut lock_ms = 0;
    if let PageData::Issues { .. } = &page.data {
        // Interactive writes take the authorization then the graph lock, and then may
        // reference the connection (outbox rows, stage deletion), so take the graph lock
        // before the connection row.
        let lock_started = Instant::now();
        sqlx::query("SELECT pg_advisory_xact_lock_shared(hashtextextended($1,74103))")
            .bind(workspace.to_string())
            .execute(&mut *tx)
            .await?;
        sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,41827))")
            .bind(workspace.to_string())
            .execute(&mut *tx)
            .await?;
        lock_ms = lock_started.elapsed().as_millis();
    }
    let connection_lock_started = Instant::now();
    // NO KEY UPDATE: commands inserting outbox rows hold the graph lock and only need the
    // foreign key's KEY SHARE on this row, which this lock does not block.
    let current: Option<Uuid> = sqlx::query_scalar("SELECT id FROM tracker_connections WHERE id=$1 AND generation=$2 AND enabled AND NOT deleted AND EXISTS(SELECT 1 FROM jobs WHERE id=$3 AND claim_token=$4 AND state='running' AND lease_expires_at>clock_timestamp()) FOR NO KEY UPDATE")
        .bind(job.connection_id).bind(job.generation).bind(claim.id).bind(claim.token)
        .fetch_optional(&mut *tx).await?;
    let connection_lock_ms = connection_lock_started.elapsed().as_millis();
    if current.is_none() {
        tracing::debug!("Tracker page discarded: lease lost or configuration superseded");
        Outbox::complete_in(&mut tx, claim).await?;
        tx.commit().await?;
        return Ok(());
    }
    let reconcile_started = Instant::now();
    match &page.data {
        PageData::Projects(items) => {
            discovery::save(&mut tx, job, "projects", page.number, page.more, items).await?
        }
        PageData::Statuses(items) => {
            discovery::save(&mut tx, job, "statuses", page.number, page.more, items).await?
        }
        PageData::People(items) => {
            discovery::save(&mut tx, job, "people", page.number, page.more, items).await?
        }
        PageData::Issues { mapping, items } => {
            let metadata = metadata
                .as_ref()
                .ok_or_else(|| Error::Internal("missing tracker import metadata".into()))?;
            reconciliation::apply_page(
                &mut tx,
                reconciliation::PageImport {
                    workspace,
                    connection: job.connection_id,
                    provider,
                    mapping,
                    metadata,
                    comments: fetched.as_ref(),
                },
                items,
            )
            .await
            .inspect_err(|_| {
                tracing::debug!("Tracker issue reconciliation failed; page will roll back");
            })?;
        }
    }
    let reconcile_ms = reconcile_started
        .elapsed()
        .as_millis()
        .saturating_sub(lock_ms);
    let finished = page.next.is_none();
    let discovered = matches!(&page.data, PageData::People(_)) && !page.more;
    let next = page
        .next
        .clone()
        .unwrap_or_else(|| provider.checkpoint(false));
    sqlx::query("UPDATE tracker_connections SET checkpoint=$3,next_run_at=CASE WHEN NOT $4 THEN clock_timestamp() WHEN $5 THEN clock_timestamp()+interval '30 minutes' ELSE GREATEST(clock_timestamp()+interval '30 seconds',$6::timestamptz+interval '5 minutes') END,status=$7,last_error='',last_checked_at=CASE WHEN $8 THEN clock_timestamp() ELSE last_checked_at END,last_synced_at=CASE WHEN $4 AND NOT $9 THEN clock_timestamp() ELSE last_synced_at END,poll_watermark=CASE WHEN $4 AND NOT $9 THEN $6 WHEN $4 AND $9 THEN NULL ELSE poll_watermark END,last_discovered_at=CASE WHEN $10 THEN clock_timestamp() ELSE last_discovered_at END WHERE id=$1 AND generation=$2")
        .bind(job.connection_id).bind(job.generation).bind(next)
        .bind(finished).bind(mappings.is_empty()).bind(page.started_at)
        .bind(if finished {"idle"} else {"syncing"}).bind(page.checked).bind(page.refresh_only)
        .bind(discovered).execute(&mut *tx).await?;
    if Outbox::complete_in(&mut tx, claim).await? {
        tx.commit().await?;
        tracing::debug!(
            resource = page.resource,
            page = page.number,
            item_count = page.data.item_count(),
            finished,
            refresh_only = page.refresh_only,
            pool_ms,
            connection_lock_ms,
            lock_ms,
            reconcile_ms,
            elapsed_ms = started.elapsed().as_millis(),
            "Tracker page committed"
        );
    } else {
        tracing::debug!("Tracker page rolled back: job completion lost ownership");
    }
    Ok(())
}

async fn restart_unfiltered(
    store: &Store,
    claim: &Claim,
    job: &TrackerJob,
    checkpoint: Value,
) -> Result<()> {
    let mut tx = store.pool.begin().await?;
    let changed = sqlx::query("UPDATE tracker_connections SET incremental_supported=false,checkpoint=$3,status='syncing',next_run_at=clock_timestamp() WHERE id=$1 AND generation=$2 AND enabled AND NOT deleted AND EXISTS(SELECT 1 FROM jobs WHERE id=$4 AND claim_token=$5 AND state='running' AND lease_expires_at>clock_timestamp())")
        .bind(job.connection_id).bind(job.generation).bind(checkpoint).bind(claim.id).bind(claim.token)
        .execute(&mut *tx).await?.rows_affected() == 1;
    if Outbox::complete_in(&mut tx, claim).await? {
        tx.commit().await?;
        tracing::debug!(
            changed,
            "Tracker incremental request rejected; restarting an unfiltered scan"
        );
    }
    Ok(())
}

/// Only our own static messages or numeric HTTP statuses reach status metadata.
pub fn failure_message(error: &Error) -> String {
    match error {
        Error::Internal(message)
        | Error::BadRequest(message)
        | Error::Conflict(message)
        | Error::Stale(message) => message.clone(),
        _ => "Tracker database write failed; check destination team/stage configuration".into(),
    }
}

pub async fn record_failure(
    store: &Store,
    claim: &Claim,
    job: &TrackerJob,
    message: &str,
) -> Result<()> {
    let mut tx = store.pool.begin().await?;
    let current: Option<Uuid> = sqlx::query_scalar(
        "SELECT id FROM tracker_connections WHERE id=$1 AND generation=$2 AND NOT deleted FOR NO KEY UPDATE",
    )
    .bind(job.connection_id)
    .bind(job.generation)
    .fetch_optional(&mut *tx)
    .await?;
    let mut recorded = false;
    if current.is_some() {
        let owned: Option<i32> = sqlx::query_scalar("SELECT 1 FROM jobs WHERE id=$1 AND claim_token=$2 AND state='running' AND lease_expires_at>clock_timestamp() FOR SHARE")
            .bind(claim.id).bind(claim.token).fetch_optional(&mut *tx).await?;
        if owned.is_some() {
            recorded = sqlx::query("UPDATE tracker_connections SET status='error',last_error=$3,next_run_at=LEAST(next_run_at,clock_timestamp()+interval '5 minutes') WHERE id=$1 AND generation=$2 AND NOT deleted")
                .bind(job.connection_id).bind(job.generation).bind(message).execute(&mut *tx).await?.rows_affected() > 0;
        }
    }
    tx.commit().await?;
    tracing::debug!(connection_id = %job.connection_id, generation = job.generation,
        recorded, "Tracker scan failure recorded");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn jobs_are_credential_free_and_failures_actionable() {
        let job = Job::Tracker(TrackerJob {
            connection_id: Uuid::nil(),
            generation: 4,
            push_only: false,
        });
        let payload = job.payload().unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&payload).unwrap(),
            json!({"connection_id":Uuid::nil(),"generation":4})
        );
        assert_eq!(job.queue(), "tracker");
        assert!(matches!(
            Job::decode("tracker", &payload).unwrap(),
            Job::Tracker(_)
        ));
        assert_eq!(
            failure_message(&Error::Internal("remote HTTP 500".into())),
            "remote HTTP 500"
        );
        assert!(failure_message(&Error::NotFound).contains("database write failed"));
    }
}
