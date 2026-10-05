#[path = "openproject/logging.rs"]
mod logging;
#[path = "openproject/performance.rs"]
mod performance;
#[path = "openproject/persistence.rs"]
mod persistence;
mod support;
#[path = "openproject/upgrade.rs"]
mod upgrade;

use axum::{
    Json, Router,
    body::Body,
    extract::{ConnectInfo, Path, Query, State},
    http::{HeaderMap, Request, StatusCode},
    routing::get,
};
use blackwall::{
    auth::{Register, Session},
    domain::Command,
    http,
    jobs::Job,
    openproject,
    store::Store,
};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use std::{collections::BTreeMap, sync::Arc, time::Duration};
use tokio::sync::{Mutex, Notify};
use tower::ServiceExt;
use uuid::Uuid;

const TOKEN: &str = "op-private-token-do-not-leak";

#[derive(Default)]
struct Remote {
    moved: bool,
    missing: bool,
    stall: bool,
    same_stage: bool,
    extra: bool,
    requests: usize,
    assignee_email: Option<String>,
    assignee_id: Option<i64>,
    deadline: Option<String>,
    closed_first: bool,
    malformed_last: bool,
    page_size: Option<usize>,
    resource_requests: BTreeMap<String, usize>,
    connections: std::collections::BTreeSet<std::net::SocketAddr>,
    incremental_requests: usize,
    reject_date_filter: bool,
    incremental_items: Option<Vec<Value>>,
    bulk_count: usize,
    parents: BTreeMap<i64, i64>,
}

#[derive(Clone, Default)]
struct Mock {
    data: Arc<Mutex<Remote>>,
    entered: Arc<Notify>,
    release: Arc<Notify>,
}

async fn remote(
    State(mock): State<Mock>,
    Path(resource): Path<String>,
    Query(query): Query<BTreeMap<String, String>>,
    headers: HeaderMap,
    ConnectInfo(peer): ConnectInfo<std::net::SocketAddr>,
) -> (StatusCode, Json<Value>) {
    assert_eq!(
        headers["authorization"],
        "Basic YXBpa2V5Om9wLXByaXZhdGUtdG9rZW4tZG8tbm90LWxlYWs="
    );
    let mut data = mock.data.lock().await;
    data.requests += 1;
    *data.resource_requests.entry(resource.clone()).or_default() += 1;
    data.connections.insert(peer);
    let page: usize = query["offset"].parse().unwrap();
    let items = match resource.as_str() {
        "projects" => vec![
            json!({"id":42,"name":"Alpha"}),
            json!({"id":43,"name":"Beta"}),
        ],
        "users" => vec![json!({"id":10,"name":"Remote person","email":data.assignee_email})],
        "statuses" => {
            // This OP endpoint returns the complete collection without pagination metadata.
            return (
                StatusCode::OK,
                Json(json!({"total":2,"count":2,"_embedded":{"elements":[
                    {"id":1,"name":"In progress","isClosed":false},
                    {"id":2,"name":"Closed","isClosed":true}
                ]}})),
            );
        }
        "work_packages" => {
            let filters: Value = serde_json::from_str(&query["filters"]).unwrap();
            let filters_array = filters.as_array().unwrap();
            assert!(filters_array.len() == 1 || filters_array.len() == 2);
            let incremental = filters_array.len() == 2;
            if incremental {
                assert_eq!(filters[1]["updatedAt"]["operator"], "<>d");
                for value in filters[1]["updatedAt"]["values"].as_array().unwrap() {
                    chrono::DateTime::parse_from_rfc3339(value.as_str().unwrap()).unwrap();
                }
                data.incremental_requests += 1;
                if data.reject_date_filter {
                    return (
                        StatusCode::BAD_REQUEST,
                        Json(json!({"error":"date filter unsupported"})),
                    );
                }
                if let Some(items) = data.incremental_items.clone() {
                    let parents = data.parents.clone();
                    let page_size = data.page_size.unwrap_or(1);
                    let mut items = items;
                    for package in &mut items {
                        if let Some(id) = package.get("id").and_then(Value::as_i64)
                            && let Some(parent) = parents.get(&id)
                        {
                            package["_links"]["parent"] =
                                json!({"href": format!("/api/v3/work_packages/{parent}")});
                        }
                    }
                    return (
                        StatusCode::OK,
                        Json(collection_with_size(items, page, page_size)),
                    );
                }
            }
            let project: i64 = filters[0]["project"]["values"][0]
                .as_str()
                .unwrap()
                .parse()
                .unwrap();
            let assignee_id = data.assignee_id;
            let moved = data.moved;
            let missing = data.missing;
            let stall = data.stall;
            let same_stage = data.same_stage;
            let extra = data.extra;
            let deadline = data.deadline.clone().unwrap_or_else(|| "2026-05-10".into());
            let closed_first = data.closed_first;
            let malformed_last = data.malformed_last;
            let page_size = data.page_size.unwrap_or(1);
            let bulk_count = data.bulk_count;
            let parents = data.parents.clone();
            drop(data);
            if stall {
                mock.entered.notify_one();
                mock.release.notified().await;
            }
            let mut packages = vec![];
            if !missing && project == if moved { 43 } else { 42 } {
                packages.push(json!({
                    "id":7,"subject":if moved {"Moved package"}else{"First package"},
                    "description":{"raw":"Imported **description**"},"dueDate":deadline,
                    "_links":{"project":{"href":format!("/api/v3/projects/{project}")},
                        "status":{"href":if closed_first {"/api/v3/statuses/2"}else{"/api/v3/statuses/1"},"title":"In progress"},
                        "assignee":{"href":assignee_id.map(|id| format!("/api/v3/users/{id}"))},
                        "priority":{"title":"High"}}
                }));
            }
            if !missing && project == 42 {
                packages.push(
                    json!({"id":8,"subject":"Closed package","description":{"raw":""},
                    "_links":{"project":{"href":"/api/v3/projects/42"},
                        "status":{"href":if same_stage {"/api/v3/statuses/1"}else{"/api/v3/statuses/2"},"title":"Closed"}}}),
                );
            }
            if extra && project == 42 {
                packages.push(json!({"id":9,"subject":"Beyond capacity","description":{"raw":""},
                    "_links":{"project":{"href":"/api/v3/projects/42"},"status":{"href":"/api/v3/statuses/1"}}}));
            }
            for index in 0..bulk_count {
                packages.push(json!({"id":100+index,"subject":format!("Bulk package {index}"),
                    "description":{"raw":"A repeated description for the performance test.".repeat(20)},
                    "_links":{"project":{"href":format!("/api/v3/projects/{project}")},
                    "status":{"href":"/api/v3/statuses/1"}}}));
            }
            if malformed_last && let Some(last) = packages.last_mut() {
                last["dueDate"] = json!("invalid-date");
            }
            for package in &mut packages {
                if let Some(id) = package.get("id").and_then(Value::as_i64)
                    && let Some(parent) = parents.get(&id)
                {
                    package["_links"]["parent"] =
                        json!({"href": format!("/api/v3/work_packages/{parent}")});
                }
            }
            return (
                StatusCode::OK,
                Json(collection_with_size(packages, page, page_size)),
            );
        }
        _ => panic!("unexpected remote endpoint: {resource}"),
    };
    (StatusCode::OK, Json(collection(items, page)))
}

fn collection(items: Vec<Value>, page: usize) -> Value {
    collection_with_size(items, page, 1)
}

fn collection_with_size(items: Vec<Value>, page: usize, size: usize) -> Value {
    let total = items.len();
    let selected: Vec<_> = items
        .into_iter()
        .skip((page - 1) * size)
        .take(size)
        .collect();
    json!({"total":total,"count":selected.len(),"pageSize":size,"offset":page,"_embedded":{"elements":selected}})
}

async fn mock_server(mock: Mock) -> (String, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let app = Router::new()
        .route("/api/v3/{resource}", get(remote))
        .with_state(mock);
    let task = tokio::spawn(async move {
        axum::serve(
            listener,
            app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
        )
        .await
        .unwrap();
    });
    (url, task)
}

async fn call(
    app: &Router,
    user: &Session,
    method: &str,
    path: &str,
    body: Option<Value>,
) -> (StatusCode, Value) {
    let request = Request::builder()
        .method(method)
        .uri(path)
        .header("Authorization", format!("Bearer {}", user.token))
        .header("Content-Type", "application/json")
        .body(body.map_or_else(Body::empty, |value| Body::from(value.to_string())))
        .unwrap();
    let response = app.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

async fn account(store: &Store) -> Session {
    store
        .register(Register {
            email: format!("op-{}@example.com", Uuid::new_v4()),
            password: "test-password-123".into(),
            display_name: "OP owner".into(),
        })
        .await
        .unwrap()
}

async fn setup(store: &Store, owner: &Session) -> (Uuid, Uuid, Uuid) {
    let workspace = store
        .create_workspace("OpenProject test".into(), owner.profile.id)
        .await
        .unwrap();
    let workspace = Uuid::parse_str(workspace["id"].as_str().unwrap()).unwrap();
    let mut teams = vec![];
    for name in ["Team A", "Team B"] {
        let result = store
            .operation(
                workspace,
                owner.profile.id,
                Command::CreateTeam {
                    name: name.into(),
                    members: vec![],
                },
                BTreeMap::new(),
                None,
                None,
            )
            .await
            .unwrap();
        teams.push(result.result.id.unwrap());
    }
    (workspace, teams[0], teams[1])
}

async fn drain(store: &Store) {
    for _ in 0..30 {
        openproject::schedule(store).await.unwrap();
        let claims = store.outbox.claim("openproject", 1).await.unwrap();
        if claims.is_empty() {
            return;
        }
        let claim = &claims[0];
        assert!(!claim.payload.contains(TOKEN));
        let Job::OpenProject(job) = Job::decode(&claim.kind, &claim.payload).unwrap() else {
            panic!("wrong queue kind");
        };
        openproject::execute(store, claim, &job).await.unwrap();
    }
    panic!("sync did not finish within bounded pages");
}

async fn issues(app: &Router, user: &Session, workspace: Uuid) -> Vec<Value> {
    let (status, value) = call(
        app,
        user,
        "GET",
        &format!("/api/workspaces/{workspace}/issues"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{value}");
    value["items"].as_array().unwrap().clone()
}

#[tokio::test]
async fn paginated_sync_is_idempotent_read_only_and_reconciles_project_and_team_moves() {
    let db = support::TestDatabase::new().await;
    let store = Store::connect(&db.url).await.unwrap();
    let owner = account(&store).await;
    let (workspace, a, b) = setup(&store, &owner).await;
    let app = http::router(store.clone());
    let mock = Mock::default();
    let (url, server) = mock_server(mock.clone()).await;
    let base = format!("/api/workspaces/{workspace}/openproject/connections");
    let (status, config) = call(
        &app,
        &owner,
        "POST",
        &base,
        Some(json!({
            "name":"Private OP","base_url":url,"token":TOKEN,
            "projects":[{"project_id":42,"team_id":a},{"project_id":43,"team_id":b}]
        })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{config}");
    assert!(!config.to_string().contains(TOKEN));
    assert_eq!(
        mock.data.lock().await.requests,
        0,
        "HTTP configuration must not contact OP"
    );
    let connection = config["id"].as_str().unwrap();
    let action = format!("{base}/{connection}");
    drain(&store).await;
    let imported = issues(&app, &owner, workspace).await;
    assert_eq!(
        imported.len(),
        2,
        "server page-size cap must not lose page 2"
    );
    let first = imported
        .iter()
        .find(|i| i["openproject"]["work_package_id"] == 7)
        .unwrap();
    let first_id = first["id"].clone();
    let first_version = first["version"].clone();
    assert_eq!(first["description"], "Imported **description**");
    assert_eq!(first["priority"], "high");
    assert_eq!(first["team_id"], a.to_string());
    let closed = imported
        .iter()
        .find(|i| i["openproject"]["work_package_id"] == 8)
        .unwrap();
    let stage_kind: String = sqlx::query_scalar("SELECT kind FROM stages WHERE id=$1")
        .bind(Uuid::parse_str(closed["stage_id"].as_str().unwrap()).unwrap())
        .fetch_one(&store.pool)
        .await
        .unwrap();
    assert_eq!(stage_kind, "done", "closed work packages must be imported");
    let (status, rejected) = call(
        &app,
        &owner,
        "PATCH",
        &action,
        Some(json!({"base_url":"http://another-instance.example"})),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::CONFLICT,
        "source identity cannot be repointed: {rejected}"
    );

    let (status, _) = call(&app, &owner, "POST", &format!("{action}/sync"), None).await;
    assert_eq!(status, StatusCode::ACCEPTED);
    // Checkpoints survive a new Store and pool, just as after a restart.
    let restarted = Store::connect(&db.url).await.unwrap();
    drain(&restarted).await;
    restarted.pool.close().await;
    let repeated = issues(&app, &owner, workspace).await;
    assert_eq!(repeated.len(), 2);
    assert_eq!(
        repeated.iter().find(|i| i["id"] == first_id).unwrap()["version"],
        first_version
    );

    for command in [
        json!({"type":"update_issue","id":first_id,"patch":{"title":"Local change"}}),
        json!({"type":"delete_issue","id":first_id}),
        json!({"type":"bulk_issues","ids":[first_id],"action":{"update":{"title":"Bulk change"}}}),
    ] {
        let (status, value) = call(&app, &owner, "POST", &format!("/api/workspaces/{workspace}/commands"), Some(json!({"expected_versions":{first_id.as_str().unwrap():first_version},"command":command}))).await;
        assert_eq!(status, StatusCode::CONFLICT, "{value}");
        assert!(value["error"].as_str().unwrap().contains("read-only"));
    }

    mock.data.lock().await.moved = true;
    call(&app, &owner, "POST", &format!("{action}/sync"), None).await;
    drain(&store).await;
    let moved = issues(&app, &owner, workspace).await;
    assert_eq!(moved.len(), 2);
    let moved = moved.iter().find(|i| i["id"] == first_id).unwrap();
    assert_eq!(moved["title"], "Moved package");
    assert_eq!(moved["team_id"], b.to_string());
    assert_eq!(moved["openproject"]["project_id"], 43);

    let (status, _) = call(
        &app,
        &owner,
        "PATCH",
        &action,
        Some(json!({"projects":[{"project_id":42,"team_id":a},{"project_id":43,"team_id":a}]})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    drain(&store).await;
    assert_eq!(
        issues(&app, &owner, workspace)
            .await
            .iter()
            .find(|i| i["id"] == first_id)
            .unwrap()["team_id"],
        a.to_string()
    );
    mock.data.lock().await.missing = true;
    call(&app, &owner, "POST", &format!("{action}/sync"), None).await;
    drain(&store).await;
    assert_eq!(
        issues(&app, &owner, workspace).await.len(),
        2,
        "absence is not deletion"
    );

    let transfer = store
        .export_transfer(workspace, owner.profile.id)
        .await
        .unwrap();
    assert!(
        transfer
            .issues
            .iter()
            .all(|issue| issue.openproject.is_none()),
        "exports must not contain connection-bound identities"
    );
    let target = store
        .create_workspace("Transferred copy".into(), owner.profile.id)
        .await
        .unwrap();
    let target = Uuid::parse_str(target["id"].as_str().unwrap()).unwrap();
    store
        .import_transfer(target, owner.profile.id, transfer, BTreeMap::new(), None)
        .await
        .unwrap();
    let copies = issues(&app, &owner, target).await;
    assert_eq!(copies.len(), 2);
    assert!(copies.iter().all(|issue| issue["openproject"].is_null()));

    let (status, _) = call(&app, &owner, "DELETE", &action, None).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let retained = issues(&app, &owner, workspace).await;
    assert_eq!(retained.len(), 2);
    assert!(retained.iter().all(|i| i["openproject"].is_object()));
    assert_eq!(
        sqlx::query_scalar::<_, String>("SELECT token FROM openproject_connections WHERE id=$1")
            .bind(Uuid::parse_str(connection).unwrap())
            .fetch_one(&store.pool)
            .await
            .unwrap(),
        ""
    );
    server.abort();
    store.pool.close().await;
    db.cleanup().await;
}

#[tokio::test]
async fn cached_settings_stay_responsive_and_config_changes_fence_slow_remote_pages() {
    let db = support::TestDatabase::new().await;
    let store = Store::connect(&db.url).await.unwrap();
    let owner = account(&store).await;
    let outsider = account(&store).await;
    let (workspace, team, _) = setup(&store, &owner).await;
    let app = http::router(store.clone());
    let mock = Mock::default();
    let (url, server) = mock_server(mock.clone()).await;
    let base = format!("/api/workspaces/{workspace}/openproject/connections");
    let (status, _) = call(&app, &outsider, "GET", &base, None).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _) = call(
        &app,
        &owner,
        "POST",
        &base,
        Some(json!({"name":"bad","base_url":"http://user:password@private.example","token":TOKEN})),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, config) = call(&app, &owner, "POST", &base, Some(json!({"name":"Slow OP","base_url":url,"token":TOKEN,"projects":[{"project_id":42,"team_id":team}]}))).await;
    assert_eq!(status, StatusCode::CREATED, "{config}");
    let action = format!("{base}/{}", config["id"].as_str().unwrap());
    // Complete project discovery and statuses before stalling the first WP page.
    for _ in 0..4 {
        openproject::schedule(&store).await.unwrap();
        let claim = store
            .outbox
            .claim("openproject", 1)
            .await
            .unwrap()
            .remove(0);
        let Job::OpenProject(job) = Job::decode(&claim.kind, &claim.payload).unwrap() else {
            panic!()
        };
        openproject::execute(&store, &claim, &job).await.unwrap();
    }
    mock.data.lock().await.stall = true;
    openproject::schedule(&store).await.unwrap();
    let claim = store
        .outbox
        .claim("openproject", 1)
        .await
        .unwrap()
        .remove(0);
    let Job::OpenProject(job) = Job::decode(&claim.kind, &claim.payload).unwrap() else {
        panic!()
    };
    let running_store = store.clone();
    let running =
        tokio::spawn(async move { openproject::execute(&running_store, &claim, &job).await });
    tokio::time::timeout(Duration::from_secs(3), mock.entered.notified())
        .await
        .unwrap();
    let (status, list) = tokio::time::timeout(
        Duration::from_secs(1),
        call(&app, &owner, "GET", &base, None),
    )
    .await
    .unwrap();
    assert_eq!(status, StatusCode::OK);
    assert!(!list.to_string().contains(TOKEN));
    assert_eq!(
        list["connections"][0]["cached_projects"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    let (status, _) = tokio::time::timeout(
        Duration::from_secs(1),
        call(
            &app,
            &owner,
            "PATCH",
            &action,
            Some(json!({"enabled":false})),
        ),
    )
    .await
    .unwrap();
    assert_eq!(status, StatusCode::OK);
    mock.release.notify_one();
    running.await.unwrap().unwrap();
    assert!(
        issues(&app, &owner, workspace).await.is_empty(),
        "stale configuration must not commit remote data"
    );
    assert_eq!(store.outbox.claim("openproject", 1).await.unwrap().len(), 0);
    server.abort();
    store.pool.close().await;
    db.cleanup().await;
}

#[tokio::test]
async fn scheduler_recovers_exhausted_jobs_without_duplicate_active_connection_work() {
    let db = support::TestDatabase::new().await;
    let store = Store::connect(&db.url).await.unwrap();
    let owner = account(&store).await;
    let (workspace, team, _) = setup(&store, &owner).await;
    let app = http::router(store.clone());
    let mock = Mock::default();
    let (url, server) = mock_server(mock).await;
    let base = format!("/api/workspaces/{workspace}/openproject/connections");
    let (status, config) = call(&app, &owner, "POST", &base, Some(json!({"name":"Recoverable OP","base_url":url,"token":TOKEN,"projects":[{"project_id":42,"team_id":team}]}))).await;
    assert_eq!(status, StatusCode::CREATED, "{config}");
    let id = Uuid::parse_str(config["id"].as_str().unwrap()).unwrap();
    let (a, b) = tokio::join!(openproject::schedule(&store), openproject::schedule(&store));
    a.unwrap();
    b.unwrap();
    let count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM jobs WHERE queue='openproject' AND state='pending'",
    )
    .fetch_one(&store.pool)
    .await
    .unwrap();
    assert_eq!(count, 1);
    let claim = store
        .outbox
        .claim("openproject", 1)
        .await
        .unwrap()
        .remove(0);
    assert_eq!(claim.max_attempts, 3);
    store
        .outbox
        .fail(&claim, "simulated exhausted request")
        .await
        .unwrap();
    // A due persisted schedule recovers even when the old queue job is terminal.
    sqlx::query("UPDATE openproject_connections SET next_run_at=clock_timestamp()-interval '1 second' WHERE id=$1").bind(id).execute(&store.pool).await.unwrap();
    let restarted = Store::connect(&db.url).await.unwrap();
    drain(&restarted).await;
    restarted.pool.close().await;
    assert_eq!(issues(&app, &owner, workspace).await.len(), 2);
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM jobs WHERE queue='openproject' AND state='failed'"
        )
        .fetch_one(&store.pool)
        .await
        .unwrap(),
        1
    );
    server.abort();
    store.pool.close().await;
    db.cleanup().await;
}

#[tokio::test]
async fn capacity_stops_new_imports_but_existing_work_packages_still_update() {
    let db = support::TestDatabase::new().await;
    let store = Store::connect(&db.url).await.unwrap();
    let owner = account(&store).await;
    let (workspace, team, other_team) = setup(&store, &owner).await;
    let app = http::router(store.clone());
    let mock = Mock::default();
    let (url, server) = mock_server(mock.clone()).await;
    let base = format!("/api/workspaces/{workspace}/openproject/connections");
    let (status, config) = call(&app, &owner, "POST", &base, Some(json!({"name":"Capacity test","base_url":url,"token":TOKEN,"projects":[{"project_id":42,"team_id":team},{"project_id":43,"team_id":other_team}]}))).await;
    assert_eq!(status, StatusCode::CREATED, "{config}");
    let action = format!("{base}/{}", config["id"].as_str().unwrap());
    drain(&store).await;
    let stage: Uuid =
        sqlx::query_scalar("SELECT stage_id FROM issues WHERE workspace_id=$1 LIMIT 1")
            .bind(workspace)
            .fetch_one(&store.pool)
            .await
            .unwrap();
    sqlx::query("INSERT INTO issues(id,workspace_id,number,title,description,team_id,stage_id,priority,position,created_at,updated_at) SELECT gen_random_uuid(),$1,n,'Filler','',$2,$3,'none',n*1024,clock_timestamp(),clock_timestamp() FROM generate_series(3,5000) n").bind(workspace).bind(team).bind(stage).execute(&store.pool).await.unwrap();
    sqlx::query("UPDATE workspaces SET next_issue_number=5001 WHERE id=$1")
        .bind(workspace)
        .execute(&store.pool)
        .await
        .unwrap();
    mock.data.lock().await.moved = true;
    call(&app, &owner, "POST", &format!("{action}/sync"), None).await;
    drain(&store).await;
    let updated: String = sqlx::query_scalar(
        "SELECT title FROM issues WHERE workspace_id=$1 AND openproject->>'work_package_id'='7'",
    )
    .bind(workspace)
    .fetch_one(&store.pool)
    .await
    .unwrap();
    assert_eq!(updated, "Moved package", "updates must work at capacity");
    mock.data.lock().await.extra = true;
    call(&app, &owner, "POST", &format!("{action}/sync"), None).await;
    let mut capacity_failed = false;
    for _ in 0..15 {
        openproject::schedule(&store).await.unwrap();
        let claim = store
            .outbox
            .claim("openproject", 1)
            .await
            .unwrap()
            .remove(0);
        let Job::OpenProject(job) = Job::decode(&claim.kind, &claim.payload).unwrap() else {
            panic!()
        };
        if let Err(error) = openproject::execute(&store, &claim, &job).await {
            let message = openproject::failure_message(&error);
            assert!(message.contains("capacity"), "{message}");
            openproject::record_failure(&store, &job, &message)
                .await
                .unwrap();
            store
                .outbox
                .fail(&claim, "capacity exhausted")
                .await
                .unwrap();
            capacity_failed = true;
            break;
        }
    }
    assert!(capacity_failed);
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM issues WHERE workspace_id=$1")
            .bind(workspace)
            .fetch_one(&store.pool)
            .await
            .unwrap(),
        5000
    );
    assert_eq!(sqlx::query_scalar::<_,i64>("SELECT count(*) FROM issues WHERE workspace_id=$1 AND openproject->>'work_package_id'='9'").bind(workspace).fetch_one(&store.pool).await.unwrap(),0);
    server.abort();
    store.pool.close().await;
    db.cleanup().await;
}

#[tokio::test]
async fn local_cards_can_rebalance_between_read_only_imported_cards() {
    let db = support::TestDatabase::new().await;
    let store = Store::connect(&db.url).await.unwrap();
    let owner = account(&store).await;
    let (workspace, team, _) = setup(&store, &owner).await;
    let app = http::router(store.clone());
    let mock = Mock::default();
    mock.data.lock().await.same_stage = true;
    let (url, server) = mock_server(mock).await;
    let base = format!("/api/workspaces/{workspace}/openproject/connections");
    let (status, config) = call(&app, &owner, "POST", &base, Some(json!({"name":"Mixed board","base_url":url,"token":TOKEN,"projects":[{"project_id":42,"team_id":team}]}))).await;
    assert_eq!(status, StatusCode::CREATED, "{config}");
    drain(&store).await;
    let imported = issues(&app, &owner, workspace).await;
    let first = imported
        .iter()
        .find(|i| i["openproject"]["work_package_id"] == 7)
        .unwrap();
    let second = imported
        .iter()
        .find(|i| i["openproject"]["work_package_id"] == 8)
        .unwrap();
    let stage = Uuid::parse_str(first["stage_id"].as_str().unwrap()).unwrap();
    let first_id = Uuid::parse_str(first["id"].as_str().unwrap()).unwrap();
    let second_id = Uuid::parse_str(second["id"].as_str().unwrap()).unwrap();
    assert_eq!(second["stage_id"], first["stage_id"]);
    let local = store
        .operation(
            workspace,
            owner.profile.id,
            Command::CreateIssue {
                input: serde_json::from_value(
                    json!({"team_id":team,"stage_id":stage,"title":"Local card"}),
                )
                .unwrap(),
            },
            BTreeMap::new(),
            None,
            None,
        )
        .await
        .unwrap()
        .result
        .id
        .unwrap();
    // Reproduce an exhausted rank gap, regardless of initial import spacing.
    let mut tx = store.pool.begin().await.unwrap();
    sqlx::query("SELECT set_config('blackwall.openproject_sync','on',true)")
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query("UPDATE issues SET position=CASE WHEN id=$1 THEN 0 ELSE 1 END WHERE id=ANY($2)")
        .bind(first_id)
        .bind(vec![first_id, second_id])
        .execute(&mut *tx)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    store
        .operation(
            workspace,
            owner.profile.id,
            Command::MoveIssue {
                id: local,
                stage_id: stage,
                before_id: Some(second_id),
            },
            BTreeMap::from([(local, 1)]),
            None,
            None,
        )
        .await
        .unwrap();
    let cards = issues(&app, &owner, workspace).await;
    let position = |id: Uuid| {
        cards.iter().find(|i| i["id"] == id.to_string()).unwrap()["position"]
            .as_i64()
            .unwrap()
    };
    assert!(position(first_id) < position(local));
    assert!(position(local) < position(second_id));
    assert!(
        cards
            .iter()
            .filter(|i| i["openproject"].is_object())
            .count()
            == 2
    );
    server.abort();
    store.pool.close().await;
    db.cleanup().await;
}

#[tokio::test]
async fn people_match_by_email_and_overrides_and_migrated_statuses_reconcile() {
    let db = support::TestDatabase::new().await;
    let store = Store::connect(&db.url).await.unwrap();
    let owner = account(&store).await;
    let member = account(&store).await;
    let outsider = account(&store).await;
    let (workspace, team, other_team) = setup(&store, &owner).await;
    sqlx::query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'member')")
        .bind(workspace)
        .bind(member.profile.id)
        .execute(&store.pool)
        .await
        .unwrap();
    let app = http::router(store.clone());
    let mock = Mock::default();
    {
        let mut data = mock.data.lock().await;
        data.assignee_email = Some(format!(" {} ", owner.profile.email.to_uppercase()));
        data.assignee_id = Some(10);
    }
    let (url, server) = mock_server(mock.clone()).await;
    let base = format!("/api/workspaces/{workspace}/openproject/connections");
    let (status, config) = call(
        &app,
        &owner,
        "POST",
        &base,
        Some(json!({
            "name":"People and statuses","base_url":url,"token":TOKEN,
            "projects":[{"project_id":42,"team_id":team},{"project_id":43,"team_id":other_team}]
        })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{config}");
    let action = format!("{base}/{}", config["id"].as_str().unwrap());
    drain(&store).await;
    let imported = issues(&app, &owner, workspace).await;
    let first = imported
        .iter()
        .find(|issue| issue["openproject"]["work_package_id"] == 7)
        .unwrap();
    assert_eq!(first["assignee"], json!(owner.profile.id));
    let issue_id = first["id"].clone();
    let (_, cached) = call(&app, &owner, "GET", &base, None).await;
    assert_eq!(
        cached["connections"][0]["cached_people"][0]["email"],
        owner.profile.email
    );
    assert_eq!(
        cached["connections"][0]["cached_statuses"]
            .as_array()
            .unwrap()
            .len(),
        2
    );

    // The settings migration uses the existing stage command, then saves its ID in the mapping.
    let migrated = store
        .operation(
            workspace,
            owner.profile.id,
            Command::CreateStage {
                team_id: team,
                name: "Closed".into(),
                kind: blackwall::domain::StageKind::Done,
                position: 5,
            },
            BTreeMap::new(),
            None,
            None,
        )
        .await
        .unwrap()
        .result
        .id
        .unwrap();
    let (status, configured) = call(&app, &owner, "PATCH", &action, Some(json!({
        "people_mapping":{format!(" {} ", owner.profile.email.to_uppercase()): member.profile.id},
        "projects":[{"project_id":42,"team_id":team,"stage_mapping":{"1":migrated,"2":migrated}},
                    {"project_id":43,"team_id":other_team}]
    }))).await;
    assert_eq!(status, StatusCode::OK, "{configured}");
    assert_eq!(
        configured["people_mapping"][&owner.profile.email],
        json!(member.profile.id)
    );
    drain(&store).await;
    let imported = issues(&app, &owner, workspace).await;
    let first = imported
        .iter()
        .find(|issue| issue["id"] == issue_id)
        .unwrap();
    assert_eq!(first["assignee"], json!(member.profile.id));
    assert_eq!(first["stage_id"], json!(migrated));
    assert!(
        imported
            .iter()
            .all(|issue| issue["stage_id"] == json!(migrated))
    );

    for mapping in [
        json!({"remote@example.com": outsider.profile.id}),
        json!({"duplicate@example.com": owner.profile.id," DUPLICATE@example.com ":member.profile.id}),
        json!({"invalid":owner.profile.id}),
    ] {
        let (status, _) = call(
            &app,
            &owner,
            "PATCH",
            &action,
            Some(json!({"people_mapping":mapping})),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
    }
    let (status, preserved) = call(
        &app,
        &owner,
        "PATCH",
        &action,
        Some(json!({"name":"Renamed"})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(preserved["people_mapping"], configured["people_mapping"]);

    // An unknown, hidden or removed assignee clears the old local assignment.
    for (email, assignee) in [
        (Some(outsider.profile.email.clone()), Some(10)),
        (None, Some(10)),
        (Some(owner.profile.email.clone()), None),
    ] {
        {
            let mut data = mock.data.lock().await;
            data.assignee_email = email;
            data.assignee_id = assignee;
        }
        call(&app, &owner, "POST", &format!("{action}/sync"), None).await;
        drain(&store).await;
        let imported = issues(&app, &owner, workspace).await;
        assert!(
            imported
                .iter()
                .find(|issue| issue["id"] == issue_id)
                .unwrap()["assignee"]
                .is_null()
        );
    }
    {
        let mut data = mock.data.lock().await;
        data.moved = true;
        data.closed_first = true;
        data.assignee_id = Some(10);
    }
    call(&app, &owner, "POST", &format!("{action}/sync"), None).await;
    drain(&store).await;
    let imported = issues(&app, &owner, workspace).await;
    let moved = imported
        .iter()
        .find(|issue| issue["id"] == issue_id)
        .unwrap();
    assert_eq!(moved["team_id"], json!(other_team));
    assert_ne!(moved["stage_id"], json!(migrated));
    assert_eq!(moved["assignee"], json!(member.profile.id));
    let kind: String = sqlx::query_scalar("SELECT kind FROM stages WHERE id=$1")
        .bind(Uuid::parse_str(moved["stage_id"].as_str().unwrap()).unwrap())
        .fetch_one(&store.pool)
        .await
        .unwrap();
    assert_eq!(kind, "done");
    server.abort();
    store.pool.close().await;
    db.cleanup().await;
}

#[tokio::test]
async fn mirrored_done_issues_archive_and_reopening_unarchives() {
    let db = support::TestDatabase::new().await;
    let store = Store::connect(&db.url).await.unwrap();
    let owner = account(&store).await;
    let (workspace, a, _) = setup(&store, &owner).await;
    let app = http::router(store.clone());
    let mock = Mock::default();
    let (url, server) = mock_server(mock.clone()).await;
    let base = format!("/api/workspaces/{workspace}/openproject/connections");
    let (status, config) = call(
        &app,
        &owner,
        "POST",
        &base,
        Some(json!({
            "name":"Archive OP","base_url":url,"token":TOKEN,
            "projects":[{"project_id":42,"team_id":a}]
        })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{config}");
    let connection = config["id"].as_str().unwrap();
    let action = format!("{base}/{connection}");
    drain(&store).await;

    // A day-long deadline keeps the test fast without touching other teams.
    let team_version: i64 = sqlx::query_scalar("SELECT version FROM teams WHERE id=$1")
        .bind(a)
        .fetch_one(&store.pool)
        .await
        .unwrap();
    store
        .operation(
            workspace,
            owner.profile.id,
            Command::SetTeamArchive {
                id: a,
                archive_after_days: Some(1),
            },
            BTreeMap::from([(a, team_version)]),
            None,
            None,
        )
        .await
        .unwrap();

    // The closed package mirrors into Done with the archive clock started.
    let closed = issues(&app, &owner, workspace)
        .await
        .into_iter()
        .find(|i| i["openproject"]["work_package_id"] == 8)
        .unwrap();
    let closed_id = Uuid::parse_str(closed["id"].as_str().unwrap()).unwrap();
    let done_at: Option<chrono::DateTime<chrono::Utc>> =
        sqlx::query_scalar("SELECT done_at FROM issues WHERE id=$1")
            .bind(closed_id)
            .fetch_one(&store.pool)
            .await
            .unwrap();
    assert!(
        done_at.is_some(),
        "mirrored Done issues must start the archive clock on import"
    );

    // Ageing past the deadline archives mirrored issues like local ones.
    sqlx::query("UPDATE issues SET done_at=now()-interval '2 days' WHERE id=$1")
        .bind(closed_id)
        .execute(&store.pool)
        .await
        .unwrap();
    assert_eq!(store.archive_sweep().await.unwrap(), 1);
    let visible = issues(&app, &owner, workspace).await;
    assert!(
        visible.iter().all(|i| i["id"] != closed["id"]),
        "archived mirrors must leave default listings"
    );
    let (status, archived) = call(
        &app,
        &owner,
        "GET",
        &format!("/api/workspaces/{workspace}/issues?archived=true"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{archived}");
    assert!(
        archived["items"]
            .as_array()
            .unwrap()
            .iter()
            .any(|i| i["id"] == closed["id"]),
        "archived mirrors must stay reachable through the archive filter"
    );

    // Reopening upstream unarchives on the next sync.
    mock.data.lock().await.same_stage = true;
    call(&app, &owner, "POST", &format!("{action}/sync"), None).await;
    drain(&store).await;
    let reopened = issues(&app, &owner, workspace)
        .await
        .into_iter()
        .find(|i| i["id"] == closed["id"])
        .unwrap();
    assert!(
        reopened["archived_at"].is_null() && reopened["done_at"].is_null(),
        "reopened mirrors must leave the archive with a cleared clock: {reopened}"
    );

    server.abort();
    store.pool.close().await;
    db.cleanup().await;
}
