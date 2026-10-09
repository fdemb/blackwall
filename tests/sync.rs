mod support;

use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use blackwall::{
    auth::{Register, Session},
    http::router,
    store::Store,
};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use tower::ServiceExt;
use uuid::Uuid;

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
    (status, serde_json::from_slice(&bytes).unwrap())
}

async fn account(store: &Store, name: &str) -> Session {
    store
        .register(Register {
            email: format!("{name}-{}@example.com", Uuid::new_v4()),
            password: "sync-test-password".into(),
            display_name: name.into(),
        })
        .await
        .unwrap()
}

fn id(value: &Value) -> Uuid {
    Uuid::parse_str(value.as_str().unwrap()).unwrap()
}

async fn command(
    app: &axum::Router,
    owner: &Session,
    workspace: Uuid,
    command: Value,
    versions: Option<Value>,
) -> (StatusCode, Value) {
    let mut body = serde_json::Map::new();
    body.insert("command".into(), command);
    if let Some(versions) = versions {
        body.insert("expected_versions".into(), versions);
    }
    call(
        app,
        owner,
        "POST",
        &format!("/api/workspaces/{workspace}/commands"),
        Some(Value::Object(body)),
    )
    .await
}

async fn created(app: &axum::Router, owner: &Session, workspace: Uuid, cmd: Value) -> Uuid {
    let (status, result) = command(app, owner, workspace, cmd, Some(json!({}))).await;
    assert_eq!(status, StatusCode::OK, "{result}");
    id(&result["result"]["id"])
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

async fn setup(app: &axum::Router, owner: &Session) -> (Uuid, Uuid) {
    let ws = workspace(app, owner, "Sync").await;
    let team = created(
        app,
        owner,
        ws,
        json!({"type": "create_team", "name": "Team", "members": [owner.profile.id]}),
    )
    .await;
    (ws, team)
}

async fn items(app: &axum::Router, owner: &Session, workspace: Uuid, resource: &str) -> Vec<Value> {
    let (status, result) = call(
        app,
        owner,
        "GET",
        &format!("/api/workspaces/{workspace}/{resource}"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{result}");
    result["items"].as_array().unwrap().clone()
}

#[tokio::test]
async fn update_without_versions_succeeds_and_stale_version_conflicts() {
    let database = support::TestDatabase::new().await;
    let store = Store::connect(&database.url).await.unwrap();
    let app = router(store.clone());
    let owner = account(&store, "owner").await;
    let (ws, team) = setup(&app, &owner).await;
    let issue = created(
        &app,
        &owner,
        ws,
        json!({"type": "create_issue", "input": {"team_id": team, "title": "Original"}}),
    )
    .await;

    // No expected_versions key at all: last-writer-wins.
    let (status, result) = command(
        &app,
        &owner,
        ws,
        json!({"type": "update_issue", "id": issue, "patch": {"title": "Edited"}}),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{result}");
    assert_eq!(result["versions"][issue.to_string()], 2);

    // A sent stale version still conflicts.
    let stale = command(
        &app,
        &owner,
        ws,
        json!({"type": "update_issue", "id": issue, "patch": {"title": "Stale"}}),
        Some(json!({issue.to_string(): 1})),
    )
    .await;
    assert_eq!(stale.0, StatusCode::CONFLICT, "{}", stale.1);

    // The current version still succeeds.
    let (status, result) = command(
        &app,
        &owner,
        ws,
        json!({"type": "update_issue", "id": issue, "patch": {"title": "Current"}}),
        Some(json!({issue.to_string(): 2})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{result}");
    assert_eq!(result["versions"][issue.to_string()], 3);

    let (status, issue_row) = call(
        &app,
        &owner,
        "GET",
        &format!("/api/workspaces/{ws}/issues/{issue}"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{issue_row}");
    assert_eq!(issue_row["title"], "Current");

    drop(app);
    store.pool.close().await;
    database.cleanup().await;
}

#[tokio::test]
async fn different_field_edits_without_versions_both_win() {
    let database = support::TestDatabase::new().await;
    let store = Store::connect(&database.url).await.unwrap();
    let app = router(store.clone());
    let owner = account(&store, "owner").await;
    let (ws, team) = setup(&app, &owner).await;
    let issue = created(
        &app,
        &owner,
        ws,
        json!({"type": "create_issue", "input": {"team_id": team, "title": "Original"}}),
    )
    .await;

    let title_edit = command(
        &app,
        &owner,
        ws,
        json!({"type": "update_issue", "id": issue, "patch": {"title": "Renamed"}}),
        Some(json!({})),
    );
    let priority_edit = command(
        &app,
        &owner,
        ws,
        json!({"type": "update_issue", "id": issue, "patch": {"priority": "urgent"}}),
        Some(json!({})),
    );
    let (a, b) = tokio::join!(title_edit, priority_edit);
    assert_eq!(a.0, StatusCode::OK, "{}", a.1);
    assert_eq!(b.0, StatusCode::OK, "{}", b.1);

    let (status, issue_row) = call(
        &app,
        &owner,
        "GET",
        &format!("/api/workspaces/{ws}/issues/{issue}"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{issue_row}");
    assert_eq!(issue_row["title"], "Renamed");
    assert_eq!(issue_row["priority"], "urgent");

    drop(app);
    store.pool.close().await;
    database.cleanup().await;
}

#[tokio::test]
async fn bulk_edit_and_upload_without_versions_succeed() {
    let database = support::TestDatabase::new().await;
    let store = Store::connect(&database.url).await.unwrap();
    let app = router(store.clone());
    let owner = account(&store, "owner").await;
    let (ws, team) = setup(&app, &owner).await;
    let first = created(
        &app,
        &owner,
        ws,
        json!({"type": "create_issue", "input": {"team_id": team, "title": "First"}}),
    )
    .await;
    let second = created(
        &app,
        &owner,
        ws,
        json!({"type": "create_issue", "input": {"team_id": team, "title": "Second"}}),
    )
    .await;

    let (status, result) = command(
        &app,
        &owner,
        ws,
        json!({"type": "bulk_issues", "ids": [first, second], "action": {"update": {"priority": "high"}}}),
        Some(json!({})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{result}");

    for issue in [first, second] {
        let (status, issue_row) = call(
            &app,
            &owner,
            "GET",
            &format!("/api/workspaces/{ws}/issues/{issue}"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{issue_row}");
        assert_eq!(issue_row["priority"], "high");
    }

    // Multipart upload with no expected_versions part.
    let boundary = "sync-test-boundary";
    let upload = format!(
        "--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"notes.txt\"\r\nContent-Type: text/plain\r\n\r\nsync notes\r\n--{boundary}--\r\n"
    );
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/api/workspaces/{ws}/issues/{first}/attachments"))
                .header("Authorization", format!("Bearer {}", owner.token))
                .header(
                    "Content-Type",
                    format!("multipart/form-data; boundary={boundary}"),
                )
                .body(Body::from(upload))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);

    let (status, issue_row) = call(
        &app,
        &owner,
        "GET",
        &format!("/api/workspaces/{ws}/issues/{first}"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{issue_row}");
    assert_eq!(issue_row["attachments"].as_array().unwrap().len(), 1);

    drop(app);
    store.pool.close().await;
    database.cleanup().await;
}

#[tokio::test]
async fn creates_honor_client_chosen_ids() {
    let database = support::TestDatabase::new().await;
    let store = Store::connect(&database.url).await.unwrap();
    let app = router(store.clone());
    let owner = account(&store, "owner").await;
    let ws = workspace(&app, &owner, "Client ids").await;

    let team_id = Uuid::new_v4();
    let (status, result) = command(
        &app,
        &owner,
        ws,
        json!({"type": "create_team", "id": team_id, "name": "Team", "members": [owner.profile.id]}),
        Some(json!({})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{result}");
    assert_eq!(id(&result["result"]["id"]), team_id);
    assert!(
        items(&app, &owner, ws, "teams")
            .await
            .iter()
            .any(|t| t["id"] == team_id.to_string())
    );

    let stage_id = Uuid::new_v4();
    let (status, result) = command(
        &app,
        &owner,
        ws,
        json!({"type": "create_stage", "id": stage_id, "team_id": team_id, "name": "Review", "kind": "active", "position": 99}),
        Some(json!({})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{result}");
    assert_eq!(id(&result["result"]["id"]), stage_id);

    let label_id = Uuid::new_v4();
    let (status, result) = command(
        &app,
        &owner,
        ws,
        json!({"type": "create_label", "id": label_id, "name": "bug", "color": "#ef4444"}),
        Some(json!({})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{result}");
    assert_eq!(id(&result["result"]["id"]), label_id);
    assert!(
        items(&app, &owner, ws, "labels")
            .await
            .iter()
            .any(|l| l["id"] == label_id.to_string())
    );

    let project_id = Uuid::new_v4();
    let (status, result) = command(
        &app,
        &owner,
        ws,
        json!({"type": "create_project", "id": project_id, "name": "Launch", "description": "", "team_ids": [team_id]}),
        Some(json!({})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{result}");
    assert_eq!(id(&result["result"]["id"]), project_id);
    assert!(
        items(&app, &owner, ws, "projects")
            .await
            .iter()
            .any(|p| p["id"] == project_id.to_string())
    );

    let milestone_id = Uuid::new_v4();
    let (status, result) = command(
        &app,
        &owner,
        ws,
        json!({"type": "create_milestone", "id": milestone_id, "project_id": project_id, "name": "Beta", "deadline": null}),
        Some(json!({})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{result}");
    assert_eq!(id(&result["result"]["id"]), milestone_id);
    assert!(
        items(&app, &owner, ws, "milestones")
            .await
            .iter()
            .any(|m| m["id"] == milestone_id.to_string())
    );

    let now = chrono::Utc::now().to_rfc3339();
    let later = (chrono::Utc::now() + chrono::Duration::days(7)).to_rfc3339();
    let sprint_id = Uuid::new_v4();
    let (status, result) = command(
        &app,
        &owner,
        ws,
        json!({"type": "create_sprint", "id": sprint_id, "team_id": team_id, "name": "One", "goal": "Ship", "starts_at": now, "ends_at": later}),
        Some(json!({})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{result}");
    assert_eq!(id(&result["result"]["id"]), sprint_id);
    assert!(
        items(&app, &owner, ws, "sprints")
            .await
            .iter()
            .any(|s| s["id"] == sprint_id.to_string())
    );

    let issue_id = Uuid::new_v4();
    let (status, result) = command(
        &app,
        &owner,
        ws,
        json!({"type": "create_issue", "input": {"id": issue_id, "team_id": team_id, "title": "Chosen"}}),
        Some(json!({})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{result}");
    assert_eq!(id(&result["result"]["id"]), issue_id);
    let (status, issue_row) = call(
        &app,
        &owner,
        "GET",
        &format!("/api/workspaces/{ws}/issues/{issue_id}"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{issue_row}");
    assert_eq!(issue_row["id"], issue_id.to_string());

    let comment_id = Uuid::new_v4();
    let (status, result) = command(
        &app,
        &owner,
        ws,
        json!({"type": "add_comment", "id": comment_id, "issue_id": issue_id, "body": "Note", "mentions": [], "attachments": []}),
        Some(json!({})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{result}");
    assert_eq!(id(&result["result"]["id"]), comment_id);
    assert!(
        items(&app, &owner, ws, &format!("comments?issue_id={issue_id}"))
            .await
            .iter()
            .any(|c| c["id"] == comment_id.to_string())
    );

    let entry_id = Uuid::new_v4();
    let (status, result) = command(
        &app,
        &owner,
        ws,
        json!({"type": "log_time", "id": entry_id, "issue_id": issue_id, "minutes": 30, "note": "Work", "logged_at": now}),
        Some(json!({})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{result}");
    assert_eq!(id(&result["result"]["id"]), entry_id);
    assert!(
        items(
            &app,
            &owner,
            ws,
            &format!("time_entries?issue_id={issue_id}")
        )
        .await
        .iter()
        .any(|e| e["id"] == entry_id.to_string())
    );

    let view_id = Uuid::new_v4();
    let (status, result) = command(
        &app,
        &owner,
        ws,
        json!({"type": "save_view", "id": view_id, "name": "Mine", "shared": false, "filter": {}}),
        Some(json!({})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{result}");
    assert_eq!(id(&result["result"]["id"]), view_id);
    assert!(
        items(&app, &owner, ws, "views")
            .await
            .iter()
            .any(|v| v["id"] == view_id.to_string())
    );

    let integration_id = Uuid::new_v4();
    let (status, result) = command(
        &app,
        &owner,
        ws,
        json!({"type": "create_integration", "id": integration_id, "name": "Hook", "webhook_url": "https://example.invalid/hook", "secret": "secret"}),
        Some(json!({})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{result}");
    assert_eq!(id(&result["result"]["id"]), integration_id);
    assert!(
        items(&app, &owner, ws, "integrations")
            .await
            .iter()
            .any(|i| i["id"] == integration_id.to_string())
    );

    // Imported issues honor supplied ids too, so offline parent links survive.
    let parent_id = Uuid::new_v4();
    let child_id = Uuid::new_v4();
    let (status, result) = call(
        &app,
        &owner,
        "POST",
        &format!("/api/workspaces/{ws}/import"),
        Some(json!({"issues": [
            {"id": parent_id, "team_id": team_id, "title": "Imported parent"},
            {"id": child_id, "team_id": team_id, "title": "Imported child", "parent_id": parent_id},
        ]})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{result}");
    let (status, child) = call(
        &app,
        &owner,
        "GET",
        &format!("/api/workspaces/{ws}/issues/{child_id}"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{child}");
    assert_eq!(child["parent_id"], parent_id.to_string());

    drop(app);
    store.pool.close().await;
    database.cleanup().await;
}

#[tokio::test]
async fn reused_ids_conflict_and_nil_ids_rejected() {
    let database = support::TestDatabase::new().await;
    let store = Store::connect(&database.url).await.unwrap();
    let app = router(store.clone());
    let owner = account(&store, "owner").await;
    let (ws, team) = setup(&app, &owner).await;

    let label_id = Uuid::new_v4();
    let (status, result) = command(
        &app,
        &owner,
        ws,
        json!({"type": "create_label", "id": label_id, "name": "bug", "color": "#ef4444"}),
        Some(json!({})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{result}");

    let (status, result) = command(
        &app,
        &owner,
        ws,
        json!({"type": "create_label", "id": label_id, "name": "duplicate", "color": "#000000"}),
        Some(json!({})),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "{result}");
    assert_eq!(result["error"], "id already exists");

    // Ids are global: reuse in another workspace conflicts without naming it.
    let other = workspace(&app, &owner, "Other").await;
    let (status, result) = command(
        &app,
        &owner,
        other,
        json!({"type": "create_label", "id": label_id, "name": "elsewhere", "color": "#000000"}),
        Some(json!({})),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "{result}");
    assert_eq!(result["error"], "id already exists");
    assert!(!result["error"].as_str().unwrap().contains(&ws.to_string()));
    assert!(
        !result["error"]
            .as_str()
            .unwrap()
            .contains(&other.to_string())
    );

    let issue_id = Uuid::new_v4();
    let (status, result) = command(
        &app,
        &owner,
        ws,
        json!({"type": "create_issue", "input": {"id": issue_id, "team_id": team, "title": "First"}}),
        Some(json!({})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{result}");

    let (status, result) = command(
        &app,
        &owner,
        ws,
        json!({"type": "create_issue", "input": {"id": issue_id, "team_id": team, "title": "Second"}}),
        Some(json!({})),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "{result}");
    assert_eq!(result["error"], "id already exists");

    let nil = Uuid::nil().to_string();
    let (status, result) = command(
        &app,
        &owner,
        ws,
        json!({"type": "create_label", "id": nil, "name": "nil", "color": "#000000"}),
        Some(json!({})),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{result}");

    let (status, result) = command(
        &app,
        &owner,
        ws,
        json!({"type": "create_issue", "input": {"id": nil, "team_id": team, "title": "Nil"}}),
        Some(json!({})),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{result}");

    drop(app);
    store.pool.close().await;
    database.cleanup().await;
}

#[tokio::test]
async fn cross_type_ids_conflict() {
    let database = support::TestDatabase::new().await;
    let store = Store::connect(&database.url).await.unwrap();
    let app = router(store.clone());
    let owner = account(&store, "owner").await;
    let (ws, team) = setup(&app, &owner).await;

    let now = chrono::Utc::now().to_rfc3339();
    let later = (chrono::Utc::now() + chrono::Duration::days(7)).to_rfc3339();

    // Sprint id cannot be reused by an issue (the reviewer's setup).
    let sprint = created(
        &app,
        &owner,
        ws,
        json!({"type": "create_sprint", "team_id": team, "name": "One", "goal": "Ship", "starts_at": now, "ends_at": later}),
    )
    .await;
    let (status, result) = command(
        &app,
        &owner,
        ws,
        json!({"type": "create_issue", "input": {"id": sprint, "team_id": team, "title": "Collision"}}),
        Some(json!({})),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "{result}");
    assert_eq!(result["error"], "id already exists");

    // Stage id cannot be reused by another entity.
    let stage_id = Uuid::new_v4();
    let (status, result) = command(
        &app,
        &owner,
        ws,
        json!({"type": "create_stage", "id": stage_id, "team_id": team, "name": "Review", "kind": "active", "position": 99}),
        Some(json!({})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{result}");
    let (status, result) = command(
        &app,
        &owner,
        ws,
        json!({"type": "create_label", "id": stage_id, "name": "collision", "color": "#000000"}),
        Some(json!({})),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "{result}");
    assert_eq!(result["error"], "id already exists");

    // Comment id cannot be reused by another entity.
    let issue = created(
        &app,
        &owner,
        ws,
        json!({"type": "create_issue", "input": {"team_id": team, "title": "Target"}}),
    )
    .await;
    let comment = created(
        &app,
        &owner,
        ws,
        json!({"type": "add_comment", "issue_id": issue, "body": "Note", "mentions": [], "attachments": []}),
    )
    .await;
    for (kind, cmd) in [
        (
            "issue",
            json!({"type": "create_issue", "input": {"id": comment, "team_id": team, "title": "Collision"}}),
        ),
        (
            "label",
            json!({"type": "create_label", "id": comment, "name": "collision", "color": "#000000"}),
        ),
    ] {
        let (status, result) = command(&app, &owner, ws, cmd, Some(json!({}))).await;
        assert_eq!(status, StatusCode::CONFLICT, "{kind}: {result}");
        assert_eq!(result["error"], "id already exists");
    }

    // A few more cross-type pairs.
    let label_id = Uuid::new_v4();
    let (status, result) = command(
        &app,
        &owner,
        ws,
        json!({"type": "create_label", "id": label_id, "name": "bug", "color": "#ef4444"}),
        Some(json!({})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{result}");
    let (status, result) = command(
        &app,
        &owner,
        ws,
        json!({"type": "create_project", "id": label_id, "name": "Collision", "description": "", "team_ids": []}),
        Some(json!({})),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "{result}");
    assert_eq!(result["error"], "id already exists");

    let teams = items(&app, &owner, ws, "teams").await;
    let team_id = id(&teams[0]["id"]);
    let (status, result) = command(
        &app,
        &owner,
        ws,
        json!({"type": "create_label", "id": team_id, "name": "collision", "color": "#000000"}),
        Some(json!({})),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "{result}");
    assert_eq!(result["error"], "id already exists");

    drop(app);
    store.pool.close().await;
    database.cleanup().await;
}

#[tokio::test]
async fn concurrent_cross_type_creates_only_one_wins() {
    let database = support::TestDatabase::new().await;
    let store = Store::connect(&database.url).await.unwrap();
    let app = router(store.clone());
    let owner = account(&store, "owner").await;
    let ws = workspace(&app, &owner, "Concurrent").await;

    // Separate tasks on separate pool connections race on the same id.
    let shared = Uuid::new_v4();
    let label = command(
        &app,
        &owner,
        ws,
        json!({"type": "create_label", "id": shared, "name": "race", "color": "#ef4444"}),
        Some(json!({})),
    );
    let project = command(
        &app,
        &owner,
        ws,
        json!({"type": "create_project", "id": shared, "name": "Race", "description": "", "team_ids": []}),
        Some(json!({})),
    );
    let (a, b) = tokio::join!(label, project);

    let ok = [a.0, b.0].iter().filter(|s| **s == StatusCode::OK).count();
    let conflicts = [&a.1, &b.1]
        .iter()
        .filter(|r| r["error"] == "id already exists")
        .count();
    assert_eq!(ok, 1, "label={} project={}", a.1, b.1);
    assert_eq!(conflicts, 1, "label={} project={}", a.1, b.1);

    drop(app);
    store.pool.close().await;
    database.cleanup().await;
}

#[tokio::test]
async fn sprint_completion_bumps_colliding_issue_version() {
    use sqlx::Row;

    let database = support::TestDatabase::new().await;
    let store = Store::connect(&database.url).await.unwrap();
    let app = router(store.clone());
    let owner = account(&store, "owner").await;
    let (ws, team) = setup(&app, &owner).await;

    let now = chrono::Utc::now().to_rfc3339();
    let later = (chrono::Utc::now() + chrono::Duration::days(7)).to_rfc3339();
    let sprint = created(
        &app,
        &owner,
        ws,
        json!({"type": "create_sprint", "team_id": team, "name": "One", "goal": "Ship", "starts_at": now, "ends_at": later}),
    )
    .await;
    let issue = created(
        &app,
        &owner,
        ws,
        json!({"type": "create_issue", "input": {"team_id": team, "title": "Work", "sprint_id": sprint}}),
    )
    .await;

    // The API now refuses cross-type reuse, so collide the rows with SQL.
    sqlx::query("DELETE FROM issue_followers WHERE workspace_id=$1 AND issue_id=$2")
        .bind(ws)
        .bind(issue)
        .execute(&store.pool)
        .await
        .unwrap();
    sqlx::query("UPDATE issues SET id=$1 WHERE workspace_id=$2 AND id=$3")
        .bind(sprint)
        .bind(ws)
        .bind(issue)
        .execute(&store.pool)
        .await
        .unwrap();

    // Complete without preconditions, as in the reviewer's scenario.
    let (status, result) = command(
        &app,
        &owner,
        ws,
        json!({"type": "complete_sprint", "id": sprint}),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{result}");
    // The id is recorded under both sprints and issues, so it is ambiguous
    // and left out of the response instead of reporting one version.
    assert!(result["versions"].get(sprint.to_string()).is_none());

    let sprint_version: i64 = sqlx::query_scalar("SELECT version FROM sprints WHERE id=$1")
        .bind(sprint)
        .fetch_one(&store.pool)
        .await
        .unwrap();
    let issue_version: i64 = sqlx::query_scalar("SELECT version FROM issues WHERE id=$1")
        .bind(sprint)
        .fetch_one(&store.pool)
        .await
        .unwrap();
    assert_eq!(sprint_version, 2);
    assert_eq!(issue_version, 2);

    let sprint_cleared: Option<Uuid> = sqlx::query("SELECT sprint_id FROM issues WHERE id=$1")
        .bind(sprint)
        .fetch_one(&store.pool)
        .await
        .unwrap()
        .try_get("sprint_id")
        .unwrap();
    assert_eq!(sprint_cleared, None);

    // The obsolete version 1 must no longer succeed.
    let (status, result) = command(
        &app,
        &owner,
        ws,
        json!({"type": "update_issue", "id": sprint, "patch": {"title": "Stale"}}),
        Some(json!({sprint.to_string(): 1})),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "{result}");

    drop(app);
    store.pool.close().await;
    database.cleanup().await;
}

#[tokio::test]
async fn in_memory_model_rejects_cross_collection_ids() {
    use blackwall::domain::{Command, IssueInput, Priority, Workspace};
    use blackwall::error::Error;

    let owner = Uuid::new_v4();
    let mut w = Workspace::new("Memory".into(), owner).unwrap();
    let now = chrono::Utc::now();
    let team = w
        .apply(
            owner,
            Command::CreateTeam {
                id: None,
                name: "Team".into(),
                members: vec![owner],
                default_stage_ids: None,
            },
            now,
        )
        .unwrap()
        .id
        .unwrap();

    let sprint = w
        .apply(
            owner,
            Command::CreateSprint {
                id: None,
                team_id: team,
                name: "One".into(),
                goal: "Ship".into(),
                starts_at: now,
                ends_at: now + chrono::Duration::days(7),
            },
            now,
        )
        .unwrap()
        .id
        .unwrap();

    let input = |id: Uuid| IssueInput {
        id: Some(id),
        title: "Collision".into(),
        description: String::new(),
        team_id: team,
        stage_id: None,
        assignee: None,
        priority: Priority::Normal,
        labels: vec![],
        estimate: None,
        deadline: None,
        project_id: None,
        milestone_id: None,
        sprint_id: None,
        parent_id: None,
        dependencies: vec![],
    };

    assert!(matches!(
        w.apply(
            owner,
            Command::CreateIssue {
                input: input(sprint)
            },
            now
        ),
        Err(Error::Conflict(_))
    ));
    assert!(matches!(
        w.apply(
            owner,
            Command::CreateLabel {
                id: Some(sprint),
                name: "bug".into(),
                color: "#ef4444".into(),
            },
            now,
        ),
        Err(Error::Conflict(_))
    ));

    let activity_id = w.activity[0].id;
    assert!(matches!(
        w.apply(
            owner,
            Command::CreateLabel {
                id: Some(activity_id),
                name: "bug".into(),
                color: "#ef4444".into(),
            },
            now,
        ),
        Err(Error::Conflict(_))
    ));
    let workspace_id = w.id;
    assert!(matches!(
        w.apply(
            owner,
            Command::CreateLabel {
                id: Some(workspace_id),
                name: "bug".into(),
                color: "#ef4444".into(),
            },
            now,
        ),
        Err(Error::Conflict(_))
    ));
}

#[tokio::test]
async fn concurrent_imports_in_opposite_order_never_deadlock() {
    let database = support::TestDatabase::new().await;
    let store = Store::connect(&database.url).await.unwrap();
    let app = router(store.clone());
    let owner = account(&store, "owner").await;
    let ws_a = workspace(&app, &owner, "Import A").await;
    let team_a = created(
        &app,
        &owner,
        ws_a,
        json!({"type": "create_team", "name": "Team", "members": [owner.profile.id]}),
    )
    .await;
    let ws_b = workspace(&app, &owner, "Import B").await;
    let team_b = created(
        &app,
        &owner,
        ws_b,
        json!({"type": "create_team", "name": "Team", "members": [owner.profile.id]}),
    )
    .await;

    let first = Uuid::new_v4();
    let second = Uuid::new_v4();

    // Hold both id buckets open so both imports queue behind this transaction.
    // Releasing it lets the imports overlap while each waits for the other's
    // first lock; sorted reservation still lets one finish with 409 for the
    // loser instead of deadlocking into a 500.
    let mut holder = store.pool.begin().await.unwrap();
    let mut buckets: Vec<i64> = [first, second]
        .iter()
        .map(|id| (id.as_u128() & 63) as i64)
        .collect();
    buckets.sort_unstable();
    buckets.dedup();
    for bucket in buckets {
        sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1, 53177))")
            .bind(format!("client-id-bucket:{bucket}"))
            .execute(&mut *holder)
            .await
            .unwrap();
    }

    let url_a = format!("/api/workspaces/{ws_a}/import");
    let url_b = format!("/api/workspaces/{ws_b}/import");
    let import_a = call(
        &app,
        &owner,
        "POST",
        &url_a,
        Some(json!({"issues": [
            {"id": first, "team_id": team_a, "title": "A first"},
            {"id": second, "team_id": team_a, "title": "A second"},
        ]})),
    );
    let import_b = call(
        &app,
        &owner,
        "POST",
        &url_b,
        Some(json!({"issues": [
            {"id": second, "team_id": team_b, "title": "B second"},
            {"id": first, "team_id": team_b, "title": "B first"},
        ]})),
    );
    let release = async {
        let start = std::time::Instant::now();
        loop {
            let blocked: i64 = sqlx::query_scalar(
                "SELECT count(*) FROM pg_locks WHERE locktype = 'advisory' AND NOT granted",
            )
            .fetch_one(&store.pool)
            .await
            .unwrap();
            if blocked >= 2 {
                break;
            }
            assert!(
                start.elapsed() < std::time::Duration::from_secs(20),
                "imports never queued on the held id locks"
            );
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        holder.commit().await.unwrap();
    };

    let (a, b, ()) = tokio::join!(import_a, import_b, release);
    for (status, body) in [&a, &b] {
        assert_ne!(*status, StatusCode::INTERNAL_SERVER_ERROR, "{body}");
    }
    let mut outcomes = [(&a, ws_a), (&b, ws_b)];
    outcomes.sort_by_key(|((status, _), _)| *status);
    assert_eq!(outcomes[0].0.0, StatusCode::OK, "{}", outcomes[0].0.1);
    assert_eq!(outcomes[1].0.0, StatusCode::CONFLICT, "{}", outcomes[1].0.1);
    assert_eq!(outcomes[1].0.1["error"], "id already exists");

    // The winner imported both issues in request order; the loser none.
    assert_eq!(items(&app, &owner, outcomes[0].1, "issues").await.len(), 2);

    drop(app);
    store.pool.close().await;
    database.cleanup().await;
}

#[tokio::test]
async fn client_ids_conflict_with_workspace_activity_source_link_and_connection_ids() {
    let database = support::TestDatabase::new().await;
    let store = Store::connect(&database.url).await.unwrap();
    let app = router(store.clone());
    let owner = account(&store, "owner").await;
    let (ws, team) = setup(&app, &owner).await;

    // Every command leaves an activity row; its id is reserved.
    let activity_id: Uuid =
        sqlx::query_scalar("SELECT id FROM activity WHERE workspace_id = $1 LIMIT 1")
            .bind(ws)
            .fetch_one(&store.pool)
            .await
            .unwrap();
    let (status, result) = command(
        &app,
        &owner,
        ws,
        json!({"type": "create_label", "id": activity_id, "name": "collision", "color": "#000000"}),
        Some(json!({})),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "{result}");
    assert_eq!(result["error"], "id already exists");

    // The workspace id itself is reserved too.
    let (status, result) = command(
        &app,
        &owner,
        ws,
        json!({"type": "create_label", "id": ws, "name": "collision", "color": "#000000"}),
        Some(json!({})),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "{result}");
    assert_eq!(result["error"], "id already exists");

    // Source link ids are server-generated; reusing one still conflicts.
    let issue = created(
        &app,
        &owner,
        ws,
        json!({"type": "create_issue", "input": {"team_id": team, "title": "Target"}}),
    )
    .await;
    let (status, result) = command(
        &app,
        &owner,
        ws,
        json!({"type": "add_source_link", "issue_id": issue, "url": "https://example.invalid/spec", "title": "Spec"}),
        Some(json!({})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{result}");
    let link_id: Uuid =
        sqlx::query_scalar("SELECT id FROM source_links WHERE workspace_id = $1 LIMIT 1")
            .bind(ws)
            .fetch_one(&store.pool)
            .await
            .unwrap();
    let (status, result) = command(
        &app,
        &owner,
        ws,
        json!({"type": "create_label", "id": link_id, "name": "collision", "color": "#000000"}),
        Some(json!({})),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "{result}");
    assert_eq!(result["error"], "id already exists");

    // So are OpenProject connection ids.
    let connection = Uuid::new_v4();
    sqlx::query("INSERT INTO openproject_connections(id, workspace_id, name, base_url, token) VALUES($1, $2, 'Legacy', 'https://example.invalid', 'secret')")
        .bind(connection)
        .bind(ws)
        .execute(&store.pool)
        .await
        .unwrap();
    let (status, result) = command(
        &app,
        &owner,
        ws,
        json!({"type": "create_label", "id": connection, "name": "collision", "color": "#000000"}),
        Some(json!({})),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "{result}");
    assert_eq!(result["error"], "id already exists");

    drop(app);
    store.pool.close().await;
    database.cleanup().await;
}

#[tokio::test]
async fn colliding_stage_and_issue_omit_ambiguous_version() {
    let database = support::TestDatabase::new().await;
    let store = Store::connect(&database.url).await.unwrap();
    let app = router(store.clone());
    let owner = account(&store, "owner").await;
    let (ws, team) = setup(&app, &owner).await;

    // A stage at version 2 and an issue at version 1 sharing one id.
    let stage = created(
        &app,
        &owner,
        ws,
        json!({"type": "create_stage", "team_id": team, "name": "Review", "kind": "active", "position": 99}),
    )
    .await;
    let (status, result) = command(
        &app,
        &owner,
        ws,
        json!({"type": "update_stage", "team_id": team, "id": stage, "name": "Review", "kind": "active", "position": 100}),
        Some(json!({})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{result}");
    assert_eq!(result["versions"][stage.to_string()], 2);

    let replacement = created(
        &app,
        &owner,
        ws,
        json!({"type": "create_stage", "team_id": team, "name": "Later", "kind": "planned", "position": 101}),
    )
    .await;
    let issue = created(
        &app,
        &owner,
        ws,
        json!({"type": "create_issue", "input": {"team_id": team, "stage_id": stage, "title": "Work"}}),
    )
    .await;

    // The API refuses cross-type reuse, so collide the rows with SQL.
    sqlx::query("DELETE FROM issue_followers WHERE workspace_id=$1 AND issue_id=$2")
        .bind(ws)
        .bind(issue)
        .execute(&store.pool)
        .await
        .unwrap();
    sqlx::query("UPDATE issues SET id=$1 WHERE workspace_id=$2 AND id=$3")
        .bind(stage)
        .bind(ws)
        .bind(issue)
        .execute(&store.pool)
        .await
        .unwrap();

    // Deleting the stage touches the stage row and the colliding issue row
    // under the same id at unequal versions.
    let (status, result) = command(
        &app,
        &owner,
        ws,
        json!({"type": "delete_stage", "team_id": team, "id": stage, "replacement": replacement}),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{result}");
    assert!(
        result["versions"].get(stage.to_string()).is_none(),
        "{result}"
    );

    // The issue row itself still moved and bumped to version 2.
    let issue_version: i64 = sqlx::query_scalar("SELECT version FROM issues WHERE id=$1")
        .bind(stage)
        .fetch_one(&store.pool)
        .await
        .unwrap();
    assert_eq!(issue_version, 2);
    let moved: Uuid = sqlx::query_scalar("SELECT stage_id FROM issues WHERE id=$1")
        .bind(stage)
        .fetch_one(&store.pool)
        .await
        .unwrap();
    assert_eq!(moved, replacement);

    drop(app);
    store.pool.close().await;
    database.cleanup().await;
}

#[tokio::test]
async fn large_import_with_client_ids_succeeds() {
    let database = support::TestDatabase::new().await;
    let store = Store::connect(&database.url).await.unwrap();
    let app = router(store.clone());
    let owner = account(&store, "owner").await;
    let (ws, team) = setup(&app, &owner).await;

    // 5000 supplied ids map to at most 64 buckets, so one import can no
    // longer exhaust the shared lock table no matter how many ids it
    // reserves. The import itself must still succeed end to end.
    let issues: Vec<Value> = (0..5000)
        .map(|n| json!({"id": Uuid::new_v4(), "team_id": team, "title": format!("Bulk {n}")}))
        .collect();
    let (status, result) = call(
        &app,
        &owner,
        "POST",
        &format!("/api/workspaces/{ws}/import"),
        Some(json!({"issues": issues})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{result}");

    let stored: i64 = sqlx::query_scalar("SELECT count(*) FROM issues WHERE workspace_id = $1")
        .bind(ws)
        .fetch_one(&store.pool)
        .await
        .unwrap();
    assert_eq!(stored, 5000);

    drop(app);
    store.pool.close().await;
    database.cleanup().await;
}
