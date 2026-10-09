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

/// Cap for the listener's reconnect backoff.
const MAX_RECONNECT_DELAY: Duration = Duration::from_secs(30);

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
/// never in the worker. The listener opens its own dedicated connection
/// outside the request pool, so it never takes a pool slot; subscribers share
/// it through the broadcast channel. The pool is only watched for shutdown.
pub fn spawn_listener(
    pool: PgPool,
    database_url: String,
    sender: tokio::sync::broadcast::Sender<Uuid>,
    reconnect_delay: Duration,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move { run(&pool, &database_url, &sender, reconnect_delay).await })
}

async fn connect(database_url: &str) -> Result<PgListener, sqlx::Error> {
    let mut listener = PgListener::connect(database_url).await?;
    // The task owns reconnects; a failed eager reconnect must not silently
    // recover on a later `try_recv` without a wildcard.
    listener.eager_reconnect(false);
    listener.listen("blackwall_changes").await?;
    Ok(listener)
}

async fn run(
    pool: &PgPool,
    database_url: &str,
    sender: &tokio::sync::broadcast::Sender<Uuid>,
    delay: Duration,
) {
    let initial = if delay.is_zero() {
        Duration::from_millis(10)
    } else {
        delay
    };
    let mut backoff = initial;
    loop {
        if pool.is_closed() {
            return;
        }
        match connect(database_url).await {
            Ok(mut listener) => {
                tracing::info!("sync events listener connected");
                // After every successful LISTEN, including the first:
                // notifications may have been lost while disconnected.
                let _ = sender.send(Uuid::nil());
                backoff = initial;
                loop {
                    if pool.is_closed() {
                        return;
                    }
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
                        // The connection dropped. Drop the listener and
                        // reconnect with backoff; the next successful LISTEN
                        // broadcasts the wildcard that covers the gap.
                        Ok(None) => {
                            tracing::warn!("sync events listener connection lost; reconnecting");
                            break;
                        }
                        Err(error) => {
                            if pool.is_closed() {
                                return;
                            }
                            tracing::warn!(
                                error = %error,
                                "sync events notification failed; reconnecting"
                            );
                            break;
                        }
                    }
                }
            }
            Err(error) => {
                if pool.is_closed() {
                    return;
                }
                tracing::warn!(error = %error, "sync events listen failed; retrying");
            }
        }
        tokio::select! {
            _ = tokio::time::sleep(backoff) => {},
            _ = pool.close_event() => return,
        }
        backoff = std::cmp::min(backoff.saturating_mul(2), MAX_RECONNECT_DELAY);
    }
}
