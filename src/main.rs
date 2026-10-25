use blackwall::{http, jobs, store::Store};
use sqlx::Row;
use uuid::Uuid;

type MainResult = Result<(), Box<dyn std::error::Error>>;

const USAGE: &str = "blackwall [serve|worker|migrate|fixtures empty|fixtures rich|queue status|queue failed [limit]|queue retry <uuid>|queue cancel <uuid>]\nQueue administration requires shell access and DATABASE_URL credentials. Payloads are never displayed.";

#[tokio::main]
async fn main() -> MainResult {
    dotenvy::dotenv().ok();
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "blackwall=info".into()),
        )
        .init();

    let args: Vec<String> = std::env::args().skip(1).collect();
    if args
        .first()
        .is_some_and(|arg| arg == "--help" || arg == "help")
    {
        println!("{USAGE}");
        return Ok(());
    }

    let database_url = std::env::var("DATABASE_URL").map_err(|_| "DATABASE_URL is required")?;
    if !database_url.starts_with("postgres://") && !database_url.starts_with("postgresql://") {
        return Err("DATABASE_URL must use PostgreSQL".into());
    }
    // Connecting applies migrations, which is all `migrate` needs.
    let store = Store::connect(&database_url).await?;
    let result = match (args.first().map(String::as_str), args.len()) {
        (Some("migrate"), 1) => Ok(()),
        (Some("fixtures"), 2) => blackwall::fixtures::load(&store, &args[1])
            .await
            .map_err(Into::into),
        (Some("queue"), _) => queue_admin(&store, &args[1..]).await,
        (Some("worker"), 1) => run_worker(&store).await,
        (Some("serve"), 1) | (None, _) => serve(&store).await,
        _ => return Err("unknown arguments; use --help".into()),
    };
    store.pool.close().await;
    result
}

async fn run_worker(store: &Store) -> MainResult {
    let (shutdown_tx, shutdown_rx) = tokio::sync::watch::channel(false);
    let mailer = jobs::Mailer::from_env()?;
    let config = jobs::WorkerConfig::from_env()?;
    config.validate(store)?;
    tracing::info!(mail = mailer.describe(), "email delivery configured");
    if mailer.lacks_links() {
        tracing::warn!("PUBLIC_URL is unset, so emails carry tokens instead of links");
    }
    let worker = jobs::run_with_config(store.clone(), mailer, shutdown_rx, config);
    tokio::pin!(worker);
    tokio::select! {
        result = &mut worker => result?,
        _ = shutdown_signal() => {
            force_on_second_signal();
            let _ = shutdown_tx.send(true);
            worker.await?;
        }
    }
    Ok(())
}

async fn serve(store: &Store) -> MainResult {
    let bind = std::env::var("BIND_ADDR").unwrap_or_else(|_| "127.0.0.1:3000".into());
    let listener = tokio::net::TcpListener::bind(&bind).await?;
    let mut store = store.clone();
    store.mail_enabled = jobs::Mailer::from_env()?.enabled();
    store.registration =
        blackwall::auth::RegistrationMode::parse(std::env::var("REGISTRATION").ok().as_deref())?;

    // One change listener per HTTP process; the worker never starts one.
    let _sync_events = store.spawn_sync_events();
    let events = store.clone();
    tracing::info!(
        address = %listener.local_addr()?,
        mail = store.mail_enabled,
        registration = ?store.registration,
        "Blackwall listening"
    );
    axum::serve(
        listener,
        http::router(store.clone()).into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
    .with_graceful_shutdown(async move {
        shutdown_signal().await;
        force_on_second_signal();
        // Event streams otherwise hold graceful shutdown for their lifetime.
        events.close_sync_events();
    })
    .await?;
    Ok(())
}

async fn queue_admin(store: &Store, args: &[String]) -> MainResult {
    match (args.first().map(String::as_str), args.get(1)) {
        (Some("status"), None) => print_queue_status(store).await,
        (Some("failed"), limit) if args.len() <= 2 => print_failed_jobs(store, limit).await,
        (Some(action @ ("retry" | "cancel")), Some(id)) if args.len() == 2 => {
            change_job(store, action, id.parse()?).await
        }
        _ => Err("use queue status|failed [limit]|retry <uuid>|cancel <uuid>".into()),
    }
}

async fn print_queue_status(store: &Store) -> MainResult {
    let rows = sqlx::query(
        "SELECT queue,state,count(*) AS count,\
         COALESCE(EXTRACT(EPOCH FROM clock_timestamp()-min(run_at) \
         FILTER (WHERE state='pending' AND run_at<clock_timestamp())),0)::bigint \
         AS oldest_overdue_seconds \
         FROM jobs GROUP BY queue,state ORDER BY queue,state",
    )
    .fetch_all(&store.pool)
    .await?;

    for row in rows {
        println!(
            "{}",
            serde_json::json!({
                "queue": row.try_get::<String, _>("queue")?,
                "state": row.try_get::<String, _>("state")?,
                "count": row.try_get::<i64, _>("count")?,
                "oldest_overdue_seconds": row.try_get::<i64, _>("oldest_overdue_seconds")?,
            })
        );
    }
    Ok(())
}

async fn print_failed_jobs(store: &Store, limit: Option<&String>) -> MainResult {
    let limit = limit
        .map(|arg| arg.parse::<i64>())
        .transpose()?
        .unwrap_or(50);
    if !(1..=100).contains(&limit) {
        return Err("inspection limit must be between 1 and 100".into());
    }

    let rows = sqlx::query(
        "SELECT id,kind,attempts,max_attempts,last_error FROM jobs \
         WHERE state='failed' ORDER BY finished_at DESC,id LIMIT $1",
    )
    .bind(limit)
    .fetch_all(&store.pool)
    .await?;

    for row in rows {
        println!(
            "{}",
            serde_json::json!({
                "id": row.try_get::<Uuid, _>("id")?,
                "kind": row.try_get::<String, _>("kind")?,
                "attempts": row.try_get::<i32, _>("attempts")?,
                "max_attempts": row.try_get::<i32, _>("max_attempts")?,
                "last_error": row.try_get::<String, _>("last_error")?,
            })
        );
    }
    Ok(())
}

/// Retries a failed job or cancels a job under its current claim.
async fn change_job(store: &Store, action: &str, id: Uuid) -> MainResult {
    let changed = if action == "retry" {
        store.outbox.retry_failed(id).await?
    } else {
        let token: Option<Option<Uuid>> =
            sqlx::query_scalar("SELECT claim_token FROM jobs WHERE id=$1")
                .bind(id)
                .fetch_optional(&store.pool)
                .await?;
        match token {
            Some(token) => store.outbox.cancel(id, token).await?,
            None => false,
        }
    };

    if !changed {
        return Err("job missing or state changed; inspect status and retry command".into());
    }

    println!("{id} {action}");
    Ok(())
}

async fn shutdown_signal() {
    #[cfg(unix)]
    {
        if let Ok(mut terminate) =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        {
            tokio::select! {
                _ = tokio::signal::ctrl_c() => {},
                _ = terminate.recv() => {},
            }
            return;
        }
    }

    let _ = tokio::signal::ctrl_c().await;
}

/// Exits immediately on another Ctrl+C while graceful shutdown drains.
fn force_on_second_signal() {
    tracing::info!("shutting down; press Ctrl+C again to force");
    tokio::spawn(async {
        if tokio::signal::ctrl_c().await.is_ok() {
            tracing::warn!("forced shutdown");
            std::process::exit(130);
        }
    });
}
