use crate::{
    domain::*,
    error::{Error, Result},
};
use chrono::{DateTime, Utc};
use sqlx::{PgConnection, PgPool, Postgres, Row, Transaction, postgres::PgPoolOptions};
use std::{collections::BTreeMap, time::Duration};
use uuid::Uuid;

mod changes;
mod discussion;
mod issues;
pub mod ownership;
pub(crate) mod persistence;
mod planning;
mod queue;
mod reads;
mod transfer;

pub use changes::{Change, ChangeFeed};
pub use queue::{Claim, NewJob, Outbox};
pub use reads::CollectionQuery;

#[derive(Clone)]
pub struct Store {
    pub pool: PgPool,
    pub outbox: Outbox,
}

pub struct NewAttachment {
    pub id: Uuid,
    pub issue_id: Uuid,
    pub uploader_id: Uuid,
    pub filename: String,
    pub content_type: String,
    pub bytes: Vec<u8>,
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, utoipa::ToSchema)]
pub struct OperationResult {
    pub result: CommandResult,
    pub versions: BTreeMap<Uuid, i64>,
    /// Every record the operation changed that the caller can see, including side effects such
    /// as a parent's subtask counts. A null record was deleted or is no longer visible.
    #[serde(default)]
    pub changes: Vec<Change>,
}

pub(super) struct Operation<'a> {
    pub tx: Transaction<'a, Postgres>,
    pub workspace_id: Uuid,
    pub actor: Uuid,
    pub role: Role,
    pub expected: BTreeMap<Uuid, i64>,
    pub versions: BTreeMap<Uuid, i64>,
    pub activity_fields: Vec<String>,
}

pub(super) fn enum_text<T: serde::Serialize>(v: &T) -> String {
    serde_json::to_value(v)
        .unwrap()
        .as_str()
        .unwrap()
        .to_owned()
}

impl Store {
    pub async fn connect(url: &str) -> Result<Self> {
        if !url.starts_with("postgres://") && !url.starts_with("postgresql://") {
            return Err(Error::BadRequest("DATABASE_URL must use PostgreSQL".into()));
        }

        let max = database_setting("DATABASE_MAX_CONNECTIONS", 16, 1, 256)?;
        let acquisition_seconds = database_setting("DATABASE_ACQUIRE_TIMEOUT_SECONDS", 10, 1, 60)?;

        let pool = PgPoolOptions::new()
            .max_connections(max)
            .acquire_timeout(Duration::from_secs(u64::from(acquisition_seconds)))
            .connect(url)
            .await?;

        sqlx::migrate!()
            .run(&pool)
            .await
            .map_err(|e| Error::Internal(e.to_string()))?;

        Ok(Self {
            outbox: Outbox::new(pool.clone()),
            pool,
        })
    }

    pub async fn operation(
        &self,
        workspace_id: Uuid,
        actor: Uuid,
        command: Command,
        expected: BTreeMap<Uuid, i64>,
        key: Option<String>,
        attachment: Option<NewAttachment>,
    ) -> Result<OperationResult> {
        use sha2::{Digest, Sha256};

        let mut command_fingerprint = serde_json::to_value(&command)?;
        if attachment.is_some()
            && let Some(metadata) = command_fingerprint
                .get_mut("attachment")
                .and_then(serde_json::Value::as_object_mut)
        {
            metadata.remove("id");
        }

        let request = serde_json::json!({
            "command": command_fingerprint,
            "expected_versions": expected,
            "attachment": attachment.as_ref().map(|a| serde_json::json!({
                "filename": a.filename,
                "content_type": a.content_type,
                "sha256": hex::encode(Sha256::digest(&a.bytes)),
            })),
        });

        let membership_exclusive = matches!(
            command,
            Command::SetRole { .. } | Command::RemoveMember { .. }
        );

        let mut op = self
            .begin_operation(workspace_id, actor, expected, membership_exclusive)
            .await?;

        if let Some(key) = &key {
            crate::domain::text(key, 200)?;

            sqlx::query(
                "INSERT INTO operation_keys(workspace_id,actor,key,request) \
                 VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING",
            )
            .bind(workspace_id)
            .bind(actor)
            .bind(key)
            .bind(&request)
            .execute(&mut *op.tx)
            .await?;

            let row = sqlx::query(
                "SELECT request,result FROM operation_keys \
                 WHERE workspace_id=$1 AND actor=$2 AND key=$3 FOR UPDATE",
            )
            .bind(workspace_id)
            .bind(actor)
            .bind(key)
            .fetch_one(&mut *op.tx)
            .await?;

            if row.try_get::<serde_json::Value, _>("request")? != request {
                return Err(Error::Conflict(
                    "idempotency key reused for a different request".into(),
                ));
            }

            if let Some(value) = row.try_get::<Option<serde_json::Value>, _>("result")? {
                // Replays report the records as they are now, not as the first attempt saw them.
                let mut result: OperationResult = serde_json::from_value(value)?;
                changes::render(&mut op.tx, workspace_id, actor, &mut result.changes).await?;
                return Ok(result);
            }
        }

        let personal = matches!(
            &command,
            Command::MarkNotificationRead { .. }
                | Command::MarkNotificationUnread { .. }
                | Command::MarkAllNotificationsRead
                | Command::ConfigureAlerts { .. }
                | Command::SaveView { shared: false, .. }
                | Command::UpdateView { shared: false, .. }
                | Command::DeleteView { .. }
                | Command::Follow { .. }
        );

        if op.role == Role::Viewer && !personal {
            return Err(Error::Forbidden);
        }

        op.authorize_issue_ownership(&command).await?;

        let action = command.kind();
        let id = match &command {
            Command::CreateTeam { .. }
            | Command::SetTeamMembers { .. }
            | Command::CreateStage { .. }
            | Command::UpdateStage { .. }
            | Command::DeleteStage { .. }
            | Command::CreateLabel { .. }
            | Command::UpdateLabel { .. }
            | Command::CreateProject { .. }
            | Command::UpdateProject { .. }
            | Command::CreateMilestone { .. }
            | Command::UpdateMilestone { .. }
            | Command::CreateSprint { .. }
            | Command::UpdateSprint { .. }
            | Command::CompleteSprint { .. }
            | Command::ArchiveSprint { .. }
            | Command::SetTeamArchive { .. } => op.planning(command).await?,
            Command::CreateIssue { .. }
            | Command::UpdateIssue { .. }
            | Command::MoveIssue { .. }
            | Command::BulkIssues { .. }
            | Command::DeleteIssue { .. }
            | Command::RestoreIssue { .. }
            | Command::ArchiveIssue { .. }
            | Command::UnarchiveIssue { .. }
            | Command::Follow { .. }
            | Command::AddSourceLink { .. }
            | Command::ImportIssues { .. } => op.issues(command).await?,
            _ => op.discussion(command, attachment).await?,
        };

        let fields = std::mem::take(&mut op.activity_fields);
        op.activity(action, id, fields).await?;

        let mut result = OperationResult {
            result: CommandResult { id },
            versions: op.versions.clone(),
            changes: changes::pending(&mut op.tx, workspace_id, actor).await?,
        };

        // Store only which records changed; rendering them again on replay keeps keys small.
        if let Some(key) = key {
            sqlx::query(
                "UPDATE operation_keys SET result=$4 WHERE workspace_id=$1 AND actor=$2 AND key=$3",
            )
            .bind(workspace_id)
            .bind(actor)
            .bind(key)
            .bind(serde_json::to_value(&result)?)
            .execute(&mut *op.tx)
            .await?;
        }

        changes::render(&mut op.tx, workspace_id, actor, &mut result.changes).await?;
        op.tx.commit().await?;
        self.outbox.ready();

        Ok(result)
    }

    pub(super) async fn begin_operation(
        &self,
        workspace_id: Uuid,
        actor: Uuid,
        expected: BTreeMap<Uuid, i64>,
        exclusive: bool,
    ) -> Result<Operation<'static>> {
        let mut tx = self.pool.begin().await?;

        let auth_lock = if exclusive {
            "SELECT pg_advisory_xact_lock(hashtextextended($1, 74103))"
        } else {
            "SELECT pg_advisory_xact_lock_shared(hashtextextended($1, 74103))"
        };

        sqlx::query(auth_lock)
            .bind(workspace_id.to_string())
            .execute(&mut *tx)
            .await?;

        // Membership changes lock every member in UUID order. Other mutations retain shared locks.
        let role = if exclusive {
            let rows = sqlx::query(
                "SELECT user_id,role FROM workspace_members \
                 WHERE workspace_id=$1 ORDER BY user_id FOR UPDATE",
            )
            .bind(workspace_id)
            .fetch_all(&mut *tx)
            .await?;

            rows.into_iter()
                .find(|r| r.get::<Uuid, _>("user_id") == actor)
                .map(|r| r.get::<String, _>("role"))
                .ok_or(Error::Forbidden)?
        } else {
            sqlx::query(
                "SELECT role FROM workspace_members WHERE workspace_id=$1 AND user_id=$2 FOR SHARE",
            )
            .bind(workspace_id)
            .bind(actor)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or(Error::Forbidden)?
            .try_get::<String, _>("role")?
        };

        Ok(Operation {
            tx,
            workspace_id,
            actor,
            role: serde_json::from_value(serde_json::Value::String(role))?,
            expected,
            versions: BTreeMap::new(),
            activity_fields: Vec::new(),
        })
    }
}

fn database_setting(name: &str, default: u32, min: u32, max: u32) -> Result<u32> {
    let value = match std::env::var(name) {
        Ok(value) => value
            .parse::<u32>()
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

impl Operation<'_> {
    pub fn admin(&self) -> Result<()> {
        if matches!(self.role, Role::Owner | Role::Admin) {
            Ok(())
        } else {
            Err(Error::Forbidden)
        }
    }

    pub async fn member(&mut self, user: Uuid) -> Result<()> {
        sqlx::query(
            "SELECT user_id FROM workspace_members WHERE workspace_id=$1 AND user_id=$2 FOR SHARE",
        )
        .bind(self.workspace_id)
        .bind(user)
        .fetch_optional(&mut *self.tx)
        .await?
        .ok_or(Error::Forbidden)?;

        Ok(())
    }

    pub async fn touch(&mut self, table: &str, id: Uuid) -> Result<i64> {
        if let Some(v) = self.versions.get(&id) {
            return Ok(*v);
        }

        let column = if matches!(table, "workspace_members" | "alert_preferences") {
            "user_id"
        } else {
            "id"
        };

        assert!(matches!(
            table,
            "issues"
                | "teams"
                | "stages"
                | "labels"
                | "projects"
                | "milestones"
                | "sprints"
                | "comments"
                | "time_entries"
                | "invitations"
                | "saved_views"
                | "notifications"
                | "integrations"
                | "workspace_members"
                | "alert_preferences"
        ));

        let sql =
            format!("SELECT version FROM {table} WHERE workspace_id=$1 AND {column}=$2 FOR UPDATE");
        let version: i64 = sqlx::query(&sql)
            .bind(self.workspace_id)
            .bind(id)
            .fetch_optional(&mut *self.tx)
            .await?
            .ok_or(Error::NotFound)?
            .try_get("version")?;

        let expected = self
            .expected
            .get(&id)
            .ok_or_else(|| Error::BadRequest(format!("expected_versions must include {id}")))?;

        if *expected != version {
            return Err(Error::Conflict(format!(
                "entity {id} changed; current version is {version}"
            )));
        }

        let sql =
            format!("UPDATE {table} SET version=version+1 WHERE workspace_id=$1 AND {column}=$2");
        sqlx::query(&sql)
            .bind(self.workspace_id)
            .bind(id)
            .execute(&mut *self.tx)
            .await?;

        self.versions.insert(id, version + 1);

        Ok(version + 1)
    }

    pub fn created(&mut self, id: Uuid) {
        self.versions.insert(id, 1);
    }

    pub async fn activity(
        &mut self,
        action: &str,
        id: Option<Uuid>,
        fields: Vec<String>,
    ) -> Result<()> {
        persistence::activity(
            &mut self.tx,
            self.workspace_id,
            self.actor,
            action,
            id,
            fields,
        )
        .await
    }

    pub async fn notify(
        &mut self,
        user: Uuid,
        issue_id: Option<Uuid>,
        kind: AlertKind,
        message: String,
        key: String,
    ) -> Result<()> {
        persistence::notify(
            &mut self.tx,
            self.workspace_id,
            user,
            issue_id,
            kind,
            message,
            key,
        )
        .await
    }

    pub async fn issue(&mut self, id: Uuid) -> Result<Issue> {
        reads::issue_on(&mut self.tx, self.workspace_id, id, false).await
    }
}
