use crate::{
    error::{Error, Result},
    store::{Claim, LEASE_SECONDS, Outbox, Store},
};
use sqlx::{Postgres, Transaction};
use std::{collections::HashMap, time::Duration};
use tokio::{sync::watch, task::JoinSet};

mod delivery;
mod mail;

pub use delivery::{Email, Grant, Job, Reminder, Webhook};
pub use mail::Mailer;

pub const PAYLOAD_VERSION: i32 = 1;

const EMAIL_TIMEOUT: Duration = Duration::from_secs(45);
const WEBHOOK_TIMEOUT: Duration = Duration::from_secs(45);
const DATABASE_TIMEOUT: Duration = Duration::from_secs(45);

#[derive(Debug)]
pub enum DeliveryError {
    Permanent(&'static str),
    Transient(&'static str),
}

impl std::fmt::Display for DeliveryError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Permanent(message) | Self::Transient(message) => f.write_str(message),
        }
    }
}

impl std::error::Error for DeliveryError {}

#[derive(Clone, Debug)]
pub struct WorkerConfig {
    pub email_concurrency: usize,
    pub webhook_concurrency: usize,
    pub database_concurrency: usize,
    pub sync_concurrency: usize,
    pub poll_interval: Duration,
    pub drain_timeout: Duration,
    pub retention_days: i32,
    pub failed_retention_days: i32,
}

impl Default for WorkerConfig {
    fn default() -> Self {
        Self {
            email_concurrency: 4,
            webhook_concurrency: 4,
            database_concurrency: 2,
            sync_concurrency: 2,
            poll_interval: Duration::from_secs(5),
            drain_timeout: Duration::from_secs(50),
            retention_days: 30,
            failed_retention_days: 90,
        }
    }
}

impl WorkerConfig {
    pub fn from_env() -> Result<Self> {
        let default = Self::default();

        Ok(Self {
            email_concurrency: setting(
                "JOBS_EMAIL_CONCURRENCY",
                default.email_concurrency as u64,
                1,
                32,
            )? as usize,
            webhook_concurrency: setting(
                "JOBS_WEBHOOK_CONCURRENCY",
                default.webhook_concurrency as u64,
                1,
                32,
            )? as usize,
            database_concurrency: setting(
                "JOBS_DATABASE_CONCURRENCY",
                default.database_concurrency as u64,
                1,
                16,
            )? as usize,
            sync_concurrency: setting(sync_concurrency_variable(), 2, 1, 4)? as usize,
            poll_interval: Duration::from_millis(setting("JOBS_POLL_MS", 5000, 50, 5000)?),
            drain_timeout: Duration::from_secs(setting("JOBS_DRAIN_SECONDS", 50, 1, 120)?),
            retention_days: setting("JOBS_RETENTION_DAYS", 30, 1, 3650)? as i32,
            failed_retention_days: setting("JOBS_FAILED_RETENTION_DAYS", 90, 1, 3650)? as i32,
        })
    }

    pub fn validate(&self, store: &Store) -> Result<()> {
        let pool_size = store.pool.options().get_max_connections() as usize;

        if self.email_concurrency == 0
            || self.webhook_concurrency == 0
            || self.database_concurrency == 0
            || self.email_concurrency > 32
            || self.webhook_concurrency > 32
            || self.database_concurrency > 16
            || self.sync_concurrency == 0
            || self.sync_concurrency > 4
            || pool_size < self.database_concurrency + self.sync_concurrency + 3
            || self.poll_interval.is_zero()
            || self.poll_interval > Duration::from_secs(5)
            || self.drain_timeout.is_zero()
            || self.drain_timeout > Duration::from_secs(120)
            || self.retention_days < 1
            || self.failed_retention_days < 1
        {
            return Err(Error::BadRequest(
                "invalid worker limits; reserve at least three pool connections beyond database concurrency".into(),
            ));
        }

        Ok(())
    }
}

/// `JOBS_OPENPROJECT_CONCURRENCY` remains an alias from before sync supported other providers.
fn sync_concurrency_variable() -> &'static str {
    if std::env::var_os("JOBS_SYNC_CONCURRENCY").is_none()
        && std::env::var_os("JOBS_OPENPROJECT_CONCURRENCY").is_some()
    {
        "JOBS_OPENPROJECT_CONCURRENCY"
    } else {
        "JOBS_SYNC_CONCURRENCY"
    }
}

fn setting(name: &str, default: u64, min: u64, max: u64) -> Result<u64> {
    let value = match std::env::var(name) {
        Ok(value) => value
            .parse::<u64>()
            .map_err(|_| Error::BadRequest(format!("{name} must be an integer")))?,
        Err(std::env::VarError::NotPresent) => default,
        Err(_) => return Err(Error::BadRequest(format!("{name} must be valid text"))),
    };

    if !(min..=max).contains(&value) {
        return Err(Error::BadRequest(format!(
            "{name} must be between {min} and {max}"
        )));
    }

    Ok(value)
}

pub async fn run(store: Store, mailer: Mailer, shutdown: watch::Receiver<bool>) -> Result<()> {
    run_with_config(store, mailer, shutdown, WorkerConfig::from_env()?).await
}

/// Delivery is at least once. Aborted I/O may already have reached the destination.
pub async fn run_with_config(
    store: Store,
    mailer: Mailer,
    mut shutdown: watch::Receiver<bool>,
    config: WorkerConfig,
) -> Result<()> {
    config.validate(&store)?;

    let listener = tokio::spawn(listen(
        store.outbox.clone(),
        shutdown.clone(),
        config.poll_interval,
    ));

    let mut tasks = JoinSet::new();
    let mut active = [0_usize; 4];
    let mut task_queues = HashMap::new();
    let queues = ["email", "webhook", "database", "sync"];

    let limits = [
        if mailer.enabled() {
            config.email_concurrency
        } else {
            0
        },
        config.webhook_concurrency,
        config.database_concurrency,
        config.sync_concurrency,
    ];

    if !mailer.enabled() {
        tracing::info!("email queue paused until SMTP or development spool is configured");
    }

    let mut maintenance_at = tokio::time::Instant::now();
    let mut schedule_at = tokio::time::Instant::now();

    loop {
        if *shutdown.borrow() {
            break;
        }

        if schedule_at <= tokio::time::Instant::now() {
            schedule_at = tokio::time::Instant::now() + config.poll_interval;

            if let Err(error) = crate::sync::schedule(&store).await {
                tracing::warn!(
                    error = %crate::sync::failure_message(&error),
                    "Sync scheduling failed"
                );
            }
        }
        for index in 0..queues.len() {
            if *shutdown.borrow() {
                break;
            }

            match store
                .outbox
                .claim(queues[index], limits[index].saturating_sub(active[index]))
                .await
            {
                Ok(claims) => {
                    for claim in claims {
                        active[index] += 1;

                        let store = store.clone();
                        let mailer = mailer.clone();
                        let handle =
                            tasks.spawn(async move { execute(&store, &mailer, &claim).await });

                        task_queues.insert(handle.id(), index);
                    }
                }
                Err(error) => {
                    tracing::error!(queue = queues[index], error = %error, "queue claim failed")
                }
            }
        }

        if *shutdown.borrow() {
            break;
        }

        if maintenance_at <= tokio::time::Instant::now() {
            if let Err(error) =
                maintenance(&store, config.retention_days, config.failed_retention_days).await
            {
                tracing::warn!(error = %error, "queue maintenance failed");
            }

            maintenance_at = tokio::time::Instant::now() + Duration::from_secs(300);
        }

        let deadline = schedule_at
            .min(maintenance_at)
            .min(tokio::time::Instant::now() + config.poll_interval);

        tokio::select! {
            biased;
            _ = stopped(&mut shutdown) => break,
            finished = tasks.join_next_with_id(), if !tasks.is_empty() => {
                match finished {
                    Some(Ok((id, result))) => {
                        let index = task_queues.remove(&id).expect("tracked worker task");
                        active[index] -= 1;

                        if let Err(error) = result {
                            tracing::warn!(
                                queue = queues[index],
                                error = %error,
                                "queue result could not be recorded; lease will expire"
                            );
                        }
                    }
                    Some(Err(error)) => {
                        if let Some(index) = task_queues.remove(&error.id()) {
                            active[index] -= 1;
                        }

                        tracing::error!(error = %error, "job task panicked; claim will expire");
                    }
                    None => {}
                }
            },
            _ = store.outbox.wait() => {},
            _ = tokio::time::sleep_until(deadline) => {},
        }
    }

    listener.abort();
    if let Err(error) = listener.await
        && !error.is_cancelled()
    {
        tracing::warn!(error = %error, "queue listener stopped");
    }

    if let Err(error) = tokio::time::timeout(config.drain_timeout, async {
        while let Some(result) = tasks.join_next().await {
            match result {
                Ok(Ok(())) => {}
                Ok(Err(error)) => {
                    tracing::warn!(error = %error, "draining job left a recoverable lease");
                }
                Err(error) => {
                    tracing::warn!(error = %error, "draining job left a recoverable lease");
                }
            }
        }
    })
    .await
    {
        tasks.abort_all();
        while tasks.join_next().await.is_some() {}
        tracing::warn!(
            error = %error,
            "worker drain deadline reached; unfinished leases will expire"
        );
    }

    Ok(())
}

async fn listen(outbox: Outbox, mut shutdown: watch::Receiver<bool>, poll: Duration) {
    loop {
        if *shutdown.borrow() {
            return;
        }

        let mut listener = tokio::select! {
            _ = stopped(&mut shutdown) => return,
            result = outbox.listen() => match result {
                Ok(listener) => listener,
                Err(error) => {
                    tracing::warn!(error = %error, "queue listen failed; retrying");
                    outbox.ready();

                    tokio::select! {
                        _ = stopped(&mut shutdown) => return,
                        _ = tokio::time::sleep(poll) => {}
                    }

                    continue;
                }
            }
        };

        outbox.ready();

        loop {
            tokio::select! {
                _ = stopped(&mut shutdown) => return,
                notification = listener.try_recv() => {
                    outbox.ready();

                    match notification {
                        Ok(Some(_)) => {}
                        Ok(None) => {
                            tokio::select! {
                                _ = stopped(&mut shutdown) => return,
                                _ = tokio::time::sleep(poll) => {}
                            }

                            break;
                        }
                        Err(error) => {
                            tracing::warn!(error = %error, "queue notification failed; reconnecting");
                            tokio::select! {
                                _ = stopped(&mut shutdown) => return,
                                _ = tokio::time::sleep(poll) => {}
                            }

                            break;
                        }
                    }
                }
            }
        }
    }
}

async fn stopped(shutdown: &mut watch::Receiver<bool>) {
    let _ = shutdown.wait_for(|stop| *stop).await;
}

/// Executes currently due work once, preserving missing-SMTP pause behavior.
pub async fn tick(store: &Store, mailer: &Mailer) -> Result<()> {
    crate::sync::schedule(store).await?;
    for queue in ["database", "webhook", "email", "sync"] {
        if queue == "email" && !mailer.enabled() {
            continue;
        }

        while let Some(claim) = store.outbox.claim(queue, 1).await?.pop() {
            execute(store, mailer, &claim).await?;
        }
    }

    let defaults = WorkerConfig::default();
    maintenance(
        store,
        defaults.retention_days,
        defaults.failed_retention_days,
    )
    .await
}

async fn execute(store: &Store, mailer: &Mailer, claim: &Claim) -> Result<()> {
    execute_with_renew_interval(
        store,
        mailer,
        claim,
        Duration::from_secs(LEASE_SECONDS as u64 / 3),
    )
    .await
}

// For tests: production uses a third of the lease.
#[doc(hidden)]
pub async fn execute_with_renew_interval(
    store: &Store,
    mailer: &Mailer,
    claim: &Claim,
    renew_interval: Duration,
) -> Result<()> {
    let started = tokio::time::Instant::now();
    let result = if claim.payload_version != PAYLOAD_VERSION {
        Err(DeliveryError::Permanent("unsupported job payload version"))
    } else {
        match Job::decode(&claim.kind, &claim.payload) {
            Err(error) => {
                tracing::warn!(job = %claim.id, error = %error, "invalid job kind or payload");
                Err(DeliveryError::Permanent("invalid job kind or payload"))
            }
            Ok(job) if job.queue() != claim.queue => {
                Err(DeliveryError::Permanent("job kind does not match queue"))
            }
            Ok(Job::Sync(job)) => {
                let work = tokio::time::timeout(
                    Duration::from_secs(75),
                    crate::sync::execute(store, claim, &job),
                );
                let Some(result) =
                    run_with_renewal(&store.outbox, claim, work, renew_interval).await
                else {
                    return Ok(());
                };
                match result {
                    Ok(Ok(())) => return Ok(()),
                    failed => {
                        let message = match &failed {
                            Ok(Err(error)) => crate::sync::failure_message(error),
                            _ => "Sync timed out; retry scheduled".into(),
                        };
                        tracing::warn!(job = %claim.id, error = %message, "Sync failed");
                        if let Err(error) =
                            crate::sync::record_failure(store, claim, &job, &message).await
                        {
                            tracing::warn!(
                                job = %claim.id,
                                error = %error,
                                "Sync failure could not be recorded"
                            );
                        }
                        Err(DeliveryError::Transient("sync failed"))
                    }
                }
            }
            Ok(Job::Reminder(reminder)) => {
                let work = tokio::time::timeout(
                    DATABASE_TIMEOUT,
                    execute_reminder(store, claim, &reminder),
                );
                let Some(result) =
                    run_with_renewal(&store.outbox, claim, work, renew_interval).await
                else {
                    return Ok(());
                };

                match result {
                    Ok(Ok(())) => {
                        tracing::info!(
                            job = %claim.id,
                            kind = %claim.kind,
                            attempt = claim.attempts,
                            elapsed_ms = started.elapsed().as_millis() as u64,
                            "database job attempt finished"
                        );

                        return Ok(());
                    }
                    Ok(Err(error)) => {
                        tracing::warn!(job = %claim.id, error = %error, "reminder transaction failed");
                        Err(DeliveryError::Transient("reminder transaction failed"))
                    }
                    Err(error) => {
                        tracing::warn!(job = %claim.id, error = %error, "reminder transaction timed out");
                        Err(DeliveryError::Transient("reminder transaction timed out"))
                    }
                }
            }
            Ok(job) => {
                let timeout = match job {
                    Job::Email(_) => EMAIL_TIMEOUT,
                    _ => WEBHOOK_TIMEOUT,
                };
                let id = claim.id.to_string();
                let work = tokio::time::timeout(timeout, job.deliver(store, mailer, &id));
                let Some(result) =
                    run_with_renewal(&store.outbox, claim, work, renew_interval).await
                else {
                    return Ok(());
                };
                match result {
                    Ok(result) => result,
                    Err(error) => {
                        tracing::warn!(job = %claim.id, error = %error, "delivery timed out");
                        Err(DeliveryError::Transient("delivery timed out"))
                    }
                }
            }
        }
    };

    let accepted = match result {
        Ok(()) => store.outbox.complete(claim).await?,
        Err(DeliveryError::Permanent(error)) => store.outbox.fail(claim, error).await?,
        Err(DeliveryError::Transient(error)) => store.outbox.retry(claim, error).await?,
    };

    tracing::info!(
        job = %claim.id,
        kind = %claim.kind,
        attempt = claim.attempts,
        elapsed_ms = started.elapsed().as_millis() as u64,
        accepted,
        "job attempt finished"
    );

    Ok(())
}

async fn run_with_renewal<'a, T>(
    outbox: &'a Outbox,
    claim: &'a Claim,
    work: impl std::future::Future<Output = T>,
    interval: Duration,
) -> Option<T> {
    tokio::pin!(work);
    let mut ticker = tokio::time::interval_at(tokio::time::Instant::now() + interval, interval);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut pending: Option<
        std::pin::Pin<Box<dyn std::future::Future<Output = Result<bool>> + Send + 'a>>,
    > = None;
    loop {
        if pending.is_none() {
            tokio::select! {
                biased;
                output = &mut work => return Some(output),
                _ = ticker.tick() => {
                    pending = Some(Box::pin(outbox.renew(claim)));
                }
            }
        } else {
            tokio::select! {
                biased;
                output = &mut work => return Some(output),
                result = pending.as_mut().expect("renew in flight") => {
                    pending = None;
                    match result {
                        Ok(true) => {}
                        Ok(false) => {
                            tracing::warn!(job = %claim.id, "job lease lost; abandoning work");
                            return None;
                        }
                        Err(error) => {
                            tracing::warn!(job = %claim.id, error = %error, "job lease renewal failed");
                        }
                    }
                },
                _ = ticker.tick() => {}
            }
        }
    }
}

async fn execute_reminder(store: &Store, claim: &Claim, reminder: &Reminder) -> Result<()> {
    let mut tx = store.pool.begin().await?;

    let owned = sqlx::query(
        "SELECT id FROM jobs \
         WHERE id=$1 AND state='running' AND claim_token=$2 \
         AND lease_expires_at>clock_timestamp() FOR UPDATE",
    )
    .bind(claim.id)
    .bind(claim.token)
    .fetch_optional(&mut *tx)
    .await?
    .is_some();

    if !owned {
        return Ok(());
    }

    Store::execute_reminder(&mut tx, reminder).await?;

    if Outbox::complete_in(&mut tx, claim).await? {
        tx.commit().await?;
    }

    Ok(())
}

async fn maintenance(store: &Store, retention_days: i32, failed_retention_days: i32) -> Result<()> {
    use sqlx::Row;

    let metrics = sqlx::query(
        "SELECT \
         count(*) FILTER(WHERE state IN ('pending','running')) AS depth,\
         count(*) FILTER(WHERE state='failed') AS failures,\
         COALESCE(EXTRACT(EPOCH FROM clock_timestamp()-min(run_at) FILTER(WHERE state='pending' AND run_at<clock_timestamp())),0)::bigint AS overdue_seconds,\
         (SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock') AS lock_waiters \
         FROM jobs",
    )
    .fetch_one(&store.pool)
    .await?;

    tracing::info!(
        pool_size = store.pool.size(),
        pool_idle = store.pool.num_idle(),
        queue_depth = metrics.try_get::<i64, _>("depth")?,
        failed_jobs = metrics.try_get::<i64, _>("failures")?,
        oldest_overdue_seconds = metrics.try_get::<i64, _>("overdue_seconds")?,
        lock_waiters = metrics.try_get::<i64, _>("lock_waiters")?,
        "database and queue pressure"
    );

    let mut lock = store.pool.acquire().await?;
    lock.close_on_drop();

    let locked: bool = sqlx::query_scalar("SELECT pg_try_advisory_lock(728192404)")
        .fetch_one(&mut *lock)
        .await?;

    if !locked {
        return Ok(());
    }

    let outcome = sweep(store, retention_days, failed_retention_days).await;
    let _ = sqlx::query("SELECT pg_advisory_unlock(728192404)")
        .execute(&mut *lock)
        .await;

    outcome
}

const MAINTENANCE_BUDGET: Duration = Duration::from_secs(20);

async fn sweep(store: &Store, retention_days: i32, failed_retention_days: i32) -> Result<()> {
    let deadline = tokio::time::Instant::now() + MAINTENANCE_BUDGET;

    for table in ["sessions", "password_resets"] {
        drain(deadline, 1000, store.clone(), |s| async move {
            Ok(sqlx::query(&format!(
                "DELETE FROM {table} WHERE token_hash IN (\
                 SELECT token_hash FROM {table} WHERE expires_at<=clock_timestamp() \
                 ORDER BY expires_at LIMIT 1000 FOR UPDATE SKIP LOCKED)"
            ))
            .execute(&s.pool)
            .await?
            .rows_affected())
        })
        .await?;
    }

    drain(deadline, 1000, store.clone(), |s| async move {
        Ok(sqlx::query(
            "WITH expired AS (\
             SELECT id FROM invitations WHERE state='pending' AND expires_at<=clock_timestamp() \
             ORDER BY expires_at,id FOR UPDATE SKIP LOCKED LIMIT 1000) \
             UPDATE invitations SET state='expired',version=version+1 \
             FROM expired WHERE invitations.id=expired.id",
        )
        .execute(&s.pool)
        .await?
        .rows_affected())
    })
    .await?;

    // Backfill the Done-entry clock for rows predating the archive columns,
    // then auto-archive Done issues past their team's deadline.
    // Cancelled is excluded; NULL deadline means never.
    drain(deadline, 1000, store.clone(), |s| async move {
        let mut tx = s.pool.begin().await?;
        let (_, progress) = Store::archive_batch(&mut tx).await?;
        tx.commit().await?;
        Ok(progress)
    })
    .await?;
    drain(deadline, 1000, store.clone(), |s| async move {
        s.outbox
            .cleanup(retention_days, failed_retention_days)
            .await
    })
    .await?;
    drain(deadline, 10000, store.clone(), |s| async move {
        s.prune_changes(retention_days).await
    })
    .await?;

    Ok(())
}

async fn drain<F, Fut>(
    deadline: tokio::time::Instant,
    batch: u64,
    store: Store,
    step: F,
) -> Result<()>
where
    F: Fn(Store) -> Fut,
    Fut: std::future::Future<Output = Result<u64>>,
{
    while tokio::time::Instant::now() < deadline {
        if step(store.clone()).await? < batch {
            return Ok(());
        }
    }

    Ok(())
}

impl Store {
    /// Backfills the Done-entry clock and archives Done issues past their
    /// team's deadline. Returns the number of issues archived.
    /// Cancelled stages are excluded; a NULL team deadline means never.
    pub async fn archive_sweep(&self) -> Result<u64> {
        let mut tx = self.pool.begin().await?;

        let (archived, _) = Self::archive_batch(&mut tx).await?;
        tx.commit().await?;

        Ok(archived)
    }

    async fn archive_batch(tx: &mut Transaction<'_, Postgres>) -> Result<(u64, u64)> {
        let cleared = sqlx::query(
            "UPDATE issues SET done_at=NULL,updated_at=now() WHERE id IN (\
             SELECT i.id FROM issues i JOIN stages s ON s.id=i.stage_id \
             WHERE s.kind<>'done' AND i.done_at IS NOT NULL AND i.archived_at IS NULL \
             ORDER BY i.done_at LIMIT 1000 FOR UPDATE SKIP LOCKED)",
        )
        .execute(&mut **tx)
        .await?
        .rows_affected();

        let backfilled = sqlx::query(
            "UPDATE issues SET done_at=updated_at,updated_at=now() WHERE id IN (\
             SELECT i.id FROM issues i JOIN stages s ON s.id=i.stage_id \
             WHERE s.kind='done' AND i.done_at IS NULL AND i.deleted_at IS NULL \
             ORDER BY i.updated_at LIMIT 1000 FOR UPDATE SKIP LOCKED)",
        )
        .execute(&mut **tx)
        .await?
        .rows_affected();

        let archived = sqlx::query(
            "UPDATE issues SET archived_at=now(),updated_at=now(),version=version+1 WHERE id IN (\
             SELECT i.id FROM issues i \
             JOIN stages s ON s.id=i.stage_id AND s.kind='done' \
             JOIN teams t ON t.id=i.team_id \
             WHERE i.archived_at IS NULL AND i.deleted_at IS NULL \
             AND t.archive_after_days IS NOT NULL \
             AND COALESCE(i.done_at,i.updated_at) <= now()-make_interval(days=>t.archive_after_days) \
             ORDER BY i.done_at NULLS LAST,i.id LIMIT 1000 FOR UPDATE SKIP LOCKED)",
        )
        .execute(&mut **tx)
        .await?
        .rows_affected();

        Ok((archived, cleared.max(backfilled).max(archived)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TestDatabase;
    use uuid::Uuid;

    #[tokio::test]
    async fn renewal_does_not_block_work_on_row_lock() {
        let db = TestDatabase::new().await;
        let store = Store::connect(&db.url).await.unwrap();
        let id = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO jobs(id,kind,queue,payload_version,payload) VALUES($1,'email','email',1,'{}')",
        )
        .bind(id)
        .execute(&store.pool)
        .await
        .unwrap();
        let claim = store.outbox.claim("email", 1).await.unwrap().pop().unwrap();

        let mut lock = store.pool.begin().await.unwrap();
        sqlx::query("SELECT id FROM jobs WHERE id=$1 FOR UPDATE")
            .bind(id)
            .fetch_one(&mut *lock)
            .await
            .unwrap();

        let output = tokio::time::timeout(
            Duration::from_secs(5),
            run_with_renewal(
                &store.outbox,
                &claim,
                async {
                    tokio::time::sleep(Duration::from_millis(300)).await;
                    42
                },
                Duration::from_millis(50),
            ),
        )
        .await
        .unwrap();
        assert_eq!(output, Some(42));

        lock.rollback().await.unwrap();
        store.pool.close().await;
        db.cleanup().await;
    }
}
