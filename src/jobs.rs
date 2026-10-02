use crate::{
    error::{Error, Result},
    store::{Claim, Store},
};
use chrono::Utc;
use std::{future::Future, time::Duration};
use tokio::sync::watch;
mod delivery;
mod mail;
pub use delivery::{Email, Grant, Job, Webhook};
pub use mail::Mailer;

const DELIVERY_TIMEOUT: Duration = Duration::from_secs(45);
const RETRY_AFTER_ERROR: Duration = Duration::from_secs(30);
const SWEEP_SECONDS: i64 = 300;
/// Longest sleep between checks. Work scheduled by another instance cannot wake this one, so
/// this bounds how late it is noticed.
const MAX_IDLE: Duration = Duration::from_secs(300);

/// Runs the background workers until shutdown. Each worker does what is due, then sleeps until
/// its next due time or until a commit wakes it.
pub async fn run(store: Store, mailer: Mailer, shutdown: watch::Receiver<bool>) -> Result<()> {
    let (store, mailer) = (&store, &mailer);
    tokio::join!(
        worker(
            "workspace ticks",
            shutdown.clone(),
            || tick_due_workspaces(store),
            || store.ticks_changed.notified(),
        ),
        worker(
            "deliveries",
            shutdown.clone(),
            || deliver_due(store, mailer),
            || store.outbox.wait(),
        ),
        worker(
            "expiry sweep",
            shutdown,
            || sweep_expired(store),
            std::future::pending::<()>,
        ),
    );
    Ok(())
}

/// Runs all due work once.
pub async fn tick(store: &Store, mailer: &Mailer) -> Result<()> {
    tick_due_workspaces(store).await?;
    sweep_expired(store).await?;
    deliver_due(store, mailer).await?;
    Ok(())
}

async fn worker<S, SF, W, WF>(name: &str, mut shutdown: watch::Receiver<bool>, mut step: S, wake: W)
where
    S: FnMut() -> SF,
    SF: Future<Output = Result<Option<i64>>>,
    W: Fn() -> WF,
    WF: Future<Output = ()>,
{
    loop {
        let wait = tokio::select! {
            result = step() => match result {
                Ok(next) => until(next),
                Err(error) => {
                    tracing::error!(%error, worker = name, "scheduled work failed");
                    RETRY_AFTER_ERROR
                }
            },
            _ = stopped(&mut shutdown) => return,
        };
        tokio::select! {
            _ = tokio::time::sleep(wait) => {}
            _ = wake() => {}
            _ = stopped(&mut shutdown) => return,
        }
    }
}

async fn stopped(shutdown: &mut watch::Receiver<bool>) {
    let _ = shutdown.wait_for(|stop| *stop).await;
}

fn until(next: Option<i64>) -> Duration {
    let Some(next) = next else {
        return MAX_IDLE;
    };
    let millis = next
        .saturating_mul(1000)
        .saturating_sub(Utc::now().timestamp_millis());
    Duration::from_millis(millis.max(0) as u64).min(MAX_IDLE)
}

async fn tick_due_workspaces(store: &Store) -> Result<Option<i64>> {
    let now = Utc::now();
    let mut failures = 0;
    for id in store.due_workspaces(now).await? {
        if let Err(error) = tick_workspace(store, id, now).await {
            tracing::warn!(%error, workspace = %id, "workspace tick failed");
            failures += 1;
        }
    }
    if failures > 0 {
        return Err(Error::Internal(format!(
            "{failures} workspace ticks failed"
        )));
    }
    store.next_workspace_tick().await
}

async fn tick_workspace(store: &Store, id: uuid::Uuid, now: chrono::DateTime<Utc>) -> Result<()> {
    let (mut workspace, mut revision) = store.load_workspace(id).await?;
    let before = workspace.clone();
    if workspace.tick(now) {
        crate::auth::filter_notifications(store, &before, &mut workspace).await?;
        if serde_json::to_value(&workspace)? != serde_json::to_value(&before)? {
            match store.save_workspace(&workspace, revision).await {
                Ok(saved) => revision = saved,
                // The competing commit scheduled the next tick from its own state.
                Err(Error::Conflict(_)) => return Ok(()),
                Err(e) => return Err(e),
            }
        }
    }
    store
        .reschedule_tick(id, revision, workspace.next_tick(now))
        .await
}

async fn sweep_expired(store: &Store) -> Result<Option<i64>> {
    let now = Utc::now().timestamp();
    sqlx::query("DELETE FROM sessions WHERE expires_at <= $1")
        .bind(now)
        .execute(&store.pool)
        .await?;
    sqlx::query("DELETE FROM password_resets WHERE expires_at <= $1")
        .bind(now)
        .execute(&store.pool)
        .await?;
    Ok(Some(now + SWEEP_SECONDS))
}

async fn deliver_due(store: &Store, mailer: &Mailer) -> Result<Option<i64>> {
    while let Some(claim) = store.outbox.claim_next().await? {
        deliver(store, mailer, &claim).await?;
    }
    store.outbox.next_due().await
}

async fn deliver(store: &Store, mailer: &Mailer, claim: &Claim) -> Result<()> {
    let result = match Job::decode(&claim.kind, &claim.payload) {
        Ok(job) => tokio::time::timeout(DELIVERY_TIMEOUT, job.deliver(store, mailer, &claim.id))
            .await
            .unwrap_or_else(|_| Err("delivery timed out".into())),
        Err(error) => Err(error),
    };
    match result {
        Ok(()) => store.outbox.complete(claim).await,
        Err(error) => {
            tracing::warn!(job = %claim.id, kind = %claim.kind, "delivery failed; retry scheduled");
            store.outbox.retry(claim, &error).await
        }
    }
}
