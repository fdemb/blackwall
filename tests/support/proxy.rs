#![allow(dead_code)]

use sqlx::ConnectOptions;
use std::str::FromStr;
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use tokio::net::{TcpListener, TcpStream};

/// Tiny TCP proxy for listener failure injection without database roles.
///
/// Listens on an ephemeral loopback port and forwards every connection to the
/// real PostgreSQL host and port. Tests switch it at runtime between
/// forwarding, refusing new connections (accept and immediately close), and
/// cutting existing connections (abort the active forwards). Refused and cut
/// connections surface to `PgListener` as connect and receive failures, which
/// drive its reconnect loop; nothing touches roles or grants, so the suite
/// runs with a `CREATEDB`-only role.
pub struct TestProxy {
    /// Local port clients connect to.
    pub port: u16,
    refuse: Arc<AtomicBool>,
    active: Arc<std::sync::Mutex<Vec<tokio::task::AbortHandle>>>,
    accept_task: tokio::task::JoinHandle<()>,
}

impl TestProxy {
    /// Starts forwarding to `target_host:target_port` on an ephemeral port.
    pub async fn new(target_host: String, target_port: u16) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let refuse = Arc::new(AtomicBool::new(false));
        let active: Arc<std::sync::Mutex<Vec<tokio::task::AbortHandle>>> =
            Arc::new(std::sync::Mutex::new(Vec::new()));
        let loop_refuse = refuse.clone();
        let loop_active = active.clone();
        let accept_task = tokio::spawn(async move {
            loop {
                let (client, _) = match listener.accept().await {
                    Ok(accepted) => accepted,
                    Err(_) => break,
                };
                if loop_refuse.load(Ordering::SeqCst) {
                    drop(client);
                    continue;
                }
                let server = match TcpStream::connect((target_host.as_str(), target_port)).await {
                    Ok(server) => server,
                    Err(_) => {
                        drop(client);
                        continue;
                    }
                };
                let handle = tokio::spawn(async move {
                    let mut client = client;
                    let mut server = server;
                    let _ = tokio::io::copy_bidirectional(&mut client, &mut server).await;
                });
                loop_active.lock().unwrap().push(handle.abort_handle());
            }
        });
        Self {
            port,
            refuse,
            active,
            accept_task,
        }
    }

    /// Forwards new connections (the default).
    pub fn forward(&self) {
        self.refuse.store(false, Ordering::SeqCst);
    }

    /// Accepts new connections and immediately closes them, so listener
    /// reconnect attempts fail without touching the database.
    pub fn refuse_new(&self) {
        self.refuse.store(true, Ordering::SeqCst);
    }

    /// Cuts every currently forwarded connection. The proxy keeps its current
    /// forwarding/refusing mode for new connections.
    pub fn disconnect_all(&self) {
        let handles: Vec<tokio::task::AbortHandle> =
            std::mem::take(&mut *self.active.lock().unwrap());
        for handle in handles {
            handle.abort();
        }
    }
}

impl Drop for TestProxy {
    fn drop(&mut self) {
        self.accept_task.abort();
        if let Ok(mut active) = self.active.lock() {
            for handle in active.drain(..) {
                handle.abort();
            }
        }
    }
}

/// PostgreSQL host and port behind a database URL.
pub fn target_from_url(url: &str) -> (String, u16) {
    let options = sqlx::postgres::PgConnectOptions::from_str(url).unwrap();
    (options.get_host().to_owned(), options.get_port())
}

/// Rewrites a database URL to connect through the proxy's local port,
/// keeping user, password and database name.
pub fn proxy_url(original_url: &str, proxy_port: u16) -> String {
    let options = sqlx::postgres::PgConnectOptions::from_str(original_url).unwrap();
    options
        .host("127.0.0.1")
        .port(proxy_port)
        .to_url_lossy()
        .to_string()
}
