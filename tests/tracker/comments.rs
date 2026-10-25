use super::{push::Fixture, *};

const STRANGER: i64 = 77;

impl Fixture {
    /// Comments of package 7 as (remote ID, author, author name, body), oldest first.
    async fn comments(&self) -> Vec<(String, Uuid, Option<String>, String)> {
        sqlx::query_as("SELECT c.tracker->>'remote_id',c.author,c.tracker->>'author_name',c.body FROM comments c JOIN issues i ON i.id=c.issue_id WHERE i.tracker->>'remote_id'='7' ORDER BY c.created_at,c.id")
            .fetch_all(&self.store.pool)
            .await
            .unwrap()
    }

    async fn replies(&self) -> Vec<Uuid> {
        sqlx::query_scalar("SELECT user_id FROM notifications WHERE kind='reply' ORDER BY user_id")
            .fetch_all(&self.store.pool)
            .await
            .unwrap()
    }

    async fn reply_actors(&self) -> Vec<Option<Uuid>> {
        sqlx::query_scalar("SELECT actor_id FROM notifications WHERE kind='reply' ORDER BY user_id")
            .fetch_all(&self.store.pool)
            .await
            .unwrap()
    }

    async fn activity_requests(&self) -> Vec<i64> {
        let mut requests = self.mock.data.lock().await.activity_requests.clone();
        requests.sort();
        requests
    }

    /// Adds a remote comment to package 7 and moves its `updatedAt`.
    async fn remote_comment(&self, id: usize, user: i64, name: &str, body: &str) {
        let mut data = self.mock.data.lock().await;
        let at = chrono::Utc::now().to_rfc3339();
        data.activities
            .entry(7)
            .or_default()
            .push(activity(id, user, name, body, &at));
        data.updated_at = Some(at);
    }

    async fn touch_remote(&self) {
        self.mock.data.lock().await.updated_at = Some(chrono::Utc::now().to_rfc3339());
    }

    async fn add_comment(&self, body: &str) {
        let issue = self.first().await;
        let (status, value) = call(
            &self.app,
            &self.owner,
            "POST",
            &format!("/internal-api/workspaces/{}/commands", self.workspace),
            Some(json!({"expected_versions":{},"command":{"type":"add_comment","issue_id":issue["id"],"body":body,"mentions":[]}})),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{value}");
    }

    async fn retry_pushes(&self) {
        sqlx::query("UPDATE tracker_outbox SET retry_at=NULL")
            .execute(&self.store.pool)
            .await
            .unwrap();
        drain(&self.store).await;
    }

    async fn push_error(&self) -> Value {
        let list = self.action.rsplit_once('/').unwrap().0;
        let (status, value) = call(&self.app, &self.owner, "GET", list, None).await;
        assert_eq!(status, StatusCode::OK, "{value}");
        value["connections"][0]["push_error"].clone()
    }

    async fn comments_at(&self) -> Option<chrono::DateTime<chrono::Utc>> {
        serde_json::from_value(self.link().await["comments_at"].clone()).unwrap()
    }

    async fn connection(&self) -> (String, String) {
        sqlx::query_as("SELECT status,last_error FROM tracker_connections")
            .fetch_one(&self.store.pool)
            .await
            .unwrap()
    }
}

#[tokio::test]
async fn enabling_import_brings_history_silently_then_new_comments_notify() {
    let jane_email = format!("jane-{}@example.com", Uuid::new_v4());
    let email = jane_email.clone();
    let off = json!({"options":{"comments":{"import":false,"export":true}}});
    let f = Fixture::with(off, move |remote| {
        remote.assignee_email = Some(email);
        remote.activities.insert(
            7,
            vec![activity(
                201,
                STRANGER,
                "Ghost Writer",
                "Old *history*",
                "2026-09-01T08:00:00Z",
            )],
        );
    })
    .await;
    assert!(f.activity_requests().await.is_empty(), "import is off");
    assert!(f.comments().await.is_empty());

    let jane = f
        .store
        .register(Register {
            email: jane_email,
            password: "test-password-123".into(),
            display_name: "Jane".into(),
        })
        .await
        .unwrap();
    sqlx::query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'member')")
        .bind(f.workspace)
        .bind(jane.profile.id)
        .execute(&f.store.pool)
        .await
        .unwrap();
    let issue = Uuid::parse_str(f.first().await["id"].as_str().unwrap()).unwrap();
    for user in [f.owner.profile.id, jane.profile.id] {
        sqlx::query("INSERT INTO issue_followers(workspace_id,issue_id,user_id) VALUES($1,$2,$3)")
            .bind(f.workspace)
            .bind(issue)
            .bind(user)
            .execute(&f.store.pool)
            .await
            .unwrap();
    }

    // Enabling import fetches every linked package once; history is silent.
    let (status, value) = call(
        &f.app,
        &f.owner,
        "PATCH",
        &f.action,
        Some(json!({"options":{"comments":{"import":true,"export":true}}})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{value}");
    f.sync_now().await;
    assert_eq!(f.activity_requests().await, [7, 8]);
    assert_eq!(
        f.comments().await,
        [(
            "201".into(),
            f.owner.profile.id,
            Some("Ghost Writer".into()),
            "Old *history*".into()
        )]
    );
    let created: chrono::DateTime<chrono::Utc> =
        sqlx::query_scalar("SELECT created_at FROM comments")
            .fetch_one(&f.store.pool)
            .await
            .unwrap();
    assert_eq!(created.to_rfc3339(), "2026-09-01T08:00:00+00:00");
    assert!(f.replies().await.is_empty(), "history is silent");
    assert!(f.outbox().await.is_empty(), "imports never queue pushes");

    // Unchanged packages are not fetched again.
    f.sync_now().await;
    assert_eq!(f.activity_requests().await, [7, 8]);

    // A new comment by a mapped person notifies followers other than its author.
    f.remote_comment(202, 10, "Jane Remote", "Fresh reply")
        .await;
    f.sync_now().await;
    assert_eq!(f.activity_requests().await, [7, 7, 8, 8]);
    let comments = f.comments().await;
    assert_eq!(comments.len(), 2);
    assert_eq!(
        comments[1],
        (
            "202".into(),
            jane.profile.id,
            Some("Jane Remote".into()),
            "Fresh reply".into()
        )
    );
    assert_eq!(f.replies().await, [f.owner.profile.id]);
    assert_eq!(f.reply_actors().await, [Some(jane.profile.id)]);
    let (status, listed) = call(
        &f.app,
        &f.owner,
        "GET",
        &format!(
            "/internal-api/workspaces/{}/comments?issue_id={issue}",
            f.workspace
        ),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{listed}");
    assert!(
        listed["items"]
            .as_array()
            .unwrap()
            .iter()
            .any(|comment| comment["tracker"]["author_name"] == "Jane Remote")
    );

    // Refetching imports nothing twice.
    f.touch_remote().await;
    f.sync_now().await;
    assert_eq!(f.activity_requests().await.len(), 6);
    assert_eq!(f.comments().await.len(), 2);
    assert_eq!(f.replies().await.len(), 1);
    f.cleanup().await;
}

#[tokio::test]
async fn failed_listings_skip_the_package_until_seen_again() {
    let f = Fixture::with(json!({}), |remote| {
        remote.activity_statuses.push_back(500);
        remote.activities.insert(
            7,
            vec![activity(
                201,
                STRANGER,
                "Ghost Writer",
                "Kept",
                "2026-09-01T08:00:00Z",
            )],
        );
    })
    .await;
    assert_eq!(f.activity_requests().await, [7, 8]);
    assert!(f.comments().await.is_empty());
    assert_eq!(f.connection().await.1, "", "the page still commits");
    f.sync_now().await;
    assert_eq!(f.activity_requests().await, [7, 7, 8]);
    assert_eq!(f.comments().await.len(), 1);
    f.cleanup().await;
}

#[tokio::test]
async fn pushed_comments_are_not_imported_back() {
    let f = Fixture::new().await;
    f.add_comment("Local note").await;
    drain(&f.store).await;
    assert_eq!(f.mock.data.lock().await.comments.len(), 1);
    f.touch_remote().await;
    f.sync_now().await;
    assert_eq!(f.activity_requests().await, [7, 7, 8, 8]);
    let comments = f.comments().await;
    assert_eq!(comments.len(), 1);
    assert_eq!(comments[0].0, "501");
    assert_eq!(comments[0].2, None);
    f.cleanup().await;
}

#[tokio::test]
async fn resent_comments_adopt_the_copy_the_remote_already_has() {
    let f = Fixture::new().await;
    f.mock.data.lock().await.lose_comment_responses = true;
    f.add_comment("Only once").await;
    drain(&f.store).await;
    assert_eq!(f.outbox().await[0].1, 1, "the lost response is retried");
    f.mock.data.lock().await.lose_comment_responses = false;
    f.retry_pushes().await;
    assert_eq!(
        f.mock.data.lock().await.comments.len(),
        1,
        "not posted again"
    );
    assert!(f.outbox().await.is_empty());
    assert_eq!(f.comments().await[0].0, "501");
    f.cleanup().await;
}

#[tokio::test]
async fn edited_comments_resent_after_a_lost_response_adopt_the_original_copy() {
    let f = Fixture::new().await;
    f.mock.data.lock().await.lose_comment_responses = true;
    f.add_comment("Original").await;
    drain(&f.store).await;
    f.mock.data.lock().await.lose_comment_responses = false;
    let (comment, version): (Uuid, i64) = sqlx::query_as("SELECT id,version FROM comments")
        .fetch_one(&f.store.pool)
        .await
        .unwrap();
    let (status, value) = call(
        &f.app,
        &f.owner,
        "POST",
        &format!("/internal-api/workspaces/{}/commands", f.workspace),
        Some(json!({"expected_versions":{comment.to_string():version},"command":{"type":"edit_comment","id":comment,"body":"Edited","mentions":[]}})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{value}");
    // A token for another account meanwhile: the copy is still the original sender's.
    sqlx::query("UPDATE tracker_connections SET remote_user_id='999'")
        .execute(&f.store.pool)
        .await
        .unwrap();
    f.retry_pushes().await;
    assert!(f.outbox().await.is_empty());
    assert_eq!(
        f.mock.data.lock().await.comments.len(),
        1,
        "not posted again"
    );
    let comments = f.comments().await;
    assert_eq!(
        (comments[0].0.as_str(), comments[0].3.as_str()),
        ("501", "Edited")
    );
    f.cleanup().await;
}

#[tokio::test]
async fn scans_hold_back_comments_whose_push_response_was_lost() {
    let f = Fixture::new().await;
    f.mock.data.lock().await.lose_comment_responses = true;
    f.add_comment("Only once").await;
    drain(&f.store).await;
    f.mock.data.lock().await.lose_comment_responses = false;
    // The row waits out its backoff while a scan sees the remote comment and leaves it
    // to the push.
    let imported_at = f.comments_at().await;
    f.touch_remote().await;
    f.sync_now().await;
    assert_eq!(f.outbox().await.len(), 1);
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM comments")
        .fetch_one(&f.store.pool)
        .await
        .unwrap();
    assert_eq!(count, 1, "not imported as a second comment");
    assert_eq!(f.comments_at().await, imported_at, "fetched again later");
    f.retry_pushes().await;
    assert!(f.outbox().await.is_empty());
    assert_eq!(
        f.mock.data.lock().await.comments.len(),
        1,
        "not posted again"
    );
    let comments = f.comments().await;
    assert_eq!(
        (comments.len(), comments[0].0.as_str(), comments[0].1),
        (1, "501", f.owner.profile.id)
    );
    f.sync_now().await;
    assert_eq!(f.comments().await.len(), 1);
    assert!(f.link().await["comments_imported"].as_bool().unwrap());
    f.cleanup().await;
}

#[tokio::test]
async fn sends_that_never_recorded_their_outcome_adopt_the_remote_copy() {
    let f = Fixture::new().await;
    f.add_comment("Posted before a crash").await;
    drain(&f.store).await;
    assert_eq!(f.mock.data.lock().await.comments.len(), 1);
    // As if the job stopped after posting, before recording the remote ID.
    sqlx::query("UPDATE comments SET tracker=NULL")
        .execute(&f.store.pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO tracker_outbox(id,workspace_id,connection_id,issue_id,kind,comment_id,sent_at,sent_body) SELECT gen_random_uuid(),workspace_id,(SELECT id FROM tracker_connections),issue_id,'comment',id,now(),body FROM comments")
        .execute(&f.store.pool)
        .await
        .unwrap();
    drain(&f.store).await;
    assert!(f.outbox().await.is_empty());
    assert_eq!(
        f.mock.data.lock().await.comments.len(),
        1,
        "not posted again"
    );
    assert_eq!(f.comments().await[0].0, "501");
    f.cleanup().await;
}

#[tokio::test]
async fn identical_remote_comments_by_others_import_and_never_stand_in_for_a_push() {
    let f = Fixture::new().await;
    f.mock.data.lock().await.push_statuses.push_back(500);
    f.add_comment("Thanks").await;
    drain(&f.store).await;
    assert_eq!(f.outbox().await[0].1, 1);
    f.remote_comment(301, STRANGER, "Ghost Writer", "Thanks")
        .await;
    f.sync_now().await;
    let imported: Vec<(String, String)> = sqlx::query_as(
        "SELECT tracker->>'remote_id',tracker->>'author_name' FROM comments WHERE tracker IS NOT NULL",
    )
    .fetch_all(&f.store.pool)
    .await
    .unwrap();
    assert_eq!(
        imported,
        [("301".into(), "Ghost Writer".into())],
        "imported as theirs"
    );
    assert_eq!(f.outbox().await.len(), 1, "our push is still due");
    f.retry_pushes().await;
    assert!(f.outbox().await.is_empty());
    let posted = f.mock.data.lock().await.comments.len();
    assert_eq!(posted, 2, "the failed post and the retry");
    let ours: Vec<String> = sqlx::query_scalar(
        "SELECT tracker->>'remote_id' FROM comments WHERE tracker->>'author_name' IS NULL",
    )
    .fetch_all(&f.store.pool)
    .await
    .unwrap();
    assert_eq!(ours, ["502"]);
    f.cleanup().await;
}

#[tokio::test]
async fn comments_past_the_workspace_limit_are_fetched_again() {
    let off = json!({"options":{"comments":{"import":false,"export":true}}});
    let limits = Limits::default().with(Resource::Comments, Some(10));
    let f = Fixture::with_limits(off, limits, |remote| {
        remote.activities.insert(
            7,
            vec![
                activity(201, STRANGER, "Ghost", "First", "2026-09-01T08:00:00Z"),
                activity(202, STRANGER, "Ghost", "Second", "2026-09-01T09:00:00Z"),
            ],
        );
    })
    .await;
    let issue = Uuid::parse_str(f.first().await["id"].as_str().unwrap()).unwrap();
    sqlx::query("INSERT INTO comments(id,workspace_id,issue_id,author,body,created_at) SELECT gen_random_uuid(),$1,$2,$3,'Filler',now() FROM generate_series(1,9)")
        .bind(f.workspace)
        .bind(issue)
        .bind(f.owner.profile.id)
        .execute(&f.store.pool)
        .await
        .unwrap();
    let (status, value) = call(
        &f.app,
        &f.owner,
        "PATCH",
        &f.action,
        Some(json!({"options":{"comments":{"import":true,"export":true}}})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{value}");
    f.sync_now().await;
    let imported = |f: &Fixture| {
        let pool = f.store.pool.clone();
        async move {
            sqlx::query_scalar::<_, String>(
                "SELECT tracker->>'remote_id' FROM comments WHERE tracker IS NOT NULL ORDER BY 1",
            )
            .fetch_all(&pool)
            .await
            .unwrap()
        }
    };
    assert_eq!(imported(&f).await, ["201"]);
    let link = f.link().await;
    assert!(link.get("comments_imported").is_none() && link.get("comments_at").is_none());

    // Room frees up; the unchanged package is fetched again and its history completes.
    sqlx::query("DELETE FROM comments WHERE tracker IS NULL AND id IN (SELECT id FROM comments WHERE tracker IS NULL LIMIT 10)")
        .execute(&f.store.pool)
        .await
        .unwrap();
    f.sync_now().await;
    assert_eq!(imported(&f).await, ["201", "202"]);
    assert!(f.link().await["comments_imported"].as_bool().unwrap());
    assert!(f.replies().await.is_empty(), "history stays silent");
    f.cleanup().await;
}

#[tokio::test]
async fn trashed_issues_import_comments_only_after_restore() {
    let f = Fixture::new().await;
    f.sync_now().await;
    let id = f.first().await["id"].clone();
    let imported_at = f.comments_at().await;
    assert!(imported_at.is_some());
    f.run(json!({"type":"delete_issue","id":id})).await;
    f.remote_comment(301, STRANGER, "Ghost", "While trashed")
        .await;
    f.sync_now().await;
    assert!(f.comments().await.is_empty());
    assert_eq!(f.comments_at().await, imported_at);
    assert_eq!(
        f.activity_requests().await,
        [7, 8, 8],
        "trashed: not listed"
    );

    let version: i64 = sqlx::query_scalar("SELECT version FROM issues WHERE id=$1::text::uuid")
        .bind(id.as_str().unwrap())
        .fetch_one(&f.store.pool)
        .await
        .unwrap();
    let (status, value) = call(
        &f.app,
        &f.owner,
        "POST",
        &format!("/internal-api/workspaces/{}/commands", f.workspace),
        Some(json!({"expected_versions":{id.as_str().unwrap():version},"command":{"type":"restore_issue","id":id}})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{value}");
    f.sync_now().await;
    assert_eq!(f.comments().await.len(), 1);
    assert_eq!(f.comments().await[0].3, "While trashed");
    f.cleanup().await;
}

#[tokio::test]
async fn comments_notify_after_the_first_import_without_remote_modification_times() {
    let f = Fixture::with(json!({}), |remote| {
        // Unparseable, as if the provider omitted it.
        remote.updated_at = Some(String::new());
        remote.activities.insert(
            7,
            vec![activity(
                201,
                STRANGER,
                "Ghost",
                "History",
                "2026-09-01T08:00:00Z",
            )],
        );
    })
    .await;
    // Imported comments by unmapped people are by the owner, so another member follows.
    let jane = f
        .store
        .register(Register {
            email: format!("jane-{}@example.com", Uuid::new_v4()),
            password: "test-password-123".into(),
            display_name: "Jane".into(),
        })
        .await
        .unwrap();
    sqlx::query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'member')")
        .bind(f.workspace)
        .bind(jane.profile.id)
        .execute(&f.store.pool)
        .await
        .unwrap();
    let issue = f.first().await["id"].clone();
    sqlx::query(
        "INSERT INTO issue_followers(workspace_id,issue_id,user_id) VALUES($1,$2::text::uuid,$3)",
    )
    .bind(f.workspace)
    .bind(issue.as_str().unwrap())
    .bind(jane.profile.id)
    .execute(&f.store.pool)
    .await
    .unwrap();
    assert_eq!(f.comments().await.len(), 1);
    assert!(f.replies().await.is_empty(), "history is silent");
    assert!(f.link().await["comments_imported"].as_bool().unwrap());
    f.remote_comment(202, STRANGER, "Ghost", "Fresh").await;
    f.mock.data.lock().await.updated_at = Some(String::new());
    f.sync_now().await;
    assert_eq!(f.comments().await.len(), 2);
    assert_eq!(f.replies().await, [jane.profile.id]);
    assert_eq!(
        f.reply_actors().await,
        [None],
        "an unmapped author is nobody local"
    );
    f.cleanup().await;
}

#[tokio::test]
async fn auth_failures_keep_pushes_and_report_on_the_connection() {
    let f = Fixture::new().await;
    f.mock.data.lock().await.push_statuses.push_back(401);
    f.run(
        json!({"type":"update_issue","id":f.first().await["id"],"patch":{"title":"Local title"}}),
    )
    .await;
    drain(&f.store).await;
    let queued = f.outbox().await;
    assert_eq!(queued.len(), 1);
    assert_eq!(queued[0].1, 0, "not counted towards giving up");
    assert!(
        queued[0].2.contains("check the API token"),
        "{}",
        queued[0].2
    );
    assert!(f.first().await["tracker"].get("push_error").is_none());
    let error = f.push_error().await;
    assert!(
        error.as_str().unwrap().contains("check the API token"),
        "{error}"
    );

    // A successful scheduled scan keeps reporting it.
    sqlx::query("UPDATE tracker_connections SET next_run_at=now()")
        .execute(&f.store.pool)
        .await
        .unwrap();
    drain(&f.store).await;
    assert_eq!(f.connection().await, ("idle".into(), String::new()));
    assert!(f.push_error().await.is_string());

    // Fixed credentials send the change and clear the error.
    f.retry_pushes().await;
    assert!(f.outbox().await.is_empty());
    assert_eq!(
        f.mock.data.lock().await.subject.as_deref(),
        Some("Local title")
    );
    assert!(f.push_error().await.is_null());
    f.cleanup().await;
}

#[tokio::test]
async fn permission_failures_never_use_up_the_retry_budget() {
    let f = Fixture::new().await;
    f.mock.data.lock().await.push_statuses = [401; 10].into_iter().chain([500]).collect();
    f.run(
        json!({"type":"update_issue","id":f.first().await["id"],"patch":{"title":"Local title"}}),
    )
    .await;
    for _ in 0..11 {
        f.retry_pushes().await;
    }
    assert!(f.mock.data.lock().await.push_statuses.is_empty());
    let queued = f.outbox().await;
    assert_eq!((queued.len(), queued[0].1), (1, 1), "still kept");
    assert!(f.first().await["tracker"].get("push_error").is_none());

    // A configuration change clears the connection's push error.
    sqlx::query("UPDATE tracker_connections SET push_error='stale'")
        .execute(&f.store.pool)
        .await
        .unwrap();
    f.sync_now().await;
    assert!(f.push_error().await.is_null());
    f.cleanup().await;
}

#[tokio::test]
async fn deleted_comments_stay_deleted() {
    let f = Fixture::new().await;
    f.remote_comment(301, STRANGER, "Ghost Writer", "Imported once")
        .await;
    f.add_comment("Sent from here").await;
    f.sync_now().await;
    let comments = f.comments().await;
    assert_eq!(comments.len(), 2, "{comments:?}");
    for (remote_id, ..) in &comments {
        let id: Uuid = sqlx::query_scalar("SELECT id FROM comments WHERE tracker->>'remote_id'=$1")
            .bind(remote_id)
            .fetch_one(&f.store.pool)
            .await
            .unwrap();
        let (status, value) = call(
            &f.app,
            &f.owner,
            "POST",
            &format!("/internal-api/workspaces/{}/commands", f.workspace),
            Some(json!({"expected_versions":{},"command":{"type":"delete_comment","id":id}})),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{value}");
    }
    assert!(f.comments().await.is_empty());

    // An unrelated remote change lists the comments again.
    f.touch_remote().await;
    f.sync_now().await;
    assert!(f.comments().await.is_empty());
    f.remote_comment(302, STRANGER, "Ghost Writer", "New remote")
        .await;
    f.sync_now().await;
    let comments = f.comments().await;
    assert_eq!(comments.len(), 1);
    assert_eq!(comments[0].3, "New remote");
    f.cleanup().await;
}
