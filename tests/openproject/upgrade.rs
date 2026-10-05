use super::*;

#[tokio::test]
async fn legacy_unmapped_checkpoint_restarts_discovery_on_upgrade() {
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
        Some(json!({"name":"Legacy scan","base_url":url,"token":TOKEN})),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let connection = Uuid::parse_str(config["id"].as_str().unwrap()).unwrap();
    sqlx::query("UPDATE openproject_connections SET checkpoint=$2 WHERE id=$1")
        .bind(connection)
        .bind(json!({"phase":"work_packages","page":1,"page_size":null,"project_index":0,"refresh_only":false}))
        .execute(&store.pool).await.unwrap();
    openproject::schedule(&store).await.unwrap();
    sqlx::raw_sql(include_str!(
        "../../migrations/0007_openproject_checkpoints.sql"
    ))
    .execute(&store.pool)
    .await
    .unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT generation FROM openproject_connections WHERE id=$1")
            .bind(connection)
            .fetch_one(&store.pool)
            .await
            .unwrap(),
        config["generation"].as_i64().unwrap() + 1
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM jobs WHERE queue='openproject' AND state='pending'"
        )
        .fetch_one(&store.pool)
        .await
        .unwrap(),
        0
    );
    drain(&store).await;
    assert_eq!(mock.data.lock().await.requests, 4);
    assert!(issues(&app, &owner, workspace).await.is_empty());
    assert_eq!(
        sqlx::query_scalar::<_, String>("SELECT status FROM openproject_connections WHERE id=$1")
            .bind(connection)
            .fetch_one(&store.pool)
            .await
            .unwrap(),
        "idle"
    );
    server.abort();
    store.pool.close().await;
    db.cleanup().await;
}
