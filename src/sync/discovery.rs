use super::SyncJob;
use crate::error::{Error, Result};
use serde::Serialize;
use serde_json::json;
use sqlx::PgConnection;

/// Only the completed resource replaces its public cache. The connection row is locked
/// by the caller, so a superseded generation cannot append or publish stale pages.
pub(super) async fn save<T: Serialize>(
    conn: &mut PgConnection,
    job: &SyncJob,
    resource: &str,
    page: i64,
    more: bool,
    items: &[T],
) -> Result<()> {
    let column = match resource {
        "projects" => "cached_projects",
        "statuses" => "cached_statuses",
        "people" => "cached_people",
        _ => return Err(Error::Internal("invalid sync discovery resource".into())),
    };
    if page == 1 {
        sqlx::query("DELETE FROM sync_discovery_pages WHERE connection_id=$1 AND resource=$2")
            .bind(job.connection_id)
            .bind(resource)
            .execute(&mut *conn)
            .await?;
    }
    sqlx::query("INSERT INTO sync_discovery_pages(connection_id,generation,resource,page,items) VALUES($1,$2,$3,$4,$5) ON CONFLICT(connection_id,generation,resource,page) DO UPDATE SET items=excluded.items")
        .bind(job.connection_id).bind(job.generation).bind(resource).bind(page).bind(json!(items))
        .execute(&mut *conn).await?;
    let count: i64 = sqlx::query_scalar("SELECT COALESCE(sum(jsonb_array_length(items)),0)::bigint FROM sync_discovery_pages WHERE connection_id=$1 AND generation=$2 AND resource=$3")
        .bind(job.connection_id).bind(job.generation).bind(resource).fetch_one(&mut *conn).await?;
    if count > 5000 {
        return Err(Error::Internal("sync discovery limit reached".into()));
    }
    if !more {
        sqlx::query(&format!("UPDATE sync_connections SET {column}=(SELECT COALESCE(jsonb_agg(element.value ORDER BY p.page,element.ordinality),'[]'::jsonb) FROM sync_discovery_pages p CROSS JOIN LATERAL jsonb_array_elements(p.items) WITH ORDINALITY AS element(value,ordinality) WHERE p.connection_id=$1 AND p.generation=$2 AND p.resource=$3) WHERE id=$1 AND generation=$2"))
            .bind(job.connection_id).bind(job.generation).bind(resource).execute(&mut *conn).await?;
        sqlx::query("DELETE FROM sync_discovery_pages WHERE connection_id=$1 AND resource=$2")
            .bind(job.connection_id)
            .bind(resource)
            .execute(conn)
            .await?;
    }
    Ok(())
}
