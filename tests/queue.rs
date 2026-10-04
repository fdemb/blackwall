mod support;

use blackwall::{
    jobs::{self, Email, Grant, Job, Mailer, WorkerConfig},
    store::{NewJob, Outbox, Store},
};
use sqlx::Row;
use std::{collections::HashSet, time::Duration};
use tokio::{
    sync::{mpsc, watch},
    task::JoinSet,
};
use uuid::Uuid;

fn email(key: impl Into<String>) -> NewJob {
    NewJob::now(
        key,
        Job::Email(Email {
            to: "queue@example.com".into(),
            subject: "reset".into(),
            token: "secret".into(),
            grant: Grant::Reset {
                user_id: Uuid::new_v4(),
                token_hash: "hash".into(),
            },
        }),
    )
}

async fn enqueue(store: &Store, count: usize) {
    let mut tx = store.pool.begin().await.unwrap();
    for i in 0..count {
        Outbox::insert(&mut tx, &email(format!("job-{i}")))
            .await
            .unwrap();
    }
    tx.commit().await.unwrap();
}

async fn state(store: &Store, id: Uuid) -> String {
    sqlx::query_scalar("SELECT state FROM jobs WHERE id=$1")
        .bind(id)
        .fetch_one(&store.pool)
        .await
        .unwrap()
}

async fn wait_state(store: &Store, id: Uuid, expected: &str) {
    tokio::time::timeout(Duration::from_secs(5), async {
        while state(store, id).await != expected {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
}

async fn malformed(store: &Store, kind: &str, queue: &str, version: i32) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO jobs(id,kind,queue,payload_version,payload) VALUES($1,$2,$3,$4,'{}')")
        .bind(id)
        .bind(kind)
        .bind(queue)
        .bind(version)
        .execute(&store.pool)
        .await
        .unwrap();
    id
}

#[tokio::test]
async fn enqueue_and_notifications_are_transactional_and_deduplicated() {
    let db = support::TestDatabase::new().await;
    let store = Store::connect(&db.url).await.unwrap();

    let mut listener = store.outbox.listen().await.unwrap();

    let mut tx = store.pool.begin().await.unwrap();
    sqlx::query("INSERT INTO workspaces(id,name) VALUES($1,'rollback')")
        .bind(Uuid::new_v4())
        .execute(&mut *tx)
        .await
        .unwrap();
    Outbox::insert(&mut tx, &email("atomic")).await.unwrap();
    assert!(
        tokio::time::timeout(Duration::from_millis(100), listener.recv())
            .await
            .is_err()
    );
    tx.rollback().await.unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM jobs")
            .fetch_one(&store.pool)
            .await
            .unwrap(),
        0
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM workspaces")
            .fetch_one(&store.pool)
            .await
            .unwrap(),
        0
    );

    let mut tx = store.pool.begin().await.unwrap();
    Outbox::insert(&mut tx, &email("atomic")).await.unwrap();
    Outbox::insert(&mut tx, &email("atomic")).await.unwrap();
    tx.commit().await.unwrap();
    let notification = tokio::time::timeout(Duration::from_secs(2), listener.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(notification.channel(), "blackwall_jobs");
    assert!(notification.payload().is_empty());
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM jobs")
            .fetch_one(&store.pool)
            .await
            .unwrap(),
        1
    );
    drop(listener);

    store.pool.close().await;
    db.cleanup().await;
}

#[tokio::test]
async fn competing_claims_skip_locked_rows_and_respect_available_slots() {
    let db = support::TestDatabase::new().await;
    let store = Store::connect(&db.url).await.unwrap();
    enqueue(&store, 41).await;

    let mut lock = store.pool.begin().await.unwrap();
    let locked: Uuid = sqlx::query_scalar("SELECT id FROM jobs ORDER BY id LIMIT 1 FOR UPDATE")
        .fetch_one(&mut *lock)
        .await
        .unwrap();
    assert!(store.outbox.claim("email", 0).await.unwrap().is_empty());

    let mut tasks = JoinSet::new();
    for _ in 0..10 {
        let queue = store.outbox.clone();
        tasks.spawn(async move { queue.claim("email", 4).await.unwrap() });
    }

    let mut ids = HashSet::new();
    while let Some(result) = tasks.join_next().await {
        let claims = result.unwrap();
        assert_eq!(claims.len(), 4);
        for claim in claims {
            assert_eq!(claim.attempts, 1);
            assert!(ids.insert(claim.id));
            assert_ne!(claim.id, locked);
        }
    }
    assert_eq!(ids.len(), 40);
    lock.rollback().await.unwrap();
    assert_eq!(store.outbox.claim("email", 1).await.unwrap()[0].id, locked);
    let leases: bool = sqlx::query_scalar(
        "SELECT bool_and(\
             lease_expires_at > clock_timestamp() + interval '115 seconds' \
             AND lease_expires_at <= clock_timestamp() + interval '120 seconds'\
         ) FROM jobs",
    )
    .fetch_one(&store.pool)
    .await
    .unwrap();
    assert!(leases);

    store.pool.close().await;
    db.cleanup().await;
}

#[tokio::test]
async fn expired_leases_reclaim_with_new_tokens_and_fence_stale_workers() {
    let db = support::TestDatabase::new().await;
    let store = Store::connect(&db.url).await.unwrap();
    enqueue(&store, 1).await;

    let first = store.outbox.claim_next().await.unwrap().unwrap();
    assert!(store.outbox.renew(&first).await.unwrap());
    sqlx::query(
        "UPDATE jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
    )
    .bind(first.id)
    .execute(&store.pool)
    .await
    .unwrap();
    assert!(!store.outbox.complete(&first).await.unwrap());
    assert!(!store.outbox.renew(&first).await.unwrap());

    let second = store.outbox.claim_next().await.unwrap().unwrap();
    assert_eq!(first.id, second.id);
    assert_ne!(first.token, second.token);
    assert_eq!(second.attempts, 2);
    assert!(!store.outbox.complete(&first).await.unwrap());
    assert!(!store.outbox.retry(&first, "stale").await.unwrap());
    assert!(!store.outbox.fail(&first, "stale").await.unwrap());
    assert!(
        !store
            .outbox
            .cancel(first.id, Some(first.token))
            .await
            .unwrap()
    );
    assert!(store.outbox.complete(&second).await.unwrap());

    assert_eq!(state(&store, first.id).await, "succeeded");

    store.pool.close().await;
    db.cleanup().await;
}

#[tokio::test]
async fn retries_and_crashes_stop_at_max_attempts_and_admin_retry_resets_budget() {
    let db = support::TestDatabase::new().await;
    let store = Store::connect(&db.url).await.unwrap();
    enqueue(&store, 1).await;
    sqlx::query("UPDATE jobs SET max_attempts=2")
        .execute(&store.pool)
        .await
        .unwrap();

    let first = store.outbox.claim_next().await.unwrap().unwrap();
    assert!(store.outbox.retry(&first, &"é".repeat(3000)).await.unwrap());
    let row = sqlx::query(
        "SELECT octet_length(last_error) AS len,\
         EXTRACT(EPOCH FROM run_at-clock_timestamp()) AS delay FROM jobs WHERE id=$1",
    )
    .bind(first.id)
    .fetch_one(&store.pool)
    .await
    .unwrap();
    assert_eq!(row.get::<i32, _>("len"), 2048);
    let delay: f64 = sqlx::query_scalar(
        "SELECT EXTRACT(EPOCH FROM run_at-clock_timestamp())::double precision \
         FROM jobs WHERE id=$1",
    )
    .bind(first.id)
    .fetch_one(&store.pool)
    .await
    .unwrap();
    assert!((28.0..=38.0).contains(&delay));
    assert!(store.outbox.claim_next().await.unwrap().is_none());
    sqlx::query("UPDATE jobs SET run_at=clock_timestamp() WHERE id=$1")
        .bind(first.id)
        .execute(&store.pool)
        .await
        .unwrap();

    let second = store.outbox.claim_next().await.unwrap().unwrap();
    assert_eq!(second.attempts, 2);
    sqlx::query(
        "UPDATE jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
    )
    .bind(second.id)
    .execute(&store.pool)
    .await
    .unwrap();
    assert!(store.outbox.claim_next().await.unwrap().is_none());

    assert_eq!(state(&store, second.id).await, "failed");
    assert!(store.outbox.retry_failed(second.id).await.unwrap());

    let retried = store.outbox.claim_next().await.unwrap().unwrap();
    assert_eq!(retried.attempts, 1);
    assert!(store.outbox.fail(&retried, "permanent").await.unwrap());

    assert_eq!(state(&store, retried.id).await, "failed");
    assert!(!store.outbox.retry_failed(Uuid::new_v4()).await.unwrap());

    store.pool.close().await;
    db.cleanup().await;
}

#[tokio::test]
async fn cancellation_invalidates_current_ownership_and_payloads_are_bounded() {
    let db = support::TestDatabase::new().await;
    let store = Store::connect(&db.url).await.unwrap();
    enqueue(&store, 2).await;

    let claim = store.outbox.claim_next().await.unwrap().unwrap();
    assert!(!store.outbox.cancel(claim.id, None).await.unwrap());
    assert!(
        store
            .outbox
            .cancel(claim.id, Some(claim.token))
            .await
            .unwrap()
    );
    assert!(!store.outbox.complete(&claim).await.unwrap());
    assert!(!store.outbox.retry(&claim, "cancelled").await.unwrap());

    let pending: Uuid = sqlx::query_scalar("SELECT id FROM jobs WHERE state='pending'")
        .fetch_one(&store.pool)
        .await
        .unwrap();
    assert!(store.outbox.cancel(pending, None).await.unwrap());
    assert!(store.outbox.claim_next().await.unwrap().is_none());

    let mut too_big = email("large");
    if let Job::Email(email) = &mut too_big.job {
        email.subject = "x".repeat(256 * 1024);
    }

    let mut tx = store.pool.begin().await.unwrap();
    assert!(Outbox::insert(&mut tx, &too_big).await.is_err());
    tx.rollback().await.unwrap();
    assert!(
        sqlx::query(
            "INSERT INTO jobs(id,kind,queue,payload) \
             VALUES($1,'email','email',jsonb_build_object('large',repeat('x',262144)))",
        )
        .bind(Uuid::new_v4())
        .execute(&store.pool)
        .await
        .is_err()
    );

    store.pool.close().await;
    db.cleanup().await;
}

#[tokio::test]
async fn database_effects_and_completion_rollback_together() {
    let db = support::TestDatabase::new().await;
    let store = Store::connect(&db.url).await.unwrap();
    enqueue(&store, 1).await;

    let claim = store.outbox.claim_next().await.unwrap().unwrap();

    let workspace = Uuid::new_v4();

    let mut tx = store.pool.begin().await.unwrap();
    sqlx::query("SELECT id FROM jobs WHERE id=$1 AND claim_token=$2 FOR UPDATE")
        .bind(claim.id)
        .bind(claim.token)
        .fetch_one(&mut *tx)
        .await
        .unwrap();
    sqlx::query("INSERT INTO workspaces(id,name) VALUES($1,'atomic effect')")
        .bind(workspace)
        .execute(&mut *tx)
        .await
        .unwrap();
    assert!(Outbox::complete_in(&mut tx, &claim).await.unwrap());
    tx.rollback().await.unwrap();

    assert_eq!(state(&store, claim.id).await, "running");
    assert!(
        !sqlx::query_scalar::<_, bool>("SELECT EXISTS(SELECT 1 FROM workspaces WHERE id=$1)")
            .bind(workspace)
            .fetch_one(&store.pool)
            .await
            .unwrap()
    );

    let mut tx = store.pool.begin().await.unwrap();
    sqlx::query("INSERT INTO workspaces(id,name) VALUES($1,'atomic effect')")
        .bind(workspace)
        .execute(&mut *tx)
        .await
        .unwrap();
    assert!(Outbox::complete_in(&mut tx, &claim).await.unwrap());
    tx.commit().await.unwrap();

    assert_eq!(state(&store, claim.id).await, "succeeded");
    assert!(
        sqlx::query_scalar::<_, bool>("SELECT EXISTS(SELECT 1 FROM workspaces WHERE id=$1)")
            .bind(workspace)
            .fetch_one(&store.pool)
            .await
            .unwrap()
    );

    store.pool.close().await;
    db.cleanup().await;
}

#[tokio::test]
async fn worker_pauses_email_and_fails_malformed_and_unversioned_payloads() {
    let db = support::TestDatabase::new().await;
    let store = Store::connect(&db.url).await.unwrap();
    enqueue(&store, 1).await;

    let bad = malformed(&store, "webhook", "webhook", 1).await;
    let version = malformed(&store, "webhook", "webhook", 2).await;
    let unknown = malformed(&store, "future", "webhook", 1).await;
    jobs::tick(&store, &Mailer::Disabled).await.unwrap();
    for id in [bad, version, unknown] {
        assert_eq!(state(&store, id).await, "failed");
    }

    let paused: i32 = sqlx::query_scalar("SELECT attempts FROM jobs WHERE kind='email'")
        .fetch_one(&store.pool)
        .await
        .unwrap();
    assert_eq!(paused, 0);

    store.pool.close().await;
    db.cleanup().await;
}

#[tokio::test]
async fn polling_and_listener_reconnection_recover_lost_wakeups() {
    let db = support::TestDatabase::new().await;
    let store = Store::connect(&db.url).await.unwrap();

    let (stop, shutdown) = watch::channel(false);

    let config = WorkerConfig {
        poll_interval: Duration::from_millis(100),
        ..WorkerConfig::default()
    };

    let worker = tokio::spawn(jobs::run_with_config(
        store.clone(),
        Mailer::Disabled,
        shutdown,
        config,
    ));
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let killed: Vec<bool> = sqlx::query_scalar(
                "SELECT pg_terminate_backend(pid) FROM pg_stat_activity \
                 WHERE datname=current_database() AND pid<>pg_backend_pid() \
                 AND query LIKE 'LISTEN %'",
            )
            .fetch_all(&store.pool)
            .await
            .unwrap();

            if !killed.is_empty() {
                assert!(killed.into_iter().all(|k| k));
                break;
            }

            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();

    let id = malformed(&store, "webhook", "webhook", 1).await;
    wait_state(&store, id, "failed").await;
    let next = malformed(&store, "webhook", "webhook", 1).await;
    wait_state(&store, next, "failed").await;

    stop.send(true).unwrap();
    tokio::time::timeout(Duration::from_secs(2), worker)
        .await
        .unwrap()
        .unwrap()
        .unwrap();

    store.pool.close().await;
    db.cleanup().await;
}

async fn smtp_hold(
    listener: tokio::net::TcpListener,
    started: mpsc::Sender<()>,
    mut release: watch::Receiver<bool>,
) -> String {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

    let (stream, _) = listener.accept().await.unwrap();
    let (read, mut write) = stream.into_split();
    let mut lines = BufReader::new(read).lines();
    write.write_all(b"220 sink ESMTP\r\n").await.unwrap();
    let mut data = None::<String>;
    while let Some(line) = lines.next_line().await.unwrap() {
        if let Some(message) = &mut data {
            if line == "." {
                started.send(()).await.unwrap();
                let _ = release.wait_for(|done| *done).await;
                write.write_all(b"250 queued\r\n").await.unwrap();
                return data.unwrap();
            }
            message.push_str(&line);
            message.push('\n');
            continue;
        }
        let reply: &[u8] = match line.to_ascii_uppercase().get(..4) {
            Some("EHLO") => b"250-sink\r\n250 8BITMIME\r\n",
            Some("DATA") => {
                data = Some(String::new());
                b"354 go ahead\r\n"
            }
            _ => b"250 ok\r\n",
        };
        write.write_all(reply).await.unwrap();
    }
    panic!("SMTP closed before DATA");
}

#[tokio::test]
async fn shutdown_drains_inflight_delivery_without_claiming_more() {
    use lettre::{AsyncSmtpTransport, Tokio1Executor};

    let db = support::TestDatabase::new().await;
    let store = Store::connect(&db.url).await.unwrap();

    let user = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO users(id,email,password_hash,profile) \
         VALUES($1,'queue@example.com','hash','{}')",
    )
    .bind(user)
    .execute(&store.pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO password_resets(token_hash,user_id,expires_at) \
         VALUES('hash',$1,clock_timestamp()+interval '1 hour')",
    )
    .bind(user)
    .execute(&store.pool)
    .await
    .unwrap();

    let mut tx = store.pool.begin().await.unwrap();
    for i in 0..3 {
        let mut job = email(format!("drain-{i}"));
        if let Job::Email(email) = &mut job.job {
            email.grant = Grant::Reset {
                user_id: user,
                token_hash: "hash".into(),
            };
        }
        Outbox::insert(&mut tx, &job).await.unwrap();
    }
    tx.commit().await.unwrap();

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let (started_tx, mut started_rx) = mpsc::channel(1);
    let (release_tx, release_rx) = watch::channel(false);

    let sink = tokio::spawn(smtp_hold(listener, started_tx, release_rx));

    let mailer = Mailer::Smtp {
        transport: AsyncSmtpTransport::<Tokio1Executor>::builder_dangerous("127.0.0.1")
            .port(port)
            .build(),
        from: "Blackwall <noreply@example.com>".parse().unwrap(),
    };

    let (stop, shutdown) = watch::channel(false);

    let config = WorkerConfig {
        email_concurrency: 1,
        poll_interval: Duration::from_millis(50),
        drain_timeout: Duration::from_secs(2),
        ..WorkerConfig::default()
    };

    let worker = tokio::spawn(jobs::run_with_config(
        store.clone(),
        mailer,
        shutdown,
        config,
    ));
    tokio::time::timeout(Duration::from_secs(5), started_rx.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM jobs WHERE state='running'")
            .fetch_one(&store.pool)
            .await
            .unwrap(),
        1
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM jobs WHERE state='pending'")
            .fetch_one(&store.pool)
            .await
            .unwrap(),
        2
    );

    let id: Uuid = sqlx::query_scalar("SELECT id FROM jobs WHERE state='running'")
        .fetch_one(&store.pool)
        .await
        .unwrap();

    stop.send(true).unwrap();
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(!worker.is_finished());
    release_tx.send(true).unwrap();
    tokio::time::timeout(Duration::from_secs(3), worker)
        .await
        .unwrap()
        .unwrap()
        .unwrap();

    let data = sink.await.unwrap();
    assert!(data.contains(&format!(
        "Message-ID: <{}@example.com>",
        blackwall::auth::hash(&id.to_string())
    )));

    assert_eq!(state(&store, id).await, "succeeded");
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM jobs WHERE attempts=0 AND state='pending'"
        )
        .fetch_one(&store.pool)
        .await
        .unwrap(),
        2
    );

    store.pool.close().await;
    db.cleanup().await;
}

#[tokio::test]
async fn retention_keeps_failed_jobs_and_unfinished_claims() {
    let db = support::TestDatabase::new().await;
    let store = Store::connect(&db.url).await.unwrap();
    enqueue(&store, 3).await;

    let done = store.outbox.claim_next().await.unwrap().unwrap();
    store.outbox.complete(&done).await.unwrap();
    let failed = store.outbox.claim_next().await.unwrap().unwrap();
    store.outbox.fail(&failed, "permanent").await.unwrap();

    let running = store.outbox.claim_next().await.unwrap().unwrap();
    sqlx::query(
        "UPDATE jobs SET finished_at=clock_timestamp()-interval '31 days' \
         WHERE finished_at IS NOT NULL",
    )
    .execute(&store.pool)
    .await
    .unwrap();
    assert_eq!(store.outbox.cleanup(30).await.unwrap(), 1);

    assert_eq!(state(&store, failed.id).await, "failed");

    assert_eq!(state(&store, running.id).await, "running");
    assert!(store.outbox.cleanup(0).await.is_err());

    store.pool.close().await;
    db.cleanup().await;
}

#[tokio::test]
async fn repeated_crashes_exhaust_the_attempt_budget() {
    let db = support::TestDatabase::new().await;
    let store = Store::connect(&db.url).await.unwrap();
    enqueue(&store, 1).await;
    sqlx::query("UPDATE jobs SET max_attempts=3")
        .execute(&store.pool)
        .await
        .unwrap();

    let mut previous = None;
    for attempt in 1..=3 {
        let claim = store.outbox.claim_next().await.unwrap().unwrap();
        assert_eq!(claim.attempts, attempt);
        if let Some(token) = previous {
            assert_ne!(claim.token, token);
        }
        previous = Some(claim.token);
        sqlx::query(
            "UPDATE jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
        )
        .bind(claim.id)
        .execute(&store.pool)
        .await
        .unwrap();
    }
    assert!(store.outbox.claim_next().await.unwrap().is_none());
    assert_eq!(
        sqlx::query_scalar::<_, String>("SELECT state FROM jobs")
            .fetch_one(&store.pool)
            .await
            .unwrap(),
        "failed"
    );

    store.pool.close().await;
    db.cleanup().await;
}

#[tokio::test]
async fn permanent_webhook_errors_fail_once_and_disabled_grants_skip_delivery() {
    use blackwall::jobs::Webhook;

    let db = support::TestDatabase::new().await;
    let store = Store::connect(&db.url).await.unwrap();

    let workspace = Uuid::new_v4();
    let integration = Uuid::new_v4();
    sqlx::query("INSERT INTO workspaces(id,name) VALUES($1,'webhooks')")
        .bind(workspace)
        .execute(&store.pool)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO integrations(id,workspace_id,name,webhook_url,secret,enabled) \
         VALUES($1,$2,'test','http://example.com','secret',true)",
    )
    .bind(integration)
    .bind(workspace)
    .execute(&store.pool)
    .await
    .unwrap();

    let webhook = Job::Webhook(Webhook {
        workspace_id: workspace,
        integration_id: integration,
        url: "http://example.com".into(),
        secret: "secret".into(),
        event: serde_json::json!({"change":true}),
    });

    let mut tx = store.pool.begin().await.unwrap();
    Outbox::insert(&mut tx, &NewJob::now("invalid-webhook", webhook.clone()))
        .await
        .unwrap();
    tx.commit().await.unwrap();
    jobs::tick(&store, &Mailer::Disabled).await.unwrap();

    let failed: Uuid = sqlx::query_scalar("SELECT id FROM jobs WHERE dedup_key='invalid-webhook'")
        .fetch_one(&store.pool)
        .await
        .unwrap();

    assert_eq!(state(&store, failed).await, "failed");
    assert_eq!(
        sqlx::query_scalar::<_, i32>("SELECT attempts FROM jobs WHERE id=$1")
            .bind(failed)
            .fetch_one(&store.pool)
            .await
            .unwrap(),
        1
    );
    sqlx::query("UPDATE integrations SET enabled=false WHERE id=$1")
        .bind(integration)
        .execute(&store.pool)
        .await
        .unwrap();

    let mut tx = store.pool.begin().await.unwrap();
    Outbox::insert(&mut tx, &NewJob::now("disabled-webhook", webhook))
        .await
        .unwrap();
    tx.commit().await.unwrap();
    jobs::tick(&store, &Mailer::Disabled).await.unwrap();

    let skipped: Uuid =
        sqlx::query_scalar("SELECT id FROM jobs WHERE dedup_key='disabled-webhook'")
            .fetch_one(&store.pool)
            .await
            .unwrap();

    assert_eq!(state(&store, skipped).await, "succeeded");

    store.pool.close().await;
    db.cleanup().await;
}

#[tokio::test]
async fn drain_deadline_abandons_lease_for_restart_recovery() {
    use lettre::{AsyncSmtpTransport, Tokio1Executor};

    let db = support::TestDatabase::new().await;
    let store = Store::connect(&db.url).await.unwrap();

    let user = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO users(id,email,password_hash,profile) \
         VALUES($1,'queue@example.com','hash','{}')",
    )
    .bind(user)
    .execute(&store.pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO password_resets(token_hash,user_id,expires_at) \
         VALUES('hash',$1,clock_timestamp()+interval '1 hour')",
    )
    .bind(user)
    .execute(&store.pool)
    .await
    .unwrap();

    let mut job = email("abandon");
    if let Job::Email(email) = &mut job.job {
        email.grant = Grant::Reset {
            user_id: user,
            token_hash: "hash".into(),
        };
    }

    let mut tx = store.pool.begin().await.unwrap();
    Outbox::insert(&mut tx, &job).await.unwrap();
    tx.commit().await.unwrap();

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let (started_tx, mut started_rx) = mpsc::channel(1);
    let (_release_tx, release_rx) = watch::channel(false);

    let sink = tokio::spawn(smtp_hold(listener, started_tx, release_rx));

    let mailer = Mailer::Smtp {
        transport: AsyncSmtpTransport::<Tokio1Executor>::builder_dangerous("127.0.0.1")
            .port(port)
            .build(),
        from: "Blackwall <noreply@example.com>".parse().unwrap(),
    };

    let (stop, shutdown) = watch::channel(false);

    let config = WorkerConfig {
        email_concurrency: 1,
        poll_interval: Duration::from_millis(50),
        drain_timeout: Duration::from_secs(1),
        ..WorkerConfig::default()
    };

    let worker = tokio::spawn(jobs::run_with_config(
        store.clone(),
        mailer,
        shutdown,
        config,
    ));
    tokio::time::timeout(Duration::from_secs(5), started_rx.recv())
        .await
        .unwrap()
        .unwrap();
    // A blocked email slot must not block the separate webhook queue.
    let webhook = malformed(&store, "webhook", "webhook", 1).await;
    wait_state(&store, webhook, "failed").await;

    stop.send(true).unwrap();
    tokio::time::timeout(Duration::from_secs(3), worker)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let abandoned: Uuid = sqlx::query_scalar("SELECT id FROM jobs WHERE kind='email'")
        .fetch_one(&store.pool)
        .await
        .unwrap();

    assert_eq!(state(&store, abandoned).await, "running");
    sink.abort();
    let _ = sink.await;
    sqlx::query(
        "UPDATE jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
    )
    .bind(abandoned)
    .execute(&store.pool)
    .await
    .unwrap();

    let spool = std::env::temp_dir().join(format!("blackwall-queue-spool-{}", Uuid::new_v4()));
    jobs::tick(&store, &Mailer::Spool(spool.clone()))
        .await
        .unwrap();

    assert_eq!(state(&store, abandoned).await, "succeeded");
    assert_eq!(
        sqlx::query_scalar::<_, i32>("SELECT attempts FROM jobs WHERE id=$1")
            .bind(abandoned)
            .fetch_one(&store.pool)
            .await
            .unwrap(),
        2
    );

    let payload = tokio::fs::read(spool.join(format!(
        "{}.json",
        blackwall::auth::hash(&abandoned.to_string())
    )))
    .await
    .unwrap();
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&payload).unwrap()["to"],
        "queue@example.com"
    );
    tokio::fs::remove_dir_all(spool).await.unwrap();

    store.pool.close().await;
    db.cleanup().await;
}
