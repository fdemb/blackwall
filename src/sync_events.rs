use crate::store::Store;
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

/// Capacity of each workspace's poke channel. Overflow means the subscriber
/// missed pokes, so it surfaces as a wildcard poke.
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

/// What a poke tells a stream. A commit names the committing transaction, or
/// the highest of several coalesced ones, and the epoch of the history that
/// transaction belongs to. A wildcard says nothing about what changed, so the
/// client must pull.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Poke {
    #[default]
    Wildcard,
    Commit {
        epoch: Uuid,
        txid: i64,
    },
}

impl Poke {
    /// Two pokes become one. A wildcard in either, or commits from different
    /// epochs, make the result a wildcard.
    pub fn merge(self, other: Self) -> Self {
        match (self, other) {
            (
                Self::Commit { epoch, txid },
                Self::Commit {
                    epoch: other_epoch,
                    txid: other_txid,
                },
            ) if epoch == other_epoch => Self::Commit {
                epoch,
                txid: txid.max(other_txid),
            },
            _ => Self::Wildcard,
        }
    }
}

/// Pokes fan out per workspace, so a burst or a lagging reader in one
/// workspace never wakes another workspace's streams. A channel exists while
/// the workspace has a subscriber.
///
/// The hub also holds the sync epoch that stamps commit pokes. It is `None`
/// while the listener is disconnected and after a rotation, until the
/// listener checks the history again, and commits become wildcards meanwhile.
#[derive(Default)]
pub struct PokeHub {
    channels: Mutex<HashMap<Uuid, broadcast::Sender<Poke>>>,
    epoch: Mutex<Option<Uuid>>,
}

impl PokeHub {
    fn channels(&self) -> MutexGuard<'_, HashMap<Uuid, broadcast::Sender<Poke>>> {
        self.channels.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn epoch(&self) -> MutexGuard<'_, Option<Uuid>> {
        self.epoch.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Records the epoch of the history the listener is connected to.
    pub fn publish_epoch(&self, epoch: Uuid) {
        *self.epoch() = Some(epoch);
    }

    /// Stops stamping commits, until the next `publish_epoch`.
    pub fn withdraw_epoch(&self) {
        *self.epoch() = None;
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
    pub fn poke(&self, workspace: Uuid, poke: Poke) {
        if let Some(sender) = self.channels().get(&workspace) {
            let _ = sender.send(poke);
        }
    }

    /// Pokes one workspace's streams for a commit, stamped with the current
    /// epoch, or a wildcard when it is unknown or the notification carried no
    /// txid. The epoch stays locked while the poke is queued, so a rotation
    /// cannot slip between stamping and sending.
    pub fn notify(&self, workspace: Uuid, txid: Option<i64>) {
        let epoch = self.epoch();
        let poke = match (*epoch, txid) {
            (Some(epoch), Some(txid)) => Poke::Commit { epoch, txid },
            _ => Poke::Wildcard,
        };
        self.poke(workspace, poke);
    }

    /// Pokes every open stream, for gaps in what the listener saw.
    pub fn poke_all(&self) {
        for sender in self.channels().values() {
            let _ = sender.send(Poke::Wildcard);
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
    receiver: Option<broadcast::Receiver<Poke>>,
}

impl Subscription {
    /// The next poke, or `None` once the channel closes. A lagged receiver
    /// missed pokes of unknown content, so it gets a wildcard.
    pub async fn recv(&mut self) -> Option<Poke> {
        match self.receiver.as_mut()?.recv().await {
            Ok(poke) => Some(poke),
            Err(broadcast::error::RecvError::Lagged(_)) => Some(Poke::Wildcard),
            Err(broadcast::error::RecvError::Closed) => None,
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
/// it through the hub. The pool is only watched for shutdown. A database
/// that changes history, as a restore or failover does, drops this
/// connection, and every reconnect checks the history again before relaying.
pub fn spawn_listener(
    store: Store,
    database_url: String,
    reconnect_delay: Duration,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move { run(&store, &database_url, reconnect_delay).await })
}

async fn connect(database_url: &str) -> Result<PgListener, sqlx::Error> {
    let mut listener = PgListener::connect(database_url).await?;
    // The task owns reconnects; a failed eager reconnect must not silently
    // recover on a later `try_recv` without a wildcard.
    listener.eager_reconnect(false);
    Ok(listener)
}

async fn run(store: &Store, database_url: &str, delay: Duration) {
    let initial = if delay.is_zero() {
        Duration::from_millis(10)
    } else {
        delay
    };
    let mut backoff = initial;
    loop {
        match listen(store, database_url).await {
            Attempt::PoolClosed => return,
            Attempt::Relayed => backoff = initial,
            Attempt::Failed => {}
        }
        // Commits are wildcards until the history is checked on the next
        // connection, so no txid is stamped with an epoch from before it.
        store.sync_pokes.withdraw_epoch();
        if pause(&store.pool, backoff).await.is_break() {
            return;
        }
        backoff = std::cmp::min(backoff.saturating_mul(2), MAX_RECONNECT_DELAY);
    }
}

/// How one connection attempt ended.
enum Attempt {
    PoolClosed,
    /// Connecting or checking the history failed.
    Failed,
    /// The connection came up and relayed until it dropped.
    Relayed,
}

/// One listener connection: connect, check the database's history, then relay.
async fn listen(store: &Store, database_url: &str) -> Attempt {
    let listener = match open(store, database_url).await {
        Ok(listener) => listener,
        Err(attempt) => return attempt,
    };
    // After every successful LISTEN, including the first: notifications may
    // have been lost while disconnected.
    store.sync_pokes.poke_all();
    match relay(&store.pool, listener, &store.sync_pokes).await {
        ControlFlow::Break(()) => Attempt::PoolClosed,
        ControlFlow::Continue(()) => Attempt::Relayed,
    }
}

/// Connects, adopts the database's history, publishes its epoch and starts
/// listening. The epoch is read on the listening connection, so it names the
/// history the notifications come from. Only this task publishes, in
/// connection order, so a slower adoption elsewhere can never put back an
/// epoch a rotation replaced.
async fn open(store: &Store, database_url: &str) -> Result<PgListener, Attempt> {
    let pool = &store.pool;
    // Race connection establishment against the request pool's close
    // signal: `connect` opens its own dedicated connection and would
    // otherwise wait out network stalls past pool shutdown.
    let connected = tokio::select! {
        biased;
        _ = pool.close_event() => return Err(Attempt::PoolClosed),
        result = connect(database_url) => result,
    };
    let mut listener = connected.map_err(|error| {
        tracing::warn!(error = %error, "sync events listen failed; retrying");
        Attempt::Failed
    })?;
    tracing::info!("sync events listener connected");
    let started = tokio::select! {
        biased;
        _ = pool.close_event() => return Err(Attempt::PoolClosed),
        result = start(store, &mut listener) => result,
    };
    match started {
        Ok(epoch) => store.sync_pokes.publish_epoch(epoch),
        Err(error) => {
            tracing::warn!(error = %error, "sync events listen failed; retrying");
            return Err(Attempt::Failed);
        }
    }
    Ok(listener)
}

/// Adopts the database's history, reads its epoch on `listener` and starts
/// listening. Fails when the request pool reached another history than the
/// listener.
async fn start(store: &Store, listener: &mut PgListener) -> crate::error::Result<Uuid> {
    store.adopt_sync_history().await?;
    let epoch =
        sqlx::query_scalar!("SELECT epoch FROM sync_history WHERE cluster = sync_identity()")
            .fetch_optional(&mut *listener)
            .await?
            .ok_or_else(|| {
                crate::error::Error::ServiceUnavailable(
                    "the listener reached another database history".into(),
                )
            })?;
    listener.listen("blackwall_changes").await?;
    Ok(epoch)
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

/// Payloads are `workspace_id:txid`. A bare workspace id, which an older
/// `mark_change` sends, pokes that workspace without a txid.
fn parse_payload(payload: &str) -> Option<(Uuid, Option<i64>)> {
    let (workspace, txid) = match payload.split_once(':') {
        Some((workspace, txid)) => (workspace, Some(txid.parse().ok()?)),
        None => (payload, None),
    };
    Some((workspace.parse().ok()?, txid))
}

fn relay_payload(hub: &PokeHub, payload: &str) {
    match parse_payload(payload) {
        Some((workspace, txid)) if !workspace.is_nil() => hub.notify(workspace, txid),
        Some(_) => hub.poke_all(),
        None => {
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
    use super::{Poke, PokeHub, SYNC_EVENTS_CHANNEL, parse_payload};
    use std::sync::Arc;
    use tokio::sync::broadcast::error::TryRecvError;
    use uuid::Uuid;

    const EPOCH: Uuid = Uuid::from_u128(1);

    fn commit(txid: i64) -> Poke {
        Poke::Commit { epoch: EPOCH, txid }
    }

    #[tokio::test]
    async fn lagging_in_one_workspace_leaves_another_alone() {
        let hub = Arc::new(PokeHub::default());
        let (busy, quiet) = (Uuid::new_v4(), Uuid::new_v4());
        let mut lagging = hub.subscribe(busy);
        let mut bystander = hub.subscribe(quiet);

        for txid in 0..=SYNC_EVENTS_CHANNEL as i64 {
            hub.poke(busy, commit(txid));
        }

        assert_eq!(lagging.recv().await, Some(Poke::Wildcard));
        let receiver = bystander.receiver.as_mut().unwrap();
        assert!(matches!(receiver.try_recv(), Err(TryRecvError::Empty)));
    }

    #[tokio::test]
    async fn poke_all_reaches_every_workspace() {
        let hub = Arc::new(PokeHub::default());
        let mut first = hub.subscribe(Uuid::new_v4());
        let mut second = hub.subscribe(Uuid::new_v4());

        hub.poke_all();

        assert_eq!(first.recv().await, Some(Poke::Wildcard));
        assert_eq!(second.recv().await, Some(Poke::Wildcard));
    }

    #[tokio::test]
    async fn channel_lives_while_a_workspace_has_subscribers() {
        let hub = Arc::new(PokeHub::default());
        let workspace = Uuid::new_v4();
        let first = hub.subscribe(workspace);
        let mut second = hub.subscribe(workspace);
        assert_eq!(hub.subscriber_count(), 2);

        drop(first);
        hub.poke(workspace, commit(7));
        assert_eq!(second.recv().await, Some(commit(7)));

        drop(second);
        assert_eq!(hub.subscriber_count(), 0);
        assert!(hub.channels().is_empty());

        let mut again = hub.subscribe(workspace);
        hub.poke(workspace, commit(8));
        assert_eq!(again.recv().await, Some(commit(8)));
    }

    #[test]
    fn merge_keeps_the_highest_txid_and_a_wildcard_wins() {
        assert_eq!(commit(5).merge(commit(9)), commit(9));
        assert_eq!(commit(9).merge(commit(5)), commit(9));
        assert_eq!(commit(5).merge(Poke::Wildcard), Poke::Wildcard);
        assert_eq!(Poke::Wildcard.merge(commit(5)), Poke::Wildcard);
    }

    #[test]
    fn commits_from_different_epochs_merge_into_a_wildcard() {
        let other = Poke::Commit {
            epoch: Uuid::from_u128(2),
            txid: 9,
        };
        assert_eq!(commit(5).merge(other), Poke::Wildcard);
        assert_eq!(other.merge(commit(5)), Poke::Wildcard);
    }

    #[tokio::test]
    async fn notify_stamps_the_published_epoch_and_withdrawal_makes_wildcards() {
        let hub = Arc::new(PokeHub::default());
        let workspace = Uuid::new_v4();
        let mut stream = hub.subscribe(workspace);

        hub.notify(workspace, Some(5));
        assert_eq!(stream.recv().await, Some(Poke::Wildcard));

        hub.publish_epoch(EPOCH);
        hub.notify(workspace, Some(6));
        assert_eq!(stream.recv().await, Some(commit(6)));
        hub.notify(workspace, None);
        assert_eq!(stream.recv().await, Some(Poke::Wildcard));

        hub.withdraw_epoch();
        hub.notify(workspace, Some(7));
        assert_eq!(stream.recv().await, Some(Poke::Wildcard));

        let rotated = Uuid::from_u128(2);
        hub.publish_epoch(rotated);
        hub.notify(workspace, Some(8));
        assert_eq!(
            stream.recv().await,
            Some(Poke::Commit {
                epoch: rotated,
                txid: 8
            })
        );
    }

    #[test]
    fn payload_carries_workspace_and_txid() {
        let workspace = Uuid::new_v4();
        assert_eq!(
            parse_payload(&format!("{workspace}:812")),
            Some((workspace, Some(812)))
        );
        assert_eq!(
            parse_payload(&workspace.to_string()),
            Some((workspace, None))
        );
        assert_eq!(
            parse_payload(&Uuid::nil().to_string()),
            Some((Uuid::nil(), None))
        );
        for bad in [
            String::new(),
            "nope".to_owned(),
            format!("{workspace}:"),
            format!("{workspace}:x"),
            format!("{workspace}:1:2"),
            ":5".to_owned(),
        ] {
            assert_eq!(parse_payload(&bad), None, "{bad:?}");
        }
    }
}
