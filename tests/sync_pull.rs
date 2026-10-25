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
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
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

async fn workspace(app: &axum::Router, owner: &Session, name: &str) -> Uuid {
    let (status, result) = call(
        app,
        "POST",
        "/internal-api/workspaces",
        Some(&owner.token),
        Some(json!({"name": name, "slug": Uuid::new_v4().to_string()})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{result}");
    id(&result["workspace"]["id"])
}

async fn setup(app: &axum::Router, owner: &Session) -> (Uuid, Uuid) {
    let ws = workspace(app, owner, "Sync pull").await;
    let team = created(
        app,
        owner,
        ws,
        json!({"type": "create_team", "name": "Team", "key": "TEA", "members": [owner.profile.id]}),
    )
    .await;
    (ws, team)
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
        &format!("/internal-api/workspaces/{workspace}/commands"),
        Some(&owner.token),
        Some(json!({"command": cmd})),
    )
    .await
}

async fn created(app: &axum::Router, owner: &Session, workspace: Uuid, cmd: Value) -> Uuid {
    let (status, result) = command(app, owner, workspace, cmd).await;
    assert_eq!(status, StatusCode::OK, "{result}");
    result["result"]["id"]
        .as_str()
        .map(|s| Uuid::parse_str(s).unwrap())
        .unwrap()
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
        &format!("/internal-api/workspaces/{workspace}/sync/push"),
        Some(token),
        Some(json!({"client_id": client, "mutations": mutations})),
    )
    .await
}

async fn pull(
    app: &axum::Router,
    token: &str,
    workspace: Uuid,
    client: Uuid,
    cursor: Option<&str>,
) -> (StatusCode, Value) {
    let query = match cursor {
        Some(cursor) => format!("?client_id={client}&cursor={cursor}"),
        None => format!("?client_id={client}"),
    };
    call(
        app,
        "GET",
        &format!("/internal-api/workspaces/{workspace}/sync/pull{query}"),
        Some(token),
        None,
    )
    .await
}

async fn pull_ok(
    app: &axum::Router,
    token: &str,
    workspace: Uuid,
    client: Uuid,
    cursor: Option<&str>,
) -> Value {
    let (status, result) = pull(app, token, workspace, client, cursor).await;
    assert_eq!(status, StatusCode::OK, "{result}");
    result
}

fn cursor_of(page: &Value) -> String {
    page["cursor"].as_str().unwrap().to_owned()
}

fn cursor_xmax(cursor: &str) -> i64 {
    cursor.split(':').nth(1).unwrap().parse().unwrap()
}

async fn invite_member(
    app: &axum::Router,
    store: &Store,
    owner: &Session,
    workspace: Uuid,
    user: &Session,
) {
    use sqlx::Row;
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
        &format!("/internal-api/workspaces/{workspace}/invitations/accept"),
        Some(&user.token),
        Some(json!({"token": mail["token"]})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{result}");
}

/// The record for an entity, or None when the page does not mention it.
fn record<'a>(changes: &'a Value, entity: &str, id: &str) -> Option<&'a Value> {
    changes
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["entity"] == entity && c["id"] == id)
        .map(|c| &c["record"])
}

#[tokio::test]
async fn pull_returns_rendered_records_and_quiet_poll_is_empty() {
    let database = support::TestDatabase::new().await;
    let store = Store::connect(&database.url).await.unwrap();
    let app = router(store.clone());
    let owner = account(&store, "owner").await;
    let (ws, team) = setup(&app, &owner).await;
    let client = Uuid::new_v4();

    let start = pull_ok(&app, &owner.token, ws, client, None).await;
    assert_eq!(start["more"], false);
    assert_eq!(start["reset"], false);
    assert_eq!(start["changes"], json!([]));
    assert_eq!(start["last_mutation_id"], Value::Null);
    let before = cursor_of(&start);

    let issue = created(
        &app,
        &owner,
        ws,
        json!({"type": "create_issue", "input": {"team_id": team, "title": "Pulled"}}),
    )
    .await;

    let page = pull_ok(&app, &owner.token, ws, client, Some(&before)).await;
    assert_eq!(page["more"], false);
    assert_eq!(page["reset"], false);
    assert_eq!(page["last_mutation_id"], 0);
    let pulled = record(&page["changes"], "issues", &issue.to_string()).expect("issue in pull");
    assert_eq!(pulled["title"], "Pulled");

    let (status, detail) = call(
        &app,
        "GET",
        &format!("/internal-api/workspaces/{ws}/issues/{issue}"),
        Some(&owner.token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{detail}");
    assert_eq!(pulled["title"], detail["title"]);
    assert_eq!(pulled["team_id"], detail["team_id"]);

    let cursor = cursor_of(&page);
    let quiet = pull_ok(&app, &owner.token, ws, client, Some(&cursor)).await;
    assert_eq!(quiet["changes"], json!([]));
    assert_eq!(quiet["more"], false);
    assert_eq!(quiet["reset"], false);

    drop(app);
    store.pool.close().await;
    database.cleanup().await;
}

#[tokio::test]
async fn pull_pinned_xmin_elsewhere_does_not_hold_cursor_back() {
    let database = support::TestDatabase::new().await;
    let store = Store::connect(&database.url).await.unwrap();
    let app = router(store.clone());
    let owner = account(&store, "owner").await;
    let (ws, team) = setup(&app, &owner).await;
    let client = Uuid::new_v4();

    // A transaction on a separate connection takes a txid and stays open,
    // pinning the cluster-wide xmin for the whole test.
    let mut pin = store.pool.acquire().await.unwrap();
    sqlx::query("BEGIN").execute(&mut *pin).await.unwrap();
    let _pinned: i64 = sqlx::query_scalar("SELECT pg_current_xact_id()::text::bigint")
        .fetch_one(&mut *pin)
        .await
        .unwrap();

    let start = pull_ok(&app, &owner.token, ws, client, None).await;
    assert_eq!(start["reset"], false);
    let first = cursor_of(&start);

    let issue = created(
        &app,
        &owner,
        ws,
        json!({"type": "create_issue", "input": {"team_id": team, "title": "First"}}),
    )
    .await;
    // The pinned transaction edits the same workspace; its rows stay
    // invisible until it commits.
    sqlx::query("UPDATE issues SET title = 'Pinned edit' WHERE id = $1")
        .bind(issue)
        .execute(&mut *pin)
        .await
        .unwrap();

    let page = pull_ok(&app, &owner.token, ws, client, Some(&first)).await;
    assert_eq!(page["reset"], false);
    assert_eq!(page["more"], false);
    assert_ne!(cursor_of(&page), first);
    assert_eq!(
        record(&page["changes"], "issues", &issue.to_string()).unwrap()["title"],
        "First"
    );
    let second = cursor_of(&page);

    let other = created(
        &app,
        &owner,
        ws,
        json!({"type": "create_issue", "input": {"team_id": team, "title": "Second"}}),
    )
    .await;
    let page = pull_ok(&app, &owner.token, ws, client, Some(&second)).await;
    assert_eq!(page["reset"], false);
    assert_eq!(page["more"], false);
    assert_ne!(cursor_of(&page), second);
    // Only the new changes: no repeats, no resets, while the pin is held.
    assert!(record(&page["changes"], "issues", &issue.to_string()).is_none());
    assert!(record(&page["changes"], "issues", &other.to_string()).is_some());
    let third = cursor_of(&page);

    // Two 600-issue imports still page while the pin is held.
    let first_ids: Vec<Uuid> = (0..600).map(|_| Uuid::new_v4()).collect();
    import_issues(
        &app,
        &owner,
        ws,
        first_ids
            .iter()
            .enumerate()
            .map(|(n, id)| json!({"id": id, "team_id": team, "title": format!("Bulk {n}")}))
            .collect(),
    )
    .await;
    let second_ids: Vec<Uuid> = (0..600).map(|_| Uuid::new_v4()).collect();
    import_issues(
        &app,
        &owner,
        ws,
        second_ids
            .iter()
            .enumerate()
            .map(|(n, id)| json!({"id": id, "team_id": team, "title": format!("Bulk {}", 600 + n)}))
            .collect(),
    )
    .await;

    let page_one = pull_ok(&app, &owner.token, ws, client, Some(&third)).await;
    assert_eq!(page_one["reset"], false);
    assert_eq!(page_one["more"], true);
    let issues: Vec<String> = page_one["changes"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|c| c["entity"] == "issues")
        .map(|c| c["id"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(issues.len(), 600);
    for id in &first_ids {
        assert!(issues.contains(&id.to_string()), "missing {id}");
    }

    let page_two = pull_ok(&app, &owner.token, ws, client, Some(&cursor_of(&page_one))).await;
    assert_eq!(page_two["reset"], false);
    assert_eq!(page_two["more"], false);
    let issues: Vec<String> = page_two["changes"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|c| c["entity"] == "issues")
        .map(|c| c["id"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(issues.len(), 600);
    for id in &second_ids {
        assert!(issues.contains(&id.to_string()), "missing {id}");
    }
    let fourth = cursor_of(&page_two);

    // Committing the pinned transaction makes its edit arrive next pull: its
    // txid sat in every cursor's xip list while open.
    sqlx::query("COMMIT").execute(&mut *pin).await.unwrap();
    drop(pin);
    let page = pull_ok(&app, &owner.token, ws, client, Some(&fourth)).await;
    assert_eq!(page["reset"], false);
    assert_eq!(
        record(&page["changes"], "issues", &issue.to_string()).unwrap()["title"],
        "Pinned edit"
    );

    drop(app);
    store.pool.close().await;
    database.cleanup().await;
}

#[tokio::test]
async fn pull_deleted_and_unvisible_return_null() {
    let database = support::TestDatabase::new().await;
    let store = Store::connect(&database.url).await.unwrap();
    let app = router(store.clone());
    let owner = account(&store, "owner").await;
    let colleague = account(&store, "colleague").await;
    let (ws, _) = setup(&app, &owner).await;
    invite_member(&app, &store, &owner, ws, &colleague).await;
    let owner_client = Uuid::new_v4();
    let colleague_client = Uuid::new_v4();

    // A shared view both members see.
    let view = created(
        &app,
        &owner,
        ws,
        json!({"type": "save_view", "name": "Shared", "shared": true, "filter": {}}),
    )
    .await;
    let after_create =
        cursor_of(&pull_ok(&app, &colleague.token, ws, colleague_client, None).await);

    // Deleting it returns null to a pull from before the delete.
    let before_delete = cursor_of(&pull_ok(&app, &owner.token, ws, owner_client, None).await);
    // Take the cursor before the delete from a fresh client so the window
    // contains both the create and the delete; rendering shows the end state.
    let (status, result) =
        command(&app, &owner, ws, json!({"type": "delete_view", "id": view})).await;
    assert_eq!(status, StatusCode::OK, "{result}");
    assert_eq!(
        result["changes"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["entity"] == "views" && c["id"] == view.to_string())
            .map(|c| &c["record"]),
        Some(&Value::Null)
    );
    let page = pull_ok(&app, &owner.token, ws, owner_client, Some(&before_delete)).await;
    assert_eq!(
        record(&page["changes"], "views", &view.to_string()),
        Some(&Value::Null)
    );

    // A shared view made private is null to members who lose access.
    let view2 = created(
        &app,
        &owner,
        ws,
        json!({"type": "save_view", "name": "Was shared", "shared": true, "filter": {}}),
    )
    .await;
    let cursor = cursor_of(&pull_ok(&app, &colleague.token, ws, colleague_client, None).await);
    // Sanity: the colleague sees the shared view from before.
    let visible = pull_ok(
        &app,
        &colleague.token,
        ws,
        colleague_client,
        Some(&after_create),
    )
    .await;
    assert!(record(&visible["changes"], "views", &view2.to_string()).is_some());

    let (status, result) = command(
        &app,
        &owner,
        ws,
        json!({"type": "update_view", "id": view2, "name": "Was shared", "shared": false, "filter": {}}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{result}");

    let page = pull_ok(&app, &colleague.token, ws, colleague_client, Some(&cursor)).await;
    assert_eq!(page["reset"], false);
    assert_eq!(
        record(&page["changes"], "views", &view2.to_string()),
        Some(&Value::Null)
    );
    // The owner still sees the private record.
    let owner_page = pull_ok(&app, &owner.token, ws, owner_client, Some(&cursor)).await;
    let kept = record(&owner_page["changes"], "views", &view2.to_string()).unwrap();
    assert_eq!(kept["name"], "Was shared");

    drop(app);
    store.pool.close().await;
    database.cleanup().await;
}

#[tokio::test]
async fn pull_visibility_scopes_private_records() {
    let database = support::TestDatabase::new().await;
    let store = Store::connect(&database.url).await.unwrap();
    let app = router(store.clone());
    let owner = account(&store, "owner").await;
    let colleague = account(&store, "colleague").await;
    let (ws, team) = setup(&app, &owner).await;
    invite_member(&app, &store, &owner, ws, &colleague).await;
    let owner_client = Uuid::new_v4();
    let colleague_client = Uuid::new_v4();

    let owner_before = cursor_of(&pull_ok(&app, &owner.token, ws, owner_client, None).await);
    let colleague_before =
        cursor_of(&pull_ok(&app, &colleague.token, ws, colleague_client, None).await);

    // Private view reaches only its owner.
    let private = created(
        &app,
        &owner,
        ws,
        json!({"type": "save_view", "name": "Mine", "shared": false, "filter": {}}),
    )
    .await;
    let owner_page = pull_ok(&app, &owner.token, ws, owner_client, Some(&owner_before)).await;
    assert_eq!(
        record(&owner_page["changes"], "views", &private.to_string()).unwrap()["name"],
        "Mine"
    );
    let colleague_page = pull_ok(
        &app,
        &colleague.token,
        ws,
        colleague_client,
        Some(&colleague_before),
    )
    .await;
    assert!(record(&colleague_page["changes"], "views", &private.to_string()).is_none());

    // Assignment notifies only the recipient.
    created(
        &app,
        &owner,
        ws,
        json!({"type": "create_issue", "input": {"team_id": team, "title": "Assigned", "assignee": colleague.profile.id}}),
    )
    .await;
    let colleague_page = pull_ok(
        &app,
        &colleague.token,
        ws,
        colleague_client,
        Some(&colleague_before),
    )
    .await;
    let notification = colleague_page["changes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["entity"] == "notifications")
        .expect("assignment notification");
    assert_eq!(
        notification["record"]["user_id"],
        json!(colleague.profile.id)
    );
    let owner_page = pull_ok(&app, &owner.token, ws, owner_client, Some(&owner_before)).await;
    assert!(
        owner_page["changes"]
            .as_array()
            .unwrap()
            .iter()
            .all(|c| c["entity"] != "notifications")
    );

    // Invitations and integrations render only for admins.
    let (status, result) = command(
        &app,
        &owner,
        ws,
        json!({"type": "invite", "email": "invited@example.com", "role": "member", "token_hash": "ignored"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{result}");
    let (status, result) = command(
        &app,
        &owner,
        ws,
        json!({"type": "create_integration", "name": "Hook", "webhook_url": "https://example.com/hook", "secret": "s3cret"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{result}");

    // Re-stating the colleague's role marks their membership row but writes
    // no role marker, so nobody resets.
    let (status, result) = command(
        &app,
        &owner,
        ws,
        json!({"type": "set_role", "user_id": colleague.profile.id, "role": "member"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{result}");

    let admin_page = pull_ok(&app, &owner.token, ws, owner_client, Some(&owner_before)).await;
    assert_eq!(admin_page["reset"], false);
    assert!(
        admin_page["changes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|c| c["entity"] == "invitations" && !c["record"].is_null())
    );
    assert!(
        admin_page["changes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|c| c["entity"] == "integrations" && !c["record"].is_null())
    );

    drop(app);
    store.pool.close().await;
    database.cleanup().await;
}

#[tokio::test]
async fn pull_member_sees_admin_entities_as_null() {
    let database = support::TestDatabase::new().await;
    let store = Store::connect(&database.url).await.unwrap();
    let app = router(store.clone());
    let owner = account(&store, "owner").await;
    let member = account(&store, "member").await;
    let (ws, _) = setup(&app, &owner).await;
    invite_member(&app, &store, &owner, ws, &member).await;
    let member_client = Uuid::new_v4();

    let before = cursor_of(&pull_ok(&app, &member.token, ws, member_client, None).await);

    let (status, result) = command(
        &app,
        &owner,
        ws,
        json!({"type": "invite", "email": "pending@example.com", "role": "member", "token_hash": "ignored"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{result}");
    let invitation = result["result"]["id"].as_str().unwrap().to_owned();

    let page = pull_ok(&app, &member.token, ws, member_client, Some(&before)).await;
    assert_eq!(page["reset"], false);
    // The row is in the member's window but renders null without admin.
    assert_eq!(
        record(&page["changes"], "invitations", &invitation),
        Some(&Value::Null)
    );

    drop(app);
    store.pool.close().await;
    database.cleanup().await;
}

fn bulk_issues(team: Uuid, start: usize, count: usize) -> Vec<Value> {
    (start..start + count)
        .map(|n| json!({"id": Uuid::new_v4(), "team_id": team, "title": format!("Bulk {n}")}))
        .collect()
}

async fn import_issues(app: &axum::Router, owner: &Session, ws: Uuid, issues: Vec<Value>) {
    let (status, result) = call(
        app,
        "POST",
        &format!("/internal-api/workspaces/{ws}/import"),
        Some(&owner.token),
        Some(json!({"issues": issues})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{result}");
}

#[tokio::test]
async fn pull_pages_cut_at_txid_boundaries() {
    let database = support::TestDatabase::new().await;
    let store = Store::connect(&database.url).await.unwrap();
    let app = router(store.clone());
    let owner = account(&store, "owner").await;
    let (ws, team) = setup(&app, &owner).await;
    let client = Uuid::new_v4();

    let before = cursor_of(&pull_ok(&app, &owner.token, ws, client, None).await);

    let first_payload = bulk_issues(team, 0, 600);
    let first: Vec<Uuid> = first_payload
        .iter()
        .map(|issue| Uuid::parse_str(issue["id"].as_str().unwrap()).unwrap())
        .collect();
    import_issues(&app, &owner, ws, first_payload).await;

    let second_payload = bulk_issues(team, 600, 600);
    let second: Vec<Uuid> = second_payload
        .iter()
        .map(|issue| Uuid::parse_str(issue["id"].as_str().unwrap()).unwrap())
        .collect();
    import_issues(&app, &owner, ws, second_payload).await;

    let first_page = pull_ok(&app, &owner.token, ws, client, Some(&before)).await;
    assert_eq!(first_page["more"], true);
    assert_eq!(first_page["reset"], false);
    assert_eq!(first_page["last_mutation_id"], Value::Null);
    let issues: Vec<String> = first_page["changes"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|c| c["entity"] == "issues")
        .map(|c| c["id"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(
        issues.len(),
        600,
        "first page holds exactly the first import"
    );
    for id in &first {
        assert!(issues.contains(&id.to_string()), "missing {id}");
    }
    for id in &second {
        assert!(!issues.contains(&id.to_string()), "leaked {id}");
    }

    let next = cursor_of(&first_page);
    assert_ne!(next, before);
    let second_page = pull_ok(&app, &owner.token, ws, client, Some(&next)).await;
    assert_eq!(second_page["more"], false);
    assert_eq!(second_page["reset"], false);
    assert_eq!(second_page["last_mutation_id"], 0);
    let issues: Vec<String> = second_page["changes"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|c| c["entity"] == "issues")
        .map(|c| c["id"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(issues.len(), 600);
    for id in &second {
        assert!(issues.contains(&id.to_string()), "missing {id}");
    }

    drop(app);
    store.pool.close().await;
    database.cleanup().await;
}

#[tokio::test]
async fn pull_many_small_transactions_stay_bounded() {
    let database = support::TestDatabase::new().await;
    let store = Store::connect(&database.url).await.unwrap();
    let app = router(store.clone());
    let owner = account(&store, "owner").await;
    let (ws, team) = setup(&app, &owner).await;
    let client = Uuid::new_v4();

    let before = cursor_of(&pull_ok(&app, &owner.token, ws, client, None).await);

    let issue = created(
        &app,
        &owner,
        ws,
        json!({"type": "create_issue", "input": {"team_id": team, "title": "Edited"}}),
    )
    .await;

    // One change row per transaction, all for the same issue: a single
    // distinct pair spread over 25,000 txids. Direct inserts are one autocommit
    // transaction each, so each row gets its own txid.
    for _ in 0..25_000 {
        sqlx::query(
            "INSERT INTO changes (workspace_id, entity, entity_id) VALUES ($1, 'issues', $2)",
        )
        .bind(ws)
        .bind(issue)
        .execute(&store.pool)
        .await
        .unwrap();
    }

    // One pair can never overflow the page, so an unbounded scan would return
    // everything with `more: false`. The row cap stops the page early instead.
    let page_one = pull_ok(&app, &owner.token, ws, client, Some(&before)).await;
    assert_eq!(page_one["reset"], false);
    assert_eq!(page_one["more"], true);
    assert_eq!(page_one["last_mutation_id"], Value::Null);
    assert_eq!(
        record(&page_one["changes"], "issues", &issue.to_string()).unwrap()["title"],
        "Edited"
    );
    // Count reflected rows rather than cluster-wide txid gaps, which other
    // tests can widen. The cap is crossed after exactly 20,001 window rows.
    let delivered: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM changes WHERE workspace_id = $1 AND txid >= $2 AND txid < $3",
    )
    .bind(ws)
    .bind(cursor_xmax(&before))
    .bind(cursor_xmax(&cursor_of(&page_one)))
    .fetch_one(&store.pool)
    .await
    .unwrap();
    assert_eq!(delivered, 20_001);

    // Paging from there completes with the single issue delivered.
    let page_two = pull_ok(&app, &owner.token, ws, client, Some(&cursor_of(&page_one))).await;
    assert_eq!(page_two["reset"], false);
    assert_eq!(page_two["more"], false);
    assert_eq!(
        record(&page_two["changes"], "issues", &issue.to_string()).unwrap()["title"],
        "Edited"
    );

    drop(app);
    store.pool.close().await;
    database.cleanup().await;
}

#[tokio::test]
async fn pull_row_cap_finishes_transaction_across_batches() {
    let database = support::TestDatabase::new().await;
    let store = Store::connect(&database.url).await.unwrap();
    let app = router(store.clone());
    let owner = account(&store, "owner").await;
    let (ws, _) = setup(&app, &owner).await;
    let client = Uuid::new_v4();
    let before = cursor_of(&pull_ok(&app, &owner.token, ws, client, None).await);
    let first = Uuid::new_v4();
    let second = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO changes(workspace_id, entity, entity_id) \
         SELECT $1, 'issues', $2 FROM generate_series(1, 20005)",
    )
    .bind(ws)
    .bind(first)
    .execute(&store.pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO changes(workspace_id, entity, entity_id) VALUES($1, 'issues', $2)")
        .bind(ws)
        .bind(second)
        .execute(&store.pool)
        .await
        .unwrap();

    let page = pull_ok(&app, &owner.token, ws, client, Some(&before)).await;
    assert_eq!(page["reset"], false);
    assert_eq!(page["more"], true);
    assert_eq!(page["changes"].as_array().unwrap().len(), 1);
    assert_eq!(
        record(&page["changes"], "issues", &first.to_string()),
        Some(&Value::Null)
    );
    assert!(record(&page["changes"], "issues", &second.to_string()).is_none());
    let delivered: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM changes WHERE workspace_id = $1 AND txid >= $2 AND txid < $3",
    )
    .bind(ws)
    .bind(cursor_xmax(&before))
    .bind(cursor_xmax(&cursor_of(&page)))
    .fetch_one(&store.pool)
    .await
    .unwrap();
    assert_eq!(delivered, 20_005);
    let final_page = pull_ok(&app, &owner.token, ws, client, Some(&cursor_of(&page))).await;
    assert_eq!(final_page["reset"], false);
    assert_eq!(final_page["more"], false);
    assert_eq!(final_page["changes"].as_array().unwrap().len(), 1);
    assert_eq!(
        record(&final_page["changes"], "issues", &second.to_string()),
        Some(&Value::Null)
    );

    drop(app);
    store.pool.close().await;
    database.cleanup().await;
}

#[tokio::test]
async fn pull_single_transaction_over_limit_resets() {
    let database = support::TestDatabase::new().await;
    let store = Store::connect(&database.url).await.unwrap();
    let app = router(store.clone());
    let owner = account(&store, "owner").await;
    let (ws, team) = setup(&app, &owner).await;
    let client = Uuid::new_v4();

    let before = cursor_of(&pull_ok(&app, &owner.token, ws, client, None).await);

    let payload: Vec<Value> = (0..1001)
        .map(|n| json!({"id": Uuid::new_v4(), "team_id": team, "title": format!("Huge {n}")}))
        .collect();
    import_issues(&app, &owner, ws, payload).await;

    let page = pull_ok(&app, &owner.token, ws, client, Some(&before)).await;
    assert_eq!(page["reset"], true);
    assert_eq!(page["more"], false);
    assert_eq!(page["changes"], json!([]));
    assert_eq!(page["last_mutation_id"], Value::Null);

    drop(app);
    store.pool.close().await;
    database.cleanup().await;
}

#[tokio::test]
async fn pull_cursor_below_horizon_resets() {
    let database = support::TestDatabase::new().await;
    let store = Store::connect(&database.url).await.unwrap();
    let app = router(store.clone());
    let owner = account(&store, "owner").await;
    let (ws, team) = setup(&app, &owner).await;
    let client = Uuid::new_v4();

    let before = cursor_of(&pull_ok(&app, &owner.token, ws, client, None).await);
    let _ = created(
        &app,
        &owner,
        ws,
        json!({"type": "create_issue", "input": {"team_id": team, "title": "After"}}),
    )
    .await;

    let xmin: i64 = before.split(':').next().unwrap().parse().unwrap();
    sqlx::query("UPDATE change_horizon SET txid = $1")
        .bind(xmin + 1)
        .execute(&store.pool)
        .await
        .unwrap();

    let page = pull_ok(&app, &owner.token, ws, client, Some(&before)).await;
    assert_eq!(page["reset"], true);
    assert_eq!(page["changes"], json!([]));
    assert_eq!(page["last_mutation_id"], Value::Null);
    assert_eq!(page["more"], false);
    assert!(cursor_xmax(&cursor_of(&page)) >= cursor_xmax(&before));

    drop(app);
    store.pool.close().await;
    database.cleanup().await;
}

#[tokio::test]
async fn pull_own_role_change_resets_other_does_not() {
    let database = support::TestDatabase::new().await;
    let store = Store::connect(&database.url).await.unwrap();
    let app = router(store.clone());
    let owner = account(&store, "owner").await;
    let alice = account(&store, "alice").await;
    let bob = account(&store, "bob").await;
    let (ws, _) = setup(&app, &owner).await;
    invite_member(&app, &store, &owner, ws, &alice).await;
    invite_member(&app, &store, &owner, ws, &bob).await;
    let alice_client = Uuid::new_v4();

    let before = cursor_of(&pull_ok(&app, &alice.token, ws, alice_client, None).await);

    let (status, result) = command(
        &app,
        &owner,
        ws,
        json!({"type": "set_role", "user_id": alice.profile.id, "role": "admin"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{result}");

    let page = pull_ok(&app, &alice.token, ws, alice_client, Some(&before)).await;
    assert_eq!(page["reset"], true);
    assert_eq!(page["last_mutation_id"], Value::Null);

    let after = cursor_of(&page);
    let (status, result) = command(
        &app,
        &owner,
        ws,
        json!({"type": "set_role", "user_id": bob.profile.id, "role": "admin"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{result}");

    let page = pull_ok(&app, &alice.token, ws, alice_client, Some(&after)).await;
    assert_eq!(page["reset"], false);
    let changed =
        record(&page["changes"], "members", &bob.profile.id.to_string()).expect("bob in pull");
    assert_eq!(changed["role"], "admin");

    drop(app);
    store.pool.close().await;
    database.cleanup().await;
}

#[tokio::test]
async fn pull_role_change_beyond_first_page_resets() {
    let database = support::TestDatabase::new().await;
    let store = Store::connect(&database.url).await.unwrap();
    let app = router(store.clone());
    let owner = account(&store, "owner").await;
    let alice = account(&store, "alice").await;
    let (ws, team) = setup(&app, &owner).await;
    invite_member(&app, &store, &owner, ws, &alice).await;
    let client = Uuid::new_v4();
    let before = cursor_of(&pull_ok(&app, &alice.token, ws, client, None).await);

    import_issues(&app, &owner, ws, bulk_issues(team, 0, 600)).await;
    import_issues(&app, &owner, ws, bulk_issues(team, 600, 600)).await;
    let (status, result) = command(
        &app,
        &owner,
        ws,
        json!({"type": "set_role", "user_id": alice.profile.id, "role": "admin"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{result}");
    let page = pull_ok(&app, &alice.token, ws, client, Some(&before)).await;
    assert_eq!(page["reset"], true);
    assert_eq!(page["more"], false);
    assert_eq!(page["changes"], json!([]));
    assert_eq!(page["last_mutation_id"], Value::Null);

    // The marker is private and never appears in command or pull records.
    let owner_page = pull_ok(&app, &owner.token, ws, Uuid::new_v4(), Some(&before)).await;
    assert_eq!(owner_page["reset"], false);
    for changes in [&result["changes"], &owner_page["changes"]] {
        assert!(
            changes
                .as_array()
                .unwrap()
                .iter()
                .all(|c| c["entity"] != "roles")
        );
    }

    drop(app);
    store.pool.close().await;
    database.cleanup().await;
}

#[tokio::test]
async fn pull_pages_committed_xip_transactions_below_request_xmax() {
    let database = support::TestDatabase::new().await;
    let store = Store::connect(&database.url).await.unwrap();
    let app = router(store.clone());
    let owner = account(&store, "owner").await;
    let (ws, _) = setup(&app, &owner).await;
    let client = Uuid::new_v4();
    let mut transactions = Vec::new();
    let mut txids = Vec::new();
    let ids: Vec<Uuid> = (0..1200).map(|_| Uuid::new_v4()).collect();
    for chunk in ids.chunks(600) {
        let mut tx = store.pool.begin().await.unwrap();
        let txid: i64 = sqlx::query_scalar("SELECT pg_current_xact_id()::text::bigint")
            .fetch_one(&mut *tx)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO changes(workspace_id, entity, entity_id) \
             SELECT $1, 'issues', id FROM unnest($2::uuid[]) AS t(id)",
        )
        .bind(ws)
        .bind(chunk)
        .execute(&mut *tx)
        .await
        .unwrap();
        txids.push(txid);
        transactions.push(tx);
    }
    // Advance xmax beyond both transactions while they remain in flight.
    sqlx::query("SELECT pg_current_xact_id()")
        .execute(&store.pool)
        .await
        .unwrap();
    let before = cursor_of(&pull_ok(&app, &owner.token, ws, client, None).await);
    assert!(cursor_xmax(&before) > txids[1]);
    for tx in transactions {
        tx.commit().await.unwrap();
    }

    let first = pull_ok(&app, &owner.token, ws, client, Some(&before)).await;
    assert_eq!(first["reset"], false);
    assert_eq!(first["more"], true);
    assert_eq!(first["last_mutation_id"], Value::Null);
    assert_eq!(cursor_xmax(&cursor_of(&first)), cursor_xmax(&before));
    let first_xip = cursor_of(&first).split(':').nth(2).unwrap().to_owned();
    assert!(!first_xip.split(',').any(|x| x == txids[0].to_string()));
    assert!(first_xip.split(',').any(|x| x == txids[1].to_string()));
    assert_eq!(first["changes"].as_array().unwrap().len(), 600);
    for entity_id in &ids[..600] {
        assert_eq!(
            record(&first["changes"], "issues", &entity_id.to_string()),
            Some(&Value::Null)
        );
    }
    let second = pull_ok(&app, &owner.token, ws, client, Some(&cursor_of(&first))).await;
    assert_eq!(second["reset"], false);
    assert_eq!(second["more"], false);
    assert_eq!(second["last_mutation_id"], 0);
    assert_eq!(second["changes"].as_array().unwrap().len(), 600);
    for entity_id in &ids[600..] {
        assert_eq!(
            record(&second["changes"], "issues", &entity_id.to_string()),
            Some(&Value::Null)
        );
    }

    drop(app);
    store.pool.close().await;
    database.cleanup().await;
}

#[tokio::test]
async fn pull_keeps_pair_cap_and_deduplication_across_xip_and_range() {
    let database = support::TestDatabase::new().await;
    let store = Store::connect(&database.url).await.unwrap();
    let app = router(store.clone());
    let owner = account(&store, "owner").await;
    let (ws, _) = setup(&app, &owner).await;
    let client = Uuid::new_v4();
    let ids: Vec<Uuid> = (0..1001).map(|_| Uuid::new_v4()).collect();
    let mut tx = store.pool.begin().await.unwrap();
    let xip_txid: i64 = sqlx::query_scalar("SELECT pg_current_xact_id()::text::bigint")
        .fetch_one(&mut *tx)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO changes(workspace_id, entity, entity_id) \
         SELECT $1, 'issues', id FROM unnest($2::uuid[]) AS t(id)",
    )
    .bind(ws)
    .bind(&ids[..600])
    .execute(&mut *tx)
    .await
    .unwrap();
    sqlx::query("SELECT pg_current_xact_id()")
        .execute(&store.pool)
        .await
        .unwrap();
    let before = cursor_of(&pull_ok(&app, &owner.token, ws, client, None).await);
    assert!(cursor_xmax(&before) > xip_txid);
    tx.commit().await.unwrap();

    // The range repeats 200 pairs from xip, then fills the 1,000-pair page.
    sqlx::query(
        "INSERT INTO changes(workspace_id, entity, entity_id) \
         SELECT $1, 'issues', id FROM unnest($2::uuid[]) AS t(id)",
    )
    .bind(ws)
    .bind(&ids[400..1000])
    .execute(&store.pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO changes(workspace_id, entity, entity_id) VALUES($1, 'issues', $2)")
        .bind(ws)
        .bind(ids[1000])
        .execute(&store.pool)
        .await
        .unwrap();

    let first = pull_ok(&app, &owner.token, ws, client, Some(&before)).await;
    assert_eq!(first["reset"], false);
    assert_eq!(first["more"], true);
    assert_eq!(first["last_mutation_id"], Value::Null);
    assert_eq!(first["changes"].as_array().unwrap().len(), 1000);
    for entity_id in &ids[..1000] {
        assert_eq!(
            record(&first["changes"], "issues", &entity_id.to_string()),
            Some(&Value::Null)
        );
    }
    assert!(record(&first["changes"], "issues", &ids[1000].to_string()).is_none());
    let next = cursor_of(&first);
    assert!(cursor_xmax(&next) > cursor_xmax(&before));
    assert!(
        !next
            .split(':')
            .nth(2)
            .unwrap()
            .split(',')
            .any(|txid| txid == xip_txid.to_string())
    );
    let second = pull_ok(&app, &owner.token, ws, client, Some(&next)).await;
    assert_eq!(second["reset"], false);
    assert_eq!(second["more"], false);
    assert_eq!(second["last_mutation_id"], 0);
    assert_eq!(second["changes"].as_array().unwrap().len(), 1);
    assert_eq!(
        record(&second["changes"], "issues", &ids[1000].to_string()),
        Some(&Value::Null)
    );

    drop(app);
    store.pool.close().await;
    database.cleanup().await;
}

#[tokio::test]
async fn pull_profile_edit_and_team_join_do_not_reset() {
    let database = support::TestDatabase::new().await;
    let store = Store::connect(&database.url).await.unwrap();
    let app = router(store.clone());
    let owner = account(&store, "owner").await;
    let (ws, _) = setup(&app, &owner).await;
    let client = Uuid::new_v4();

    let before = cursor_of(&pull_ok(&app, &owner.token, ws, client, None).await);

    // A profile edit marks the actor's membership row, but writes no role
    // marker, so it rides along as a normal change.
    let (status, me) = call(&app, "GET", "/internal-api/me", Some(&owner.token), None).await;
    assert_eq!(status, StatusCode::OK, "{me}");
    let (status, result) = call(
        &app,
        "PATCH",
        "/internal-api/me",
        Some(&owner.token),
        Some(json!({
            "display_name": "Renamed",
            "avatar_url": me["avatar_url"],
            "contact": me["contact"],
            "language": me["language"],
            "theme": me["theme"],
            "alerts": me["alerts"],
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{result}");

    // Joining a team marks teams and the actor's membership row, and that is
    // not a role change either.
    let team = created(
        &app,
        &owner,
        ws,
        json!({"type": "create_team", "name": "Second", "key": "SEC", "members": [owner.profile.id]}),
    )
    .await;

    let page = pull_ok(&app, &owner.token, ws, client, Some(&before)).await;
    assert_eq!(page["reset"], false);
    assert_eq!(page["more"], false);
    let member = record(&page["changes"], "members", &owner.profile.id.to_string())
        .expect("own membership in pull");
    assert_eq!(member["display_name"], "Renamed");
    assert!(
        member["team_ids"]
            .as_array()
            .unwrap()
            .iter()
            .any(|id| id == &json!(team)),
        "new team in member team_ids: {member}"
    );
    assert_eq!(
        record(&page["changes"], "teams", &team.to_string()).unwrap()["name"],
        "Second"
    );

    drop(app);
    store.pool.close().await;
    database.cleanup().await;
}

#[tokio::test]
async fn pull_cursor_validation() {
    let database = support::TestDatabase::new().await;
    let store = Store::connect(&database.url).await.unwrap();
    let app = router(store.clone());
    let owner = account(&store, "owner").await;
    let (ws, _) = setup(&app, &owner).await;
    let client = Uuid::new_v4();

    // Malformed strings, inverted snapshots, xip entries outside
    // `[xmin, xmax)`, unsorted or duplicated xip, and a snapshot from the
    // future are each 400.
    let bad = vec![
        "nope".to_owned(),
        String::new(),
        "100".to_owned(),
        "100:200".to_owned(),
        "100:200:100:".to_owned(),
        "a:b:c".to_owned(),
        "0:0:+0".to_owned(),
        "+0:0:".to_owned(),
        "99:105:100".to_owned(),
        "99:105:98,99".to_owned(),
        "99:105:".to_owned(),
        "101:100:".to_owned(),
        "99:105:99,200".to_owned(),
        "99:105:99,105".to_owned(),
        "99:110:99,104,103".to_owned(),
        "99:110:99,99".to_owned(),
        "99999990:99999999:99999990".to_owned(),
        "99999999:99999999:".to_owned(),
    ];
    for cursor in &bad {
        let (status, _) = pull(&app, &owner.token, ws, client, Some(cursor)).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "cursor {cursor:?}");
    }

    // An xip list over the cap is 400 even though its shape is valid.
    let huge = format!(
        "1:20000:{}",
        (1..=10_001)
            .map(|x: i64| x.to_string())
            .collect::<Vec<_>>()
            .join(",")
    );
    let (status, _) = pull(&app, &owner.token, ws, client, Some(&huge)).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    drop(app);
    store.pool.close().await;
    database.cleanup().await;
}

#[tokio::test]
async fn pull_last_mutation_id_rules() {
    let database = support::TestDatabase::new().await;
    let store = Store::connect(&database.url).await.unwrap();
    let app = router(store.clone());
    let owner = account(&store, "owner").await;
    let (ws, team) = setup(&app, &owner).await;
    let client = Uuid::new_v4();

    // Cursorless responses never acknowledge the outbox.
    let start = pull_ok(&app, &owner.token, ws, client, None).await;
    assert_eq!(start["last_mutation_id"], Value::Null);
    let before = cursor_of(&start);

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
                json!({"name": "pulled", "color": "#000000"}),
            ),
            mutation(
                2,
                "create_issue",
                json!({"input": {"id": issue, "team_id": team, "title": "Pushed"}}),
            ),
        ],
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{result}");
    assert_eq!(result["last_mutation_id"], 2);

    // Two imports force an intermediate page, which leaves the outbox alone.
    import_issues(&app, &owner, ws, bulk_issues(team, 0, 600)).await;
    import_issues(&app, &owner, ws, bulk_issues(team, 600, 600)).await;

    let middle = pull_ok(&app, &owner.token, ws, client, Some(&before)).await;
    assert_eq!(middle["more"], true);
    assert_eq!(middle["reset"], false);
    assert_eq!(middle["last_mutation_id"], Value::Null);

    assert_eq!(
        record(&middle["changes"], "issues", &issue.to_string()).unwrap()["title"],
        "Pushed"
    );
    assert_eq!(
        pull_ok(&app, &owner.token, ws, client, None).await["last_mutation_id"],
        Value::Null
    );

    // Only the final page acknowledges the mutations already delivered.
    let final_page = pull_ok(&app, &owner.token, ws, client, Some(&cursor_of(&middle))).await;
    assert_eq!(final_page["more"], false);
    assert_eq!(final_page["reset"], false);
    assert_eq!(final_page["last_mutation_id"], 2);
    assert_eq!(
        record(&final_page["changes"], "issues", &issue.to_string()),
        None
    );

    drop(app);
    store.pool.close().await;
    database.cleanup().await;
}

#[tokio::test]
async fn pull_last_mutation_id_reflects_pushes() {
    let database = support::TestDatabase::new().await;
    let store = Store::connect(&database.url).await.unwrap();
    let app = router(store.clone());
    let owner = account(&store, "owner").await;
    let (ws, team) = setup(&app, &owner).await;
    let client = Uuid::new_v4();

    let before = cursor_of(&pull_ok(&app, &owner.token, ws, client, None).await);

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
                json!({"name": "pulled", "color": "#000000"}),
            ),
            mutation(
                2,
                "create_issue",
                json!({"input": {"id": issue, "team_id": team, "title": "Pushed"}}),
            ),
        ],
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{result}");
    assert_eq!(result["last_mutation_id"], 2);

    let page = pull_ok(&app, &owner.token, ws, client, Some(&before)).await;
    assert_eq!(page["more"], false);
    assert_eq!(page["reset"], false);
    assert_eq!(page["last_mutation_id"], 2);
    assert_eq!(
        record(&page["changes"], "issues", &issue.to_string()).unwrap()["title"],
        "Pushed"
    );

    drop(app);
    store.pool.close().await;
    database.cleanup().await;
}

#[tokio::test]
async fn pull_request_errors() {
    let database = support::TestDatabase::new().await;
    let store = Store::connect(&database.url).await.unwrap();
    let app = router(store.clone());
    let owner = account(&store, "owner").await;
    let member = account(&store, "member").await;
    let outsider = account(&store, "outsider").await;
    let (ws, _) = setup(&app, &owner).await;
    invite_member(&app, &store, &owner, ws, &member).await;
    let other = workspace(&app, &owner, "Other").await;

    // Non-members cannot pull.
    let (status, _) = pull(&app, &outsider.token, ws, Uuid::new_v4(), None).await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    // A client_id owned by another user or workspace is a request error.
    let client = Uuid::new_v4();
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

    let (status, _) = pull(&app, &member.token, ws, client, None).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, _) = pull(&app, &owner.token, other, client, None).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    // Missing and malformed client ids are request errors too.
    let (status, _) = call(
        &app,
        "GET",
        &format!("/internal-api/workspaces/{ws}/sync/pull"),
        Some(&owner.token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, _) = call(
        &app,
        "GET",
        &format!("/internal-api/workspaces/{ws}/sync/pull?client_id=nope"),
        Some(&owner.token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    // Malformed and out-of-range cursors are request errors.
    let client = Uuid::new_v4();
    for bad in ["nope", "999999999999", "-1", ""] {
        let (status, _) = call(
            &app,
            "GET",
            &format!("/internal-api/workspaces/{ws}/sync/pull?client_id={client}&cursor={bad}"),
            Some(&owner.token),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "cursor {bad:?}");
    }

    drop(app);
    store.pool.close().await;
    database.cleanup().await;
}

#[tokio::test]
async fn pull_replays_command_changes_with_current_records() {
    let database = support::TestDatabase::new().await;
    let store = Store::connect(&database.url).await.unwrap();
    let app = router(store.clone());

    let mut sessions = Vec::new();
    for name in ["owner", "colleague"] {
        sessions.push(account(&store, name).await);
    }
    let (owner, colleague) = (&sessions[0], &sessions[1]);

    let ws = workspace(&app, owner, "Changes").await;
    sqlx::query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'member')")
        .bind(ws)
        .bind(colleague.profile.id)
        .execute(&store.pool)
        .await
        .unwrap();

    let owner_client = Uuid::new_v4();
    let colleague_client = Uuid::new_v4();
    let start = pull_ok(&app, &colleague.token, ws, colleague_client, None).await;
    assert_eq!(start["reset"], false);
    assert_eq!(start["changes"], json!([]));
    let colleague_cursor = cursor_of(&start);

    let (_, result) = command(
        &app,
        owner,
        ws,
        json!({"type":"create_team","name":"Ops", "key": "OPS","members":[owner.profile.id]}),
    )
    .await;
    let team = result["result"]["id"].as_str().unwrap().to_owned();
    assert_eq!(
        result["changes"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["entity"] == "teams" && c["id"] == team)
            .unwrap()["record"]["name"],
        "Ops"
    );
    let stages = result["changes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["entity"] == "teams" && c["id"] == team)
        .unwrap()["record"]["stages"]
        .as_array()
        .unwrap()
        .clone();
    let done = stages.iter().find(|s| s["kind"] == "done").unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let me = owner.profile.id.to_string();
    assert_eq!(
        result["changes"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["entity"] == "members" && c["id"] == me)
            .unwrap()["record"]["team_ids"],
        json!([team])
    );
    // The team join changed the owner's own membership row, but that is not
    // a role change, so an owner cursor from before it still pulls records.
    let owner_cursor = cursor_of(&pull_ok(&app, &owner.token, ws, owner_client, None).await);

    let (_, result) = command(
        &app,
        owner,
        ws,
        json!({"type":"create_issue","input":{"team_id":team,"title":"Parent"}}),
    )
    .await;
    let parent = result["result"]["id"].as_str().unwrap().to_owned();

    let (_, result) = command(
        &app,
        owner,
        ws,
        json!({"type":"create_issue","input":{"team_id":team,"title":"Child","parent_id":parent}}),
    )
    .await;
    let child = result["result"]["id"].as_str().unwrap().to_owned();

    let (_, result) = command(
        &app,
        owner,
        ws,
        json!({"type":"move_issue","id":child,"stage_id":done,"before_id":null}),
    )
    .await;
    assert_eq!(
        result["changes"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["entity"] == "issues" && c["id"] == child)
            .unwrap()["record"]["stage_id"],
        done
    );

    let (_, result) = command(
        &app,
        owner,
        ws,
        json!({"type":"save_view","name":"Mine","shared":false,"filter":{}}),
    )
    .await;
    let view = result["result"]["id"].as_str().unwrap().to_owned();

    let (_, result) = command(&app, owner, ws, json!({"type":"create_issue","input":{"team_id":team,"title":"Blocked","dependencies":[parent],"assignee":colleague.profile.id}})).await;
    let blocked = result["result"]["id"].as_str().unwrap().to_owned();
    assert!(
        !result["changes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|c| c["entity"] == "notifications")
    );

    let changes = pull_ok(
        &app,
        &colleague.token,
        ws,
        colleague_client,
        Some(&colleague_cursor),
    )
    .await;
    assert_eq!(changes["reset"], false);
    let list = &changes["changes"];
    assert_eq!(record(list, "teams", &team).unwrap()["name"], "Ops");
    assert_eq!(record(list, "issues", &child).unwrap()["stage_id"], done);
    assert!(record(list, "views", &view).is_none());
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

    let cursor = cursor_of(&changes);
    assert_eq!(
        pull_ok(&app, &colleague.token, ws, colleague_client, Some(&cursor)).await["changes"],
        json!([])
    );

    let (_, result) = command(
        &app,
        owner,
        ws,
        json!({"type":"move_issue","id":parent,"stage_id":done,"before_id":null}),
    )
    .await;
    assert!(
        !result["changes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|c| c["entity"] == "issues" && c["id"] == blocked)
    );
    let cursor =
        cursor_of(&pull_ok(&app, &colleague.token, ws, colleague_client, Some(&cursor)).await);

    let (_, result) = command(&app, owner, ws, json!({"type":"delete_view","id":view})).await;
    assert_eq!(
        result["changes"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["entity"] == "views" && c["id"] == view)
            .map(|c| &c["record"]),
        Some(&Value::Null)
    );
    assert_eq!(
        record(
            &pull_ok(&app, &owner.token, ws, owner_client, Some(&owner_cursor)).await["changes"],
            "views",
            &view
        ),
        Some(&Value::Null)
    );
    assert!(
        record(
            &pull_ok(&app, &colleague.token, ws, colleague_client, Some(&cursor)).await["changes"],
            "views",
            &view
        )
        .is_none()
    );

    sqlx::query("UPDATE changes SET created_at=now()-interval '40 days'")
        .execute(&store.pool)
        .await
        .unwrap();
    assert!(store.prune_changes(30).await.unwrap() > 0);
    let changes = pull_ok(
        &app,
        &colleague.token,
        ws,
        colleague_client,
        Some(&colleague_cursor),
    )
    .await;
    assert_eq!(changes["reset"], true);
    assert_eq!(changes["changes"], json!([]));
    assert_eq!(changes["more"], false);
    assert_eq!(changes["last_mutation_id"], Value::Null);

    drop(app);
    store.pool.close().await;
    database.cleanup().await;
}

async fn bootstrap_text(app: &axum::Router, token: &str, workspace: Uuid) -> String {
    let request = Request::builder()
        .uri(format!(
            "/internal-api/workspaces/{workspace}/sync/bootstrap?client_id={}",
            Uuid::new_v4()
        ))
        .header("Authorization", format!("Bearer {token}"))
        .body(Body::empty())
        .unwrap();
    let response = app.clone().oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    String::from_utf8(bytes.to_vec()).unwrap()
}

#[tokio::test]
async fn planning_deletes_clear_references_on_live_and_trashed_issues() {
    let database = support::TestDatabase::new().await;
    let store = Store::connect(&database.url).await.unwrap();
    let app = router(store.clone());
    let owner = account(&store, "owner").await;
    let viewer = account(&store, "viewer").await;
    let (ws, team) = setup(&app, &owner).await;
    sqlx::query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'viewer')")
        .bind(ws)
        .bind(viewer.profile.id)
        .execute(&store.pool)
        .await
        .unwrap();
    let client = Uuid::new_v4();

    let label = created(
        &app,
        &owner,
        ws,
        json!({"type": "create_label", "name": "bug", "color": "red"}),
    )
    .await;
    let project = created(
        &app,
        &owner,
        ws,
        json!({"type": "create_project", "name": "Launch", "team_ids": [team]}),
    )
    .await;
    let mut milestones = vec![];
    for name in ["Beta", "GA"] {
        milestones.push(
            created(
                &app,
                &owner,
                ws,
                json!({"type": "create_milestone", "project_id": project, "name": name, "deadline": null}),
            )
            .await,
        );
    }
    let mut issues = vec![];
    for title in ["Live", "Trashed"] {
        issues.push(
            created(
                &app,
                &owner,
                ws,
                json!({"type": "create_issue", "input": {"team_id": team, "title": title, "labels": [label], "project_id": project, "milestone_id": milestones[0]}}),
            )
            .await,
        );
    }
    let (live, trashed) = (issues[0], issues[1]);
    created(
        &app,
        &owner,
        ws,
        json!({"type": "delete_issue", "id": trashed}),
    )
    .await;
    let before = cursor_of(&pull_ok(&app, &owner.token, ws, client, None).await);

    let (status, result) = push(
        &app,
        &viewer.token,
        ws,
        Uuid::new_v4(),
        vec![mutation(1, "delete_label", json!({"id": label}))],
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{result}");
    assert_eq!(result["results"][0]["error"]["status"], 403, "{result}");

    let ghost = Uuid::new_v4();
    let (status, result) = push(
        &app,
        &owner.token,
        ws,
        client,
        vec![
            mutation(1, "delete_label", json!({"id": ghost})),
            mutation(2, "delete_project", json!({"id": ghost})),
            mutation(3, "delete_milestone", json!({"id": ghost})),
            mutation(4, "delete_label", json!({"id": label})),
            mutation(5, "delete_milestone", json!({"id": milestones[0]})),
        ],
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{result}");
    for index in 0..3 {
        assert_eq!(result["results"][index]["error"]["status"], 404, "{result}");
    }
    assert_eq!(result["results"][3]["status"], "applied", "{result}");
    assert_eq!(result["results"][4]["status"], "applied", "{result}");

    let page = pull_ok(&app, &owner.token, ws, client, Some(&before)).await;
    let changes = &page["changes"];
    assert_eq!(
        record(changes, "labels", &label.to_string()),
        Some(&Value::Null)
    );
    assert_eq!(
        record(changes, "milestones", &milestones[0].to_string()),
        Some(&Value::Null)
    );
    let issue = record(changes, "issues", &live.to_string()).unwrap();
    assert_eq!(issue["labels"], json!([]), "{issue}");
    assert_eq!(issue["milestone_id"], Value::Null);
    assert_eq!(issue["project_id"], json!(project));
    let stored: Vec<(Uuid, i64, i64)> = sqlx::query_as(
        "SELECT id, version, (SELECT count(*) FROM issue_labels l WHERE l.issue_id = i.id) \
         FROM issues i WHERE workspace_id = $1 AND milestone_id IS NULL ORDER BY number",
    )
    .bind(ws)
    .fetch_all(&store.pool)
    .await
    .unwrap();
    assert_eq!(stored, vec![(live, 3, 0), (trashed, 4, 0)]);

    let (status, result) = push(
        &app,
        &owner.token,
        ws,
        client,
        vec![mutation(6, "delete_project", json!({"id": project}))],
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{result}");
    assert_eq!(result["results"][0]["status"], "applied", "{result}");
    let page = pull_ok(&app, &owner.token, ws, client, Some(&before)).await;
    let changes = &page["changes"];
    assert_eq!(
        record(changes, "projects", &project.to_string()),
        Some(&Value::Null)
    );
    assert_eq!(
        record(changes, "milestones", &milestones[1].to_string()),
        Some(&Value::Null)
    );
    assert_eq!(
        record(changes, "issues", &live.to_string()).unwrap()["project_id"],
        Value::Null
    );
    let referenced: i64 = sqlx::query_scalar(
        "SELECT (SELECT count(*) FROM issues WHERE workspace_id=$1 AND project_id IS NOT NULL) \
         + (SELECT count(*) FROM project_teams WHERE workspace_id=$1)",
    )
    .bind(ws)
    .fetch_one(&store.pool)
    .await
    .unwrap();
    assert_eq!(referenced, 0);

    let snapshot = bootstrap_text(&app, &owner.token, ws).await;
    for gone in [label, project, milestones[0], milestones[1]] {
        assert!(
            !snapshot.contains(&gone.to_string()),
            "{gone} in {snapshot}"
        );
    }
    assert!(snapshot.contains(&live.to_string()));

    drop(app);
    store.pool.close().await;
    database.cleanup().await;
}

#[tokio::test]
async fn pull_tombstones_issues_purged_from_the_trash_with_their_activity() {
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
        json!({"type": "create_issue", "input": {"team_id": team, "title": "Old"}}),
    )
    .await;
    let comment = created(
        &app,
        &owner,
        ws,
        json!({"type": "add_comment", "issue_id": issue, "body": "Note"}),
    )
    .await;
    let (status, result) = command(
        &app,
        &owner,
        ws,
        json!({"type": "delete_issue", "id": issue}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{result}");
    let activity: Vec<Uuid> = sqlx::query_scalar("SELECT id FROM activity WHERE entity_id=ANY($1)")
        .bind(vec![issue, comment])
        .fetch_all(&store.pool)
        .await
        .unwrap();
    assert!(activity.len() >= 3, "create, comment and delete activity");
    sqlx::query("UPDATE issues SET deleted_at=now()-interval '31 days' WHERE id=$1")
        .bind(issue)
        .execute(&store.pool)
        .await
        .unwrap();
    let start = pull_ok(&app, &owner.token, ws, client, None).await;

    assert_eq!(store.purge_trash().await.unwrap(), 1);

    let page = pull_ok(&app, &owner.token, ws, client, Some(&cursor_of(&start))).await;
    assert_eq!(page["more"], false);
    assert_eq!(
        record(&page["changes"], "issues", &issue.to_string()),
        Some(&Value::Null)
    );
    assert_eq!(
        record(&page["changes"], "comments", &comment.to_string()),
        Some(&Value::Null)
    );
    for id in activity {
        assert_eq!(
            record(&page["changes"], "activity", &id.to_string()),
            Some(&Value::Null),
            "activity {id} is tombstoned"
        );
    }

    store.pool.close().await;
    database.cleanup().await;
}
