use crate::{
    domain::*,
    error::{Error, Result},
    ids::WorkspaceId,
    limits::{Limits, Resource, Usage},
};
use chrono::{DateTime, Utc};
use sqlx::{PgConnection, PgPool, Postgres, Row, Transaction, postgres::PgPoolOptions};
use std::{collections::BTreeMap, sync::Arc, time::Duration};
use tokio::sync::Semaphore;
use uuid::Uuid;

mod changes;
mod discussion;
mod issues;
pub(crate) mod persistence;
mod planning;
mod queue;
mod reads;
mod sync;
mod transfer;

pub use crate::sync_events::SyncEventsConfig;
pub use changes::Change;
pub(crate) use queue::LEASE_SECONDS;
pub use queue::{Claim, NewJob, Outbox};
pub use reads::CollectionQuery;
pub(crate) use reads::{issue_on, record_on};
pub use sync::{
    BOOTSTRAP_OVERALL_TIMEOUT, BOOTSTRAP_PERMIT_WAIT, BOOTSTRAP_SEND_TIMEOUT, MutationError,
    MutationResult, MutationStatus, PULL_BATCH_RANGE_SQL, PULL_BATCH_XIP_SQL,
    PULL_ROLE_CHANGED_SQL, PullResponse, PushOutcome, PushRequest, PushResponse, SYNC_SCHEMA,
    ScopeResponse, SyncMutation, SyncScope,
};

/// Tuning for [`Store::connect_with_config`]. Production uses [`Default`],
/// which reads pool sizes from the environment and bootstrap and sync-events
/// deadlines from the named constants in `store::sync` and `sync_events`.
#[derive(Clone, Debug)]
pub struct StoreConfig {
    pub max_connections: u32,
    pub acquire_timeout: Duration,
    pub bootstrap_permit_wait: Duration,
    pub bootstrap_send_timeout: Duration,
    pub bootstrap_overall_timeout: Duration,
    pub sync_events: SyncEventsConfig,
    pub limits: Limits,
}

impl Default for StoreConfig {
    fn default() -> Self {
        Self {
            max_connections: 16,
            acquire_timeout: Duration::from_secs(10),
            bootstrap_permit_wait: sync::BOOTSTRAP_PERMIT_WAIT,
            bootstrap_send_timeout: sync::BOOTSTRAP_SEND_TIMEOUT,
            bootstrap_overall_timeout: sync::BOOTSTRAP_OVERALL_TIMEOUT,
            sync_events: SyncEventsConfig::default(),
            limits: Limits::default(),
        }
    }
}

impl StoreConfig {
    pub fn from_env() -> Result<Self> {
        Ok(Self {
            max_connections: database_setting("DATABASE_MAX_CONNECTIONS", 16, 1, 256)?,
            acquire_timeout: Duration::from_secs(u64::from(database_setting(
                "DATABASE_ACQUIRE_TIMEOUT_SECONDS",
                10,
                1,
                60,
            )?)),
            limits: Limits::from_env()?,
            ..Self::default()
        })
    }
}

#[derive(Clone)]
pub struct Store {
    pub pool: PgPool,
    pub outbox: Outbox,
    pub(crate) tracker_client: reqwest::Client,
    pub(crate) bootstrap_permits: Arc<Semaphore>,
    pub(crate) bootstrap_permit_wait: Duration,
    pub(crate) bootstrap_send_timeout: Duration,
    pub(crate) bootstrap_overall_timeout: Duration,
    pub(crate) sync_pokes: Arc<crate::sync_events::PokeHub>,
    pub(crate) sync_events: SyncEventsConfig,
    /// Set once the HTTP server begins shutting down; ends `/sync/events`
    /// streams so graceful shutdown does not wait out their lifetime.
    pub(crate) sync_shutdown: Arc<tokio::sync::watch::Sender<bool>>,
    pub(crate) database_url: String,
    pub mail_enabled: bool,
    pub(crate) limits: Limits,
    pub registration: crate::auth::RegistrationMode,
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
    pub activity_changes: Vec<FieldChange>,
    pub mail_enabled: bool,
    pub invitation: Option<crate::domain::IssuedInvitation>,
    pub limits: Limits,
    /// Reset for every command, so a command sees the integrations its predecessors created.
    pub deliveries: persistence::Deliveries,
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

/// A team insert collides on its id or on its key.
pub(super) fn team_conflict(error: sqlx::Error) -> Error {
    if let sqlx::Error::Database(db) = &error
        && db.constraint() == Some("teams_key")
    {
        return Error::Conflict("team key already exists".into());
    }
    id_conflict(error)
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
            sqlx::query_scalar!(
                "SELECT pg_advisory_xact_lock(hashtextextended($1, 53177))",
                format!("client-id-bucket:{bucket}"),
            )
            .fetch_one(&mut *self.tx)
            .await?;
        }

        if !ordered.is_empty() {
            let taken: bool = sqlx::query_scalar!(
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
                 OR EXISTS(SELECT 1 FROM tracker_connections WHERE id = ANY($1)) AS \"taken!\"",
                &ordered,
            )
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
        Command::SetRole { .. } | Command::RemoveMember { .. } | Command::TransferOwnership { .. }
    )
}

impl Store {
    pub async fn connect(url: &str) -> Result<Self> {
        Self::connect_with_config(url, StoreConfig::from_env()?).await
    }

    pub async fn connect_with_config(url: &str, config: StoreConfig) -> Result<Self> {
        if !url.starts_with("postgres://") && !url.starts_with("postgresql://") {
            return Err(Error::BadRequest("DATABASE_URL must use PostgreSQL".into()));
        }

        let pool = PgPoolOptions::new()
            .max_connections(config.max_connections)
            .acquire_timeout(config.acquire_timeout)
            .connect(url)
            .await?;

        // A deploy rollback runs the previous binary against migrations from
        // the release it rolled back from, so tolerate versions it doesn't embed.
        let mut migrator = sqlx::migrate!();
        migrator.set_ignore_missing(true);
        migrator
            .run(&pool)
            .await
            .map_err(|e| Error::Internal(e.to_string()))?;

        Ok(Self {
            outbox: Outbox::new(pool.clone()),
            tracker_client: crate::tracker::http_client()?,
            bootstrap_permits: Arc::new(Semaphore::new(sync::bootstrap_permits(
                config.max_connections,
            ))),
            bootstrap_permit_wait: config.bootstrap_permit_wait,
            bootstrap_send_timeout: config.bootstrap_send_timeout,
            bootstrap_overall_timeout: config.bootstrap_overall_timeout,
            sync_pokes: Arc::default(),
            sync_events: config.sync_events,
            sync_shutdown: Arc::new(tokio::sync::watch::channel(false).0),
            database_url: url.to_owned(),
            limits: config.limits,
            mail_enabled: false,
            registration: crate::auth::RegistrationMode::Open,
            pool,
        })
    }

    /// Open subscriptions held by live `/sync/events` streams.
    pub fn sync_broadcast_receiver_count(&self) -> usize {
        self.sync_pokes.subscriber_count()
    }

    /// Pokes a workspace's live `/sync/events` streams. Tests use it to
    /// flood subscribers without touching the database.
    pub fn sync_broadcast_poke(&self, workspace: WorkspaceId) {
        self.sync_pokes.poke(workspace.0);
    }

    /// Ends open `/sync/events` streams and refuses to hold new ones open.
    /// Call when the HTTP server starts graceful shutdown.
    pub fn close_sync_events(&self) {
        self.sync_shutdown.send_replace(true);
    }

    /// Starts the workspace-change listener that fans `blackwall_changes`
    /// notifications out to `/sync/events` streams. Call once when the HTTP
    /// server starts; the worker never calls it.
    pub fn spawn_sync_events(&self) -> tokio::task::JoinHandle<()> {
        self.spawn_sync_events_with_url(&self.database_url)
    }

    /// Starts the listener with an explicit database URL for the dedicated
    /// connection. Production passes the pool's URL; tests point it at a TCP
    /// proxy to fail connects without touching database roles.
    pub fn spawn_sync_events_with_url(&self, database_url: &str) -> tokio::task::JoinHandle<()> {
        crate::sync_events::spawn_listener(
            self.pool.clone(),
            database_url.to_owned(),
            self.sync_pokes.clone(),
            self.sync_events.reconnect_delay,
        )
    }

    pub async fn operation(
        &self,
        workspace_id: WorkspaceId,
        actor: Uuid,
        command: Command,
        expected: BTreeMap<Uuid, i64>,
        key: Option<String>,
        attachment: Option<NewAttachment>,
    ) -> Result<OperationResult> {
        self.operation_via(
            workspace_id,
            actor,
            command,
            expected,
            key,
            None,
            None,
            attachment,
            None,
        )
        .await
    }

    /// Runs a command as `actor`, recording on its activity and comments that `via` acted for them.
    /// `sent` is the request as the client sent it; when given, a replayed key is matched
    /// against it instead of the command. A record keyed by command under `legacy_key`
    /// stands in for `key`.
    #[allow(clippy::too_many_arguments)]
    pub async fn operation_via(
        &self,
        workspace_id: WorkspaceId,
        actor: Uuid,
        command: Command,
        expected: BTreeMap<Uuid, i64>,
        key: Option<String>,
        legacy_key: Option<String>,
        sent: Option<serde_json::Value>,
        attachment: Option<NewAttachment>,
        via: Option<crate::domain::ViaToken>,
    ) -> Result<OperationResult> {
        use sha2::{Digest, Sha256};

        let workspace_id = workspace_id.0;
        let mut command_fingerprint = serde_json::to_value(&command)?;
        if attachment.is_some()
            && let Some(metadata) = command_fingerprint
                .get_mut("attachment")
                .and_then(serde_json::Value::as_object_mut)
        {
            metadata.remove("id");
        }

        let by_command = serde_json::json!({
            "command": command_fingerprint,
            "expected_versions": expected,
            "attachment": attachment.as_ref().map(|a| serde_json::json!({
                "filename": a.filename,
                "content_type": a.content_type,
                "sha256": hex::encode(Sha256::digest(&a.bytes)),
            })),
        });
        let request = sent.map(|sent| keyed_request(sent, &expected));

        let membership = membership_exclusive(&command);

        let mut op = self
            .begin_operation(workspace_id, actor, expected, membership)
            .await?;
        if let Some(via) = via {
            // Column defaults on activity and comments read this until the transaction ends.
            sqlx::query_scalar!(
                "SELECT set_config('blackwall.via', \
                 jsonb_build_object('kind',$1::text,'token_id',id,'name',name)::text, true) \
                 FROM api_tokens WHERE id=$2",
                serde_json::to_value(via.kind)?
                    .as_str()
                    .unwrap_or_default()
                    .to_owned(),
                via.token_id,
            )
            .fetch_optional(&mut *op.tx)
            .await?;
        }

        if let Some(key) = &key
            && let Some(value) = match &request {
                Some(request) => {
                    op.claim_key(key, request, Some(&by_command), legacy_key.as_deref())
                        .await?
                }
                None => op.claim_key(key, &by_command, None, None).await?,
            }
        {
            // Replays report the records as they are now, not as the first attempt saw them.
            let mut result: OperationResult = serde_json::from_value(value)?;
            changes::render(
                &mut op.tx,
                workspace_id,
                actor,
                &mut result.changes,
                changes::RecordShape::Rest,
            )
            .await?;
            return Ok(result);
        }

        let id = op.run_command(command, attachment).await?;

        let mut result = OperationResult {
            result: CommandResult {
                id,
                invitation: None,
            },
            versions: op.response_versions(),
            changes: changes::pending(&mut op.tx, workspace_id, actor).await?,
        };

        // Store only which records changed; rendering them again on replay keeps keys small.
        if let Some(key) = &key {
            op.save_key_result(key, serde_json::to_value(&result)?)
                .await?;
        }

        changes::render(
            &mut op.tx,
            workspace_id,
            actor,
            &mut result.changes,
            changes::RecordShape::Rest,
        )
        .await?;
        op.tx.commit().await?;

        result.result.invitation = op.invitation.take();
        Ok(result)
    }

    /// The stored result of a completed keyed request that sent exactly `sent`, so a
    /// handler can replay it before merging or resolving anything that may have changed
    /// since. Only members replay. A key recorded for another request is a conflict. Keys
    /// recorded by command, and keys still in flight, return `None` and resolve inside the
    /// operation.
    pub async fn replay(
        &self,
        workspace_id: WorkspaceId,
        actor: Uuid,
        key: &str,
        sent: serde_json::Value,
        expected: &BTreeMap<Uuid, i64>,
    ) -> Result<Option<OperationResult>> {
        let workspace_id = workspace_id.0;
        let mut conn = self.pool.acquire().await?;
        reads::authorize(&mut conn, workspace_id, actor).await?;
        let Some(row) = sqlx::query!(
            "SELECT request,result AS \"result!\" FROM operation_keys \
             WHERE workspace_id=$1 AND actor=$2 AND key=$3 AND result IS NOT NULL",
            workspace_id,
            actor,
            key,
        )
        .fetch_optional(&mut *conn)
        .await?
        else {
            return Ok(None);
        };
        let stored = row.request;
        if stored.get("sent").is_none() {
            return Ok(None);
        }
        if stored != keyed_request(sent, expected) {
            return Err(Error::Conflict(
                "idempotency key reused for a different request".into(),
            ));
        }
        let mut result: OperationResult = serde_json::from_value(row.result)?;
        changes::render(
            &mut conn,
            workspace_id,
            actor,
            &mut result.changes,
            changes::RecordShape::Rest,
        )
        .await?;
        Ok(Some(result))
    }

    pub(super) async fn begin_operation(
        &self,
        workspace_id: Uuid,
        actor: Uuid,
        expected: BTreeMap<Uuid, i64>,
        exclusive: bool,
    ) -> Result<Operation<'static>> {
        let mut tx = self.pool.begin().await?;

        if exclusive {
            sqlx::query_scalar!(
                "SELECT pg_advisory_xact_lock(hashtextextended($1, 74103))",
                workspace_id.to_string(),
            )
            .fetch_one(&mut *tx)
            .await?;
        } else {
            sqlx::query_scalar!(
                "SELECT pg_advisory_xact_lock_shared(hashtextextended($1, 74103))",
                workspace_id.to_string(),
            )
            .fetch_one(&mut *tx)
            .await?;
        }

        // Membership changes lock every member in UUID order. Other mutations retain shared locks.
        let role = if exclusive {
            let rows = sqlx::query!(
                "SELECT user_id,role FROM workspace_members \
                 WHERE workspace_id=$1 ORDER BY user_id FOR UPDATE",
                workspace_id,
            )
            .fetch_all(&mut *tx)
            .await?;

            rows.into_iter()
                .find(|r| r.user_id == actor)
                .map(|r| r.role)
                .ok_or(Error::Forbidden)?
        } else {
            sqlx::query_scalar!(
                "SELECT role FROM workspace_members WHERE workspace_id=$1 AND user_id=$2 FOR SHARE",
                workspace_id,
                actor,
            )
            .fetch_optional(&mut *tx)
            .await?
            .ok_or(Error::Forbidden)?
        };

        Ok(Operation {
            tx,
            workspace_id,
            actor,
            role: serde_json::from_value(serde_json::Value::String(role))?,
            expected,
            versions: BTreeMap::new(),
            activity_fields: Vec::new(),
            activity_changes: Vec::new(),
            mail_enabled: self.mail_enabled,
            invitation: None,
            limits: self.limits,
            deliveries: persistence::Deliveries::default(),
        })
    }
}

fn keyed_request(sent: serde_json::Value, expected: &BTreeMap<Uuid, i64>) -> serde_json::Value {
    serde_json::json!({
        "sent": sent,
        "expected_versions": expected,
    })
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
    /// Records `request` under the idempotency key. Returns the stored result
    /// when the key already completed, and rejects a key reused for another request.
    /// A stored record without a `sent` fingerprint predates them and was keyed by
    /// command, so it still matches `by_command`. Such a record under `legacy`, the
    /// name this key had back then, stands in for the key.
    pub(super) async fn claim_key(
        &mut self,
        key: &str,
        request: &serde_json::Value,
        by_command: Option<&serde_json::Value>,
        legacy: Option<&str>,
    ) -> Result<Option<serde_json::Value>> {
        crate::domain::text(key, 200)?;
        let legacy = match legacy {
            Some(legacy) => sqlx::query!(
                "SELECT request,result FROM operation_keys \
                 WHERE workspace_id=$1 AND actor=$2 AND key=$3 AND request->'sent' IS NULL",
                self.workspace_id,
                self.actor,
                legacy,
            )
            .fetch_optional(&mut *self.tx)
            .await?
            .map(|row| (row.request, row.result)),
            None => None,
        };
        let (stored, result) = match legacy {
            Some(row) => row,
            None => {
                sqlx::query!(
                    "INSERT INTO operation_keys(workspace_id,actor,key,request) \
                     VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING",
                    self.workspace_id,
                    self.actor,
                    key,
                    request,
                )
                .execute(&mut *self.tx)
                .await?;

                let row = sqlx::query!(
                    "SELECT request,result FROM operation_keys \
                     WHERE workspace_id=$1 AND actor=$2 AND key=$3 FOR UPDATE",
                    self.workspace_id,
                    self.actor,
                    key,
                )
                .fetch_one(&mut *self.tx)
                .await?;
                (row.request, row.result)
            }
        };

        let matches = stored == *request
            || by_command
                .is_some_and(|by_command| stored.get("sent").is_none() && stored == *by_command);
        if !matches {
            return Err(Error::Conflict(
                "idempotency key reused for a different request".into(),
            ));
        }
        Ok(result)
    }

    pub(super) async fn save_key_result(
        &mut self,
        key: &str,
        result: serde_json::Value,
    ) -> Result<()> {
        sqlx::query!(
            "UPDATE operation_keys SET result=$4 WHERE workspace_id=$1 AND actor=$2 AND key=$3",
            self.workspace_id,
            self.actor,
            key,
            result,
        )
        .execute(&mut *self.tx)
        .await?;
        Ok(())
    }

    /// Runs one command inside this already-open operation: the viewer rule,
    /// dispatch and activity row. Shared by the REST command
    /// endpoint and sync push, so both enforce identical semantics.
    pub(crate) async fn run_command(
        &mut self,
        command: Command,
        attachment: Option<NewAttachment>,
    ) -> Result<Option<Uuid>> {
        if self.role == Role::Viewer && !command.is_personal(self.actor) {
            return Err(Error::Forbidden);
        }

        self.deliveries = persistence::Deliveries::default();
        let action = command.kind();
        let update = command.is_issue_update();
        let id = match command.family() {
            CommandFamily::Planning => self.planning(command).await?,
            CommandFamily::Issues => self.issues(command).await?,
            CommandFamily::Discussion => self.discussion(command, attachment).await?,
        };

        let fields = std::mem::take(&mut self.activity_fields);
        let changes = std::mem::take(&mut self.activity_changes);
        if !(update && fields.is_empty()) {
            // A bulk update has no single issue whose values `changes` could describe.
            let changes = if id.is_some() { changes } else { Vec::new() };
            persistence::activity_with(
                &mut self.tx,
                self.workspace_id,
                self.actor,
                action,
                id,
                fields,
                changes,
                &mut self.deliveries,
            )
            .await?;
        }

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
        sqlx::query_scalar!(
            "SELECT user_id FROM workspace_members WHERE workspace_id=$1 AND user_id=$2 FOR SHARE",
            self.workspace_id,
            user,
        )
        .fetch_optional(&mut *self.tx)
        .await?
        .ok_or(Error::Forbidden)?;

        Ok(())
    }

    /// Subscribes `user` to the issue; repeat calls change nothing.
    async fn add_follower(&mut self, issue: Uuid, user: Uuid) -> Result<()> {
        sqlx::query!(
            "INSERT INTO issue_followers(workspace_id,issue_id,user_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
            self.workspace_id,
            issue,
            user,
        )
        .execute(&mut *self.tx)
            .await?;
        Ok(())
    }

    pub async fn touch(&mut self, table: &str, id: Uuid) -> Result<i64> {
        if let Some(v) = self.versions.get(&(table.to_owned(), id)) {
            return Ok(*v);
        }
        let version = self.lock(table, id).await?;
        self.touch_locked(table, id, version).await
    }

    pub async fn lock(&mut self, table: &str, id: Uuid) -> Result<i64> {
        if let Some(v) = self.versions.get(&(table.to_owned(), id)) {
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

        self.check_expected(id, version)?;
        Ok(version)
    }

    /// Bump a row already locked FOR UPDATE, after the caller's authorization checks.
    async fn touch_locked(&mut self, table: &str, id: Uuid, version: i64) -> Result<i64> {
        let key = (table.to_owned(), id);
        if let Some(version) = self.versions.get(&key) {
            return Ok(*version);
        }
        let column = if matches!(table, "workspace_members" | "alert_preferences") {
            "user_id"
        } else {
            "id"
        };

        self.check_expected(id, version)?;

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

    fn check_expected(&self, id: Uuid, version: i64) -> Result<()> {
        match self.expected.get(&id) {
            Some(expected) if *expected != version => Err(Error::Stale(format!(
                "entity {id} changed; current version is {version}"
            ))),
            _ => Ok(()),
        }
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
        persistence::activity_with(
            &mut self.tx,
            self.workspace_id,
            self.actor,
            action,
            id,
            fields,
            Vec::new(),
            &mut self.deliveries,
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
        fields: &[&str],
    ) -> Result<()> {
        persistence::notify(
            &mut self.tx,
            self.workspace_id,
            Some(self.actor),
            user,
            issue_id,
            kind,
            message,
            key,
            fields,
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
    use crate::ids::{IssueId, TeamId};
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
            activity_changes: Vec::new(),
            mail_enabled: true,
            invitation: None,
            limits: Limits::default(),
            deliveries: persistence::Deliveries::default(),
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

    fn import_input(team: TeamId, id: Option<Uuid>, title: &str) -> IssueInput {
        IssueInput {
            id: id.map(IssueId),
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

    async fn import_workspace(store: &Store, name: &str) -> (WorkspaceId, Uuid, TeamId) {
        let actor = store
            .register(crate::auth::Register {
                email: format!("{name}-{}@example.com", Uuid::new_v4()),
                password: "import-lock-password".into(),
                display_name: name.into(),
                invitation: None,
            })
            .await
            .unwrap()
            .session()
            .unwrap()
            .profile
            .id;
        let workspace: WorkspaceId = serde_json::from_value(
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
                    key: "TEA".into(),
                    members: vec![actor],
                    default_stage_ids: None,
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
        (workspace, actor, TeamId(team))
    }

    #[tokio::test]
    async fn import_without_supplied_ids_holds_no_reservation_locks() {
        let database = TestDatabase::new().await;
        let store = Store::connect(&database.url).await.unwrap();
        let (workspace, actor, team) = import_workspace(&store, "generated").await;

        let tx = store.pool.begin().await.unwrap();
        let mut op = Operation {
            tx,
            workspace_id: workspace.0,
            actor,
            role: Role::Owner,
            expected: BTreeMap::new(),
            versions: BTreeMap::new(),
            activity_fields: Vec::new(),
            activity_changes: Vec::new(),
            mail_enabled: true,
            invitation: None,
            limits: Limits::default(),
            deliveries: persistence::Deliveries::default(),
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
            workspace_id: workspace.0,
            actor,
            role: Role::Owner,
            expected: BTreeMap::new(),
            versions: BTreeMap::new(),
            activity_fields: Vec::new(),
            activity_changes: Vec::new(),
            mail_enabled: true,
            invitation: None,
            limits: Limits::default(),
            deliveries: persistence::Deliveries::default(),
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

    #[tokio::test]
    async fn completing_a_stage_reads_the_directory_once_for_all_its_deliveries() {
        let database = TestDatabase::new().await;
        let store = Store::connect(&database.url).await.unwrap();
        let (workspace, actor, team) = import_workspace(&store, "completing").await;
        let (stage, name, position): (Uuid, String, i64) = sqlx::query_as(
            "SELECT id,name,position FROM stages WHERE team_id=$1 AND kind='active' LIMIT 1",
        )
        .bind(team)
        .fetch_one(&store.pool)
        .await
        .unwrap();
        let issues: Vec<IssueInput> = (0..3)
            .map(|n| IssueInput {
                stage_id: Some(stage),
                ..import_input(team, None, &format!("Active {n}"))
            })
            .collect();
        for command in [
            Command::ImportIssues { issues },
            Command::CreateIntegration {
                id: None,
                name: "Everything".into(),
                webhook_url: "https://hooks.example.com/all".into(),
                secret: "completing-stage-secret".into(),
                events: vec![],
                include_data: true,
            },
        ] {
            store
                .operation(workspace, actor, command, BTreeMap::new(), None, None)
                .await
                .unwrap();
        }

        let tx = store.pool.begin().await.unwrap();
        let mut op = Operation {
            tx,
            workspace_id: workspace.0,
            actor,
            role: Role::Owner,
            expected: BTreeMap::new(),
            versions: BTreeMap::new(),
            activity_fields: Vec::new(),
            activity_changes: Vec::new(),
            mail_enabled: true,
            invitation: None,
            limits: Limits::default(),
            deliveries: persistence::Deliveries::default(),
        };
        op.run_command(
            Command::UpdateStage {
                team_id: team,
                id: stage,
                name,
                kind: crate::domain::StageKind::Done,
                position,
            },
            None,
        )
        .await
        .unwrap();

        let completed: Vec<serde_json::Value> = sqlx::query_scalar(
            "SELECT payload->'event' FROM jobs WHERE kind='webhook' \
             AND payload->'event'->>'type'='issue.completed'",
        )
        .fetch_all(&mut *op.tx)
        .await
        .unwrap();
        assert_eq!(completed.len(), 3, "{completed:?}");
        for event in &completed {
            assert_eq!(event["data"]["id"], event["entity_id"]);
            assert_eq!(event["data"]["stage"]["kind"], "done");
        }
        // Only the directory reads milestones here, so this counts directory loads.
        let reads: i64 = sqlx::query_scalar(
            "SELECT seq_scan+COALESCE(idx_scan,0) FROM pg_stat_xact_user_tables \
             WHERE relname='milestones'",
        )
        .fetch_one(&mut *op.tx)
        .await
        .unwrap();
        assert_eq!(reads, 1);

        op.tx.rollback().await.unwrap();
        store.pool.close().await;
        database.cleanup().await;
    }

    /// Moves three issues into a done stage in one bulk edit, with one webhook subscribed to
    /// everything, and returns the `issue.completed` deliveries and the directory loads.
    async fn bulk_complete(store: &Store, include_data: bool) -> (Vec<serde_json::Value>, i64) {
        let name = format!("bulk-{include_data}");
        let (workspace, actor, team) = import_workspace(store, &name).await;
        let issues: Vec<IssueInput> = (0..3)
            .map(|n| import_input(team, None, &format!("Bulk {n}")))
            .collect();
        for command in [
            Command::ImportIssues { issues },
            Command::CreateIntegration {
                id: None,
                name: "Everything".into(),
                webhook_url: "https://hooks.example.com/all".into(),
                secret: "bulk-complete-secret".into(),
                events: vec![],
                include_data,
            },
        ] {
            store
                .operation(workspace, actor, command, BTreeMap::new(), None, None)
                .await
                .unwrap();
        }
        let ids: Vec<IssueId> = sqlx::query_scalar("SELECT id FROM issues WHERE workspace_id=$1")
            .bind(workspace)
            .fetch_all(&store.pool)
            .await
            .unwrap();
        let done: Uuid =
            sqlx::query_scalar("SELECT id FROM stages WHERE team_id=$1 AND kind='done' LIMIT 1")
                .bind(team)
                .fetch_one(&store.pool)
                .await
                .unwrap();

        let mut op = store
            .begin_operation(workspace.0, actor, BTreeMap::new(), false)
            .await
            .unwrap();
        let before = milestone_reads(&mut op.tx).await;
        op.run_command(
            Command::BulkIssues {
                ids,
                action: BulkAction::Update(Box::new(IssuePatch {
                    stage_id: Some(done),
                    ..IssuePatch::default()
                })),
            },
            None,
        )
        .await
        .unwrap();
        let completed: Vec<serde_json::Value> = sqlx::query_scalar(
            "SELECT payload->'event' FROM jobs WHERE kind='webhook' \
             AND (payload->'event'->>'workspace_id')::uuid=$1 \
             AND payload->'event'->>'type'='issue.completed'",
        )
        .bind(workspace)
        .fetch_all(&mut *op.tx)
        .await
        .unwrap();
        let reads = milestone_reads(&mut op.tx).await - before;
        op.tx.rollback().await.unwrap();
        (completed, reads)
    }

    /// Only the directory reads `milestones` here, so this counts directory loads. The counter
    /// can include reads of earlier transactions on the same connection that Postgres has not
    /// flushed yet, so callers compare two readings.
    async fn milestone_reads(conn: &mut PgConnection) -> i64 {
        sqlx::query_scalar(
            "SELECT seq_scan+COALESCE(idx_scan,0) FROM pg_stat_xact_user_tables \
             WHERE relname='milestones'",
        )
        .fetch_one(conn)
        .await
        .unwrap()
    }

    #[tokio::test]
    async fn a_bulk_edit_reads_the_directory_once_and_only_for_data() {
        let database = TestDatabase::new().await;
        let store = Store::connect(&database.url).await.unwrap();

        let (completed, reads) = bulk_complete(&store, true).await;
        assert_eq!(completed.len(), 3, "{completed:?}");
        for event in &completed {
            assert_eq!(event["data"]["id"], event["entity_id"]);
            assert_eq!(event["data"]["stage"]["kind"], "done");
        }
        assert_eq!(reads, 1);

        let (completed, reads) = bulk_complete(&store, false).await;
        assert_eq!(completed.len(), 3, "{completed:?}");
        assert!(
            completed.iter().all(|e| e.get("data").is_none()),
            "{completed:?}"
        );
        assert_eq!(reads, 0);

        store.pool.close().await;
        database.cleanup().await;
    }
}
