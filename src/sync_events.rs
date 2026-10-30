use sqlx::{PgPool, postgres::PgListener};
use std::collections::HashMap;
use std::ops::ControlFlow;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;
use tokio::sync::broadcast;
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

/// Capacity of each workspace's poke channel. A poke carries no data, so
/// overflow only means the subscriber missed some; it surfaces as `Lagged`,
/// which a subscriber treats as a poke.
pub const SYNC_EVENTS_CHANNEL: usize = 64;

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

/// Pokes fan out per workspace, so a burst or a lagging reader in one
/// workspace never wakes another workspace's streams. A channel exists while
/// the workspace has a subscriber.
#[derive(Default)]
pub struct PokeHub {
    channels: Mutex<HashMap<Uuid, broadcast::Sender<()>>>,
}

impl PokeHub {
    fn channels(&self) -> MutexGuard<'_, HashMap<Uuid, broadcast::Sender<()>>> {
        self.channels.lock().unwrap_or_else(PoisonError::into_inner)
    }

    pub fn subscribe(self: &Arc<Self>, workspace: Uuid) -> Subscription {
        let receiver = self
            .channels()
            .entry(workspace)
            .or_insert_with(|| broadcast::channel(SYNC_EVENTS_CHANNEL).0)
            .subscribe();
        Subscription {
            hub: Arc::clone(self),
            workspace,
            receiver: Some(receiver),
        }
    }

    /// Pokes one workspace's streams.
    pub fn poke(&self, workspace: Uuid) {
        if let Some(sender) = self.channels().get(&workspace) {
            let _ = sender.send(());
        }
    }

    /// Pokes every open stream, for gaps in what the listener saw.
    pub fn poke_all(&self) {
        for sender in self.channels().values() {
            let _ = sender.send(());
        }
    }

    /// Open subscriptions across all workspaces.
    pub fn subscriber_count(&self) -> usize {
        self.channels()
            .values()
            .map(broadcast::Sender::receiver_count)
            .sum()
    }
}

/// One stream's place in its workspace's channel. Dropping the last one
/// removes the channel.
pub struct Subscription {
    hub: Arc<PokeHub>,
    workspace: Uuid,
    receiver: Option<broadcast::Receiver<()>>,
}

impl Subscription {
    pub async fn recv(&mut self) -> Result<(), broadcast::error::RecvError> {
        match self.receiver.as_mut() {
            Some(receiver) => receiver.recv().await,
            None => Err(broadcast::error::RecvError::Closed),
        }
    }
}

impl Drop for Subscription {
    fn drop(&mut self) {
        let mut channels = self.hub.channels();
        drop(self.receiver.take());
        if channels
            .get(&self.workspace)
            .is_some_and(|sender| sender.receiver_count() == 0)
        {
            channels.remove(&self.workspace);
        }
    }
}

/// One `PgListener` per server process. Started when the HTTP server starts,
/// never in the worker. The listener opens its own dedicated connection
/// outside the request pool, so it never takes a pool slot; subscribers share
/// it through the hub. The pool is only watched for shutdown.
pub fn spawn_listener(
    pool: PgPool,
    database_url: String,
    hub: Arc<PokeHub>,
    reconnect_delay: Duration,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move { run(&pool, &database_url, &hub, reconnect_delay).await })
}

async fn connect(database_url: &str) -> Result<PgListener, sqlx::Error> {
    let mut listener = PgListener::connect(database_url).await?;
    // The task owns reconnects; a failed eager reconnect must not silently
    // recover on a later `try_recv` without a wildcard.
    listener.eager_reconnect(false);
    listener.listen("blackwall_changes").await?;
    Ok(listener)
}

async fn run(pool: &PgPool, database_url: &str, hub: &PokeHub, delay: Duration) {
    let initial = if delay.is_zero() {
        Duration::from_millis(10)
    } else {
        delay
    };
    let mut backoff = initial;
    loop {
        // Race connection establishment against the request pool's close
        // signal: `connect` opens its own dedicated connection and would
        // otherwise wait out network stalls past pool shutdown.
        let connected = tokio::select! {
            biased;
            _ = pool.close_event() => return,
            result = connect(database_url) => result,
        };
        match connected {
            Ok(listener) => {
                tracing::info!("sync events listener connected");
                // After every successful LISTEN, including the first:
                // notifications may have been lost while disconnected.
                hub.poke_all();
                backoff = initial;
                if relay(pool, listener, hub).await.is_break() {
                    return;
                }
            }
            Err(error) => {
                if pool.is_closed() {
                    return;
                }
                tracing::warn!(error = %error, "sync events listen failed; retrying");
            }
        }
        if pause(pool, backoff).await.is_break() {
            return;
        }
        backoff = std::cmp::min(backoff.saturating_mul(2), MAX_RECONNECT_DELAY);
    }
}

/// Forwards notifications until the connection drops. Breaks once the pool
/// closes.
async fn relay(pool: &PgPool, mut listener: PgListener, hub: &PokeHub) -> ControlFlow<()> {
    loop {
        // Race reception against the request pool's close signal:
        // `try_recv` waits on the socket and would otherwise hold
        // the backend past pool shutdown. On closure the listener
        // is dropped with the task, releasing its backend.
        let received = tokio::select! {
            biased;
            _ = pool.close_event() => return ControlFlow::Break(()),
            result = listener.try_recv() => result,
        };
        match received {
            Ok(Some(notification)) => relay_payload(hub, notification.payload()),
            // The connection dropped. Drop the listener and
            // reconnect with backoff; the next successful LISTEN
            // broadcasts the wildcard that covers the gap.
            Ok(None) => {
                tracing::warn!("sync events listener connection lost; reconnecting");
                return ControlFlow::Continue(());
            }
            Err(error) => {
                if pool.is_closed() {
                    return ControlFlow::Break(());
                }
                tracing::warn!(
                    error = %error,
                    "sync events notification failed; reconnecting"
                );
                return ControlFlow::Continue(());
            }
        }
    }
}

fn relay_payload(hub: &PokeHub, payload: &str) {
    match payload.parse::<Uuid>() {
        Ok(workspace) if !workspace.is_nil() => hub.poke(workspace),
        Ok(_) => hub.poke_all(),
        Err(_) => {
            tracing::warn!(
                payload,
                "sync events invalid payload; poking all subscribers"
            );
            hub.poke_all();
        }
    }
}

async fn pause(pool: &PgPool, delay: Duration) -> ControlFlow<()> {
    tokio::select! {
        _ = tokio::time::sleep(delay) => ControlFlow::Continue(()),
        _ = pool.close_event() => ControlFlow::Break(()),
    }
}

#[cfg(test)]
mod tests {
    use super::{PokeHub, SYNC_EVENTS_CHANNEL};
    use std::sync::Arc;
    use tokio::sync::broadcast::error::{RecvError, TryRecvError};
    use uuid::Uuid;

    #[tokio::test]
    async fn lagging_in_one_workspace_leaves_another_alone() {
        let hub = Arc::new(PokeHub::default());
        let (busy, quiet) = (Uuid::new_v4(), Uuid::new_v4());
        let mut lagging = hub.subscribe(busy);
        let mut bystander = hub.subscribe(quiet);

        for _ in 0..=SYNC_EVENTS_CHANNEL {
            hub.poke(busy);
        }

        assert!(matches!(lagging.recv().await, Err(RecvError::Lagged(_))));
        let receiver = bystander.receiver.as_mut().unwrap();
        assert!(matches!(receiver.try_recv(), Err(TryRecvError::Empty)));
    }

    #[tokio::test]
    async fn poke_all_reaches_every_workspace() {
        let hub = Arc::new(PokeHub::default());
        let mut first = hub.subscribe(Uuid::new_v4());
        let mut second = hub.subscribe(Uuid::new_v4());

        hub.poke_all();

        assert!(first.recv().await.is_ok());
        assert!(second.recv().await.is_ok());
    }

    #[tokio::test]
    async fn channel_lives_while_a_workspace_has_subscribers() {
        let hub = Arc::new(PokeHub::default());
        let workspace = Uuid::new_v4();
        let first = hub.subscribe(workspace);
        let mut second = hub.subscribe(workspace);
        assert_eq!(hub.subscriber_count(), 2);

        drop(first);
        hub.poke(workspace);
        assert!(second.recv().await.is_ok());

        drop(second);
        assert_eq!(hub.subscriber_count(), 0);
        assert!(hub.channels().is_empty());

        let mut again = hub.subscribe(workspace);
        hub.poke(workspace);
        assert!(again.recv().await.is_ok());
    }
}
