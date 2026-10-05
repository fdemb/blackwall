//! One-way, full paginated polling. Each queue lease fetches at most one page.
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
use sqlx::{PgConnection, Row};
use std::{
    collections::{BTreeMap, BTreeSet},
    time::Duration,
};
use uuid::Uuid;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SyncJob {
    pub connection_id: Uuid,
    pub generation: i64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
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
    pub status: String,
    pub last_error: String,
    pub last_checked_at: Option<DateTime<Utc>>,
    pub last_synced_at: Option<DateTime<Utc>>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
struct Checkpoint {
    phase: String,
    page: i64,
    project_index: usize,
    refresh_only: bool,
    #[serde(default)]
    page_size: Option<i64>,
}
impl Default for Checkpoint {
    fn default() -> Self {
        Self {
            phase: "projects".into(),
            page: 1,
            project_index: 0,
            refresh_only: false,
            page_size: None,
        }
    }
}
const PUBLIC: &str = "id,name,base_url,enabled,generation,projects,cached_projects,cached_statuses,status,last_error,last_checked_at,last_synced_at";
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
    let id = match id {
        Some(id) => id,
        None => {
            sqlx::query("SELECT id FROM workspaces WHERE id=$1 FOR UPDATE")
                .bind(workspace)
                .execute(&mut *tx)
                .await?;
            let name = config
                .name
                .as_deref()
                .ok_or_else(|| Error::BadRequest("name is required".into()))?;
            let url = validate_url(
                config
                    .base_url
                    .as_deref()
                    .ok_or_else(|| Error::BadRequest("base_url is required".into()))?,
            )?;
            let token = config
                .token
                .as_deref()
                .ok_or_else(|| Error::BadRequest("token is required".into()))?;
            let count: i64 = sqlx::query_scalar("SELECT count(*) FROM openproject_connections WHERE workspace_id=$1 AND NOT deleted").bind(workspace).fetch_one(&mut *tx).await?;
            if count >= 20 {
                return Err(Error::BadRequest("connection limit reached".into()));
            }
            let id = Uuid::new_v4();
            sqlx::query("INSERT INTO openproject_connections(id,workspace_id,name,base_url,token) VALUES($1,$2,$3,$4,$5)")
                .bind(id).bind(workspace).bind(name).bind(url).bind(token).execute(&mut *tx).await?;
            id
        }
    };
    let row = sqlx::query("SELECT * FROM openproject_connections WHERE workspace_id=$1 AND id=$2 AND NOT deleted FOR UPDATE")
        .bind(workspace).bind(id).fetch_optional(&mut *tx).await?.ok_or(Error::NotFound)?;
    let name = config.name.unwrap_or(row.try_get("name")?);
    crate::domain::text(&name, 200)?;
    let previous_url: String = row.try_get("base_url")?;
    let url = validate_url(&config.base_url.unwrap_or(previous_url.clone()))?;
    if url != previous_url {
        let imported: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM issues WHERE openproject->>'connection_id'=$1)",
        )
        .bind(id.to_string())
        .fetch_one(&mut *tx)
        .await?;
        if imported {
            return Err(Error::Conflict("OpenProject URL cannot change after import; create a new connection for another instance".into()));
        }
    }
    let token = config.token.unwrap_or(row.try_get("token")?);
    if token.is_empty() || token.len() > 4096 || token.chars().any(char::is_control) {
        return Err(Error::BadRequest("invalid token".into()));
    }
    let projects: Vec<Mapping> = config
        .projects
        .unwrap_or(serde_json::from_value(row.try_get("projects")?)?);
    if projects.len() > 100 {
        return Err(Error::BadRequest("at most 100 project mappings".into()));
    }
    let mut seen = BTreeSet::new();
    for mapping in &projects {
        if mapping.project_id <= 0
            || !seen.insert(mapping.project_id)
            || mapping.stage_mapping.len() > 100
        {
            return Err(Error::BadRequest(
                "invalid or duplicate project mapping".into(),
            ));
        }
        let exists: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM stages WHERE workspace_id=$1 AND team_id=$2)",
        )
        .bind(workspace)
        .bind(mapping.team_id)
        .fetch_one(&mut *tx)
        .await?;
        if !exists {
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
            let exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM stages WHERE workspace_id=$1 AND team_id=$2 AND id=$3)").bind(workspace).bind(mapping.team_id).bind(stage).fetch_one(&mut *tx).await?;
            if !exists {
                return Err(Error::BadRequest(
                    "mapped stage must belong to destination team".into(),
                ));
            }
        }
    }
    let enabled = config.enabled.unwrap_or(row.try_get("enabled")?);
    sqlx::query("UPDATE openproject_connections SET name=$3,base_url=$4,token=$5,enabled=$6,projects=$7,generation=generation+1,checkpoint=$8,next_run_at=clock_timestamp(),status='pending',last_error='' WHERE workspace_id=$1 AND id=$2")
        .bind(workspace).bind(id).bind(name).bind(url).bind(token).bind(enabled).bind(json!(projects)).bind(json!(Checkpoint::default())).execute(&mut *tx).await?;
    cancel_pending(&mut tx, id).await?;
    let result = connection(
        sqlx::query(&format!(
            "SELECT {PUBLIC} FROM openproject_connections WHERE id=$1"
        ))
        .bind(id)
        .fetch_one(&mut *tx)
        .await?,
    )?;
    tx.commit().await?;
    store.outbox.ready();
    Ok(result)
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
    let checkpoint = Checkpoint {
        refresh_only,
        ..Default::default()
    };
    if sqlx::query("UPDATE openproject_connections SET generation=generation+1,checkpoint=$3,next_run_at=clock_timestamp(),status='pending',last_error='' WHERE workspace_id=$1 AND id=$2 AND NOT deleted AND enabled")
        .bind(workspace).bind(id).bind(json!(checkpoint)).execute(&mut *tx).await?.rows_affected()==0 { return Err(Error::BadRequest("connection missing or disabled".into())); }
    cancel_pending(&mut tx, id).await?;
    tx.commit().await?;
    store.outbox.ready();
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
    let rows=sqlx::query("SELECT id,generation FROM openproject_connections c WHERE enabled AND NOT deleted AND next_run_at<=clock_timestamp() AND NOT EXISTS(SELECT 1 FROM jobs WHERE queue='openproject' AND payload->>'connection_id'=c.id::text AND state IN ('pending','running')) ORDER BY next_run_at,id FOR UPDATE SKIP LOCKED LIMIT 100").fetch_all(&mut *tx).await?;
    for row in rows {
        let id: Uuid = row.try_get("id")?;
        Outbox::insert(
            &mut tx,
            &NewJob::now(
                format!("openproject:{}", Uuid::new_v4()),
                Job::OpenProject(SyncJob {
                    connection_id: id,
                    generation: row.try_get("generation")?,
                }),
            ),
        )
        .await?;
        sqlx::query("UPDATE jobs SET max_attempts=3 WHERE queue='openproject' AND payload->>'connection_id'=$1 AND state='pending'").bind(id.to_string()).execute(&mut *tx).await?;
        sqlx::query("UPDATE openproject_connections SET next_run_at=clock_timestamp()+interval '5 minutes' WHERE id=$1").bind(id).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    Ok(())
}

async fn fetch(
    base: &str,
    token: &str,
    path: &str,
    page: i64,
    filters: Option<Value>,
) -> Result<Value> {
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(20))
        .connect_timeout(Duration::from_secs(5))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| Error::Internal("OpenProject client failed".into()))?;
    let mut req = client
        .get(format!("{base}/api/v3/{path}"))
        .basic_auth("apikey", Some(token))
        .query(&[("pageSize", "50".to_owned()), ("offset", page.to_string())]);
    if let Some(filters) = filters {
        req = req.query(&[
            ("filters", filters.to_string()),
            ("sortBy", json!([["id", "asc"]]).to_string()),
        ]);
    }
    let mut response = req
        .send()
        .await
        .map_err(|_| Error::Internal("OpenProject request failed".into()))?;
    if !response.status().is_success() {
        return Err(Error::Internal(format!(
            "OpenProject HTTP {}",
            response.status().as_u16()
        )));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| Error::Internal("OpenProject body failed".into()))?
    {
        if bytes.len() + chunk.len() > 2 * 1024 * 1024 {
            return Err(Error::Internal("OpenProject page exceeds 2 MiB".into()));
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes)
        .map_err(|_| Error::Internal("OpenProject returned invalid JSON".into()))
}
fn elements(value: &Value, page: i64) -> Result<(Vec<Value>, bool)> {
    let items = value
        .pointer("/_embedded/elements")
        .and_then(Value::as_array)
        .ok_or_else(|| Error::Internal("invalid OpenProject collection".into()))?;
    let total = value
        .get("total")
        .and_then(Value::as_i64)
        .ok_or_else(|| Error::Internal("missing OpenProject total".into()))?;
    if total < 0
        || items.len() > 5000
        || value
            .get("count")
            .and_then(Value::as_u64)
            .is_some_and(|count| count != items.len() as u64)
    {
        return Err(Error::Internal(
            "invalid OpenProject collection count".into(),
        ));
    }
    let more = match value.get("pageSize").and_then(Value::as_i64) {
        Some(size) => {
            if !(1..=50).contains(&size)
                || items.len() as i64 > size
                || value.get("offset").and_then(Value::as_i64) != Some(page)
            {
                return Err(Error::Internal("invalid OpenProject pagination".into()));
            }
            page * size < total
        }
        None => {
            if page != 1 || total != items.len() as i64 {
                return Err(Error::Internal(
                    "incomplete unpaginated OpenProject collection".into(),
                ));
            }
            false
        }
    };
    if more && value.get("pageSize").and_then(Value::as_u64) != Some(items.len() as u64) {
        return Err(Error::Internal(
            "empty OpenProject page with continuation".into(),
        ));
    }
    Ok((items.clone(), more))
}
fn link_id(value: &Value, kind: &str) -> Option<i64> {
    value
        .pointer(&format!("/_links/{kind}/href"))?
        .as_str()?
        .rsplit('/')
        .next()?
        .parse()
        .ok()
}

pub async fn execute(store: &Store, claim: &Claim, job: &SyncJob) -> Result<()> {
    let row=sqlx::query("SELECT * FROM openproject_connections WHERE id=$1 AND generation=$2 AND enabled AND NOT deleted").bind(job.connection_id).bind(job.generation).fetch_optional(&store.pool).await?;
    let Some(row) = row else {
        store.outbox.complete(claim).await?;
        return Ok(());
    };
    let base: String = row.try_get("base_url")?;
    let token: String = row.try_get("token")?;
    let workspace: Uuid = row.try_get("workspace_id")?;
    let mappings: Vec<Mapping> = serde_json::from_value(row.try_get("projects")?)?;
    let mut cp: Checkpoint = serde_json::from_value(row.try_get("checkpoint")?)?;
    if cp.page < 1 || cp.page > 1000 {
        return Err(Error::Internal("OpenProject page limit reached".into()));
    }
    let (path, filters) = match cp.phase.as_str() {
        "projects" => ("projects", None),
        "statuses" => ("statuses", None),
        "work_packages" => {
            if let Some(mapping) = mappings.get(cp.project_index) {
                (
                    "work_packages",
                    Some(
                        json!([{"project":{"operator":"=","values":[mapping.project_id.to_string()]}}]),
                    ),
                )
            } else {
                ("work_packages", None)
            }
        }
        _ => return Err(Error::Internal("invalid OpenProject checkpoint".into())),
    };
    let skip = cp.phase == "work_packages" && cp.project_index >= mappings.len();
    let (items, more) = if skip {
        (vec![], false)
    } else {
        let response = fetch(&base, &token, path, cp.page, filters).await?;
        let reported_size = response.get("pageSize").and_then(Value::as_i64);
        if cp.page > 1 && cp.page_size != reported_size {
            return Err(Error::Internal(
                "OpenProject page size changed during scan; run sync now to restart".into(),
            ));
        }
        cp.page_size = reported_size;
        elements(&response, cp.page)?
    };
    if cp.phase == "work_packages" && items.len() > 50 {
        return Err(Error::Internal(
            "OpenProject work package page exceeds 50 items".into(),
        ));
    }
    let mut tx = store.pool.begin().await?;
    sqlx::query("SET LOCAL lock_timeout='5s'")
        .execute(&mut *tx)
        .await?;
    sqlx::query("SET LOCAL statement_timeout='10s'")
        .execute(&mut *tx)
        .await?;
    let owned:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM jobs WHERE id=$1 AND claim_token=$2 AND state='running' AND lease_expires_at>clock_timestamp())").bind(claim.id).bind(claim.token).fetch_one(&mut *tx).await?;
    let current=sqlx::query("SELECT cached_projects,cached_statuses FROM openproject_connections WHERE id=$1 AND generation=$2 AND enabled AND NOT deleted FOR UPDATE").bind(job.connection_id).bind(job.generation).fetch_optional(&mut *tx).await?;
    if !owned || current.is_none() {
        Outbox::complete_in(&mut tx, claim).await?;
        tx.commit().await?;
        return Ok(());
    }
    let current = current.unwrap();
    let mut cached_projects: Value = current.try_get("cached_projects")?;
    let mut cached_statuses: Value = current.try_get("cached_statuses")?;
    if cp.phase == "projects" || cp.phase == "statuses" {
        let cache = if cp.phase == "projects" {
            &mut cached_projects
        } else {
            &mut cached_statuses
        };
        if cp.page == 1 {
            *cache = json!([]);
        }
        let entries = cache
            .as_array_mut()
            .ok_or_else(|| Error::Internal("invalid cache".into()))?;
        for item in &items {
            let id = item
                .get("id")
                .and_then(Value::as_i64)
                .ok_or_else(|| Error::Internal("missing OpenProject ID".into()))?;
            let name = item
                .get("name")
                .and_then(Value::as_str)
                .ok_or_else(|| Error::Internal("missing OpenProject name".into()))?;
            entries.push(if cp.phase=="statuses" {json!({"id":id,"name":name,"is_closed":item.get("isClosed").and_then(Value::as_bool).unwrap_or(false)})} else {json!({"id":id,"name":name})});
        }
        if entries.len() > 5000 {
            return Err(Error::Internal(
                "OpenProject discovery limit reached".into(),
            ));
        }
    } else {
        sqlx::query("SELECT set_config('blackwall.openproject_sync','on',true)")
            .execute(&mut *tx)
            .await?;
        let mut import = PageImport {
            workspace,
            connection: job.connection_id,
            base: &base,
            mappings: &mappings,
            statuses: &cached_statuses,
            issue_count: None,
        };
        for item in &items {
            apply(&mut tx, &mut import, item).await?;
        }
    }
    let mut finished = false;
    if more {
        cp.page += 1;
    } else {
        cp.page = 1;
        cp.page_size = None;
        match cp.phase.as_str() {
            "projects" => cp.phase = "statuses".into(),
            "statuses" => {
                if cp.refresh_only {
                    finished = true;
                } else {
                    cp.phase = "work_packages".into();
                }
            }
            _ => {
                cp.project_index += 1;
                finished = cp.project_index >= mappings.len();
            }
        }
    }
    let checked = cp.phase == "work_packages" || cp.refresh_only && finished;
    sqlx::query("UPDATE openproject_connections SET cached_projects=$3,cached_statuses=$4,checkpoint=$5,next_run_at=clock_timestamp()+CASE WHEN $6 THEN interval '5 minutes' ELSE interval '0 seconds' END,status=$7,last_error='',last_checked_at=CASE WHEN $8 THEN clock_timestamp() ELSE last_checked_at END,last_synced_at=CASE WHEN $6 AND NOT $9 THEN clock_timestamp() ELSE last_synced_at END WHERE id=$1 AND generation=$2")
        .bind(job.connection_id).bind(job.generation).bind(cached_projects).bind(cached_statuses).bind(if finished {json!(Checkpoint::default())}else{json!(cp)}).bind(finished).bind(if finished {"idle"} else {"syncing"}).bind(checked).bind(cp.refresh_only).execute(&mut *tx).await?;
    if Outbox::complete_in(&mut tx, claim).await? {
        tx.commit().await?;
    }
    Ok(())
}

struct PageImport<'a> {
    workspace: Uuid,
    connection: Uuid,
    base: &'a str,
    mappings: &'a [Mapping],
    statuses: &'a Value,
    issue_count: Option<i64>,
}

async fn apply(conn: &mut PgConnection, import: &mut PageImport<'_>, item: &Value) -> Result<()> {
    let workspace = import.workspace;
    let connection = import.connection;
    let base = import.base;
    let mappings = import.mappings;
    let statuses = import.statuses;
    let issue_count = &mut import.issue_count;
    let id = item
        .get("id")
        .and_then(Value::as_i64)
        .filter(|id| *id > 0)
        .ok_or_else(|| Error::Internal("invalid work package ID".into()))?;
    let project = link_id(item, "project")
        .ok_or_else(|| Error::Internal("missing work package project".into()))?;
    let Some(mapping) = mappings
        .iter()
        .find(|mapping| mapping.project_id == project)
    else {
        return Err(Error::Internal(
            "work package outside configured projects".into(),
        ));
    };
    let title = item
        .get("subject")
        .and_then(Value::as_str)
        .ok_or_else(|| Error::Internal("missing work package subject".into()))?;
    crate::domain::text(title, 500)?;
    let description = item
        .pointer("/description/raw")
        .and_then(Value::as_str)
        .unwrap_or("");
    if description.len() > 100_000 {
        return Err(Error::Internal("work package description too large".into()));
    }
    let status_id = link_id(item, "status")
        .ok_or_else(|| Error::Internal("missing work package status".into()))?;
    let status = statuses.as_array().and_then(|statuses| {
        statuses
            .iter()
            .find(|status| status["id"].as_i64() == Some(status_id))
    });
    let status_name = status
        .and_then(|status| status["name"].as_str())
        .or_else(|| item.pointer("/_links/status/title").and_then(Value::as_str))
        .unwrap_or("Unknown");
    let closed = status
        .and_then(|status| status["is_closed"].as_bool())
        .unwrap_or(false);
    let stage = if let Some(stage) = mapping.stage_mapping.get(&status_id.to_string()) {
        *stage
    } else {
        sqlx::query_scalar("SELECT id FROM stages WHERE workspace_id=$1 AND team_id=$2 ORDER BY (lower(name)=lower($3)) DESC,(kind=$4) DESC,position,id LIMIT 1").bind(workspace).bind(mapping.team_id).bind(status_name).bind(if closed {"done"}else{"backlog"}).fetch_optional(&mut *conn).await?.ok_or_else(||Error::Internal("destination team has no stage".into()))?
    };
    let stage_exists: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM stages WHERE workspace_id=$1 AND team_id=$2 AND id=$3)",
    )
    .bind(workspace)
    .bind(mapping.team_id)
    .bind(stage)
    .fetch_one(&mut *conn)
    .await?;
    if !stage_exists {
        return Err(Error::BadRequest(
            "OpenProject mapped stage no longer exists; update project stage mapping".into(),
        ));
    }
    let url = format!("{base}/work_packages/{id}");
    let metadata = json!({"connection_id":connection,"work_package_id":id,"project_id":project,"status_name":status_name,"url":url,"unavailable":false});
    let priority = match item
        .pointer("/_links/priority/title")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "low" => "low",
        "normal" => "normal",
        "high" => "high",
        "urgent" | "immediate" => "urgent",
        _ => "none",
    };
    let deadline = item
        .get("dueDate")
        .and_then(Value::as_str)
        .map(|date| {
            chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d")
                .map(|date| date.and_hms_opt(0, 0, 0).unwrap().and_utc())
        })
        .transpose()
        .map_err(|_| Error::Internal("invalid work package due date".into()))?;
    let existing:Option<Uuid>=sqlx::query_scalar("SELECT id FROM issues WHERE openproject->>'connection_id'=$1 AND openproject->>'work_package_id'=$2 FOR UPDATE").bind(connection.to_string()).bind(id.to_string()).fetch_optional(&mut *conn).await?;
    let issue = if let Some(issue) = existing {
        sqlx::query("UPDATE issues SET title=$2,description=$3,team_id=$4,stage_id=$5,priority=$6,deadline=$7,openproject=$8,version=version+1,updated_at=clock_timestamp(),project_id=NULL,milestone_id=NULL,sprint_id=NULL WHERE id=$1 AND (title,description,team_id,stage_id,priority,deadline,openproject) IS DISTINCT FROM ($2,$3,$4,$5,$6,$7,$8)")
            .bind(issue).bind(title).bind(description).bind(mapping.team_id).bind(stage).bind(priority).bind(deadline).bind(&metadata).execute(&mut *conn).await?;
        issue
    } else {
        if issue_count.is_none() {
            sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,30269))")
                .bind(format!("{workspace}:issues"))
                .execute(&mut *conn)
                .await?;
            *issue_count = Some(
                sqlx::query_scalar("SELECT count(*) FROM issues WHERE workspace_id=$1")
                    .bind(workspace)
                    .fetch_one(&mut *conn)
                    .await?,
            );
        }
        if issue_count.is_some_and(|count| count >= 5000) {
            return Err(Error::BadRequest("OpenProject import stopped: workspace issue capacity reached (5000); reduce project mappings. Existing issues remain unchanged".into()));
        }
        let number:i64=sqlx::query_scalar("UPDATE workspaces SET next_issue_number=next_issue_number+1 WHERE id=$1 RETURNING next_issue_number-1").bind(workspace).fetch_one(&mut *conn).await?;
        let issue = Uuid::new_v4();
        let position: i64 = sqlx::query_scalar("SELECT COALESCE(max(position),-1024)+1024 FROM issues WHERE workspace_id=$1 AND team_id=$2 AND stage_id=$3 AND deleted_at IS NULL")
            .bind(workspace).bind(mapping.team_id).bind(stage).fetch_one(&mut *conn).await?;
        sqlx::query("INSERT INTO issues(id,workspace_id,number,title,description,team_id,stage_id,priority,deadline,position,created_at,updated_at,openproject) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$11,clock_timestamp(),clock_timestamp(),$10)")
            .bind(issue).bind(workspace).bind(number).bind(title).bind(description).bind(mapping.team_id).bind(stage).bind(priority).bind(deadline).bind(metadata).bind(position).execute(&mut *conn).await?;
        *issue_count = issue_count.map(|count| count + 1);
        issue
    };
    sqlx::query("INSERT INTO source_links(id,workspace_id,issue_id,url,title) VALUES($1,$2,$3,$4,'OpenProject') ON CONFLICT DO NOTHING").bind(Uuid::new_v4()).bind(workspace).bind(issue).bind(url).execute(conn).await?;
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
pub async fn record_failure(store: &Store, job: &SyncJob, message: &str) -> Result<()> {
    sqlx::query("UPDATE openproject_connections SET status='error',last_error=$3,next_run_at=LEAST(next_run_at,clock_timestamp()+interval '5 minutes') WHERE id=$1 AND generation=$2 AND NOT deleted")
        .bind(job.connection_id).bind(job.generation).bind(message).execute(&store.pool).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pagination_respects_reported_size_and_unpaginated_discovery() {
        let page = json!({"total":3,"count":1,"pageSize":1,"offset":1,"_embedded":{"elements":[{"id":1}]}});
        assert!(elements(&page, 1).unwrap().1);
        assert!(elements(&page, 2).is_err());
        let last = json!({"total":3,"count":1,"pageSize":1,"offset":3,"_embedded":{"elements":[{"id":3}]}});
        assert!(!elements(&last, 3).unwrap().1);
        let statuses =
            json!({"total":70,"count":70,"_embedded":{"elements":vec![json!({"id":1});70]}});
        assert_eq!(elements(&statuses, 1).unwrap().0.len(), 70);
        assert!(elements(&statuses, 2).is_err());
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
            assert!(elements(&page, 1).is_err());
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
