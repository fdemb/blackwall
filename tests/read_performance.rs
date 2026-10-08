mod support;
use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use blackwall::{
    auth::Register,
    domain::{Command, IssueFilter},
    http,
    store::Store,
};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use std::collections::BTreeMap;
use tower::ServiceExt;
use uuid::Uuid;

async fn setup() -> (
    support::TestDatabase,
    Store,
    blackwall::auth::Session,
    Uuid,
    Uuid,
) {
    let db = support::TestDatabase::new().await;
    let store = Store::connect(&db.url).await.unwrap();
    let owner = store
        .register(Register {
            email: format!("{}@example.com", Uuid::new_v4()),
            password: "test-password-123".into(),
            display_name: "Reader".into(),
        })
        .await
        .unwrap();
    let workspace = store
        .create_workspace("Read tests".into(), owner.profile.id)
        .await
        .unwrap();
    let workspace = Uuid::parse_str(workspace["id"].as_str().unwrap()).unwrap();
    let team = store
        .operation(
            workspace,
            owner.profile.id,
            Command::CreateTeam {
                id: None,
                name: "Team".into(),
                members: vec![],
            },
            BTreeMap::new(),
            None,
            None,
        )
        .await
        .unwrap()
        .result
        .id
        .unwrap();
    (db, store, owner, workspace, team)
}

async fn create(
    store: &Store,
    workspace: Uuid,
    actor: Uuid,
    team: Uuid,
    title: &str,
    description: &str,
) -> Uuid {
    let command: Command = serde_json::from_value(json!({"type":"create_issue","input":{"team_id":team,"title":title,"description":description}})).unwrap();
    store
        .operation(workspace, actor, command, BTreeMap::new(), None, None)
        .await
        .unwrap()
        .result
        .id
        .unwrap()
}

fn filter(value: Value) -> IssueFilter {
    serde_json::from_value(value).unwrap()
}

#[tokio::test]
async fn search_union_preserves_fulltext_substring_numbers_and_literal_characters() {
    let (db, store, owner, workspace, team) = setup().await;
    create(
        &store,
        workspace,
        owner.profile.id,
        team,
        "Plain title",
        "aNeedleZ in description",
    )
    .await;
    create(
        &store,
        workspace,
        owner.profile.id,
        team,
        "Literal % _ \\ characters",
        "another word",
    )
    .await;
    create(
        &store,
        workspace,
        owner.profile.id,
        team,
        "Needle title",
        "unrelated",
    )
    .await;
    for search in [
        "Needl", "Needle", "#1", "##1", "01", "1", "a", "%", "_", "\\", " #1", "missing",
        "aNeedleZ",
    ] {
        let pattern = format!(
            "%{}%",
            search
                .replace('\\', "\\\\")
                .replace('%', "\\%")
                .replace('_', "\\_")
        );
        let mut expected:Vec<Uuid>=sqlx::query_scalar("SELECT id FROM issues WHERE workspace_id=$1 AND deleted_at IS NULL AND archived_at IS NULL AND (to_tsvector('simple',title || ' ' || description) @@ plainto_tsquery('simple',$2) OR title || ' ' || description ILIKE $3 OR number::text=$4)")
            .bind(workspace).bind(search).bind(pattern).bind(search.trim_start_matches('#'))
            .fetch_all(&store.pool).await.unwrap();
        let result = store
            .list_issues(
                workspace,
                owner.profile.id,
                filter(json!({"search":search})),
                200,
                0,
            )
            .await
            .unwrap();
        let mut actual: Vec<Uuid> = result["items"]
            .as_array()
            .unwrap()
            .iter()
            .map(|item| Uuid::parse_str(item["id"].as_str().unwrap()).unwrap())
            .collect();
        expected.sort();
        actual.sort();
        assert_eq!(actual, expected, "search {search:?}");
    }
    store.pool.close().await;
    db.cleanup().await;
}

#[tokio::test]
async fn summary_is_opt_in_and_full_detail_and_changefeed_keep_complete_records() {
    let (db, store, owner, workspace, team) = setup().await;
    let cursor = store
        .changes(workspace, owner.profile.id, None)
        .await
        .unwrap()
        .cursor;
    let id = create(
        &store,
        workspace,
        owner.profile.id,
        team,
        "Title",
        &"Large description ".repeat(2000),
    )
    .await;
    let full = store
        .list_issues(workspace, owner.profile.id, filter(json!({})), 10, 0)
        .await
        .unwrap();
    let summary = store
        .list_issues(
            workspace,
            owner.profile.id,
            filter(json!({"projection":"summary"})),
            10,
            0,
        )
        .await
        .unwrap();
    let record = &summary["items"][0];
    for omitted in [
        "description",
        "dependencies",
        "followers",
        "attachments",
        "source_links",
    ] {
        assert!(record.get(omitted).is_none(), "{omitted} was not omitted");
        assert!(
            full["items"][0].get(omitted).is_some(),
            "{omitted} missing from full response"
        );
    }
    for (key, value) in record.as_object().unwrap() {
        assert_eq!(value, &full["items"][0][key], "{key}");
    }
    assert!(summary.to_string().len() * 5 < full.to_string().len());
    assert!(
        !store
            .get_issue(workspace, owner.profile.id, id)
            .await
            .unwrap()
            .description
            .is_empty()
    );
    let feed = store
        .changes(workspace, owner.profile.id, Some(&cursor))
        .await
        .unwrap();
    let changed = feed
        .changes
        .iter()
        .find(|change| change.entity == "issues" && change.id == id)
        .unwrap();
    assert!(
        changed.record.as_ref().unwrap()["description"]
            .as_str()
            .unwrap()
            .len()
            > 1000
    );

    let app = http::router(store.clone());
    let response = app
        .oneshot(
            Request::builder()
                .uri(format!(
                    "/api/workspaces/{workspace}/issues?projection=summary&sort=updated&limit=1"
                ))
                .header("Authorization", format!("Bearer {}", owner.token))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let page: Value = serde_json::from_slice(&bytes).unwrap();
    assert!(page["items"][0].get("description").is_none());
    store.pool.close().await;
    db.cleanup().await;
}

#[tokio::test]
async fn search_and_updated_indexes_support_the_query_predicates() {
    let (db, store, owner, workspace, team) = setup().await;
    let stage: Uuid =
        sqlx::query_scalar("SELECT id FROM stages WHERE team_id=$1 ORDER BY position,id LIMIT 1")
            .bind(team)
            .fetch_one(&store.pool)
            .await
            .unwrap();
    sqlx::query("INSERT INTO issues(id,workspace_id,number,title,description,team_id,stage_id,priority,position,created_at,updated_at) SELECT gen_random_uuid(),$1,n,'Common title',CASE WHEN n=5000 THEN 'PerformanceNeedle' ELSE 'Ordinary description' END,$2,$3,'none',n*1024,now(),now()-make_interval(secs=>n) FROM generate_series(1,5000) AS input(n)")
        .bind(workspace).bind(team).bind(stage).execute(&store.pool).await.unwrap();
    // Flush fresh GIN pending entries before checking the steady-state plan.
    // A sequential scan can be cheaper immediately after a bulk load.
    sqlx::query("VACUUM (ANALYZE) issues")
        .execute(&store.pool)
        .await
        .unwrap();
    let substring:Value=sqlx::query_scalar("EXPLAIN (FORMAT JSON) SELECT id FROM issues WHERE workspace_id=$1 AND (title || ' ' || description) ILIKE '%PerformanceNeedl%'")
        .bind(workspace).fetch_one(&store.pool).await.unwrap();
    assert!(
        substring.to_string().contains("issues_substring_search"),
        "{substring}"
    );
    let number: Value = sqlx::query_scalar(
        "EXPLAIN (FORMAT JSON) SELECT id FROM issues WHERE workspace_id=$1 AND number=4999",
    )
    .bind(workspace)
    .fetch_one(&store.pool)
    .await
    .unwrap();
    assert!(
        number
            .to_string()
            .contains("issues_workspace_id_number_key"),
        "{number}"
    );
    let updated:Value=sqlx::query_scalar("EXPLAIN (FORMAT JSON) SELECT id FROM issues WHERE workspace_id=$1 AND deleted_at IS NULL AND archived_at IS NULL AND updated_at<=now()-interval '1 hour' AND (updated_at<now()-interval '1 hour' OR (updated_at=now()-interval '1 hour' AND id>$2)) ORDER BY updated_at DESC,id LIMIT 50")
        .bind(workspace).bind(Uuid::nil()).fetch_one(&store.pool).await.unwrap();
    assert!(
        updated.to_string().contains("issues_updated_active"),
        "{updated}"
    );
    assert!(updated.to_string().contains("Index Cond"), "{updated}");
    let result = store
        .list_issues(
            workspace,
            owner.profile.id,
            filter(json!({"search":"PerformanceNeedl","projection":"summary"})),
            10,
            0,
        )
        .await
        .unwrap();
    assert_eq!(result["items"].as_array().unwrap().len(), 1);
    store.pool.close().await;
    db.cleanup().await;
}

#[tokio::test]
async fn updated_cursors_handle_ties_and_reject_wrong_scope_or_invalid_modes() {
    let (db, store, owner, workspace, team) = setup().await;
    let mut ids = vec![];
    for index in 0..7 {
        ids.push(
            create(
                &store,
                workspace,
                owner.profile.id,
                team,
                &format!("Issue {index}"),
                "",
            )
            .await,
        );
    }
    sqlx::query("UPDATE issues SET updated_at='2026-01-01T00:00:00Z' WHERE workspace_id=$1")
        .bind(workspace)
        .execute(&store.pool)
        .await
        .unwrap();
    let first = store
        .list_issues(
            workspace,
            owner.profile.id,
            filter(json!({"sort":"updated"})),
            2,
            0,
        )
        .await
        .unwrap();
    assert_eq!(first["has_more"], true);
    let token = first["next_cursor"].as_str().unwrap();
    for invalid in [
        json!({"sort":"updated","after":token,"search":"Issue"}),
        json!({"sort":"position","after":token}),
        json!({"sort":"updated","group_by":"stage","after":token}),
        json!({"sort":"updated","after":"malformed!"}),
    ] {
        assert!(
            store
                .list_issues(workspace, owner.profile.id, filter(invalid), 2, 0)
                .await
                .is_err()
        );
    }
    assert!(
        store
            .list_issues(
                workspace,
                owner.profile.id,
                filter(json!({"sort":"updated","after":token})),
                2,
                1
            )
            .await
            .is_err()
    );
    let other = store
        .create_workspace("Other".into(), owner.profile.id)
        .await
        .unwrap();
    let other = Uuid::parse_str(other["id"].as_str().unwrap()).unwrap();
    assert!(
        store
            .list_issues(
                other,
                owner.profile.id,
                filter(json!({"sort":"updated","after":token})),
                2,
                0
            )
            .await
            .is_err()
    );
    let mut after = None;
    let mut seen = vec![];
    loop {
        let result = store
            .list_issues(
                workspace,
                owner.profile.id,
                filter(json!({"sort":"updated","after":after,"projection":"summary"})),
                2,
                0,
            )
            .await
            .unwrap();
        seen.extend(
            result["items"]
                .as_array()
                .unwrap()
                .iter()
                .map(|item| Uuid::parse_str(item["id"].as_str().unwrap()).unwrap()),
        );
        after = result["next_cursor"].as_str().map(str::to_owned);
        if !result["has_more"].as_bool().unwrap() {
            break;
        }
        assert!(seen.len() <= ids.len());
    }
    ids.sort();
    assert_eq!(seen, ids);
    store.pool.close().await;
    db.cleanup().await;
}
