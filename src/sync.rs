//! Provider-neutral issue sync: overlapping incremental polling with periodic full discovery.
//! Each queue lease fetches at most one page. Providers own transport, scan state and
//! normalization; everything else lives here.
use crate::error::{Error, Result};
use provider::{RemotePerson, RemoteStatus};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{collections::BTreeMap, time::Duration};
use uuid::Uuid;

mod comments;
mod connections;
mod discovery;
mod merge;
mod openproject;
mod options;
mod outbox;
mod provider;
mod push;
mod reconciliation;
mod runner;

pub use connections::router;
pub use options::{Direction, SyncField, SyncOptions};
pub(crate) use outbox::{enqueue_comment, enqueue_fields};
pub use provider::{Descriptor, ProviderKind};
pub use runner::{execute, failure_message, record_failure, schedule};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SyncJob {
    pub connection_id: Uuid,
    pub generation: i64,
    /// Only sends queued local changes; the scan waits for its schedule.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub push_only: bool,
}

/// Imports one remote project into a team. Status IDs key the explicit stage overrides.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Mapping {
    pub project_id: String,
    pub team_id: Uuid,
    #[serde(default)]
    pub stage_mapping: BTreeMap<String, Uuid>,
}

/// Connection metadata that imports and pushes map remote values with.
struct Metadata {
    options: SyncOptions,
    statuses: Vec<RemoteStatus>,
    people: Vec<RemotePerson>,
    people_mapping: BTreeMap<String, Uuid>,
}

impl Metadata {
    /// Loads the connection in whatever state it is; callers check its generation and
    /// whether it is enabled.
    async fn load(pool: &sqlx::PgPool, connection: Uuid) -> Result<Option<Self>> {
        let row: Option<(Value, Value, Value, Value)> = sqlx::query_as("SELECT options,cached_statuses,cached_people,people_mapping FROM sync_connections WHERE id=$1")
            .bind(connection).fetch_optional(pool).await?;
        let Some((options, statuses, people, people_mapping)) = row else {
            return Ok(None);
        };
        Ok(Some(Self {
            options: serde_json::from_value(options)?,
            statuses: serde_json::from_value(statuses)?,
            people: serde_json::from_value(people)?,
            people_mapping: serde_json::from_value(people_mapping)?,
        }))
    }
}

/// Shared by every provider: no proxies or redirects, so requests only reach the configured host.
pub(crate) fn http_client() -> Result<reqwest::Client> {
    reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(20))
        .connect_timeout(Duration::from_secs(5))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| Error::Internal("sync HTTP client failed".into()))
}

/// Cancels queued work for a connection whose configuration was superseded.
async fn cancel_pending(conn: &mut sqlx::PgConnection, id: Uuid) -> Result<()> {
    sqlx::query("UPDATE jobs SET state='cancelled',finished_at=clock_timestamp(),updated_at=clock_timestamp() WHERE queue='sync' AND state='pending' AND payload->>'connection_id'=$1")
        .bind(id.to_string()).execute(conn).await?;
    Ok(())
}
