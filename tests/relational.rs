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
use std::time::Duration;
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
            email: format!("{name}@example.com"),
            password: "relational-test-password".into(),
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
    versions: Value,
    key: Option<&str>,
) -> (StatusCode, Value) {
    call(
        app,
        owner,
        "POST",
        &format!("/internal-api/workspaces/{workspace}/commands"),
        Some(json!({
            "command": command,
            "expected_versions": versions,
            "idempotency_key": key,
        })),
    )
    .await
}

async fn created(app: &axum::Router, owner: &Session, workspace: Uuid, cmd: Value) -> Uuid {
    let (status, result) = command(app, owner, workspace, cmd, json!({}), None).await;
    assert_eq!(status, StatusCode::OK, "{result}");
    id(&result["result"]["id"])
}

async fn workspace(app: &axum::Router, owner: &Session, name: &str) -> Uuid {
    let (status, result) = call(
        app,
        owner,
        "POST",
        "/internal-api/workspaces",
        Some(json!({"name": name, "slug": Uuid::new_v4().to_string()})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{result}");
    id(&result["workspace"]["id"])
}

async fn version(store: &Store, issue: Uuid) -> i64 {
    sqlx::query_scalar("SELECT version FROM issues WHERE id=$1")
        .bind(issue)
        .fetch_one(&store.pool)
        .await
        .unwrap()
}

#[tokio::test]
async fn independent_writes_stale_versions_atomic_bulk_and_idempotency() {
    let database = support::TestDatabase::new().await;
    let store = Store::connect(&database.url).await.unwrap();
    let app = router(store.clone());
    let owner = account(&store, "owner").await;
    let ws = workspace(&app, &owner, "Independent writes").await;
    let team = created(
        &app,
        &owner,
        ws,
        json!({"type": "create_team", "name": "Team", "key": "TEA", "members": [owner.profile.id]}),
    )
    .await;
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

    let first_version = version(&store, first).await;
    let second_version = version(&store, second).await;

    let first_edit = command(
        &app,
        &owner,
        ws,
        json!({"type": "update_issue", "id": first, "patch": {"title": "First edited"}}),
        json!({first.to_string(): first_version}),
        None,
    );
    let second_edit = command(
        &app,
        &owner,
        ws,
        json!({"type": "update_issue", "id": second, "patch": {"title": "Second edited"}}),
        json!({second.to_string(): second_version}),
        None,
    );

    let (a, b) = tokio::join!(first_edit, second_edit);
    assert_eq!(a.0, StatusCode::OK, "{}", a.1);
    assert_eq!(b.0, StatusCode::OK, "{}", b.1);
    assert_eq!(version(&store, first).await, first_version + 1);
    assert_eq!(version(&store, second).await, second_version + 1);

    let stale = command(
        &app,
        &owner,
        ws,
        json!({"type": "update_issue", "id": first, "patch": {"title": "Stale"}}),
        json!({first.to_string(): first_version}),
        None,
    )
    .await;
    assert_eq!(stale.0, StatusCode::CONFLICT, "{}", stale.1);

    let missing = Uuid::new_v4();
    let bulk = command(
        &app,
        &owner,
        ws,
        json!({"type": "bulk_issues", "ids": [first, missing], "action": "delete"}),
        json!({first.to_string(): first_version + 1, missing.to_string(): 1}),
        None,
    )
    .await;
    assert!(bulk.0.is_client_error(), "{}", bulk.1);

    let row = sqlx::query("SELECT title,deleted_at,version FROM issues WHERE id=$1")
        .bind(first)
        .fetch_one(&store.pool)
        .await
        .unwrap();
    assert_eq!(row.get::<String, _>("title"), "First edited");
    assert!(
        row.get::<Option<chrono::DateTime<chrono::Utc>>, _>("deleted_at")
            .is_none()
    );
    assert_eq!(row.get::<i64, _>("version"), first_version + 1);

    let create =
        json!({"type": "create_issue", "input": {"team_id": team, "title": "Exactly one"}});
    let one = command(
        &app,
        &owner,
        ws,
        create.clone(),
        json!({}),
        Some("same-create"),
    )
    .await;

    let replay = command(&app, &owner, ws, create, json!({}), Some("same-create")).await;
    assert_eq!(one.0, StatusCode::OK, "{}", one.1);
    assert_eq!(replay, one);

    let changed = command(
        &app,
        &owner,
        ws,
        json!({"type": "create_issue", "input": {"team_id": team, "title": "Different"}}),
        json!({}),
        Some("same-create"),
    )
    .await;
    assert_eq!(changed.0, StatusCode::CONFLICT, "{}", changed.1);
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM issues WHERE workspace_id=$1")
            .bind(ws)
            .fetch_one(&store.pool)
            .await
            .unwrap(),
        3
    );

    drop(app);

    store.pool.close().await;
    database.cleanup().await;
}

#[tokio::test]
async fn parallel_number_allocation_and_database_tenant_constraints() {
    let database = support::TestDatabase::new().await;
    let store = Store::connect(&database.url).await.unwrap();
    let app = router(store.clone());
    let owner = account(&store, "owner").await;
    let ws = workspace(&app, &owner, "Numbers").await;
    let other = workspace(&app, &owner, "Other tenant").await;
    let team = created(
        &app,
        &owner,
        ws,
        json!({"type": "create_team", "name": "Team", "key": "TEA", "members": []}),
    )
    .await;
    let foreign_team = created(
        &app,
        &owner,
        other,
        json!({"type": "create_team", "name": "Foreign", "key": "FOR", "members": []}),
    )
    .await;
    let second = created(
        &app,
        &owner,
        ws,
        json!({"type": "create_team", "name": "Second", "key": "SEC", "members": []}),
    )
    .await;
    let taken = command(
        &app,
        &owner,
        ws,
        json!({"type": "create_team", "name": "Again", "key": "TEA", "members": []}),
        json!({}),
        None,
    )
    .await;
    assert_eq!(taken.0, StatusCode::CONFLICT, "{}", taken.1);

    let mut tasks = tokio::task::JoinSet::new();
    for n in 0..16 {
        let team = if n % 2 == 0 { team } else { second };
        let app = app.clone();
        let token = owner.token.clone();
        let profile = owner.profile.clone();
        let session_id = owner.session_id;
        tasks.spawn(async move {
            let owner = Session {
                token,
                profile,
                session_id,
                csrf_token: String::new(),
            };

            created(
                &app,
                &owner,
                ws,
                json!({
                    "type": "create_issue",
                    "input": {"team_id": team, "title": format!("Issue {n}")}
                }),
            )
            .await
        });
    }

    let mut ids = Vec::new();
    while let Some(result) = tasks.join_next().await {
        ids.push(result.unwrap());
    }

    // Each team counts from 1 on its own, even when creates interleave.
    for team in [team, second] {
        let numbers: Vec<i64> = sqlx::query_scalar(
            "SELECT number::bigint FROM issues WHERE workspace_id=$1 AND team_id=$2 ORDER BY number",
        )
        .bind(ws)
        .bind(team)
        .fetch_all(&store.pool)
        .await
        .unwrap();
        assert_eq!(numbers, (1..=8).collect::<Vec<_>>());
    }

    let invalid = sqlx::query("UPDATE issues SET team_id=$1 WHERE id=$2")
        .bind(foreign_team)
        .bind(ids[0])
        .execute(&store.pool)
        .await
        .unwrap_err();
    assert!(
        matches!(invalid, sqlx::Error::Database(ref error) if error.is_foreign_key_violation())
    );

    let duplicate =
        sqlx::query("UPDATE issues SET number=1 WHERE workspace_id=$1 AND team_id=$2 AND number=2")
            .bind(ws)
            .bind(team)
            .execute(&store.pool)
            .await
            .unwrap_err();
    assert!(matches!(duplicate, sqlx::Error::Database(ref error) if error.is_unique_violation()));

    let columns: Vec<String> = sqlx::query_scalar(
        "SELECT column_name FROM information_schema.columns \
         WHERE table_name='workspaces' AND table_schema=current_schema()",
    )
    .fetch_all(&store.pool)
    .await
    .unwrap();
    for obsolete in ["data", "revision", "next_tick_at"] {
        assert!(!columns.iter().any(|column| column == obsolete));
    }

    drop(app);

    store.pool.close().await;
    database.cleanup().await;
}

#[tokio::test]
async fn revocation_waits_for_membership_lock_and_blocks_later_writes() {
    let database = support::TestDatabase::new().await;
    let store = Store::connect(&database.url).await.unwrap();
    let app = router(store.clone());
    let owner = account(&store, "owner").await;
    let member = account(&store, "member").await;
    let ws = workspace(&app, &owner, "Revocation").await;
    let team = created(
        &app,
        &owner,
        ws,
        json!({"type": "create_team", "name": "Team", "key": "TEA", "members": []}),
    )
    .await;

    sqlx::query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'member')")
        .bind(ws)
        .bind(member.profile.id)
        .execute(&store.pool)
        .await
        .unwrap();

    let member_version: i64 = sqlx::query_scalar(
        "SELECT version FROM workspace_members WHERE workspace_id=$1 AND user_id=$2",
    )
    .bind(ws)
    .bind(member.profile.id)
    .fetch_one(&store.pool)
    .await
    .unwrap();

    let mut mutation = store.pool.begin().await.unwrap();

    sqlx::query(
        "SELECT role FROM workspace_members WHERE workspace_id=$1 AND user_id=$2 FOR SHARE",
    )
    .bind(ws)
    .bind(member.profile.id)
    .fetch_one(&mut *mutation)
    .await
    .unwrap();
    {
        let revoke = command(
            &app,
            &owner,
            ws,
            json!({"type": "remove_member", "user_id": member.profile.id}),
            json!({member.profile.id.to_string(): member_version}),
            None,
        );
        tokio::pin!(revoke);
        assert!(
            tokio::time::timeout(Duration::from_millis(150), &mut revoke)
                .await
                .is_err()
        );
        mutation.commit().await.unwrap();
        let result = tokio::time::timeout(Duration::from_secs(5), &mut revoke)
            .await
            .unwrap();
        assert_eq!(result.0, StatusCode::OK, "{}", result.1);
    }

    let denied = command(
        &app,
        &member,
        ws,
        json!({"type": "create_issue", "input": {"team_id": team, "title": "Too late"}}),
        json!({}),
        None,
    )
    .await;
    assert_eq!(denied.0, StatusCode::FORBIDDEN, "{}", denied.1);
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM issues WHERE workspace_id=$1")
            .bind(ws)
            .fetch_one(&store.pool)
            .await
            .unwrap(),
        0
    );

    drop(app);

    store.pool.close().await;
    database.cleanup().await;
}

#[tokio::test]
async fn superseded_running_reminders_skip_inbox_and_current_generation_deduplicates() {
    use blackwall::{
        jobs::{Job, Mailer, Reminder},
        store::Outbox,
    };
    let database = support::TestDatabase::new().await;
    let store = Store::connect(&database.url).await.unwrap();
    let app = router(store.clone());
    let owner = account(&store, "owner").await;
    let ws = workspace(&app, &owner, "Reminders").await;
    let team = created(
        &app,
        &owner,
        ws,
        json!({"type": "create_team", "name": "Team", "key": "TEA", "members": [owner.profile.id]}),
    )
    .await;

    let deadline = chrono::Utc::now() + chrono::Duration::hours(1);

    let issue = created(
        &app,
        &owner,
        ws,
        json!({
            "type": "create_issue",
            "input": {
                "team_id": team,
                "title": "Due soon",
                "assignee": owner.profile.id,
                "deadline": deadline
            }
        }),
    )
    .await;

    let old = store
        .outbox
        .claim("database", 1)
        .await
        .unwrap()
        .pop()
        .unwrap();

    let Job::Reminder(reminder) = Job::decode(&old.kind, &old.payload).unwrap() else {
        panic!("expected reminder")
    };

    let edit = command(
        &app,
        &owner,
        ws,
        json!({
            "type": "update_issue",
            "id": issue,
            "patch": {"deadline": deadline + chrono::Duration::days(2)}
        }),
        json!({issue.to_string(): version(&store, issue).await}),
        None,
    )
    .await;
    assert_eq!(edit.0, StatusCode::OK, "{}", edit.1);

    let mut tx = store.pool.begin().await.unwrap();

    sqlx::query("SELECT id FROM jobs WHERE id=$1 AND claim_token=$2 FOR UPDATE")
        .bind(old.id)
        .bind(old.token)
        .fetch_one(&mut *tx)
        .await
        .unwrap();
    Store::execute_reminder(&mut tx, &reminder).await.unwrap();
    assert!(Outbox::complete_in(&mut tx, &old).await.unwrap());
    tx.commit().await.unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM notifications WHERE kind='deadline'")
            .fetch_one(&store.pool)
            .await
            .unwrap(),
        0
    );

    let edit = command(
        &app,
        &owner,
        ws,
        json!({"type": "update_issue", "id": issue, "patch": {"deadline": deadline}}),
        json!({issue.to_string(): version(&store, issue).await}),
        None,
    )
    .await;
    assert_eq!(edit.0, StatusCode::OK, "{}", edit.1);

    blackwall::jobs::tick(&store, &Mailer::Disabled)
        .await
        .unwrap();

    blackwall::jobs::tick(&store, &Mailer::Disabled)
        .await
        .unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM notifications WHERE kind='deadline'")
            .fetch_one(&store.pool)
            .await
            .unwrap(),
        1
    );

    let generation: i64 = sqlx::query_scalar("SELECT reminder_generation FROM issues WHERE id=$1")
        .bind(issue)
        .fetch_one(&store.pool)
        .await
        .unwrap();

    let current = Reminder {
        workspace_id: ws,
        issue_id: issue,
        generation,
    };

    let mut tx = store.pool.begin().await.unwrap();
    Store::execute_reminder(&mut tx, &current).await.unwrap();
    Store::execute_reminder(&mut tx, &current).await.unwrap();
    tx.commit().await.unwrap();

    let edit = command(
        &app,
        &owner,
        ws,
        json!({
            "type": "update_issue",
            "id": issue,
            "patch": {"deadline": deadline + chrono::Duration::hours(1)}
        }),
        json!({issue.to_string(): version(&store, issue).await}),
        None,
    )
    .await;
    assert_eq!(edit.0, StatusCode::OK, "{}", edit.1);

    let claim = store
        .outbox
        .claim("database", 1)
        .await
        .unwrap()
        .pop()
        .unwrap();

    let Job::Reminder(reminder) = Job::decode(&claim.kind, &claim.payload).unwrap() else {
        panic!("expected reminder")
    };

    sqlx::query(
        "INSERT INTO alert_preferences(workspace_id,user_id,deadline) VALUES($1,$2,false) \
         ON CONFLICT(workspace_id,user_id) DO UPDATE SET deadline=EXCLUDED.deadline",
    )
    .bind(ws)
    .bind(owner.profile.id)
    .execute(&store.pool)
    .await
    .unwrap();

    let mut tx = store.pool.begin().await.unwrap();

    sqlx::query("SELECT id FROM jobs WHERE id=$1 AND claim_token=$2 FOR UPDATE")
        .bind(claim.id)
        .bind(claim.token)
        .fetch_one(&mut *tx)
        .await
        .unwrap();
    Store::execute_reminder(&mut tx, &reminder).await.unwrap();
    assert!(Outbox::complete_in(&mut tx, &claim).await.unwrap());
    tx.commit().await.unwrap();

    sqlx::query(
        "INSERT INTO alert_preferences(workspace_id,user_id,deadline) VALUES($1,$2,true) \
         ON CONFLICT(workspace_id,user_id) DO UPDATE SET deadline=EXCLUDED.deadline",
    )
    .bind(ws)
    .bind(owner.profile.id)
    .execute(&store.pool)
    .await
    .unwrap();

    let edit = command(
        &app,
        &owner,
        ws,
        json!({"type": "update_issue", "id": issue, "patch": {"deadline": deadline}}),
        json!({issue.to_string(): version(&store, issue).await}),
        None,
    )
    .await;
    assert_eq!(edit.0, StatusCode::OK, "{}", edit.1);

    let running = store
        .outbox
        .claim("database", 1)
        .await
        .unwrap()
        .pop()
        .unwrap();

    let Job::Reminder(reminder) = Job::decode(&running.kind, &running.payload).unwrap() else {
        panic!("expected reminder")
    };

    let done: Uuid = sqlx::query_scalar("SELECT id FROM stages WHERE team_id=$1 AND kind='done'")
        .bind(team)
        .fetch_one(&store.pool)
        .await
        .unwrap();

    let complete = command(
        &app,
        &owner,
        ws,
        json!({"type": "move_issue", "id": issue, "stage_id": done}),
        json!({issue.to_string(): version(&store, issue).await}),
        None,
    )
    .await;
    assert_eq!(complete.0, StatusCode::OK, "{}", complete.1);

    let mut tx = store.pool.begin().await.unwrap();

    sqlx::query("SELECT id FROM jobs WHERE id=$1 AND claim_token=$2 FOR UPDATE")
        .bind(running.id)
        .bind(running.token)
        .fetch_one(&mut *tx)
        .await
        .unwrap();
    Store::execute_reminder(&mut tx, &reminder).await.unwrap();
    assert!(Outbox::complete_in(&mut tx, &running).await.unwrap());
    tx.commit().await.unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM notifications WHERE kind='deadline'")
            .fetch_one(&store.pool)
            .await
            .unwrap(),
        1
    );

    drop(app);

    store.pool.close().await;
    database.cleanup().await;
}

#[tokio::test]
async fn fixtures_load_transactionally_and_migrations_are_repeatable() {
    let database = support::TestDatabase::new().await;
    let store = Store::connect(&database.url).await.unwrap();
    blackwall::fixtures::load(&store, "empty").await.unwrap();
    blackwall::fixtures::load(&store, "rich").await.unwrap();

    let login = store
        .login(blackwall::auth::Login {
            email: "owner@example.com".into(),
            password: "fixture-password-123".into(),
        })
        .await
        .unwrap();
    assert_eq!(
        login.profile.id,
        Uuid::from_u128(0x20000000_0000_0000_0000_000000000001)
    );

    let counts: Vec<i64> = sqlx::query_scalar(
        "SELECT count(i.id) FROM workspaces w \
         LEFT JOIN issues i ON i.workspace_id=w.id \
         GROUP BY w.id ORDER BY w.id",
    )
    .fetch_all(&store.pool)
    .await
    .unwrap();
    assert_eq!(counts, vec![0, 3]);
    assert_eq!(
        sqlx::query_scalar::<_, Vec<u8>>("SELECT bytes FROM attachments")
            .fetch_one(&store.pool)
            .await
            .unwrap(),
        b"claim tokens\n"
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM jobs WHERE kind='reminder' AND state='pending'"
        )
        .fetch_one(&store.pool)
        .await
        .unwrap(),
        1
    );

    let foreign_assignment = sqlx::query(
        "UPDATE issues SET assignee='10000000-0000-0000-0000-000000000001' \
         WHERE id='20000000-0000-0000-0000-000000000062'",
    )
    .execute(&store.pool)
    .await
    .unwrap_err();
    assert!(
        matches!(foreign_assignment, sqlx::Error::Database(ref error) if error.is_foreign_key_violation())
    );

    let excessive_time = sqlx::query(
        "UPDATE time_entries SET minutes=1441 WHERE id='20000000-0000-0000-0000-000000000071'",
    )
    .execute(&store.pool)
    .await
    .unwrap_err();
    assert!(
        matches!(excessive_time, sqlx::Error::Database(ref error) if error.is_check_violation())
    );

    assert!(blackwall::fixtures::load(&store, "rich").await.is_err());
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM users")
            .fetch_one(&store.pool)
            .await
            .unwrap(),
        3
    );

    store.pool.close().await;

    let reopened = Store::connect(&database.url).await.unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM workspaces")
            .fetch_one(&reopened.pool)
            .await
            .unwrap(),
        2
    );

    reopened.pool.close().await;
    database.cleanup().await;
}

#[tokio::test]
async fn representative_workspace_lists_reports_and_indexed_board_plan() {
    use blackwall::domain::IssueFilter;
    let database = support::TestDatabase::new().await;
    let store = Store::connect(&database.url).await.unwrap();
    blackwall::fixtures::load(&store, "rich").await.unwrap();
    let ws = Uuid::from_u128(0x20000000_0000_0000_0000_000000000010);
    let owner = Uuid::from_u128(0x20000000_0000_0000_0000_000000000001);
    let team = Uuid::from_u128(0x20000000_0000_0000_0000_000000000020);
    let stage = Uuid::from_u128(0x20000000_0000_0000_0000_000000000021);

    sqlx::query(
        "INSERT INTO issues(id,workspace_id,number,title,description,team_id,stage_id,priority,\
         position,created_at,updated_at) \
         SELECT gen_random_uuid(),$1,n,'Representative issue '||n,'SQL list and report fixture',\
         $2,$3,'normal',n*1024,now(),now() FROM generate_series(4,5000) n",
    )
    .bind(ws)
    .bind(team)
    .bind(stage)
    .execute(&store.pool)
    .await
    .unwrap();

    sqlx::query("ANALYZE issues")
        .execute(&store.pool)
        .await
        .unwrap();

    let start = std::time::Instant::now();

    let page = store
        .list_issues(ws, owner, IssueFilter::default(), 100, 0)
        .await
        .unwrap();
    assert_eq!(page["items"].as_array().unwrap().len(), 100);
    assert_eq!(page["has_more"], true);
    assert_eq!(page["next_offset"], 100);

    let found = store
        .list_issues(
            ws,
            owner,
            IssueFilter {
                search: Some("Representative issue 4210".into()),
                ..Default::default()
            },
            100,
            0,
        )
        .await
        .unwrap();
    assert_eq!(found["items"].as_array().unwrap().len(), 1);
    assert_eq!(found["items"][0]["number"], 4210);

    let report = store.report_sql(ws, owner).await.unwrap();
    assert_eq!(report["issue_count"], 4999);

    let plan: Value = sqlx::query_scalar(
        "EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) SELECT id FROM issues \
         WHERE workspace_id=$1 AND team_id=$2 AND stage_id=$3 AND deleted_at IS NULL \
         ORDER BY position,id LIMIT 100",
    )
    .bind(ws)
    .bind(team)
    .bind(stage)
    .fetch_one(&store.pool)
    .await
    .unwrap();
    assert!(plan.to_string().contains("issues_board"), "{plan}");
    eprintln!(
        "5000-issue list/search/report verification took {:?}; board plan {}",
        start.elapsed(),
        plan
    );

    store.pool.close().await;
    database.cleanup().await;
}

#[tokio::test]
async fn workspace_creation_retries_are_actor_scoped_and_atomic() {
    let database = support::TestDatabase::new().await;
    let store = Store::connect(&database.url).await.unwrap();
    let app = router(store.clone());
    let owner = account(&store, "owner").await;
    let other = account(&store, "other").await;

    let payload = json!({"name": "One workspace", "slug": "one-workspace", "idempotency_key": "ambiguous-create"});

    let (a, b) = tokio::join!(
        call(
            &app,
            &owner,
            "POST",
            "/internal-api/workspaces",
            Some(payload.clone())
        ),
        call(
            &app,
            &owner,
            "POST",
            "/internal-api/workspaces",
            Some(payload)
        ),
    );
    assert_eq!(a.0, StatusCode::OK, "{}", a.1);
    assert_eq!(a, b);

    let mismatch = call(
        &app,
        &owner,
        "POST",
        "/internal-api/workspaces",
        Some(json!({"name": "Another name", "slug": "another-name", "idempotency_key": "ambiguous-create"})),
    )
    .await;
    assert_eq!(mismatch.0, StatusCode::CONFLICT, "{}", mismatch.1);

    let taken = call(
        &app,
        &owner,
        "POST",
        "/internal-api/workspaces",
        Some(json!({"name": "Copy", "slug": "one-workspace", "idempotency_key": "taken-slug"})),
    )
    .await;
    assert_eq!(taken.0, StatusCode::CONFLICT, "{}", taken.1);
    let reserved = call(
        &app,
        &owner,
        "POST",
        "/internal-api/workspaces",
        Some(json!({"name": "Login", "slug": "login"})),
    )
    .await;
    assert_eq!(reserved.0, StatusCode::BAD_REQUEST, "{}", reserved.1);

    let other = call(
        &app,
        &other,
        "POST",
        "/internal-api/workspaces",
        Some(json!({"name": "Another actor", "slug": "another-actor", "idempotency_key": "ambiguous-create"})),
    )
    .await;
    assert_eq!(other.0, StatusCode::OK, "{}", other.1);
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM workspaces")
            .fetch_one(&store.pool)
            .await
            .unwrap(),
        2
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM workspace_members")
            .fetch_one(&store.pool)
            .await
            .unwrap(),
        2
    );

    drop(app);

    store.pool.close().await;
    database.cleanup().await;
}

#[tokio::test]
async fn non_postgres_urls_are_rejected() {
    for url in [
        "sqlite::memory:",
        "sqlite://blackwall.db",
        "mysql://localhost/blackwall",
        "",
    ] {
        assert!(Store::connect(url).await.is_err(), "accepted {url}");
    }
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
async fn idempotent_finish_child_replay_reports_current_records() {
    let database = support::TestDatabase::new().await;
    let store = Store::connect(&database.url).await.unwrap();
    let app = router(store.clone());
    let owner = account(&store, "owner").await;
    let ws = workspace(&app, &owner, "Finish replay").await;

    let (status, result) = command(
        &app,
        &owner,
        ws,
        json!({"type": "create_team", "name": "Ops", "key": "OPS", "members": [owner.profile.id]}),
        json!({}),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{result}");
    let team = id(&result["result"]["id"]);
    let stages = record(&result["changes"], "teams", &team.to_string()).unwrap()["stages"]
        .as_array()
        .unwrap()
        .clone();
    let done = stages.iter().find(|s| s["kind"] == "done").unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();

    let parent = created(
        &app,
        &owner,
        ws,
        json!({"type": "create_issue", "input": {"team_id": team, "title": "Parent"}}),
    )
    .await;

    // Counts are read through REST; creating a child changes only the child.
    let (status, result) = command(
        &app,
        &owner,
        ws,
        json!({"type": "create_issue", "input": {"team_id": team, "title": "Child", "parent_id": parent}}),
        json!({}),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{result}");
    let child = id(&result["result"]["id"]);
    assert!(record(&result["changes"], "issues", &parent.to_string()).is_none());
    let (status, parent_record) = call(
        &app,
        &owner,
        "GET",
        &format!("/internal-api/workspaces/{ws}/issues/{parent}"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(parent_record["subtask_total"], 1);
    assert_eq!(parent_record["subtask_completed"], 0);
    let child_version =
        record(&result["changes"], "issues", &child.to_string()).unwrap()["version"].clone();

    let (status, result) = command(
        &app,
        &owner,
        ws,
        json!({"type": "create_issue", "input": {"team_id": team, "title": "Blocked", "dependencies": [child]}}),
        json!({}),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{result}");
    let blocked = id(&result["result"]["id"]);
    assert_eq!(
        record(&result["changes"], "issues", &blocked.to_string()).unwrap()["blocked_count"],
        1
    );

    // Finishing returns the child in its new stage. Replay the same key later.
    let move_child =
        json!({"type": "move_issue", "id": child, "stage_id": done, "before_id": null});
    let finish_versions = json!({ child.to_string(): child_version });
    let (status, result) = command(
        &app,
        &owner,
        ws,
        move_child.clone(),
        finish_versions.clone(),
        Some("finish-child"),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{result}");
    assert_eq!(
        record(&result["changes"], "issues", &child.to_string()).unwrap()["stage_id"],
        done
    );
    for (issue, count, value) in [
        (parent, "subtask_completed", 1),
        (blocked, "blocked_count", 0),
    ] {
        assert!(record(&result["changes"], "issues", &issue.to_string()).is_none());
        let (status, detail) = call(
            &app,
            &owner,
            "GET",
            &format!("/internal-api/workspaces/{ws}/issues/{issue}"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(detail[count], value);
    }
    let updated = created(
        &app,
        &owner,
        ws,
        json!({"type": "update_issue", "id": parent, "patch": {"title": "Parent edited after finish"}}),
    )
    .await;
    assert_eq!(updated, parent);
    let changes_before: i64 =
        sqlx::query_scalar("SELECT count(*) FROM changes WHERE workspace_id = $1")
            .bind(ws)
            .fetch_one(&store.pool)
            .await
            .unwrap();

    // A replayed command reports the records as they are now.
    let (status, replay) = command(
        &app,
        &owner,
        ws,
        move_child,
        finish_versions,
        Some("finish-child"),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{replay}");
    assert_eq!(
        record(&replay["changes"], "issues", &child.to_string()).unwrap()["stage_id"],
        done
    );
    assert!(record(&replay["changes"], "issues", &parent.to_string()).is_none());
    assert!(record(&replay["changes"], "issues", &blocked.to_string()).is_none());
    let (status, detail) = call(
        &app,
        &owner,
        "GET",
        &format!("/internal-api/workspaces/{ws}/issues/{parent}"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(detail["subtask_completed"], 1);
    assert_eq!(detail["title"], "Parent edited after finish");
    let (status, detail) = call(
        &app,
        &owner,
        "GET",
        &format!("/internal-api/workspaces/{ws}/issues/{blocked}"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(detail["blocked_count"], 0);
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
async fn backlog_issues_stay_out_of_sprints() {
    let database = support::TestDatabase::new().await;
    let store = Store::connect(&database.url).await.unwrap();
    let app = router(store.clone());
    let owner = account(&store, "owner").await;
    let ws = workspace(&app, &owner, "Backlog and sprints").await;
    let team = created(
        &app,
        &owner,
        ws,
        json!({"type": "create_team", "name": "Team", "key": "TEA", "members": [owner.profile.id]}),
    )
    .await;
    let stage = |kind: &'static str| {
        sqlx::query_scalar::<_, Uuid>("SELECT id FROM stages WHERE team_id=$1 AND kind=$2")
            .bind(team)
            .bind(kind)
            .fetch_one(&store.pool)
    };
    let (backlog, todo) = (
        stage("backlog").await.unwrap(),
        stage("planned").await.unwrap(),
    );
    let sprint = created(
        &app,
        &owner,
        ws,
        json!({"type": "create_sprint", "team_id": team, "name": "One", "goal": "", "starts_at": "2030-01-01T00:00:00Z", "ends_at": "2030-01-15T00:00:00Z"}),
    )
    .await;
    let placement = |issue: Uuid| {
        let pool = store.pool.clone();
        async move {
            let row = sqlx::query("SELECT stage_id,sprint_id FROM issues WHERE id=$1")
                .bind(issue)
                .fetch_one(&pool)
                .await
                .unwrap();
            (
                row.get::<Uuid, _>("stage_id"),
                row.get::<Option<Uuid>, _>("sprint_id"),
            )
        }
    };
    let ok = async |cmd: Value| {
        let (status, result) = command(&app, &owner, ws, cmd, json!({}), None).await;
        assert_eq!(status, StatusCode::OK, "{result}");
    };

    // The team's first stage is Backlog, so sprint work defaults to Todo instead.
    let issue = created(
        &app,
        &owner,
        ws,
        json!({"type": "create_issue", "input": {"team_id": team, "title": "Planned", "sprint_id": sprint}}),
    )
    .await;
    assert_eq!(placement(issue).await, (todo, Some(sprint)));

    // A named backlog stage wins over the sprint.
    let named = created(
        &app,
        &owner,
        ws,
        json!({"type": "create_issue", "input": {"team_id": team, "title": "Later", "stage_id": backlog, "sprint_id": sprint}}),
    )
    .await;
    assert_eq!(placement(named).await, (backlog, None));

    ok(json!({"type": "update_issue", "id": issue, "patch": {"stage_id": backlog}})).await;
    assert_eq!(placement(issue).await, (backlog, None));

    ok(json!({"type": "update_issue", "id": issue, "patch": {"sprint_id": sprint}})).await;
    assert_eq!(placement(issue).await, (todo, Some(sprint)));

    ok(json!({"type": "move_issue", "id": issue, "stage_id": backlog, "before_id": null})).await;
    assert_eq!(placement(issue).await, (backlog, None));

    // Turning a stage into a backlog stage takes its issues out of their sprints.
    ok(json!({"type": "update_issue", "id": issue, "patch": {"sprint_id": sprint}})).await;
    let before = version(&store, issue).await;
    ok(json!({"type": "update_stage", "team_id": team, "id": todo, "name": "Todo", "kind": "backlog", "position": 1})).await;
    assert_eq!(placement(issue).await, (todo, None));
    assert_eq!(version(&store, issue).await, before + 1);

    drop(app);
    store.pool.close().await;
    database.cleanup().await;
}

#[tokio::test]
async fn dependencies_gate_starting_work_but_reopening_leaves_dependents_blocked() {
    let database = support::TestDatabase::new().await;
    let store = Store::connect(&database.url).await.unwrap();
    let app = router(store.clone());
    let owner = account(&store, "owner").await;
    let ws = workspace(&app, &owner, "Blockers").await;
    let (status, result) = command(
        &app,
        &owner,
        ws,
        json!({"type": "create_team", "name": "Ops", "key": "OPS", "members": [owner.profile.id]}),
        json!({}),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{result}");
    let team = id(&result["result"]["id"]);
    let stages = record(&result["changes"], "teams", &team.to_string()).unwrap()["stages"]
        .as_array()
        .unwrap()
        .clone();
    let stage = |kind: &str| stages.iter().find(|s| s["kind"] == kind).unwrap()["id"].clone();
    let (planned, active, done) = (stage("planned"), stage("active"), stage("done"));
    let run = |command_value: Value| command(&app, &owner, ws, command_value, json!({}), None);
    let blocked_count = |issue: Uuid| {
        let path = format!("/internal-api/workspaces/{ws}/issues/{issue}");
        let (app, owner) = (&app, &owner);
        async move { call(app, owner, "GET", &path, None).await.1["blocked_count"].clone() }
    };

    let blocker = created(
        &app,
        &owner,
        ws,
        json!({"type": "create_issue", "input": {"team_id": team, "title": "Blocker", "stage_id": done}}),
    )
    .await;
    let dependent = created(
        &app,
        &owner,
        ws,
        json!({"type": "create_issue", "input": {"team_id": team, "title": "Dependent", "stage_id": active, "dependencies": [blocker]}}),
    )
    .await;

    // Reopening the blocker leaves the dependent started, blocked and editable.
    let (status, result) =
        run(json!({"type": "move_issue", "id": blocker, "stage_id": planned, "before_id": null}))
            .await;
    assert_eq!(status, StatusCode::OK, "{result}");
    assert_eq!(blocked_count(dependent).await, 1);
    let (status, result) =
        run(json!({"type": "update_issue", "id": dependent, "patch": {"title": "Renamed"}})).await;
    assert_eq!(status, StatusCode::OK, "{result}");

    // Entering another started stage still waits for the blocker.
    let (status, result) =
        run(json!({"type": "move_issue", "id": dependent, "stage_id": done, "before_id": null}))
            .await;
    assert_eq!(status, StatusCode::CONFLICT, "{result}");

    // A started issue cannot gain an open dependency.
    let other = created(
        &app,
        &owner,
        ws,
        json!({"type": "create_issue", "input": {"team_id": team, "title": "Other"}}),
    )
    .await;
    let (status, result) = run(
        json!({"type": "update_issue", "id": dependent, "patch": {"dependencies": [blocker, other]}}),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "{result}");

    // Trashing the blocker unblocks the dependent, which stays editable.
    let (status, result) = run(json!({"type": "delete_issue", "id": blocker})).await;
    assert_eq!(status, StatusCode::OK, "{result}");
    assert_eq!(blocked_count(dependent).await, 0);
    let (status, result) =
        run(json!({"type": "update_issue", "id": dependent, "patch": {"title": "Again"}})).await;
    assert_eq!(status, StatusCode::OK, "{result}");
    let (status, result) =
        run(json!({"type": "move_issue", "id": dependent, "stage_id": done, "before_id": null}))
            .await;
    assert_eq!(status, StatusCode::OK, "{result}");
    database.cleanup().await;
}
