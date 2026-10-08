mod support;

use std::sync::OnceLock;

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

// Sync pull cursors are global snapshot xmins, so a long import in one
// test pins the xmin every other test observes. Serializing this file keeps
// a 600-issue transaction from making another test's starting cursor predate
// its own setup (which would spuriously include an own-membership change
// and reset).
static TEST_LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();

async fn lock() -> tokio::sync::MutexGuard<'static, ()> {
    TEST_LOCK
        .get_or_init(|| tokio::sync::Mutex::new(()))
        .lock()
        .await
}

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
        "/api/workspaces",
        Some(&owner.token),
        Some(json!({"name": name})),
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
        json!({"type": "create_team", "name": "Team", "members": [owner.profile.id]}),
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
        &format!("/api/workspaces/{workspace}/commands"),
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
        &format!("/api/workspaces/{workspace}/sync/push"),
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
        &format!("/api/workspaces/{workspace}/sync/pull{query}"),
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
        &format!("/api/workspaces/{workspace}/invitations/accept"),
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
    let _guard = lock().await;
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
    assert_eq!(start["last_mutation_id"], 0);
    let before = start["cursor"].as_str().unwrap().to_owned();

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
        &format!("/api/workspaces/{ws}/issues/{issue}"),
        Some(&owner.token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{detail}");
    assert_eq!(pulled["title"], detail["title"]);
    assert_eq!(pulled["team_id"], detail["team_id"]);

    let cursor = page["cursor"].as_str().unwrap().to_owned();
    let quiet = pull_ok(&app, &owner.token, ws, client, Some(&cursor)).await;
    assert_eq!(quiet["changes"], json!([]));
    assert_eq!(quiet["more"], false);
    assert_eq!(quiet["reset"], false);

    drop(app);
    store.pool.close().await;
    database.cleanup().await;
}

#[tokio::test]
async fn pull_deleted_and_unvisible_return_null() {
    let _guard = lock().await;
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
    let after_create = pull_ok(&app, &colleague.token, ws, colleague_client, None).await["cursor"]
        .as_str()
        .unwrap()
        .to_owned();

    // Deleting it returns null to a pull from before the delete.
    let before_delete = pull_ok(&app, &owner.token, ws, owner_client, None).await["cursor"]
        .as_str()
        .unwrap()
        .to_owned();
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
    let cursor = pull_ok(&app, &colleague.token, ws, colleague_client, None).await["cursor"]
        .as_str()
        .unwrap()
        .to_owned();
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
    let _guard = lock().await;
    let database = support::TestDatabase::new().await;
    let store = Store::connect(&database.url).await.unwrap();
    let app = router(store.clone());
    let owner = account(&store, "owner").await;
    let colleague = account(&store, "colleague").await;
    let (ws, team) = setup(&app, &owner).await;
    invite_member(&app, &store, &owner, ws, &colleague).await;
    let owner_client = Uuid::new_v4();
    let colleague_client = Uuid::new_v4();

    let owner_before = pull_ok(&app, &owner.token, ws, owner_client, None).await["cursor"]
        .as_str()
        .unwrap()
        .to_owned();
    let colleague_before =
        pull_ok(&app, &colleague.token, ws, colleague_client, None).await["cursor"]
            .as_str()
            .unwrap()
            .to_owned();

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
    let issue = created(
        &app,
        &owner,
        ws,
        json!({"type": "create_issue", "input": {"team_id": team, "title": "Assigned", "assignee": colleague.profile.id}}),
    )
    .await;
    let _ = issue;
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

    // Demote the colleague to a plain member for the admin check.
    let (status, result) = command(
        &app,
        &owner,
        ws,
        json!({"type": "set_role", "user_id": colleague.profile.id, "role": "member"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{result}");

    // Fresh cursors so the role change itself does not force a reset for
    // the colleague check below; the admin rows are still in the window.
    let member_cursor = pull_ok(&app, &colleague.token, ws, colleague_client, None).await["cursor"]
        .as_str()
        .unwrap()
        .to_owned();
    // The colleague's own role change is in every window from before, so a
    // pull from the old cursor resets. Use a cursor taken after it.
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
    let _ = member_cursor;

    drop(app);
    store.pool.close().await;
    database.cleanup().await;
}

#[tokio::test]
async fn pull_member_sees_admin_entities_as_null() {
    let _guard = lock().await;
    let database = support::TestDatabase::new().await;
    let store = Store::connect(&database.url).await.unwrap();
    let app = router(store.clone());
    let owner = account(&store, "owner").await;
    let member = account(&store, "member").await;
    let (ws, _) = setup(&app, &owner).await;
    invite_member(&app, &store, &owner, ws, &member).await;
    let member_client = Uuid::new_v4();

    let before = pull_ok(&app, &member.token, ws, member_client, None).await["cursor"]
        .as_str()
        .unwrap()
        .to_owned();

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
        &format!("/api/workspaces/{ws}/import"),
        Some(&owner.token),
        Some(json!({"issues": issues})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{result}");
}

#[tokio::test]
async fn pull_pages_cut_at_txid_boundaries() {
    let _guard = lock().await;
    let database = support::TestDatabase::new().await;
    let store = Store::connect(&database.url).await.unwrap();
    let app = router(store.clone());
    let owner = account(&store, "owner").await;
    let (ws, team) = setup(&app, &owner).await;
    let client = Uuid::new_v4();

    let before = pull_ok(&app, &owner.token, ws, client, None).await["cursor"]
        .as_str()
        .unwrap()
        .to_owned();

    let first: Vec<Uuid> = bulk_issues(team, 0, 600)
        .iter()
        .map(|issue| Uuid::parse_str(issue["id"].as_str().unwrap()).unwrap())
        .collect();
    let first_payload: Vec<Value> = first
        .iter()
        .enumerate()
        .map(|(n, id)| json!({"id": id, "team_id": team, "title": format!("Bulk {n}")}))
        .collect();
    import_issues(&app, &owner, ws, first_payload).await;

    let second: Vec<Uuid> = bulk_issues(team, 600, 600)
        .iter()
        .map(|issue| Uuid::parse_str(issue["id"].as_str().unwrap()).unwrap())
        .collect();
    let second_payload: Vec<Value> = second
        .iter()
        .enumerate()
        .map(|(n, id)| json!({"id": id, "team_id": team, "title": format!("Bulk {}", 600 + n)}))
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

    let next = first_page["cursor"].as_str().unwrap().to_owned();
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
async fn pull_single_transaction_over_limit_resets() {
    let _guard = lock().await;
    let database = support::TestDatabase::new().await;
    let store = Store::connect(&database.url).await.unwrap();
    let app = router(store.clone());
    let owner = account(&store, "owner").await;
    let (ws, team) = setup(&app, &owner).await;
    let client = Uuid::new_v4();

    let before = pull_ok(&app, &owner.token, ws, client, None).await["cursor"]
        .as_str()
        .unwrap()
        .to_owned();

    let payload: Vec<Value> = (0..1001)
        .map(|n| json!({"id": Uuid::new_v4(), "team_id": team, "title": format!("Huge {n}")}))
        .collect();
    import_issues(&app, &owner, ws, payload).await;

    let page = pull_ok(&app, &owner.token, ws, client, Some(&before)).await;
    assert_eq!(page["reset"], true);
    assert_eq!(page["more"], false);
    assert_eq!(page["changes"], json!([]));

    drop(app);
    store.pool.close().await;
    database.cleanup().await;
}

#[tokio::test]
async fn pull_cursor_below_horizon_resets() {
    let _guard = lock().await;
    let database = support::TestDatabase::new().await;
    let store = Store::connect(&database.url).await.unwrap();
    let app = router(store.clone());
    let owner = account(&store, "owner").await;
    let (ws, team) = setup(&app, &owner).await;
    let client = Uuid::new_v4();

    let before = pull_ok(&app, &owner.token, ws, client, None).await["cursor"]
        .as_str()
        .unwrap()
        .to_owned();
    let _ = created(
        &app,
        &owner,
        ws,
        json!({"type": "create_issue", "input": {"team_id": team, "title": "After"}}),
    )
    .await;

    let cursor: i64 = before.parse().unwrap();
    sqlx::query("UPDATE change_horizon SET txid = $1")
        .bind(cursor + 1)
        .execute(&store.pool)
        .await
        .unwrap();

    let page = pull_ok(&app, &owner.token, ws, client, Some(&before)).await;
    assert_eq!(page["reset"], true);
    assert_eq!(page["changes"], json!([]));
    let fresh = page["cursor"].as_str().unwrap().to_owned();
    let again = pull_ok(&app, &owner.token, ws, client, Some(&fresh)).await;
    assert_eq!(again["reset"], false);

    drop(app);
    store.pool.close().await;
    database.cleanup().await;
}

#[tokio::test]
async fn pull_own_membership_change_resets_other_does_not() {
    let _guard = lock().await;
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

    let before = pull_ok(&app, &alice.token, ws, alice_client, None).await["cursor"]
        .as_str()
        .unwrap()
        .to_owned();

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

    let after = page["cursor"].as_str().unwrap().to_owned();
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
async fn pull_last_mutation_id_reflects_pushes() {
    let _guard = lock().await;
    let database = support::TestDatabase::new().await;
    let store = Store::connect(&database.url).await.unwrap();
    let app = router(store.clone());
    let owner = account(&store, "owner").await;
    let (ws, team) = setup(&app, &owner).await;
    let client = Uuid::new_v4();

    let before = pull_ok(&app, &owner.token, ws, client, None).await["cursor"]
        .as_str()
        .unwrap()
        .to_owned();

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
    let _guard = lock().await;
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
        &format!("/api/workspaces/{ws}/sync/pull"),
        Some(&owner.token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, _) = call(
        &app,
        "GET",
        &format!("/api/workspaces/{ws}/sync/pull?client_id=nope"),
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
            &format!("/api/workspaces/{ws}/sync/pull?client_id={client}&cursor={bad}"),
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
    let _guard = lock().await;
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
    let colleague_cursor = start["cursor"].as_str().unwrap().to_owned();

    let (_, result) = command(
        &app,
        owner,
        ws,
        json!({"type":"create_team","name":"Ops","members":[owner.profile.id]}),
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
    // The team join changed the owner's own membership row, so an owner
    // cursor from before it would reset. Take it after, so later owner pulls
    // show records instead of resetting.
    let owner_cursor = pull_ok(&app, &owner.token, ws, owner_client, None).await["cursor"]
        .as_str()
        .unwrap()
        .to_owned();

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

    let cursor = changes["cursor"].as_str().unwrap().to_owned();
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
        result["changes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|c| c["entity"] == "issues" && c["id"] == blocked)
    );
    let cursor =
        pull_ok(&app, &colleague.token, ws, colleague_client, Some(&cursor)).await["cursor"]
            .as_str()
            .unwrap()
            .to_owned();

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
    let fresh = changes["cursor"].as_str().unwrap().to_owned();
    assert_eq!(
        pull_ok(&app, &colleague.token, ws, colleague_client, Some(&fresh)).await["reset"],
        false
    );

    drop(app);
    store.pool.close().await;
    database.cleanup().await;
}
