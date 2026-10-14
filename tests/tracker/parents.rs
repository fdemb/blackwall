use super::*;

fn by_wp(list: &[Value], wp: i64) -> &Value {
    list.iter()
        .find(|issue| {
            issue["tracker"]["remote_id"]
                .as_str()
                .and_then(|id| id.parse().ok())
                == Some(wp)
        })
        .unwrap()
}

async fn create(
    app: &Router,
    owner: &Session,
    workspace: Uuid,
    url: &str,
    projects: Value,
) -> String {
    let base = format!("/api/workspaces/{workspace}/trackers/connections");
    let (status, config) = call(
        app,
        owner,
        "POST",
        &base,
        Some(json!({"provider":"openproject","name":"Parents","base_url":url,"token":TOKEN,"projects":projects})),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{config}");
    format!("{base}/{}", config["id"].as_str().unwrap())
}

async fn sync_now(app: &Router, owner: &Session, action: &str, store: &Store) {
    let (status, _) = call(app, owner, "POST", &format!("{action}/sync"), None).await;
    assert_eq!(status, StatusCode::ACCEPTED);
    drain(store).await;
}

async fn version(store: &Store, workspace: Uuid, wp: i64) -> i64 {
    sqlx::query_scalar(
        "SELECT version FROM issues WHERE workspace_id=$1 AND tracker->>'remote_id'=$2",
    )
    .bind(workspace)
    .bind(wp.to_string())
    .fetch_one(&store.pool)
    .await
    .unwrap()
}

fn issue_id(list: &[Value], wp: i64) -> Uuid {
    Uuid::parse_str(by_wp(list, wp)["id"].as_str().unwrap()).unwrap()
}

#[tokio::test]
async fn same_page_child_before_parent_links_without_extra_writes() {
    let db = support::TestDatabase::new().await;
    let store = Store::connect(&db.url).await.unwrap();
    let owner = account(&store).await;
    let (workspace, team, _) = setup(&store, &owner).await;
    let app = http::router(store.clone());
    let mock = Mock::default();
    {
        let mut data = mock.data.lock().await;
        data.parents.insert(7, 8);
        data.page_size = Some(50);
    }
    let (url, server) = mock_server(mock.clone()).await;
    let action = create(
        &app,
        &owner,
        workspace,
        &url,
        json!([{"project_id":"42","team_id":team}]),
    )
    .await;
    drain(&store).await;
    let list = issues(&app, &owner, workspace).await;
    assert_eq!(list.len(), 2);
    let child = by_wp(&list, 7);
    let parent = by_wp(&list, 8);
    assert_eq!(child["parent_id"], parent["id"]);
    assert!(parent["parent_id"].is_null());
    assert_eq!(child["version"], 1);
    for id in [
        child["id"].as_str().unwrap(),
        parent["id"].as_str().unwrap(),
    ] {
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT count(*) FROM changes WHERE workspace_id=$1 AND entity='issues' AND entity_id=$2")
                .bind(workspace)
                .bind(Uuid::parse_str(id).unwrap())
                .fetch_one(&store.pool)
                .await
                .unwrap(),
            1
        );
    }
    sync_now(&app, &owner, &action, &store).await;
    let again = issues(&app, &owner, workspace).await;
    assert_eq!(by_wp(&again, 7)["version"], 1);
    assert_eq!(by_wp(&again, 8)["version"], 1);
    server.abort();
    store.pool.close().await;
    db.cleanup().await;
}

#[tokio::test]
async fn child_on_earlier_page_links_when_parent_arrives() {
    let db = support::TestDatabase::new().await;
    let store = Store::connect(&db.url).await.unwrap();
    let owner = account(&store).await;
    let (workspace, team, _) = setup(&store, &owner).await;
    let app = http::router(store.clone());
    let mock = Mock::default();
    mock.data.lock().await.parents.insert(7, 8);
    let (url, server) = mock_server(mock.clone()).await;
    create(
        &app,
        &owner,
        workspace,
        &url,
        json!([{"project_id":"42","team_id":team}]),
    )
    .await;
    drain(&store).await;
    let list = issues(&app, &owner, workspace).await;
    let child = issue_id(&list, 7);
    assert_eq!(by_wp(&list, 7)["parent_id"], by_wp(&list, 8)["id"]);
    assert_eq!(version(&store, workspace, 7).await, 2);
    assert_eq!(version(&store, workspace, 8).await, 1);
    let fields: Value = sqlx::query_scalar("SELECT fields FROM activity WHERE entity_id=$1 AND action='update_issue' ORDER BY at DESC LIMIT 1")
        .bind(child).fetch_one(&store.pool).await.unwrap();
    assert_eq!(fields, json!(["parent"]));
    server.abort();
    store.pool.close().await;
    db.cleanup().await;
}

#[tokio::test]
async fn parent_in_unmapped_project_links_after_mapping() {
    let db = support::TestDatabase::new().await;
    let store = Store::connect(&db.url).await.unwrap();
    let owner = account(&store).await;
    let (workspace, a, b) = setup(&store, &owner).await;
    let app = http::router(store.clone());
    let mock = Mock::default();
    {
        let mut data = mock.data.lock().await;
        data.moved = true;
        data.parents.insert(8, 7);
    }
    let (url, server) = mock_server(mock.clone()).await;
    let action = create(
        &app,
        &owner,
        workspace,
        &url,
        json!([{"project_id":"42","team_id":a}]),
    )
    .await;
    drain(&store).await;
    let list = issues(&app, &owner, workspace).await;
    assert_eq!(list.len(), 1);
    assert!(by_wp(&list, 8)["parent_id"].is_null());
    let (status, _) = call(
        &app,
        &owner,
        "PATCH",
        &action,
        Some(json!({"projects":[{"project_id":"42","team_id":a},{"project_id":"43","team_id":b}]})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    drain(&store).await;
    let list = issues(&app, &owner, workspace).await;
    assert_eq!(list.len(), 2);
    assert_eq!(by_wp(&list, 7)["team_id"], b.to_string());
    assert_eq!(by_wp(&list, 8)["parent_id"], by_wp(&list, 7)["id"]);
    let versions: BTreeMap<i64, i64> = list
        .iter()
        .map(|issue| {
            (
                issue["tracker"]["remote_id"]
                    .as_str()
                    .unwrap()
                    .parse::<i64>()
                    .unwrap(),
                issue["version"].as_i64().unwrap(),
            )
        })
        .collect();
    let (status, _) = call(
        &app,
        &owner,
        "PATCH",
        &action,
        Some(json!({"projects":[{"project_id":"42","team_id":a}]})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    drain(&store).await;
    let list = issues(&app, &owner, workspace).await;
    assert_eq!(
        list.len(),
        2,
        "an unmapped parent is missing data, not a deletion"
    );
    assert_eq!(by_wp(&list, 8)["parent_id"], by_wp(&list, 7)["id"]);
    for issue in &list {
        assert_eq!(
            issue["version"].as_i64().unwrap(),
            versions[&issue["tracker"]["remote_id"]
                .as_str()
                .unwrap()
                .parse::<i64>()
                .unwrap()],
            "a scan that misses the parent must not rewrite the child"
        );
    }
    server.abort();
    store.pool.close().await;
    db.cleanup().await;
}

#[tokio::test]
async fn reparenting_moves_link_and_marks_old_and_new_parents() {
    let db = support::TestDatabase::new().await;
    let store = Store::connect(&db.url).await.unwrap();
    let owner = account(&store).await;
    let (workspace, team, _) = setup(&store, &owner).await;
    let app = http::router(store.clone());
    let mock = Mock::default();
    {
        let mut data = mock.data.lock().await;
        data.extra = true;
        data.parents.insert(8, 7);
    }
    let (url, server) = mock_server(mock.clone()).await;
    let action = create(
        &app,
        &owner,
        workspace,
        &url,
        json!([{"project_id":"42","team_id":team}]),
    )
    .await;
    drain(&store).await;
    assert_eq!(
        issues(&app, &owner, workspace).await.len(),
        3,
        "extra package must be imported"
    );
    let before = version(&store, workspace, 8).await;
    let mark: i64 = sqlx::query_scalar("SELECT COALESCE(max(id),0) FROM changes")
        .fetch_one(&store.pool)
        .await
        .unwrap();
    mock.data.lock().await.parents.insert(8, 9);
    sync_now(&app, &owner, &action, &store).await;
    let list = issues(&app, &owner, workspace).await;
    assert_eq!(by_wp(&list, 8)["parent_id"], by_wp(&list, 9)["id"]);
    assert_eq!(version(&store, workspace, 8).await, before + 1);
    let child = issue_id(&list, 8);
    let fields: Value = sqlx::query_scalar("SELECT fields FROM activity WHERE entity_id=$1 AND action='update_issue' ORDER BY at DESC LIMIT 1")
        .bind(child).fetch_one(&store.pool).await.unwrap();
    assert_eq!(fields, json!(["parent", "tracker"]));
    let marked: Vec<Uuid> = sqlx::query_scalar(
        "SELECT entity_id FROM changes WHERE workspace_id=$1 AND entity='issues' AND id>$2",
    )
    .bind(workspace)
    .bind(mark)
    .fetch_all(&store.pool)
    .await
    .unwrap();
    for wp in [8, 9, 7] {
        assert!(
            marked.contains(&issue_id(&list, wp)),
            "change feed must mark the child and both parents"
        );
    }
    server.abort();
    store.pool.close().await;
    db.cleanup().await;
}

#[tokio::test]
async fn parent_removal_clears_link() {
    let db = support::TestDatabase::new().await;
    let store = Store::connect(&db.url).await.unwrap();
    let owner = account(&store).await;
    let (workspace, team, _) = setup(&store, &owner).await;
    let app = http::router(store.clone());
    let mock = Mock::default();
    mock.data.lock().await.parents.insert(8, 7);
    let (url, server) = mock_server(mock.clone()).await;
    let action = create(
        &app,
        &owner,
        workspace,
        &url,
        json!([{"project_id":"42","team_id":team}]),
    )
    .await;
    drain(&store).await;
    assert_eq!(
        by_wp(&issues(&app, &owner, workspace).await, 8)["parent_id"],
        by_wp(&issues(&app, &owner, workspace).await, 7)["id"]
    );
    let before = version(&store, workspace, 8).await;
    mock.data.lock().await.parents.clear();
    sync_now(&app, &owner, &action, &store).await;
    let list = issues(&app, &owner, workspace).await;
    assert!(by_wp(&list, 8)["parent_id"].is_null());
    assert_eq!(version(&store, workspace, 8).await, before + 1);
    server.abort();
    store.pool.close().await;
    db.cleanup().await;
}

#[tokio::test]
async fn three_level_chain_links_on_a_single_page() {
    let db = support::TestDatabase::new().await;
    let store = Store::connect(&db.url).await.unwrap();
    let owner = account(&store).await;
    let (workspace, team, _) = setup(&store, &owner).await;
    let app = http::router(store.clone());
    let mock = Mock::default();
    {
        let mut data = mock.data.lock().await;
        data.extra = true;
        data.parents.insert(8, 7);
        data.parents.insert(9, 8);
        data.page_size = Some(50);
    }
    let (url, server) = mock_server(mock.clone()).await;
    create(
        &app,
        &owner,
        workspace,
        &url,
        json!([{"project_id":"42","team_id":team}]),
    )
    .await;
    drain(&store).await;
    let list = issues(&app, &owner, workspace).await;
    assert_eq!(list.len(), 3);
    assert_eq!(by_wp(&list, 9)["parent_id"], by_wp(&list, 8)["id"]);
    assert_eq!(by_wp(&list, 8)["parent_id"], by_wp(&list, 7)["id"]);
    assert!(by_wp(&list, 7)["parent_id"].is_null());
    for wp in [7, 8, 9] {
        assert_eq!(by_wp(&list, wp)["version"], 1);
    }
    server.abort();
    store.pool.close().await;
    db.cleanup().await;
}

#[tokio::test]
async fn three_level_chain_converges_across_single_item_pages() {
    let db = support::TestDatabase::new().await;
    let store = Store::connect(&db.url).await.unwrap();
    let owner = account(&store).await;
    let (workspace, team, _) = setup(&store, &owner).await;
    let app = http::router(store.clone());
    let mock = Mock::default();
    {
        let mut data = mock.data.lock().await;
        data.extra = true;
        data.parents.insert(8, 7);
        data.parents.insert(9, 8);
    }
    let (url, server) = mock_server(mock.clone()).await;
    create(
        &app,
        &owner,
        workspace,
        &url,
        json!([{"project_id":"42","team_id":team}]),
    )
    .await;
    drain(&store).await;
    let list = issues(&app, &owner, workspace).await;
    assert_eq!(list.len(), 3);
    assert_eq!(by_wp(&list, 9)["parent_id"], by_wp(&list, 8)["id"]);
    assert_eq!(by_wp(&list, 8)["parent_id"], by_wp(&list, 7)["id"]);
    assert!(by_wp(&list, 7)["parent_id"].is_null());
    server.abort();
    store.pool.close().await;
    db.cleanup().await;
}

#[tokio::test]
async fn incremental_scan_relinks_child_from_a_single_item() {
    let db = support::TestDatabase::new().await;
    let store = Store::connect(&db.url).await.unwrap();
    let owner = account(&store).await;
    let (workspace, team, _) = setup(&store, &owner).await;
    let app = http::router(store.clone());
    let mock = Mock::default();
    {
        let mut data = mock.data.lock().await;
        data.extra = true;
        data.parents.insert(8, 7);
    }
    let (url, server) = mock_server(mock.clone()).await;
    create(
        &app,
        &owner,
        workspace,
        &url,
        json!([{"project_id":"42","team_id":team}]),
    )
    .await;
    drain(&store).await;
    let list = issues(&app, &owner, workspace).await;
    assert_eq!(by_wp(&list, 8)["parent_id"], by_wp(&list, 7)["id"]);
    let before = version(&store, workspace, 8).await;
    let untouched = version(&store, workspace, 7).await;
    let new_parent = version(&store, workspace, 9).await;
    {
        let mut data = mock.data.lock().await;
        data.parents.insert(8, 9);
        data.incremental_items = Some(vec![
            json!({"id":8,"subject":"Closed package","_links":{"project":{"href":"/api/v3/projects/42"},"status":{"href":"/api/v3/statuses/2"}}}),
        ]);
    }
    sqlx::query(
        "UPDATE tracker_connections SET next_run_at=clock_timestamp() WHERE workspace_id=$1",
    )
    .bind(workspace)
    .execute(&store.pool)
    .await
    .unwrap();
    drain(&store).await;
    assert_eq!(mock.data.lock().await.incremental_requests, 1);
    let list = issues(&app, &owner, workspace).await;
    assert_eq!(by_wp(&list, 8)["parent_id"], by_wp(&list, 9)["id"]);
    assert_eq!(version(&store, workspace, 8).await, before + 1);
    assert_eq!(version(&store, workspace, 7).await, untouched);
    assert_eq!(version(&store, workspace, 9).await, new_parent);
    server.abort();
    store.pool.close().await;
    db.cleanup().await;
}

#[tokio::test]
async fn swap_reparent_converges_across_pages() {
    let db = support::TestDatabase::new().await;
    let store = Store::connect(&db.url).await.unwrap();
    let owner = account(&store).await;
    let (workspace, team, _) = setup(&store, &owner).await;
    let app = http::router(store.clone());
    let mock = Mock::default();
    mock.data.lock().await.parents.insert(8, 7);
    let (url, server) = mock_server(mock.clone()).await;
    let action = create(
        &app,
        &owner,
        workspace,
        &url,
        json!([{"project_id":"42","team_id":team}]),
    )
    .await;
    drain(&store).await;
    assert_eq!(version(&store, workspace, 7).await, 1);
    assert_eq!(version(&store, workspace, 8).await, 1);
    {
        let mut data = mock.data.lock().await;
        data.parents.clear();
        data.parents.insert(7, 8);
    }
    sync_now(&app, &owner, &action, &store).await;
    let list = issues(&app, &owner, workspace).await;
    assert_eq!(by_wp(&list, 7)["parent_id"], by_wp(&list, 8)["id"]);
    assert!(by_wp(&list, 8)["parent_id"].is_null());
    // Page one keeps 8's unchanged stored parent and only records 7's remote parent;
    // page two clears 8, and 7 links as its dependent.
    assert_eq!(version(&store, workspace, 7).await, 3);
    assert_eq!(version(&store, workspace, 8).await, 2);
    server.abort();
    store.pool.close().await;
    db.cleanup().await;
}

#[tokio::test]
async fn cyclic_remote_leaves_parents_empty_until_a_later_scan() {
    let db = support::TestDatabase::new().await;
    let store = Store::connect(&db.url).await.unwrap();
    let owner = account(&store).await;
    let (workspace, team, _) = setup(&store, &owner).await;
    let app = http::router(store.clone());
    let mock = Mock::default();
    {
        let mut data = mock.data.lock().await;
        data.parents.insert(7, 8);
        data.parents.insert(8, 7);
        data.page_size = Some(50);
    }
    let (url, server) = mock_server(mock.clone()).await;
    let action = create(
        &app,
        &owner,
        workspace,
        &url,
        json!([{"project_id":"42","team_id":team}]),
    )
    .await;
    drain(&store).await;
    let list = issues(&app, &owner, workspace).await;
    assert!(
        by_wp(&list, 7)["parent_id"].is_null() && by_wp(&list, 8)["parent_id"].is_null(),
        "a cyclic remote must leave both sides unlinked, not fail the page"
    );
    mock.data.lock().await.parents.remove(&8);
    sync_now(&app, &owner, &action, &store).await;
    let list = issues(&app, &owner, workspace).await;
    assert_eq!(by_wp(&list, 7)["parent_id"], by_wp(&list, 8)["id"]);
    assert!(by_wp(&list, 8)["parent_id"].is_null());
    server.abort();
    store.pool.close().await;
    db.cleanup().await;
}

#[tokio::test]
async fn parent_links_stay_within_their_connection() {
    let db = support::TestDatabase::new().await;
    let store = Store::connect(&db.url).await.unwrap();
    let owner = account(&store).await;
    let (workspace, a, b) = setup(&store, &owner).await;
    let app = http::router(store.clone());
    let linked = Mock::default();
    linked.data.lock().await.parents.insert(8, 7);
    let (linked_url, linked_server) = mock_server(linked.clone()).await;
    let plain = Mock::default();
    let (plain_url, plain_server) = mock_server(plain.clone()).await;
    let linked_action = create(
        &app,
        &owner,
        workspace,
        &linked_url,
        json!([{"project_id":"42","team_id":a}]),
    )
    .await;
    let plain_action = create(
        &app,
        &owner,
        workspace,
        &plain_url,
        json!([{"project_id":"42","team_id":b}]),
    )
    .await;
    drain(&store).await;
    let linked_id = linked_action.rsplit('/').next().unwrap();
    let plain_id = plain_action.rsplit('/').next().unwrap();
    let list = issues(&app, &owner, workspace).await;
    assert_eq!(list.len(), 4);
    let at = |conn: &str, wp: i64| {
        list.iter()
            .find(|issue| {
                issue["tracker"]["connection_id"] == conn
                    && issue["tracker"]["remote_id"]
                        .as_str()
                        .and_then(|id| id.parse().ok())
                        == Some(wp)
            })
            .unwrap()
            .clone()
    };
    let parent = at(linked_id, 7);
    let child = at(linked_id, 8);
    assert_eq!(child["parent_id"], parent["id"]);
    assert!(parent["parent_id"].is_null());
    let foreign_parent = at(plain_id, 7);
    let foreign_child = at(plain_id, 8);
    assert!(
        foreign_child["parent_id"].is_null(),
        "a connection without a remote parent must not borrow another connection's issue"
    );
    assert!(foreign_parent["parent_id"].is_null());
    assert_ne!(child["parent_id"], foreign_parent["id"]);
    linked_server.abort();
    plain_server.abort();
    store.pool.close().await;
    db.cleanup().await;
}

#[tokio::test]
async fn local_issues_can_use_imported_parents() {
    let db = support::TestDatabase::new().await;
    let store = Store::connect(&db.url).await.unwrap();
    let owner = account(&store).await;
    let (workspace, team, _) = setup(&store, &owner).await;
    let app = http::router(store.clone());
    let mock = Mock::default();
    mock.data.lock().await.parents.insert(8, 7);
    let (url, server) = mock_server(mock.clone()).await;
    let action = create(
        &app,
        &owner,
        workspace,
        &url,
        json!([{"project_id":"42","team_id":team}]),
    )
    .await;
    drain(&store).await;
    let list = issues(&app, &owner, workspace).await;
    let imported = by_wp(&list, 8)["id"].as_str().unwrap().to_owned();
    let team_id = by_wp(&list, 8)["team_id"].as_str().unwrap().to_owned();
    let stage_id = by_wp(&list, 8)["stage_id"].as_str().unwrap().to_owned();
    let (status, value) = call(
        &app,
        &owner,
        "POST",
        &format!("/api/workspaces/{workspace}/commands"),
        Some(json!({"expected_versions":{},"command":{"type":"create_issue","input":{"team_id":team_id,"stage_id":stage_id,"title":"Local","parent_id":imported,"dependencies":[imported]}}})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{value}");
    sync_now(&app, &owner, &action, &store).await;
    let local = issues(&app, &owner, workspace)
        .await
        .into_iter()
        .find(|issue| issue["title"] == "Local")
        .unwrap();
    assert_eq!(local["parent_id"], imported.as_str());
    assert_eq!(local["dependencies"], json!([imported]));
    server.abort();
    store.pool.close().await;
    db.cleanup().await;
}

#[tokio::test]
async fn late_parent_links_many_earlier_children_in_one_page() {
    const CHILDREN: i64 = 299;
    let db = support::TestDatabase::new().await;
    let store = Store::connect(&db.url).await.unwrap();
    let owner = account(&store).await;
    let (workspace, team, _) = setup(&store, &owner).await;
    let app = http::router(store.clone());
    let mock = Mock::default();
    {
        let mut data = mock.data.lock().await;
        data.missing = true;
        data.bulk_count = (CHILDREN + 1) as usize;
        data.page_size = Some(50);
        for index in 0..CHILDREN {
            data.parents.insert(100 + index, 100 + CHILDREN);
        }
    }
    let (url, server) = mock_server(mock.clone()).await;
    create(
        &app,
        &owner,
        workspace,
        &url,
        json!([{"project_id":"42","team_id":team}]),
    )
    .await;
    drain(&store).await;
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM issues WHERE workspace_id=$1")
        .bind(workspace)
        .fetch_one(&store.pool)
        .await
        .unwrap();
    assert_eq!(count, CHILDREN + 1);
    let parent: Uuid = sqlx::query_scalar(
        "SELECT id FROM issues WHERE workspace_id=$1 AND tracker->>'remote_id'=$2",
    )
    .bind(workspace)
    .bind((100 + CHILDREN).to_string())
    .fetch_one(&store.pool)
    .await
    .unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM issues WHERE workspace_id=$1 AND parent_id IS NULL"
        )
        .bind(workspace)
        .fetch_one(&store.pool)
        .await
        .unwrap(),
        1
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM issues WHERE workspace_id=$1 AND id!=$2 AND parent_id IS DISTINCT FROM $2"
        )
        .bind(workspace)
        .bind(parent)
        .fetch_one(&store.pool)
        .await
        .unwrap(),
        0,
        "every earlier child must link once the parent arrives"
    );
    server.abort();
    store.pool.close().await;
    db.cleanup().await;
}

#[tokio::test]
async fn exported_parent_links_reimport_as_local() {
    let db = support::TestDatabase::new().await;
    let store = Store::connect(&db.url).await.unwrap();
    let owner = account(&store).await;
    let (workspace, team, _) = setup(&store, &owner).await;
    let app = http::router(store.clone());
    let mock = Mock::default();
    mock.data.lock().await.parents.insert(8, 7);
    let (url, server) = mock_server(mock.clone()).await;
    create(
        &app,
        &owner,
        workspace,
        &url,
        json!([{"project_id":"42","team_id":team}]),
    )
    .await;
    drain(&store).await;
    let transfer = store
        .export_transfer(workspace, owner.profile.id)
        .await
        .unwrap();
    let target = store
        .create_workspace("Transferred copy".into(), owner.profile.id)
        .await
        .unwrap();
    let target = Uuid::parse_str(target["id"].as_str().unwrap()).unwrap();
    store
        .import_transfer(target, owner.profile.id, transfer, BTreeMap::new(), None)
        .await
        .unwrap();
    let copies = issues(&app, &owner, target).await;
    assert_eq!(copies.len(), 2);
    assert!(copies.iter().all(|issue| issue["tracker"].is_null()));
    let child = copies
        .iter()
        .find(|issue| issue["title"] == "Closed package")
        .unwrap();
    let parent = copies
        .iter()
        .find(|issue| issue["title"] == "First package")
        .unwrap();
    assert_eq!(child["parent_id"], parent["id"]);
    assert!(parent["parent_id"].is_null());
    server.abort();
    store.pool.close().await;
    db.cleanup().await;
}

async fn reparent(app: &Router, owner: &Session, workspace: Uuid, child: &Value, patch: Value) {
    let (status, value) = call(
        app,
        owner,
        "POST",
        &format!("/api/workspaces/{workspace}/commands"),
        Some(
            json!({"expected_versions":{child["id"].as_str().unwrap():child["version"]},
            "command":{"type":"update_issue","id":child["id"],"patch":patch}}),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{value}");
}

#[tokio::test]
async fn remote_cycle_keeps_a_preserved_local_parent() {
    let db = support::TestDatabase::new().await;
    let store = Store::connect(&db.url).await.unwrap();
    let owner = account(&store).await;
    let (workspace, team, _) = setup(&store, &owner).await;
    let app = http::router(store.clone());
    let mock = Mock::default();
    mock.data.lock().await.page_size = Some(50);
    let (url, server) = mock_server(mock.clone()).await;
    let action = create(
        &app,
        &owner,
        workspace,
        &url,
        json!([{"project_id":"42","team_id":team}]),
    )
    .await;
    drain(&store).await;
    let list = issues(&app, &owner, workspace).await;
    // Locally 7 moves under 8; the remote, unchanged for 7, moves 8 under 7.
    reparent(
        &app,
        &owner,
        workspace,
        by_wp(&list, 7),
        json!({"parent_id":issue_id(&list, 8)}),
    )
    .await;
    mock.data.lock().await.parents.insert(8, 7);
    sync_now(&app, &owner, &action, &store).await;
    let list = issues(&app, &owner, workspace).await;
    assert_eq!(by_wp(&list, 7)["parent_id"], json!(issue_id(&list, 8)));
    assert!(by_wp(&list, 8)["parent_id"].is_null());
    // The rejected remote change stays out of the baseline, so a later scan retries it.
    reparent(
        &app,
        &owner,
        workspace,
        by_wp(&list, 7),
        json!({"clear_parent":true}),
    )
    .await;
    sync_now(&app, &owner, &action, &store).await;
    let list = issues(&app, &owner, workspace).await;
    assert_eq!(by_wp(&list, 8)["parent_id"], json!(issue_id(&list, 7)));
    assert!(by_wp(&list, 7)["parent_id"].is_null());
    server.abort();
    store.pool.close().await;
    db.cleanup().await;
}

#[tokio::test]
async fn late_parent_advances_the_baseline_while_parent_import_is_off() {
    let db = support::TestDatabase::new().await;
    let store = Store::connect(&db.url).await.unwrap();
    let owner = account(&store).await;
    let (workspace, team, _) = setup(&store, &owner).await;
    let app = http::router(store.clone());
    let mock = Mock::default();
    // Single-item pages: child 7 arrives before its parent 8.
    mock.data.lock().await.parents.insert(7, 8);
    let (url, server) = mock_server(mock.clone()).await;
    let base = format!("/api/workspaces/{workspace}/trackers/connections");
    let mut options = import_only();
    options["parent"] = json!({"import":false,"export":false});
    let (status, config) = call(
        &app,
        &owner,
        "POST",
        &base,
        Some(
            json!({"provider":"openproject","name":"Parents","base_url":url,"token":TOKEN,
            "projects":[{"project_id":"42","team_id":team}],"options":options}),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{config}");
    let action = format!("{base}/{}", config["id"].as_str().unwrap());
    drain(&store).await;
    let list = issues(&app, &owner, workspace).await;
    assert!(by_wp(&list, 7)["parent_id"].is_null());
    let baseline: Value =
        sqlx::query_scalar("SELECT tracker->'baseline'->'parent_id' FROM issues WHERE id=$1")
            .bind(issue_id(&list, 7))
            .fetch_one(&store.pool)
            .await
            .unwrap();
    assert_eq!(baseline, json!(issue_id(&list, 8)));
    // The unchanged remote parent must not overwrite the kept local value.
    let (status, value) = call(
        &app,
        &owner,
        "PATCH",
        &action,
        Some(json!({"options":{"parent":{"import":true,"export":false}}})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{value}");
    drain(&store).await;
    let list = issues(&app, &owner, workspace).await;
    assert!(by_wp(&list, 7)["parent_id"].is_null());
    server.abort();
    store.pool.close().await;
    db.cleanup().await;
}
