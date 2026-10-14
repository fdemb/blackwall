use super::*;

struct Fixture {
    db: support::TestDatabase,
    store: Store,
    app: Router,
    owner: Session,
    workspace: Uuid,
    team: Uuid,
    mock: Mock,
    server: tokio::task::JoinHandle<()>,
    action: String,
}

impl Fixture {
    async fn new() -> Self {
        let db = support::TestDatabase::new().await;
        let store = Store::connect(&db.url).await.unwrap();
        let owner = account(&store).await;
        let (workspace, team, _) = setup(&store, &owner).await;
        let app = http::router(store.clone());
        let mock = Mock::default();
        let (url, server) = mock_server(mock.clone()).await;
        let base = format!("/api/workspaces/{workspace}/trackers/connections");
        let (status, config) = call(
            &app,
            &owner,
            "POST",
            &base,
            Some(
                json!({"provider":"openproject","name":"Merge","base_url":url,"token":TOKEN,
                "projects":[{"project_id":"42","team_id":team}],"options":import_only()}),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED, "{config}");
        let action = format!("{base}/{}", config["id"].as_str().unwrap());
        drain(&store).await;
        Self {
            db,
            store,
            app,
            owner,
            workspace,
            team,
            mock,
            server,
            action,
        }
    }

    async fn first(&self) -> Value {
        issues(&self.app, &self.owner, self.workspace)
            .await
            .into_iter()
            .find(|issue| issue["tracker"]["remote_id"] == "7")
            .unwrap()
    }

    async fn run(&self, command: Value) {
        let issue = self.first().await;
        let (status, value) = call(
            &self.app,
            &self.owner,
            "POST",
            &format!("/api/workspaces/{}/commands", self.workspace),
            Some(json!({"expected_versions":{issue["id"].as_str().unwrap():issue["version"]},"command":command})),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{value}");
    }

    /// Retitles and moves the first package to another stage locally; returns that stage.
    async fn edit_locally(&self) -> Uuid {
        let issue = self.first().await;
        let stage: Uuid = sqlx::query_scalar(
            "SELECT id FROM stages WHERE team_id=$1 AND id<>$2 AND kind='backlog' ORDER BY position LIMIT 1",
        )
        .bind(self.team)
        .bind(Uuid::parse_str(issue["stage_id"].as_str().unwrap()).unwrap())
        .fetch_one(&self.store.pool)
        .await
        .unwrap();
        self.run(json!({"type":"update_issue","id":issue["id"],"patch":{"title":"Local title"}}))
            .await;
        self.run(json!({"type":"move_issue","id":issue["id"],"stage_id":stage}))
            .await;
        stage
    }

    async fn sync_now(&self) {
        let (status, _) = call(
            &self.app,
            &self.owner,
            "POST",
            &format!("{}/sync", self.action),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::ACCEPTED);
        drain(&self.store).await;
    }

    async fn stage_kind(&self, issue: &Value) -> String {
        sqlx::query_scalar("SELECT kind FROM stages WHERE id=$1")
            .bind(Uuid::parse_str(issue["stage_id"].as_str().unwrap()).unwrap())
            .fetch_one(&self.store.pool)
            .await
            .unwrap()
    }

    async fn cleanup(self) {
        self.server.abort();
        self.store.pool.close().await;
        self.db.cleanup().await;
    }
}

#[tokio::test]
async fn local_edits_survive_unchanged_remote() {
    let f = Fixture::new().await;
    let stage = f.edit_locally().await;
    let edited = f.first().await;
    f.sync_now().await;
    let issue = f.first().await;
    assert_eq!(issue["title"], "Local title");
    assert_eq!(issue["stage_id"], json!(stage));
    assert_eq!(
        issue["version"], edited["version"],
        "unchanged remote must not write"
    );
    f.cleanup().await;
}

#[tokio::test]
async fn remote_changes_win_over_earlier_local_edits() {
    let f = Fixture::new().await;
    f.edit_locally().await;
    {
        let mut data = f.mock.data.lock().await;
        data.subject = Some("Remote title".into());
        data.closed_first = true;
    }
    f.sync_now().await;
    let issue = f.first().await;
    assert_eq!(issue["title"], "Remote title");
    assert_eq!(f.stage_kind(&issue).await, "done");
    f.cleanup().await;
}

#[tokio::test]
async fn disabled_imports_keep_local_values_when_the_remote_changes() {
    let f = Fixture::new().await;
    let off = json!({"import":false,"export":false});
    let (status, value) = call(
        &f.app,
        &f.owner,
        "PATCH",
        &f.action,
        Some(json!({"options":{"title":off,"status":off}})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{value}");
    drain(&f.store).await;
    let stage = f.edit_locally().await;
    {
        let mut data = f.mock.data.lock().await;
        data.subject = Some("Remote title".into());
        data.closed_first = true;
        data.deadline = Some("2026-12-24".into());
    }
    f.sync_now().await;
    let issue = f.first().await;
    assert_eq!(issue["title"], "Local title");
    assert_eq!(issue["stage_id"], json!(stage));
    // Fields that still import follow the remote.
    assert!(
        issue["deadline"]
            .as_str()
            .unwrap()
            .starts_with("2026-12-24")
    );
    f.cleanup().await;
}

#[tokio::test]
async fn migrated_links_without_baseline_take_the_remote_once() {
    let f = Fixture::new().await;
    f.run(
        json!({"type":"update_issue","id":f.first().await["id"],"patch":{"title":"Local title"}}),
    )
    .await;
    sqlx::query("UPDATE issues SET tracker=tracker-'baseline' WHERE workspace_id=$1")
        .bind(f.workspace)
        .execute(&f.store.pool)
        .await
        .unwrap();
    f.sync_now().await;
    let issue = f.first().await;
    assert_eq!(issue["title"], "First package");
    assert!(
        issue["tracker"].get("baseline").is_none(),
        "baseline stays internal"
    );
    let baseline: Value = sqlx::query_scalar("SELECT tracker->'baseline' FROM issues WHERE id=$1")
        .bind(Uuid::parse_str(issue["id"].as_str().unwrap()).unwrap())
        .fetch_one(&f.store.pool)
        .await
        .unwrap();
    assert_eq!(baseline["title"], "First package");
    assert_eq!(baseline["team_id"], json!(f.team));

    f.run(json!({"type":"update_issue","id":issue["id"],"patch":{"title":"Local again"}}))
        .await;
    f.sync_now().await;
    assert_eq!(f.first().await["title"], "Local again");
    f.cleanup().await;
}

#[tokio::test]
async fn trashed_issues_only_record_the_remote_baseline() {
    let f = Fixture::new().await;
    let id = f.first().await["id"].clone();
    f.run(json!({"type":"update_issue","id":id,"patch":{"title":"Local title"}}))
        .await;
    f.run(json!({"type":"delete_issue","id":id})).await;
    {
        let mut data = f.mock.data.lock().await;
        data.subject = Some("Remote title".into());
        data.closed_first = true;
    }
    f.sync_now().await;
    let row: (String, bool, Value) = sqlx::query_as(
        "SELECT title,deleted_at IS NOT NULL,tracker->'baseline' FROM issues WHERE id=$1",
    )
    .bind(Uuid::parse_str(id.as_str().unwrap()).unwrap())
    .fetch_one(&f.store.pool)
    .await
    .unwrap();
    assert_eq!(row.0, "Local title");
    assert!(row.1, "import must not restore trashed issues");
    assert_eq!(row.2["title"], "Remote title");
    f.cleanup().await;
}
