mod support;

use blackwall::{
    auth::{Login, Register},
    domain::{Command, IssueFilter},
    http::router,
    store::Store,
};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use uuid::Uuid;

async fn account(store: &Store, name: &str) -> Uuid {
    store
        .register(Register {
            email: format!("{name}@example.com"),
            password: "archive-test-password".into(),
            display_name: name.into(),
        })
        .await
        .unwrap()
        .profile
        .id
}

async fn op(
    store: &Store,
    ws: Uuid,
    actor: Uuid,
    cmd: Value,
    expected: BTreeMap<Uuid, i64>,
) -> Result<blackwall::store::OperationResult, blackwall::error::Error> {
    store
        .operation(
            ws,
            actor,
            serde_json::from_value::<Command>(cmd).unwrap(),
            expected,
            None,
            None,
        )
        .await
}

async fn version_of(store: &Store, table: &str, id: Uuid) -> i64 {
    let sql = format!("SELECT version FROM {table} WHERE id=$1");
    sqlx::query_scalar(&sql)
        .bind(id)
        .fetch_one(&store.pool)
        .await
        .unwrap()
}

async fn expect(store: &Store, table: &str, id: Uuid) -> BTreeMap<Uuid, i64> {
    BTreeMap::from([(id, version_of(store, table, id).await)])
}

fn items(page: &Value) -> &Vec<Value> {
    page["items"].as_array().unwrap()
}

#[tokio::test]
async fn done_issues_archive_on_team_deadline_and_stay_out_of_lists() {
    let database = support::TestDatabase::new().await;
    let store = Store::connect(&database.url).await.unwrap();
    let owner = account(&store, "owner").await;
    let ws = Uuid::parse_str(
        store
            .create_workspace("Archive".into(), owner)
            .await
            .unwrap()["id"]
            .as_str()
            .unwrap(),
    )
    .unwrap();

    // New teams default to a 30-day deadline.
    let team = op(
        &store,
        ws,
        owner,
        json!({"type":"create_team","name":"Infra","members":[owner]}),
        BTreeMap::new(),
    )
    .await
    .unwrap()
    .result
    .id
    .unwrap();
    let days: Option<i32> = sqlx::query_scalar("SELECT archive_after_days FROM teams WHERE id=$1")
        .bind(team)
        .fetch_one(&store.pool)
        .await
        .unwrap();
    assert_eq!(days, Some(30));

    let stages: Vec<(Uuid, String)> = sqlx::query_as(
        "SELECT id,kind FROM stages WHERE workspace_id=$1 AND team_id=$2 ORDER BY position",
    )
    .bind(ws)
    .bind(team)
    .fetch_all(&store.pool)
    .await
    .unwrap();
    let backlog = stages.iter().find(|(_, k)| k == "backlog").unwrap().0;
    let done = stages.iter().find(|(_, k)| k == "done").unwrap().0;
    assert_ne!(backlog, done);

    // Out-of-range deadlines are rejected; null means never.
    assert!(
        op(
            &store,
            ws,
            owner,
            json!({"type":"set_team_archive","id":team,"archive_after_days":0}),
            expect(&store, "teams", team).await,
        )
        .await
        .is_err()
    );
    op(
        &store,
        ws,
        owner,
        json!({"type":"set_team_archive","id":team,"archive_after_days":1}),
        expect(&store, "teams", team).await,
    )
    .await
    .unwrap();

    let issue = op(
        &store,
        ws,
        owner,
        json!({"type":"create_issue","input":{"team_id":team,"title":"Rotate keys"}}),
        BTreeMap::new(),
    )
    .await
    .unwrap()
    .result
    .id
    .unwrap();

    // Only Done issues can be archived; open ones are rejected.
    assert!(
        op(
            &store,
            ws,
            owner,
            json!({"type":"archive_issue","id":issue}),
            expect(&store, "issues", issue).await,
        )
        .await
        .is_err()
    );

    // Moving to Done starts the clock.
    op(
        &store,
        ws,
        owner,
        json!({"type":"move_issue","id":issue,"stage_id":done,"before_id":null}),
        expect(&store, "issues", issue).await,
    )
    .await
    .unwrap();
    let done_at: Option<chrono::DateTime<chrono::Utc>> =
        sqlx::query_scalar("SELECT done_at FROM issues WHERE id=$1")
            .bind(issue)
            .fetch_one(&store.pool)
            .await
            .unwrap();
    assert!(done_at.is_some());

    // Manual archive hides the issue from default listings but keeps detail.
    op(
        &store,
        ws,
        owner,
        json!({"type":"archive_issue","id":issue}),
        expect(&store, "issues", issue).await,
    )
    .await
    .unwrap();
    assert!(
        store
            .list_issues(ws, owner, IssueFilter::default(), 100, 0)
            .await
            .unwrap()["items"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    let archived_page = store
        .list_issues(
            ws,
            owner,
            IssueFilter {
                archived: true,
                ..Default::default()
            },
            100,
            0,
        )
        .await
        .unwrap();
    assert_eq!(items(&archived_page).len(), 1);
    assert!(
        store
            .get_issue(ws, owner, issue)
            .await
            .unwrap()
            .archived_at
            .is_some()
    );

    // Archived issues are read-only until unarchived.
    assert!(
        op(
            &store,
            ws,
            owner,
            json!({"type":"update_issue","id":issue,"patch":{"title":"Edited while archived"}}),
            expect(&store, "issues", issue).await,
        )
        .await
        .is_err()
    );
    assert!(
        op(
            &store,
            ws,
            owner,
            json!({"type":"move_issue","id":issue,"stage_id":backlog,"before_id":null}),
            expect(&store, "issues", issue).await,
        )
        .await
        .is_err()
    );

    // Unarchiving restores visibility with a fresh grace period.
    op(
        &store,
        ws,
        owner,
        json!({"type":"unarchive_issue","id":issue}),
        expect(&store, "issues", issue).await,
    )
    .await
    .unwrap();
    assert_eq!(
        items(
            &store
                .list_issues(ws, owner, IssueFilter::default(), 100, 0)
                .await
                .unwrap()
        )
        .len(),
        1
    );

    // Ageing past the team deadline auto-archives on sweep.
    sqlx::query("UPDATE issues SET done_at=now()-interval '2 days',updated_at=now()-interval '2 days' WHERE id=$1")
        .bind(issue)
        .execute(&store.pool)
        .await
        .unwrap();
    assert_eq!(store.archive_sweep().await.unwrap(), 1);
    assert!(
        store
            .list_issues(ws, owner, IssueFilter::default(), 100, 0)
            .await
            .unwrap()["items"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert_eq!(store.report_sql(ws, owner).await.unwrap()["issue_count"], 0);

    // A NULL deadline means never: even a stale Done issue stays visible.
    op(
        &store,
        ws,
        owner,
        json!({"type":"set_team_archive","id":team,"archive_after_days":null}),
        expect(&store, "teams", team).await,
    )
    .await
    .unwrap();
    let fresh = op(
        &store,
        ws,
        owner,
        json!({"type":"create_issue","input":{"team_id":team,"title":"Stay visible"}}),
        BTreeMap::new(),
    )
    .await
    .unwrap()
    .result
    .id
    .unwrap();
    op(
        &store,
        ws,
        owner,
        json!({"type":"move_issue","id":fresh,"stage_id":done,"before_id":null}),
        expect(&store, "issues", fresh).await,
    )
    .await
    .unwrap();
    sqlx::query("UPDATE issues SET done_at=now()-interval '10 days',updated_at=now()-interval '10 days' WHERE id=$1")
        .bind(fresh)
        .execute(&store.pool)
        .await
        .unwrap();
    assert_eq!(store.archive_sweep().await.unwrap(), 0);
    assert_eq!(
        items(
            &store
                .list_issues(ws, owner, IssueFilter::default(), 100, 0)
                .await
                .unwrap()
        )
        .len(),
        1
    );

    // Cancelled stages are excluded from archiving entirely.
    let cancelled = op(
        &store,
        ws,
        owner,
        json!({"type":"create_stage","team_id":team,"name":"Dropped","kind":"cancelled","position":99}),
        BTreeMap::new(),
    )
    .await
    .unwrap()
    .result
    .id
    .unwrap();
    op(
        &store,
        ws,
        owner,
        json!({"type":"set_team_archive","id":team,"archive_after_days":1}),
        expect(&store, "teams", team).await,
    )
    .await
    .unwrap();
    op(
        &store,
        ws,
        owner,
        json!({"type":"move_issue","id":fresh,"stage_id":cancelled,"before_id":null}),
        expect(&store, "issues", fresh).await,
    )
    .await
    .unwrap();
    // Manual archive rejects Cancelled issues too.
    assert!(
        op(
            &store,
            ws,
            owner,
            json!({"type":"archive_issue","id":fresh}),
            expect(&store, "issues", fresh).await,
        )
        .await
        .is_err()
    );
    sqlx::query("UPDATE issues SET updated_at=now()-interval '10 days' WHERE id=$1")
        .bind(fresh)
        .execute(&store.pool)
        .await
        .unwrap();
    assert_eq!(store.archive_sweep().await.unwrap(), 0);
    assert_eq!(
        items(
            &store
                .list_issues(ws, owner, IssueFilter::default(), 100, 0)
                .await
                .unwrap()
        )
        .len(),
        1
    );

    store.pool.close().await;
    database.cleanup().await;
}

#[tokio::test]
async fn global_search_spans_live_and_archived_issues() {
    use axum::{
        body::Body,
        http::{Request, StatusCode},
    };
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    let database = support::TestDatabase::new().await;
    let store = Store::connect(&database.url).await.unwrap();
    let owner = account(&store, "searcher").await;
    let session = store
        .login(Login {
            email: "searcher@example.com".into(),
            password: "archive-test-password".into(),
        })
        .await
        .unwrap();
    let ws = Uuid::parse_str(
        store
            .create_workspace("Search".into(), owner)
            .await
            .unwrap()["id"]
            .as_str()
            .unwrap(),
    )
    .unwrap();

    let team = op(
        &store,
        ws,
        owner,
        json!({"type":"create_team","name":"Infra","members":[owner]}),
        BTreeMap::new(),
    )
    .await
    .unwrap()
    .result
    .id
    .unwrap();
    let done: Uuid = sqlx::query_scalar(
        "SELECT id FROM stages WHERE workspace_id=$1 AND team_id=$2 AND kind='done'",
    )
    .bind(ws)
    .bind(team)
    .fetch_one(&store.pool)
    .await
    .unwrap();

    let live = op(
        &store,
        ws,
        owner,
        json!({"type":"create_issue","input":{"team_id":team,"title":"Zebra Quartz live"}}),
        BTreeMap::new(),
    )
    .await
    .unwrap()
    .result
    .id
    .unwrap();
    let old = op(
        &store,
        ws,
        owner,
        json!({"type":"create_issue","input":{"team_id":team,"title":"Zebra Quartz archived"}}),
        BTreeMap::new(),
    )
    .await
    .unwrap()
    .result
    .id
    .unwrap();
    op(
        &store,
        ws,
        owner,
        json!({"type":"move_issue","id":old,"stage_id":done,"before_id":null}),
        expect(&store, "issues", old).await,
    )
    .await
    .unwrap();
    op(
        &store,
        ws,
        owner,
        json!({"type":"archive_issue","id":old}),
        expect(&store, "issues", old).await,
    )
    .await
    .unwrap();

    let app = router(store.clone());
    let response = app
        .oneshot(
            Request::builder()
                .uri(format!("/api/workspaces/{ws}/search?q=zebra"))
                .header("Authorization", format!("Bearer {}", session.token))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let found: Vec<Uuid> = serde_json::from_slice::<Value>(&body).unwrap()["issues"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| Uuid::parse_str(i["id"].as_str().unwrap()).unwrap())
        .collect();

    // Live matches rank first; archived matches are still findable.
    assert_eq!(found, vec![live, old]);

    store.pool.close().await;
    database.cleanup().await;
}
