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

async fn send(app: &axum::Router, path: &str, token: &str, body: Value) -> Value {
    let request = Request::builder()
        .method("POST")
        .uri(path)
        .header("Authorization", format!("Bearer {token}"))
        .header("Content-Type", "application/json")
        .body(Body::from(body.to_string()))
        .unwrap();
    let response = app.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let value: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(status, StatusCode::OK, "{value}");
    value
}

async fn account(store: &Store, name: &str) -> Session {
    store
        .register(Register {
            email: format!("{name}-{}@example.com", Uuid::new_v4()),
            password: "mcp-password-123".into(),
            display_name: name.into(),
            invitation: None,
        })
        .await
        .unwrap()
        .session()
        .unwrap()
}

async fn token(app: &axum::Router, user: &Session, body: Value) -> String {
    let request = Request::builder()
        .method("POST")
        .uri("/internal-api/me/tokens")
        .header("Authorization", format!("Bearer {}", user.token))
        .header("Content-Type", "application/json")
        .body(Body::from(body.to_string()))
        .unwrap();
    let response = app.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let value: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(status, StatusCode::CREATED, "{value}");
    value["secret"].as_str().unwrap().to_owned()
}

async fn create(app: &axum::Router, path: &str, token: &str, body: Value) -> Value {
    let request = Request::builder()
        .method("POST")
        .uri(path)
        .header("Authorization", format!("Bearer {token}"))
        .header("Content-Type", "application/json")
        .body(Body::from(body.to_string()))
        .unwrap();
    let response = app.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let value: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(status, StatusCode::CREATED, "{value}");
    value
}

fn tool(name: &str, arguments: Value) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": { "name": name, "arguments": arguments }
    })
}

fn structured(reply: &Value) -> &Value {
    let result = &reply["result"];
    assert_eq!(result["isError"], false, "{result}");
    &result["structuredContent"]
}

#[tokio::test]
async fn lifecycle_tools_report_their_result_on_postgres() {
    let database = support::TestDatabase::new().await;
    let store = Store::connect(&database.url).await.unwrap();
    let app = router(store.clone());

    let owner = account(&store, "owner").await;
    let value = store
        .create_workspace("MCP".into(), owner.profile.id)
        .await
        .unwrap();
    let workspace = value["id"].as_str().unwrap().to_owned();
    let write = token(
        &app,
        &owner,
        json!({"name":"Agent","access":"write","workspace_ids":[workspace]}),
    )
    .await;

    let team = create(
        &app,
        &format!("/api/v1/workspaces/{workspace}/teams"),
        &write,
        json!({"name":"Platform","key":"MCP"}),
    )
    .await;
    let done = team["stages"]
        .as_array()
        .unwrap()
        .iter()
        .find(|stage| stage["kind"] == "done")
        .unwrap()["name"]
        .as_str()
        .unwrap()
        .to_owned();

    let created = send(
        &app,
        "/mcp",
        &write,
        tool("create_issue", json!({"team":"MCP","title":"Delete me"})),
    )
    .await;
    let key = structured(&created)["issue"]["key"]
        .as_str()
        .unwrap()
        .to_owned();

    let deleted = send(
        &app,
        "/mcp",
        &write,
        tool("delete_issue", json!({"issue":key})),
    )
    .await;
    assert_eq!(structured(&deleted)["deleted"], json!(key), "{deleted}");

    let restored = send(
        &app,
        "/mcp",
        &write,
        tool("restore_issue", json!({"issue":key})),
    )
    .await;
    let restored = &structured(&restored)["issue"];
    assert_eq!(restored["key"], json!(key));
    assert_eq!(restored["deleted_at"], Value::Null);

    let created = send(
        &app,
        "/mcp",
        &write,
        tool(
            "create_issue",
            json!({"team":"MCP","title":"Archive me","stage":done}),
        ),
    )
    .await;
    let key = structured(&created)["issue"]["key"]
        .as_str()
        .unwrap()
        .to_owned();

    let archived = send(
        &app,
        "/mcp",
        &write,
        tool("archive_issue", json!({"issue":key})),
    )
    .await;
    assert!(structured(&archived)["issue"]["archived_at"].is_string());

    let unarchived = send(
        &app,
        "/mcp",
        &write,
        tool("unarchive_issue", json!({"issue":key})),
    )
    .await;
    assert_eq!(structured(&unarchived)["issue"]["archived_at"], Value::Null);

    database.cleanup().await;
}

#[tokio::test]
async fn update_issue_adds_and_removes_labels_keeping_the_rest() {
    let database = support::TestDatabase::new().await;
    let store = Store::connect(&database.url).await.unwrap();
    let app = router(store.clone());

    let owner = account(&store, "owner").await;
    let value = store
        .create_workspace("MCP".into(), owner.profile.id)
        .await
        .unwrap();
    let workspace = value["id"].as_str().unwrap().to_owned();
    let write = token(
        &app,
        &owner,
        json!({"name":"Agent","access":"write","workspace_ids":[workspace]}),
    )
    .await;
    create(
        &app,
        &format!("/api/v1/workspaces/{workspace}/teams"),
        &write,
        json!({"name":"Platform","key":"MCP"}),
    )
    .await;
    for name in ["bug", "ui", "ops"] {
        create(
            &app,
            &format!("/api/v1/workspaces/{workspace}/labels"),
            &write,
            json!({"name":name,"color":"#ef4444"}),
        )
        .await;
    }
    let created = send(
        &app,
        "/mcp",
        &write,
        tool(
            "create_issue",
            json!({"team":"MCP","title":"Labelled","labels":["bug","ui"]}),
        ),
    )
    .await;
    let key = structured(&created)["issue"]["key"]
        .as_str()
        .unwrap()
        .to_owned();

    let updated = send(
        &app,
        "/mcp",
        &write,
        tool(
            "update_issue",
            json!({"issue":key,"add_labels":["ops"],"remove_labels":["bug"]}),
        ),
    )
    .await;
    let mut labels: Vec<_> = structured(&updated)["issue"]["labels"]
        .as_array()
        .unwrap()
        .iter()
        .map(|l| l["name"].as_str().unwrap().to_owned())
        .collect();
    labels.sort();
    assert_eq!(labels, ["ops", "ui"]);

    let both = send(
        &app,
        "/mcp",
        &write,
        tool(
            "update_issue",
            json!({"issue":key,"labels":["bug"],"add_labels":["ops"]}),
        ),
    )
    .await;
    assert_eq!(both["result"]["isError"], true, "{both}");

    database.cleanup().await;
}
