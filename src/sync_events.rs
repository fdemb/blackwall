use sqlx::{PgPool, postgres::PgListener};
use std::time::Duration;
use uuid::Uuid;

/// At most one poke per stream per this long. Notifications arriving inside
/// the window collapse into one trailing poke, so the last one is never dropped.
pub const SYNC_EVENTS_COALESCE: Duration = Duration::from_millis(250);
/// Idle streams send a comment this often so intermediaries do not close them.
pub const SYNC_EVENTS_KEEPALIVE: Duration = Duration::from_secs(15);
/// Streams end after this long. Clients reconnect, which re-runs
/// authentication and the membership check.
pub const SYNC_EVENTS_LIFETIME: Duration = Duration::from_secs(30 * 60);
/// Delay before retrying a failed listener connection.
pub const SYNC_EVENTS_RECONNECT_DELAY: Duration = Duration::from_secs(1);

/// Broadcast capacity for workspace ids. Subscribers filter for their own
/// workspace; overflow surfaces as `Lagged`, which subscribers treat as a poke.
pub const SYNC_EVENTS_CHANNEL: usize = 1024;

/// Tuning for the sync event stream. Production uses [`Default`]; tests
/// shorten the durations through [`crate::store::StoreConfig`].
#[derive(Clone, Debug)]
pub struct SyncEventsConfig {
    pub coalesce: Duration,
    pub keepalive: Duration,
    pub lifetime: Duration,
    pub reconnect_delay: Duration,
}

impl Default for SyncEventsConfig {
    fn default() -> Self {
        Self {
            coalesce: SYNC_EVENTS_COALESCE,
            keepalive: SYNC_EVENTS_KEEPALIVE,
            lifetime: SYNC_EVENTS_LIFETIME,
            reconnect_delay: SYNC_EVENTS_RECONNECT_DELAY,
        }
    }
}

/// One `PgListener` per server process. Started when the HTTP server starts,
/// never in the worker. The only database connection is the listener's;
/// subscribers share it through the broadcast channel.
pub fn spawn_listener(
    pool: PgPool,
    sender: tokio::sync::broadcast::Sender<Uuid>,
    reconnect_delay: Duration,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move { run(&pool, &sender, reconnect_delay).await })
}

async fn connect(pool: &PgPool) -> Result<PgListener, sqlx::Error> {
    let mut listener = PgListener::connect_with(pool).await?;
    // Surface pool closure so the task can exit instead of waiting forever.
    listener.ignore_pool_close_event(false);
    listener.listen("blackwall_changes").await?;
    Ok(listener)
}

async fn run(pool: &PgPool, sender: &tokio::sync::broadcast::Sender<Uuid>, delay: Duration) {
    let mut listener = loop {
        match connect(pool).await {
            Ok(listener) => break listener,
            Err(error) => {
                tracing::warn!(error = %error, "sync events listen failed; retrying");
                tokio::time::sleep(delay).await;
            }
        }
    };
    tracing::info!("sync events listener connected");

    loop {
        match listener.try_recv().await {
            Ok(Some(notification)) => match notification.payload().parse::<Uuid>() {
                Ok(workspace) => {
                    let _ = sender.send(workspace);
                }
                Err(_) => {
                    tracing::warn!(
                        payload = notification.payload(),
                        "sync events invalid payload; poking all subscribers"
                    );
                    let _ = sender.send(Uuid::nil());
                }
            },
            // The connection dropped and (with eager reconnect) is already
            // re-listening. Notifications in between may be lost, so poke
            // every subscriber; each pulls what it missed.
            Ok(None) => {
                tracing::warn!("sync events listener reconnected; poking all subscribers");
                let _ = sender.send(Uuid::nil());
            }
            Err(error) => {
                if matches!(error, sqlx::Error::PoolClosed) {
                    tracing::info!("sync events listener pool closed");
                    return;
                }
                tracing::warn!(error = %error, "sync events notification failed; retrying");
                tokio::time::sleep(delay).await;
            }
        }
    }
}
