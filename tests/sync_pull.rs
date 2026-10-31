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
            invitation: None,
        })
        .await
        .unwrap()
        .session()
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

async fn invite_member(app: &axum::Router, owner: &Session, workspace: Uuid, user: &Session) {
    let (status, result) = command(
        app,
        owner,
        workspace,
        json!({"type": "invite", "email": user.profile.email, "role": "member", "token_hash": "ignored"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{result}");

    let token = result["result"]["invitation"]["token"].clone();

    let (status, result) = call(
        app,
        "POST",
        &format!("/internal-api/workspaces/{workspace}/invitations/accept"),
        Some(&user.token),
        Some(json!({"token": token})),
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
    invite_member(&app, &owner, ws, &colleague).await;
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
    invite_member(&app, &owner, ws, &colleague).await;
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
    invite_member(&app, &owner, ws, &member).await;
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
    // tests can widen. The page takes exactly 20,000 window rows.
    let delivered: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM changes WHERE workspace_id = $1 AND txid >= $2 AND txid < $3",
    )
    .bind(ws)
    .bind(cursor_xmax(&before))
    .bind(cursor_xmax(&cursor_of(&page_one)))
    .fetch_one(&store.pool)
    .await
    .unwrap();
    assert_eq!(delivered, 20_000);

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

/// Pulls from `cursor` until a final page. Every page must be a normal one,
/// and only the final one may acknowledge the outbox.
async fn pull_pages(
    app: &axum::Router,
    token: &str,
    workspace: Uuid,
    client: Uuid,
    cursor: &str,
) -> Vec<Value> {
    let mut pages = Vec::new();
    let mut cursor = cursor.to_owned();
    loop {
        let page = pull_ok(app, token, workspace, client, Some(&cursor)).await;
        assert_eq!(page["reset"], false, "page {}", pages.len());
        assert!(
            page["changes"].as_array().unwrap().len() <= 1000,
            "page {} is over the limit",
            pages.len()
        );
        let more = page["more"].as_bool().unwrap();
        assert_eq!(
            page["last_mutation_id"].is_null(),
            more,
            "page {} acknowledges the outbox only when final",
            pages.len()
        );
        let next = cursor_of(&page);
        pages.push(page);
        if !more {
            return pages;
        }
        assert_ne!(next, cursor, "an unfinished page must move the cursor");
        assert!(pages.len() < 200, "paging does not converge");
        cursor = next;
    }
}

/// Each record of `entity` the pages delivered, by id.
fn paged_entity<'a>(
    pages: &'a [Value],
    entity: &str,
) -> std::collections::HashMap<&'a str, &'a Value> {
    pages
        .iter()
        .flat_map(|page| page["changes"].as_array().unwrap())
        .filter(|change| change["entity"] == entity)
        .map(|change| (change["id"].as_str().unwrap(), &change["record"]))
        .collect()
}

fn paged_records(pages: &[Value]) -> std::collections::BTreeSet<(String, String)> {
    pages
        .iter()
        .flat_map(|page| page["changes"].as_array().unwrap())
        .map(|change| {
            (
                change["entity"].as_str().unwrap().to_owned(),
                change["id"].as_str().unwrap().to_owned(),
            )
        })
        .collect()
}

/// Records the actor sees as changed by transactions at or after `xmax`.
async fn changed_since(
    store: &Store,
    workspace: Uuid,
    actor: Uuid,
    xmax: i64,
) -> std::collections::BTreeSet<(String, String)> {
    let rows: Vec<(String, Uuid)> = sqlx::query_as(
        "SELECT DISTINCT entity, entity_id FROM changes \
         WHERE workspace_id = $1 AND txid >= $2 AND entity <> 'roles' \
           AND (user_id IS NULL OR user_id = $3)",
    )
    .bind(workspace)
    .bind(xmax)
    .bind(actor)
    .fetch_all(&store.pool)
    .await
    .unwrap();
    rows.into_iter()
        .map(|(entity, id)| (entity, id.to_string()))
        .collect()
}

#[tokio::test]
async fn pull_spans_a_large_transaction_over_pages_without_reset() {
    let database = support::TestDatabase::new().await;
    let store = Store::connect(&database.url).await.unwrap();
    let app = router(store.clone());
    let owner = account(&store, "owner").await;
    let (ws, team) = setup(&app, &owner).await;
    let client = Uuid::new_v4();

    let before = cursor_of(&pull_ok(&app, &owner.token, ws, client, None).await);
    let payload = bulk_issues(team, 0, 5000);
    let issue_ids: Vec<String> = payload
        .iter()
        .map(|issue| issue["id"].as_str().unwrap().to_owned())
        .collect();
    import_issues(&app, &owner, ws, payload).await;

    let pages = pull_pages(&app, &owner.token, ws, client, &before).await;
    assert!(pages.len() >= 5, "{} pages", pages.len());
    assert!(
        pages[0]["more"] == true && cursor_of(&pages[0]).split(':').count() == 4,
        "the first page ends inside the transaction: {}",
        cursor_of(&pages[0])
    );
    let last = pages.last().unwrap();
    assert_eq!(last["last_mutation_id"], 0);
    assert_eq!(cursor_of(last).split(':').count(), 3);

    let delivered = paged_records(&pages);
    assert_eq!(
        delivered,
        changed_since(&store, ws, owner.profile.id, cursor_xmax(&before)).await
    );
    let issues = paged_entity(&pages, "issues");
    for id in &issue_ids {
        let record = issues
            .get(id.as_str())
            .unwrap_or_else(|| panic!("issue {id} never delivered"));
        assert!(!record.is_null(), "issue {id} arrived as deleted");
    }

    drop(app);
    store.pool.close().await;
    database.cleanup().await;
}

#[tokio::test]
async fn pull_acknowledges_a_pushed_mutation_on_the_final_page_only() {
    let database = support::TestDatabase::new().await;
    let store = Store::connect(&database.url).await.unwrap();
    let app = router(store.clone());
    let owner = account(&store, "owner").await;
    let (ws, team) = setup(&app, &owner).await;
    let client = Uuid::new_v4();

    let payload = bulk_issues(team, 0, 500);
    let issue_ids: Vec<String> = payload
        .iter()
        .map(|issue| issue["id"].as_str().unwrap().to_owned())
        .collect();
    import_issues(&app, &owner, ws, payload).await;
    let done: Uuid =
        sqlx::query_scalar("SELECT id FROM stages WHERE team_id = $1 AND kind = 'done' LIMIT 1")
            .bind(team)
            .fetch_one(&store.pool)
            .await
            .unwrap();

    let before = cursor_of(&pull_ok(&app, &owner.token, ws, client, None).await);
    let (status, result) = push(
        &app,
        &owner.token,
        ws,
        client,
        vec![mutation(
            1,
            "bulk_issues",
            json!({"ids": issue_ids, "action": {"update": {"stage_id": done}}}),
        )],
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{result}");
    assert_eq!(result["results"][0]["status"], "applied", "{result}");

    let changed = changed_since(&store, ws, owner.profile.id, cursor_xmax(&before)).await;
    assert!(
        changed.len() > 1000,
        "the mutation must outgrow one page, changed {}",
        changed.len()
    );

    let pages = pull_pages(&app, &owner.token, ws, client, &before).await;
    assert!(pages.len() >= 2);
    assert_eq!(pages.last().unwrap()["last_mutation_id"], 1);
    assert_eq!(paged_records(&pages), changed);
    let issues = paged_entity(&pages, "issues");
    for id in &issue_ids {
        let record = issues
            .get(id.as_str())
            .unwrap_or_else(|| panic!("issue {id} never delivered"));
        assert_eq!(record["stage_id"], done.to_string(), "issue {id}");
    }

    drop(app);
    store.pool.close().await;
    database.cleanup().await;
}

#[tokio::test]
async fn pull_resumes_a_partial_transaction_listed_in_the_cursor_xip() {
    let database = support::TestDatabase::new().await;
    let store = Store::connect(&database.url).await.unwrap();
    let app = router(store.clone());
    let owner = account(&store, "owner").await;
    let (ws, _) = setup(&app, &owner).await;
    let client = Uuid::new_v4();
    let ids: Vec<Uuid> = (0..1500).map(|_| Uuid::new_v4()).collect();

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
    .bind(&ids)
    .execute(&mut *tx)
    .await
    .unwrap();
    // Move xmax past the open transaction, so the cursor lists it in xip.
    sqlx::query("SELECT pg_current_xact_id()")
        .execute(&store.pool)
        .await
        .unwrap();
    let before = cursor_of(&pull_ok(&app, &owner.token, ws, client, None).await);
    assert!(cursor_xmax(&before) > txid);
    tx.commit().await.unwrap();

    let first = pull_ok(&app, &owner.token, ws, client, Some(&before)).await;
    assert_eq!(first["reset"], false);
    assert_eq!(first["more"], true);
    assert_eq!(first["last_mutation_id"], Value::Null);
    assert_eq!(first["changes"].as_array().unwrap().len(), 1000);
    let cursor = cursor_of(&first);
    let parts: Vec<&str> = cursor.split(':').collect();
    assert!(parts[2].split(',').any(|x| x == txid.to_string()));
    assert!(parts[3].starts_with(&format!("{txid}.")), "{cursor}");

    // A later transaction lands while the client holds half of the first.
    let late = Uuid::new_v4();
    sqlx::query("INSERT INTO changes(workspace_id, entity, entity_id) VALUES($1, 'issues', $2)")
        .bind(ws)
        .bind(late)
        .execute(&store.pool)
        .await
        .unwrap();

    let pages = pull_pages(&app, &owner.token, ws, client, &cursor).await;
    assert_eq!(pages.len(), 1);
    let mut delivered = paged_records(&[first]);
    delivered.extend(paged_records(&pages));
    let expected: std::collections::BTreeSet<_> = ids
        .iter()
        .chain([&late])
        .map(|id| ("issues".to_owned(), id.to_string()))
        .collect();
    assert_eq!(delivered, expected);
    assert_eq!(pages[0]["changes"].as_array().unwrap().len(), 501);
    assert_eq!(pages[0]["last_mutation_id"], 0);

    drop(app);
    store.pool.close().await;
    database.cleanup().await;
}

async fn mark_issues(conn: &mut sqlx::PgConnection, workspace: Uuid, ids: &[Uuid]) -> i64 {
    sqlx::query(
        "INSERT INTO changes(workspace_id, entity, entity_id) \
         SELECT $1, 'issues', id FROM unnest($2::uuid[]) AS t(id)",
    )
    .bind(workspace)
    .bind(ids)
    .execute(&mut *conn)
    .await
    .unwrap();
    sqlx::query_scalar("SELECT pg_current_xact_id()::text::bigint")
        .fetch_one(&mut *conn)
        .await
        .unwrap()
}

#[tokio::test]
async fn pull_redelivers_a_displaced_partial_when_a_lower_transaction_commits() {
    let database = support::TestDatabase::new().await;
    let store = Store::connect(&database.url).await.unwrap();
    let app = router(store.clone());
    let owner = account(&store, "owner").await;
    let (ws, _) = setup(&app, &owner).await;
    let client = Uuid::new_v4();
    let a_ids: Vec<Uuid> = (0..1500).map(|_| Uuid::new_v4()).collect();
    let b_ids: Vec<Uuid> = (0..1500).map(|_| Uuid::new_v4()).collect();

    let before = cursor_of(&pull_ok(&app, &owner.token, ws, client, None).await);

    let mut a = store.pool.begin().await.unwrap();
    let a_txid = mark_issues(&mut a, ws, &a_ids).await;
    let mut b = store.pool.begin().await.unwrap();
    let b_txid = mark_issues(&mut b, ws, &b_ids).await;
    b.commit().await.unwrap();
    assert!(a_txid < b_txid);

    let first = pull_ok(&app, &owner.token, ws, client, Some(&before)).await;
    assert_eq!(first["reset"], false);
    assert_eq!(first["more"], true);
    assert_eq!(first["last_mutation_id"], Value::Null);
    let first_cursor = cursor_of(&first);
    let parts: Vec<&str> = first_cursor.split(':').collect();
    assert!(parts[2].split(',').any(|x| x == a_txid.to_string()));
    assert!(
        parts[3].starts_with(&format!("{b_txid}.")),
        "the first page ends inside B: {first_cursor}"
    );
    let a_set: std::collections::BTreeSet<_> = a_ids
        .iter()
        .map(|id| ("issues".to_owned(), id.to_string()))
        .collect();
    assert!(paged_records(std::slice::from_ref(&first)).is_disjoint(&a_set));

    a.commit().await.unwrap();

    let pages = pull_pages(&app, &owner.token, ws, client, &first_cursor).await;
    assert!(
        cursor_of(&pages[0])
            .split(':')
            .nth(3)
            .is_some_and(|partial| partial.starts_with(&format!("{a_txid}."))),
        "A's partial displaces B's: {}",
        cursor_of(&pages[0])
    );
    let mut all = vec![first];
    all.extend(pages);
    let delivered = paged_records(&all);
    assert_eq!(
        delivered,
        changed_since(&store, ws, owner.profile.id, cursor_xmax(&before)).await
    );
    assert_eq!(delivered.len(), 3000);
    let sent: usize = all
        .iter()
        .map(|page| page["changes"].as_array().unwrap().len())
        .sum();
    assert!(sent > delivered.len(), "B's displaced rows arrive again");
    assert_eq!(all.last().unwrap()["last_mutation_id"], 0);

    drop(app);
    store.pool.close().await;
    database.cleanup().await;
}

/// The `(txid, row)` a cursor names as its partial transaction.
fn partial_of(cursor: &str) -> Option<(i64, i64)> {
    let (txid, row) = cursor.split(':').nth(3)?.split_once('.')?;
    Some((txid.parse().unwrap(), row.parse().unwrap()))
}

async fn rows_between(store: &Store, txid: i64, after: i64, upto: i64) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM changes WHERE txid = $1 AND id > $2 AND id <= $3")
        .bind(txid)
        .bind(after)
        .bind(upto)
        .fetch_one(&store.pool)
        .await
        .unwrap()
}

#[tokio::test]
async fn pull_row_cap_cuts_inside_the_first_transaction_across_batches() {
    let database = support::TestDatabase::new().await;
    let store = Store::connect(&database.url).await.unwrap();
    let app = router(store.clone());
    let owner = account(&store, "owner").await;
    let (ws, _) = setup(&app, &owner).await;
    let client = Uuid::new_v4();
    let before = cursor_of(&pull_ok(&app, &owner.token, ws, client, None).await);
    let first = Uuid::new_v4();
    let second = Uuid::new_v4();

    // Role rows do not count toward the page's record limit, so one
    // transaction can pass the row cap while staying one record.
    let mut tx = store.pool.begin().await.unwrap();
    sqlx::query(
        "INSERT INTO changes(workspace_id, entity, entity_id) \
         SELECT $1, 'roles', $2 FROM generate_series(1, 20005)",
    )
    .bind(ws)
    .bind(Uuid::new_v4())
    .execute(&mut *tx)
    .await
    .unwrap();
    let txid = mark_issues(&mut tx, ws, &[first]).await;
    tx.commit().await.unwrap();
    let mut conn = store.pool.acquire().await.unwrap();
    mark_issues(&mut conn, ws, &[second]).await;
    drop(conn);

    let pages = pull_pages(&app, &owner.token, ws, client, &before).await;
    assert_eq!(pages.len(), 2);
    let (cut_txid, row) = partial_of(&cursor_of(&pages[0])).expect("the first page cuts inside");
    assert_eq!(cut_txid, txid);
    assert_eq!(rows_between(&store, txid, 0, row).await, 20_000);
    assert!(pages[0]["changes"].as_array().unwrap().is_empty());
    assert_eq!(
        record(&pages[1]["changes"], "issues", &first.to_string()),
        Some(&Value::Null)
    );
    assert_eq!(
        paged_records(&pages),
        changed_since(&store, ws, owner.profile.id, cursor_xmax(&before)).await
    );
    assert_eq!(paged_records(&pages).len(), 2);

    drop(app);
    store.pool.close().await;
    database.cleanup().await;
}

#[tokio::test]
async fn pull_scans_a_bounded_number_of_rows_in_a_transaction_of_repeats() {
    let database = support::TestDatabase::new().await;
    let store = Store::connect(&database.url).await.unwrap();
    let app = router(store.clone());
    let owner = account(&store, "owner").await;
    let (ws, _) = setup(&app, &owner).await;
    let client = Uuid::new_v4();
    let before = cursor_of(&pull_ok(&app, &owner.token, ws, client, None).await);

    let hot = Uuid::new_v4();
    let others: Vec<Uuid> = (0..3).map(|_| Uuid::new_v4()).collect();
    let mut tx = store.pool.begin().await.unwrap();
    mark_repeatedly(&mut tx, ws, hot, 45_000).await;
    mark_all(&mut tx, ws, &others).await;
    mark_repeatedly(&mut tx, ws, hot, 5).await;
    let txid: i64 = sqlx::query_scalar("SELECT pg_current_xact_id()::text::bigint")
        .fetch_one(&mut *tx)
        .await
        .unwrap();
    tx.commit().await.unwrap();

    let pages = pull_pages(&app, &owner.token, ws, client, &before).await;
    assert_eq!(pages.len(), 3);
    let mut after = 0;
    for page in &pages[..2] {
        let (cut_txid, row) = partial_of(&cursor_of(page)).expect("the page cuts inside");
        assert_eq!(cut_txid, txid);
        assert!(row > after, "the cursor advances every page");
        assert_eq!(rows_between(&store, txid, after, row).await, 20_000);
        assert_eq!(page_pairs(page).len(), 1, "repeats collapse across batches");
        after = row;
    }
    let last = pages.last().unwrap();
    assert_eq!(page_pairs(last).len(), 4);
    assert_eq!(last["last_mutation_id"], 0);
    assert_eq!(cursor_of(last).split(':').count(), 3);
    let delivered = paged_records(&pages);
    assert_eq!(
        delivered,
        changed_since(&store, ws, owner.profile.id, cursor_xmax(&before)).await
    );
    assert_eq!(delivered.len(), 4);

    drop(app);
    store.pool.close().await;
    database.cleanup().await;
}

#[tokio::test]
async fn pull_defers_an_oversized_transaction_that_follows_others() {
    let database = support::TestDatabase::new().await;
    let store = Store::connect(&database.url).await.unwrap();
    let app = router(store.clone());
    let owner = account(&store, "owner").await;
    let (ws, _) = setup(&app, &owner).await;
    let client = Uuid::new_v4();
    let before = cursor_of(&pull_ok(&app, &owner.token, ws, client, None).await);

    let small: Vec<Uuid> = (0..3).map(|_| Uuid::new_v4()).collect();
    let mut conn = store.pool.acquire().await.unwrap();
    mark_issues(&mut conn, ws, &small).await;
    drop(conn);
    let hot = Uuid::new_v4();
    let mut tx = store.pool.begin().await.unwrap();
    mark_repeatedly(&mut tx, ws, hot, 25_000).await;
    let txid: i64 = sqlx::query_scalar("SELECT pg_current_xact_id()::text::bigint")
        .fetch_one(&mut *tx)
        .await
        .unwrap();
    tx.commit().await.unwrap();

    let pages = pull_pages(&app, &owner.token, ws, client, &before).await;
    assert_eq!(pages.len(), 3);
    assert_eq!(
        page_pairs(&pages[0]).len(),
        3,
        "the small transaction goes first"
    );
    assert!(
        partial_of(&cursor_of(&pages[0])).is_none(),
        "the oversized one waits whole: {}",
        cursor_of(&pages[0])
    );
    let (cut_txid, row) = partial_of(&cursor_of(&pages[1])).expect("then it spans pages");
    assert_eq!(cut_txid, txid);
    assert_eq!(rows_between(&store, txid, 0, row).await, 20_000);
    assert_eq!(page_pairs(&pages[1]), page_pairs(&pages[2]));
    assert_eq!(pages[2]["last_mutation_id"], 0);
    assert_eq!(
        paged_records(&pages),
        changed_since(&store, ws, owner.profile.id, cursor_xmax(&before)).await
    );

    drop(app);
    store.pool.close().await;
    database.cleanup().await;
}

#[tokio::test]
async fn pull_partial_transaction_that_was_pruned_resets() {
    let database = support::TestDatabase::new().await;
    let store = Store::connect(&database.url).await.unwrap();
    let app = router(store.clone());
    let owner = account(&store, "owner").await;
    let (ws, team) = setup(&app, &owner).await;
    let client = Uuid::new_v4();

    let before = cursor_of(&pull_ok(&app, &owner.token, ws, client, None).await);
    import_issues(&app, &owner, ws, bulk_issues(team, 0, 1500)).await;
    let first = pull_ok(&app, &owner.token, ws, client, Some(&before)).await;
    assert_eq!(first["more"], true);
    let cursor = cursor_of(&first);
    assert_eq!(cursor.split(':').count(), 4, "{cursor}");

    sqlx::query(
        "UPDATE changes SET created_at = now() - interval '2 days' WHERE workspace_id = $1",
    )
    .bind(ws)
    .execute(&store.pool)
    .await
    .unwrap();
    assert!(store.prune_changes(1).await.unwrap() > 0);

    let page = pull_ok(&app, &owner.token, ws, client, Some(&cursor)).await;
    assert_eq!(page["reset"], true);
    assert_eq!(page["more"], false);
    assert_eq!(page["changes"], json!([]));
    assert_eq!(page["last_mutation_id"], Value::Null);

    drop(app);
    store.pool.close().await;
    database.cleanup().await;
}

#[tokio::test]
async fn pull_role_change_in_a_large_transaction_resets_on_the_first_page() {
    let database = support::TestDatabase::new().await;
    let store = Store::connect(&database.url).await.unwrap();
    let app = router(store.clone());
    let owner = account(&store, "owner").await;
    let member = account(&store, "member").await;
    let (ws, _) = setup(&app, &owner).await;
    invite_member(&app, &owner, ws, &member).await;
    let client = Uuid::new_v4();
    let ids: Vec<Uuid> = (0..1500).map(|_| Uuid::new_v4()).collect();

    let before = cursor_of(&pull_ok(&app, &member.token, ws, client, None).await);
    let mut tx = store.pool.begin().await.unwrap();
    sqlx::query(
        "INSERT INTO changes(workspace_id, entity, entity_id) \
         SELECT $1, 'issues', id FROM unnest($2::uuid[]) AS t(id)",
    )
    .bind(ws)
    .bind(&ids)
    .execute(&mut *tx)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO changes(workspace_id, entity, entity_id, user_id) VALUES($1, 'roles', $2, $2)",
    )
    .bind(ws)
    .bind(member.profile.id)
    .execute(&mut *tx)
    .await
    .unwrap();
    tx.commit().await.unwrap();

    // The role check covers the whole window on every page, so the client
    // never receives part of a transaction it must discard.
    let page = pull_ok(&app, &member.token, ws, client, Some(&before)).await;
    assert_eq!(page["reset"], true);
    assert_eq!(page["changes"], json!([]));

    drop(app);
    store.pool.close().await;
    database.cleanup().await;
}

async fn mark_repeatedly(conn: &mut sqlx::PgConnection, workspace: Uuid, record: Uuid, times: i32) {
    sqlx::query("SELECT mark_change($1, 'issues', $2) FROM generate_series(1, $3)")
        .bind(workspace)
        .bind(record)
        .bind(times)
        .execute(&mut *conn)
        .await
        .unwrap();
}

async fn mark_all(conn: &mut sqlx::PgConnection, workspace: Uuid, ids: &[Uuid]) {
    sqlx::query("SELECT mark_change($1, 'issues', id) FROM unnest($2::uuid[]) AS t(id)")
        .bind(workspace)
        .bind(ids)
        .execute(&mut *conn)
        .await
        .unwrap();
}

fn page_pairs(page: &Value) -> Vec<(String, String)> {
    page["changes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|change| {
            (
                change["entity"].as_str().unwrap().to_owned(),
                change["id"].as_str().unwrap().to_owned(),
            )
        })
        .collect()
}

#[tokio::test]
async fn pull_renders_a_record_updated_many_times_once() {
    let database = support::TestDatabase::new().await;
    let store = Store::connect(&database.url).await.unwrap();
    let app = router(store.clone());
    let owner = account(&store, "owner").await;
    let (ws, _) = setup(&app, &owner).await;
    let client = Uuid::new_v4();
    let before = cursor_of(&pull_ok(&app, &owner.token, ws, client, None).await);

    let hot = Uuid::new_v4();
    let others: Vec<Uuid> = (0..1500).map(|_| Uuid::new_v4()).collect();
    let mut tx = store.pool.begin().await.unwrap();
    mark_repeatedly(&mut tx, ws, hot, 50).await;
    mark_all(&mut tx, ws, &others).await;
    mark_repeatedly(&mut tx, ws, hot, 50).await;
    tx.commit().await.unwrap();
    let rows: i64 =
        sqlx::query_scalar("SELECT count(*) FROM changes WHERE workspace_id = $1 AND txid >= $2")
            .bind(ws)
            .bind(cursor_xmax(&before))
            .fetch_one(&store.pool)
            .await
            .unwrap();
    assert_eq!(rows, 1600, "mark_change writes a row per call");

    let pages = pull_pages(&app, &owner.token, ws, client, &before).await;
    assert_eq!(pages.len(), 2);
    for (n, page) in pages.iter().enumerate() {
        let pairs = page_pairs(page);
        let distinct: std::collections::BTreeSet<_> = pairs.iter().collect();
        assert_eq!(distinct.len(), pairs.len(), "page {n} repeats a record");
    }
    assert_eq!(pages[0]["changes"].as_array().unwrap().len(), 1000);
    // The cut falls inside the transaction, so the second run of `hot` is
    // read again on page 2. Rendering it twice is harmless.
    assert!(record(&pages[0]["changes"], "issues", &hot.to_string()).is_some());
    assert!(record(&pages[1]["changes"], "issues", &hot.to_string()).is_some());
    assert_eq!(
        paged_records(&pages),
        changed_since(&store, ws, owner.profile.id, cursor_xmax(&before)).await
    );
    assert_eq!(paged_records(&pages).len(), 1501);

    drop(app);
    store.pool.close().await;
    database.cleanup().await;
}

#[tokio::test]
async fn pull_delivers_exactly_the_changed_set_when_repeats_precede_the_cut() {
    let database = support::TestDatabase::new().await;
    let store = Store::connect(&database.url).await.unwrap();
    let app = router(store.clone());
    let owner = account(&store, "owner").await;
    let (ws, _) = setup(&app, &owner).await;
    let client = Uuid::new_v4();
    let before = cursor_of(&pull_ok(&app, &owner.token, ws, client, None).await);

    let hot = Uuid::new_v4();
    let others: Vec<Uuid> = (0..1500).map(|_| Uuid::new_v4()).collect();
    let mut tx = store.pool.begin().await.unwrap();
    mark_repeatedly(&mut tx, ws, hot, 50).await;
    mark_all(&mut tx, ws, &others).await;
    tx.commit().await.unwrap();

    let pages = pull_pages(&app, &owner.token, ws, client, &before).await;
    let delivered: usize = pages.iter().map(|page| page_pairs(page).len()).sum();
    let changed = changed_since(&store, ws, owner.profile.id, cursor_xmax(&before)).await;
    assert_eq!(changed.len(), 1501);
    assert_eq!(delivered, changed.len());
    assert_eq!(paged_records(&pages), changed);

    drop(app);
    store.pool.close().await;
    database.cleanup().await;
}

#[tokio::test]
async fn mark_change_keeps_a_private_and_a_shared_mark_of_one_record() {
    let database = support::TestDatabase::new().await;
    let store = Store::connect(&database.url).await.unwrap();
    let ws = Uuid::new_v4();
    let view = Uuid::new_v4();
    let owner = Uuid::new_v4();

    let mut tx = store.pool.begin().await.unwrap();
    for user in [Some(owner), None] {
        sqlx::query("SELECT mark_change($1, 'views', $2, $3)")
            .bind(ws)
            .bind(view)
            .bind(user)
            .execute(&mut *tx)
            .await
            .unwrap();
    }
    sqlx::query("SELECT mark_change(NULL, 'issues', $1), mark_change($2, 'issues', NULL)")
        .bind(view)
        .bind(ws)
        .execute(&mut *tx)
        .await
        .unwrap();
    tx.commit().await.unwrap();

    let rows: Vec<(String, Option<Uuid>)> = sqlx::query_as(
        "SELECT entity, user_id FROM changes WHERE workspace_id = $1 ORDER BY user_id NULLS LAST",
    )
    .bind(ws)
    .fetch_all(&store.pool)
    .await
    .unwrap();
    assert_eq!(
        rows,
        vec![
            ("views".to_owned(), Some(owner)),
            ("views".to_owned(), None)
        ],
        "the workspace-wide mark survives the private one, and null arguments write nothing"
    );

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
    invite_member(&app, &owner, ws, &alice).await;
    invite_member(&app, &owner, ws, &bob).await;
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
    invite_member(&app, &owner, ws, &alice).await;
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
        // Partial transactions: malformed, outside the window, or from the future.
        "99:105:99:".to_owned(),
        "99:105:99:99".to_owned(),
        "99:105:99:99.".to_owned(),
        "99:105:99:.5".to_owned(),
        "99:105:99:99.0".to_owned(),
        "99:105:99:99.1.2".to_owned(),
        "99:105:99:99,1".to_owned(),
        "99:105:99:+99.1".to_owned(),
        "99:105:99:99.-1".to_owned(),
        "99:105:99:99.1:1".to_owned(),
        "99:105:99:100.1".to_owned(),
        "99:105:99:98.1".to_owned(),
        "99:105:99:99999999.1".to_owned(),
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
    invite_member(&app, &owner, ws, &member).await;
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

#[tokio::test]
async fn project_plan_syncs_and_survives_update_project() {
    let database = support::TestDatabase::new().await;
    let store = Store::connect(&database.url).await.unwrap();
    let app = router(store.clone());
    let owner = account(&store, "owner").await;
    let stranger = account(&store, "stranger").await;
    let (ws, team) = setup(&app, &owner).await;
    let client = Uuid::new_v4();
    let project = created(
        &app,
        &owner,
        ws,
        json!({"type": "create_project", "name": "Launch", "team_ids": [team]}),
    )
    .await;
    let before = cursor_of(&pull_ok(&app, &owner.token, ws, client, None).await);
    let plan = json!({
        "id": project,
        "lead_id": owner.profile.id,
        "status": "in_progress",
        "health": "on_track",
        "start_date": "2026-11-01",
        "target_date": "2026-12-15",
    });
    let mut backwards = plan.clone();
    backwards["start_date"] = json!("2027-01-01");
    let mut outsider = plan.clone();
    outsider["lead_id"] = json!(stranger.profile.id);

    let (status, result) = push(
        &app,
        &owner.token,
        ws,
        client,
        vec![
            mutation(1, "set_project_plan", backwards),
            mutation(2, "set_project_plan", outsider),
            mutation(3, "set_project_plan", plan),
            mutation(
                4,
                "update_project",
                json!({"id": project, "name": "Relaunch", "description": "", "team_ids": [team]}),
            ),
        ],
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{result}");
    assert_eq!(result["results"][0]["error"]["status"], 400, "{result}");
    assert_eq!(result["results"][1]["error"]["status"], 403, "{result}");
    assert_eq!(result["results"][2]["status"], "applied", "{result}");
    assert_eq!(result["results"][3]["status"], "applied", "{result}");

    let page = pull_ok(&app, &owner.token, ws, client, Some(&before)).await;
    let record = record(&page["changes"], "projects", &project.to_string()).unwrap();
    assert_eq!(record["name"], "Relaunch", "{record}");
    assert_eq!(record["lead_id"], json!(owner.profile.id));
    assert_eq!(record["status"], "in_progress");
    assert_eq!(record["health"], "on_track");
    assert_eq!(record["start_date"], "2026-11-01");
    assert_eq!(record["target_date"], "2026-12-15");
    assert_eq!(record["version"], 3);

    drop(app);
    store.pool.close().await;
    database.cleanup().await;
}

async fn max_change_id(store: &Store) -> i64 {
    sqlx::query_scalar("SELECT COALESCE(max(id), 0) FROM changes")
        .fetch_one(&store.pool)
        .await
        .unwrap()
}

async fn issue_change_rows(store: &Store, issue: Uuid, after: i64) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM changes WHERE entity_id = $1 AND id > $2")
        .bind(issue)
        .bind(after)
        .fetch_one(&store.pool)
        .await
        .unwrap()
}

/// Row versions of the issue's links, so a rewritten link shows as a new xmin.
async fn link_versions(store: &Store, issue: Uuid) -> Vec<(String, String, String)> {
    sqlx::query_as(
        "SELECT 'label', label_id::text, xmin::text FROM issue_labels WHERE issue_id = $1 \
         UNION ALL \
         SELECT 'dependency', dependency_id::text, xmin::text FROM issue_dependencies \
         WHERE issue_id = $1 ORDER BY 1, 2",
    )
    .bind(issue)
    .fetch_all(&store.pool)
    .await
    .unwrap()
}

async fn update_fields(store: &Store, issue: Uuid) -> Vec<String> {
    let fields: String = sqlx::query_scalar(
        "SELECT fields::text FROM activity WHERE entity_id = $1 AND action = 'update_issue' \
         ORDER BY at DESC, id DESC LIMIT 1",
    )
    .bind(issue)
    .fetch_one(&store.pool)
    .await
    .unwrap();
    serde_json::from_str(&fields).unwrap()
}

#[tokio::test]
async fn saving_an_issue_writes_only_the_links_that_changed() {
    let database = support::TestDatabase::new().await;
    let store = Store::connect(&database.url).await.unwrap();
    let app = router(store.clone());
    let owner = account(&store, "owner").await;
    let (ws, team) = setup(&app, &owner).await;
    let label = |name: &'static str| {
        let (app, owner) = (&app, &owner);
        async move {
            created(
                app,
                owner,
                ws,
                json!({"type": "create_label", "name": name, "color": "#000000"}),
            )
            .await
        }
    };
    let (red, blue) = (label("red").await, label("blue").await);
    let issue_titled = |title: &'static str| json!({"team_id": team, "title": title});
    let first_dep = created(
        &app,
        &owner,
        ws,
        json!({"type": "create_issue", "input": issue_titled("First dependency")}),
    )
    .await;
    let second_dep = created(
        &app,
        &owner,
        ws,
        json!({"type": "create_issue", "input": issue_titled("Second dependency")}),
    )
    .await;
    let issue = created(
        &app,
        &owner,
        ws,
        json!({"type": "create_issue", "input": {
            "team_id": team, "title": "Linked", "labels": [red], "dependencies": [first_dep]
        }}),
    )
    .await;
    let update = |patch: Value| {
        let (app, owner) = (&app, &owner);
        let store = &store;
        async move {
            let after = max_change_id(store).await;
            let (status, result) = command(
                app,
                owner,
                ws,
                json!({"type": "update_issue", "id": issue, "patch": patch}),
            )
            .await;
            assert_eq!(status, StatusCode::OK, "{result}");
            issue_change_rows(store, issue, after).await
        }
    };

    let baseline = update(json!({"title": "Retitled"})).await;
    assert_eq!(update_fields(&store, issue).await, ["title"]);
    let stored = link_versions(&store, issue).await;
    assert_eq!(stored.len(), 2);

    let unchanged = update(json!({
        "title": "Retitled again", "labels": [red], "dependencies": [first_dep]
    }))
    .await;
    assert_eq!(unchanged, baseline, "unchanged links write no change rows");
    assert_eq!(update_fields(&store, issue).await, ["title"]);
    assert_eq!(link_versions(&store, issue).await, stored);

    let added = update(json!({"labels": {"add": [blue]}})).await;
    assert_eq!(update_fields(&store, issue).await, ["labels"]);
    assert_eq!(added, baseline + 1, "one inserted link, one change row");
    let after_add = link_versions(&store, issue).await;
    assert_eq!(after_add.len(), 3);
    assert!(
        stored.iter().all(|link| after_add.contains(link)),
        "the existing links were left alone"
    );

    let removed = update(json!({"labels": {"remove": [blue]}})).await;
    assert_eq!(removed, baseline + 1, "one deleted link, one change row");
    assert_eq!(link_versions(&store, issue).await, stored);

    let more_deps = update(json!({"dependencies": [first_dep, second_dep]})).await;
    assert_eq!(update_fields(&store, issue).await, ["dependencies"]);
    assert_eq!(more_deps, baseline + 1);
    let fewer_deps = update(json!({"dependencies": [second_dep]})).await;
    assert_eq!(fewer_deps, baseline + 1);
    let swapped = link_versions(&store, issue).await;
    let dependencies: Vec<&str> = swapped
        .iter()
        .filter(|link| link.0 == "dependency")
        .map(|link| link.1.as_str())
        .collect();
    assert_eq!(dependencies, [second_dep.to_string()]);
    let labels: Vec<&str> = swapped
        .iter()
        .filter(|link| link.0 == "label")
        .map(|link| link.1.as_str())
        .collect();
    assert_eq!(labels, [red.to_string()]);

    drop(app);
    store.pool.close().await;
    database.cleanup().await;
}

async fn row_versions(store: &Store, sql: &str, parent: Uuid) -> Vec<(String, String)> {
    sqlx::query_as(sql)
        .bind(parent)
        .fetch_all(&store.pool)
        .await
        .unwrap()
}

#[tokio::test]
async fn replacing_team_members_and_mentions_writes_only_the_difference() {
    let database = support::TestDatabase::new().await;
    let store = Store::connect(&database.url).await.unwrap();
    let app = router(store.clone());
    let owner = account(&store, "owner").await;
    let member = account(&store, "member").await;
    let (ws, team) = setup(&app, &owner).await;
    invite_member(&app, &owner, ws, &member).await;
    let run = |cmd: Value| {
        let (app, owner) = (&app, &owner);
        async move {
            let (status, result) = command(app, owner, ws, cmd).await;
            assert_eq!(status, StatusCode::OK, "{result}");
        }
    };

    let members_sql =
        "SELECT user_id::text, xmin::text FROM team_members WHERE team_id = $1 ORDER BY 1";
    let owner_only = row_versions(&store, members_sql, team).await;
    assert_eq!(owner_only.len(), 1);
    let both = json!([owner.profile.id, member.profile.id]);
    run(json!({"type": "set_team_members", "id": team, "members": both})).await;
    let with_member = row_versions(&store, members_sql, team).await;
    assert_eq!(with_member.len(), 2);
    assert!(
        with_member.contains(&owner_only[0]),
        "the owner's row was left alone"
    );
    run(json!({"type": "set_team_members", "id": team, "members": both})).await;
    assert_eq!(row_versions(&store, members_sql, team).await, with_member);
    run(json!({"type": "set_team_members", "id": team, "members": [owner.profile.id]})).await;
    assert_eq!(row_versions(&store, members_sql, team).await, owner_only);

    let issue = created(
        &app,
        &owner,
        ws,
        json!({"type": "create_issue", "input": {"team_id": team, "title": "Discussed"}}),
    )
    .await;
    let comment = created(
        &app,
        &owner,
        ws,
        json!({"type": "add_comment", "issue_id": issue, "body": "Hello", "mentions": [member.profile.id]}),
    )
    .await;
    let mentions_sql =
        "SELECT user_id::text, xmin::text FROM comment_mentions WHERE comment_id = $1 ORDER BY 1";
    let mentioned = row_versions(&store, mentions_sql, comment).await;
    assert_eq!(mentioned.len(), 1);
    run(json!({"type": "edit_comment", "id": comment, "body": "Hello again", "mentions": [member.profile.id]})).await;
    assert_eq!(row_versions(&store, mentions_sql, comment).await, mentioned);
    run(json!({"type": "edit_comment", "id": comment, "body": "Nobody", "mentions": []})).await;
    assert!(row_versions(&store, mentions_sql, comment).await.is_empty());
    run(json!({"type": "edit_comment", "id": comment, "body": "Again", "mentions": [member.profile.id]})).await;
    assert_eq!(row_versions(&store, mentions_sql, comment).await.len(), 1);

    drop(app);
    store.pool.close().await;
    database.cleanup().await;
}
