mod support;

use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use blackwall::{
    auth::{Register, Session},
    http::router,
    store::{Store, StoreConfig},
    sync_events::SyncEventsConfig,
};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use std::time::Duration;
use tower::ServiceExt;
use uuid::Uuid;

async fn account(store: &Store, name: &str) -> Session {
    store
        .register(Register {
            email: format!("{name}-{}@example.com", Uuid::new_v4()),
            password: "test-password-123".into(),
            display_name: name.into(),
            invitation: None,
        })
        .await
        .unwrap()
        .session()
        .unwrap()
}

fn id(value: &Value) -> Uuid {
    Uuid::parse_str(value.as_str().unwrap()).unwrap()
}

async fn call(
    app: &axum::Router,
    user: &Session,
    method: &str,
    path: &str,
    input: Option<Value>,
) -> (StatusCode, Value) {
    let mut request = Request::builder()
        .method(method)
        .uri(path)
        .header("Authorization", format!("Bearer {}", user.token));
    let body = match input {
        Some(input) => {
            request = request.header("Content-Type", "application/json");
            Body::from(input.to_string())
        }
        None => Body::empty(),
    };
    let response = app
        .clone()
        .oneshot(request.body(body).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

async fn workspace(app: &axum::Router, owner: &Session, name: &str) -> Uuid {
    let (status, result) = call(
        app,
        owner,
        "POST",
        "/internal-api/workspaces",
        Some(json!({"name": name, "slug": Uuid::new_v4().to_string()})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{result}");
    id(&result["workspace"]["id"])
}

async fn command(
    app: &axum::Router,
    owner: &Session,
    workspace: Uuid,
    cmd: Value,
) -> (StatusCode, Value) {
    call(
        app,
        owner,
        "POST",
        &format!("/internal-api/workspaces/{workspace}/commands"),
        Some(json!({"command": cmd})),
    )
    .await
}

async fn created(app: &axum::Router, owner: &Session, workspace: Uuid, cmd: Value) -> Uuid {
    let (status, result) = command(app, owner, workspace, cmd).await;
    assert_eq!(status, StatusCode::OK, "{result}");
    id(&result["result"]["id"])
}

async fn setup(app: &axum::Router, owner: &Session) -> (Uuid, Uuid) {
    let ws = workspace(app, owner, "Sync events").await;
    let team = created(
        app,
        owner,
        ws,
        json!({"type": "create_team", "name": "Team", "key": "TEA", "members": [owner.profile.id]}),
    )
    .await;
    (ws, team)
}

fn events_config(
    coalesce: Duration,
    keepalive: Duration,
    lifetime: Duration,
    reconnect_delay: Duration,
) -> StoreConfig {
    StoreConfig {
        sync_events: SyncEventsConfig {
            coalesce,
            keepalive,
            lifetime,
            reconnect_delay,
        },
        ..StoreConfig::default()
    }
}

async fn connect_store(url: &str, config: StoreConfig) -> Store {
    let store = Store::connect_with_config(url, config).await.unwrap();
    store.spawn_sync_events();
    wait_for_listener(&store).await;
    store
}

async fn wait_for_listener(store: &Store) {
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let found: Option<i32> = sqlx::query_scalar(
                "SELECT pid FROM pg_stat_activity WHERE datname = current_database() \
                 AND query LIKE 'LISTEN%'",
            )
            .fetch_optional(&store.pool)
            .await
            .unwrap();
            if found.is_some() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("listener never started listening");
}

async fn sse_response(
    app: &axum::Router,
    token: Option<&str>,
    workspace: Uuid,
    query: &str,
) -> axum::response::Response {
    let mut request = Request::builder().method("GET").uri(format!(
        "/internal-api/workspaces/{workspace}/sync/events{query}"
    ));
    if let Some(token) = token {
        request = request.header("Authorization", format!("Bearer {token}"));
    }
    app.clone()
        .oneshot(request.body(Body::empty()).unwrap())
        .await
        .unwrap()
}

/// Next SSE data frame, or `None` on stream end or timeout.
async fn next_data(body: &mut axum::body::Body, timeout: Duration) -> Option<Vec<u8>> {
    tokio::time::timeout(timeout, async {
        loop {
            let frame = body.frame().await?;
            match frame {
                Ok(frame) => {
                    if let Ok(data) = frame.into_data() {
                        return Some(data.to_vec());
                    }
                }
                Err(_) => return None,
            }
        }
    })
    .await
    .ok()
    .flatten()
}

fn is_poke(bytes: &[u8]) -> bool {
    bytes.starts_with(b"event: poke") && bytes.windows(8).any(|w| w == b"data: {}")
}

fn is_comment(bytes: &[u8]) -> bool {
    bytes.starts_with(b":")
}

async fn drain_poke(body: &mut axum::body::Body) {
    let bytes = next_data(body, Duration::from_secs(2))
        .await
        .expect("initial poke");
    assert!(
        is_poke(&bytes),
        "expected poke, got {:?}",
        String::from_utf8_lossy(&bytes)
    );
}

/// Swallows pokes for changes committed before the stream subscribed. Their
/// notifications can reach the listener after the initial poke.
async fn settle(body: &mut axum::body::Body) {
    while let Some(bytes) = next_data(body, Duration::from_millis(500)).await {
        assert!(
            is_poke(&bytes),
            "expected poke, got {:?}",
            String::from_utf8_lossy(&bytes)
        );
    }
}

async fn expect_poke(body: &mut axum::body::Body, timeout: Duration) {
    let bytes = next_data(body, timeout).await.expect("expected poke");
    assert!(
        is_poke(&bytes),
        "expected poke, got {:?}",
        String::from_utf8_lossy(&bytes)
    );
}

async fn expect_no_data(body: &mut axum::body::Body, wait: Duration) {
    assert!(
        next_data(body, wait).await.is_none(),
        "expected silence, got a frame"
    );
}

#[tokio::test]
async fn events_sends_initial_poke() {
    let database = support::TestDatabase::new().await;
    let store = connect_store(&database.url, StoreConfig::default()).await;
    let app = router(store.clone());
    let owner = account(&store, "owner").await;
    let (ws, _) = setup(&app, &owner).await;
    let client = Uuid::new_v4();

    let response = sse_response(
        &app,
        Some(&owner.token),
        ws,
        &format!("?client_id={client}"),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()["content-type"], "text/event-stream");
    let mut body = response.into_body();
    let bytes = next_data(&mut body, Duration::from_secs(2))
        .await
        .expect("initial poke");
    assert!(is_poke(&bytes), "got {:?}", String::from_utf8_lossy(&bytes));

    drop(app);
    store.pool.close().await;
    database.cleanup().await;
}

#[tokio::test]
async fn events_poke_workspace_isolation() {
    let database = support::TestDatabase::new().await;
    let store = connect_store(&database.url, StoreConfig::default()).await;
    let app = router(store.clone());
    let owner = account(&store, "owner").await;
    let (ws_a, team_a) = setup(&app, &owner).await;
    let ws_b = workspace(&app, &owner, "Other").await;
    let client_a = Uuid::new_v4();
    let client_b = Uuid::new_v4();

    let mut body_a = sse_response(
        &app,
        Some(&owner.token),
        ws_a,
        &format!("?client_id={client_a}"),
    )
    .await
    .into_body();
    let mut body_b = sse_response(
        &app,
        Some(&owner.token),
        ws_b,
        &format!("?client_id={client_b}"),
    )
    .await
    .into_body();
    drain_poke(&mut body_a).await;
    drain_poke(&mut body_b).await;
    settle(&mut body_a).await;
    settle(&mut body_b).await;

    created(
        &app,
        &owner,
        ws_a,
        json!({"type": "create_issue", "input": {"team_id": team_a, "title": "Hello"}}),
    )
    .await;

    expect_poke(&mut body_a, Duration::from_secs(2)).await;
    expect_no_data(&mut body_b, Duration::from_millis(500)).await;

    drop(app);
    store.pool.close().await;
    database.cleanup().await;
}

#[tokio::test]
async fn events_rollback_produces_no_poke() {
    let database = support::TestDatabase::new().await;
    let store = connect_store(&database.url, StoreConfig::default()).await;
    let app = router(store.clone());
    let owner = account(&store, "owner").await;
    let (ws, _) = setup(&app, &owner).await;
    let client = Uuid::new_v4();

    let mut body = sse_response(
        &app,
        Some(&owner.token),
        ws,
        &format!("?client_id={client}"),
    )
    .await
    .into_body();
    drain_poke(&mut body).await;
    settle(&mut body).await;

    let mut tx = store.pool.begin().await.unwrap();
    let changed = Uuid::new_v4();
    sqlx::query("SELECT mark_change($1, 'issues', $2)")
        .bind(ws)
        .bind(changed)
        .execute(&mut *tx)
        .await
        .unwrap();
    tx.rollback().await.unwrap();

    expect_no_data(&mut body, Duration::from_millis(500)).await;

    drop(app);
    store.pool.close().await;
    database.cleanup().await;
}

#[tokio::test]
async fn events_single_transaction_coalesces_to_one_poke() {
    let database = support::TestDatabase::new().await;
    let store = connect_store(&database.url, StoreConfig::default()).await;
    let app = router(store.clone());
    let owner = account(&store, "owner").await;
    let (ws, _) = setup(&app, &owner).await;
    let client = Uuid::new_v4();

    let mut body = sse_response(
        &app,
        Some(&owner.token),
        ws,
        &format!("?client_id={client}"),
    )
    .await
    .into_body();
    drain_poke(&mut body).await;
    settle(&mut body).await;

    // Many changes in one transaction: PostgreSQL collapses the identical
    // notifications, so exactly one poke follows.
    let mut tx = store.pool.begin().await.unwrap();
    for _ in 0..10 {
        sqlx::query("SELECT mark_change($1, 'issues', $2)")
            .bind(ws)
            .bind(Uuid::new_v4())
            .execute(&mut *tx)
            .await
            .unwrap();
    }
    tx.commit().await.unwrap();

    expect_poke(&mut body, Duration::from_secs(2)).await;
    expect_no_data(&mut body, Duration::from_millis(500)).await;

    drop(app);
    store.pool.close().await;
    database.cleanup().await;
}

#[tokio::test]
async fn events_burst_coalesces_to_one_trailing_poke() {
    let database = support::TestDatabase::new().await;
    let store = connect_store(
        &database.url,
        events_config(
            Duration::from_millis(1500),
            Duration::from_secs(60),
            Duration::from_secs(30 * 60),
            Duration::from_secs(1),
        ),
    )
    .await;
    let app = router(store.clone());
    let owner = account(&store, "owner").await;
    let (ws, _) = setup(&app, &owner).await;
    let client = Uuid::new_v4();

    let mut body = sse_response(
        &app,
        Some(&owner.token),
        ws,
        &format!("?client_id={client}"),
    )
    .await
    .into_body();
    drain_poke(&mut body).await;

    // Five fast autocommitted notifies land inside one coalesce window:
    // exactly one trailing poke, not zero and not one per notify.
    for _ in 0..5 {
        sqlx::query("SELECT pg_notify('blackwall_changes', $1)")
            .bind(ws.to_string())
            .execute(&store.pool)
            .await
            .unwrap();
    }

    expect_poke(&mut body, Duration::from_secs(5)).await;
    expect_no_data(&mut body, Duration::from_millis(2000)).await;

    drop(app);
    store.pool.close().await;
    database.cleanup().await;
}

#[tokio::test]
async fn events_request_errors() {
    let database = support::TestDatabase::new().await;
    let store = connect_store(&database.url, StoreConfig::default()).await;
    let app = router(store.clone());
    let owner = account(&store, "owner").await;
    let member = account(&store, "member").await;
    let outsider = account(&store, "outsider").await;
    let (ws, _) = setup(&app, &owner).await;
    sqlx::query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'member')")
        .bind(ws)
        .bind(member.profile.id)
        .execute(&store.pool)
        .await
        .unwrap();
    let other = workspace(&app, &owner, "Other").await;

    // 401 without credentials.
    let response = sse_response(&app, None, ws, &format!("?client_id={}", Uuid::new_v4())).await;
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);

    // 403 for non-members.
    let response = sse_response(
        &app,
        Some(&outsider.token),
        ws,
        &format!("?client_id={}", Uuid::new_v4()),
    )
    .await;
    assert_eq!(response.status(), StatusCode::FORBIDDEN);

    // A client_id owned by another user or workspace is 400.
    let taken = Uuid::new_v4();
    sqlx::query("INSERT INTO sync_clients(client_id,workspace_id,user_id) VALUES($1,$2,$3)")
        .bind(taken)
        .bind(ws)
        .bind(owner.profile.id)
        .execute(&store.pool)
        .await
        .unwrap();
    let response = sse_response(
        &app,
        Some(&member.token),
        ws,
        &format!("?client_id={taken}"),
    )
    .await;
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let response = sse_response(
        &app,
        Some(&owner.token),
        other,
        &format!("?client_id={taken}"),
    )
    .await;
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);

    // Missing and malformed client ids are 400.
    let response = sse_response(&app, Some(&owner.token), ws, "").await;
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let response = sse_response(&app, Some(&owner.token), ws, "?client_id=nope").await;
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);

    drop(app);
    store.pool.close().await;
    database.cleanup().await;
}

#[tokio::test]
async fn events_reconnect_pokes_all_and_recovers() {
    let database = support::TestDatabase::new().await;
    let store = connect_store(
        &database.url,
        events_config(
            Duration::from_millis(250),
            Duration::from_secs(60),
            Duration::from_secs(30 * 60),
            Duration::from_millis(50),
        ),
    )
    .await;
    let app = router(store.clone());
    let owner = account(&store, "owner").await;
    let (ws_a, team_a) = setup(&app, &owner).await;
    let ws_b = workspace(&app, &owner, "Other").await;
    let client_a = Uuid::new_v4();
    let client_b = Uuid::new_v4();

    let mut body_a = sse_response(
        &app,
        Some(&owner.token),
        ws_a,
        &format!("?client_id={client_a}"),
    )
    .await
    .into_body();
    let mut body_b = sse_response(
        &app,
        Some(&owner.token),
        ws_b,
        &format!("?client_id={client_b}"),
    )
    .await
    .into_body();
    drain_poke(&mut body_a).await;
    drain_poke(&mut body_b).await;

    let pid: i32 = sqlx::query_scalar(
        "SELECT pid FROM pg_stat_activity WHERE datname = current_database() \
         AND query LIKE 'LISTEN%'",
    )
    .fetch_one(&store.pool)
    .await
    .unwrap();
    sqlx::query("SELECT pg_terminate_backend($1)")
        .bind(pid)
        .execute(&store.pool)
        .await
        .unwrap();

    // The wildcard after the reconnect pokes every subscriber.
    expect_poke(&mut body_a, Duration::from_secs(5)).await;
    expect_poke(&mut body_b, Duration::from_secs(5)).await;

    // A later commit still pokes normally: only its workspace.
    created(
        &app,
        &owner,
        ws_a,
        json!({"type": "create_issue", "input": {"team_id": team_a, "title": "After"}}),
    )
    .await;
    expect_poke(&mut body_a, Duration::from_secs(2)).await;
    expect_no_data(&mut body_b, Duration::from_millis(500)).await;

    drop(app);
    store.pool.close().await;
    database.cleanup().await;
}

#[tokio::test]
async fn events_lifetime_cap_ends_stream() {
    let database = support::TestDatabase::new().await;
    let store = connect_store(
        &database.url,
        events_config(
            Duration::from_millis(250),
            Duration::from_secs(60),
            Duration::from_millis(200),
            Duration::from_secs(1),
        ),
    )
    .await;
    let app = router(store.clone());
    let owner = account(&store, "owner").await;
    let (ws, _) = setup(&app, &owner).await;
    let client = Uuid::new_v4();

    let start = std::time::Instant::now();
    let mut body = sse_response(
        &app,
        Some(&owner.token),
        ws,
        &format!("?client_id={client}"),
    )
    .await
    .into_body();
    drain_poke(&mut body).await;
    // The stream ends after the cap with no further frames.
    expect_no_data(&mut body, Duration::from_secs(5)).await;
    let elapsed = start.elapsed();
    assert!(
        elapsed < Duration::from_secs(5),
        "stream did not end on time: {elapsed:?}"
    );
    assert!(
        elapsed >= Duration::from_millis(150),
        "stream ended too early: {elapsed:?}"
    );

    drop(app);
    store.pool.close().await;
    database.cleanup().await;
}

#[tokio::test]
async fn events_close_ends_open_streams() {
    let database = support::TestDatabase::new().await;
    let store = connect_store(
        &database.url,
        events_config(
            Duration::from_millis(250),
            Duration::from_secs(60),
            Duration::from_secs(60),
            Duration::from_secs(1),
        ),
    )
    .await;
    let app = router(store.clone());
    let owner = account(&store, "owner").await;
    let (ws, _) = setup(&app, &owner).await;
    let client = Uuid::new_v4();

    let mut body = sse_response(
        &app,
        Some(&owner.token),
        ws,
        &format!("?client_id={client}"),
    )
    .await
    .into_body();
    drain_poke(&mut body).await;

    // Server shutdown ends the stream long before its lifetime cap.
    let start = std::time::Instant::now();
    store.close_sync_events();
    expect_no_data(&mut body, Duration::from_secs(5)).await;
    assert!(
        start.elapsed() < Duration::from_secs(2),
        "stream outlived shutdown"
    );

    drop(app);
    store.pool.close().await;
    database.cleanup().await;
}

#[tokio::test]
async fn events_keepalive_comments() {
    let database = support::TestDatabase::new().await;
    let store = connect_store(
        &database.url,
        events_config(
            Duration::from_millis(250),
            Duration::from_millis(50),
            Duration::from_secs(10),
            Duration::from_secs(1),
        ),
    )
    .await;
    let app = router(store.clone());
    let owner = account(&store, "owner").await;
    let (ws, _) = setup(&app, &owner).await;
    let client = Uuid::new_v4();

    let mut body = sse_response(
        &app,
        Some(&owner.token),
        ws,
        &format!("?client_id={client}"),
    )
    .await
    .into_body();

    // Frames may arrive in any order: the keep-alive comment can precede the
    // initial poke when the stream is slow to yield it.
    let mut seen_poke = false;
    let mut seen_comment = false;
    for _ in 0..5 {
        let bytes = next_data(&mut body, Duration::from_secs(2))
            .await
            .expect("expected frame");
        if is_poke(&bytes) {
            seen_poke = true;
        }
        if is_comment(&bytes) {
            seen_comment = true;
        }
        if seen_poke && seen_comment {
            break;
        }
    }
    assert!(seen_poke, "no poke in the first frames");
    assert!(seen_comment, "no keep-alive comment arrived");

    drop(app);
    store.pool.close().await;
    database.cleanup().await;
}

#[tokio::test]
async fn events_failed_reconnect_recovers_with_wildcard() {
    let database = support::TestDatabase::new().await;
    let store = Store::connect_with_config(
        &database.url,
        events_config(
            Duration::from_millis(250),
            Duration::from_secs(60),
            Duration::from_secs(30 * 60),
            Duration::from_millis(50),
        ),
    )
    .await
    .unwrap();
    // The listener connects through a loopback proxy so blocked reconnects
    // never affect the request pool or other tests sharing the cluster.
    let (target_host, target_port) = support::proxy::target_from_url(&database.url);
    let proxy = support::proxy::TestProxy::new(target_host, target_port).await;
    let listener_url = support::proxy::proxy_url(&database.url, proxy.port);
    let listener = store.spawn_sync_events_with_url(&listener_url);
    wait_for_listener(&store).await;

    let app = router(store.clone());
    let owner = account(&store, "owner").await;
    let (ws_a, team_a) = setup(&app, &owner).await;
    let ws_b = workspace(&app, &owner, "Other").await;
    let client_a = Uuid::new_v4();
    let client_b = Uuid::new_v4();

    let mut body_a = sse_response(
        &app,
        Some(&owner.token),
        ws_a,
        &format!("?client_id={client_a}"),
    )
    .await
    .into_body();
    let mut body_b = sse_response(
        &app,
        Some(&owner.token),
        ws_b,
        &format!("?client_id={client_b}"),
    )
    .await
    .into_body();
    drain_poke(&mut body_a).await;
    drain_poke(&mut body_b).await;

    // Refuse reconnects first, then cut the listener: every reconnect attempt
    // fails until forwarding resumes.
    proxy.refuse_new();
    proxy.disconnect_all();
    tokio::time::sleep(Duration::from_millis(300)).await;

    // A change committed while reconnects fail is lost to the listener.
    sqlx::query("SELECT mark_change($1, 'issues', $2)")
        .bind(ws_a)
        .bind(Uuid::new_v4())
        .execute(&store.pool)
        .await
        .unwrap();

    proxy.forward();

    // Recovery broadcasts the wildcard, so every subscriber pokes.
    expect_poke(&mut body_a, Duration::from_secs(10)).await;
    expect_poke(&mut body_b, Duration::from_secs(10)).await;

    // A later commit still pokes normally: only its workspace.
    created(
        &app,
        &owner,
        ws_a,
        json!({"type": "create_issue", "input": {"team_id": team_a, "title": "After"}}),
    )
    .await;
    expect_poke(&mut body_a, Duration::from_secs(2)).await;
    expect_no_data(&mut body_b, Duration::from_millis(500)).await;

    drop(app);
    listener.abort();
    store.pool.close().await;
    database.cleanup().await;
}

#[tokio::test]
async fn events_initial_listen_pokes_subscriber() {
    let database = support::TestDatabase::new().await;
    let store = Store::connect_with_config(
        &database.url,
        events_config(
            Duration::from_millis(250),
            Duration::from_secs(60),
            Duration::from_secs(30 * 60),
            Duration::from_millis(50),
        ),
    )
    .await
    .unwrap();
    // Start the proxy refusing so the first connects fail: the startup gap is
    // deterministic and needs no role changes.
    let (target_host, target_port) = support::proxy::target_from_url(&database.url);
    let proxy = support::proxy::TestProxy::new(target_host, target_port).await;
    proxy.refuse_new();
    let listener_url = support::proxy::proxy_url(&database.url, proxy.port);
    let listener = store.spawn_sync_events_with_url(&listener_url);

    let app = router(store.clone());
    let owner = account(&store, "owner").await;
    let (ws, team) = setup(&app, &owner).await;
    let client = Uuid::new_v4();

    let mut body = sse_response(
        &app,
        Some(&owner.token),
        ws,
        &format!("?client_id={client}"),
    )
    .await
    .into_body();
    drain_poke(&mut body).await;

    // A change committed while the listener cannot connect has no listener
    // to receive it.
    sqlx::query("SELECT mark_change($1, 'issues', $2)")
        .bind(ws)
        .bind(Uuid::new_v4())
        .execute(&store.pool)
        .await
        .unwrap();

    // The first successful LISTEN broadcasts the wildcard that covers it.
    proxy.forward();
    wait_for_listener(&store).await;
    expect_poke(&mut body, Duration::from_secs(10)).await;

    // Later commits still poke normally.
    created(
        &app,
        &owner,
        ws,
        json!({"type": "create_issue", "input": {"team_id": team, "title": "After"}}),
    )
    .await;
    expect_poke(&mut body, Duration::from_secs(2)).await;

    drop(app);
    listener.abort();
    store.pool.close().await;
    database.cleanup().await;
}

#[tokio::test]
async fn events_lifetime_cap_with_unread_body() {
    let database = support::TestDatabase::new().await;
    let store = connect_store(
        &database.url,
        events_config(
            Duration::from_millis(250),
            Duration::from_secs(60),
            Duration::from_millis(200),
            Duration::from_secs(1),
        ),
    )
    .await;
    let app = router(store.clone());
    let owner = account(&store, "owner").await;
    let (ws, _) = setup(&app, &owner).await;
    let client = Uuid::new_v4();

    let mut body = sse_response(
        &app,
        Some(&owner.token),
        ws,
        &format!("?client_id={client}"),
    )
    .await
    .into_body();
    // Never read: the task must still end at the deadline instead of blocking
    // on the full channel.
    tokio::time::sleep(Duration::from_millis(600)).await;
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if store.sync_broadcast_receiver_count() == 0 {
                return;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("stream task did not end at the lifetime cap");

    // Resuming reads delivers at most the one buffered poke, then the end.
    let mut pokes = 0;
    for _ in 0..4 {
        match tokio::time::timeout(Duration::from_secs(2), body.frame()).await {
            Ok(Some(Ok(frame))) => {
                if let Ok(data) = frame.into_data()
                    && is_poke(&data)
                {
                    pokes += 1;
                }
            }
            Ok(Some(Err(_))) | Ok(None) => break,
            Err(_) => panic!("stream did not end after the lifetime cap"),
        }
    }
    assert!(
        pokes <= 1,
        "expected at most one buffered poke, got {pokes}"
    );
    expect_no_data(&mut body, Duration::from_millis(300)).await;

    drop(app);
    store.pool.close().await;
    database.cleanup().await;
}

#[tokio::test]
async fn events_listener_with_single_connection_pool() {
    let database = support::TestDatabase::new().await;
    let config = StoreConfig {
        max_connections: 1,
        acquire_timeout: Duration::from_secs(2),
        ..events_config(
            Duration::from_millis(250),
            Duration::from_secs(60),
            Duration::from_secs(30 * 60),
            Duration::from_millis(50),
        )
    };
    let store = Store::connect_with_config(&database.url, config)
        .await
        .unwrap();
    let listener = store.spawn_sync_events();
    wait_for_listener(&store).await;

    // The listener holds no pool slot, so a normal request succeeds with only
    // one connection in the pool instead of timing out on acquire.
    let app = router(store.clone());
    let owner = account(&store, "owner").await;
    let (_ws, _team) = setup(&app, &owner).await;

    drop(app);
    listener.abort();
    store.pool.close().await;
    database.cleanup().await;
}

#[tokio::test]
async fn events_dropped_body_releases_receiver() {
    let database = support::TestDatabase::new().await;
    let store = connect_store(
        &database.url,
        events_config(
            Duration::from_millis(250),
            Duration::from_secs(60),
            Duration::from_secs(30 * 60),
            Duration::from_secs(1),
        ),
    )
    .await;
    let app = router(store.clone());
    let owner = account(&store, "owner").await;
    let (ws, _) = setup(&app, &owner).await;

    assert_eq!(store.sync_broadcast_receiver_count(), 0);
    let mut bodies = Vec::new();
    for _ in 0..3 {
        let client = Uuid::new_v4();
        let mut body = sse_response(
            &app,
            Some(&owner.token),
            ws,
            &format!("?client_id={client}"),
        )
        .await
        .into_body();
        drain_poke(&mut body).await;
        bodies.push(body);
    }
    assert_eq!(store.sync_broadcast_receiver_count(), 3);
    drop(bodies);

    // Dropped idle bodies end their tasks promptly instead of lingering until
    // the lifetime cap.
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if store.sync_broadcast_receiver_count() == 0 {
                return;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("idle streams did not release their receivers");

    drop(app);
    store.pool.close().await;
    database.cleanup().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn events_trailing_poke_beats_other_workspace_flood() {
    let coalesce = Duration::from_millis(500);
    let database = support::TestDatabase::new().await;
    let store = connect_store(
        &database.url,
        events_config(
            coalesce,
            Duration::from_secs(60),
            Duration::from_secs(30 * 60),
            Duration::from_secs(1),
        ),
    )
    .await;
    let app = router(store.clone());
    let owner = account(&store, "owner").await;
    let (ws, _) = setup(&app, &owner).await;
    let client = Uuid::new_v4();

    let mut body = sse_response(
        &app,
        Some(&owner.token),
        ws,
        &format!("?client_id={client}"),
    )
    .await
    .into_body();
    drain_poke(&mut body).await;

    // Arm a trailing poke: this lands inside the coalesce window, so the
    // stream defers it to the window's end instead of sending immediately.
    store.sync_broadcast_poke(blackwall::ids::WorkspaceId(ws));
    let start = std::time::Instant::now();

    // Flood with notifications for other workspaces while the trailing poke
    // is pending. The timer branch runs before broadcast reception, so the
    // overdue poke fires on time instead of waiting out the flood. One fixed
    // id keeps the producer faster than the consumer without RNG overhead.
    let other = blackwall::ids::WorkspaceId::new_v4();
    let flooder_store = store.clone();
    let flooder = tokio::spawn(async move {
        let mut n: u64 = 0;
        loop {
            // Never matches the stream's workspace or the wildcard.
            flooder_store.sync_broadcast_poke(other);
            n += 1;
            if n.is_multiple_of(1024) {
                tokio::task::yield_now().await;
            }
        }
    });

    let bytes = next_data(&mut body, coalesce + Duration::from_millis(500))
        .await
        .expect("trailing poke starved by other workspaces' notifications");
    flooder.abort();
    assert!(
        is_poke(&bytes),
        "expected poke, got {:?}",
        String::from_utf8_lossy(&bytes)
    );
    assert!(
        start.elapsed() <= coalesce + Duration::from_millis(500),
        "trailing poke arrived late: {:?}",
        start.elapsed()
    );

    drop(app);
    store.pool.close().await;
    database.cleanup().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn events_flood_in_one_workspace_does_not_poke_another() {
    let database = support::TestDatabase::new().await;
    let store = connect_store(
        &database.url,
        events_config(
            Duration::from_millis(100),
            Duration::from_secs(60),
            Duration::from_secs(30 * 60),
            Duration::from_secs(1),
        ),
    )
    .await;
    let app = router(store.clone());
    let owner = account(&store, "owner").await;
    let (busy, _) = setup(&app, &owner).await;
    let quiet = workspace(&app, &owner, "Quiet").await;

    let mut busy_body = sse_response(
        &app,
        Some(&owner.token),
        busy,
        &format!("?client_id={}", Uuid::new_v4()),
    )
    .await
    .into_body();
    let mut quiet_body = sse_response(
        &app,
        Some(&owner.token),
        quiet,
        &format!("?client_id={}", Uuid::new_v4()),
    )
    .await
    .into_body();
    drain_poke(&mut busy_body).await;
    drain_poke(&mut quiet_body).await;
    settle(&mut busy_body).await;
    settle(&mut quiet_body).await;

    for _ in 0..10_000 {
        store.sync_broadcast_poke(blackwall::ids::WorkspaceId(busy));
    }

    expect_poke(&mut busy_body, Duration::from_secs(2)).await;
    expect_no_data(&mut quiet_body, Duration::from_millis(700)).await;

    drop(app);
    store.pool.close().await;
    database.cleanup().await;
}

#[tokio::test]
async fn events_pool_close_ends_listener() {
    let database = support::TestDatabase::new().await;
    let store = Store::connect_with_config(
        &database.url,
        events_config(
            Duration::from_millis(250),
            Duration::from_secs(60),
            Duration::from_secs(30 * 60),
            Duration::from_millis(50),
        ),
    )
    .await
    .unwrap();
    let listener = store.spawn_sync_events();
    wait_for_listener(&store).await;

    // A separate connection observes the listener backend: the request pool
    // itself cannot be used after it closes.
    let observer = sqlx::postgres::PgPoolOptions::new()
        .max_connections(1)
        .connect(&database.url)
        .await
        .unwrap();
    let pid: i32 = sqlx::query_scalar(
        "SELECT pid FROM pg_stat_activity WHERE datname = current_database() \
         AND query LIKE 'LISTEN%'",
    )
    .fetch_one(&observer)
    .await
    .unwrap();

    // Closing the request pool interrupts the idle receive wait and ends the
    // listener task instead of leaving it parked on its backend.
    store.pool.close().await;
    tokio::time::timeout(Duration::from_secs(5), listener)
        .await
        .expect("listener task did not end after pool close")
        .unwrap();

    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let alive: bool =
                sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid = $1)")
                    .bind(pid)
                    .fetch_one(&observer)
                    .await
                    .unwrap();
            if !alive {
                return;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("listener backend still in pg_stat_activity after pool close");

    observer.close().await;
    database.cleanup().await;
}
