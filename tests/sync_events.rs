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
        })
        .await
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
        "/api/workspaces",
        Some(json!({"name": name})),
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
        &format!("/api/workspaces/{workspace}/commands"),
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
        json!({"type": "create_team", "name": "Team", "members": [owner.profile.id]}),
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
    let mut request = Request::builder()
        .method("GET")
        .uri(format!("/api/workspaces/{workspace}/sync/events{query}"));
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
            Duration::from_millis(500),
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

    // Separate commits inside one coalesce window: exactly one trailing poke,
    // not zero and not one per commit.
    for _ in 0..5 {
        sqlx::query("SELECT mark_change($1, 'issues', $2)")
            .bind(ws)
            .bind(Uuid::new_v4())
            .execute(&store.pool)
            .await
            .unwrap();
    }

    expect_poke(&mut body, Duration::from_secs(2)).await;
    expect_no_data(&mut body, Duration::from_millis(800)).await;

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
    drain_poke(&mut body).await;

    let found = tokio::time::timeout(Duration::from_secs(2), async {
        while let Some(bytes) = next_data(&mut body, Duration::from_secs(2)).await {
            if is_comment(&bytes) {
                return true;
            }
        }
        false
    })
    .await
    .unwrap();
    assert!(found, "no keep-alive comment arrived");

    drop(app);
    store.pool.close().await;
    database.cleanup().await;
}
