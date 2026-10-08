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
