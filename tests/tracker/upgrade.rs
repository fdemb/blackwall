use super::*;
use chrono::{DateTime, Utc};

/// Restores the pre-0028 OpenProject schema and JSON shapes, so tests can seed legacy
/// rows or replay older migrations before upgrading again.
const DOWNGRADE: &str = r#"
UPDATE issues SET tracker=jsonb_strip_nulls(jsonb_build_object(
 'connection_id',tracker->'connection_id','work_package_id',(tracker->>'remote_id')::bigint,
 'project_id',(tracker->>'project_id')::bigint,'parent_work_package_id',(tracker->>'parent_remote_id')::bigint,
 'status_name',tracker->'status_name','url',tracker->'url','unavailable',false))
WHERE tracker IS NOT NULL;
DROP INDEX issues_tracker_identity;
DROP INDEX issues_tracker_parent;
ALTER TABLE issues RENAME COLUMN tracker TO openproject;
CREATE UNIQUE INDEX issues_openproject_identity ON issues((openproject->>'connection_id'),(openproject->>'work_package_id')) WHERE openproject IS NOT NULL;
CREATE INDEX issues_openproject_parent ON issues(workspace_id,(openproject->>'connection_id'),(openproject->>'parent_work_package_id')) WHERE openproject IS NOT NULL;
DROP INDEX jobs_tracker_active;
ALTER TABLE jobs DROP CONSTRAINT jobs_queue_check;
UPDATE jobs SET queue='openproject' WHERE queue='tracker';
UPDATE jobs SET kind='openproject' WHERE kind='tracker';
ALTER TABLE jobs ADD CONSTRAINT jobs_queue_check CHECK(queue IN ('email','webhook','database','openproject'));
CREATE UNIQUE INDEX jobs_openproject_active ON jobs((payload->>'connection_id')) WHERE queue='openproject' AND state IN ('pending','running');
CREATE FUNCTION pg_temp.number_ids(items jsonb, key text) RETURNS jsonb LANGUAGE sql AS $$
 SELECT COALESCE(jsonb_agg(CASE WHEN item ? key THEN item || jsonb_build_object(key,(item->>key)::bigint) ELSE item END ORDER BY ordinality),'[]'::jsonb)
 FROM jsonb_array_elements(items) WITH ORDINALITY AS element(item,ordinality)
$$;
ALTER TABLE tracker_discovery_pages DROP CONSTRAINT tracker_discovery_pages_resource_check;
UPDATE tracker_discovery_pages SET resource='users' WHERE resource='people';
UPDATE tracker_discovery_pages SET items=pg_temp.number_ids(items,'id');
ALTER TABLE tracker_discovery_pages ADD CONSTRAINT openproject_discovery_pages_resource_check CHECK(resource IN ('projects','statuses','users'));
ALTER TABLE tracker_discovery_pages RENAME CONSTRAINT tracker_discovery_pages_pkey TO openproject_discovery_pages_pkey;
ALTER TABLE tracker_discovery_pages RENAME CONSTRAINT tracker_discovery_pages_connection_id_fkey TO openproject_discovery_pages_connection_id_fkey;
ALTER TABLE tracker_discovery_pages RENAME TO openproject_discovery_pages;
UPDATE tracker_connections SET projects=pg_temp.number_ids(projects,'project_id'),
 cached_projects=pg_temp.number_ids(cached_projects,'id'),
 cached_statuses=pg_temp.number_ids(cached_statuses,'id'),
 cached_people=pg_temp.number_ids(cached_people,'id');
DROP FUNCTION pg_temp.number_ids(jsonb,text);
ALTER TABLE tracker_connections DROP COLUMN options, DROP COLUMN provider;
ALTER INDEX tracker_due RENAME TO openproject_due;
ALTER TABLE tracker_connections RENAME CONSTRAINT tracker_connections_pkey TO openproject_connections_pkey;
ALTER TABLE tracker_connections RENAME CONSTRAINT tracker_connections_workspace_id_fkey TO openproject_connections_workspace_id_fkey;
ALTER TABLE tracker_connections RENAME TO openproject_connections;
"#;

pub(super) async fn downgrade(store: &Store) {
    sqlx::raw_sql(DOWNGRADE).execute(&store.pool).await.unwrap();
}

pub(super) async fn upgrade(store: &Store) {
    sqlx::raw_sql(include_str!("../../migrations/0028_trackers.sql"))
        .execute(&store.pool)
        .await
        .unwrap();
}

async fn legacy_job(store: &Store, connection: Uuid, generation: i64) {
    sqlx::query(
        "INSERT INTO jobs(id,kind,queue,payload) VALUES($1,'openproject','openproject',$2)",
    )
    .bind(Uuid::new_v4())
    .bind(json!({"connection_id":connection,"generation":generation}))
    .execute(&store.pool)
    .await
    .unwrap();
}

async fn scalar(store: &Store, sql: &str, connection: Uuid) -> Value {
    sqlx::query_scalar(sql)
        .bind(connection)
        .fetch_one(&store.pool)
        .await
        .unwrap()
}

#[tokio::test]
async fn tracker_upgrade_converts_connections_links_jobs_and_discovery_pages() {
    let db = support::TestDatabase::new().await;
    let store = Store::connect(&db.url).await.unwrap();
    let owner = account(&store).await;
    let (workspace, team, _) = setup(&store, &owner).await;
    let app = http::router(store.clone());
    let mock = Mock::default();
    mock.data.lock().await.parents.insert(8, 7);
    let (url, server) = mock_server(mock.clone()).await;
    let base = format!("/api/workspaces/{workspace}/trackers/connections");
    let (status, config) = call(
        &app,
        &owner,
        "POST",
        &base,
        Some(
            json!({"provider":"openproject","name":"Upgraded","base_url":url,"token":TOKEN,
            "projects":[{"project_id":"42","team_id":team}]}),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{config}");
    let connection = Uuid::parse_str(config["id"].as_str().unwrap()).unwrap();
    drain(&store).await;
    let before = issues(&app, &owner, workspace).await;
    assert_eq!(before.len(), 2);

    downgrade(&store).await;
    let legacy = scalar(
        &store,
        "SELECT openproject FROM issues WHERE openproject->>'work_package_id'='8' AND openproject->>'connection_id'=$1::text",
        connection,
    )
    .await;
    assert_eq!(legacy["parent_work_package_id"], 7);
    let generation = config["generation"].as_i64().unwrap();
    legacy_job(&store, connection, generation).await;
    sqlx::query("INSERT INTO openproject_discovery_pages(connection_id,generation,resource,page,items) VALUES($1,$2,'users',1,$3)")
        .bind(connection).bind(generation).bind(json!([{"id":10,"name":"Remote","email":null}]))
        .execute(&store.pool).await.unwrap();
    upgrade(&store).await;

    let row = scalar(
        &store,
        "SELECT to_jsonb(c)-'token' FROM tracker_connections c WHERE id=$1",
        connection,
    )
    .await;
    assert_eq!(row["provider"], "openproject");
    for field in [
        "status",
        "title",
        "description",
        "assignee",
        "due_date",
        "priority",
        "parent",
        "comments",
    ] {
        assert_eq!(row["options"][field], json!({"import":true,"export":false}));
    }
    assert_eq!(row["projects"][0]["project_id"], "42");
    assert_eq!(row["cached_projects"][0]["id"], "42");
    assert_eq!(row["cached_statuses"][0]["id"], "1");
    assert_eq!(row["cached_people"][0]["id"], "10");
    let page = scalar(
        &store,
        "SELECT jsonb_build_object('resource',resource,'items',items) FROM tracker_discovery_pages WHERE connection_id=$1",
        connection,
    )
    .await;
    assert_eq!(page["resource"], "people");
    assert_eq!(page["items"][0]["id"], "10");
    let jobs = scalar(
        &store,
        "SELECT jsonb_agg(jsonb_build_array(queue,kind,state)) FROM jobs WHERE payload->>'connection_id'=$1::text",
        connection,
    )
    .await;
    assert!(
        jobs.as_array()
            .unwrap()
            .contains(&json!(["tracker", "tracker", "pending"]))
    );
    let link = scalar(
        &store,
        "SELECT tracker FROM issues WHERE tracker->>'remote_id'='8' AND tracker->>'connection_id'=$1::text",
        connection,
    )
    .await;
    let child = before
        .iter()
        .find(|issue| issue["tracker"]["remote_id"] == "8")
        .unwrap();
    assert_eq!(
        link,
        json!({"provider":"openproject","connection_id":connection,"remote_id":"8","project_id":"42",
            "parent_remote_id":"7","status_name":child["tracker"]["status_name"],"url":child["tracker"]["url"]})
    );

    // The converted connection keeps syncing the same issues without rewriting them.
    let (status, listed) = call(&app, &owner, "GET", &base, None).await;
    assert_eq!(status, StatusCode::OK, "{listed}");
    assert_eq!(listed["connections"][0]["options"], row["options"]);
    drain(&store).await;
    let (status, _) = call(
        &app,
        &owner,
        "POST",
        &format!("{base}/{connection}/sync"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED);
    drain(&store).await;
    let after = issues(&app, &owner, workspace).await;
    assert_eq!(after.len(), 2);
    for issue in &before {
        let current = after.iter().find(|i| i["id"] == issue["id"]).unwrap();
        assert_eq!(current["version"], issue["version"], "{current}");
        assert_eq!(current["parent_id"], issue["parent_id"]);
        assert_eq!(current["tracker"], issue["tracker"]);
    }
    server.abort();
    store.pool.close().await;
    db.cleanup().await;
}

#[tokio::test]
async fn legacy_unmapped_checkpoint_restarts_discovery_on_upgrade() {
    let db = support::TestDatabase::new().await;
    let store = Store::connect(&db.url).await.unwrap();
    let owner = account(&store).await;
    let (workspace, _, _) = setup(&store, &owner).await;
    let app = http::router(store.clone());
    let mock = Mock::default();
    let (url, server) = mock_server(mock.clone()).await;
    let base = format!("/api/workspaces/{workspace}/trackers/connections");
    let (status, config) = call(
        &app,
        &owner,
        "POST",
        &base,
        Some(json!({"provider":"openproject","name":"Legacy scan","base_url":url,"token":TOKEN})),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let connection = Uuid::parse_str(config["id"].as_str().unwrap()).unwrap();
    downgrade(&store).await;
    sqlx::query("UPDATE openproject_connections SET checkpoint=$2 WHERE id=$1")
        .bind(connection)
        .bind(json!({"phase":"work_packages","page":1,"page_size":null,"project_index":0,"refresh_only":false}))
        .execute(&store.pool).await.unwrap();
    legacy_job(&store, connection, config["generation"].as_i64().unwrap()).await;
    sqlx::raw_sql(include_str!(
        "../../migrations/0007_openproject_checkpoints.sql"
    ))
    .execute(&store.pool)
    .await
    .unwrap();
    upgrade(&store).await;
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT generation FROM tracker_connections WHERE id=$1")
            .bind(connection)
            .fetch_one(&store.pool)
            .await
            .unwrap(),
        config["generation"].as_i64().unwrap() + 1
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM jobs WHERE queue='tracker' AND state='pending'"
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
        sqlx::query_scalar::<_, String>("SELECT status FROM tracker_connections WHERE id=$1")
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

#[tokio::test]
async fn comment_delivery_upgrade_keeps_attempted_sends_uncertain_and_relists_comments() {
    let f = super::push::Fixture::new().await;
    f.sync_now().await;
    assert!(f.link().await.get("comments_at").is_some());
    // The schema before 0032, with an attempted comment push on package 7 and a new one on 8.
    sqlx::raw_sql(
        "ALTER TABLE tracker_outbox DROP COLUMN sent_at, DROP COLUMN sent_body, DROP COLUMN sent_account, DROP COLUMN retry_at, ADD COLUMN attempted_at timestamptz;
         ALTER TABLE tracker_connections DROP COLUMN remote_user_id, DROP COLUMN push_error;
         UPDATE issues SET tracker=tracker-'comments_imported'-'comments_tried_at' WHERE tracker IS NOT NULL;",
    )
    .execute(&f.store.pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO comments(id,workspace_id,issue_id,author,body,created_at) SELECT gen_random_uuid(),workspace_id,id,$1,'Body '||(tracker->>'remote_id'),now() FROM issues WHERE tracker IS NOT NULL")
        .bind(f.owner.profile.id)
        .execute(&f.store.pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO tracker_outbox(id,workspace_id,connection_id,issue_id,kind,comment_id,attempts,attempted_at) SELECT gen_random_uuid(),c.workspace_id,(i.tracker->>'connection_id')::uuid,c.issue_id,'comment',c.id,CASE WHEN i.tracker->>'remote_id'='7' THEN 2 ELSE 0 END,CASE WHEN i.tracker->>'remote_id'='7' THEN '2026-10-01T10:00:00Z'::timestamptz END FROM comments c JOIN issues i ON i.id=c.issue_id")
        .execute(&f.store.pool)
        .await
        .unwrap();
    sqlx::raw_sql(include_str!(
        "../../migrations/0032_tracker_comment_delivery.sql"
    ))
    .execute(&f.store.pool)
    .await
    .unwrap();
    type Row = (
        String,
        Option<String>,
        Option<String>,
        Option<DateTime<Utc>>,
        Option<DateTime<Utc>>,
    );
    let rows: Vec<Row> = sqlx::query_as("SELECT i.tracker->>'remote_id',o.sent_body,o.sent_account,o.sent_at,o.retry_at FROM tracker_outbox o JOIN issues i ON i.id=o.issue_id ORDER BY 1")
        .fetch_all(&f.store.pool)
        .await
        .unwrap();
    let at: DateTime<Utc> = "2026-10-01T10:00:00Z".parse().unwrap();
    assert_eq!(
        rows,
        [
            (
                "7".into(),
                Some("Body 7".into()),
                None,
                Some(at),
                Some(at + chrono::TimeDelta::minutes(1))
            ),
            ("8".into(), None, None, None, None),
        ]
    );
    let link = f.link().await;
    assert_eq!(link["comments_imported"], true);
    assert!(link.get("comments_at").is_none(), "listed once more");
    f.cleanup().await;
}
