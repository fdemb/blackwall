use super::*;

pub(super) struct Fixture {
    db: support::TestDatabase,
    pub(super) store: Store,
    pub(super) app: Router,
    pub(super) owner: Session,
    pub(super) workspace: Uuid,
    team: Uuid,
    pub(super) mock: Mock,
    server: tokio::task::JoinHandle<()>,
    pub(super) action: String,
}

impl Fixture {
    /// Imports packages 7 and 8; the owner's email matches remote person 10.
    pub(super) async fn new() -> Self {
        Self::with(json!({}), |_| {}).await
    }

    /// Creates the connection with `extra` connection fields after `prepare` set up the remote.
    pub(super) async fn with(extra: Value, prepare: impl FnOnce(&mut Remote)) -> Self {
        let db = support::TestDatabase::new().await;
        let store = Store::connect(&db.url).await.unwrap();
        let owner = account(&store).await;
        let (workspace, team, _) = setup(&store, &owner).await;
        let app = http::router(store.clone());
        let mock = Mock::default();
        {
            let mut data = mock.data.lock().await;
            data.assignee_email = Some(owner.profile.email.clone());
            prepare(&mut data);
        }
        let (url, server) = mock_server(mock.clone()).await;
        let base = format!("/api/workspaces/{workspace}/trackers/connections");
        let mut body = json!({"provider":"openproject","name":"Push","base_url":url,"token":TOKEN,
            "projects":[{"project_id":"42","team_id":team}]});
        body.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        let (status, config) = call(&app, &owner, "POST", &base, Some(body)).await;
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

    pub(super) async fn first(&self) -> Value {
        issues(&self.app, &self.owner, self.workspace)
            .await
            .into_iter()
            .find(|issue| issue["tracker"]["remote_id"] == "7")
            .unwrap()
    }

    pub(super) async fn run(&self, command: Value) {
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

    async fn stage(&self, name: &str) -> Uuid {
        sqlx::query_scalar("SELECT id FROM stages WHERE team_id=$1 AND name=$2")
            .bind(self.team)
            .bind(name)
            .fetch_one(&self.store.pool)
            .await
            .unwrap()
    }

    pub(super) async fn outbox(&self) -> Vec<(Vec<String>, i32, String)> {
        sqlx::query_as("SELECT fields,attempts,last_error FROM tracker_outbox ORDER BY created_at")
            .fetch_all(&self.store.pool)
            .await
            .unwrap()
    }

    pub(super) async fn link(&self) -> Value {
        sqlx::query_scalar("SELECT tracker FROM issues WHERE tracker->>'remote_id'='7'")
            .fetch_one(&self.store.pool)
            .await
            .unwrap()
    }

    pub(super) async fn sync_now(&self) {
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

    pub(super) async fn cleanup(self) {
        self.server.abort();
        self.store.pool.close().await;
        self.db.cleanup().await;
    }
}

#[tokio::test]
async fn local_edits_coalesce_into_one_patch_without_echo() {
    let f = Fixture::new().await;
    let done = f.stage("Done").await;
    // Map the closed status to Done; the issue stays in progress.
    let (status, value) = call(
        &f.app,
        &f.owner,
        "PATCH",
        &f.action,
        Some(json!({"projects":[{"project_id":"42","team_id":f.team,"stage_mapping":{"2":done}}]})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{value}");
    drain(&f.store).await;
    let issue = f.first().await;
    assert!(issue["assignee"].is_null());
    let patch = json!({"title":"Local title","description":"Local *body*",
        "assignee":f.owner.profile.id,"deadline":"2026-06-01T15:00:00Z"});
    f.run(json!({"type":"update_issue","id":issue["id"],"patch":patch}))
        .await;
    f.run(json!({"type":"move_issue","id":issue["id"],"stage_id":done}))
        .await;
    let queued = f.outbox().await;
    assert_eq!(queued.len(), 1, "one coalesced row per issue");
    assert_eq!(
        queued[0].0,
        ["assignee", "description", "due_date", "status", "title"]
    );
    assert!(f.mock.data.lock().await.patches.is_empty());
    let edited = f.first().await;

    drain(&f.store).await;
    let lock_version = {
        let data = f.mock.data.lock().await;
        assert_eq!(data.patches.len(), 1);
        assert_eq!(
            data.patches[0],
            json!({"lockVersion":0,"subject":"Local title","description":{"raw":"Local *body*"},
                "dueDate":"2026-06-01","_links":{"status":{"href":"/api/v3/statuses/2"},
                "assignee":{"href":"/api/v3/users/10"}}})
        );
        data.lock_version
    };
    assert_eq!(lock_version, 1);
    assert!(f.outbox().await.is_empty());
    let link = f.link().await;
    assert_eq!(link["baseline"]["title"], "Local title");
    assert_eq!(link["baseline"]["stage_id"], json!(done));
    assert_eq!(link["baseline"]["deadline"], "2026-06-01T00:00:00Z");
    assert_eq!(link["status_name"], "Closed");
    assert!(link.get("push_error").is_none());
    let pushed = f.first().await;
    assert_eq!(pushed["version"], edited["version"], "pushes do not bump");

    f.sync_now().await;
    let imported = f.first().await;
    assert_eq!(imported["version"], edited["version"], "no echo");
    assert_eq!(imported["title"], "Local title");
    assert!(
        imported["deadline"]
            .as_str()
            .unwrap()
            .starts_with("2026-06-01T15:00:00")
    );
    assert_eq!(f.mock.data.lock().await.patches.len(), 1);
    f.cleanup().await;
}

#[tokio::test]
async fn disabled_exports_and_imports_queue_nothing() {
    let f = Fixture::new().await;
    let off = json!({"import":true,"export":false});
    let (status, value) = call(
        &f.app,
        &f.owner,
        "PATCH",
        &f.action,
        Some(json!({"options":{"title":off,"comments":off}})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{value}");
    let issue = f.first().await;
    f.run(json!({"type":"update_issue","id":issue["id"],"patch":{"title":"Local title","priority":"low"}}))
        .await;
    let (status, value) = call(
        &f.app,
        &f.owner,
        "POST",
        &format!("/api/workspaces/{}/commands", f.workspace),
        Some(json!({"expected_versions":{},"command":{"type":"add_comment","issue_id":issue["id"],"body":"Local only","mentions":[]}})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{value}");
    assert!(f.outbox().await.is_empty());
    f.mock.data.lock().await.description = Some("Remote body".into());
    f.sync_now().await;
    assert_eq!(f.first().await["description"], "Remote body");
    assert!(f.outbox().await.is_empty(), "imports never queue pushes");
    let data = f.mock.data.lock().await;
    assert!(data.patches.is_empty() && data.comments.is_empty());
    drop(data);
    f.cleanup().await;
}

#[tokio::test]
async fn lock_conflicts_refetch_and_retry_once() {
    let f = Fixture::new().await;
    f.mock.data.lock().await.push_statuses.push_back(409);
    f.run(
        json!({"type":"update_issue","id":f.first().await["id"],"patch":{"title":"Local title"}}),
    )
    .await;
    drain(&f.store).await;
    let data = f.mock.data.lock().await;
    let versions: Vec<_> = data
        .patches
        .iter()
        .map(|p| p["lockVersion"].clone())
        .collect();
    assert_eq!(versions, [json!(0), json!(1)]);
    assert_eq!(data.subject.as_deref(), Some("Local title"));
    drop(data);
    assert!(f.outbox().await.is_empty());
    f.cleanup().await;
}

#[tokio::test]
async fn rejected_pushes_surface_on_the_issue_and_are_dropped() {
    let f = Fixture::new().await;
    f.mock.data.lock().await.push_statuses.push_back(422);
    f.run(
        json!({"type":"update_issue","id":f.first().await["id"],"patch":{"title":"Local title"}}),
    )
    .await;
    let edited = f.first().await;
    let counts = || async {
        sqlx::query_as::<_, (i64, i64)>("SELECT (SELECT count(*) FROM activity),(SELECT count(*) FROM changes WHERE entity='issues')")
            .fetch_one(&f.store.pool)
            .await
            .unwrap()
    };
    let before = counts().await;
    drain(&f.store).await;
    assert!(f.outbox().await.is_empty());
    let issue = f.first().await;
    let error = issue["tracker"]["push_error"].as_str().unwrap();
    assert!(error.contains("422"), "{error}");
    assert!(!error.contains("secret"), "remote bodies stay out");
    assert_eq!(issue["version"], edited["version"]);
    assert_eq!(issue["title"], "Local title");
    let after = counts().await;
    assert_eq!(after.0, before.0, "no activity noise");
    assert!(after.1 > before.1, "the change feed reports the error");

    // The next successful push clears the error.
    f.run(json!({"type":"update_issue","id":issue["id"],"patch":{"title":"Fixed title"}}))
        .await;
    drain(&f.store).await;
    assert!(f.first().await["tracker"].get("push_error").is_none());
    f.cleanup().await;
}

#[tokio::test]
async fn transient_failures_keep_the_row_and_imports_keep_its_fields() {
    let f = Fixture::new().await;
    f.mock.data.lock().await.push_statuses.push_back(500);
    f.run(
        json!({"type":"update_issue","id":f.first().await["id"],"patch":{"title":"Local title"}}),
    )
    .await;
    drain(&f.store).await;
    let queued = f.outbox().await;
    assert_eq!(queued.len(), 1);
    assert_eq!(
        (queued[0].1, queued[0].2.as_str()),
        (1, "OpenProject HTTP 500")
    );
    assert!(f.first().await["tracker"].get("push_error").is_none());

    // While the row waits out its backoff, a remote change keeps the local title.
    f.mock.data.lock().await.subject = Some("Remote title".into());
    f.sync_now().await;
    assert_eq!(f.mock.data.lock().await.patches.len(), 1, "backoff holds");
    assert_eq!(f.first().await["title"], "Local title");

    sqlx::query("UPDATE tracker_outbox SET retry_at=NULL")
        .execute(&f.store.pool)
        .await
        .unwrap();
    drain(&f.store).await;
    assert!(f.outbox().await.is_empty());
    assert_eq!(
        f.mock.data.lock().await.subject.as_deref(),
        Some("Local title")
    );
    f.cleanup().await;
}

#[tokio::test]
async fn unmappable_stages_are_skipped_but_other_fields_push() {
    let f = Fixture::new().await;
    let issue = f.first().await;
    let done = f.stage("Done").await;
    f.run(json!({"type":"update_issue","id":issue["id"],"patch":{"title":"Local title","stage_id":done}}))
        .await;
    drain(&f.store).await;
    let patches = f.mock.data.lock().await.patches.clone();
    assert_eq!(
        patches,
        [json!({"lockVersion":0,"subject":"Local title"})],
        "no status is named Done"
    );
    assert!(f.outbox().await.is_empty());
    f.sync_now().await;
    assert_eq!(f.first().await["stage_id"], json!(done));
    f.cleanup().await;
}

#[tokio::test]
async fn comments_post_activities_and_record_their_remote_id() {
    let f = Fixture::new().await;
    let issue = f.first().await;
    let (status, value) = call(
        &f.app,
        &f.owner,
        "POST",
        &format!("/api/workspaces/{}/commands", f.workspace),
        Some(json!({"expected_versions":{},"command":{"type":"add_comment","issue_id":issue["id"],"body":"Hello **remote**","mentions":[]}})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{value}");
    assert_eq!(f.outbox().await.len(), 1);
    drain(&f.store).await;
    assert_eq!(
        f.mock.data.lock().await.comments,
        [json!({"comment":{"raw":"Hello **remote**"}})]
    );
    assert!(f.outbox().await.is_empty());
    let (status, comments) = call(
        &f.app,
        &f.owner,
        "GET",
        &format!(
            "/api/workspaces/{}/comments?issue_id={}",
            f.workspace,
            issue["id"].as_str().unwrap()
        ),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{comments}");
    let tracker = &comments["items"][0]["tracker"];
    assert_eq!(tracker["remote_id"], "501");
    assert_eq!(tracker["provider"], "openproject");
    assert!(tracker["author_name"].is_null());
    f.cleanup().await;
}

impl Fixture {
    async fn retitle(&self, wp: &str, title: &str) {
        let issue = issues(&self.app, &self.owner, self.workspace)
            .await
            .into_iter()
            .find(|issue| issue["tracker"]["remote_id"] == wp)
            .unwrap();
        let (status, value) = call(
            &self.app,
            &self.owner,
            "POST",
            &format!("/api/workspaces/{}/commands", self.workspace),
            Some(
                json!({"expected_versions":{issue["id"].as_str().unwrap():issue["version"]},
                "command":{"type":"update_issue","id":issue["id"],"patch":{"title":title}}}),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{value}");
    }

    /// Runs one tracker job whose first PATCH stalls; `meanwhile` runs before it is answered.
    async fn run_stalled<F: Future<Output = ()>>(&self, meanwhile: impl FnOnce() -> F) {
        self.mock.data.lock().await.stall_patch = true;
        let store = self.store.clone();
        let running = tokio::spawn(async move {
            tracker::schedule(&store).await.unwrap();
            let claims = store.outbox.claim("tracker", 1).await.unwrap();
            let Job::Tracker(job) = Job::decode(&claims[0].kind, &claims[0].payload).unwrap()
            else {
                panic!("wrong queue kind");
            };
            tracker::execute(&store, &claims[0], &job).await.unwrap();
        });
        self.mock.entered.notified().await;
        meanwhile().await;
        self.mock.release.notify_one();
        running.await.unwrap();
    }
}

#[tokio::test]
async fn disabling_a_connection_stops_an_active_push_batch() {
    let f = Fixture::new().await;
    f.retitle("7", "First local").await;
    f.retitle("8", "Second local").await;
    f.run_stalled(|| async {
        let (status, value) = call(
            &f.app,
            &f.owner,
            "PATCH",
            &f.action,
            Some(json!({"enabled":false})),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{value}");
    })
    .await;
    assert_eq!(f.mock.data.lock().await.patches.len(), 1);
    assert_eq!(f.outbox().await.len(), 1, "the second row waits");
    f.cleanup().await;
}

#[tokio::test]
async fn export_toggles_apply_to_the_rest_of_an_active_push_batch() {
    let f = Fixture::new().await;
    f.retitle("7", "First local").await;
    f.retitle("8", "Second local").await;
    f.run_stalled(|| async {
        let (status, value) = call(
            &f.app,
            &f.owner,
            "PATCH",
            &f.action,
            Some(json!({"options":{"title":{"import":true,"export":false}}})),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{value}");
    })
    .await;
    assert_eq!(f.mock.data.lock().await.patches.len(), 1);
    assert!(f.outbox().await.is_empty(), "the second row is dropped");
    f.cleanup().await;
}

#[tokio::test]
async fn stale_failures_leave_a_newer_edit_due() {
    // A transient failure, then one that would give up.
    for attempts in [0, 9] {
        let f = Fixture::new().await;
        f.mock.data.lock().await.push_statuses.push_back(500);
        f.retitle("7", "First local").await;
        sqlx::query("UPDATE tracker_outbox SET attempts=$1")
            .bind(attempts)
            .execute(&f.store.pool)
            .await
            .unwrap();
        f.run_stalled(|| f.retitle("7", "Second local")).await;
        // The newer edit keeps its fresh retry state, and nothing gave up.
        assert_eq!(f.outbox().await[0].1, 0, "attempts {attempts}");
        assert!(f.first().await["tracker"].get("push_error").is_none());
        drain(&f.store).await;
        assert!(f.outbox().await.is_empty());
        assert_eq!(f.mock.data.lock().await.patches.len(), 2);
        assert_eq!(
            f.mock.data.lock().await.subject.as_deref(),
            Some("Second local")
        );
        assert!(f.first().await["tracker"].get("push_error").is_none());
        f.cleanup().await;
    }
}

#[tokio::test]
async fn edits_start_an_overdue_scan_instead_of_a_push_only_job() {
    let f = Fixture::new().await;
    sqlx::query("UPDATE tracker_connections SET next_run_at=now()-interval '1 minute'")
        .execute(&f.store.pool)
        .await
        .unwrap();
    f.retitle("7", "Local title").await;
    let payloads: Vec<Value> = sqlx::query_scalar(
        "SELECT payload::jsonb FROM jobs WHERE queue='tracker' AND state='pending'",
    )
    .fetch_all(&f.store.pool)
    .await
    .unwrap();
    assert_eq!(payloads.len(), 1);
    assert!(payloads[0].get("push_only").is_none(), "{}", payloads[0]);
    drain(&f.store).await;
    assert!(f.outbox().await.is_empty());
    let scheduled: bool = sqlx::query_scalar("SELECT next_run_at>now() FROM tracker_connections")
        .fetch_one(&f.store.pool)
        .await
        .unwrap();
    assert!(scheduled, "the scan ran");
    f.cleanup().await;
}

#[tokio::test]
async fn edits_holding_the_graph_lock_can_queue_while_a_page_waits_for_it() {
    let f = Fixture::new().await;
    sqlx::query("UPDATE tracker_connections SET next_run_at=now()")
        .execute(&f.store.pool)
        .await
        .unwrap();
    // An interactive edit: graph lock first, then an outbox row referencing the connection.
    let mut edit = f.store.pool.begin().await.unwrap();
    let edit_pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
        .fetch_one(&mut *edit)
        .await
        .unwrap();
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,41827))")
        .bind(f.workspace.to_string())
        .execute(&mut *edit)
        .await
        .unwrap();
    let store = f.store.clone();
    let page = tokio::spawn(async move {
        tracker::schedule(&store).await.unwrap();
        let claims = store.outbox.claim("tracker", 1).await.unwrap();
        let Job::Tracker(job) = Job::decode(&claims[0].kind, &claims[0].payload).unwrap() else {
            panic!("wrong queue kind");
        };
        tracker::execute(&store, &claims[0], &job).await
    });
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let blocked: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND $1=ANY(pg_blocking_pids(pid)))")
                .bind(edit_pid).fetch_one(&f.store.pool).await.unwrap();
            if blocked {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("the page did not wait for the graph lock");
    tokio::time::timeout(
        Duration::from_secs(5),
        sqlx::query("INSERT INTO tracker_outbox(id,workspace_id,connection_id,issue_id,kind,fields) SELECT gen_random_uuid(),workspace_id,(tracker->>'connection_id')::uuid,id,'fields','{title}' FROM issues WHERE tracker->>'remote_id'='7'")
            .execute(&mut *edit),
    )
    .await
    .expect("the edit waited for the page")
    .unwrap();
    edit.commit().await.unwrap();
    page.await.unwrap().unwrap();
    let state: String = sqlx::query_scalar(
        "SELECT state FROM jobs WHERE queue='tracker' ORDER BY created_at DESC LIMIT 1",
    )
    .fetch_one(&f.store.pool)
    .await
    .unwrap();
    assert_eq!(state, "succeeded");
    assert_eq!(f.outbox().await.len(), 1);
    f.cleanup().await;
}
