use super::*;
use sqlx::Row;

struct Fixture {
    db: support::TestDatabase,
    store: Store,
    owner: Session,
    app: Router,
    mock: Mock,
    server: tokio::task::JoinHandle<()>,
    workspace: Uuid,
    team: Uuid,
    connection: Uuid,
    action: String,
}

impl Fixture {
    async fn new(bulk_count: usize) -> Self {
        let db = support::TestDatabase::new().await;
        let store = Store::connect(&db.url).await.unwrap();
        let owner = account(&store).await;
        let (workspace, team, _) = setup(&store, &owner).await;
        let app = http::router(store.clone());
        let mock = Mock::default();
        {
            let mut remote = mock.data.lock().await;
            remote.page_size = Some(50);
            remote.bulk_count = bulk_count;
        }
        let (url, server) = mock_server(mock.clone()).await;
        let base = format!("/api/workspaces/{workspace}/openproject/connections");
        let (status, config) = call(
            &app,
            &owner,
            "POST",
            &base,
            Some(json!({
                "name":"Performance", "base_url":url, "token":TOKEN,
                "projects":[{"project_id":42,"team_id":team}]
            })),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED, "{config}");
        let connection = Uuid::parse_str(config["id"].as_str().unwrap()).unwrap();
        Self {
            db,
            store,
            owner,
            app,
            mock,
            server,
            workspace,
            team,
            connection,
            action: format!("{base}/{connection}"),
        }
    }

    async fn due(&self) {
        sqlx::query("UPDATE openproject_connections SET next_run_at=clock_timestamp() WHERE id=$1")
            .bind(self.connection)
            .execute(&self.store.pool)
            .await
            .unwrap();
    }

    async fn sync(&self) {
        let (status, value) = call(
            &self.app,
            &self.owner,
            "POST",
            &format!("{}/sync", self.action),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::ACCEPTED, "{value}");
        drain(&self.store).await;
    }

    async fn close(self) {
        self.server.abort();
        self.store.pool.close().await;
        self.db.cleanup().await;
    }
}

#[tokio::test]
async fn pages_reuse_http_connection_and_unchanged_scan_preserves_local_data() {
    let fixture = Fixture::new(48).await;
    drain(&fixture.store).await;
    assert_eq!(fixture.mock.data.lock().await.connections.len(), 1);
    let imported = issues(&fixture.app, &fixture.owner, fixture.workspace).await;
    assert_eq!(imported.len(), 50);
    let issue = Uuid::parse_str(imported[0]["id"].as_str().unwrap()).unwrap();
    let label = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO labels(id,workspace_id,name,color) VALUES($1,$2,'Local label','blue')",
    )
    .bind(label)
    .bind(fixture.workspace)
    .execute(&fixture.store.pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO issue_labels(workspace_id,issue_id,label_id) VALUES($1,$2,$3)")
        .bind(fixture.workspace)
        .bind(issue)
        .bind(label)
        .execute(&fixture.store.pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO issue_followers(workspace_id,issue_id,user_id) VALUES($1,$2,$3)")
        .bind(fixture.workspace)
        .bind(issue)
        .bind(fixture.owner.profile.id)
        .execute(&fixture.store.pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO attachments(id,workspace_id,issue_id,uploader_id,filename,content_type,bytes,created_at) VALUES($1,$2,$3,$4,'local.txt','text/plain',$5,now())")
        .bind(Uuid::new_v4()).bind(fixture.workspace).bind(issue).bind(fixture.owner.profile.id)
        .bind(b"local data".as_slice()).execute(&fixture.store.pool).await.unwrap();
    let before = fixture
        .store
        .get_issue(fixture.workspace, fixture.owner.profile.id, issue)
        .await
        .unwrap();
    fixture.sync().await;
    let after = fixture
        .store
        .get_issue(fixture.workspace, fixture.owner.profile.id, issue)
        .await
        .unwrap();
    assert_eq!(
        serde_json::to_value(before).unwrap(),
        serde_json::to_value(&after).unwrap()
    );
    assert_eq!(fixture.mock.data.lock().await.connections.len(), 1);
    let mut tx = fixture.store.pool.begin().await.unwrap();
    sqlx::query("SELECT set_config('blackwall.openproject_sync','on',true)")
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query("DELETE FROM source_links WHERE issue_id=$1")
        .bind(issue)
        .execute(&mut *tx)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    fixture.sync().await;
    let repaired = fixture
        .store
        .get_issue(fixture.workspace, fixture.owner.profile.id, issue)
        .await
        .unwrap();
    assert_eq!(repaired.version, after.version);
    assert_eq!(repaired.source_links.len(), 1);
    fixture.close().await;
}

#[tokio::test]
async fn polling_skips_discovery_and_advances_watermark_only_after_success() {
    let fixture = Fixture::new(0).await;
    drain(&fixture.store).await;
    let before: chrono::DateTime<chrono::Utc> =
        sqlx::query_scalar("SELECT poll_watermark FROM openproject_connections WHERE id=$1")
            .bind(fixture.connection)
            .fetch_one(&fixture.store.pool)
            .await
            .unwrap();
    let discovery_requests = fixture.mock.data.lock().await.resource_requests.clone();
    fixture.mock.data.lock().await.incremental_items = Some(vec![]);
    fixture.due().await;
    drain(&fixture.store).await;
    {
        let remote = fixture.mock.data.lock().await;
        assert_eq!(remote.incremental_requests, 1);
        for resource in ["projects", "statuses", "users"] {
            assert_eq!(
                remote.resource_requests[resource],
                discovery_requests[resource]
            );
        }
    }
    assert_eq!(
        issues(&fixture.app, &fixture.owner, fixture.workspace)
            .await
            .len(),
        2
    );
    let after: chrono::DateTime<chrono::Utc> =
        sqlx::query_scalar("SELECT poll_watermark FROM openproject_connections WHERE id=$1")
            .bind(fixture.connection)
            .fetch_one(&fixture.store.pool)
            .await
            .unwrap();
    assert!(after > before);
    fixture.mock.data.lock().await.incremental_items = Some(vec![
        json!({"id":7,"subject":"Malformed","dueDate":"invalid"}),
    ]);
    fixture.due().await;
    openproject::schedule(&fixture.store).await.unwrap();
    let claim = fixture
        .store
        .outbox
        .claim("openproject", 1)
        .await
        .unwrap()
        .pop()
        .unwrap();
    let Job::OpenProject(job) = Job::decode(&claim.kind, &claim.payload).unwrap() else {
        panic!("wrong job")
    };
    assert!(
        openproject::execute(&fixture.store, &claim, &job)
            .await
            .is_err()
    );
    let unchanged: chrono::DateTime<chrono::Utc> =
        sqlx::query_scalar("SELECT poll_watermark FROM openproject_connections WHERE id=$1")
            .bind(fixture.connection)
            .fetch_one(&fixture.store.pool)
            .await
            .unwrap();
    assert_eq!(unchanged, after);
    fixture.close().await;
}

#[tokio::test]
async fn unsupported_date_filter_falls_back_and_metadata_expiry_forces_full_refresh() {
    let fixture = Fixture::new(0).await;
    drain(&fixture.store).await;
    fixture.mock.data.lock().await.reject_date_filter = true;
    fixture.due().await;
    drain(&fixture.store).await;
    assert_eq!(fixture.mock.data.lock().await.incremental_requests, 1);
    let supported: bool =
        sqlx::query_scalar("SELECT incremental_supported FROM openproject_connections WHERE id=$1")
            .bind(fixture.connection)
            .fetch_one(&fixture.store.pool)
            .await
            .unwrap();
    assert!(!supported);
    fixture.due().await;
    drain(&fixture.store).await;
    assert_eq!(fixture.mock.data.lock().await.incremental_requests, 1);
    let before = fixture.mock.data.lock().await.resource_requests["projects"];
    sqlx::query("UPDATE openproject_connections SET last_discovered_at=now()-interval '31 minutes',next_run_at=clock_timestamp() WHERE id=$1")
        .bind(fixture.connection).execute(&fixture.store.pool).await.unwrap();
    drain(&fixture.store).await;
    assert!(fixture.mock.data.lock().await.resource_requests["projects"] > before);
    fixture.close().await;
}

#[tokio::test]
async fn local_stage_changes_force_unfiltered_reconciliation() {
    let fixture = Fixture::new(0).await;
    drain(&fixture.store).await;
    // New matching stage changes resolution without changing remote work packages.
    fixture.mock.data.lock().await.incremental_items = Some(vec![]);
    let stage = Uuid::new_v4();
    sqlx::query("INSERT INTO stages(id,workspace_id,team_id,name,kind,position) VALUES($1,$2,$3,'In progress','active',-10000)")
        .bind(stage).bind(fixture.workspace).bind(fixture.team).execute(&fixture.store.pool).await.unwrap();
    fixture.due().await;
    drain(&fixture.store).await;
    assert_eq!(fixture.mock.data.lock().await.incremental_requests, 0);
    let imported = issues(&fixture.app, &fixture.owner, fixture.workspace).await;
    let first = imported
        .iter()
        .find(|i| i["openproject"]["work_package_id"] == 7)
        .unwrap();
    assert_eq!(first["stage_id"], stage.to_string());
    fixture.close().await;
}

#[tokio::test]
async fn discovery_cache_publishes_only_complete_resources() {
    let fixture = Fixture::new(0).await;
    openproject::schedule(&fixture.store).await.unwrap();
    let claim = fixture
        .store
        .outbox
        .claim("openproject", 1)
        .await
        .unwrap()
        .pop()
        .unwrap();
    let Job::OpenProject(job) = Job::decode(&claim.kind, &claim.payload).unwrap() else {
        panic!("wrong job")
    };
    openproject::execute(&fixture.store, &claim, &job)
        .await
        .unwrap();
    let row =
        sqlx::query("SELECT cached_projects,checkpoint FROM openproject_connections WHERE id=$1")
            .bind(fixture.connection)
            .fetch_one(&fixture.store.pool)
            .await
            .unwrap();
    assert_eq!(row.get::<Value, _>("cached_projects"), json!([]));
    assert_eq!(row.get::<Value, _>("checkpoint")["page"], 2);
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM openproject_discovery_pages")
            .fetch_one(&fixture.store.pool)
            .await
            .unwrap(),
        1
    );
    drain(&fixture.store).await;
    assert_eq!(
        sqlx::query_scalar::<_, Value>(
            "SELECT cached_projects FROM openproject_connections WHERE id=$1"
        )
        .bind(fixture.connection)
        .fetch_one(&fixture.store.pool)
        .await
        .unwrap()
        .as_array()
        .unwrap()
        .len(),
        2
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM openproject_discovery_pages")
            .fetch_one(&fixture.store.pool)
            .await
            .unwrap(),
        0
    );
    fixture.close().await;
}

#[tokio::test]
async fn configuration_noops_preserve_live_checkpoint_and_invalid_sets_roll_back() {
    let fixture = Fixture::new(0).await;
    openproject::schedule(&fixture.store).await.unwrap();
    let before: Value =
        sqlx::query_scalar("SELECT to_jsonb(c)-'name' FROM openproject_connections c WHERE id=$1")
            .bind(fixture.connection)
            .fetch_one(&fixture.store.pool)
            .await
            .unwrap();
    let (status, _) = call(
        &fixture.app,
        &fixture.owner,
        "PATCH",
        &fixture.action,
        Some(json!({"name":"Renamed"})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (status, _) = call(
        &fixture.app,
        &fixture.owner,
        "PATCH",
        &fixture.action,
        Some(json!({
        "projects":[{"project_id":42,"team_id":fixture.team}],"people_mapping":{}})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let after: Value =
        sqlx::query_scalar("SELECT to_jsonb(c)-'name' FROM openproject_connections c WHERE id=$1")
            .bind(fixture.connection)
            .fetch_one(&fixture.store.pool)
            .await
            .unwrap();
    assert_eq!(before, after);
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM jobs WHERE state='pending' AND queue='openproject'"
        )
        .fetch_one(&fixture.store.pool)
        .await
        .unwrap(),
        1
    );
    for invalid in [
        json!({"projects":[{"project_id":42,"team_id":fixture.team,"stage_mapping":{"1":Uuid::new_v4()}}]}),
        json!({"people_mapping":{"unknown@example.com":Uuid::new_v4()}}),
        json!({"projects":[{"project_id":42,"team_id":fixture.team},{"project_id":42,"team_id":fixture.team}]}),
    ] {
        let (status, _) = call(
            &fixture.app,
            &fixture.owner,
            "PATCH",
            &fixture.action,
            Some(invalid),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
    }
    let unchanged: Value =
        sqlx::query_scalar("SELECT to_jsonb(c)-'name' FROM openproject_connections c WHERE id=$1")
            .bind(fixture.connection)
            .fetch_one(&fixture.store.pool)
            .await
            .unwrap();
    assert_eq!(after, unchanged);
    fixture.close().await;
}

#[tokio::test]
async fn refresh_only_invalidates_watermark_and_reconciles_old_packages_next_poll() {
    let fixture = Fixture::new(0).await;
    drain(&fixture.store).await;
    fixture.mock.data.lock().await.incremental_items = Some(vec![]);
    let (status, _) = call(
        &fixture.app,
        &fixture.owner,
        "POST",
        &format!("{}/refresh", fixture.action),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED);
    drain(&fixture.store).await;
    let watermark: Option<chrono::DateTime<chrono::Utc>> =
        sqlx::query_scalar("SELECT poll_watermark FROM openproject_connections WHERE id=$1")
            .bind(fixture.connection)
            .fetch_one(&fixture.store.pool)
            .await
            .unwrap();
    assert!(watermark.is_none());
    fixture.due().await;
    drain(&fixture.store).await;
    assert_eq!(fixture.mock.data.lock().await.incremental_requests, 0);
    fixture.close().await;
}

#[tokio::test]
async fn follower_alerts_are_batched_and_respect_local_and_global_preferences() {
    let fixture = Fixture::new(0).await;
    drain(&fixture.store).await;
    let member = account(&fixture.store).await;
    sqlx::query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'member')")
        .bind(fixture.workspace)
        .bind(member.profile.id)
        .execute(&fixture.store.pool)
        .await
        .unwrap();
    let imported = issues(&fixture.app, &fixture.owner, fixture.workspace).await;
    let issue = Uuid::parse_str(
        imported
            .iter()
            .find(|i| i["openproject"]["work_package_id"] == 7)
            .unwrap()["id"]
            .as_str()
            .unwrap(),
    )
    .unwrap();
    for user in [fixture.owner.profile.id, member.profile.id] {
        sqlx::query("INSERT INTO issue_followers(workspace_id,issue_id,user_id) VALUES($1,$2,$3)")
            .bind(fixture.workspace)
            .bind(issue)
            .bind(user)
            .execute(&fixture.store.pool)
            .await
            .unwrap();
    }
    sqlx::query("INSERT INTO alert_preferences(workspace_id,user_id,change) VALUES($1,$2,false)")
        .bind(fixture.workspace)
        .bind(fixture.owner.profile.id)
        .execute(&fixture.store.pool)
        .await
        .unwrap();
    fixture.mock.data.lock().await.deadline = Some("2030-12-10".into());
    fixture.sync().await;
    let users: Vec<Uuid> =
        sqlx::query_scalar("SELECT user_id FROM notifications WHERE issue_id=$1 AND kind='change'")
            .bind(issue)
            .fetch_all(&fixture.store.pool)
            .await
            .unwrap();
    assert_eq!(users, vec![member.profile.id]);
    sqlx::query(
        "UPDATE users SET profile=jsonb_set(profile,'{alerts,changes}','false'::jsonb) WHERE id=$1",
    )
    .bind(member.profile.id)
    .execute(&fixture.store.pool)
    .await
    .unwrap();
    fixture.mock.data.lock().await.deadline = Some("2030-12-11".into());
    fixture.sync().await;
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM notifications WHERE issue_id=$1 AND kind='change'"
        )
        .bind(issue)
        .fetch_one(&fixture.store.pool)
        .await
        .unwrap(),
        1
    );
    fixture.close().await;
}

#[tokio::test]
async fn polling_upgrade_fences_old_leases_and_restarts_partial_discovery() {
    for running in [false, true] {
        let fixture = Fixture::new(0).await;
        openproject::schedule(&fixture.store).await.unwrap();
        let old_generation: i64 =
            sqlx::query_scalar("SELECT generation FROM openproject_connections WHERE id=$1")
                .bind(fixture.connection)
                .fetch_one(&fixture.store.pool)
                .await
                .unwrap();
        let claim = if running {
            fixture
                .store
                .outbox
                .claim("openproject", 1)
                .await
                .unwrap()
                .pop()
        } else {
            None
        };
        sqlx::query("UPDATE openproject_connections SET status='syncing',checkpoint=$2,cached_projects=$3 WHERE id=$1")
            .bind(fixture.connection).bind(json!({"phase":"projects","page":2,"refresh_only":false}))
            .bind(json!([{"id":999,"name":"Partial legacy page"}])).execute(&fixture.store.pool).await.unwrap();
        sqlx::raw_sql("DROP TABLE openproject_discovery_pages; ALTER TABLE openproject_connections DROP COLUMN poll_watermark,DROP COLUMN last_discovered_at,DROP COLUMN incremental_supported")
            .execute(&fixture.store.pool).await.unwrap();
        sqlx::raw_sql(include_str!(
            "../../migrations/0010_openproject_polling.sql"
        ))
        .execute(&fixture.store.pool)
        .await
        .unwrap();
        let current: i64 =
            sqlx::query_scalar("SELECT generation FROM openproject_connections WHERE id=$1")
                .bind(fixture.connection)
                .fetch_one(&fixture.store.pool)
                .await
                .unwrap();
        assert_eq!(current, old_generation + 1);
        if let Some(claim) = claim {
            let Job::OpenProject(job) = Job::decode(&claim.kind, &claim.payload).unwrap() else {
                panic!("wrong job")
            };
            openproject::execute(&fixture.store, &claim, &job)
                .await
                .unwrap();
            assert_eq!(fixture.mock.data.lock().await.requests, 0);
        } else {
            assert_eq!(
                sqlx::query_scalar::<_, i64>(
                    "SELECT count(*) FROM jobs WHERE queue='openproject' AND state='cancelled'"
                )
                .fetch_one(&fixture.store.pool)
                .await
                .unwrap(),
                1
            );
        }
        drain(&fixture.store).await;
        let projects: Value =
            sqlx::query_scalar("SELECT cached_projects FROM openproject_connections WHERE id=$1")
                .bind(fixture.connection)
                .fetch_one(&fixture.store.pool)
                .await
                .unwrap();
        assert_eq!(projects.as_array().unwrap().len(), 2);
        assert!(!projects.to_string().contains("Partial legacy"));
        fixture.close().await;
    }
}

#[tokio::test]
#[ignore = "manual performance measurement against isolated PostgreSQL and mock HTTP"]
async fn benchmark_thousand_issue_scans() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tracing::instrument::WithSubscriber;
    use tracing_subscriber::{Layer, layer::SubscriberExt};
    struct Counter(Arc<AtomicUsize>);
    impl<S: tracing::Subscriber> Layer<S> for Counter {
        fn on_event(
            &self,
            event: &tracing::Event<'_>,
            _: tracing_subscriber::layer::Context<'_, S>,
        ) {
            if event.metadata().target() == "sqlx::query" {
                self.0.fetch_add(1, Ordering::Relaxed);
            }
        }
    }
    let fixture = Fixture::new(998).await;
    let started = std::time::Instant::now();
    let mut interactive_ms = Vec::new();
    tokio::join!(drain(&fixture.store), async {
        for index in 0..25 {
            let start = std::time::Instant::now();
            fixture.store.operation(fixture.workspace, fixture.owner.profile.id,
                serde_json::from_value(json!({"type":"create_issue","input":{"team_id":fixture.team,"title":format!("Concurrent local issue {index}")}})).unwrap(),
                BTreeMap::new(),None,None).await.unwrap();
            interactive_ms.push(start.elapsed().as_millis());
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    });
    interactive_ms.sort();
    let interactive_p95 = interactive_ms[23];
    let initial_ms = started.elapsed().as_millis();
    let counter = Arc::new(AtomicUsize::new(0));
    let subscriber = tracing_subscriber::registry().with(Counter(counter.clone()));
    let started = std::time::Instant::now();
    fixture.sync().with_subscriber(subscriber).await;
    let unchanged_ms = started.elapsed().as_millis();
    let statements = counter.load(Ordering::Relaxed);
    assert!(
        statements > 0,
        "SQL instrumentation did not capture queries"
    );
    assert!(
        statements < 1500,
        "unchanged scan regressed to per-item queries: {statements}"
    );
    fixture.mock.data.lock().await.deadline = Some("2030-12-10".into());
    let started = std::time::Instant::now();
    fixture.sync().await;
    let small_update_ms = started.elapsed().as_millis();
    fixture.mock.data.lock().await.incremental_items = Some(vec![]);
    fixture.due().await;
    let started = std::time::Instant::now();
    drain(&fixture.store).await;
    eprintln!(
        "1000 remote issues: initial={initial_ms}ms unchanged_full={unchanged_ms}ms SQL_events={statements} small_update={small_update_ms}ms unchanged_incremental={}ms concurrent_write_p95={interactive_p95}ms",
        started.elapsed().as_millis()
    );
    fixture.close().await;
}
