//! One-way polling with overlapping incremental scans and periodic full discovery.
//! Each queue lease fetches at most one page.
use crate::{
    error::{Error, Result},
    http::Actor,
    jobs::Job,
    store::{Claim, NewJob, Outbox, Store},
};
use axum::{
    Json, Router,
    extract::{Path, State},
    http::StatusCode,
    routing::{get, post},
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{Acquire, PgConnection, Row};
use std::collections::{BTreeMap, BTreeSet};
use uuid::Uuid;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SyncJob {
    pub connection_id: Uuid,
    pub generation: i64,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Mapping {
    pub project_id: i64,
    pub team_id: Uuid,
    #[serde(default)]
    pub stage_mapping: BTreeMap<String, Uuid>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    pub name: Option<String>,
    pub base_url: Option<String>,
    pub token: Option<String>,
    pub enabled: Option<bool>,
    pub projects: Option<Vec<Mapping>>,
    pub people_mapping: Option<BTreeMap<String, Uuid>>,
}
#[derive(Serialize)]
pub struct Connection {
    pub id: Uuid,
    pub name: String,
    pub base_url: String,
    pub enabled: bool,
    pub generation: i64,
    pub projects: Vec<Mapping>,
    pub cached_projects: Value,
    pub cached_statuses: Value,
    pub cached_people: Value,
    pub people_mapping: BTreeMap<String, Uuid>,
    pub status: String,
    pub last_error: String,
    pub last_checked_at: Option<DateTime<Utc>>,
    pub last_synced_at: Option<DateTime<Utc>>,
}
mod discovery;
mod reconciliation;
mod scan;
mod transport;
use scan::{Checkpoint, PageData};
pub(crate) use transport::client as http_client;
const PUBLIC: &str = "id,name,base_url,enabled,generation,projects,cached_projects,cached_statuses,cached_people,people_mapping,status,last_error,last_checked_at,last_synced_at";
fn connection(row: sqlx::postgres::PgRow) -> Result<Connection> {
    Ok(Connection {
        id: row.try_get("id")?,
        name: row.try_get("name")?,
        base_url: row.try_get("base_url")?,
        enabled: row.try_get("enabled")?,
        generation: row.try_get("generation")?,
        projects: serde_json::from_value(row.try_get("projects")?)?,
        cached_projects: row.try_get("cached_projects")?,
        cached_statuses: row.try_get("cached_statuses")?,
        cached_people: row.try_get("cached_people")?,
        people_mapping: serde_json::from_value(row.try_get("people_mapping")?)?,
        status: row.try_get("status")?,
        last_error: row.try_get("last_error")?,
        last_checked_at: row.try_get("last_checked_at")?,
        last_synced_at: row.try_get("last_synced_at")?,
    })
}
pub fn router() -> Router<Store> {
    Router::new()
        .route(
            "/api/workspaces/{workspace}/openproject/connections",
            get(list).post(create),
        )
        .route(
            "/api/workspaces/{workspace}/openproject/connections/{id}",
            axum::routing::patch(update).delete(delete),
        )
        .route(
            "/api/workspaces/{workspace}/openproject/connections/{id}/refresh",
            post(refresh),
        )
        .route(
            "/api/workspaces/{workspace}/openproject/connections/{id}/sync",
            post(sync),
        )
}
async fn admin(conn: &mut PgConnection, workspace: Uuid, actor: Uuid) -> Result<()> {
    let role: Option<String> = sqlx::query_scalar(
        "SELECT role FROM workspace_members WHERE workspace_id=$1 AND user_id=$2 FOR SHARE",
    )
    .bind(workspace)
    .bind(actor)
    .fetch_optional(conn)
    .await?;
    if !matches!(role.as_deref(), Some("owner" | "admin")) {
        return Err(Error::Forbidden);
    }
    Ok(())
}
async fn list(
    State(store): State<Store>,
    actor: Actor,
    Path(workspace): Path<Uuid>,
) -> Result<Json<Value>> {
    let mut tx = store.pool.begin().await?;
    admin(&mut tx, workspace, actor.profile.id).await?;
    let rows = sqlx::query(&format!("SELECT {PUBLIC} FROM openproject_connections WHERE workspace_id=$1 AND NOT deleted ORDER BY name,id"))
        .bind(workspace).fetch_all(&mut *tx).await?;
    Ok(Json(
        json!({"connections": rows.into_iter().map(connection).collect::<Result<Vec<_>>>()?}),
    ))
}
fn validate_url(value: &str) -> Result<String> {
    let url = reqwest::Url::parse(value)
        .map_err(|_| Error::BadRequest("invalid OpenProject URL".into()))?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(Error::BadRequest(
            "OpenProject URL must be http(s) without credentials, query or fragment".into(),
        ));
    }
    if value.len() > 2000 {
        return Err(Error::BadRequest("OpenProject URL is too long".into()));
    }
    Ok(url.as_str().trim_end_matches('/').into())
}
async fn configure(
    store: Store,
    actor: Actor,
    workspace: Uuid,
    id: Option<Uuid>,
    config: Config,
) -> Result<Connection> {
    let mut tx = store.pool.begin().await?;
    admin(&mut tx, workspace, actor.profile.id).await?;
    let created = id.is_none();
    let id = match id {
        Some(id) => id,
        None => insert_connection(&mut tx, workspace, &config).await?,
    };
    let row = sqlx::query("SELECT name,base_url,token,enabled,projects,people_mapping,generation FROM openproject_connections WHERE workspace_id=$1 AND id=$2 AND NOT deleted FOR UPDATE")
        .bind(workspace).bind(id).fetch_optional(&mut *tx).await?.ok_or(Error::NotFound)?;
    let previous_name: String = row.try_get("name")?;
    let name = config.name.as_deref().unwrap_or(&previous_name);
    crate::domain::text(name, 200)?;
    let previous_url: String = row.try_get("base_url")?;
    let url = validate_url(config.base_url.as_deref().unwrap_or(&previous_url))?;
    if url != previous_url && has_imports(&mut tx, id).await? {
        return Err(Error::Conflict("OpenProject URL cannot change after import; create a new connection for another instance".into()));
    }
    let previous_token: String = row.try_get("token")?;
    let token = config.token.as_deref().unwrap_or(&previous_token);
    validate_token(token)?;
    let previous_projects: Vec<Mapping> = serde_json::from_value(row.try_get("projects")?)?;
    let projects = config.projects.as_ref().unwrap_or(&previous_projects);
    let projects_changed = projects != &previous_projects;
    if projects_changed {
        validate_project_mappings(&mut tx, workspace, projects).await?;
    }
    let previous_people: BTreeMap<String, Uuid> =
        serde_json::from_value(row.try_get("people_mapping")?)?;
    let people = match config.people_mapping {
        Some(people) => normalize_people_mapping(people)?,
        None => previous_people.clone(),
    };
    let people_changed = people != previous_people;
    if people_changed {
        validate_people_members(&mut tx, workspace, &people).await?;
    }
    let previous_enabled: bool = row.try_get("enabled")?;
    let enabled = config.enabled.unwrap_or(previous_enabled);
    let scan_changed = created
        || url != previous_url
        || token != previous_token
        || enabled != previous_enabled
        || projects_changed
        || people_changed;
    if scan_changed {
        let generation = row
            .try_get::<i64, _>("generation")?
            .checked_add(1)
            .ok_or_else(|| {
                Error::Conflict("OpenProject generation exhausted; create a new connection".into())
            })?;
        sqlx::query("UPDATE openproject_connections SET name=$3,base_url=$4,token=$5,enabled=$6,projects=$7,people_mapping=$9,generation=$10,checkpoint=$8,next_run_at=clock_timestamp(),status='pending',last_error='',incremental_supported=true WHERE workspace_id=$1 AND id=$2")
            .bind(workspace).bind(id).bind(name).bind(url).bind(token).bind(enabled).bind(json!(projects)).bind(json!(Checkpoint::default())).bind(json!(people)).bind(generation).execute(&mut *tx).await?;
        cancel_pending(&mut tx, id).await?;
    } else if name != previous_name {
        sqlx::query("UPDATE openproject_connections SET name=$3 WHERE workspace_id=$1 AND id=$2")
            .bind(workspace)
            .bind(id)
            .bind(name)
            .execute(&mut *tx)
            .await?;
    }
    let result = connection(
        sqlx::query(&format!(
            "SELECT {PUBLIC} FROM openproject_connections WHERE id=$1"
        ))
        .bind(id)
        .fetch_one(&mut *tx)
        .await?,
    )?;
    tx.commit().await?;
    tracing::debug!(connection_id = %id, workspace_id = %workspace, generation = result.generation,
        enabled, project_count = result.projects.len(), people_override_count = result.people_mapping.len(),
        "OpenProject configuration saved");
    Ok(result)
}

/// Inserts a new connection after checking the required fields and the
/// per-workspace limit. The caller validates and stores the rest.
async fn insert_connection(
    conn: &mut PgConnection,
    workspace: Uuid,
    config: &Config,
) -> Result<Uuid> {
    sqlx::query("SELECT id FROM workspaces WHERE id=$1 FOR UPDATE")
        .bind(workspace)
        .execute(&mut *conn)
        .await?;
    let required = |value: &Option<String>, field: &str| {
        value
            .clone()
            .ok_or_else(|| Error::BadRequest(format!("{field} is required")))
    };
    let name = required(&config.name, "name")?;
    let url = validate_url(&required(&config.base_url, "base_url")?)?;
    let token = required(&config.token, "token")?;
    let count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM openproject_connections WHERE workspace_id=$1 AND NOT deleted",
    )
    .bind(workspace)
    .fetch_one(&mut *conn)
    .await?;
    if count >= 20 {
        return Err(Error::BadRequest("connection limit reached".into()));
    }
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO openproject_connections(id,workspace_id,name,base_url,token) VALUES($1,$2,$3,$4,$5)")
        .bind(id).bind(workspace).bind(name).bind(url).bind(token).execute(&mut *conn).await?;
    Ok(id)
}

async fn has_imports(conn: &mut PgConnection, id: Uuid) -> Result<bool> {
    Ok(sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM issues WHERE openproject->>'connection_id'=$1)",
    )
    .bind(id.to_string())
    .fetch_one(conn)
    .await?)
}

fn validate_token(token: &str) -> Result<()> {
    if token.is_empty() || token.len() > 4096 || token.chars().any(char::is_control) {
        return Err(Error::BadRequest("invalid token".into()));
    }
    Ok(())
}

/// Each project maps once, to a workspace team with stages, and every
/// status maps to a stage of that team.
async fn validate_project_mappings(
    conn: &mut PgConnection,
    workspace: Uuid,
    projects: &[Mapping],
) -> Result<()> {
    if projects.len() > 100 {
        return Err(Error::BadRequest("at most 100 project mappings".into()));
    }
    let mut seen = BTreeSet::new();
    for mapping in projects {
        if mapping.project_id <= 0
            || !seen.insert(mapping.project_id)
            || mapping.stage_mapping.len() > 100
        {
            return Err(Error::BadRequest(
                "invalid or duplicate project mapping".into(),
            ));
        }
    }
    let teams: BTreeSet<Uuid> = projects.iter().map(|mapping| mapping.team_id).collect();
    let stages: BTreeSet<Uuid> = projects
        .iter()
        .flat_map(|mapping| mapping.stage_mapping.values().copied())
        .collect();
    let existing_teams: BTreeSet<Uuid> = sqlx::query_scalar(
        "SELECT DISTINCT team_id FROM stages WHERE workspace_id=$1 AND team_id=ANY($2)",
    )
    .bind(workspace)
    .bind(teams.into_iter().collect::<Vec<_>>())
    .fetch_all(&mut *conn)
    .await?
    .into_iter()
    .collect();
    let existing_stages: BTreeSet<(Uuid, Uuid)> =
        sqlx::query_as("SELECT team_id,id FROM stages WHERE workspace_id=$1 AND id=ANY($2)")
            .bind(workspace)
            .bind(stages.into_iter().collect::<Vec<_>>())
            .fetch_all(&mut *conn)
            .await?
            .into_iter()
            .collect();
    for mapping in projects {
        if !existing_teams.contains(&mapping.team_id) {
            return Err(Error::BadRequest(
                "team must belong to workspace and have stages".into(),
            ));
        }
        for (status, stage) in &mapping.stage_mapping {
            if status.parse::<i64>().ok().is_none_or(|id| id <= 0) {
                return Err(Error::BadRequest(
                    "status mapping keys must be positive IDs".into(),
                ));
            }
            if !existing_stages.contains(&(mapping.team_id, *stage)) {
                return Err(Error::BadRequest(
                    "mapped stage must belong to destination team".into(),
                ));
            }
        }
    }
    Ok(())
}

/// Lowercases and trims every email, rejecting malformed and duplicate ones.
fn normalize_people_mapping(people: BTreeMap<String, Uuid>) -> Result<BTreeMap<String, Uuid>> {
    if people.len() > 5000 {
        return Err(Error::BadRequest("at most 5000 people mappings".into()));
    }
    let mut normalized = BTreeMap::new();
    for (email, user) in people {
        let email = email.trim().to_lowercase();
        if !plausible_email(&email) || normalized.insert(email, user).is_some() {
            return Err(Error::BadRequest(
                "invalid or duplicate people mapping email".into(),
            ));
        }
    }
    Ok(normalized)
}

fn plausible_email(email: &str) -> bool {
    email.len() <= 254
        && email.split_once('@').is_some_and(|(local, host)| {
            !local.is_empty() && host.contains('.') && !host.starts_with('.')
        })
        && !email
            .chars()
            .any(|character| character.is_whitespace() || character.is_control())
}

async fn validate_people_members(
    conn: &mut PgConnection,
    workspace: Uuid,
    people: &BTreeMap<String, Uuid>,
) -> Result<()> {
    let users: BTreeSet<Uuid> = people.values().copied().collect();
    let members: BTreeSet<Uuid> = sqlx::query_scalar(
        "SELECT user_id FROM workspace_members WHERE workspace_id=$1 AND user_id=ANY($2)",
    )
    .bind(workspace)
    .bind(users.iter().copied().collect::<Vec<_>>())
    .fetch_all(&mut *conn)
    .await?
    .into_iter()
    .collect();
    if !users.is_subset(&members) {
        return Err(Error::BadRequest(
            "mapped person must belong to workspace".into(),
        ));
    }
    Ok(())
}
async fn create(
    State(store): State<Store>,
    actor: Actor,
    Path(workspace): Path<Uuid>,
    Json(config): Json<Config>,
) -> Result<(StatusCode, Json<Connection>)> {
    Ok((
        StatusCode::CREATED,
        Json(configure(store, actor, workspace, None, config).await?),
    ))
}
async fn update(
    State(store): State<Store>,
    actor: Actor,
    Path((workspace, id)): Path<(Uuid, Uuid)>,
    Json(config): Json<Config>,
) -> Result<Json<Connection>> {
    Ok(Json(
        configure(store, actor, workspace, Some(id), config).await?,
    ))
}
async fn delete(
    State(store): State<Store>,
    actor: Actor,
    Path((workspace, id)): Path<(Uuid, Uuid)>,
) -> Result<StatusCode> {
    let mut tx = store.pool.begin().await?;
    admin(&mut tx, workspace, actor.profile.id).await?;
    if sqlx::query("UPDATE openproject_connections SET deleted=true,enabled=false,token='',generation=generation+1 WHERE workspace_id=$1 AND id=$2 AND NOT deleted").bind(workspace).bind(id).execute(&mut *tx).await?.rows_affected() == 0 { return Err(Error::NotFound); }
    cancel_pending(&mut tx, id).await?;
    tx.commit().await?;
    tracing::debug!(connection_id = %id, workspace_id = %workspace, "OpenProject connection disconnected");
    Ok(StatusCode::NO_CONTENT)
}
async fn request(
    store: Store,
    actor: Actor,
    workspace: Uuid,
    id: Uuid,
    refresh_only: bool,
) -> Result<(StatusCode, Json<Value>)> {
    let mut tx = store.pool.begin().await?;
    admin(&mut tx, workspace, actor.profile.id).await?;
    let checkpoint = Checkpoint::new(refresh_only);
    if sqlx::query("UPDATE openproject_connections SET generation=generation+1,checkpoint=$3,next_run_at=clock_timestamp(),status='pending',last_error='',incremental_supported=CASE WHEN $4 THEN incremental_supported ELSE true END WHERE workspace_id=$1 AND id=$2 AND NOT deleted AND enabled")
        .bind(workspace).bind(id).bind(json!(checkpoint)).bind(refresh_only).execute(&mut *tx).await?.rows_affected()==0 { return Err(Error::BadRequest("connection missing or disabled".into())); }
    cancel_pending(&mut tx, id).await?;
    tx.commit().await?;
    tracing::debug!(connection_id = %id, workspace_id = %workspace, refresh_only, "OpenProject scan requested");
    Ok((StatusCode::ACCEPTED, Json(json!({"queued":true}))))
}
async fn refresh(
    State(store): State<Store>,
    actor: Actor,
    Path((workspace, id)): Path<(Uuid, Uuid)>,
) -> Result<(StatusCode, Json<Value>)> {
    request(store, actor, workspace, id, true).await
}
async fn sync(
    State(store): State<Store>,
    actor: Actor,
    Path((workspace, id)): Path<(Uuid, Uuid)>,
) -> Result<(StatusCode, Json<Value>)> {
    request(store, actor, workspace, id, false).await
}

async fn cancel_pending(conn: &mut PgConnection, id: Uuid) -> Result<()> {
    sqlx::query("UPDATE jobs SET state='cancelled',finished_at=clock_timestamp(),updated_at=clock_timestamp() WHERE queue='openproject' AND state='pending' AND payload->>'connection_id'=$1")
        .bind(id.to_string()).execute(conn).await?;
    Ok(())
}

/// Recreates scheduled work independently of terminal queue jobs and retry exhaustion.
pub async fn schedule(store: &Store) -> Result<()> {
    let mut tx = store.pool.begin().await?;
    let rows=sqlx::query("SELECT id,generation,status,checkpoint,poll_watermark,incremental_supported,jsonb_array_length(projects)>0 AS mapped,last_discovered_at IS NULL OR last_discovered_at<=clock_timestamp()-interval '30 minutes' AS discover,EXISTS(SELECT 1 FROM changes WHERE workspace_id=c.workspace_id AND entity IN ('members','teams') AND created_at>=c.poll_watermark) AS local_mapping_changed FROM openproject_connections c WHERE enabled AND NOT deleted AND next_run_at<=clock_timestamp() AND NOT EXISTS(SELECT 1 FROM jobs WHERE queue='openproject' AND payload->>'connection_id'=c.id::text AND state IN ('pending','running')) ORDER BY next_run_at,id FOR UPDATE OF c SKIP LOCKED LIMIT 100").fetch_all(&mut *tx).await?;
    let mut scheduled_count = 0;
    for row in rows {
        let id: Uuid = match row.try_get("id") {
            Ok(id) => id,
            // Defensive: id is the primary key and is needed to mark the row.
            Err(error) => {
                tracing::warn!(error = %error, "OpenProject scheduling skipped a connection");
                continue;
            }
        };
        match schedule_connection(&mut tx, id, &row).await {
            Ok(()) => scheduled_count += 1,
            Err(error) => mark_schedule_failure(&mut tx, id, &error).await,
        }
    }
    tx.commit().await?;
    if scheduled_count > 0 {
        tracing::debug!(scheduled_count, "OpenProject jobs scheduled");
    }
    Ok(())
}

/// Queues one sync job in a savepoint, so a bad row cannot abort the batch.
async fn schedule_connection(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    id: Uuid,
    row: &sqlx::postgres::PgRow,
) -> Result<()> {
    let mut savepoint = tx.begin().await?;
    let checkpoint = next_checkpoint(row)?;
    Outbox::insert(
        &mut savepoint,
        &NewJob::now(
            format!("openproject:{}", Uuid::new_v4()),
            Job::OpenProject(SyncJob {
                connection_id: id,
                generation: row.try_get("generation")?,
            }),
        )
        .max_attempts(3),
    )
    .await?;
    sqlx::query("UPDATE openproject_connections SET checkpoint=$2,next_run_at=clock_timestamp()+interval '5 minutes' WHERE id=$1").bind(id).bind(json!(checkpoint)).execute(&mut *savepoint).await?;
    savepoint.commit().await?;
    Ok(())
}

/// An idle connection at the start of a full scan polls work packages when
/// discovery is fresh, else rediscovers; any other checkpoint resumes as is.
fn next_checkpoint(row: &sqlx::postgres::PgRow) -> Result<Checkpoint> {
    let checkpoint: Checkpoint = serde_json::from_value(row.try_get("checkpoint")?)?;
    let at_start = matches!(&checkpoint, Checkpoint::Projects { cursor, refresh_only: false }
        if cursor.page == 1 && cursor.page_size.is_none() && cursor.started_at.is_none());
    if row.try_get::<String, _>("status")? != "idle" || !at_start {
        return Ok(checkpoint);
    }
    let now = Utc::now();
    if !row.try_get::<bool, _>("mapped")? || row.try_get::<bool, _>("discover")? {
        let mut checkpoint = Checkpoint::default();
        checkpoint.cursor_mut().started_at = Some(now);
        return Ok(checkpoint);
    }
    // Round the lower bound back two days to cover timestamp precision
    // and timezone differences. The checkpoint freezes the entire window.
    let incremental = row.try_get::<bool, _>("incremental_supported")?
        && !row.try_get::<bool, _>("local_mapping_changed")?;
    let watermark: Option<DateTime<Utc>> = row.try_get("poll_watermark")?;
    let cutoff = watermark
        .filter(|_| incremental)
        .and_then(|date| date.date_naive().checked_sub_days(chrono::Days::new(2)));
    Ok(Checkpoint::packages(now, cutoff))
}

async fn mark_schedule_failure(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    id: Uuid,
    error: &Error,
) {
    match error {
        Error::Json(_) => {
            tracing::warn!(connection_id = %id, "OpenProject scheduling failed for connection: invalid checkpoint")
        }
        _ => {
            tracing::warn!(connection_id = %id, error = %error, "OpenProject scheduling failed for connection")
        }
    }
    let marked: Result<()> = async {
        let mut savepoint = tx.begin().await?;
        sqlx::query("UPDATE openproject_connections SET status='error',last_error=$2,next_run_at=clock_timestamp()+interval '5 minutes' WHERE id=$1").bind(id).bind("OpenProject sync state is invalid; use Sync now to restart").execute(&mut *savepoint).await?;
        savepoint.commit().await?;
        Ok(())
    }
    .await;
    if let Err(error) = marked {
        tracing::warn!(connection_id = %id, error = %error, "OpenProject scheduling failed to mark connection error");
    }
}

#[tracing::instrument(name = "openproject_sync", level = "debug", skip_all,
    fields(connection_id = %job.connection_id, generation = job.generation, job_id = %claim.id))]
pub async fn execute(store: &Store, claim: &Claim, job: &SyncJob) -> Result<()> {
    let started = std::time::Instant::now();
    let row=sqlx::query("SELECT base_url,token,workspace_id,projects,checkpoint,CASE WHEN checkpoint->>'phase'='work_packages' THEN cached_people END AS people,CASE WHEN checkpoint->>'phase'='work_packages' THEN cached_statuses END AS statuses,CASE WHEN checkpoint->>'phase'='work_packages' THEN people_mapping END AS people_mapping FROM openproject_connections WHERE id=$1 AND generation=$2 AND enabled AND NOT deleted")
        .bind(job.connection_id).bind(job.generation).fetch_optional(&store.pool).await?;
    let Some(row) = row else {
        tracing::debug!("OpenProject job skipped: connection disabled, deleted or superseded");
        store.outbox.complete(claim).await?;
        return Ok(());
    };
    let base: String = row.try_get("base_url")?;
    let token: String = row.try_get("token")?;
    let workspace: Uuid = row.try_get("workspace_id")?;
    let mappings: Vec<Mapping> = serde_json::from_value(row.try_get("projects")?)?;
    let mut cp: Checkpoint = serde_json::from_value(row.try_get("checkpoint")?)?;
    cp.cursor_mut().started_at.get_or_insert_with(Utc::now);
    let (path, filters) = cp.request(&mappings)?;
    tracing::debug!(workspace_id = %workspace, resource = path, page = cp.cursor().page,
        project_count = mappings.len(), incremental = cp.cursor().updated_since.is_some(),
        "OpenProject page started");
    let http_started = std::time::Instant::now();
    let response = match transport::fetch(
        &store.openproject_client,
        &base,
        &token,
        path,
        cp.cursor().page,
        filters,
    )
    .await
    {
        Err(Error::Internal(message))
            if cp.cursor().updated_since.is_some()
                && matches!(
                    message.as_str(),
                    "OpenProject HTTP 400" | "OpenProject HTTP 422"
                ) =>
        {
            restart_unfiltered(store, claim, job, &cp).await?;
            return Ok(());
        }
        result => result?,
    };
    let http_ms = http_started.elapsed().as_millis();
    let normalize_started = std::time::Instant::now();
    let page = cp.normalize(response, &mappings).inspect_err(|_| {
        tracing::debug!(
            resource = path,
            page = cp.cursor().page,
            "OpenProject page normalization failed"
        );
    })?;
    let import_metadata = match &page.data {
        PageData::WorkPackages { .. } => Some(ImportMetadata::read(&row)?),
        _ => None,
    };
    let normalize_ms = normalize_started.elapsed().as_millis();
    let item_count = page.data.len();
    tracing::debug!(resource = path, page = cp.cursor().page, item_count, more = page.more,
        page_size = ?page.page_size, "OpenProject page normalized");
    let transition = cp.advance(&page, mappings.len())?;
    let pool_started = std::time::Instant::now();
    let mut tx = store.pool.begin().await?;
    let pool_ms = pool_started.elapsed().as_millis();
    sqlx::query(
        "SELECT set_config('lock_timeout','5s',true),set_config('statement_timeout','10s',true)",
    )
    .execute(&mut *tx)
    .await?;
    let connection_lock_started = std::time::Instant::now();
    let current: Option<Uuid> = sqlx::query_scalar("SELECT id FROM openproject_connections WHERE id=$1 AND generation=$2 AND enabled AND NOT deleted AND EXISTS(SELECT 1 FROM jobs WHERE id=$3 AND claim_token=$4 AND state='running' AND lease_expires_at>clock_timestamp()) FOR UPDATE")
        .bind(job.connection_id).bind(job.generation).bind(claim.id).bind(claim.token)
        .fetch_optional(&mut *tx).await?;
    let connection_lock_ms = connection_lock_started.elapsed().as_millis();
    if current.is_none() {
        tracing::debug!("OpenProject page discarded: lease lost or configuration superseded");
        Outbox::complete_in(&mut tx, claim).await?;
        tx.commit().await?;
        return Ok(());
    }
    let reconcile_started = std::time::Instant::now();
    let lock_ms = match &page.data {
        PageData::Projects(items) => {
            discovery::save(&mut tx, job, path, cp.cursor().page, page.more, items).await?;
            0
        }
        PageData::Statuses(items) => {
            discovery::save(&mut tx, job, path, cp.cursor().page, page.more, items).await?;
            0
        }
        PageData::People(items) => {
            discovery::save(&mut tx, job, path, cp.cursor().page, page.more, items).await?;
            0
        }
        PageData::WorkPackages { mapping, items } => {
            let metadata = import_metadata
                .as_ref()
                .ok_or_else(|| Error::Internal("missing OpenProject import metadata".into()))?;
            import_work_packages(&mut tx, job, workspace, &base, mapping, metadata, items).await?
        }
    };
    let reconcile_ms = reconcile_started
        .elapsed()
        .as_millis()
        .saturating_sub(lock_ms);
    let finished = transition.next.is_none();
    let discovered = matches!(&page.data, PageData::People(_)) && !page.more;
    sqlx::query("UPDATE openproject_connections SET checkpoint=$3,next_run_at=CASE WHEN NOT $4 THEN clock_timestamp() WHEN $5 THEN clock_timestamp()+interval '30 minutes' ELSE GREATEST(clock_timestamp()+interval '30 seconds',$6::timestamptz+interval '5 minutes') END,status=$7,last_error='',last_checked_at=CASE WHEN $8 THEN clock_timestamp() ELSE last_checked_at END,last_synced_at=CASE WHEN $4 AND NOT $9 THEN clock_timestamp() ELSE last_synced_at END,poll_watermark=CASE WHEN $4 AND NOT $9 THEN $6 WHEN $4 AND $9 THEN NULL ELSE poll_watermark END,last_discovered_at=CASE WHEN $10 THEN clock_timestamp() ELSE last_discovered_at END WHERE id=$1 AND generation=$2")
        .bind(job.connection_id).bind(job.generation).bind(json!(transition.next.unwrap_or_default()))
        .bind(finished).bind(mappings.is_empty()).bind(cp.cursor().started_at)
        .bind(if finished {"idle"} else {"syncing"}).bind(transition.checked).bind(transition.refresh_only)
        .bind(discovered).execute(&mut *tx).await?;
    if Outbox::complete_in(&mut tx, claim).await? {
        tx.commit().await?;
        tracing::debug!(
            resource = path,
            page = cp.cursor().page,
            item_count,
            finished,
            refresh_only = transition.refresh_only,
            http_ms,
            normalize_ms,
            pool_ms,
            connection_lock_ms,
            lock_ms,
            reconcile_ms,
            elapsed_ms = started.elapsed().as_millis(),
            "OpenProject page committed"
        );
    } else {
        tracing::debug!("OpenProject page rolled back: job completion lost ownership");
    }
    Ok(())
}

/// Cached discovery results a work package page maps against.
struct ImportMetadata {
    people: Vec<scan::Person>,
    people_mapping: BTreeMap<String, Uuid>,
    statuses: Vec<scan::Status>,
}

impl ImportMetadata {
    fn read(row: &sqlx::postgres::PgRow) -> Result<Self> {
        Ok(Self {
            people: serde_json::from_value(row.try_get("people")?)?,
            people_mapping: serde_json::from_value(row.try_get("people_mapping")?)?,
            statuses: serde_json::from_value(row.try_get("statuses")?)?,
        })
    }
}

/// Takes the workspace locks and reconciles the page. Returns the time spent
/// waiting for the locks, in milliseconds.
async fn import_work_packages(
    conn: &mut PgConnection,
    job: &SyncJob,
    workspace: Uuid,
    base: &str,
    mapping: &Mapping,
    metadata: &ImportMetadata,
    items: &[scan::WorkPackage],
) -> Result<u128> {
    let lock_started = std::time::Instant::now();
    // Keep authorization-before-graph lock ordering identical to interactive writes.
    sqlx::query("SELECT pg_advisory_xact_lock_shared(hashtextextended($1,74103))")
        .bind(workspace.to_string())
        .execute(&mut *conn)
        .await?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,41827))")
        .bind(workspace.to_string())
        .execute(&mut *conn)
        .await?;
    let lock_ms = lock_started.elapsed().as_millis();
    sqlx::query("SELECT set_config('blackwall.openproject_sync','on',true)")
        .execute(&mut *conn)
        .await?;
    reconciliation::apply_page(
        conn,
        reconciliation::PageImport {
            workspace,
            connection: job.connection_id,
            base,
            mapping,
            statuses: &metadata.statuses,
            people: &metadata.people,
            people_mapping: &metadata.people_mapping,
        },
        items,
    )
    .await
    .inspect_err(|_| {
        tracing::debug!("OpenProject work package reconciliation failed; page will roll back");
    })?;
    Ok(lock_ms)
}

async fn restart_unfiltered(
    store: &Store,
    claim: &Claim,
    job: &SyncJob,
    cp: &Checkpoint,
) -> Result<()> {
    let mut tx = store.pool.begin().await?;
    let changed = sqlx::query("UPDATE openproject_connections SET incremental_supported=false,checkpoint=$3,status='syncing',next_run_at=clock_timestamp() WHERE id=$1 AND generation=$2 AND enabled AND NOT deleted AND EXISTS(SELECT 1 FROM jobs WHERE id=$4 AND claim_token=$5 AND state='running' AND lease_expires_at>clock_timestamp())")
        .bind(job.connection_id).bind(job.generation).bind(json!(cp.full_scan())).bind(claim.id).bind(claim.token)
        .execute(&mut *tx).await?.rows_affected() == 1;
    if Outbox::complete_in(&mut tx, claim).await? {
        tx.commit().await?;
        tracing::debug!(
            changed,
            "OpenProject date filter rejected; restarting an unfiltered scan"
        );
    }
    Ok(())
}

/// Only our own static messages or numeric HTTP statuses reach status metadata.
pub fn failure_message(error: &Error) -> String {
    match error {
        Error::Internal(message) if message.starts_with("OpenProject HTTP ") => {
            match message.as_str() {
                "OpenProject HTTP 401" => {
                    "OpenProject authentication failed (401); check the API token".into()
                }
                "OpenProject HTTP 403" => {
                    "OpenProject permission denied (403); check project access".into()
                }
                _ => message.clone(),
            }
        }
        Error::Internal(message) | Error::BadRequest(message) | Error::Conflict(message) => {
            message.clone()
        }
        _ => "OpenProject database write failed; check destination team/stage configuration".into(),
    }
}
pub async fn record_failure(
    store: &Store,
    claim: &Claim,
    job: &SyncJob,
    message: &str,
) -> Result<()> {
    let mut tx = store.pool.begin().await?;
    let current: Option<Uuid> = sqlx::query_scalar("SELECT id FROM openproject_connections WHERE id=$1 AND generation=$2 AND NOT deleted FOR UPDATE")
        .bind(job.connection_id).bind(job.generation).fetch_optional(&mut *tx).await?;
    let mut recorded = false;
    if current.is_some() {
        let owned: Option<i32> = sqlx::query_scalar("SELECT 1 FROM jobs WHERE id=$1 AND claim_token=$2 AND state='running' AND lease_expires_at>clock_timestamp() FOR SHARE")
            .bind(claim.id).bind(claim.token).fetch_optional(&mut *tx).await?;
        if owned.is_some() {
            recorded = sqlx::query("UPDATE openproject_connections SET status='error',last_error=$3,next_run_at=LEAST(next_run_at,clock_timestamp()+interval '5 minutes') WHERE id=$1 AND generation=$2 AND NOT deleted")
                .bind(job.connection_id).bind(job.generation).bind(message).execute(&mut *tx).await?.rows_affected() > 0;
        }
    }
    tx.commit().await?;
    tracing::debug!(connection_id = %job.connection_id, generation = job.generation,
        recorded, "OpenProject scan failure recorded");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pagination_respects_reported_size_and_unpaginated_discovery() {
        let page = json!({"total":3,"count":1,"pageSize":1,"offset":1,"_embedded":{"elements":[{"id":1}]}});
        assert!(scan::elements(&page, 1).unwrap().1);
        assert!(scan::elements(&page, 2).is_err());
        let last = json!({"total":3,"count":1,"pageSize":1,"offset":3,"_embedded":{"elements":[{"id":3}]}});
        assert!(!scan::elements(&last, 3).unwrap().1);
        let statuses =
            json!({"total":70,"count":70,"_embedded":{"elements":vec![json!({"id":1});70]}});
        assert_eq!(scan::elements(&statuses, 1).unwrap().0.len(), 70);
        assert!(scan::elements(&statuses, 2).is_err());
    }

    #[test]
    fn malformed_or_short_intermediate_pages_are_not_checkpoints() {
        for page in [
            json!({"total":10,"pageSize":2,"offset":1,"_embedded":{"elements":[]}}),
            json!({"total":10,"pageSize":2,"offset":1,"_embedded":{"elements":[{}]}}),
            json!({"total":10,"_embedded":{"elements":[{}]}}),
            json!({"total":1,"count":2,"_embedded":{"elements":[{}]}}),
            json!({"total":100,"pageSize":51,"offset":1,"_embedded":{"elements":[]}}),
        ] {
            assert!(scan::elements(&page, 1).is_err());
        }
    }

    #[test]
    fn private_endpoints_are_allowed_but_credentials_and_redirect_inputs_are_not() {
        assert_eq!(
            validate_url("http://127.0.0.1:8080/openproject/").unwrap(),
            "http://127.0.0.1:8080/openproject"
        );
        assert!(validate_url("https://internal.example/").is_ok());
        for url in [
            "file:///etc/passwd",
            "https://apikey:secret@example.com",
            "https://example.com/?token=secret",
            "https://example.com/#secret",
        ] {
            assert!(validate_url(url).is_err());
        }
    }

    #[test]
    fn jobs_are_credential_free_and_failures_actionable() {
        let job = Job::OpenProject(SyncJob {
            connection_id: Uuid::nil(),
            generation: 4,
        });
        let payload = job.payload().unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&payload).unwrap(),
            json!({"connection_id":Uuid::nil(),"generation":4})
        );
        assert_eq!(job.queue(), "openproject");
        assert!(matches!(
            Job::decode("openproject", &payload).unwrap(),
            Job::OpenProject(_)
        ));
        assert!(
            failure_message(&Error::Internal("OpenProject HTTP 401".into()))
                .contains("check the API token")
        );
    }
}
