use crate::{
    error::{Error, Result},
    store::{Claim, LEASE_SECONDS, Outbox, Store},
};
use sqlx::{Postgres, Transaction, postgres::PgListener};
use std::{collections::HashMap, ops::ControlFlow, time::Duration};
use tokio::{sync::watch, task::JoinSet};
use uuid::Uuid;

mod delivery;
mod digest;
mod mail;

pub use delivery::{Email, Grant, Job, Reminder, Webhook};
pub use digest::Digest;
use mail::Content;
pub use mail::Mailer;

pub const PAYLOAD_VERSION: i32 = 1;

const EMAIL_TIMEOUT: Duration = Duration::from_secs(45);
const WEBHOOK_TIMEOUT: Duration = Duration::from_secs(45);
const DATABASE_TIMEOUT: Duration = Duration::from_secs(45);

#[derive(Debug, thiserror::Error)]
pub enum DeliveryError {
    #[error("{0}")]
    Permanent(&'static str),
    #[error("{0}")]
    Transient(&'static str),
}

#[derive(Clone, Debug)]
pub struct WorkerConfig {
    pub email_concurrency: usize,
    pub webhook_concurrency: usize,
    pub database_concurrency: usize,
    pub tracker_concurrency: usize,
    pub poll_interval: Duration,
    pub drain_timeout: Duration,
    pub retention_days: i32,
    pub failed_retention_days: i32,
    pub changes_retention_days: i32,
}

impl Default for WorkerConfig {
    fn default() -> Self {
        Self {
            email_concurrency: 4,
            webhook_concurrency: 4,
            database_concurrency: 2,
            tracker_concurrency: 2,
            poll_interval: Duration::from_secs(5),
            drain_timeout: Duration::from_secs(50),
            retention_days: 30,
            failed_retention_days: 90,
            changes_retention_days: 30,
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
            tracker_concurrency: setting(tracker_concurrency_variable(), 2, 1, 4)? as usize,
            poll_interval: Duration::from_millis(setting("JOBS_POLL_MS", 5000, 50, 5000)?),
            drain_timeout: Duration::from_secs(setting("JOBS_DRAIN_SECONDS", 50, 1, 120)?),
            retention_days: setting("JOBS_RETENTION_DAYS", 30, 1, 3650)? as i32,
            failed_retention_days: setting("JOBS_FAILED_RETENTION_DAYS", 90, 1, 3650)? as i32,
            changes_retention_days: setting("JOBS_CHANGES_RETENTION_DAYS", 30, 1, 3650)? as i32,
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
            || self.tracker_concurrency == 0
            || self.tracker_concurrency > 4
            || pool_size < self.database_concurrency + self.tracker_concurrency + 3
            || self.poll_interval.is_zero()
            || self.poll_interval > Duration::from_secs(5)
            || self.drain_timeout.is_zero()
            || self.drain_timeout > Duration::from_secs(120)
            || self.retention_days < 1
            || self.failed_retention_days < 1
            || self.changes_retention_days < 1
        {
            return Err(Error::BadRequest(
                "invalid worker limits; reserve at least three pool connections beyond database concurrency".into(),
            ));
        }

        Ok(())
    }
}

/// `JOBS_OPENPROJECT_CONCURRENCY` remains an alias from before trackers other than OpenProject.
fn tracker_concurrency_variable() -> &'static str {
    if std::env::var_os("JOBS_TRACKER_CONCURRENCY").is_none()
        && std::env::var_os("JOBS_OPENPROJECT_CONCURRENCY").is_some()
    {
        "JOBS_OPENPROJECT_CONCURRENCY"
    } else {
        "JOBS_TRACKER_CONCURRENCY"
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

const QUEUES: [&str; 4] = ["email", "webhook", "database", "tracker"];
const MAINTENANCE_INTERVAL: Duration = Duration::from_secs(300);
const DIGEST_INTERVAL: Duration = Duration::from_secs(60);

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
    if !mailer.enabled() {
        tracing::info!("email queue paused until SMTP or development spool is configured");
    }

    let mut worker = Worker::new(store, mailer, config);
    worker.run(&mut shutdown).await;

    listener.abort();
    if let Err(error) = listener.await
        && !error.is_cancelled()
    {
        tracing::warn!(error = %error, "queue listener stopped");
    }

    worker.drain().await;
    Ok(())
}

type TaskOutcome = std::result::Result<(tokio::task::Id, Result<()>), tokio::task::JoinError>;

/// Claims jobs per queue up to each queue's concurrency and tracks the running tasks.
struct Worker {
    store: Store,
    mailer: Mailer,
    config: WorkerConfig,
    tasks: JoinSet<Result<()>>,
    /// Running tasks per queue, indexed like `QUEUES`.
    active: [usize; 4],
    limits: [usize; 4],
    task_queues: HashMap<tokio::task::Id, usize>,
    schedule_at: tokio::time::Instant,
    maintenance_at: tokio::time::Instant,
    /// `None` while mail is disabled, so the sweep never reads notifications.
    digest_at: Option<tokio::time::Instant>,
}

impl Worker {
    fn new(store: Store, mailer: Mailer, config: WorkerConfig) -> Self {
        let email = if mailer.enabled() {
            config.email_concurrency
        } else {
            0
        };
        let limits = [
            email,
            config.webhook_concurrency,
            config.database_concurrency,
            config.tracker_concurrency,
        ];
        let now = tokio::time::Instant::now();
        Self {
            store,
            config,
            tasks: JoinSet::new(),
            active: [0; 4],
            limits,
            task_queues: HashMap::new(),
            schedule_at: now,
            // A deploy restarts web and worker together, and a failed health check rolls back
            // to the old binary, which ignores purged issue numbers and tracker tombstones.
            // Waiting one interval keeps the first purge clear of both.
            maintenance_at: now + MAINTENANCE_INTERVAL,
            digest_at: mailer.enabled().then_some(now),
            mailer,
        }
    }

    /// Queues due tracker scans once per poll interval.
    async fn run(&mut self, shutdown: &mut watch::Receiver<bool>) {
        while !*shutdown.borrow() {
            self.schedule_trackers().await;
            self.claim_jobs(shutdown).await;
            if *shutdown.borrow() {
                break;
            }
            self.maintain().await;
            self.send_digests().await;

            let deadline = self.next_wake();
            tokio::select! {
                biased;
                _ = stopped(shutdown) => break,
                finished = self.tasks.join_next_with_id(), if !self.tasks.is_empty() => {
                    self.finished(finished);
                },
                _ = self.store.outbox.wait() => {},
                _ = tokio::time::sleep_until(deadline) => {},
            }
        }
    }

    async fn schedule_trackers(&mut self) {
        if self.schedule_at > tokio::time::Instant::now() {
            return;
        }
        self.schedule_at = tokio::time::Instant::now() + self.config.poll_interval;
        if let Err(error) = crate::tracker::schedule(&self.store).await {
            tracing::warn!(
                error = %crate::tracker::failure_message(&error),
                "Tracker scheduling failed"
            );
        }
    }

    async fn claim_jobs(&mut self, shutdown: &watch::Receiver<bool>) {
        for (index, queue) in QUEUES.iter().enumerate() {
            if *shutdown.borrow() {
                return;
            }
            let free = self.limits[index].saturating_sub(self.active[index]);
            match self.store.outbox.claim(queue, free).await {
                Ok(claims) => {
                    for claim in claims {
                        self.spawn(index, claim);
                    }
                }
                Err(error) => {
                    tracing::error!(queue = *queue, error = %error, "queue claim failed")
                }
            }
        }
    }

    fn spawn(&mut self, index: usize, claim: Claim) {
        self.active[index] += 1;
        let store = self.store.clone();
        let mailer = self.mailer.clone();
        let handle = self
            .tasks
            .spawn(async move { execute(&store, &mailer, &claim).await });
        self.task_queues.insert(handle.id(), index);
    }

    async fn maintain(&mut self) {
        if self.maintenance_at > tokio::time::Instant::now() {
            return;
        }
        if let Err(error) = maintenance(&self.store, &self.config).await {
            tracing::warn!(error = %error, "queue maintenance failed");
        }
        self.maintenance_at = tokio::time::Instant::now() + MAINTENANCE_INTERVAL;
    }

    async fn send_digests(&mut self) {
        let now = tokio::time::Instant::now();
        if self.digest_at.is_none_or(|at| at > now) {
            return;
        }
        if let Err(error) = digest::enqueue(&self.store).await {
            tracing::warn!(error = %error, "notification digest sweep failed");
        }
        self.digest_at = Some(tokio::time::Instant::now() + DIGEST_INTERVAL);
    }

    fn next_wake(&self) -> tokio::time::Instant {
        let poll = tokio::time::Instant::now() + self.config.poll_interval;
        self.schedule_at
            .min(self.maintenance_at)
            .min(self.digest_at.unwrap_or(poll))
            .min(poll)
    }

    /// Frees the finished task's queue slot. A failed result keeps its lease,
    /// which expires so another worker retries the job.
    fn finished(&mut self, finished: Option<TaskOutcome>) {
        match finished {
            Some(Ok((id, result))) => {
                let index = self.task_queues.remove(&id).expect("tracked worker task");
                self.active[index] -= 1;
                if let Err(error) = result {
                    tracing::warn!(
                        queue = QUEUES[index],
                        error = %error,
                        "queue result could not be recorded; lease will expire"
                    );
                }
            }
            Some(Err(error)) => {
                if let Some(index) = self.task_queues.remove(&error.id()) {
                    self.active[index] -= 1;
                }
                tracing::error!(error = %error, "job task panicked; claim will expire");
            }
            None => {}
        }
    }

    /// Waits for running jobs up to the drain timeout, then aborts the rest.
    async fn drain(mut self) {
        let tasks = &mut self.tasks;
        let drained = tokio::time::timeout(self.config.drain_timeout, async {
            while let Some(result) = tasks.join_next().await {
                let error = match result {
                    Ok(Ok(())) => continue,
                    Ok(Err(error)) => error.to_string(),
                    Err(error) => error.to_string(),
                };
                tracing::warn!(error = %error, "draining job left a recoverable lease");
            }
        })
        .await;
        if let Err(error) = drained {
            self.tasks.abort_all();
            while self.tasks.join_next().await.is_some() {}
            tracing::warn!(
                error = %error,
                "worker drain deadline reached; unfinished leases will expire"
            );
        }
    }
}

async fn listen(outbox: Outbox, mut shutdown: watch::Receiver<bool>, poll: Duration) {
    while !*shutdown.borrow() {
        let connected = tokio::select! {
            _ = stopped(&mut shutdown) => return,
            result = outbox.listen() => result,
        };
        match connected {
            Ok(listener) => {
                outbox.ready();
                if relay(&outbox, listener, &mut shutdown).await.is_break() {
                    return;
                }
            }
            Err(error) => {
                tracing::warn!(error = %error, "queue listen failed; retrying");
                outbox.ready();
            }
        }

        tokio::select! {
            _ = stopped(&mut shutdown) => return,
            _ = tokio::time::sleep(poll) => {}
        }
    }
}

/// Wakes the worker on every notification until the connection drops. Breaks
/// on shutdown.
async fn relay(
    outbox: &Outbox,
    mut listener: PgListener,
    shutdown: &mut watch::Receiver<bool>,
) -> ControlFlow<()> {
    loop {
        let notification = tokio::select! {
            _ = stopped(shutdown) => return ControlFlow::Break(()),
            notification = listener.try_recv() => notification,
        };
        outbox.ready();

        match notification {
            Ok(Some(_)) => {}
            Ok(None) => return ControlFlow::Continue(()),
            Err(error) => {
                tracing::warn!(error = %error, "queue notification failed; reconnecting");
                return ControlFlow::Continue(());
            }
        }
    }
}

async fn stopped(shutdown: &mut watch::Receiver<bool>) {
    let _ = shutdown.wait_for(|stop| *stop).await;
}

/// Executes currently due work once, preserving missing-SMTP pause behavior.
pub async fn tick(store: &Store, mailer: &Mailer) -> Result<()> {
    crate::tracker::schedule(store).await?;
    if mailer.enabled() {
        digest::enqueue(store).await?;
    }
    for queue in ["database", "webhook", "email", "tracker"] {
        if queue == "email" && !mailer.enabled() {
            continue;
        }

        while let Some(claim) = store.outbox.claim(queue, 1).await?.pop() {
            execute(store, mailer, &claim).await?;
        }
    }

    maintenance(store, &WorkerConfig::default()).await
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
    let attempt = if claim.payload_version != PAYLOAD_VERSION {
        Attempt::Finished(Err(DeliveryError::Permanent(
            "unsupported job payload version",
        )))
    } else {
        match Job::decode(&claim.kind, &claim.payload) {
            Err(error) => {
                tracing::warn!(job = %claim.id, error = %error, "invalid job kind or payload");
                Attempt::Finished(Err(DeliveryError::Permanent("invalid job kind or payload")))
            }
            Ok(job) if job.queue() != claim.queue => Attempt::Finished(Err(
                DeliveryError::Permanent("job kind does not match queue"),
            )),
            Ok(Job::Tracker(job)) => run_tracker(store, claim, &job, renew_interval).await,
            Ok(Job::Reminder(reminder)) => {
                run_reminder(store, claim, &reminder, renew_interval, started).await
            }
            Ok(job) => run_delivery(store, mailer, claim, job, renew_interval).await,
        }
    };
    let Attempt::Finished(result) = attempt else {
        return Ok(());
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

/// How one job attempt ended.
enum Attempt {
    /// The job completed its own claim, or the lease was lost; nothing to record.
    Settled,
    /// The outcome to record against the claim.
    Finished(std::result::Result<(), DeliveryError>),
}

/// A successful tracker job completes its own claim; failures are recorded on the connection.
async fn run_tracker(
    store: &Store,
    claim: &Claim,
    job: &crate::tracker::TrackerJob,
    renew_interval: Duration,
) -> Attempt {
    let work = tokio::time::timeout(
        Duration::from_secs(75),
        crate::tracker::execute(store, claim, job),
    );
    let message = match run_with_renewal(&store.outbox, claim, work, renew_interval).await {
        None | Some(Ok(Ok(()))) => return Attempt::Settled,
        Some(Ok(Err(error))) => crate::tracker::failure_message(&error),
        Some(Err(_)) => "Tracker job timed out; retry scheduled".into(),
    };
    tracing::warn!(job = %claim.id, error = %message, "Tracker job failed");
    if let Err(error) = crate::tracker::record_failure(store, claim, job, &message).await {
        tracing::warn!(
            job = %claim.id,
            error = %error,
            "Tracker job failure could not be recorded"
        );
    }
    Attempt::Finished(Err(DeliveryError::Transient("tracker job failed")))
}

/// A successful reminder completes its claim in its own transaction.
async fn run_reminder(
    store: &Store,
    claim: &Claim,
    reminder: &Reminder,
    renew_interval: Duration,
    started: tokio::time::Instant,
) -> Attempt {
    let work = tokio::time::timeout(DATABASE_TIMEOUT, execute_reminder(store, claim, reminder));
    let failure = match run_with_renewal(&store.outbox, claim, work, renew_interval).await {
        None => return Attempt::Settled,
        Some(Ok(Ok(()))) => {
            tracing::info!(
                job = %claim.id,
                kind = %claim.kind,
                attempt = claim.attempts,
                elapsed_ms = started.elapsed().as_millis() as u64,
                "database job attempt finished"
            );
            return Attempt::Settled;
        }
        Some(Ok(Err(error))) => {
            tracing::warn!(job = %claim.id, error = %error, "reminder transaction failed");
            "reminder transaction failed"
        }
        Some(Err(error)) => {
            tracing::warn!(job = %claim.id, error = %error, "reminder transaction timed out");
            "reminder transaction timed out"
        }
    };
    Attempt::Finished(Err(DeliveryError::Transient(failure)))
}

/// Email and webhook delivery, within the kind's timeout.
async fn run_delivery(
    store: &Store,
    mailer: &Mailer,
    claim: &Claim,
    job: Job,
    renew_interval: Duration,
) -> Attempt {
    let timeout = match job {
        Job::Email(_) | Job::Digest(_) => EMAIL_TIMEOUT,
        _ => WEBHOOK_TIMEOUT,
    };
    let id = claim.id.to_string();
    let work = tokio::time::timeout(timeout, job.deliver(store, mailer, &id));
    match run_with_renewal(&store.outbox, claim, work, renew_interval).await {
        None => Attempt::Settled,
        Some(Ok(result)) => Attempt::Finished(result),
        Some(Err(error)) => {
            tracing::warn!(job = %claim.id, error = %error, "delivery timed out");
            Attempt::Finished(Err(DeliveryError::Transient("delivery timed out")))
        }
    }
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

    let owned = sqlx::query_scalar!(
        "SELECT id FROM jobs \
         WHERE id=$1 AND state='running' AND claim_token=$2 \
         AND lease_expires_at>clock_timestamp() FOR UPDATE",
        claim.id,
        claim.token,
    )
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

async fn maintenance(store: &Store, config: &WorkerConfig) -> Result<()> {
    let metrics = sqlx::query!(
        "SELECT \
         count(*) FILTER(WHERE state IN ('pending','running')) AS \"depth!\",\
         count(*) FILTER(WHERE state='failed') AS \"failures!\",\
         COALESCE(EXTRACT(EPOCH FROM clock_timestamp()-min(run_at) FILTER(WHERE state='pending' AND run_at<clock_timestamp())),0)::bigint AS \"overdue_seconds!\",\
         (SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock') AS \"lock_waiters!\" \
         FROM jobs",
    )
    .fetch_one(&store.pool)
    .await?;

    tracing::info!(
        pool_size = store.pool.size(),
        pool_idle = store.pool.num_idle(),
        queue_depth = metrics.depth,
        failed_jobs = metrics.failures,
        oldest_overdue_seconds = metrics.overdue_seconds,
        lock_waiters = metrics.lock_waiters,
        "database and queue pressure"
    );

    let mut lock = store.pool.acquire().await?;
    lock.close_on_drop();

    let locked: bool = sqlx::query_scalar!("SELECT pg_try_advisory_lock(728192404) AS \"locked!\"")
        .fetch_one(&mut *lock)
        .await?;

    if !locked {
        return Ok(());
    }

    let outcome = sweep(store, config).await;
    let _ = sqlx::query("SELECT pg_advisory_unlock(728192404)")
        .execute(&mut *lock)
        .await;

    outcome
}

const MAINTENANCE_BUDGET: Duration = Duration::from_secs(20);

async fn sweep(store: &Store, config: &WorkerConfig) -> Result<()> {
    let deadline = tokio::time::Instant::now() + MAINTENANCE_BUDGET;

    for table in [
        "sessions",
        "password_resets",
        "email_verifications",
        "pending_logins",
    ] {
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
        Ok(sqlx::query!(
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
    let (retention_days, failed_retention_days) =
        (config.retention_days, config.failed_retention_days);
    drain(deadline, 1000, store.clone(), |s| async move {
        s.outbox
            .cleanup(retention_days, failed_retention_days)
            .await
    })
    .await?;
    let changes_retention_days = config.changes_retention_days;
    drain(deadline, 10000, store.clone(), |s| async move {
        s.prune_changes(changes_retention_days).await
    })
    .await?;
    drain(deadline, 1, store.clone(), |s| async move {
        s.purge_trash().await
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

const TRASH_RETENTION_DAYS: i32 = 30;
const PURGE_BATCH: u64 = 100;

const PURGE: [&str; 14] = [
    "INSERT INTO purged_issue_numbers(workspace_id,team_id,number) \
     SELECT workspace_id,team_id,max(number) FROM (\
     SELECT workspace_id,team_id,number FROM issues WHERE workspace_id=$1 AND id=ANY($2) \
     UNION ALL SELECT workspace_id,team_id,number FROM issue_key_aliases WHERE workspace_id=$1 AND issue_id=ANY($2)\
     ) purged GROUP BY workspace_id,team_id ON CONFLICT(workspace_id,team_id) \
     DO UPDATE SET number=GREATEST(purged_issue_numbers.number,EXCLUDED.number)",
    "INSERT INTO tracker_deleted_issues(connection_id,remote_id) \
     SELECT t.id,i.tracker->>'remote_id' FROM issues i \
     JOIN tracker_connections t ON t.id::text=i.tracker->>'connection_id' \
     WHERE i.workspace_id=$1 AND i.id=ANY($2) ON CONFLICT DO NOTHING",
    "UPDATE issues SET parent_id=NULL,updated_at=now(),version=version+1 \
     WHERE workspace_id=$1 AND parent_id=ANY($2) AND NOT id=ANY($2)",
    "DELETE FROM issue_dependencies WHERE workspace_id=$1 AND (issue_id=ANY($2) OR dependency_id=ANY($2))",
    "DELETE FROM activity WHERE workspace_id=$1 AND (entity_id=ANY($2) \
     OR entity_id IN (SELECT id FROM comments WHERE workspace_id=$1 AND issue_id=ANY($2)) \
     OR entity_id IN (SELECT id FROM time_entries WHERE workspace_id=$1 AND issue_id=ANY($2)))",
    "DELETE FROM issue_labels WHERE workspace_id=$1 AND issue_id=ANY($2)",
    "DELETE FROM issue_followers WHERE workspace_id=$1 AND issue_id=ANY($2)",
    "DELETE FROM source_links WHERE workspace_id=$1 AND issue_id=ANY($2)",
    "DELETE FROM time_entries WHERE workspace_id=$1 AND issue_id=ANY($2)",
    "DELETE FROM attachments WHERE workspace_id=$1 AND issue_id=ANY($2)",
    "DELETE FROM comments WHERE workspace_id=$1 AND issue_id=ANY($2)",
    "DELETE FROM notifications WHERE workspace_id=$1 AND issue_id=ANY($2)",
    "DELETE FROM issue_key_aliases WHERE workspace_id=$1 AND issue_id=ANY($2)",
    "DELETE FROM issues WHERE workspace_id=$1 AND id=ANY($2)",
];

impl Store {
    /// Permanently deletes one batch of issues trashed more than `TRASH_RETENTION_DAYS`
    /// ago in one workspace, with everything attached to them. Returns the number of
    /// issues deleted.
    pub async fn purge_trash(&self) -> Result<u64> {
        let cutoff = chrono::Utc::now() - chrono::Duration::days(TRASH_RETENTION_DAYS.into());
        let mut tx = self.pool.begin().await?;
        sqlx::query("SET LOCAL lock_timeout='5s'")
            .execute(&mut *tx)
            .await?;
        let Some(workspace): Option<Uuid> = sqlx::query_scalar!(
            "SELECT workspace_id FROM issues WHERE deleted_at<=$1 ORDER BY deleted_at,id LIMIT 1",
            cutoff,
        )
        .fetch_optional(&mut *tx)
        .await?
        else {
            return Ok(0);
        };
        sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,41827))")
            .bind(workspace.to_string())
            .execute(&mut *tx)
            .await?;
        let ids: Vec<Uuid> = sqlx::query_scalar!(
            "SELECT id FROM issues \
             WHERE workspace_id=$1 AND deleted_at<=$2 \
             ORDER BY deleted_at,id LIMIT $3 FOR UPDATE SKIP LOCKED",
            workspace,
            cutoff,
            PURGE_BATCH as i64,
        )
        .fetch_all(&mut *tx)
        .await?;
        for sql in PURGE {
            sqlx::query(sql)
                .bind(workspace)
                .bind(&ids)
                .execute(&mut *tx)
                .await?;
        }
        tx.commit().await?;
        Ok(ids.len() as u64)
    }

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
        let cleared = sqlx::query!(
            "UPDATE issues SET done_at=NULL,updated_at=now() WHERE id IN (\
             SELECT i.id FROM issues i JOIN stages s ON s.id=i.stage_id \
             WHERE s.kind<>'done' AND i.done_at IS NOT NULL AND i.archived_at IS NULL \
             ORDER BY i.done_at LIMIT 1000 FOR UPDATE SKIP LOCKED)",
        )
        .execute(&mut **tx)
        .await?
        .rows_affected();

        let backfilled = sqlx::query!(
            "UPDATE issues SET done_at=updated_at,updated_at=now() WHERE id IN (\
             SELECT i.id FROM issues i JOIN stages s ON s.id=i.stage_id \
             WHERE s.kind='done' AND i.done_at IS NULL AND i.deleted_at IS NULL \
             ORDER BY i.updated_at LIMIT 1000 FOR UPDATE SKIP LOCKED)",
        )
        .execute(&mut **tx)
        .await?
        .rows_affected();

        let archived = sqlx::query!(
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
