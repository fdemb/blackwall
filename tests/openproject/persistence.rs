use super::*;

#[tokio::test]
async fn sync_persists_reminders_changes_and_completion_atomically() {
    let db = support::TestDatabase::new().await;
    let store = Store::connect(&db.url).await.unwrap();
    let owner = account(&store).await;
    let (workspace, team, _) = setup(&store, &owner).await;
    sqlx::query("INSERT INTO integrations(id,workspace_id,name,webhook_url,secret) VALUES($1,$2,'Test events','https://example.com/events','test-secret')")
        .bind(Uuid::new_v4()).bind(workspace).execute(&store.pool).await.unwrap();
    let app = http::router(store.clone());
    let mock = Mock::default();
    let (url, server) = mock_server(mock.clone()).await;
    let base = format!("/api/workspaces/{workspace}/openproject/connections");
    let (_, config) = call(
        &app,
        &owner,
        "POST",
        &base,
        Some(json!({
            "name":"Events", "base_url":url, "token":TOKEN,
            "projects":[{"project_id":42,"team_id":team}]
        })),
    )
    .await;
    assert_eq!(config["status"], "pending");
    let connection = Uuid::parse_str(config["id"].as_str().unwrap()).unwrap();
    let action = format!("{base}/{connection}");
    drain(&store).await;
    let imported = issues(&app, &owner, workspace).await;
    let first = imported
        .iter()
        .find(|i| i["openproject"]["work_package_id"] == 7)
        .unwrap();
    let issue = Uuid::parse_str(first["id"].as_str().unwrap()).unwrap();
    assert_eq!(first["version"], 1);
    let reminder: i64 = sqlx::query_scalar("SELECT reminder_generation FROM issues WHERE id=$1")
        .bind(issue)
        .fetch_one(&store.pool)
        .await
        .unwrap();
    assert_eq!(reminder, 2);
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM jobs WHERE queue='database' AND payload->>'issue_id'=$1"
        )
        .bind(issue.to_string())
        .fetch_one(&store.pool)
        .await
        .unwrap(),
        1
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM activity WHERE workspace_id=$1 AND action='issue_completed'"
        )
        .bind(workspace)
        .fetch_one(&store.pool)
        .await
        .unwrap(),
        1
    );
    assert_eq!(sqlx::query_scalar::<_, i64>("SELECT count(*) FROM jobs WHERE queue='webhook' AND payload->'event'->'activity'->>'action'='issue_completed'")
        .fetch_one(&store.pool).await.unwrap(), 1);
    sqlx::query("INSERT INTO issue_followers(workspace_id,issue_id,user_id) VALUES($1,$2,$3)")
        .bind(workspace)
        .bind(issue)
        .bind(owner.profile.id)
        .execute(&store.pool)
        .await
        .unwrap();

    mock.data.lock().await.deadline = Some("2026-12-10".into());
    call(&app, &owner, "POST", &format!("{action}/sync"), None).await;
    drain(&store).await;
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT reminder_generation FROM issues WHERE id=$1")
            .bind(issue)
            .fetch_one(&store.pool)
            .await
            .unwrap(),
        reminder + 1
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM notifications WHERE issue_id=$1 AND kind='change'"
        )
        .bind(issue)
        .fetch_one(&store.pool)
        .await
        .unwrap(),
        1
    );
    let fields: Value = sqlx::query_scalar("SELECT fields FROM activity WHERE entity_id=$1 AND action='update_issue' ORDER BY at DESC LIMIT 1")
        .bind(issue).fetch_one(&store.pool).await.unwrap();
    assert_eq!(fields, json!(["deadline"]));

    mock.data.lock().await.closed_first = true;
    call(&app, &owner, "POST", &format!("{action}/sync"), None).await;
    drain(&store).await;
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT reminder_generation FROM issues WHERE id=$1")
            .bind(issue)
            .fetch_one(&store.pool)
            .await
            .unwrap(),
        reminder + 2
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM activity WHERE entity_id=$1 AND action='issue_completed'"
        )
        .bind(issue)
        .fetch_one(&store.pool)
        .await
        .unwrap(),
        1
    );
    let version: i64 = sqlx::query_scalar("SELECT version FROM issues WHERE id=$1")
        .bind(issue)
        .fetch_one(&store.pool)
        .await
        .unwrap();
    call(&app, &owner, "POST", &format!("{action}/sync"), None).await;
    drain(&store).await;
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT version FROM issues WHERE id=$1")
            .bind(issue)
            .fetch_one(&store.pool)
            .await
            .unwrap(),
        version
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM notifications WHERE issue_id=$1 AND kind='change'"
        )
        .bind(issue)
        .fetch_one(&store.pool)
        .await
        .unwrap(),
        2
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM activity WHERE entity_id=$1 AND action='issue_completed'"
        )
        .bind(issue)
        .fetch_one(&store.pool)
        .await
        .unwrap(),
        1
    );

    let mut tx = store.pool.begin().await.unwrap();
    for generation in [reminder, reminder + 1, reminder + 2] {
        Store::execute_reminder(
            &mut tx,
            &blackwall::jobs::Reminder {
                workspace_id: workspace,
                issue_id: issue,
                generation,
            },
        )
        .await
        .unwrap();
    }
    tx.commit().await.unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM notifications WHERE issue_id=$1 AND kind='deadline'"
        )
        .bind(issue)
        .fetch_one(&store.pool)
        .await
        .unwrap(),
        0
    );

    // A bad second item prevents the valid first item from producing writes or events.
    {
        let mut data = mock.data.lock().await;
        data.deadline = Some("2026-12-20".into());
        data.page_size = Some(50);
        data.malformed_last = true;
    }
    call(&app, &owner, "POST", &format!("{action}/sync"), None).await;
    let mut rejected_page = false;
    for _ in 0..5 {
        openproject::schedule(&store).await.unwrap();
        let claims = store.outbox.claim("openproject", 1).await.unwrap();
        let claim = &claims[0];
        let Job::OpenProject(job) = Job::decode(&claim.kind, &claim.payload).unwrap() else {
            panic!("wrong job")
        };
        let checkpoint: Value =
            sqlx::query_scalar("SELECT checkpoint FROM openproject_connections WHERE id=$1")
                .bind(connection)
                .fetch_one(&store.pool)
                .await
                .unwrap();
        if checkpoint["phase"] == "work_packages" {
            let error = openproject::execute(&store, claim, &job).await.unwrap_err();
            assert!(openproject::failure_message(&error).contains("due date"));
            assert_eq!(
                sqlx::query_scalar::<_, Value>(
                    "SELECT checkpoint FROM openproject_connections WHERE id=$1"
                )
                .bind(connection)
                .fetch_one(&store.pool)
                .await
                .unwrap(),
                checkpoint
            );
            rejected_page = true;
            break;
        }
        openproject::execute(&store, claim, &job).await.unwrap();
    }
    assert!(rejected_page, "malformed page was not exercised");
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT version FROM issues WHERE id=$1")
            .bind(issue)
            .fetch_one(&store.pool)
            .await
            .unwrap(),
        version
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM notifications WHERE issue_id=$1 AND kind='change'"
        )
        .bind(issue)
        .fetch_one(&store.pool)
        .await
        .unwrap(),
        2
    );
    server.abort();
    store.pool.close().await;
    db.cleanup().await;
}

#[tokio::test]
async fn empty_mapping_scan_finishes_and_invalid_checkpoint_never_fetches_unfiltered_packages() {
    let db = support::TestDatabase::new().await;
    let store = Store::connect(&db.url).await.unwrap();
    let owner = account(&store).await;
    let (workspace, _, _) = setup(&store, &owner).await;
    let app = http::router(store.clone());
    let mock = Mock::default();
    let (url, server) = mock_server(mock.clone()).await;
    let base = format!("/api/workspaces/{workspace}/openproject/connections");
    let (status, config) = call(
        &app,
        &owner,
        "POST",
        &base,
        Some(json!({"name":"Discovery only","base_url":url,"token":TOKEN})),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let connection = Uuid::parse_str(config["id"].as_str().unwrap()).unwrap();
    drain(&store).await;
    assert_eq!(mock.data.lock().await.requests, 4);
    assert!(issues(&app, &owner, workspace).await.is_empty());
    let synced: Option<chrono::DateTime<chrono::Utc>> = sqlx::query_scalar(
        "SELECT last_synced_at FROM openproject_connections WHERE id=$1 AND status='idle'",
    )
    .bind(connection)
    .fetch_one(&store.pool)
    .await
    .unwrap();
    assert!(synced.is_some());
    call(
        &app,
        &owner,
        "POST",
        &format!("{base}/{connection}/refresh"),
        None,
    )
    .await;
    drain(&store).await;
    assert_eq!(mock.data.lock().await.requests, 8);
    assert_eq!(
        sqlx::query_scalar::<_, Option<chrono::DateTime<chrono::Utc>>>(
            "SELECT last_synced_at FROM openproject_connections WHERE id=$1 AND status='idle'"
        )
        .bind(connection)
        .fetch_one(&store.pool)
        .await
        .unwrap(),
        synced
    );

    sqlx::query("UPDATE openproject_connections SET checkpoint=$2,next_run_at=clock_timestamp() WHERE id=$1")
        .bind(connection).bind(json!({"phase":"work_packages","page":1,"project_index":0})).execute(&store.pool).await.unwrap();
    openproject::schedule(&store).await.unwrap();
    let claims = store.outbox.claim("openproject", 1).await.unwrap();
    let claim = &claims[0];
    let Job::OpenProject(job) = Job::decode(&claim.kind, &claim.payload).unwrap() else {
        panic!("wrong job")
    };
    let error = openproject::execute(&store, claim, &job).await.unwrap_err();
    assert!(openproject::failure_message(&error).contains("checkpoint"));
    assert_eq!(mock.data.lock().await.requests, 8);
    server.abort();
    store.pool.close().await;
    db.cleanup().await;
}
