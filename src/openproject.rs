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
use std::collections::{BTreeMap, BTreeSet};
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
mod reconciliation;
mod scan;
mod transport;
use scan::{Checkpoint, PageData};
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
    let checkpoint = Checkpoint::new(refresh_only);
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
    let cp: Checkpoint = serde_json::from_value(row.try_get("checkpoint")?)?;
    let (path, filters) = cp.request(&mappings)?;
    let response = transport::fetch(&base, &token, path, cp.cursor().page, filters).await?;
    let page = cp.normalize(response, &mappings)?;
    let statuses: Vec<scan::Status> = serde_json::from_value(row.try_get("cached_statuses")?)?;
    let transition = cp.advance(&page, mappings.len())?;
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
    match &page.data {
        PageData::Projects(items) => {
            scan::append_cache(&mut cached_projects, items, cp.cursor().page)?
        }
        PageData::Statuses(items) => {
            scan::append_cache(&mut cached_statuses, items, cp.cursor().page)?
        }
        PageData::WorkPackages { mapping, items } => {
            sqlx::query("SELECT pg_advisory_xact_lock_shared(hashtextextended($1,74103))")
                .bind(workspace.to_string())
                .execute(&mut *tx)
                .await?;
            sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,41827))")
                .bind(workspace.to_string())
                .execute(&mut *tx)
                .await?;
            sqlx::query("SELECT set_config('blackwall.openproject_sync','on',true)")
                .execute(&mut *tx)
                .await?;
            let mut import = reconciliation::PageImport::new(
                workspace,
                job.connection_id,
                &base,
                mapping,
                &statuses,
            );
            for item in items {
                reconciliation::apply(&mut tx, &mut import, item).await?;
            }
        }
    }
    let finished = transition.next.is_none();
    sqlx::query("UPDATE openproject_connections SET cached_projects=$3,cached_statuses=$4,checkpoint=$5,next_run_at=clock_timestamp()+CASE WHEN $6 THEN interval '5 minutes' ELSE interval '0 seconds' END,status=$7,last_error='',last_checked_at=CASE WHEN $8 THEN clock_timestamp() ELSE last_checked_at END,last_synced_at=CASE WHEN $6 AND NOT $9 THEN clock_timestamp() ELSE last_synced_at END WHERE id=$1 AND generation=$2")
        .bind(job.connection_id).bind(job.generation).bind(cached_projects).bind(cached_statuses).bind(json!(transition.next.unwrap_or_default())).bind(finished).bind(if finished {"idle"} else {"syncing"}).bind(transition.checked).bind(transition.refresh_only).execute(&mut *tx).await?;
    if Outbox::complete_in(&mut tx, claim).await? {
        tx.commit().await?;
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
