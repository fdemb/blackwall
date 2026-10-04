use crate::{error::Result, jobs::Job};
use chrono::Utc;
use sqlx::{AnyConnection, AnyPool, Row};
use std::sync::Arc;
use tokio::sync::Notify;

const LEASE_SECONDS: i64 = 120;

/// Due rows read per claim, so contention with another worker rarely needs a second query.
const CANDIDATES: i64 = 8;

pub struct NewJob {
    pub id: String,
    pub job: Job,
    pub due_at: i64,
}

impl NewJob {
    pub fn now(id: impl Into<String>, job: Job) -> Self {
        Self {
            id: id.into(),
            job,
            due_at: Utc::now().timestamp(),
        }
    }
}

/// A leased outbox row. Only the worker holding the lease can complete or reschedule it.
pub struct Claim {
    pub id: String,
    pub kind: String,
    pub payload: String,
    attempts: i64,
    lease: i64,
}

/// Durable delivery queue. Producers insert jobs in the transaction that creates them, then call
/// `ready` after commit so the worker drains without waiting for a timer.
#[derive(Clone)]
pub struct Outbox {
    pool: AnyPool,
    ready: Arc<Notify>,
}

impl Outbox {
    pub(super) fn new(pool: AnyPool) -> Self {
        Self {
            pool,
            ready: Arc::new(Notify::new()),
        }
    }

    pub(crate) async fn insert(conn: &mut AnyConnection, job: &NewJob) -> Result<()> {
        sqlx::query(
            "INSERT INTO outbox (id, kind, payload, due_at) \
             VALUES ($1, $2, $3, $4) \
             ON CONFLICT (id) DO NOTHING",
        )
        .bind(&job.id)
        .bind(job.job.kind())
        .bind(job.job.payload()?)
        .bind(job.due_at)
        .execute(conn)
        .await?;

        Ok(())
    }

    pub fn ready(&self) {
        self.ready.notify_one();
    }

    /// Resolves after the next `ready` call, including one made before this was awaited.
    pub async fn wait(&self) {
        self.ready.notified().await;
    }

    /// Leases the oldest due row. Each row is claimed just before delivery so its lease covers
    /// only that attempt. Rows another worker claimed first are skipped.
    pub async fn claim_next(&self) -> Result<Option<Claim>> {
        let now = Utc::now().timestamp();
        let rows = sqlx::query(
            "SELECT id, kind, payload, attempts \
             FROM outbox \
             WHERE delivered_at = 0 AND due_at <= $1 AND lease_until <= $1 \
             ORDER BY due_at, id \
             LIMIT $2",
        )
        .bind(now)
        .bind(CANDIDATES)
        .fetch_all(&self.pool)
        .await?;

        for row in rows {
            let id: String = row.try_get("id")?;
            let lease = now + LEASE_SECONDS;
            let claimed = sqlx::query(
                "UPDATE outbox \
                 SET lease_until = $1, attempts = attempts + 1 \
                 WHERE id = $2 AND delivered_at = 0 AND lease_until <= $3 AND due_at <= $3",
            )
            .bind(lease)
            .bind(&id)
            .bind(now)
            .execute(&self.pool)
            .await?;

            if claimed.rows_affected() == 1 {
                return Ok(Some(Claim {
                    id,
                    kind: row.try_get("kind")?,
                    payload: row.try_get("payload")?,
                    attempts: row.try_get("attempts")?,
                    lease,
                }));
            }
        }

        Ok(None)
    }

    pub async fn complete(&self, claim: &Claim) -> Result<()> {
        sqlx::query(
            "UPDATE outbox \
             SET delivered_at = $1, lease_until = 0, last_error = '' \
             WHERE id = $2 AND lease_until = $3",
        )
        .bind(Utc::now().timestamp())
        .bind(&claim.id)
        .bind(claim.lease)
        .execute(&self.pool)
        .await?;

        Ok(())
    }

    /// Reschedules with exponential backoff from 30 seconds up to one day.
    pub async fn retry(&self, claim: &Claim, error: &str) -> Result<()> {
        let delay = 30_i64
            .saturating_mul(2_i64.pow((claim.attempts as u32).min(11)))
            .min(86400);

        sqlx::query(
            "UPDATE outbox \
             SET due_at = $1, lease_until = 0, last_error = $2 \
             WHERE id = $3 AND lease_until = $4",
        )
        .bind(Utc::now().timestamp() + delay)
        .bind(error)
        .bind(&claim.id)
        .bind(claim.lease)
        .execute(&self.pool)
        .await?;

        Ok(())
    }

    /// When the next undelivered row becomes claimable, counting expired leases as retries.
    pub async fn next_due(&self) -> Result<Option<i64>> {
        let row = sqlx::query(
            "SELECT MIN(\
                 CASE WHEN lease_until > due_at THEN lease_until ELSE due_at END\
             ) AS next \
             FROM outbox \
             WHERE delivered_at = 0",
        )
        .fetch_one(&self.pool)
        .await?;

        Ok(row.try_get("next")?)
    }
}
