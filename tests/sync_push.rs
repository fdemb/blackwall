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
use sqlx::Row;
use tower::ServiceExt;
use uuid::Uuid;

async fn call(
    app: &axum::Router,
    method: &str,
    path: &str,
    token: Option<&str>,
    input: Option<Value>,
) -> (StatusCode, Value) {
    let mut request = Request::builder().method(method).uri(path);
    if let Some(token) = token {
        request = request.header("Authorization", format!("Bearer {token}"));
    }
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
            password: "test-password-123".into(),
            display_name: name.into(),
        })
        .await
        .unwrap()
}

fn id(value: &Value) -> Uuid {
    Uuid::parse_str(value.as_str().unwrap()).unwrap()
}

fn mutation(id: i64, name: &str, args: Value) -> Value {
    json!({"id": id, "name": name, "args": args, "at": "2026-10-08T12:00:00Z"})
}

async fn command(
    app: &axum::Router,
    owner: &Session,
    workspace: Uuid,
    cmd: Value,
) -> (StatusCode, Value) {
    call(
        app,
        "POST",
        &format!("/api/workspaces/{workspace}/commands"),
        Some(&owner.token),
        Some(json!({"command": cmd})),
    )
    .await
}

async fn created(app: &axum::Router, owner: &Session, workspace: Uuid, cmd: Value) -> Uuid {
    let (status, result) = command(app, owner, workspace, cmd).await;
    assert_eq!(status, StatusCode::OK, "{result}");
    id(&result["result"]["id"])
}

async fn workspace(app: &axum::Router, owner: &Session, name: &str) -> Uuid {
    let (status, result) = call(
        app,
        "POST",
        "/api/workspaces",
        Some(&owner.token),
        Some(json!({"name": name})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{result}");
    id(&result["workspace"]["id"])
}

async fn setup(app: &axum::Router, owner: &Session) -> (Uuid, Uuid) {
    let ws = workspace(app, owner, "Sync push").await;
    let team = created(
        app,
        owner,
        ws,
        json!({"type": "create_team", "name": "Team", "members": [owner.profile.id]}),
    )
    .await;
    (ws, team)
}

async fn push(
    app: &axum::Router,
    token: &str,
    workspace: Uuid,
    client: Uuid,
    mutations: Vec<Value>,
) -> (StatusCode, Value) {
    call(
        app,
        "POST",
        &format!("/api/workspaces/{workspace}/sync/push"),
        Some(token),
        Some(json!({"client_id": client, "mutations": mutations})),
    )
    .await
}

async fn invite_member(
    app: &axum::Router,
    store: &Store,
    owner: &Session,
    workspace: Uuid,
    user: &Session,
) {
    let (status, result) = command(
        app,
        owner,
        workspace,
        json!({"type": "invite", "email": user.profile.email, "role": "member", "token_hash": "ignored"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{result}");

    let row = sqlx::query(
        "SELECT payload FROM jobs WHERE kind = 'email' AND payload->>'to' = $1 \
         ORDER BY created_at DESC LIMIT 1",
    )
    .bind(&user.profile.email)
    .fetch_one(&store.pool)
    .await
    .unwrap();
    let mail: Value = row.try_get("payload").unwrap();

    let (status, result) = call(
        app,
        "POST",
        &format!("/api/workspaces/{workspace}/invitations/accept"),
        Some(&user.token),
        Some(json!({"token": mail["token"]})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{result}");
}

async fn last_mutation_id(store: &Store, client: Uuid) -> Option<i64> {
    sqlx::query_scalar("SELECT last_mutation_id FROM sync_clients WHERE client_id = $1")
        .bind(client)
        .fetch_optional(&store.pool)
        .await
        .unwrap()
}

#[tokio::test]
async fn command_timestamps_outside_years_1_to_9999_are_rejected() {
    let database = support::TestDatabase::new().await;
    let store = Store::connect(&database.url).await.unwrap();
    let app = router(store.clone());
    let owner = account(&store, "owner").await;
    let (ws, team) = setup(&app, &owner).await;

    // 9999-12-31T23:30:00-01:00 is year 10000 in UTC; 0001-01-01T00:30:00+01:00
    // is year 0. PostgreSQL would store both, but the sync client could never
    // ingest them back.
    for deadline in ["9999-12-31T23:30:00-01:00", "0001-01-01T00:30:00+01:00"] {
        let (status, result) = command(
            &app,
            &owner,
            ws,
            json!({"type": "create_issue", "input": {"team_id": team, "title": "Out of range", "deadline": deadline}}),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{result}");
    }

    let (status, result) = command(
        &app,
        &owner,
        ws,
        json!({"type": "create_issue", "input": {"team_id": team, "title": "Latest valid", "deadline": "9999-12-31T23:59:59Z"}}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{result}");
    let issue = id(&result["result"]["id"]);

    let client = Uuid::new_v4();
    let (status, result) = push(
        &app,
        &owner.token,
        ws,
        client,
        vec![mutation(
            1,
            "update_issue",
            json!({"id": issue, "patch": {"deadline": "9999-12-31T23:30:00-01:00"}}),
        )],
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{result}");
    assert_eq!(result["results"][0]["status"], "rejected");
    assert_eq!(result["results"][0]["error"]["status"], 400);

    drop(app);
    store.pool.close().await;
    database.cleanup().await;
}

#[tokio::test]
async fn push_applies_batch_in_order() {
    let database = support::TestDatabase::new().await;
    let store = Store::connect(&database.url).await.unwrap();
    let app = router(store.clone());
    let owner = account(&store, "owner").await;
    let (ws, team) = setup(&app, &owner).await;
    let client = Uuid::new_v4();
    let issue = Uuid::new_v4();

    let (status, result) = push(
        &app,
        &owner.token,
        ws,
        client,
        vec![
            mutation(
                1,
                "create_label",
                json!({"name": "bug", "color": "#ef4444"}),
            ),
            mutation(
                2,
                "create_issue",
                json!({"input": {"id": issue, "team_id": team, "title": "Original"}}),
            ),
            mutation(
                3,
                "update_issue",
                json!({"id": issue, "patch": {"title": "Renamed"}}),
            ),
        ],
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{result}");
    assert_eq!(result["last_mutation_id"], 3);
    assert_eq!(
        result["results"],
        json!([
            {"id": 1, "status": "applied"},
            {"id": 2, "status": "applied"},
            {"id": 3, "status": "applied"},
        ])
    );

    assert_eq!(last_mutation_id(&store, client).await, Some(3));

    let (status, labels) = call(
        &app,
        "GET",
        &format!("/api/workspaces/{ws}/labels"),
        Some(&owner.token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{labels}");
    assert!(
        labels["items"]
            .as_array()
            .unwrap()
            .iter()
            .any(|l| l["name"] == "bug")
    );

    let (status, row) = call(
        &app,
        "GET",
        &format!("/api/workspaces/{ws}/issues/{issue}"),
        Some(&owner.token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{row}");
    assert_eq!(row["title"], "Renamed");

    drop(app);
    store.pool.close().await;
    database.cleanup().await;
}

#[tokio::test]
async fn push_resend_dedupes() {
    let database = support::TestDatabase::new().await;
    let store = Store::connect(&database.url).await.unwrap();
    let app = router(store.clone());
    let owner = account(&store, "owner").await;
    let (ws, team) = setup(&app, &owner).await;
    let client = Uuid::new_v4();
    let issue = created(
        &app,
        &owner,
        ws,
        json!({"type": "create_issue", "input": {"team_id": team, "title": "Target"}}),
    )
    .await;
    let comment = Uuid::new_v4();
    let batch = vec![
        mutation(
            1,
            "add_comment",
            json!({"id": comment, "issue_id": issue, "body": "Note"}),
        ),
        mutation(2, "follow", json!({"issue_id": issue, "following": true})),
        mutation(
            3,
            "update_issue",
            json!({"id": issue, "patch": {"title": "Kept"}}),
        ),
    ];

    let (status, first) = push(&app, &owner.token, ws, client, batch.clone()).await;
    assert_eq!(status, StatusCode::OK, "{first}");
    assert!(
        first["results"]
            .as_array()
            .unwrap()
            .iter()
            .all(|r| r["status"] == "applied")
    );

    let (status, second) = push(&app, &owner.token, ws, client, batch).await;
    assert_eq!(status, StatusCode::OK, "{second}");
    assert_eq!(
        second["results"],
        json!([
            {"id": 1, "status": "duplicate"},
            {"id": 2, "status": "duplicate"},
            {"id": 3, "status": "duplicate"},
        ])
    );
    assert_eq!(second["last_mutation_id"], 3);

    let (status, comments) = call(
        &app,
        "GET",
        &format!("/api/workspaces/{ws}/comments?issue_id={issue}"),
        Some(&owner.token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{comments}");
    let items = comments["items"].as_array().unwrap();
    assert_eq!(items.len(), 1);
    assert_eq!(items[0]["id"], comment.to_string());

    drop(app);
    store.pool.close().await;
    database.cleanup().await;
}

#[tokio::test]
async fn push_gaps_accepted_and_bad_batches_rejected() {
    let database = support::TestDatabase::new().await;
    let store = Store::connect(&database.url).await.unwrap();
    let app = router(store.clone());
    let owner = account(&store, "owner").await;
    let (ws, _) = setup(&app, &owner).await;
    let client = Uuid::new_v4();

    let (status, result) = push(
        &app,
        &owner.token,
        ws,
        client,
        vec![
            mutation(
                1,
                "create_label",
                json!({"name": "one", "color": "#000000"}),
            ),
            mutation(
                3,
                "create_label",
                json!({"name": "three", "color": "#000000"}),
            ),
            mutation(
                7,
                "create_label",
                json!({"name": "seven", "color": "#000000"}),
            ),
        ],
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{result}");
    assert_eq!(result["last_mutation_id"], 7);

    // Non-increasing ids fail the whole request with nothing processed.
    let (status, result) = push(
        &app,
        &owner.token,
        ws,
        client,
        vec![
            mutation(
                8,
                "create_label",
                json!({"name": "eight", "color": "#000000"}),
            ),
            mutation(
                8,
                "create_label",
                json!({"name": "eight-again", "color": "#000000"}),
            ),
        ],
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{result}");
    assert_eq!(last_mutation_id(&store, client).await, Some(7));

    let (status, labels) = call(
        &app,
        "GET",
        &format!("/api/workspaces/{ws}/labels"),
        Some(&owner.token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{labels}");
    let names: Vec<&str> = labels["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|l| l["name"].as_str().unwrap())
        .collect();
    assert!(!names.contains(&"eight"));

    // Ids below one, empty batches and oversized batches are request errors too.
    let (status, _) = push(
        &app,
        &owner.token,
        ws,
        client,
        vec![mutation(
            0,
            "create_label",
            json!({"name": "zero", "color": "#000000"}),
        )],
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(last_mutation_id(&store, client).await, Some(7));

    let (status, _) = push(&app, &owner.token, ws, client, vec![]).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    let oversized: Vec<Value> = (1..=101)
        .map(|n| {
            mutation(
                n,
                "create_label",
                json!({"name": format!("bulk-{n}"), "color": "#000000"}),
            )
        })
        .collect();
    let (status, _) = push(&app, &owner.token, ws, Uuid::new_v4(), oversized).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    drop(app);
    store.pool.close().await;
    database.cleanup().await;
}

#[tokio::test]
async fn push_rejected_mutation_advances_id_and_rolls_back() {
    let database = support::TestDatabase::new().await;
    let store = Store::connect(&database.url).await.unwrap();
    let app = router(store.clone());
    let owner = account(&store, "owner").await;
    let member = account(&store, "member").await;
    let (ws, team) = setup(&app, &owner).await;
    invite_member(&app, &store, &owner, ws, &member).await;
    let client = Uuid::new_v4();
    // The valid issue sorts first in request order, so its writes must roll
    // back when the second issue fails validation. Assignee and deadline
    // force notification and reminder-job writes, proving side effects roll
    // back too.
    let kept = Uuid::new_v4();
    let missing_team = Uuid::new_v4();

    let issues_before: i64 =
        sqlx::query_scalar("SELECT count(*) FROM issues WHERE workspace_id = $1")
            .bind(ws)
            .fetch_one(&store.pool)
            .await
            .unwrap();
    let activity_before: i64 =
        sqlx::query_scalar("SELECT count(*) FROM activity WHERE workspace_id = $1")
            .bind(ws)
            .fetch_one(&store.pool)
            .await
            .unwrap();
    let notifications_before: i64 =
        sqlx::query_scalar("SELECT count(*) FROM notifications WHERE workspace_id = $1")
            .bind(ws)
            .fetch_one(&store.pool)
            .await
            .unwrap();
    let jobs_before: i64 = sqlx::query_scalar("SELECT count(*) FROM jobs")
        .fetch_one(&store.pool)
        .await
        .unwrap();
    let changes_before: i64 =
        sqlx::query_scalar("SELECT count(*) FROM changes WHERE workspace_id = $1")
            .bind(ws)
            .fetch_one(&store.pool)
            .await
            .unwrap();

    let (status, result) = push(
        &app,
        &owner.token,
        ws,
        client,
        vec![mutation(
            1,
            "import_issues",
            json!({"issues": [
                {"id": kept, "team_id": team, "title": "Kept",
                 "assignee": member.profile.id, "deadline": "2026-11-08T12:00:00Z"},
                {"id": Uuid::new_v4(), "team_id": missing_team, "title": "Missing team"},
            ]}),
        )],
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{result}");
    assert_eq!(result["last_mutation_id"], 1);
    assert_eq!(result["results"][0]["id"], 1);
    assert_eq!(result["results"][0]["status"], "rejected");
    assert_eq!(result["results"][0]["error"]["status"], 404);
    assert_eq!(last_mutation_id(&store, client).await, Some(1));

    // Nothing from the first issue survived the rejection.
    let issue_left: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM issues WHERE workspace_id = $1 AND id = $2)",
    )
    .bind(ws)
    .bind(kept)
    .fetch_one(&store.pool)
    .await
    .unwrap();
    assert!(!issue_left);
    let (status, _) = call(
        &app,
        "GET",
        &format!("/api/workspaces/{ws}/issues/{kept}"),
        Some(&owner.token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    let activity_after: i64 =
        sqlx::query_scalar("SELECT count(*) FROM activity WHERE workspace_id = $1")
            .bind(ws)
            .fetch_one(&store.pool)
            .await
            .unwrap();
    assert_eq!(activity_after, activity_before);
    let notifications_after: i64 =
        sqlx::query_scalar("SELECT count(*) FROM notifications WHERE workspace_id = $1")
            .bind(ws)
            .fetch_one(&store.pool)
            .await
            .unwrap();
    assert_eq!(notifications_after, notifications_before);
    let jobs_after: i64 = sqlx::query_scalar("SELECT count(*) FROM jobs")
        .fetch_one(&store.pool)
        .await
        .unwrap();
    assert_eq!(jobs_after, jobs_before);
    let issues_after: i64 =
        sqlx::query_scalar("SELECT count(*) FROM issues WHERE workspace_id = $1")
            .bind(ws)
            .fetch_one(&store.pool)
            .await
            .unwrap();
    assert_eq!(issues_after, issues_before);
    // A rejection commits the high-water mark and its outcome. Neither
    // sync table has a change trigger, so no change row remains.
    let changes_after: i64 =
        sqlx::query_scalar("SELECT count(*) FROM changes WHERE workspace_id = $1")
            .bind(ws)
            .fetch_one(&store.pool)
            .await
            .unwrap();
    assert_eq!(changes_after, changes_before);

    drop(app);
    store.pool.close().await;
    database.cleanup().await;
}

#[tokio::test]
async fn push_retries_return_original_rejections() {
    let database = support::TestDatabase::new().await;
    let store = Store::connect(&database.url).await.unwrap();
    let app = router(store.clone());
    let owner = account(&store, "owner").await;
    let (ws, _) = setup(&app, &owner).await;
    let client = Uuid::new_v4();
    let label = Uuid::new_v4();
    let batch = vec![
        mutation(
            1,
            "create_label",
            json!({"id": label, "name": "Original", "color": "#000000"}),
        ),
        mutation(
            2,
            "create_label",
            json!({"id": label, "name": "Conflict", "color": "#ffffff"}),
        ),
        mutation(
            3,
            "update_issue",
            json!({"id": Uuid::new_v4(), "patch": {"title": "Missing"}}),
        ),
        mutation(4, "unknown", json!({})),
    ];
    let (status, first) = push(&app, &owner.token, ws, client, batch.clone()).await;
    assert_eq!(status, StatusCode::OK, "{first}");
    assert_eq!(first["results"][0]["status"], "applied");
    for (index, status) in [(1, 409), (2, 404), (3, 400)] {
        assert_eq!(first["results"][index]["status"], "rejected");
        assert_eq!(first["results"][index]["error"]["status"], status);
    }
    let (status, second) = push(&app, &owner.token, ws, client, batch).await;
    assert_eq!(status, StatusCode::OK, "{second}");
    assert_eq!(second["last_mutation_id"], 4);
    assert_eq!(
        second["results"][0],
        json!({"id": 1, "status": "duplicate"})
    );
    for index in 1..4 {
        assert_eq!(second["results"][index], first["results"][index]);
    }
    drop(app);
    store.pool.close().await;
    database.cleanup().await;
}

#[tokio::test]
async fn push_rejections_retain_only_the_latest_thousand_per_client() {
    let database = support::TestDatabase::new().await;
    let store = Store::connect(&database.url).await.unwrap();
    let app = router(store.clone());
    let owner = account(&store, "owner").await;
    let (ws, _) = setup(&app, &owner).await;
    let client = Uuid::new_v4();
    for start in (1..=1001).step_by(100) {
        let batch = (start..=(start + 99).min(1001))
            .map(|id| mutation(id * 2, "unknown", json!({})))
            .collect();
        let (status, result) = push(&app, &owner.token, ws, client, batch).await;
        assert_eq!(status, StatusCode::OK, "{result}");
        assert!(
            result["results"]
                .as_array()
                .unwrap()
                .iter()
                .all(|row| row["status"] == "rejected")
        );
    }
    let ids: Vec<i64> = sqlx::query_scalar(
        "SELECT mutation_id FROM sync_rejections WHERE client_id = $1 ORDER BY mutation_id",
    )
    .bind(client)
    .fetch_all(&store.pool)
    .await
    .unwrap();
    assert_eq!(ids, (2..=1001).map(|id| id * 2).collect::<Vec<_>>());
    let (status, result) = push(
        &app,
        &owner.token,
        ws,
        client,
        vec![
            mutation(2, "unknown", json!({})),
            mutation(4, "unknown", json!({})),
            mutation(2002, "unknown", json!({})),
            mutation(
                2003,
                "create_label",
                json!({"name": "Applied", "color": "#000000"}),
            ),
        ],
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{result}");
    assert_eq!(
        result["results"][0],
        json!({"id": 2, "status": "duplicate"})
    );
    assert_eq!(result["results"][1]["status"], "rejected");
    assert_eq!(result["results"][2]["status"], "rejected");
    assert_eq!(result["results"][3]["status"], "applied");
    let (status, other) = push(
        &app,
        &owner.token,
        ws,
        Uuid::new_v4(),
        vec![mutation(
            4,
            "create_label",
            json!({"name": "Other client", "color": "#000000"}),
        )],
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{other}");
    assert_eq!(other["results"][0]["status"], "applied");
    let count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM sync_rejections WHERE client_id = $1")
            .bind(client)
            .fetch_one(&store.pool)
            .await
            .unwrap();
    assert_eq!(count, 1000);
    drop(app);
    store.pool.close().await;
    database.cleanup().await;
}

#[tokio::test]
async fn push_viewer_personal_rules() {
    let database = support::TestDatabase::new().await;
    let store = Store::connect(&database.url).await.unwrap();
    let app = router(store.clone());
    let owner = account(&store, "owner").await;
    let viewer = account(&store, "watcher").await;
    let (ws, team) = setup(&app, &owner).await;
    invite_member(&app, &store, &owner, ws, &viewer).await;

    let (status, result) = command(
        &app,
        &owner,
        ws,
        json!({"type": "set_role", "user_id": viewer.profile.id, "role": "viewer"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{result}");

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
        json!({"type": "add_comment", "issue_id": issue, "body": "ping", "mentions": [viewer.profile.id]}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{result}");

    let (status, inbox) = call(
        &app,
        "GET",
        &format!("/api/workspaces/{ws}/notifications"),
        Some(&viewer.token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{inbox}");
    let notification = inbox["items"].as_array().unwrap().first().cloned().unwrap();
    assert!(notification["read_at"].is_null());

    let (status, result) = push(
        &app,
        &viewer.token,
        ws,
        Uuid::new_v4(),
        vec![
            mutation(
                1,
                "update_issue",
                json!({"id": issue, "patch": {"title": "Hijack"}}),
            ),
            mutation(
                2,
                "mark_notification_read",
                json!({"id": notification["id"]}),
            ),
        ],
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{result}");
    assert_eq!(result["last_mutation_id"], 2);
    assert_eq!(result["results"][0]["status"], "rejected");
    assert_eq!(result["results"][0]["error"]["status"], 403);
    assert_eq!(result["results"][1]["status"], "applied");

    let (status, row) = call(
        &app,
        "GET",
        &format!("/api/workspaces/{ws}/issues/{issue}"),
        Some(&owner.token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{row}");
    assert_eq!(row["title"], "Target");

    let (status, inbox) = call(
        &app,
        "GET",
        &format!("/api/workspaces/{ws}/notifications"),
        Some(&viewer.token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{inbox}");
    assert!(
        inbox["items"]
            .as_array()
            .unwrap()
            .iter()
            .all(|n| !n["read_at"].is_null())
    );

    drop(app);
    store.pool.close().await;
    database.cleanup().await;
}

#[tokio::test]
async fn push_malformed_commands_rejected_per_mutation() {
    let database = support::TestDatabase::new().await;
    let store = Store::connect(&database.url).await.unwrap();
    let app = router(store.clone());
    let owner = account(&store, "owner").await;
    let (ws, team) = setup(&app, &owner).await;
    let client = Uuid::new_v4();
    let issue = created(
        &app,
        &owner,
        ws,
        json!({"type": "create_issue", "input": {"team_id": team, "title": "Target"}}),
    )
    .await;

    let (status, result) = push(
        &app,
        &owner.token,
        ws,
        client,
        vec![
            mutation(1, "frobnicator", json!({})),
            mutation(2, "update_issue", json!({"id": issue, "patch": {"priority": "bogus"}})),
            mutation(
                3,
                "add_attachment",
                json!({"issue_id": issue, "attachment": {"id": Uuid::new_v4(), "name": "f.txt", "content_type": "text/plain", "size": 1}}),
            ),
        ],
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{result}");
    assert_eq!(result["last_mutation_id"], 3);
    for entry in result["results"].as_array().unwrap() {
        assert_eq!(entry["status"], "rejected", "{entry}");
        assert_eq!(entry["error"]["status"], 400, "{entry}");
    }
    assert_eq!(
        result["results"][2]["error"]["message"],
        "use the attachment upload endpoint"
    );

    drop(app);
    store.pool.close().await;
    database.cleanup().await;
}

#[tokio::test]
async fn push_membership_and_client_ownership() {
    let database = support::TestDatabase::new().await;
    let store = Store::connect(&database.url).await.unwrap();
    let app = router(store.clone());
    let owner = account(&store, "owner").await;
    let member = account(&store, "member").await;
    let outsider = account(&store, "outsider").await;
    let (ws, _) = setup(&app, &owner).await;
    invite_member(&app, &store, &owner, ws, &member).await;
    let client = Uuid::new_v4();

    let (status, _) = push(
        &app,
        &outsider.token,
        ws,
        Uuid::new_v4(),
        vec![mutation(
            1,
            "create_label",
            json!({"name": "x", "color": "#000000"}),
        )],
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    let (status, result) = push(
        &app,
        &owner.token,
        ws,
        client,
        vec![mutation(
            1,
            "create_label",
            json!({"name": "mine", "color": "#000000"}),
        )],
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{result}");

    // The same client id from another user or workspace is a request error.
    let (status, result) = push(
        &app,
        &member.token,
        ws,
        client,
        vec![mutation(
            1,
            "create_label",
            json!({"name": "taken", "color": "#000000"}),
        )],
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{result}");

    let other = workspace(&app, &owner, "Other").await;
    let (status, result) = push(
        &app,
        &owner.token,
        other,
        client,
        vec![mutation(
            2,
            "create_label",
            json!({"name": "taken", "color": "#000000"}),
        )],
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{result}");

    drop(app);
    store.pool.close().await;
    database.cleanup().await;
}

#[tokio::test]
async fn push_preflight_failure_returns_503_with_push_shape() {
    let database = support::TestDatabase::new().await;
    let store = Store::connect(&database.url).await.unwrap();
    let app = router(store.clone());
    let owner = account(&store, "owner").await;
    let (ws, _) = setup(&app, &owner).await;
    let client = Uuid::new_v4();

    // Break every sync_clients read without touching production code: the
    // preflight ownership check fails before the first mutation runs.
    sqlx::query("ALTER TABLE sync_clients RENAME TO sync_clients_down")
        .execute(&store.pool)
        .await
        .unwrap();

    let (status, result) = push(
        &app,
        &owner.token,
        ws,
        client,
        vec![mutation(
            1,
            "create_label",
            json!({"name": "x", "color": "#000000"}),
        )],
    )
    .await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{result}");
    assert_eq!(result, json!({"last_mutation_id": 0, "results": []}));

    sqlx::query("ALTER TABLE sync_clients_down RENAME TO sync_clients")
        .execute(&store.pool)
        .await
        .unwrap();

    let (status, result) = push(
        &app,
        &owner.token,
        ws,
        client,
        vec![mutation(
            1,
            "create_label",
            json!({"name": "x", "color": "#000000"}),
        )],
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{result}");
    assert_eq!(result["last_mutation_id"], 1);

    drop(app);
    store.pool.close().await;
    database.cleanup().await;
}

#[tokio::test]
async fn push_session_id_from_me_and_login() {
    let database = support::TestDatabase::new().await;
    let store = Store::connect(&database.url).await.unwrap();
    let app = router(store.clone());
    let session = account(&store, "owner").await;
    assert!(!session.session_id.is_nil());

    let (status, me) = call(&app, "GET", "/api/me", Some(&session.token), None).await;
    assert_eq!(status, StatusCode::OK, "{me}");
    assert_eq!(me["session_id"], session.session_id.to_string());
    assert_eq!(me["email"], session.profile.email);

    let (status, again) = call(&app, "GET", "/api/me", Some(&session.token), None).await;
    assert_eq!(status, StatusCode::OK, "{again}");
    assert_eq!(again["session_id"], session.session_id.to_string());

    let (status, login) = call(
        &app,
        "POST",
        "/api/auth/login",
        None,
        Some(json!({"email": session.profile.email, "password": "test-password-123"})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{login}");
    assert!(!login["session_id"].is_null());
    assert_ne!(login["session_id"], session.session_id.to_string());

    // A session id is not a credential.
    let (status, _) = call(
        &app,
        "GET",
        "/api/me",
        Some(&session.session_id.to_string()),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    drop(app);
    store.pool.close().await;
    database.cleanup().await;
}

#[tokio::test]
async fn push_pruning_removes_idle_clients() {
    let database = support::TestDatabase::new().await;
    let store = Store::connect(&database.url).await.unwrap();
    let app = router(store.clone());
    let owner = account(&store, "owner").await;
    let (ws, _) = setup(&app, &owner).await;
    let fresh = Uuid::new_v4();

    let (status, result) = push(
        &app,
        &owner.token,
        ws,
        fresh,
        vec![mutation(
            1,
            "create_label",
            json!({"name": "fresh", "color": "#000000"}),
        )],
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{result}");

    let idle = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO sync_clients (client_id, workspace_id, user_id, last_mutation_id, updated_at) \
         VALUES ($1, $2, $3, 9, now() - make_interval(days => 31))",
    )
    .bind(idle)
    .bind(ws)
    .bind(owner.profile.id)
    .execute(&store.pool)
    .await
    .unwrap();

    sqlx::query("INSERT INTO sync_rejections (client_id, mutation_id, status, message) VALUES ($1, 9, 400, 'idle rejection'), ($2, 1, 409, 'fresh rejection')")
        .bind(idle).bind(fresh).execute(&store.pool).await.unwrap();
    assert_eq!(store.prune_sync_clients().await.unwrap(), 1);
    let retained: Vec<Uuid> =
        sqlx::query_scalar("SELECT client_id FROM sync_rejections ORDER BY client_id")
            .fetch_all(&store.pool)
            .await
            .unwrap();
    assert_eq!(retained, vec![fresh]);
    assert_eq!(last_mutation_id(&store, idle).await, None);
    assert_eq!(last_mutation_id(&store, fresh).await, Some(1));
    assert_eq!(store.prune_sync_clients().await.unwrap(), 0);

    drop(app);
    store.pool.close().await;
    database.cleanup().await;
}
