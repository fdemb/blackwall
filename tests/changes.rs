use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use blackwall::{auth::Register, http::router_with_web, store::Store};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use tower::ServiceExt;
use uuid::Uuid;

mod support;

async fn call(
    app: &axum::Router,
    method: &str,
    path: &str,
    token: &str,
    input: Option<Value>,
) -> (StatusCode, Value) {
    let mut request = Request::builder()
        .method(method)
        .uri(path)
        .header("Authorization", format!("Bearer {token}"));
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

async fn command(
    app: &axum::Router,
    token: &str,
    ws: &str,
    versions: Value,
    key: Option<&str>,
    command: Value,
) -> Value {
    let (status, value) = call(
        app,
        "POST",
        &format!("/api/workspaces/{ws}/commands"),
        token,
        Some(json!({"expected_versions":versions,"idempotency_key":key,"command":command})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{value}");
    value
}

async fn feed(app: &axum::Router, token: &str, ws: &str, since: Option<&str>) -> Value {
    let query = since.map(|s| format!("?since={s}")).unwrap_or_default();
    let (status, value) = call(
        app,
        "GET",
        &format!("/api/workspaces/{ws}/changes{query}"),
        token,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{value}");
    value
}

/// The record for an entity, or None when the change set does not mention it.
fn record<'a>(changes: &'a Value, entity: &str, id: &str) -> Option<&'a Value> {
    changes
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["entity"] == entity && c["id"] == id)
        .map(|c| &c["record"])
}

#[tokio::test]
async fn commands_return_changed_records_and_the_feed_replays_them() {
    let database = support::TestDatabase::new().await;
    let store = Store::connect(&database.url).await.unwrap();
    let app = router_with_web(store.clone(), std::env::temp_dir());

    let mut sessions = Vec::new();
    for name in ["owner", "colleague"] {
        sessions.push(
            store
                .register(Register {
                    email: format!("{name}-{}@example.com", Uuid::new_v4()),
                    password: "test-password-123".into(),
                    display_name: name.into(),
                })
                .await
                .unwrap(),
        );
    }
    let (owner, colleague) = (&sessions[0], &sessions[1]);

    let (_, created) = call(
        &app,
        "POST",
        "/api/workspaces",
        &owner.token,
        Some(json!({"name":"Changes"})),
    )
    .await;
    let ws = created["workspace"]["id"].as_str().unwrap().to_owned();
    sqlx::query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'member')")
        .bind(Uuid::parse_str(&ws).unwrap())
        .bind(colleague.profile.id)
        .execute(&store.pool)
        .await
        .unwrap();

    // Take cursors before any writes, as a client would before its first load.
    let start = feed(&app, &colleague.token, &ws, None).await;
    assert_eq!(start["reset"], false);
    assert_eq!(start["changes"], json!([]));
    let colleague_cursor = start["cursor"].as_str().unwrap().to_owned();
    let owner_cursor = feed(&app, &owner.token, &ws, None).await["cursor"]
        .as_str()
        .unwrap()
        .to_owned();

    let result = command(
        &app,
        &owner.token,
        &ws,
        json!({}),
        None,
        json!({"type":"create_team","name":"Ops","members":[owner.profile.id]}),
    )
    .await;
    let team = result["result"]["id"].as_str().unwrap().to_owned();
    let team_record = record(&result["changes"], "teams", &team).expect("team in changes");
    assert_eq!(team_record["name"], "Ops");
    let stages = team_record["stages"].as_array().unwrap();
    let done = stages.iter().find(|s| s["kind"] == "done").unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    // Team membership shows on the member profile too.
    let me = owner.profile.id.to_string();
    assert_eq!(
        record(&result["changes"], "members", &me).unwrap()["team_ids"],
        json!([team])
    );
    assert!(
        result["changes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|c| c["entity"] == "activity")
    );

    let result = command(
        &app,
        &owner.token,
        &ws,
        json!({}),
        None,
        json!({"type":"create_issue","input":{"team_id":team,"title":"Parent"}}),
    )
    .await;
    let parent = result["result"]["id"].as_str().unwrap().to_owned();
    assert_eq!(
        record(&result["changes"], "issues", &parent).unwrap()["title"],
        "Parent"
    );

    // Creating a subtask returns the parent with its new count.
    let result = command(
        &app,
        &owner.token,
        &ws,
        json!({}),
        None,
        json!({"type":"create_issue","input":{"team_id":team,"title":"Child","parent_id":parent}}),
    )
    .await;
    let child = result["result"]["id"].as_str().unwrap().to_owned();
    let parent_record = record(&result["changes"], "issues", &parent).expect("parent in changes");
    assert_eq!(parent_record["subtask_total"], 1);
    assert_eq!(parent_record["subtask_completed"], 0);
    let child_version = record(&result["changes"], "issues", &child).unwrap()["version"].clone();

    // So does finishing it, with an idempotency key to check replays later.
    let move_child = json!({"type":"move_issue","id":child,"stage_id":done,"before_id":null});
    let finish_versions = json!({ &child: child_version });
    let result = command(
        &app,
        &owner.token,
        &ws,
        finish_versions.clone(),
        Some("finish-child"),
        move_child.clone(),
    )
    .await;
    assert_eq!(
        record(&result["changes"], "issues", &parent).unwrap()["subtask_completed"],
        1
    );
    assert_eq!(
        record(&result["changes"], "issues", &child).unwrap()["stage_id"],
        done
    );

    // A private view only concerns its owner.
    let result = command(
        &app,
        &owner.token,
        &ws,
        json!({}),
        None,
        json!({"type":"save_view","name":"Mine","shared":false,"filter":{}}),
    )
    .await;
    let view = result["result"]["id"].as_str().unwrap().to_owned();
    assert_eq!(
        record(&result["changes"], "views", &view).unwrap()["name"],
        "Mine"
    );

    // An issue that depends on the open parent counts it as a blocker. Assigning it notifies the
    // colleague, which is not the owner's record to see.
    let result = command(&app, &owner.token, &ws, json!({}), None, json!({"type":"create_issue","input":{"team_id":team,"title":"Blocked","dependencies":[parent],"assignee":colleague.profile.id}})).await;
    let blocked = result["result"]["id"].as_str().unwrap().to_owned();
    assert_eq!(
        record(&result["changes"], "issues", &blocked).unwrap()["blocked_count"],
        1
    );
    assert!(
        !result["changes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|c| c["entity"] == "notifications")
    );

    // The colleague's feed has everything shared, with current records, but not the private view.
    let changes = feed(&app, &colleague.token, &ws, Some(&colleague_cursor)).await;
    assert_eq!(changes["reset"], false);
    let list = &changes["changes"];
    assert_eq!(record(list, "teams", &team).unwrap()["name"], "Ops");
    assert_eq!(
        record(list, "issues", &parent).unwrap()["subtask_completed"],
        1
    );
    assert_eq!(record(list, "issues", &child).unwrap()["stage_id"], done);
    assert!(record(list, "views", &view).is_none());
    assert_eq!(
        record(list, "members", &me).unwrap()["team_ids"],
        json!([team])
    );

    let notification = list
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["entity"] == "notifications")
        .expect("assignment notification");
    assert_eq!(
        notification["record"]["user_id"],
        json!(colleague.profile.id)
    );
    let parent_version = record(list, "issues", &parent).unwrap()["version"].clone();

    // Polling again from the new cursor returns nothing new.
    let cursor = changes["cursor"].as_str().unwrap().to_owned();
    assert_eq!(
        feed(&app, &colleague.token, &ws, Some(&cursor)).await["changes"],
        json!([])
    );

    // Finishing the parent unblocks the dependent issue.
    let result = command(
        &app,
        &owner.token,
        &ws,
        json!({ &parent: parent_version }),
        None,
        json!({"type":"move_issue","id":parent,"stage_id":done,"before_id":null}),
    )
    .await;
    assert_eq!(
        record(&result["changes"], "issues", &blocked).unwrap()["blocked_count"],
        0
    );
    let cursor = feed(&app, &colleague.token, &ws, Some(&cursor)).await["cursor"]
        .as_str()
        .unwrap()
        .to_owned();

    // Deleting returns a null record, both to the writer and through the owner's feed.
    let version = record(
        &feed(&app, &owner.token, &ws, Some(&owner_cursor)).await["changes"],
        "views",
        &view,
    )
    .unwrap()["version"]
        .clone();
    let result = command(
        &app,
        &owner.token,
        &ws,
        json!({ &view: version }),
        None,
        json!({"type":"delete_view","id":view}),
    )
    .await;
    assert_eq!(
        record(&result["changes"], "views", &view),
        Some(&Value::Null)
    );
    assert_eq!(
        record(
            &feed(&app, &owner.token, &ws, Some(&owner_cursor)).await["changes"],
            "views",
            &view
        ),
        Some(&Value::Null)
    );
    assert!(
        record(
            &feed(&app, &colleague.token, &ws, Some(&cursor)).await["changes"],
            "views",
            &view
        )
        .is_none()
    );

    // A replayed command reports the records as they are now.
    let replay = command(
        &app,
        &owner.token,
        &ws,
        finish_versions,
        Some("finish-child"),
        move_child,
    )
    .await;
    assert_eq!(
        record(&replay["changes"], "issues", &child).unwrap()["stage_id"],
        done
    );
    assert_eq!(
        record(&replay["changes"], "issues", &parent).unwrap()["subtask_completed"],
        1
    );

    // Cursors from the future and garbage are rejected.
    for bad in ["nope", "999999999999"] {
        let (status, _) = call(
            &app,
            "GET",
            &format!("/api/workspaces/{ws}/changes?since={bad}"),
            &colleague.token,
            None,
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
    }
    // Outsiders cannot read the feed.
    let outsider = store
        .register(Register {
            email: format!("out-{}@example.com", Uuid::new_v4()),
            password: "test-password-123".into(),
            display_name: "out".into(),
        })
        .await
        .unwrap();
    let (status, _) = call(
        &app,
        "GET",
        &format!("/api/workspaces/{ws}/changes"),
        &outsider.token,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    // Pruning old rows moves the horizon; cursors older than it must reload.
    sqlx::query("UPDATE changes SET created_at=now()-interval '40 days'")
        .execute(&store.pool)
        .await
        .unwrap();
    assert!(store.prune_changes(30).await.unwrap() > 0);
    let changes = feed(&app, &colleague.token, &ws, Some(&colleague_cursor)).await;
    assert_eq!(changes["reset"], true);
    assert_eq!(changes["changes"], json!([]));
    let fresh = changes["cursor"].as_str().unwrap().to_owned();
    assert_eq!(
        feed(&app, &colleague.token, &ws, Some(&fresh)).await["reset"],
        false
    );

    drop(store);
    database.cleanup().await;
}
