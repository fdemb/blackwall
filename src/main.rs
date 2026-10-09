use blackwall::{http, jobs, store::Store};
use sqlx::Row;
use uuid::Uuid;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
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
        println!(
            "blackwall [serve|worker|migrate|fixtures empty|fixtures rich|queue status|queue failed [limit]|queue retry <uuid>|queue cancel <uuid>]\nQueue administration requires shell access and DATABASE_URL credentials. Payloads are never displayed."
        );
        return Ok(());
    }

    let database_url = std::env::var("DATABASE_URL").map_err(|_| "DATABASE_URL is required")?;
    if !database_url.starts_with("postgres://") && !database_url.starts_with("postgresql://") {
        return Err("DATABASE_URL must use PostgreSQL".into());
    }
    let store = Store::connect(&database_url).await?;

    match args.first().map(String::as_str) {
        Some("migrate") if args.len() == 1 => {
            store.pool.close().await;
            return Ok(());
        }
        Some("fixtures") if args.len() == 2 => {
            blackwall::fixtures::load(&store, &args[1]).await?;
            store.pool.close().await;
            return Ok(());
        }
        Some("queue") => {
            queue_admin(&store, &args[1..]).await?;
            store.pool.close().await;
            return Ok(());
        }
        Some("serve" | "worker") if args.len() == 1 => {}
        None => {}
        _ => return Err("unknown arguments; use --help".into()),
    }

    let (shutdown_tx, shutdown_rx) = tokio::sync::watch::channel(false);
    if args.first().is_some_and(|arg| arg == "worker") {
        let mailer = jobs::Mailer::from_env()?;
        let config = jobs::WorkerConfig::from_env()?;
        config.validate(&store)?;
        tracing::info!(mail = mailer.describe(), "email delivery configured");
        let worker = jobs::run_with_config(store.clone(), mailer, shutdown_rx, config);
        tokio::pin!(worker);
        tokio::select! {
            result = &mut worker => result?,
            _ = shutdown_signal() => {
                let _ = shutdown_tx.send(true);
                worker.await?;
            }
        }
        store.pool.close().await;
        return Ok(());
    }

    let bind = std::env::var("BIND_ADDR").unwrap_or_else(|_| "127.0.0.1:3000".into());
    let listener = tokio::net::TcpListener::bind(&bind).await?;

    // One change listener per HTTP process; the worker never starts one.
    let _sync_events = store.spawn_sync_events();
    tracing::info!(address = %listener.local_addr()?, "Blackwall listening");
    axum::serve(
        listener,
        http::router(store.clone()).into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown_signal())
    .await?;
    store.pool.close().await;

    Ok(())
}

async fn queue_admin(store: &Store, args: &[String]) -> Result<(), Box<dyn std::error::Error>> {
    match args.first().map(String::as_str) {
        Some("status") if args.len() == 1 => {
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
        }
        Some("failed") if args.len() <= 2 => {
            let limit = args
                .get(1)
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
        }
        Some("retry" | "cancel") if args.len() == 2 => {
            let id = args[1].parse::<Uuid>()?;

            let changed = if args[0] == "retry" {
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
                return Err(
                    "job missing or state changed; inspect status and retry command".into(),
                );
            }

            println!("{id} {}", args[0]);
        }
        _ => return Err("use queue status|failed [limit]|retry <uuid>|cancel <uuid>".into()),
    }

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
