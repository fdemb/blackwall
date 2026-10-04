use crate::{
    domain::Workspace,
    error::{Error, Result},
};
use chrono::{DateTime, Utc};
use sqlx::{AnyPool, Row, any::AnyPoolOptions};
use std::sync::Arc;
use tokio::sync::Notify;
use uuid::Uuid;

mod outbox;

pub use outbox::{Claim, NewJob, Outbox};

#[derive(Clone)]
pub struct Store {
    pub pool: AnyPool,
    pub outbox: Outbox,
    /// Fires when a commit may have moved a workspace's next tick earlier.
    pub(crate) ticks_changed: Arc<Notify>,
}

pub struct NewAttachment {
    pub id: Uuid,
    pub issue_id: Uuid,
    pub uploader_id: Uuid,
    pub filename: String,
    pub content_type: String,
    pub bytes: Vec<u8>,
}

impl Store {
    pub async fn connect(url: &str) -> Result<Self> {
        sqlx::any::install_default_drivers();

        let pool = AnyPoolOptions::new()
            .max_connections(if url.contains(":memory:") { 1 } else { 8 })
            .connect(url)
            .await?;
        if url.starts_with("sqlite:") && !url.contains(":memory:") {
            sqlx::query("PRAGMA journal_mode = WAL")
                .execute(&pool)
                .await?;
        }

        let store = Self {
            outbox: Outbox::new(pool.clone()),
            pool,
            ticks_changed: Arc::new(Notify::new()),
        };
        store.migrate().await?;

        Ok(store)
    }

    async fn migrate(&self) -> Result<()> {
        let statements = [
            "CREATE TABLE IF NOT EXISTS schema_migrations (\
                 version BIGINT PRIMARY KEY, \
                 applied_at BIGINT NOT NULL\
             )",
            "CREATE TABLE IF NOT EXISTS users (\
                 id TEXT PRIMARY KEY, \
                 email TEXT NOT NULL UNIQUE, \
                 password_hash TEXT NOT NULL, \
                 profile TEXT NOT NULL\
             )",
            "CREATE TABLE IF NOT EXISTS sessions (\
                 token_hash TEXT PRIMARY KEY, \
                 user_id TEXT NOT NULL REFERENCES users(id), \
                 expires_at BIGINT NOT NULL\
             )",
            "CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id)",
            "CREATE TABLE IF NOT EXISTS password_resets (\
                 token_hash TEXT PRIMARY KEY, \
                 user_id TEXT NOT NULL REFERENCES users(id), \
                 expires_at BIGINT NOT NULL\
             )",
            "CREATE TABLE IF NOT EXISTS workspaces (\
                 id TEXT PRIMARY KEY, \
                 revision BIGINT NOT NULL, \
                 data TEXT NOT NULL\
             )",
            "CREATE TABLE IF NOT EXISTS workspace_members (\
                 workspace_id TEXT NOT NULL REFERENCES workspaces(id), \
                 user_id TEXT NOT NULL REFERENCES users(id), \
                 PRIMARY KEY (workspace_id, user_id)\
             )",
            "CREATE INDEX IF NOT EXISTS memberships_user ON workspace_members(user_id)",
            "CREATE TABLE IF NOT EXISTS outbox (\
                 id TEXT PRIMARY KEY, \
                 kind TEXT NOT NULL, \
                 payload TEXT NOT NULL, \
                 due_at BIGINT NOT NULL, \
                 attempts BIGINT NOT NULL DEFAULT 0, \
                 lease_until BIGINT NOT NULL DEFAULT 0, \
                 delivered_at BIGINT NOT NULL DEFAULT 0, \
                 last_error TEXT NOT NULL DEFAULT ''\
             )",
            "CREATE INDEX IF NOT EXISTS outbox_due ON outbox(delivered_at, due_at, lease_until)",
            "CREATE TABLE IF NOT EXISTS attachments (\
                 id TEXT PRIMARY KEY, \
                 workspace_id TEXT NOT NULL REFERENCES workspaces(id), \
                 issue_id TEXT NOT NULL, \
                 uploader_id TEXT NOT NULL REFERENCES users(id), \
                 filename TEXT NOT NULL, \
                 content_type TEXT NOT NULL, \
                 bytes_hex TEXT NOT NULL, \
                 created_at BIGINT NOT NULL\
             )",
        ];

        let mut tx = self.pool.begin().await?;
        for statement in statements {
            sqlx::query(statement).execute(&mut *tx).await?;
        }
        sqlx::query(
            "INSERT INTO schema_migrations (version, applied_at) \
             VALUES (1, $1) \
             ON CONFLICT (version) DO NOTHING",
        )
        .bind(Utc::now().timestamp())
        .execute(&mut *tx)
        .await?;

        let scheduled = sqlx::query("SELECT version FROM schema_migrations WHERE version = 2")
            .fetch_optional(&mut *tx)
            .await?
            .is_some();
        if !scheduled {
            // Existing workspaces start due so the first tick computes their real schedule.
            sqlx::query("ALTER TABLE workspaces ADD COLUMN next_tick_at BIGINT DEFAULT 0")
                .execute(&mut *tx)
                .await?;
            sqlx::query("CREATE INDEX workspaces_next_tick ON workspaces(next_tick_at)")
                .execute(&mut *tx)
                .await?;
            sqlx::query("INSERT INTO schema_migrations (version, applied_at) VALUES (2, $1)")
                .bind(Utc::now().timestamp())
                .execute(&mut *tx)
                .await?;
        }

        tx.commit().await?;

        Ok(())
    }

    pub async fn load_workspace(&self, id: Uuid) -> Result<(Workspace, i64)> {
        let row = sqlx::query("SELECT revision, data FROM workspaces WHERE id = $1")
            .bind(id.to_string())
            .fetch_optional(&self.pool)
            .await?
            .ok_or(Error::NotFound)?;

        Ok((
            serde_json::from_str(row.try_get::<&str, _>("data")?)?,
            row.try_get("revision")?,
        ))
    }

    pub async fn workspace_ids(&self, user: Option<Uuid>) -> Result<Vec<Uuid>> {
        let rows = if let Some(user) = user {
            sqlx::query(
                "SELECT workspace_id AS id \
                 FROM workspace_members \
                 WHERE user_id = $1 \
                 ORDER BY workspace_id",
            )
            .bind(user.to_string())
            .fetch_all(&self.pool)
            .await?
        } else {
            sqlx::query("SELECT id FROM workspaces ORDER BY id")
                .fetch_all(&self.pool)
                .await?
        };

        rows.into_iter()
            .map(|row| {
                Uuid::parse_str(row.try_get::<&str, _>("id")?)
                    .map_err(|e| Error::Internal(e.to_string()))
            })
            .collect()
    }

    pub async fn insert_workspace(&self, workspace: &Workspace, creator: Uuid) -> Result<()> {
        let mut tx = self.pool.begin().await?;
        let next_tick = workspace.tick_due(Utc::now()).map(ceil_seconds);
        sqlx::query(
            "INSERT INTO workspaces (id, revision, data, next_tick_at) \
             VALUES ($1, 0, $2, $3)",
        )
        .bind(workspace.id.to_string())
        .bind(serde_json::to_string(workspace)?)
        .bind(next_tick)
        .execute(&mut *tx)
        .await?;
        sqlx::query("INSERT INTO workspace_members (workspace_id, user_id) VALUES ($1, $2)")
            .bind(workspace.id.to_string())
            .bind(creator.to_string())
            .execute(&mut *tx)
            .await?;

        tx.commit().await?;
        self.tick_scheduled(next_tick);

        Ok(())
    }

    pub async fn save_workspace(
        &self,
        workspace: &Workspace,
        expected_revision: i64,
    ) -> Result<i64> {
        self.commit_workspace(workspace, expected_revision, &[], None)
            .await
    }

    pub async fn commit_workspace(
        &self,
        workspace: &Workspace,
        expected_revision: i64,
        jobs: &[NewJob],
        attachment: Option<NewAttachment>,
    ) -> Result<i64> {
        if serde_json::to_vec(workspace)?.len() > 16 * 1024 * 1024 {
            return Err(Error::BadRequest(
                "workspace storage limit is 16 MiB".into(),
            ));
        }

        let next_tick = workspace.tick_due(Utc::now()).map(ceil_seconds);
        let mut tx = self.pool.begin().await?;
        let updated = sqlx::query(
            "UPDATE workspaces \
             SET data = $1, revision = revision + 1, next_tick_at = $2 \
             WHERE id = $3 AND revision = $4",
        )
        .bind(serde_json::to_string(workspace)?)
        .bind(next_tick)
        .bind(workspace.id.to_string())
        .bind(expected_revision)
        .execute(&mut *tx)
        .await?;
        if updated.rows_affected() != 1 {
            return Err(Error::Conflict(
                "workspace changed; reload and retry".into(),
            ));
        }

        sqlx::query("DELETE FROM workspace_members WHERE workspace_id = $1")
            .bind(workspace.id.to_string())
            .execute(&mut *tx)
            .await?;
        for member in &workspace.members {
            sqlx::query("INSERT INTO workspace_members (workspace_id, user_id) VALUES ($1, $2)")
                .bind(workspace.id.to_string())
                .bind(member.user_id.to_string())
                .execute(&mut *tx)
                .await?;
        }

        for job in jobs {
            Outbox::insert(&mut tx, job).await?;
        }

        if let Some(a) = attachment {
            sqlx::query(
                "INSERT INTO attachments (\
                     id, workspace_id, issue_id, uploader_id, \
                     filename, content_type, bytes_hex, created_at\
                 ) \
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
            )
            .bind(a.id.to_string())
            .bind(workspace.id.to_string())
            .bind(a.issue_id.to_string())
            .bind(a.uploader_id.to_string())
            .bind(a.filename)
            .bind(a.content_type)
            .bind(hex::encode(a.bytes))
            .bind(chrono::Utc::now().timestamp())
            .execute(&mut *tx)
            .await?;
        }

        tx.commit().await?;

        if !jobs.is_empty() {
            self.outbox.ready();
        }
        self.tick_scheduled(next_tick);

        Ok(expected_revision + 1)
    }

    fn tick_scheduled(&self, next_tick: Option<i64>) {
        if next_tick.is_some() {
            self.ticks_changed.notify_one();
        }
    }

    /// Workspaces whose scheduled tick is due at `now`.
    pub async fn due_workspaces(&self, now: DateTime<Utc>) -> Result<Vec<Uuid>> {
        let rows =
            sqlx::query("SELECT id FROM workspaces WHERE next_tick_at <= $1 ORDER BY next_tick_at")
                .bind(now.timestamp())
                .fetch_all(&self.pool)
                .await?;

        rows.into_iter()
            .map(|row| {
                Uuid::parse_str(row.try_get::<&str, _>("id")?)
                    .map_err(|e| Error::Internal(e.to_string()))
            })
            .collect()
    }

    pub async fn next_workspace_tick(&self) -> Result<Option<i64>> {
        let row = sqlx::query("SELECT MIN(next_tick_at) AS next FROM workspaces")
            .fetch_one(&self.pool)
            .await?;

        Ok(row.try_get("next")?)
    }

    /// Records the next tick for an unchanged revision. A newer commit already set its own.
    pub async fn reschedule_tick(
        &self,
        id: Uuid,
        revision: i64,
        at: Option<DateTime<Utc>>,
    ) -> Result<()> {
        sqlx::query("UPDATE workspaces SET next_tick_at = $1 WHERE id = $2 AND revision = $3")
            .bind(at.map(ceil_seconds))
            .bind(id.to_string())
            .bind(revision)
            .execute(&self.pool)
            .await?;

        Ok(())
    }
}

/// Rounds up so a wakeup never lands just before the event and spins until it arrives.
fn ceil_seconds(at: DateTime<Utc>) -> i64 {
    at.timestamp() + i64::from(at.timestamp_subsec_nanos() > 0)
}
