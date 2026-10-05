use crate::{
    error::{Error, Result},
    store::{Claim, Outbox, Store},
};
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
    pub openproject_concurrency: usize,
    pub poll_interval: Duration,
    pub drain_timeout: Duration,
    pub retention_days: i32,
}

impl Default for WorkerConfig {
    fn default() -> Self {
        Self {
            email_concurrency: 4,
            webhook_concurrency: 4,
            database_concurrency: 2,
            openproject_concurrency: 2,
            poll_interval: Duration::from_secs(5),
            drain_timeout: Duration::from_secs(50),
            retention_days: 30,
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
            openproject_concurrency: setting("JOBS_OPENPROJECT_CONCURRENCY", 2, 1, 4)? as usize,
            poll_interval: Duration::from_millis(setting("JOBS_POLL_MS", 5000, 50, 5000)?),
            drain_timeout: Duration::from_secs(setting("JOBS_DRAIN_SECONDS", 50, 1, 120)?),
            retention_days: setting("JOBS_RETENTION_DAYS", 30, 1, 3650)? as i32,
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
            || self.openproject_concurrency == 0
            || self.openproject_concurrency > 4
            || pool_size < self.database_concurrency + self.openproject_concurrency + 3
            || self.poll_interval.is_zero()
            || self.poll_interval > Duration::from_secs(5)
            || self.drain_timeout.is_zero()
            || self.drain_timeout > Duration::from_secs(120)
            || self.retention_days < 1
        {
            return Err(Error::BadRequest(
                "invalid worker limits; reserve at least three pool connections beyond database concurrency".into(),
            ));
        }

        Ok(())
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
    let queues = ["email", "webhook", "database", "openproject"];

    let limits = [
        if mailer.enabled() {
            config.email_concurrency
        } else {
            0
        },
        config.webhook_concurrency,
        config.database_concurrency,
        config.openproject_concurrency,
    ];

    if !mailer.enabled() {
        tracing::info!("email queue paused until SMTP or development spool is configured");
    }

    let mut maintenance_at = tokio::time::Instant::now();

    loop {
        if *shutdown.borrow() {
            break;
        }

        if crate::openproject::schedule(&store).await.is_err() {
            tracing::warn!("OpenProject scheduling failed");
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
                Err(_) => tracing::error!(queue = queues[index], "queue claim failed"),
            }
        }

        if *shutdown.borrow() {
            break;
        }

        if maintenance_at <= tokio::time::Instant::now() {
            if maintenance(&store, config.retention_days).await.is_err() {
                tracing::warn!("queue maintenance failed");
            }

            maintenance_at = tokio::time::Instant::now() + Duration::from_secs(300);
        }

        tokio::select! {
            biased;
            _ = stopped(&mut shutdown) => break,
            finished = tasks.join_next_with_id(), if !tasks.is_empty() => {
                match finished {
                    Some(Ok((id, result))) => {
                        let index = task_queues.remove(&id).expect("tracked worker task");
                        active[index] -= 1;

                        if result.is_err() {
                            tracing::warn!(
                                queue = queues[index],
                                "queue result could not be recorded; lease will expire"
                            );
                        }
                    }
                    Some(Err(error)) => {
                        if let Some(index) = task_queues.remove(&error.id()) {
                            active[index] -= 1;
                        }

                        tracing::error!("job task panicked; claim will expire");
                    }
                    None => {}
                }
            },
            _ = store.outbox.wait() => {},
            _ = tokio::time::sleep(config.poll_interval) => {},
        }
    }

    listener.abort();
    let _ = listener.await;

    if tokio::time::timeout(config.drain_timeout, async {
        while let Some(result) = tasks.join_next().await {
            if !matches!(result, Ok(Ok(()))) {
                tracing::warn!("draining job left a recoverable lease");
            }
        }
    })
    .await
    .is_err()
    {
        tasks.abort_all();
        while tasks.join_next().await.is_some() {}
        tracing::warn!("worker drain deadline reached; unfinished leases will expire");
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
                Err(_) => {
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

                    if !matches!(notification, Ok(Some(_))) {
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

async fn stopped(shutdown: &mut watch::Receiver<bool>) {
    let _ = shutdown.wait_for(|stop| *stop).await;
}

/// Executes currently due work once, preserving missing-SMTP pause behavior.
pub async fn tick(store: &Store, mailer: &Mailer) -> Result<()> {
    crate::openproject::schedule(store).await?;
    for queue in ["database", "webhook", "email", "openproject"] {
        if queue == "email" && !mailer.enabled() {
            continue;
        }

        while let Some(claim) = store.outbox.claim(queue, 1).await?.pop() {
            execute(store, mailer, &claim).await?;
        }
    }

    maintenance(store, 30).await
}

async fn execute(store: &Store, mailer: &Mailer, claim: &Claim) -> Result<()> {
    let started = tokio::time::Instant::now();
    let result = if claim.payload_version != PAYLOAD_VERSION {
        Err(DeliveryError::Permanent("unsupported job payload version"))
    } else {
        match Job::decode(&claim.kind, &claim.payload) {
            Err(_) => Err(DeliveryError::Permanent("invalid job kind or payload")),
            Ok(job) if job.queue() != claim.queue => {
                Err(DeliveryError::Permanent("job kind does not match queue"))
            }
            Ok(Job::OpenProject(job)) => {
                let result = tokio::time::timeout(
                    Duration::from_secs(75),
                    crate::openproject::execute(store, claim, &job),
                )
                .await;
                match result {
                    Ok(Ok(())) => return Ok(()),
                    failed => {
                        let message = match failed {
                            Ok(Err(error)) => crate::openproject::failure_message(&error),
                            _ => "OpenProject sync timed out; retry scheduled".into(),
                        };
                        let _ = crate::openproject::record_failure(store, &job, &message).await;
                        Err(DeliveryError::Transient("OpenProject sync failed"))
                    }
                }
            }
            Ok(Job::Reminder(reminder)) => {
                let result = tokio::time::timeout(
                    DATABASE_TIMEOUT,
                    execute_reminder(store, claim, &reminder),
                )
                .await;

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
                    Ok(Err(_)) => Err(DeliveryError::Transient("reminder transaction failed")),
                    Err(_) => Err(DeliveryError::Transient("reminder transaction timed out")),
                }
            }
            Ok(job) => {
                let timeout = match job {
                    Job::Email(_) => EMAIL_TIMEOUT,
                    _ => WEBHOOK_TIMEOUT,
                };

                tokio::time::timeout(timeout, job.deliver(store, mailer, &claim.id.to_string()))
                    .await
                    .unwrap_or(Err(DeliveryError::Transient("delivery timed out")))
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

async fn maintenance(store: &Store, retention_days: i32) -> Result<()> {
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

    let mut tx = store.pool.begin().await?;

    let locked: bool = sqlx::query_scalar("SELECT pg_try_advisory_xact_lock(728192404)")
        .fetch_one(&mut *tx)
        .await?;

    if !locked {
        return Ok(());
    }

    for table in ["sessions", "password_resets"] {
        sqlx::query(&format!(
            "DELETE FROM {table} WHERE token_hash IN (\
             SELECT token_hash FROM {table} WHERE expires_at<=clock_timestamp() \
             ORDER BY expires_at LIMIT 1000 FOR UPDATE SKIP LOCKED)"
        ))
        .execute(&mut *tx)
        .await?;
    }

    sqlx::query(
        "WITH expired AS (\
         SELECT id FROM invitations WHERE state='pending' AND expires_at<=clock_timestamp() \
         ORDER BY expires_at,id FOR UPDATE SKIP LOCKED LIMIT 1000) \
         UPDATE invitations SET state='expired',version=version+1 \
         FROM expired WHERE invitations.id=expired.id",
    )
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;
    store.outbox.cleanup(retention_days).await?;
    store.prune_changes(retention_days).await?;

    Ok(())
}
