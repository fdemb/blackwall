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
mod sync;
mod transfer;

pub use changes::Change;
pub(crate) use queue::LEASE_SECONDS;
pub use queue::{Claim, NewJob, Outbox};
pub use reads::CollectionQuery;
pub use sync::{
    MutationError, MutationResult, MutationStatus, PULL_BATCH_RANGE_SQL, PULL_BATCH_XIP_SQL,
    PULL_ROLE_CHANGED_SQL, PullResponse, PushOutcome, PushRequest, PushResponse, SyncMutation,
};

#[derive(Clone)]
pub struct Store {
    pub pool: PgPool,
    pub outbox: Outbox,
    pub(crate) openproject_client: reqwest::Client,
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
    /// Keyed by (table, id) so touching one table's row never short-circuits
    /// another table's row with the same id. Collapsed to Uuid keys for responses.
    pub versions: BTreeMap<(String, Uuid), i64>,
    pub activity_fields: Vec<String>,
}

pub(super) fn enum_text<T: serde::Serialize>(v: &T) -> String {
    serde_json::to_value(v)
        .unwrap()
        .as_str()
        .unwrap()
        .to_owned()
}

/// A client-chosen id that collides with any workspace's row is a business
/// error, not an internal one. Ids are globally unique primary keys, so the
/// message reveals nothing about where the row lives.
pub(super) fn id_conflict(error: sqlx::Error) -> Error {
    if let sqlx::Error::Database(db) = &error
        && db.is_unique_violation()
    {
        return Error::Conflict("id already exists".into());
    }
    Error::Database(error)
}

impl Operation<'_> {
    /// Reserve client-chosen ids across every entity table. Server-generated
    /// ids skip the check. Each id maps to one of 64 buckets by its low bits;
    /// bucket locks are taken in ascending order so concurrent multi-id
    /// operations cannot deadlock, and one transaction holds at most 64 locks
    /// however many ids it reserves. Bucket labels never parse as UUID text,
    /// so they cannot collide with other locks in this namespace. Callers
    /// that use more than one id must pass them all in one call before
    /// inserting anything.
    pub(super) async fn reserve_client_ids(
        &mut self,
        provided: &[Option<Uuid>],
    ) -> Result<Vec<Uuid>> {
        let mut resolved = Vec::with_capacity(provided.len());
        for id in provided {
            resolved.push(client_id(*id)?);
        }

        let mut ordered: Vec<Uuid> = provided
            .iter()
            .zip(&resolved)
            .filter(|(p, _)| p.is_some())
            .map(|(_, r)| *r)
            .collect();
        ordered.sort_unstable();
        ordered.dedup();

        let mut buckets: Vec<i64> = ordered
            .iter()
            .map(|id| (id.as_u128() & 63) as i64)
            .collect();
        buckets.sort_unstable();
        buckets.dedup();

        for bucket in buckets {
            sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1, 53177))")
                .bind(format!("client-id-bucket:{bucket}"))
                .execute(&mut *self.tx)
                .await?;
        }

        if !ordered.is_empty() {
            let taken: bool = sqlx::query_scalar(
                "SELECT EXISTS(SELECT 1 FROM issues WHERE id = ANY($1)) \
                 OR EXISTS(SELECT 1 FROM teams WHERE id = ANY($1)) \
                 OR EXISTS(SELECT 1 FROM stages WHERE id = ANY($1)) \
                 OR EXISTS(SELECT 1 FROM labels WHERE id = ANY($1)) \
                 OR EXISTS(SELECT 1 FROM projects WHERE id = ANY($1)) \
                 OR EXISTS(SELECT 1 FROM milestones WHERE id = ANY($1)) \
                 OR EXISTS(SELECT 1 FROM sprints WHERE id = ANY($1)) \
                 OR EXISTS(SELECT 1 FROM comments WHERE id = ANY($1)) \
                 OR EXISTS(SELECT 1 FROM time_entries WHERE id = ANY($1)) \
                 OR EXISTS(SELECT 1 FROM saved_views WHERE id = ANY($1)) \
                 OR EXISTS(SELECT 1 FROM invitations WHERE id = ANY($1)) \
                 OR EXISTS(SELECT 1 FROM integrations WHERE id = ANY($1)) \
                 OR EXISTS(SELECT 1 FROM notifications WHERE id = ANY($1)) \
                 OR EXISTS(SELECT 1 FROM attachments WHERE id = ANY($1)) \
                 OR EXISTS(SELECT 1 FROM users WHERE id = ANY($1)) \
                 OR EXISTS(SELECT 1 FROM workspaces WHERE id = ANY($1)) \
                 OR EXISTS(SELECT 1 FROM activity WHERE id = ANY($1)) \
                 OR EXISTS(SELECT 1 FROM source_links WHERE id = ANY($1)) \
                 OR EXISTS(SELECT 1 FROM openproject_connections WHERE id = ANY($1))",
            )
            .bind(&ordered)
            .fetch_one(&mut *self.tx)
            .await?;

            if taken {
                return Err(Error::Conflict("id already exists".into()));
            }
        }

        Ok(resolved)
    }

    pub(super) async fn reserve_client_id(&mut self, provided: Option<Uuid>) -> Result<Uuid> {
        let mut resolved = self.reserve_client_ids(&[provided]).await?;
        Ok(resolved.pop().expect("batch of one resolves to one id"))
    }

    pub(super) fn response_versions(&self) -> BTreeMap<Uuid, i64> {
        // Hand-written rows can reuse one id across tables. A UUID recorded
        // under more than one table is ambiguous, so it is left out instead of
        // reporting one table's version as another's.
        let mut tables_per_id: BTreeMap<Uuid, usize> = BTreeMap::new();
        for (_, id) in self.versions.keys() {
            *tables_per_id.entry(*id).or_default() += 1;
        }
        self.versions
            .iter()
            .filter(|((_, id), _)| tables_per_id[id] == 1)
            .map(|((_, id), version)| (*id, *version))
            .collect()
    }
}

/// Membership edits lock the whole roster; every other command shares the lock.
/// REST and sync push open their operations with the same rule.
pub(crate) fn membership_exclusive(command: &Command) -> bool {
    matches!(
        command,
        Command::SetRole { .. } | Command::RemoveMember { .. }
    )
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
            openproject_client: crate::openproject::http_client()?,
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

        let membership = membership_exclusive(&command);

        let mut op = self
            .begin_operation(workspace_id, actor, expected, membership)
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

        let id = op.run_command(command, attachment).await?;

        let mut result = OperationResult {
            result: CommandResult { id },
            versions: op.response_versions(),
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
    /// Runs one command inside this already-open operation: the viewer rule,
    /// ownership check, dispatch and activity row. Shared by the REST command
    /// endpoint and sync push, so both enforce identical semantics.
    pub(crate) async fn run_command(
        &mut self,
        command: Command,
        attachment: Option<NewAttachment>,
    ) -> Result<Option<Uuid>> {
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

        if self.role == Role::Viewer && !personal {
            return Err(Error::Forbidden);
        }

        self.authorize_issue_ownership(&command).await?;

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
            | Command::SetTeamArchive { .. } => self.planning(command).await?,
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
            | Command::ImportIssues { .. } => self.issues(command).await?,
            _ => self.discussion(command, attachment).await?,
        };

        let fields = std::mem::take(&mut self.activity_fields);
        self.activity(action, id, fields).await?;

        Ok(id)
    }

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
        let key = (table.to_owned(), id);
        if let Some(v) = self.versions.get(&key) {
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

        // Absent preconditions mean last-writer-wins. A present one still conflicts on mismatch.
        if let Some(expected) = self.expected.get(&id)
            && *expected != version
        {
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

        self.versions.insert(key, version + 1);

        Ok(version + 1)
    }

    pub fn created(&mut self, table: &str, id: Uuid) {
        self.versions.insert((table.to_owned(), id), 1);
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TestDatabase;

    #[tokio::test]
    async fn reserve_client_ids_holds_at_most_64_locks() {
        let database = TestDatabase::new().await;
        let store = Store::connect(&database.url).await.unwrap();

        let tx = store.pool.begin().await.unwrap();
        let mut op = Operation {
            tx,
            workspace_id: Uuid::new_v4(),
            actor: Uuid::new_v4(),
            role: Role::Owner,
            expected: BTreeMap::new(),
            versions: BTreeMap::new(),
            activity_fields: Vec::new(),
        };

        // 5000 supplied ids, as in one maximal ImportIssues command.
        let ids: Vec<Uuid> = (0..5000).map(|_| Uuid::new_v4()).collect();
        let provided: Vec<Option<Uuid>> = ids.iter().map(|id| Some(*id)).collect();
        op.reserve_client_ids(&provided).await.unwrap();

        let distinct: std::collections::BTreeSet<i64> =
            ids.iter().map(|id| (id.as_u128() & 63) as i64).collect();
        assert!(distinct.len() <= 64);

        // The transaction's only advisory locks are the reservation buckets.
        let held: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM pg_locks WHERE locktype = 'advisory' AND pid = pg_backend_pid()",
        )
        .fetch_one(&mut *op.tx)
        .await
        .unwrap();
        assert_eq!(held, distinct.len() as i64);
        assert!(held <= 64, "held {held} advisory locks");

        op.tx.rollback().await.unwrap();
        store.pool.close().await;
        database.cleanup().await;
    }

    fn import_input(team: Uuid, id: Option<Uuid>, title: &str) -> IssueInput {
        IssueInput {
            id,
            title: title.into(),
            description: String::new(),
            team_id: team,
            stage_id: None,
            assignee: None,
            priority: Priority::Normal,
            labels: Vec::new(),
            estimate: None,
            deadline: None,
            project_id: None,
            milestone_id: None,
            sprint_id: None,
            parent_id: None,
            dependencies: Vec::new(),
        }
    }

    async fn import_workspace(store: &Store, name: &str) -> (Uuid, Uuid, Uuid) {
        let actor = store
            .register(crate::auth::Register {
                email: format!("{name}-{}@example.com", Uuid::new_v4()),
                password: "import-lock-password".into(),
                display_name: name.into(),
            })
            .await
            .unwrap()
            .profile
            .id;
        let workspace: Uuid = serde_json::from_value(
            store
                .create_workspace("Import locks".into(), actor)
                .await
                .unwrap()["id"]
                .clone(),
        )
        .unwrap();
        let team = store
            .operation(
                workspace,
                actor,
                Command::CreateTeam {
                    id: None,
                    name: "Team".into(),
                    members: vec![actor],
                },
                BTreeMap::new(),
                None,
                None,
            )
            .await
            .unwrap()
            .result
            .id
            .unwrap();
        (workspace, actor, team)
    }

    #[tokio::test]
    async fn import_without_supplied_ids_holds_no_reservation_locks() {
        let database = TestDatabase::new().await;
        let store = Store::connect(&database.url).await.unwrap();
        let (workspace, actor, team) = import_workspace(&store, "generated").await;

        let tx = store.pool.begin().await.unwrap();
        let mut op = Operation {
            tx,
            workspace_id: workspace,
            actor,
            role: Role::Owner,
            expected: BTreeMap::new(),
            versions: BTreeMap::new(),
            activity_fields: Vec::new(),
        };

        let issues: Vec<IssueInput> = (0..20)
            .map(|n| import_input(team, None, &format!("Generated {n}")))
            .collect();
        op.issues(Command::ImportIssues { issues }).await.unwrap();

        // The transaction's only advisory locks are the issue-graph lock and
        // the issues capacity lock; the reservation namespace holds zero.
        let held: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM pg_locks WHERE locktype = 'advisory' AND pid = pg_backend_pid()",
        )
        .fetch_one(&mut *op.tx)
        .await
        .unwrap();
        assert_eq!(held, 2, "held {held} advisory locks");

        op.tx.rollback().await.unwrap();
        store.pool.close().await;
        database.cleanup().await;
    }

    #[tokio::test]
    async fn import_with_mixed_ids_holds_only_supplied_bucket_locks() {
        let database = TestDatabase::new().await;
        let store = Store::connect(&database.url).await.unwrap();
        let (workspace, actor, team) = import_workspace(&store, "mixed").await;

        let tx = store.pool.begin().await.unwrap();
        let mut op = Operation {
            tx,
            workspace_id: workspace,
            actor,
            role: Role::Owner,
            expected: BTreeMap::new(),
            versions: BTreeMap::new(),
            activity_fields: Vec::new(),
        };

        let supplied: Vec<Uuid> = (0..5).map(|_| Uuid::new_v4()).collect();
        let mut issues: Vec<IssueInput> = supplied
            .iter()
            .enumerate()
            .map(|(n, id)| import_input(team, Some(*id), &format!("Supplied {n}")))
            .collect();
        issues.extend((0..5).map(|n| import_input(team, None, &format!("Generated {n}"))));
        op.issues(Command::ImportIssues { issues }).await.unwrap();

        let distinct: std::collections::BTreeSet<i64> = supplied
            .iter()
            .map(|id| (id.as_u128() & 63) as i64)
            .collect();
        // One issue-graph lock and one issues capacity lock, plus exactly
        // the buckets of the supplied ids.
        let held: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM pg_locks WHERE locktype = 'advisory' AND pid = pg_backend_pid()",
        )
        .fetch_one(&mut *op.tx)
        .await
        .unwrap();
        assert_eq!(
            held,
            2 + distinct.len() as i64,
            "held {held} advisory locks"
        );

        op.tx.rollback().await.unwrap();
        store.pool.close().await;
        database.cleanup().await;
    }
}
