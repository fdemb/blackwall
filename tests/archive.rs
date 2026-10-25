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
        json!({"type":"create_team","name":"Infra", "key": "INF","members":[owner]}),
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
        json!({"type":"create_team","name":"Infra", "key": "INF","members":[owner]}),
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
                .uri(format!("/internal-api/workspaces/{ws}/search?q=zebra"))
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

async fn run(store: &Store, ws: Uuid, actor: Uuid, cmd: Value) -> Option<Uuid> {
    op(store, ws, actor, cmd, BTreeMap::new())
        .await
        .unwrap()
        .result
        .id
}

async fn trash(store: &Store, ws: Uuid, actor: Uuid, issue: Uuid, days: i32) {
    run(store, ws, actor, json!({"type":"delete_issue","id":issue})).await;
    sqlx::query("UPDATE issues SET deleted_at=now()-make_interval(days=>$2) WHERE id=$1")
        .bind(issue)
        .bind(days)
        .execute(&store.pool)
        .await
        .unwrap();
}

async fn kept_activity(store: &Store, ids: &[Uuid]) -> Vec<Uuid> {
    sqlx::query_scalar("SELECT id FROM activity WHERE entity_id=ANY($1) ORDER BY id")
        .bind(ids)
        .fetch_all(&store.pool)
        .await
        .unwrap()
}

async fn count(store: &Store, sql: &str, id: Uuid) -> i64 {
    sqlx::query_scalar(sql)
        .bind(id)
        .fetch_one(&store.pool)
        .await
        .unwrap()
}

#[tokio::test]
async fn issues_trashed_over_thirty_days_ago_are_purged_with_their_records() {
    let database = support::TestDatabase::new().await;
    let store = Store::connect(&database.url).await.unwrap();
    let owner = account(&store, "owner").await;
    let ws = Uuid::parse_str(
        store.create_workspace("Trash".into(), owner).await.unwrap()["id"]
            .as_str()
            .unwrap(),
    )
    .unwrap();
    let team = run(
        &store,
        ws,
        owner,
        json!({"type":"create_team","name":"Infra","key":"INF","members":[owner]}),
    )
    .await
    .unwrap();
    let label = run(
        &store,
        ws,
        owner,
        json!({"type":"create_label","name":"Bug","color":"red"}),
    )
    .await
    .unwrap();
    let issue = |title: &str, extra: Value| {
        let mut input = json!({"team_id":team,"title":title});
        input
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        json!({"type":"create_issue","input":input})
    };
    let blocker = run(&store, ws, owner, issue("Blocker", json!({})))
        .await
        .unwrap();
    let doomed = run(
        &store,
        ws,
        owner,
        issue("Doomed", json!({"labels":[label],"dependencies":[blocker]})),
    )
    .await
    .unwrap();
    let dependent = run(
        &store,
        ws,
        owner,
        issue("Dependent", json!({"dependencies":[doomed]})),
    )
    .await
    .unwrap();
    let child = run(
        &store,
        ws,
        owner,
        issue("Child", json!({"parent_id":doomed})),
    )
    .await
    .unwrap();
    let recent = run(&store, ws, owner, issue("Recent", json!({})))
        .await
        .unwrap();

    let comment = run(
        &store,
        ws,
        owner,
        json!({"type":"add_comment","issue_id":doomed,"body":"Looking into it"}),
    )
    .await
    .unwrap();
    let time = run(
        &store,
        ws,
        owner,
        json!({"type":"log_time","issue_id":doomed,"minutes":30,"logged_at":"2026-10-01T10:00:00Z"}),
    )
    .await
    .unwrap();
    let mut kept = Vec::new();
    for target in [child, recent] {
        let comment = run(
            &store,
            ws,
            owner,
            json!({"type":"add_comment","issue_id":target,"body":"Wrong issue"}),
        )
        .await
        .unwrap();
        run(
            &store,
            ws,
            owner,
            json!({"type":"delete_comment","id":comment}),
        )
        .await;
        let time = run(
            &store,
            ws,
            owner,
            json!({"type":"log_time","issue_id":target,"minutes":5,"logged_at":"2026-10-01T09:00:00Z"}),
        )
        .await
        .unwrap();
        run(&store, ws, owner, json!({"type":"delete_time","id":time})).await;
        kept.extend([target, comment, time]);
    }
    run(
        &store,
        ws,
        owner,
        json!({"type":"follow","issue_id":doomed,"following":true}),
    )
    .await;
    run(
        &store,
        ws,
        owner,
        json!({"type":"add_source_link","issue_id":doomed,"url":"https://example.com/1","title":"Ticket"}),
    )
    .await;
    sqlx::query("INSERT INTO attachments(id,workspace_id,issue_id,uploader_id,filename,content_type,bytes,created_at) VALUES($1,$2,$3,$4,'log.txt','text/plain','\\x00',now())")
        .bind(Uuid::new_v4())
        .bind(ws)
        .bind(doomed)
        .bind(owner)
        .execute(&store.pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO notifications(id,workspace_id,user_id,issue_id,kind,message,created_at,dedup_key) VALUES($1,$2,$3,$4,'assignment','Doomed',now(),'purge-test')")
        .bind(Uuid::new_v4())
        .bind(ws)
        .bind(owner)
        .bind(doomed)
        .execute(&store.pool)
        .await
        .unwrap();

    for id in [doomed, comment, time] {
        assert!(
            count(
                &store,
                "SELECT count(*) FROM activity WHERE entity_id=$1",
                id
            )
            .await
                > 0
        );
    }
    trash(&store, ws, owner, doomed, 31).await;
    trash(&store, ws, owner, recent, 29).await;
    let kept_before = kept_activity(&store, &kept).await;
    for id in &kept {
        assert!(
            count(
                &store,
                "SELECT count(*) FROM activity WHERE entity_id=$1",
                *id
            )
            .await
                > 0
        );
    }
    let issues_before = count(
        &store,
        "SELECT count(*) FROM issues WHERE workspace_id=$1",
        ws,
    )
    .await;

    assert_eq!(store.purge_trash().await.unwrap(), 1);

    assert_eq!(
        count(
            &store,
            "SELECT count(*) FROM issues WHERE workspace_id=$1",
            ws
        )
        .await,
        issues_before - 1
    );
    let remaining: Vec<Uuid> =
        sqlx::query_scalar("SELECT id FROM issues WHERE workspace_id=$1 ORDER BY number")
            .bind(ws)
            .fetch_all(&store.pool)
            .await
            .unwrap();
    assert_eq!(remaining, vec![blocker, dependent, child, recent]);
    let parent: Option<Uuid> = sqlx::query_scalar("SELECT parent_id FROM issues WHERE id=$1")
        .bind(child)
        .fetch_one(&store.pool)
        .await
        .unwrap();
    assert_eq!(parent, None, "the live child loses its purged parent");
    assert_eq!(
        count(
            &store,
            "SELECT count(*) FROM issue_dependencies WHERE issue_id=$1 OR dependency_id=$1",
            doomed
        )
        .await,
        0
    );
    for sql in [
        "SELECT count(*) FROM notifications WHERE issue_id=$1",
        "SELECT count(*) FROM attachments WHERE issue_id=$1",
        "SELECT count(*) FROM activity WHERE entity_id=$1",
    ] {
        assert_eq!(count(&store, sql, doomed).await, 0, "{sql}");
    }
    for id in [comment, time] {
        assert_eq!(
            count(
                &store,
                "SELECT count(*) FROM activity WHERE entity_id=$1",
                id
            )
            .await,
            0,
            "activity about the purged issue's comments and time goes too"
        );
    }
    assert_eq!(
        kept_activity(&store, &kept).await,
        kept_before,
        "issues that stay keep all their history, including deleted comments and time"
    );

    assert_eq!(store.purge_trash().await.unwrap(), 0);

    store.pool.close().await;
    database.cleanup().await;
}

#[tokio::test]
async fn purged_issue_numbers_are_not_reused() {
    let database = support::TestDatabase::new().await;
    let store = Store::connect(&database.url).await.unwrap();
    let owner = account(&store, "owner").await;
    let ws = Uuid::parse_str(
        store
            .create_workspace("Numbers".into(), owner)
            .await
            .unwrap()["id"]
            .as_str()
            .unwrap(),
    )
    .unwrap();
    let team = run(
        &store,
        ws,
        owner,
        json!({"type":"create_team","name":"Infra","key":"INF","members":[owner]}),
    )
    .await
    .unwrap();
    let create = json!({"type":"create_issue","input":{"team_id":team,"title":"Work"}});
    run(&store, ws, owner, create.clone()).await;
    let last = run(&store, ws, owner, create.clone()).await.unwrap();
    let number = |id: Uuid| {
        let pool = store.pool.clone();
        async move {
            sqlx::query_scalar::<_, i64>("SELECT number FROM issues WHERE id=$1")
                .bind(id)
                .fetch_one(&pool)
                .await
                .unwrap()
        }
    };
    let other_ws = Uuid::parse_str(
        store.create_workspace("Other".into(), owner).await.unwrap()["id"]
            .as_str()
            .unwrap(),
    )
    .unwrap();
    let other_team = run(
        &store,
        other_ws,
        owner,
        json!({"type":"create_team","name":"Ops","key":"OPS","members":[owner]}),
    )
    .await
    .unwrap();
    let other = run(
        &store,
        other_ws,
        owner,
        json!({"type":"create_issue","input":{"team_id":other_team,"title":"Old"}}),
    )
    .await
    .unwrap();
    let purged = number(last).await;
    trash(&store, ws, owner, last, 31).await;
    trash(&store, other_ws, owner, other, 40).await;
    blackwall::jobs::tick(&store, &blackwall::jobs::Mailer::Disabled)
        .await
        .unwrap();
    let left: i64 = sqlx::query_scalar("SELECT count(*) FROM issues WHERE id=ANY($1)")
        .bind(vec![last, other])
        .fetch_one(&store.pool)
        .await
        .unwrap();
    assert_eq!(left, 0);

    let next = run(&store, ws, owner, create).await.unwrap();
    assert_eq!(number(next).await, purged + 1);

    store.pool.close().await;
    database.cleanup().await;
}
