use crate::{
    error::{Error, Result},
    jobs::{Job, PAYLOAD_VERSION},
};
use chrono::Utc;
use sqlx::{PgConnection, PgPool, Row, postgres::PgListener};
use std::sync::Arc;
use tokio::sync::Notify;
use uuid::Uuid;

pub const LEASE_SECONDS: i64 = 120;
const ERROR_BYTES: usize = 2048;

pub struct NewJob {
    /// Compatibility key, independent of the queue's UUID identity.
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

#[derive(Debug)]
pub struct Claim {
    pub id: Uuid,
    pub kind: String,
    pub queue: String,
    pub payload: String,
    pub payload_version: i32,
    pub attempts: i32,
    pub max_attempts: i32,
    pub token: Uuid,
}

#[derive(Clone)]
pub struct Outbox {
    pool: PgPool,
    ready: Arc<Notify>,
}

impl Outbox {
    pub fn new(pool: PgPool) -> Self {
        Self {
            pool,
            ready: Arc::new(Notify::new()),
        }
    }

    /// Call on the same connection as the business writes. NOTIFY becomes visible at commit.
    pub async fn insert(conn: &mut PgConnection, job: &NewJob) -> Result<()> {
        let payload = job.job.payload()?;

        if payload.len() > 240 * 1024 || job.id.len() > 512 {
            return Err(Error::BadRequest(
                "job payload or deduplication key too large".into(),
            ));
        }

        sqlx::query(
            "INSERT INTO jobs(id,kind,payload_version,payload,queue,run_at,\
            dedup_key) VALUES($1,$2,$3,$4,$5,to_timestamp($6),$7) ON \
            CONFLICT(dedup_key) DO NOTHING",
        )
        .bind(Uuid::new_v4())
        .bind(job.job.kind())
        .bind(PAYLOAD_VERSION)
        .bind(serde_json::from_str::<serde_json::Value>(&payload)?)
        .bind(job.job.queue())
        .bind(job.due_at as f64)
        .bind(&job.id)
        .execute(conn)
        .await?;
        Ok(())
    }

    pub fn ready(&self) {
        self.ready.notify_one();
    }

    pub async fn wait(&self) {
        self.ready.notified().await;
    }

    pub async fn listen(&self) -> Result<PgListener> {
        let mut listener = PgListener::connect_with(&self.pool).await?;
        // Surface disconnects so the worker scans and explicitly reconnects.
        listener.ignore_pool_close_event(false);
        listener.listen("blackwall_jobs").await?;

        Ok(listener)
    }

    /// Claims exactly the free slots supplied by the worker. No external I/O holds row locks.
    pub async fn claim(&self, queue: &str, slots: usize) -> Result<Vec<Claim>> {
        if slots == 0 {
            return Ok(Vec::new());
        }

        let mut tx = self.pool.begin().await?;

        sqlx::query(
            "WITH exhausted AS (SELECT id FROM jobs WHERE state='running' AND \
            lease_expires_at<=clock_timestamp() AND attempts>=max_attempts \
            ORDER BY lease_expires_at,id FOR UPDATE SKIP LOCKED LIMIT 100) \
            UPDATE jobs SET state='failed',claim_token=NULL,\
            lease_expires_at=NULL,finished_at=clock_timestamp(),\
            updated_at=clock_timestamp(),last_error='lease expired at maximum \
            attempts' FROM exhausted WHERE jobs.id=exhausted.id",
        )
        .execute(&mut *tx)
        .await?;

        let rows = sqlx::query(
            "WITH due AS (SELECT id FROM jobs WHERE queue=$1 AND \
            attempts<max_attempts AND ((state='pending' AND \
            run_at<=clock_timestamp()) OR (state='running' AND \
            lease_expires_at<=clock_timestamp())) ORDER BY run_at,id FOR UPDATE \
            SKIP LOCKED LIMIT $2) UPDATE jobs SET state='running',\
            claim_token=gen_random_uuid(),\
            lease_expires_at=clock_timestamp()+make_interval(secs=>$3::double \
            precision),attempts=attempts+1,updated_at=clock_timestamp() FROM \
            due WHERE jobs.id=due.id RETURNING jobs.id,kind,queue,payload,\
            payload_version,attempts,max_attempts,claim_token",
        )
        .bind(queue)
        .bind(slots.min(256) as i64)
        .bind(LEASE_SECONDS as f64)
        .fetch_all(&mut *tx)
        .await?;

        let claims = rows
            .into_iter()
            .map(|row| {
                Ok(Claim {
                    id: row.try_get("id")?,
                    kind: row.try_get("kind")?,
                    queue: row.try_get("queue")?,
                    payload: row.try_get::<serde_json::Value, _>("payload")?.to_string(),
                    payload_version: row.try_get("payload_version")?,
                    attempts: row.try_get("attempts")?,
                    max_attempts: row.try_get("max_attempts")?,
                    token: row.try_get("claim_token")?,
                })
            })
            .collect::<Result<Vec<_>>>()?;
        tx.commit().await?;

        Ok(claims)
    }

    pub async fn claim_next(&self) -> Result<Option<Claim>> {
        for queue in ["database", "email", "webhook", "openproject"] {
            if let Some(claim) = self.claim(queue, 1).await?.pop() {
                return Ok(Some(claim));
            }
        }

        Ok(None)
    }

    pub async fn complete_in(conn: &mut PgConnection, claim: &Claim) -> Result<bool> {
        Ok(sqlx::query(
            "UPDATE jobs SET state='succeeded',claim_token=NULL,\
            lease_expires_at=NULL,last_error='',finished_at=clock_timestamp(),\
            updated_at=clock_timestamp() WHERE id=$1 AND state='running' AND \
            claim_token=$2 AND lease_expires_at>clock_timestamp()",
        )
        .bind(claim.id)
        .bind(claim.token)
        .execute(conn)
        .await?
        .rows_affected()
            == 1)
    }

    pub async fn complete(&self, claim: &Claim) -> Result<bool> {
        Self::complete_in(&mut *self.pool.acquire().await?, claim).await
    }

    pub async fn renew(&self, claim: &Claim) -> Result<bool> {
        Ok(sqlx::query(
            "UPDATE jobs SET \
            lease_expires_at=clock_timestamp()+make_interval(secs=>$3::double \
            precision),updated_at=clock_timestamp() WHERE id=$1 AND \
            state='running' AND claim_token=$2 AND \
            lease_expires_at>clock_timestamp()",
        )
        .bind(claim.id)
        .bind(claim.token)
        .bind(LEASE_SECONDS as f64)
        .execute(&self.pool)
        .await?
        .rows_affected()
            == 1)
    }

    pub async fn fail(&self, claim: &Claim, error: &str) -> Result<bool> {
        self.finish_attempt(claim, error, true).await
    }

    pub async fn retry(&self, claim: &Claim, error: &str) -> Result<bool> {
        self.finish_attempt(claim, error, false).await
    }

    async fn finish_attempt(&self, claim: &Claim, error: &str, permanent: bool) -> Result<bool> {
        let failed = permanent || claim.attempts >= claim.max_attempts;
        let base = 30_i64
            .saturating_mul(2_i64.pow(claim.attempts.saturating_sub(1).min(11) as u32))
            .min(86400);
        let jitter = (Uuid::new_v4().as_u128() % (base as u128 / 4 + 1)) as i64;

        Ok(sqlx::query(
            "UPDATE jobs SET state=CASE WHEN $3 THEN 'failed' ELSE 'pending' END,\
            run_at=clock_timestamp()+make_interval(secs=>$4::double precision),\
            claim_token=NULL,lease_expires_at=NULL,last_error=$5,\
            finished_at=CASE WHEN $3 THEN clock_timestamp() ELSE NULL END,\
            updated_at=clock_timestamp() WHERE id=$1 AND state='running' AND \
            claim_token=$2 AND lease_expires_at>clock_timestamp()",
        )
        .bind(claim.id)
        .bind(claim.token)
        .bind(failed)
        .bind((base + jitter).min(86400) as f64)
        .bind(bounded_error(error))
        .execute(&self.pool)
        .await?
        .rows_affected()
            == 1)
    }

    pub async fn cancel(&self, id: Uuid, token: Option<Uuid>) -> Result<bool> {
        Ok(sqlx::query(
            "UPDATE jobs SET state='cancelled',claim_token=NULL,\
            lease_expires_at=NULL,finished_at=clock_timestamp(),\
            updated_at=clock_timestamp() WHERE id=$1 AND ((state='pending' AND \
            $2::uuid IS NULL) OR (state='running' AND claim_token=$2))",
        )
        .bind(id)
        .bind(token)
        .execute(&self.pool)
        .await?
        .rows_affected()
            == 1)
    }

    pub async fn retry_failed(&self, id: Uuid) -> Result<bool> {
        Ok(sqlx::query(
            "UPDATE jobs SET state='pending',attempts=0,finished_at=NULL,\
            run_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1 \
            AND state='failed'",
        )
        .bind(id)
        .execute(&self.pool)
        .await?
        .rows_affected()
            == 1)
    }

    pub async fn next_due(&self) -> Result<Option<i64>> {
        Ok(sqlx::query_scalar(
            "SELECT EXTRACT(EPOCH FROM min(CASE WHEN state='running' THEN \
            lease_expires_at ELSE run_at END))::bigint FROM jobs WHERE state IN \
            ('pending','running')",
        )
        .fetch_one(&self.pool)
        .await?)
    }

    pub async fn cleanup(&self, retention_days: i32) -> Result<u64> {
        if retention_days < 1 {
            return Err(Error::BadRequest(
                "queue retention must be at least one day".into(),
            ));
        }

        Ok(sqlx::query(
            "WITH old AS (SELECT id FROM jobs WHERE state IN ('succeeded',\
            'cancelled') AND \
            finished_at<clock_timestamp()-make_interval(days=>$1) ORDER BY \
            finished_at,id FOR UPDATE SKIP LOCKED LIMIT 1000) DELETE FROM jobs \
            USING old WHERE jobs.id=old.id",
        )
        .bind(retention_days)
        .execute(&self.pool)
        .await?
        .rows_affected())
    }
}

fn bounded_error(error: &str) -> &str {
    let mut end = error.len().min(ERROR_BYTES);
    while !error.is_char_boundary(end) {
        end -= 1;
    }
    &error[..end]
}
