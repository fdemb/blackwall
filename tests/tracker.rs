#[path = "tracker/comments.rs"]
mod comments;
#[path = "tracker/logging.rs"]
mod logging;
#[path = "tracker/merge.rs"]
mod merge;
#[path = "tracker/parents.rs"]
mod parents;
#[path = "tracker/performance.rs"]
mod performance;
#[path = "tracker/persistence.rs"]
mod persistence;
#[path = "tracker/push.rs"]
mod push;
mod support;
#[path = "tracker/upgrade.rs"]
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
    jobs::{self, Job, Mailer, WorkerConfig},
    store::Store,
    tracker,
};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use std::{collections::BTreeMap, sync::Arc, time::Duration};
use tokio::sync::{Mutex, Notify, watch};
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
    author_id: Option<i64>,
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
    subject: Option<String>,
    description: Option<String>,
    lock_version: i64,
    /// Bodies of accepted and refused PATCH and comment requests, in order.
    patches: Vec<Value>,
    comments: Vec<Value>,
    /// Statuses for the next PATCH or comment requests; success once empty.
    push_statuses: std::collections::VecDeque<u16>,
    /// `updatedAt` of the scanned packages; a fixed time when unset.
    updated_at: Option<String>,
    /// Activities by work package, and the packages whose activities were listed.
    activities: BTreeMap<i64, Vec<Value>>,
    activity_requests: Vec<i64>,
    /// Status for the next activity listings; success once empty.
    activity_statuses: std::collections::VecDeque<u16>,
    /// Comment posts are saved but answered with 504, as if the response was lost.
    lose_comment_responses: bool,
    /// The next PATCH waits for `release` after signalling `entered`.
    stall_patch: bool,
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
            let author_id = data.author_id;
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
            let subject = data.subject.clone();
            let updated_at = data
                .updated_at
                .clone()
                .unwrap_or_else(|| "2026-10-01T10:00:00Z".into());
            let description = data
                .description
                .clone()
                .unwrap_or_else(|| "Imported **description**".into());
            drop(data);
            if stall {
                mock.entered.notify_one();
                mock.release.notified().await;
            }
            let mut packages = vec![];
            if !missing && project == if moved { 43 } else { 42 } {
                packages.push(json!({
                    "id":7,"subject":subject.unwrap_or_else(|| if moved {"Moved package"}else{"First package"}.into()),
                    "description":{"raw":description},"dueDate":deadline,"updatedAt":updated_at,
                    "_links":{"project":{"href":format!("/api/v3/projects/{project}")},
                        "status":{"href":if closed_first {"/api/v3/statuses/2"}else{"/api/v3/statuses/1"},"title":"In progress"},
                        "assignee":{"href":assignee_id.map(|id| format!("/api/v3/users/{id}"))},
                        "author":{"href":author_id.map(|id| format!("/api/v3/users/{id}"))},
                        "priority":{"title":"High"}}
                }));
            }
            if !missing && project == 42 {
                packages.push(
                    json!({"id":8,"subject":"Closed package","description":{"raw":""},"updatedAt":updated_at,
                    "_links":{"project":{"href":"/api/v3/projects/42"},
                        "status":{"href":if same_stage {"/api/v3/statuses/1"}else{"/api/v3/statuses/2"},"title":"Closed"}}}),
                );
            }
            if extra && project == 42 {
                packages.push(json!({"id":9,"subject":"Beyond capacity","description":{"raw":""},
                    "_links":{"project":{"href":"/api/v3/projects/42"},"status":{"href":"/api/v3/statuses/1"}}}));
            }
            for index in 0..bulk_count {
                packages.push(json!({"id":100+index,"subject":format!("Bulk package {index}"),"updatedAt":updated_at,
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

/// Options for connections that test imports alone.
fn import_only() -> Value {
    let both = [
        "status",
        "title",
        "description",
        "assignee",
        "due_date",
        "comments",
    ];
    Value::Object(
        both.into_iter()
            .map(|field| (field.into(), json!({"import":true,"export":false})))
            .collect(),
    )
}

fn authorized(headers: &HeaderMap) {
    assert_eq!(
        headers["authorization"],
        "Basic YXBpa2V5Om9wLXByaXZhdGUtdG9rZW4tZG8tbm90LWxlYWs="
    );
}

fn status_href(closed: bool) -> &'static str {
    if closed {
        "/api/v3/statuses/2"
    } else {
        "/api/v3/statuses/1"
    }
}

async fn work_package(
    State(mock): State<Mock>,
    Path(id): Path<i64>,
    headers: HeaderMap,
) -> (StatusCode, Json<Value>) {
    authorized(&headers);
    let data = mock.data.lock().await;
    (
        StatusCode::OK,
        Json(json!({"id":id,"lockVersion":data.lock_version,
            "_links":{"status":{"href":status_href(data.closed_first)}}})),
    )
}

/// Records the PATCH and applies it to the package the scan serves.
async fn patch_work_package(
    State(mock): State<Mock>,
    Path(id): Path<i64>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> (StatusCode, Json<Value>) {
    authorized(&headers);
    let mut data = mock.data.lock().await;
    if std::mem::take(&mut data.stall_patch) {
        drop(data);
        mock.entered.notify_one();
        mock.release.notified().await;
        data = mock.data.lock().await;
    }
    data.patches.push(body.clone());
    let status = data.push_statuses.pop_front().unwrap_or(200);
    if status == 409 {
        // Someone else saved meanwhile.
        data.lock_version += 1;
    }
    if status != 200 {
        return (
            StatusCode::from_u16(status).unwrap(),
            Json(json!({"message":"remote secret detail"})),
        );
    }
    assert_eq!(body["lockVersion"], data.lock_version, "stale lockVersion");
    data.lock_version += 1;
    if let Some(subject) = body["subject"].as_str() {
        data.subject = Some(subject.into());
    }
    if let Some(description) = body.pointer("/description/raw").and_then(Value::as_str) {
        data.description = Some(description.into());
    }
    if let Some(date) = body["dueDate"].as_str() {
        data.deadline = Some(date.into());
    }
    if let Some(href) = body.pointer("/_links/status/href").and_then(Value::as_str) {
        data.closed_first = href == status_href(true);
    }
    if let Some(assignee) = body.pointer("/_links/assignee") {
        data.assignee_id = assignee["href"]
            .as_str()
            .map(|href| href.rsplit('/').next().unwrap().parse().unwrap());
    }
    (StatusCode::OK, Json(json!({"id":id})))
}

/// The integration account; comments it posts are authored by this user.
const ACCOUNT: i64 = 99;

fn activity(id: usize, user: i64, name: &str, body: &str, created_at: &str) -> Value {
    json!({"id":id,"_type":"Activity::Comment","comment":{"format":"markdown","raw":body},
        "createdAt":created_at,"_links":{"user":{"href":format!("/api/v3/users/{user}"),"title":name}}})
}

async fn comment(
    State(mock): State<Mock>,
    Path(package): Path<i64>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> (StatusCode, Json<Value>) {
    authorized(&headers);
    let mut data = mock.data.lock().await;
    data.comments.push(body.clone());
    let mut status = data.push_statuses.pop_front().unwrap_or(201);
    let id = 500 + data.comments.len();
    if (200..300).contains(&status) || data.lose_comment_responses {
        let raw = body.pointer("/comment/raw").unwrap().as_str().unwrap();
        let now = chrono::Utc::now().to_rfc3339();
        let posted = activity(id, ACCOUNT, "Integration", raw, &now);
        data.activities.entry(package).or_default().push(posted);
        if data.lose_comment_responses {
            status = 504;
        }
    }
    (
        StatusCode::from_u16(status).unwrap(),
        Json(json!({"id":id,"_type":"Activity::Comment"})),
    )
}

/// Like OpenProject, the activity collection is complete and unpaginated.
async fn activities(
    State(mock): State<Mock>,
    Path(package): Path<i64>,
    headers: HeaderMap,
) -> (StatusCode, Json<Value>) {
    authorized(&headers);
    let mut data = mock.data.lock().await;
    data.activity_requests.push(package);
    if let Some(status) = data.activity_statuses.pop_front() {
        return (StatusCode::from_u16(status).unwrap(), Json(json!({})));
    }
    let mut items = vec![json!({"id":1,"_type":"Activity","comment":{"raw":""},
        "createdAt":"2026-01-01T00:00:00Z","_links":{"user":{"href":"/api/v3/users/10"}}})];
    items.extend(data.activities.get(&package).cloned().unwrap_or_default());
    (
        StatusCode::OK,
        Json(json!({"total":items.len(),"count":items.len(),"_embedded":{"elements":items}})),
    )
}

async fn me(headers: HeaderMap) -> Json<Value> {
    authorized(&headers);
    Json(json!({"id":ACCOUNT,"name":"Integration"}))
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
        .route(
            "/api/v3/work_packages/{id}",
            get(work_package).patch(patch_work_package),
        )
        .route(
            "/api/v3/work_packages/{id}/activities",
            get(activities).post(comment),
        )
        .route("/api/v3/users/me", get(me))
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
                    id: None,
                    name: name.into(),
                    key: name.replace("Team ", "T"),
                    members: vec![],
                    default_stage_ids: None,
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
        tracker::schedule(store).await.unwrap();
        let claims = store.outbox.claim("tracker", 1).await.unwrap();
        if claims.is_empty() {
            return;
        }
        let claim = &claims[0];
        assert!(!claim.payload.contains(TOKEN));
        let Job::Tracker(job) = Job::decode(&claim.kind, &claim.payload).unwrap() else {
            panic!("wrong queue kind");
        };
        tracker::execute(store, claim, &job).await.unwrap();
    }
    panic!("tracker scan did not finish within bounded pages");
}

async fn issues(app: &Router, user: &Session, workspace: Uuid) -> Vec<Value> {
    let (status, value) = call(
        app,
        user,
        "GET",
        &format!("/internal-api/workspaces/{workspace}/issues"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{value}");
    value["items"].as_array().unwrap().clone()
}

#[tokio::test]
async fn paginated_sync_is_idempotent_and_reconciles_project_and_team_moves() {
    let db = support::TestDatabase::new().await;
    let store = Store::connect(&db.url).await.unwrap();
    let owner = account(&store).await;
    let (workspace, a, b) = setup(&store, &owner).await;
    let app = http::router(store.clone());
    let mock = Mock::default();
    let (url, server) = mock_server(mock.clone()).await;
    let base = format!("/internal-api/workspaces/{workspace}/trackers/connections");
    let (status, config) = call(
        &app,
        &owner,
        "POST",
        &base,
        Some(json!({
            "provider":"openproject","name":"Private OP","base_url":url,"token":TOKEN,
            "projects":[{"project_id":"42","team_id":a},{"project_id":"43","team_id":b}],
            "options":import_only()
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
        .find(|i| i["tracker"]["remote_id"] == "7")
        .unwrap();
    let first_id = first["id"].clone();
    let first_version = first["version"].clone();
    assert_eq!(first["description"], "Imported **description**");
    assert_eq!(first["priority"], "high");
    assert_eq!(first["team_id"], a.to_string());
    let closed = imported
        .iter()
        .find(|i| i["tracker"]["remote_id"] == "8")
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

    // Synced issues are editable; an unchanged remote keeps the local edit.
    let command = json!({"type":"update_issue","id":first_id,"patch":{"title":"Local change"}});
    let (status, value) = call(&app, &owner, "POST", &format!("/internal-api/workspaces/{workspace}/commands"), Some(json!({"expected_versions":{first_id.as_str().unwrap():first_version},"command":command}))).await;
    assert_eq!(status, StatusCode::OK, "{value}");
    call(&app, &owner, "POST", &format!("{action}/sync"), None).await;
    drain(&store).await;
    let edited = issues(&app, &owner, workspace).await;
    assert_eq!(
        edited.iter().find(|i| i["id"] == first_id).unwrap()["title"],
        "Local change"
    );

    // Team B's first issue takes the number the moved package has in team A.
    let command = json!({"type":"create_issue","input":{"team_id":b,"title":"Local in B"}});
    let (status, value) = call(
        &app,
        &owner,
        "POST",
        &format!("/internal-api/workspaces/{workspace}/commands"),
        Some(json!({"command":command})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{value}");
    let local_in_b = value["result"]["id"].clone();
    mock.data.lock().await.moved = true;
    call(&app, &owner, "POST", &format!("{action}/sync"), None).await;
    drain(&store).await;
    let moved = issues(&app, &owner, workspace).await;
    assert_eq!(moved.len(), 3);
    let local_number = moved.iter().find(|i| i["id"] == local_in_b).unwrap()["number"].clone();
    let moved = moved.iter().find(|i| i["id"] == first_id).unwrap();
    assert_eq!(moved["title"], "Moved package");
    assert_eq!(moved["team_id"], b.to_string());
    assert_eq!(moved["tracker"]["project_id"], "43");
    // Renumbering uses the allocator of local creation, the team's highest number plus one.
    assert_eq!(
        moved["number"],
        local_number.as_u64().unwrap() + 1,
        "numbers count per team"
    );
    // Keys have no aliases: the new key resolves and the old one stops resolving.
    let key = |team: Uuid| {
        sqlx::query_scalar::<_, String>("SELECT key FROM teams WHERE id=$1")
            .bind(team)
            .fetch_one(&store.pool)
    };
    let (key_a, key_b) = (key(a).await.unwrap(), key(b).await.unwrap());
    let number = |issue: &Value| issue["number"].as_u64().unwrap();
    assert_eq!(
        store
            .issue_by_key(workspace, owner.profile.id, &key_b, number(moved))
            .await
            .unwrap()
            .to_string(),
        first_id.as_str().unwrap()
    );
    assert!(matches!(
        store
            .issue_by_key(workspace, owner.profile.id, &key_a, number(first))
            .await,
        Err(blackwall::error::Error::NotFound)
    ));
    sqlx::query(
        "WITH f AS (DELETE FROM issue_followers WHERE issue_id=$1) DELETE FROM issues WHERE id=$1",
    )
    .bind(Uuid::parse_str(local_in_b.as_str().unwrap()).unwrap())
    .execute(&store.pool)
    .await
    .unwrap();

    let (status, _) = call(
        &app,
        &owner,
        "PATCH",
        &action,
        Some(json!({"projects":[{"project_id":"42","team_id":a},{"project_id":"43","team_id":a}]})),
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
        transfer.issues.iter().all(|issue| issue.tracker.is_none()),
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
    assert!(copies.iter().all(|issue| issue["tracker"].is_null()));

    let (status, _) = call(&app, &owner, "DELETE", &action, None).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let retained = issues(&app, &owner, workspace).await;
    assert_eq!(retained.len(), 2);
    assert!(retained.iter().all(|i| i["tracker"].is_object()));
    assert_eq!(
        sqlx::query_scalar::<_, String>("SELECT token FROM tracker_connections WHERE id=$1")
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
    let base = format!("/internal-api/workspaces/{workspace}/trackers/connections");
    let (status, _) = call(&app, &outsider, "GET", &base, None).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _) = call(
        &app,
        &owner,
        "POST",
        &base,
        Some(json!({"provider":"openproject","name":"bad","base_url":"http://user:password@private.example","token":TOKEN})),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, config) = call(&app, &owner, "POST", &base, Some(json!({"provider":"openproject","name":"Slow OP","base_url":url,"token":TOKEN,"projects":[{"project_id":"42","team_id":team}]}))).await;
    assert_eq!(status, StatusCode::CREATED, "{config}");
    let action = format!("{base}/{}", config["id"].as_str().unwrap());
    // Complete project discovery and statuses before stalling the first WP page.
    for _ in 0..4 {
        tracker::schedule(&store).await.unwrap();
        let claim = store.outbox.claim("tracker", 1).await.unwrap().remove(0);
        let Job::Tracker(job) = Job::decode(&claim.kind, &claim.payload).unwrap() else {
            panic!()
        };
        tracker::execute(&store, &claim, &job).await.unwrap();
    }
    mock.data.lock().await.stall = true;
    tracker::schedule(&store).await.unwrap();
    let claim = store.outbox.claim("tracker", 1).await.unwrap().remove(0);
    let Job::Tracker(job) = Job::decode(&claim.kind, &claim.payload).unwrap() else {
        panic!()
    };
    let running_store = store.clone();
    let running = tokio::spawn(async move { tracker::execute(&running_store, &claim, &job).await });
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
    assert_eq!(store.outbox.claim("tracker", 1).await.unwrap().len(), 0);
    server.abort();
    store.pool.close().await;
    db.cleanup().await;
}

#[tokio::test]
async fn worker_schedules_due_connections_despite_frequent_wakeups() {
    async fn wake_and_wait(store: &Store) {
        let marker = Uuid::new_v4();
        sqlx::query("INSERT INTO jobs(id,kind,queue,payload_version,payload) VALUES($1,'webhook','webhook',1,'{}')")
            .bind(marker).execute(&store.pool).await.unwrap();
        store.outbox.ready();
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let state: String = sqlx::query_scalar("SELECT state FROM jobs WHERE id=$1")
                    .bind(marker)
                    .fetch_one(&store.pool)
                    .await
                    .unwrap();
                if state == "failed" {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
    }

    let db = support::TestDatabase::new().await;
    let store = Store::connect(&db.url).await.unwrap();
    let owner = account(&store).await;
    let (workspace, team, _) = setup(&store, &owner).await;
    let app = http::router(store.clone());
    let (url, server) = mock_server(Mock::default()).await;
    let base = format!("/internal-api/workspaces/{workspace}/trackers/connections");
    let (status, connection) = call(
        &app,
        &owner,
        "POST",
        &base,
        Some(
            json!({"provider":"openproject","name":"Polling OP","base_url":url,"token":TOKEN,
            "projects":[{"project_id":"42","team_id":team}]}),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{connection}");
    let id = Uuid::parse_str(connection["id"].as_str().unwrap()).unwrap();
    sqlx::query(
        "UPDATE tracker_connections SET next_run_at=clock_timestamp()+interval '1 hour' WHERE id=$1",
    )
    .bind(id)
    .execute(&store.pool)
    .await
    .unwrap();

    // A blocking task prevents paused time from advancing during PostgreSQL I/O.
    let (release_clock, hold_clock) = std::sync::mpsc::channel::<()>();
    let clock_guard = tokio::task::spawn_blocking(move || {
        let _ = hold_clock.recv_timeout(Duration::from_secs(30));
    });
    tokio::time::pause();
    let poll_interval = Duration::from_secs(3);
    let (stop, shutdown) = watch::channel(false);
    let worker = tokio::spawn(jobs::run_with_config(
        store.clone(),
        Mailer::Disabled,
        shutdown,
        WorkerConfig {
            poll_interval,
            ..WorkerConfig::default()
        },
    ));
    // Marker completion confirms the first scheduler pass and each subsequent wake-up.
    wake_and_wait(&store).await;

    sqlx::query(
        "UPDATE tracker_connections SET next_run_at=clock_timestamp()-interval '1 second' WHERE id=$1",
    )
    .bind(id)
    .execute(&store.pool)
    .await
    .unwrap();
    let mut scheduled_early = false;
    for _ in 0..10 {
        tokio::time::advance(Duration::from_millis(100)).await;
        wake_and_wait(&store).await;
        scheduled_early |= sqlx::query_scalar::<_, bool>(
            "SELECT EXISTS(SELECT 1 FROM jobs WHERE queue='tracker' AND payload->>'connection_id'=$1)",
        )
        .bind(id.to_string())
        .fetch_one(&store.pool)
        .await
        .unwrap();
    }
    tokio::time::advance(Duration::from_secs(2)).await;
    tokio::time::resume();
    drop(release_clock);
    clock_guard.await.unwrap();

    let scheduled = tokio::time::timeout(poll_interval * 2, async {
        loop {
            store.outbox.ready();
            let scheduled: bool = sqlx::query_scalar(
                "SELECT EXISTS(SELECT 1 FROM jobs WHERE queue='tracker' AND payload->>'connection_id'=$1)",
            )
            .bind(id.to_string()).fetch_one(&store.pool).await.unwrap();
            if scheduled {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await;

    stop.send(true).unwrap();
    tokio::time::timeout(Duration::from_secs(2), worker)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    server.abort();
    store.pool.close().await;
    db.cleanup().await;
    assert!(
        !scheduled_early,
        "wake-ups scheduled a connection before the poll deadline"
    );
    scheduled.expect("due connection was not scheduled within two poll intervals");
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
    let base = format!("/internal-api/workspaces/{workspace}/trackers/connections");
    let (status, config) = call(&app, &owner, "POST", &base, Some(json!({"provider":"openproject","name":"Recoverable OP","base_url":url,"token":TOKEN,"projects":[{"project_id":"42","team_id":team}]}))).await;
    assert_eq!(status, StatusCode::CREATED, "{config}");
    let id = Uuid::parse_str(config["id"].as_str().unwrap()).unwrap();
    let (a, b) = tokio::join!(tracker::schedule(&store), tracker::schedule(&store));
    a.unwrap();
    b.unwrap();
    let count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM jobs WHERE queue='tracker' AND state='pending'")
            .fetch_one(&store.pool)
            .await
            .unwrap();
    assert_eq!(count, 1);
    let claim = store.outbox.claim("tracker", 1).await.unwrap().remove(0);
    assert_eq!(claim.max_attempts, 3);
    store
        .outbox
        .fail(&claim, "simulated exhausted request")
        .await
        .unwrap();
    // A due persisted schedule recovers even when the old queue job is terminal.
    sqlx::query(
        "UPDATE tracker_connections SET next_run_at=clock_timestamp()-interval '1 second' WHERE id=$1",
    )
    .bind(id)
    .execute(&store.pool)
    .await
    .unwrap();
    let restarted = Store::connect(&db.url).await.unwrap();
    drain(&restarted).await;
    restarted.pool.close().await;
    assert_eq!(issues(&app, &owner, workspace).await.len(), 2);
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM jobs WHERE queue='tracker' AND state='failed'"
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
async fn record_failure_rechecks_ownership_after_waiting_for_connection_lock() {
    let db = support::TestDatabase::new().await;
    let store = Store::connect(&db.url).await.unwrap();
    let owner = account(&store).await;
    let (workspace, team, _) = setup(&store, &owner).await;
    let app = http::router(store.clone());
    let base = format!("/internal-api/workspaces/{workspace}/trackers/connections");
    let (status, config) = call(&app, &owner, "POST", &base, Some(json!({"provider":"openproject","name":"Failure race","base_url":"http://127.0.0.1:3000","token":TOKEN,"projects":[{"project_id":"42","team_id":team}]}))).await;
    assert_eq!(status, StatusCode::CREATED, "{config}");
    tracker::schedule(&store).await.unwrap();
    let claim = store.outbox.claim("tracker", 1).await.unwrap().remove(0);
    let Job::Tracker(job) = Job::decode(&claim.kind, &claim.payload).unwrap() else {
        panic!("wrong queue kind");
    };
    let connection_id = job.connection_id;
    let job_id = claim.id;
    let mut holding = store.pool.begin().await.unwrap();
    let holding_pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
        .fetch_one(&mut *holding)
        .await
        .unwrap();
    sqlx::query("SELECT id FROM tracker_connections WHERE id=$1 FOR UPDATE")
        .bind(connection_id)
        .fetch_one(&mut *holding)
        .await
        .unwrap();
    let failing_store = store.clone();
    let failure = tokio::spawn(async move {
        tracker::record_failure(&failing_store, &claim, &job, "stale worker failure").await
    });
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let blocked: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND $1=ANY(pg_blocking_pids(pid)))")
                .bind(holding_pid).fetch_one(&store.pool).await.unwrap();
            if blocked {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("record_failure did not block on the connection lock");
    sqlx::query("UPDATE jobs SET claim_token=$2 WHERE id=$1")
        .bind(job_id)
        .bind(Uuid::new_v4())
        .execute(&mut *holding)
        .await
        .unwrap();
    sqlx::query("UPDATE tracker_connections SET status='idle',last_error='' WHERE id=$1")
        .bind(connection_id)
        .execute(&mut *holding)
        .await
        .unwrap();
    holding.commit().await.unwrap();
    tokio::time::timeout(Duration::from_secs(5), failure)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let (status, last_error): (String, String) =
        sqlx::query_as("SELECT status,last_error FROM tracker_connections WHERE id=$1")
            .bind(connection_id)
            .fetch_one(&store.pool)
            .await
            .unwrap();
    store.pool.close().await;
    db.cleanup().await;
    assert_eq!(status, "idle");
    assert_eq!(last_error, "");
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
    let base = format!("/internal-api/workspaces/{workspace}/trackers/connections");
    let (status, config) = call(&app, &owner, "POST", &base, Some(json!({"provider":"openproject","name":"Capacity test","base_url":url,"token":TOKEN,"projects":[{"project_id":"42","team_id":team},{"project_id":"43","team_id":other_team}]}))).await;
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
    mock.data.lock().await.moved = true;
    call(&app, &owner, "POST", &format!("{action}/sync"), None).await;
    drain(&store).await;
    let updated: String = sqlx::query_scalar(
        "SELECT title FROM issues WHERE workspace_id=$1 AND tracker->>'remote_id'='7'",
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
        tracker::schedule(&store).await.unwrap();
        let claim = store.outbox.claim("tracker", 1).await.unwrap().remove(0);
        let Job::Tracker(job) = Job::decode(&claim.kind, &claim.payload).unwrap() else {
            panic!()
        };
        if let Err(error) = tracker::execute(&store, &claim, &job).await {
            let message = tracker::failure_message(&error);
            assert!(message.contains("capacity"), "{message}");
            tracker::record_failure(&store, &claim, &job, &message)
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
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM issues WHERE workspace_id=$1 AND tracker->>'remote_id'='9'"
        )
        .bind(workspace)
        .fetch_one(&store.pool)
        .await
        .unwrap(),
        0
    );
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
    let base = format!("/internal-api/workspaces/{workspace}/trackers/connections");
    let (status, config) = call(&app, &owner, "POST", &base, Some(json!({"provider":"openproject","name":"Mixed board","base_url":url,"token":TOKEN,"projects":[{"project_id":"42","team_id":team}]}))).await;
    assert_eq!(status, StatusCode::CREATED, "{config}");
    drain(&store).await;
    let imported = issues(&app, &owner, workspace).await;
    let first = imported
        .iter()
        .find(|i| i["tracker"]["remote_id"] == "7")
        .unwrap();
    let second = imported
        .iter()
        .find(|i| i["tracker"]["remote_id"] == "8")
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
    assert!(cards.iter().filter(|i| i["tracker"].is_object()).count() == 2);
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
        data.author_id = Some(10);
    }
    let (url, server) = mock_server(mock.clone()).await;
    let base = format!("/internal-api/workspaces/{workspace}/trackers/connections");
    let (status, config) = call(
        &app,
        &owner,
        "POST",
        &base,
        Some(json!({
            "provider":"openproject","name":"People and statuses","base_url":url,"token":TOKEN,
            "projects":[{"project_id":"42","team_id":team},{"project_id":"43","team_id":other_team}]
        })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{config}");
    let action = format!("{base}/{}", config["id"].as_str().unwrap());
    drain(&store).await;
    let imported = issues(&app, &owner, workspace).await;
    let first = imported
        .iter()
        .find(|issue| issue["tracker"]["remote_id"] == "7")
        .unwrap();
    assert_eq!(first["assignee"], json!(owner.profile.id));
    assert_eq!(first["created_by"], json!(owner.profile.id));
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
                id: None,
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
        "projects":[{"project_id":"42","team_id":team,"stage_mapping":{"1":migrated,"2":migrated}},
                    {"project_id":"43","team_id":other_team}]
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
    // The creator is set once, when the issue is first imported.
    assert_eq!(first["created_by"], json!(owner.profile.id));
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
        Some(json!({"provider":"openproject","name":"Renamed"})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(preserved["people_mapping"], configured["people_mapping"]);

    // An unknown, hidden or removed assignee clears the old local assignment.
    // The creator stays as first imported.
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
        let issue = imported
            .iter()
            .find(|issue| issue["id"] == issue_id)
            .unwrap();
        assert!(issue["assignee"].is_null());
        assert_eq!(issue["created_by"], json!(owner.profile.id));
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
    let base = format!("/internal-api/workspaces/{workspace}/trackers/connections");
    let (status, config) = call(
        &app,
        &owner,
        "POST",
        &base,
        Some(json!({
            "provider":"openproject","name":"Archive OP","base_url":url,"token":TOKEN,
            "projects":[{"project_id":"42","team_id":a}]
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
        .find(|i| i["tracker"]["remote_id"] == "8")
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
        &format!("/internal-api/workspaces/{workspace}/issues?archived=true"),
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

#[tokio::test]
async fn corrupt_checkpoint_does_not_block_other_connections() {
    let db = support::TestDatabase::new().await;
    let store = Store::connect(&db.url).await.unwrap();
    let owner = account(&store).await;
    let (workspace, team, other_team) = setup(&store, &owner).await;
    let app = http::router(store.clone());
    let base = format!("/internal-api/workspaces/{workspace}/trackers/connections");
    let url = "http://127.0.0.1:9";
    let (status, healthy) = call(&app, &owner, "POST", &base, Some(json!({"provider":"openproject","name":"Healthy","base_url":url,"token":TOKEN,"projects":[{"project_id":"42","team_id":team}]}))).await;
    assert_eq!(status, StatusCode::CREATED, "{healthy}");
    let (status, broken) = call(&app, &owner, "POST", &base, Some(json!({"provider":"openproject","name":"Broken","base_url":url,"token":TOKEN,"projects":[{"project_id":"43","team_id":other_team}]}))).await;
    assert_eq!(status, StatusCode::CREATED, "{broken}");
    let healthy_id = Uuid::parse_str(healthy["id"].as_str().unwrap()).unwrap();
    let broken_id = Uuid::parse_str(broken["id"].as_str().unwrap()).unwrap();
    // The corrupt row goes first on purpose so a whole-transaction abort would block the healthy one.
    sqlx::query("UPDATE tracker_connections SET checkpoint='{\"phase\":\"nonsense\"}'::jsonb,next_run_at=clock_timestamp()-interval '2 minutes' WHERE id=$1").bind(broken_id).execute(&store.pool).await.unwrap();
    sqlx::query(
        "UPDATE tracker_connections SET next_run_at=clock_timestamp()-interval '1 minute' WHERE id=$1",
    )
    .bind(healthy_id)
    .execute(&store.pool)
    .await
    .unwrap();
    tracker::schedule(&store).await.unwrap();
    let healthy_jobs: i64 = sqlx::query_scalar("SELECT count(*) FROM jobs WHERE queue='tracker' AND state='pending' AND payload->>'connection_id'=$1").bind(healthy_id.to_string()).fetch_one(&store.pool).await.unwrap();
    assert_eq!(healthy_jobs, 1);
    let broken_jobs: i64 = sqlx::query_scalar("SELECT count(*) FROM jobs WHERE queue='tracker' AND state='pending' AND payload->>'connection_id'=$1").bind(broken_id.to_string()).fetch_one(&store.pool).await.unwrap();
    assert_eq!(broken_jobs, 0);
    let row = sqlx::query("SELECT status,last_error,next_run_at>clock_timestamp() AS future FROM tracker_connections WHERE id=$1").bind(broken_id).fetch_one(&store.pool).await.unwrap();
    use sqlx::Row;
    assert_eq!(row.try_get::<String, _>("status").unwrap(), "error");
    assert_eq!(
        row.try_get::<String, _>("last_error").unwrap(),
        "Tracker state is invalid; use Sync now to restart"
    );
    assert!(row.try_get::<bool, _>("future").unwrap());
    tracker::schedule(&store).await.unwrap();
    let healthy_jobs: i64 = sqlx::query_scalar("SELECT count(*) FROM jobs WHERE queue='tracker' AND state='pending' AND payload->>'connection_id'=$1").bind(healthy_id.to_string()).fetch_one(&store.pool).await.unwrap();
    assert_eq!(healthy_jobs, 1);
    let broken_jobs: i64 = sqlx::query_scalar("SELECT count(*) FROM jobs WHERE queue='tracker' AND state='pending' AND payload->>'connection_id'=$1").bind(broken_id.to_string()).fetch_one(&store.pool).await.unwrap();
    assert_eq!(broken_jobs, 0);
    let (status, _) = call(
        &app,
        &owner,
        "POST",
        &format!("{base}/{broken_id}/sync"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED);
    tracker::schedule(&store).await.unwrap();
    let broken_jobs: i64 = sqlx::query_scalar("SELECT count(*) FROM jobs WHERE queue='tracker' AND state='pending' AND payload->>'connection_id'=$1").bind(broken_id.to_string()).fetch_one(&store.pool).await.unwrap();
    assert_eq!(broken_jobs, 1);
    store.pool.close().await;
    db.cleanup().await;
}

#[tokio::test]
async fn providers_describe_options_and_connections_validate_them() {
    let db = support::TestDatabase::new().await;
    let store = Store::connect(&db.url).await.unwrap();
    let owner = account(&store).await;
    let (workspace, _, _) = setup(&store, &owner).await;
    let app = http::router(store.clone());
    let (status, providers) = call(
        &app,
        &owner,
        "GET",
        &format!("/internal-api/workspaces/{workspace}/trackers/providers"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(providers[0]["kind"], "openproject");
    assert_eq!(providers[0]["name"], "OpenProject");
    assert_eq!(
        providers[0]["fields"]["title"],
        json!({"import":true,"export":true})
    );
    assert_eq!(
        providers[0]["fields"]["priority"],
        json!({"import":true,"export":false})
    );
    assert_eq!(providers[0]["defaults"], providers[0]["fields"]);
    let base = format!("/internal-api/workspaces/{workspace}/trackers/connections");
    let input = json!({"name":"Options","base_url":"http://127.0.0.1:9","token":TOKEN});
    let (status, _) = call(&app, &owner, "POST", &base, Some(input.clone())).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "provider is required");
    let mut created = input.clone();
    created["provider"] = json!("openproject");
    created["options"] = json!({"parent":{"import":true,"export":true}});
    let (status, _) = call(&app, &owner, "POST", &base, Some(created.clone())).await;
    assert_eq!(
        status,
        StatusCode::BAD_REQUEST,
        "parent export is not supported"
    );
    created["options"] = json!({"title":{"import":false,"export":false}});
    let (status, config) = call(&app, &owner, "POST", &base, Some(created)).await;
    assert_eq!(status, StatusCode::CREATED, "{config}");
    assert_eq!(config["provider"], "openproject");
    assert_eq!(config["options"]["title"]["import"], false);
    assert_eq!(config["options"]["status"]["import"], true);
    assert_eq!(
        config["options"]["status"]["export"], true,
        "new connections send"
    );
    assert_eq!(config["pending_pushes"], 0);
    let action = format!("{base}/{}", config["id"].as_str().unwrap());
    let (status, updated) = call(
        &app,
        &owner,
        "PATCH",
        &action,
        Some(json!({"options":{"title":{"import":true,"export":false}}})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{updated}");
    assert_eq!(updated["options"]["title"]["import"], true);
    assert_eq!(
        updated["generation"].as_i64().unwrap(),
        config["generation"].as_i64().unwrap() + 1,
        "import changes rescan"
    );
    let (status, _) = call(
        &app,
        &owner,
        "PATCH",
        &action,
        Some(json!({"options":{"labels":{"import":true,"export":false}}})),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "unknown fields");
    store.pool.close().await;
    db.cleanup().await;
}
