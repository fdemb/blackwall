//! Connection settings API. Every route requires a workspace owner or administrator.
use super::{Mapping, ProviderKind, TrackerOptions, cancel_pending, provider::Descriptor};
use crate::{
    error::{Error, Result},
    http::Actor,
    store::Store,
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

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    pub provider: Option<ProviderKind>,
    pub name: Option<String>,
    pub base_url: Option<String>,
    pub token: Option<String>,
    pub enabled: Option<bool>,
    pub projects: Option<Vec<Mapping>>,
    pub people_mapping: Option<BTreeMap<String, Uuid>>,
    /// Fields omitted here keep their current direction.
    pub options: Option<TrackerOptions>,
}

#[derive(Serialize)]
pub struct Connection {
    pub id: Uuid,
    pub provider: ProviderKind,
    pub name: String,
    pub base_url: String,
    pub enabled: bool,
    pub generation: i64,
    pub options: TrackerOptions,
    pub projects: Vec<Mapping>,
    pub cached_projects: Value,
    pub cached_statuses: Value,
    pub cached_people: Value,
    pub people_mapping: BTreeMap<String, Uuid>,
    pub status: String,
    pub last_error: String,
    pub last_checked_at: Option<DateTime<Utc>>,
    pub last_synced_at: Option<DateTime<Utc>>,
    /// Local changes waiting to be sent.
    pub pending_pushes: i64,
    /// Why waiting changes cannot be sent (credentials or permissions), apart from
    /// `last_error` of scans.
    pub push_error: Option<String>,
}

const PUBLIC: &str = "id,provider,name,base_url,enabled,generation,options,projects,cached_projects,cached_statuses,cached_people,people_mapping,status,last_error,last_checked_at,last_synced_at,push_error,(SELECT count(*) FROM tracker_outbox o WHERE o.connection_id=tracker_connections.id) AS pending_pushes";

fn connection(row: sqlx::postgres::PgRow) -> Result<Connection> {
    Ok(Connection {
        id: row.try_get("id")?,
        provider: ProviderKind::parse(row.try_get("provider")?)?,
        name: row.try_get("name")?,
        base_url: row.try_get("base_url")?,
        enabled: row.try_get("enabled")?,
        generation: row.try_get("generation")?,
        options: serde_json::from_value(row.try_get("options")?)?,
        projects: serde_json::from_value(row.try_get("projects")?)?,
        cached_projects: row.try_get("cached_projects")?,
        cached_statuses: row.try_get("cached_statuses")?,
        cached_people: row.try_get("cached_people")?,
        people_mapping: serde_json::from_value(row.try_get("people_mapping")?)?,
        status: row.try_get("status")?,
        last_error: row.try_get("last_error")?,
        last_checked_at: row.try_get("last_checked_at")?,
        last_synced_at: row.try_get("last_synced_at")?,
        pending_pushes: row.try_get("pending_pushes")?,
        push_error: row.try_get("push_error")?,
    })
}

pub fn router() -> Router<Store> {
    Router::new()
        .route(
            "/internal-api/workspaces/{workspace}/trackers/providers",
            get(providers),
        )
        .route(
            "/internal-api/workspaces/{workspace}/trackers/connections",
            get(list).post(create),
        )
        .route(
            "/internal-api/workspaces/{workspace}/trackers/connections/{id}",
            axum::routing::patch(update).delete(delete),
        )
        .route(
            "/internal-api/workspaces/{workspace}/trackers/connections/{id}/refresh",
            post(refresh),
        )
        .route(
            "/internal-api/workspaces/{workspace}/trackers/connections/{id}/sync",
            post(sync),
        )
}

async fn admin(conn: &mut PgConnection, workspace: Uuid, actor: Uuid) -> Result<()> {
    let role: Option<String> = sqlx::query_scalar!(
        "SELECT role FROM workspace_members WHERE workspace_id=$1 AND user_id=$2 FOR SHARE",
        workspace,
        actor,
    )
    .fetch_optional(conn)
    .await?;
    if !matches!(role.as_deref(), Some("owner" | "admin")) {
        return Err(Error::Forbidden);
    }
    Ok(())
}

/// Team deletion and tracker pages take the issue graph lock before any
/// connection row, so taking it first keeps that order and stops a team from
/// being deleted under a mapping saved in this transaction.
async fn admin_holding_graph(conn: &mut PgConnection, workspace: Uuid, actor: Uuid) -> Result<()> {
    admin(conn, workspace, actor).await?;
    sqlx::query!(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,41827))",
        workspace.to_string(),
    )
    .execute(conn)
    .await?;
    Ok(())
}

async fn providers(
    State(store): State<Store>,
    actor: Actor,
    Path(workspace): Path<Uuid>,
) -> Result<Json<Vec<Descriptor>>> {
    let mut conn = store.pool.acquire().await?;
    admin(&mut conn, workspace, actor.profile.id).await?;
    Ok(Json(
        ProviderKind::ALL
            .into_iter()
            .map(ProviderKind::descriptor)
            .collect(),
    ))
}

async fn list(
    State(store): State<Store>,
    actor: Actor,
    Path(workspace): Path<Uuid>,
) -> Result<Json<Value>> {
    let mut tx = store.pool.begin().await?;
    admin(&mut tx, workspace, actor.profile.id).await?;
    let rows = sqlx::query(&format!("SELECT {PUBLIC} FROM tracker_connections WHERE workspace_id=$1 AND NOT deleted ORDER BY name,id"))
        .bind(workspace).fetch_all(&mut *tx).await?;
    Ok(Json(
        json!({"connections": rows.into_iter().map(connection).collect::<Result<Vec<_>>>()?}),
    ))
}

fn validate_url(value: &str) -> Result<String> {
    let url = reqwest::Url::parse(value)
        .map_err(|_| Error::BadRequest("invalid connection URL".into()))?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(Error::BadRequest(
            "connection URL must be http(s) without credentials, query or fragment".into(),
        ));
    }
    if value.len() > 2000 {
        return Err(Error::BadRequest("connection URL is too long".into()));
    }
    Ok(url.as_str().trim_end_matches('/').into())
}

/// Creates the row with its required fields; `configure` validates and applies the rest.
async fn insert(conn: &mut PgConnection, workspace: Uuid, config: &Config) -> Result<Uuid> {
    sqlx::query!(
        "SELECT id FROM workspaces WHERE id=$1 FOR NO KEY UPDATE",
        workspace,
    )
    .execute(&mut *conn)
    .await?;
    let provider = config
        .provider
        .ok_or_else(|| Error::BadRequest("provider is required".into()))?;
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
    let count: i64 = sqlx::query_scalar!(
        r#"SELECT count(*) AS "count!" FROM tracker_connections WHERE workspace_id=$1 AND NOT deleted"#,
        workspace,
    )
    .fetch_one(&mut *conn)
    .await?;
    if count >= 20 {
        return Err(Error::BadRequest("connection limit reached".into()));
    }
    let id = Uuid::new_v4();
    sqlx::query!("INSERT INTO tracker_connections(id,workspace_id,provider,name,base_url,token,options) VALUES($1,$2,$3,$4,$5,$6,$7)",
        id, workspace, provider.key(), name, url, token,
        json!(provider.descriptor().defaults)).execute(&mut *conn).await?;
    Ok(id)
}

/// Drops changes queued for projects no longer mapped, even rows backing off.
async fn drop_unmapped(
    conn: &mut sqlx::PgConnection,
    id: Uuid,
    projects: &[Mapping],
) -> Result<()> {
    sqlx::query!("DELETE FROM tracker_outbox o USING issues i WHERE o.connection_id=$1 AND i.id=o.issue_id AND NOT $2::jsonb @> jsonb_build_array(jsonb_build_object('project_id',i.tracker->>'project_id'))",
        id, json!(projects)).execute(conn).await?;
    Ok(())
}

async fn validate_projects(
    conn: &mut PgConnection,
    workspace: Uuid,
    provider: ProviderKind,
    projects: &[Mapping],
) -> Result<()> {
    if projects.len() > 100 {
        return Err(Error::BadRequest("at most 100 project mappings".into()));
    }
    let mut seen = BTreeSet::new();
    for mapping in projects {
        if !provider.valid_id(&mapping.project_id)
            || !seen.insert(&mapping.project_id)
            || mapping.stage_mapping.len() > 100
        {
            return Err(Error::BadRequest(
                "invalid or duplicate project mapping".into(),
            ));
        }
    }
    let teams: Vec<Uuid> = projects
        .iter()
        .map(|mapping| mapping.team_id)
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    let stages: Vec<Uuid> = projects
        .iter()
        .flat_map(|mapping| mapping.stage_mapping.values().copied())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    let existing_teams: BTreeSet<Uuid> = sqlx::query_scalar!(
        "SELECT DISTINCT team_id FROM stages WHERE workspace_id=$1 AND team_id=ANY($2)",
        workspace,
        &teams,
    )
    .fetch_all(&mut *conn)
    .await?
    .into_iter()
    .collect();
    let existing_stages: BTreeSet<(Uuid, Uuid)> = sqlx::query!(
        "SELECT team_id,id FROM stages WHERE workspace_id=$1 AND id=ANY($2)",
        workspace,
        &stages,
    )
    .fetch_all(&mut *conn)
    .await?
    .into_iter()
    .map(|row| (row.team_id, row.id))
    .collect();
    for mapping in projects {
        if !existing_teams.contains(&mapping.team_id) {
            return Err(Error::BadRequest(
                "team must belong to workspace and have stages".into(),
            ));
        }
        for (status, stage) in &mapping.stage_mapping {
            if !provider.valid_id(status) {
                return Err(Error::BadRequest(
                    "status mapping keys must be valid status IDs".into(),
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

fn normalize_people(people_mapping: BTreeMap<String, Uuid>) -> Result<BTreeMap<String, Uuid>> {
    if people_mapping.len() > 5000 {
        return Err(Error::BadRequest("at most 5000 people mappings".into()));
    }
    let mut normalized = BTreeMap::new();
    for (email, user) in people_mapping {
        let email = email.trim().to_lowercase();
        if email.len() > 254
            || !email.split_once('@').is_some_and(|(local, host)| {
                !local.is_empty() && host.contains('.') && !host.starts_with('.')
            })
            || email
                .chars()
                .any(|character| character.is_whitespace() || character.is_control())
            || normalized.insert(email, user).is_some()
        {
            return Err(Error::BadRequest(
                "invalid or duplicate people mapping email".into(),
            ));
        }
    }
    Ok(normalized)
}

async fn validate_people(
    conn: &mut PgConnection,
    workspace: Uuid,
    people: &BTreeMap<String, Uuid>,
) -> Result<()> {
    let users: Vec<Uuid> = people
        .values()
        .copied()
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    let members: BTreeSet<Uuid> = sqlx::query_scalar!(
        "SELECT user_id FROM workspace_members WHERE workspace_id=$1 AND user_id=ANY($2)",
        workspace,
        &users,
    )
    .fetch_all(conn)
    .await?
    .into_iter()
    .collect();
    if users.iter().any(|user| !members.contains(user)) {
        return Err(Error::BadRequest(
            "mapped person must belong to workspace".into(),
        ));
    }
    Ok(())
}

/// The requested URL, which cannot change once the connection imported issues.
async fn updated_url(
    conn: &mut PgConnection,
    id: Uuid,
    provider: ProviderKind,
    requested: Option<String>,
    previous: &str,
) -> Result<String> {
    let url = validate_url(requested.as_deref().unwrap_or(previous))?;
    if url == previous {
        return Ok(url);
    }
    let imported: bool = sqlx::query_scalar!(
        r#"SELECT EXISTS(SELECT 1 FROM issues WHERE tracker->>'connection_id'=$1) AS "exists!""#,
        id.to_string(),
    )
    .fetch_one(&mut *conn)
    .await?;
    if imported {
        return Err(Error::Conflict(format!(
            "{} URL cannot change after import; create a new connection for another instance",
            provider.name()
        )));
    }
    Ok(url)
}

/// The requested people mapping, normalized and checked against workspace
/// membership when it differs from the stored one.
async fn updated_people(
    conn: &mut PgConnection,
    workspace: Uuid,
    requested: Option<BTreeMap<String, Uuid>>,
    previous: &BTreeMap<String, Uuid>,
) -> Result<BTreeMap<String, Uuid>> {
    let Some(requested) = requested else {
        return Ok(previous.clone());
    };
    let people = normalize_people(requested)?;
    if &people != previous {
        validate_people(conn, workspace, &people).await?;
    }
    Ok(people)
}

fn next_generation(generation: i64) -> Result<i64> {
    generation.checked_add(1).ok_or_else(|| {
        Error::Conflict("tracker generation exhausted; create a new connection".into())
    })
}

async fn configure(
    store: Store,
    actor: Actor,
    workspace: Uuid,
    id: Option<Uuid>,
    config: Config,
) -> Result<Connection> {
    let mut tx = store.pool.begin().await?;
    admin_holding_graph(&mut tx, workspace, actor.profile.id).await?;
    let created = id.is_none();
    let id = match id {
        Some(id) => id,
        None => insert(&mut tx, workspace, &config).await?,
    };
    let row = sqlx::query!("SELECT provider,name,base_url,token,enabled,options,projects,people_mapping,generation FROM tracker_connections WHERE workspace_id=$1 AND id=$2 AND NOT deleted FOR UPDATE",
        workspace, id).fetch_optional(&mut *tx).await?.ok_or(Error::NotFound)?;
    let provider = ProviderKind::parse(&row.provider)?;
    if config.provider.is_some_and(|kind| kind != provider) {
        return Err(Error::BadRequest(
            "provider cannot change; create a new connection".into(),
        ));
    }
    let previous_name: String = row.name;
    let name = config.name.unwrap_or(previous_name.clone());
    crate::domain::text(&name, 200)?;
    let previous_url: String = row.base_url;
    let url = updated_url(&mut tx, id, provider, config.base_url, &previous_url).await?;
    let previous_token: String = row.token;
    let token = config.token.unwrap_or(previous_token.clone());
    if token.is_empty() || token.len() > 4096 || token.chars().any(char::is_control) {
        return Err(Error::BadRequest("invalid token".into()));
    }
    let previous_options: TrackerOptions = serde_json::from_value(row.options)?;
    let options = config.options.map_or_else(
        || previous_options.clone(),
        |options| options.merged(&previous_options),
    );
    options.validate(&provider.descriptor().fields)?;
    let previous_projects: Vec<Mapping> = serde_json::from_value(row.projects)?;
    let projects = config.projects.unwrap_or_else(|| previous_projects.clone());
    let projects_changed = projects != previous_projects;
    if projects_changed {
        validate_projects(&mut tx, workspace, provider, &projects).await?;
    }
    let previous_people: BTreeMap<String, Uuid> = serde_json::from_value(row.people_mapping)?;
    let people =
        updated_people(&mut tx, workspace, config.people_mapping, &previous_people).await?;
    let people_changed = people != previous_people;
    let previous_enabled: bool = row.enabled;
    let enabled = config.enabled.unwrap_or(previous_enabled);
    let scan_changed = created
        || url != previous_url
        || token != previous_token
        || enabled != previous_enabled
        || projects_changed
        || people_changed
        || options.imports_changed(&previous_options);
    if scan_changed {
        let generation = next_generation(row.generation)?;
        sqlx::query!("UPDATE tracker_connections SET name=$3,base_url=$4,token=$5,enabled=$6,projects=$7,people_mapping=$9,generation=$10,options=$11,checkpoint=$8,next_run_at=clock_timestamp(),status='pending',last_error='',push_error=NULL,remote_user_id=CASE WHEN base_url=$4 AND token=$5 THEN remote_user_id END,incremental_supported=true WHERE workspace_id=$1 AND id=$2",
            workspace, id, name, url, token, enabled, json!(projects),
            provider.checkpoint(false), json!(people), generation, json!(options))
            .execute(&mut *tx).await?;
        cancel_pending(&mut tx, id).await?;
        drop_unmapped(&mut tx, id, &projects).await?;
    } else if name != previous_name || options != previous_options {
        sqlx::query!(
            "UPDATE tracker_connections SET name=$3,options=$4 WHERE workspace_id=$1 AND id=$2",
            workspace,
            id,
            name,
            json!(options),
        )
        .execute(&mut *tx)
        .await?;
    }
    let result = connection(
        sqlx::query(&format!(
            "SELECT {PUBLIC} FROM tracker_connections WHERE id=$1"
        ))
        .bind(id)
        .fetch_one(&mut *tx)
        .await?,
    )?;
    tx.commit().await?;
    tracing::debug!(connection_id = %id, workspace_id = %workspace, provider = provider.key(),
        generation = result.generation, enabled, project_count = result.projects.len(),
        people_override_count = result.people_mapping.len(), "Tracker configuration saved");
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
    if sqlx::query!("UPDATE tracker_connections SET deleted=true,enabled=false,token='',generation=generation+1 WHERE workspace_id=$1 AND id=$2 AND NOT deleted", workspace, id).execute(&mut *tx).await?.rows_affected() == 0 { return Err(Error::NotFound); }
    cancel_pending(&mut tx, id).await?;
    sqlx::query!("DELETE FROM tracker_outbox WHERE connection_id=$1", id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    tracing::debug!(connection_id = %id, workspace_id = %workspace, "Tracker connection disconnected");
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
    let provider: Option<String> = sqlx::query_scalar!("SELECT provider FROM tracker_connections WHERE workspace_id=$1 AND id=$2 AND NOT deleted AND enabled FOR UPDATE",
        workspace, id).fetch_optional(&mut *tx).await?;
    let provider = ProviderKind::parse(
        &provider.ok_or_else(|| Error::BadRequest("connection missing or disabled".into()))?,
    )?;
    sqlx::query!("UPDATE tracker_connections SET generation=generation+1,checkpoint=$3,next_run_at=clock_timestamp(),status='pending',last_error='',push_error=NULL,incremental_supported=CASE WHEN $4 THEN incremental_supported ELSE true END WHERE workspace_id=$1 AND id=$2",
        workspace, id, provider.checkpoint(refresh_only), refresh_only).execute(&mut *tx).await?;
    cancel_pending(&mut tx, id).await?;
    tx.commit().await?;
    tracing::debug!(connection_id = %id, workspace_id = %workspace, refresh_only, "Tracker scan requested");
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

#[cfg(test)]
mod tests {
    use super::*;

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
}
