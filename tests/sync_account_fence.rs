mod support;

use axum::{
    body::Body,
    http::{Request, StatusCode},
    response::Response,
};
use blackwall::{
    auth::{self, Register, Session},
    http::router,
    store::Store,
};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use tower::ServiceExt;
use uuid::Uuid;

#[derive(Clone, Copy)]
enum Auth<'a> {
    Bearer(&'a str),
    Cookie(&'a str),
}

async fn request(
    app: &axum::Router,
    method: &str,
    path: &str,
    auth: Auth<'_>,
    input: Option<Value>,
) -> Response {
    let mut request = Request::builder().method(method).uri(path);
    request = match auth {
        Auth::Bearer(token) => request.header("Authorization", format!("Bearer {token}")),
        Auth::Cookie(token) => {
            let request = request.header("Cookie", format!("blackwall_session={token}"));
            if method == "GET" {
                request
            } else {
                request.header("X-CSRF-Token", auth::csrf(token))
            }
        }
    };
    let body = match input {
        Some(input) => {
            request = request.header("Content-Type", "application/json");
            Body::from(input.to_string())
        }
        None => Body::empty(),
    };
    app.clone()
        .oneshot(request.body(body).unwrap())
        .await
        .unwrap()
}

/// Reads a finished body to its end, so no stream outlives the test. An event stream never ends.
async fn finish(path: &str, response: Response) {
    if !path.contains("/events?") {
        response.into_body().collect().await.unwrap();
    }
}

async fn json_body(response: Response) -> Value {
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    serde_json::from_slice(&bytes).unwrap()
}

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

async fn workspace(app: &axum::Router, owner: &Session) -> Uuid {
    let response = request(
        app,
        "POST",
        "/internal-api/workspaces",
        Auth::Bearer(&owner.token),
        Some(json!({"name": "Fence", "slug": Uuid::new_v4().to_string()})),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let created = json_body(response).await;
    Uuid::parse_str(created["workspace"]["id"].as_str().unwrap()).unwrap()
}

async fn client_rows(store: &Store) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM sync_clients")
        .fetch_one(&store.pool)
        .await
        .unwrap()
}

/// Every sync endpoint with its method, path and body, naming `user` as the replica's owner.
fn endpoints(
    ws: Uuid,
    client: Uuid,
    user: Option<Uuid>,
) -> Vec<(&'static str, String, Option<Value>)> {
    let base = format!("/internal-api/workspaces/{ws}/sync");
    let user = user
        .map(|user| format!("&user_id={user}"))
        .unwrap_or_default();
    let push = json!({
        "client_id": client,
        "mutations": [{
            "id": 1,
            "name": "create_label",
            "args": {"name": "fenced", "color": "#000000"},
            "at": "2026-10-08T12:00:00Z",
        }],
    });
    vec![
        ("GET", format!("{base}/pull?client_id={client}{user}"), None),
        (
            "GET",
            format!("{base}/bootstrap?client_id={client}{user}"),
            None,
        ),
        (
            "GET",
            format!(
                "{base}/scope?client_id={client}&entity=comments&issue_id={}{user}",
                Uuid::new_v4()
            ),
            None,
        ),
        (
            "GET",
            format!("{base}/events?client_id={client}{user}"),
            None,
        ),
        (
            "POST",
            format!("{base}/push?client_id={client}{user}"),
            Some(push),
        ),
    ]
}

#[tokio::test]
async fn another_accounts_replica_is_refused_before_any_work() {
    let database = support::TestDatabase::new().await;
    let store = Store::connect(&database.url).await.unwrap();
    let app = router(store.clone());
    let previous = account(&store, "previous").await;
    let current = account(&store, "current").await;
    let ws = workspace(&app, &current).await;

    for auth in [Auth::Bearer(&current.token), Auth::Cookie(&current.token)] {
        for (method, path, input) in endpoints(ws, Uuid::new_v4(), Some(previous.profile.id)) {
            let response = request(&app, method, &path, auth, input).await;
            assert_eq!(response.status(), StatusCode::UNAUTHORIZED, "{path}");
            assert_eq!(
                json_body(response).await,
                json!({"error": "account changed"}),
                "{path}"
            );
        }
    }
    assert_eq!(client_rows(&store).await, 0);

    drop(app);
    store.pool.close().await;
    database.cleanup().await;
}

#[tokio::test]
async fn the_replicas_own_account_syncs() {
    let database = support::TestDatabase::new().await;
    let store = Store::connect(&database.url).await.unwrap();
    let app = router(store.clone());
    let owner = account(&store, "owner").await;
    let ws = workspace(&app, &owner).await;

    for (method, path, input) in endpoints(ws, Uuid::new_v4(), Some(owner.profile.id)) {
        let response = request(&app, method, &path, Auth::Cookie(&owner.token), input).await;
        assert_eq!(response.status(), StatusCode::OK, "{path}");
        finish(&path, response).await;
    }
    assert_eq!(client_rows(&store).await, 1);

    drop(app);
    store.pool.close().await;
    database.cleanup().await;
}

#[tokio::test]
async fn a_browser_must_name_its_replicas_account() {
    let database = support::TestDatabase::new().await;
    let store = Store::connect(&database.url).await.unwrap();
    let app = router(store.clone());
    let owner = account(&store, "owner").await;
    let ws = workspace(&app, &owner).await;

    for (method, path, input) in endpoints(ws, Uuid::new_v4(), None) {
        let response = request(
            &app,
            method,
            &path,
            Auth::Cookie(&owner.token),
            input.clone(),
        )
        .await;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST, "{path}");
        let response = request(&app, method, &path, Auth::Bearer(&owner.token), input).await;
        assert_eq!(response.status(), StatusCode::OK, "{path}");
        finish(&path, response).await;
    }

    drop(app);
    store.pool.close().await;
    database.cleanup().await;
}

async fn labels(store: &Store, ws: Uuid) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM labels WHERE workspace_id = $1")
        .bind(ws)
        .fetch_one(&store.pool)
        .await
        .unwrap()
}

fn command_path(ws: Uuid, user: Option<Uuid>) -> String {
    let query = user
        .map(|user| format!("?user_id={user}"))
        .unwrap_or_default();
    format!("/internal-api/workspaces/{ws}/commands{query}")
}

fn create_label(name: &str) -> Value {
    json!({
        "command": {"type": "create_label", "name": name, "color": "#000000"},
        "idempotency_key": Uuid::new_v4().to_string(),
    })
}

#[tokio::test]
async fn a_command_from_another_accounts_replica_runs_nothing() {
    let database = support::TestDatabase::new().await;
    let store = Store::connect(&database.url).await.unwrap();
    let app = router(store.clone());
    let previous = account(&store, "previous").await;
    let current = account(&store, "current").await;
    let ws = workspace(&app, &current).await;
    let before = labels(&store, ws).await;

    for auth in [Auth::Bearer(&current.token), Auth::Cookie(&current.token)] {
        let response = request(
            &app,
            "POST",
            &command_path(ws, Some(previous.profile.id)),
            auth,
            Some(create_label("fenced")),
        )
        .await;
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(
            json_body(response).await,
            json!({"error": "account changed"})
        );
    }
    assert_eq!(labels(&store, ws).await, before);

    drop(app);
    store.pool.close().await;
    database.cleanup().await;
}

#[tokio::test]
async fn a_command_names_its_replicas_account_from_a_browser_only() {
    let database = support::TestDatabase::new().await;
    let store = Store::connect(&database.url).await.unwrap();
    let app = router(store.clone());
    let owner = account(&store, "owner").await;
    let ws = workspace(&app, &owner).await;
    let before = labels(&store, ws).await;

    let response = request(
        &app,
        "POST",
        &command_path(ws, Some(owner.profile.id)),
        Auth::Cookie(&owner.token),
        Some(create_label("named")),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    finish("", response).await;
    let response = request(
        &app,
        "POST",
        &command_path(ws, None),
        Auth::Bearer(&owner.token),
        Some(create_label("bearer")),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    finish("", response).await;
    let response = request(
        &app,
        "POST",
        &command_path(ws, None),
        Auth::Cookie(&owner.token),
        Some(create_label("unnamed")),
    )
    .await;
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    finish("", response).await;
    assert_eq!(labels(&store, ws).await, before + 2);

    drop(app);
    store.pool.close().await;
    database.cleanup().await;
}
