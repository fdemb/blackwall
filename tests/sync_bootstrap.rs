mod support;

use axum::{
    body::Body,
    http::{HeaderMap, Request, StatusCode},
    response::Response,
};
use blackwall::{
    auth::{Register, Session},
    http::router,
    store::{SYNC_SCHEMA, Store, StoreConfig},
};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    time::{Duration, Instant},
};
use tower::ServiceExt;
use uuid::Uuid;

async fn request(
    app: &axum::Router,
    user: &Session,
    method: &str,
    path: &str,
    input: Option<Value>,
    encoding: Option<&str>,
) -> Response {
    let mut request = Request::builder()
        .method(method)
        .uri(path)
        .header("Authorization", format!("Bearer {}", user.token));
    if let Some(encoding) = encoding {
        request = request.header("Accept-Encoding", encoding);
    }
    let body = match input {
        Some(input) => {
            request = request.header("Content-Type", "application/json");
            Body::from(input.to_string())
        }
        None => Body::empty(),
    };
    app.clone()
        .oneshot(request.body(body).unwrap())
        .await
        .unwrap()
}

async fn call(
    app: &axum::Router,
    user: &Session,
    method: &str,
    path: &str,
    input: Option<Value>,
) -> Value {
    let response = request(app, user, method, path, input, None).await;
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let value: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(status, StatusCode::OK, "{value}");
    value
}

async fn account(store: &Store, name: &str) -> Session {
    store
        .register(Register {
            email: format!("{name}-{}@example.com", Uuid::new_v4()),
            password: "test-password-123".into(),
            display_name: name.into(),
        })
        .await
        .unwrap()
}

fn id(value: &Value) -> Uuid {
    Uuid::parse_str(value.as_str().unwrap()).unwrap()
}

async fn command(app: &axum::Router, user: &Session, ws: Uuid, command: Value) -> Value {
    call(
        app,
        user,
        "POST",
        &format!("/internal-api/workspaces/{ws}/commands"),
        Some(json!({"command":command})),
    )
    .await
}

async fn created(app: &axum::Router, user: &Session, ws: Uuid, input: Value) -> Uuid {
    id(&command(app, user, ws, input).await["result"]["id"])
}

async fn setup(store: &Store, app: &axum::Router) -> (Session, Uuid, Uuid) {
    let owner = account(store, "owner").await;
    let ws = id(&call(
        app,
        &owner,
        "POST",
        "/internal-api/workspaces",
        Some(json!({"name":"Bootstrap","slug":Uuid::new_v4().to_string()})),
    )
    .await["workspace"]["id"]);
    let team = created(
        app,
        &owner,
        ws,
        json!({"type":"create_team","name":"Team", "key": "TEA","members":[owner.profile.id]}),
    )
    .await;
    (owner, ws, team)
}

async fn pull(
    app: &axum::Router,
    user: &Session,
    ws: Uuid,
    client: Uuid,
    cursor: Option<&str>,
) -> Value {
    let mut path = format!("/internal-api/workspaces/{ws}/sync/pull?client_id={client}");
    if let Some(cursor) = cursor {
        path.push_str("&cursor=");
        path.push_str(cursor);
    }
    call(app, user, "GET", &path, None).await
}

fn lines(bytes: &[u8]) -> Vec<Value> {
    assert_eq!(bytes.last(), Some(&b'\n'));
    bytes
        .split(|b| *b == b'\n')
        .filter(|line| !line.is_empty())
        .map(|line| serde_json::from_slice(line).unwrap())
        .collect()
}

async fn bootstrap(
    app: &axum::Router,
    user: &Session,
    ws: Uuid,
    client: Uuid,
    encoding: Option<&str>,
) -> (HeaderMap, Vec<u8>) {
    let response = request(
        app,
        user,
        "GET",
        &format!("/internal-api/workspaces/{ws}/sync/bootstrap?client_id={client}"),
        None,
        encoding,
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()["content-type"], "application/x-ndjson");
    let headers = response.headers().clone();
    let bytes = response
        .into_body()
        .collect()
        .await
        .unwrap()
        .to_bytes()
        .to_vec();
    (headers, bytes)
}

fn records(lines: &[Value]) -> BTreeMap<(String, Uuid), Value> {
    assert_eq!(
        lines.last().unwrap(),
        &json!({"end":true,"records":lines.len()-2})
    );
    lines[1..lines.len() - 1]
        .iter()
        .map(|line| {
            let entity = line["entity"].as_str().unwrap();
            let record = &line["record"];
            let key = if entity == "alert_preferences" {
                &record["user_id"]
            } else {
                &record["id"]
            };
            ((entity.to_owned(), id(key)), record.clone())
        })
        .collect()
}

#[tokio::test]
async fn bootstrap_all_entities_match_pull_and_rest_keeps_counts() {
    let database = support::TestDatabase::new().await;
    let store = Store::connect(&database.url).await.unwrap();
    let app = router(store.clone());
    let (owner, ws, team) = setup(&store, &app).await;
    let client = Uuid::new_v4();
    let cursor = pull(&app, &owner, ws, client, None).await["cursor"]
        .as_str()
        .unwrap()
        .to_owned();

    // Roots already exist so the cursor does not cross the actor's role marker.
    // Touch them without changing a role, then create the remaining records.
    sqlx::query("UPDATE workspaces SET name='All entities' WHERE id=$1")
        .bind(ws)
        .execute(&store.pool)
        .await
        .unwrap();
    sqlx::query("UPDATE workspace_members SET version=version+1 WHERE workspace_id=$1")
        .bind(ws)
        .execute(&store.pool)
        .await
        .unwrap();
    sqlx::query("UPDATE teams SET name='All entities' WHERE id=$1")
        .bind(team)
        .execute(&store.pool)
        .await
        .unwrap();
    created(
        &app,
        &owner,
        ws,
        json!({"type":"create_label","name":"Bug","color":"red"}),
    )
    .await;
    let project = created(
        &app,
        &owner,
        ws,
        json!({"type":"create_project","name":"Project","team_ids":[team]}),
    )
    .await;
    created(
        &app,
        &owner,
        ws,
        json!({"type":"create_milestone","project_id":project,"name":"Milestone"}),
    )
    .await;
    created(&app, &owner, ws, json!({"type":"create_sprint","team_id":team,"name":"Sprint","goal":"Ship","starts_at":"2026-10-01T00:00:00Z","ends_at":"2026-10-15T00:00:00Z"})).await;
    created(
        &app,
        &owner,
        ws,
        json!({"type":"save_view","name":"Mine","shared":false,"filter":{}}),
    )
    .await;
    command(&app, &owner, ws, json!({"type":"configure_alerts","assignment":true,"reply":true,"change":true,"mention":true,"deadline":true})).await;
    created(&app, &owner, ws, json!({"type":"invite","email":"invited@example.com","role":"member","token_hash":"hidden"})).await;
    created(&app, &owner, ws, json!({"type":"create_integration","name":"Webhook","webhook_url":"https://example.com/hook","secret":"hidden"})).await;
    let issue = created(
        &app,
        &owner,
        ws,
        json!({"type":"create_issue","input":{"team_id":team,"title":"Parent"}}),
    )
    .await;
    created(
        &app,
        &owner,
        ws,
        json!({"type":"create_issue","input":{"team_id":team,"title":"Child","parent_id":issue}}),
    )
    .await;
    let trash = created(
        &app,
        &owner,
        ws,
        json!({"type":"create_issue","input":{"team_id":team,"title":"Trash"}}),
    )
    .await;
    command(&app, &owner, ws, json!({"type":"delete_issue","id":trash})).await;
    let done: Uuid = sqlx::query_scalar("SELECT id FROM stages WHERE team_id=$1 AND kind='done'")
        .bind(team)
        .fetch_one(&store.pool)
        .await
        .unwrap();
    let archive = created(
        &app,
        &owner,
        ws,
        json!({"type":"create_issue","input":{"team_id":team,"title":"Archive","stage_id":done}}),
    )
    .await;
    command(
        &app,
        &owner,
        ws,
        json!({"type":"archive_issue","id":archive}),
    )
    .await;
    created(
        &app,
        &owner,
        ws,
        json!({"type":"add_comment","issue_id":issue,"body":"Discussion"}),
    )
    .await;
    created(
        &app,
        &owner,
        ws,
        json!({"type":"log_time","issue_id":issue,"minutes":30,"logged_at":"2026-10-09T12:00:00Z"}),
    )
    .await;
    sqlx::query("INSERT INTO notifications(id,workspace_id,user_id,issue_id,kind,message,created_at,dedup_key) VALUES(gen_random_uuid(),$1,$2,$3,'mention','Hello',now(),'test')").bind(ws).bind(owner.profile.id).bind(issue).execute(&store.pool).await.unwrap();

    let (headers, bytes) = bootstrap(&app, &owner, ws, client, None).await;
    assert!(!headers.contains_key("content-encoding"));
    let data = lines(&bytes);
    assert_eq!(data[0]["schema"], SYNC_SCHEMA);
    assert_eq!(data[0]["last_mutation_id"], 0);
    assert_eq!(data[0].as_object().unwrap().len(), 3);
    let all = records(&data);
    let entities: BTreeSet<_> = all.keys().map(|(entity, _)| entity.as_str()).collect();
    assert_eq!(
        entities,
        BTreeSet::from([
            "workspace",
            "members",
            "teams",
            "labels",
            "projects",
            "milestones",
            "sprints",
            "views",
            "alert_preferences",
            "notifications",
            "invitations",
            "integrations",
            "issues",
            "time_entries"
        ])
    );
    assert!(all[&("issues".into(), trash)]["deleted_at"].is_string());
    assert!(all[&("issues".into(), archive)]["archived_at"].is_string());
    let pulled = pull(&app, &owner, ws, client, Some(&cursor)).await;
    assert_eq!(pulled["reset"], false);
    assert_eq!(pulled["more"], false);
    for ((entity, key), record) in &all {
        let change = pulled["changes"]
            .as_array()
            .unwrap()
            .iter()
            .find(|change| change["entity"] == *entity && id(&change["id"]) == *key)
            .unwrap();
        assert_eq!(&change["record"], record, "{entity}/{key}");
        assert_eq!(
            serde_json::to_vec(&change["record"]).unwrap(),
            serde_json::to_vec(record).unwrap()
        );
    }
    for (_, record) in all.iter().filter(|((entity, _), _)| entity == "issues") {
        for count in ["blocked_count", "subtask_total", "subtask_completed"] {
            assert!(record.get(count).is_none());
        }
    }
    let detail = call(
        &app,
        &owner,
        "GET",
        &format!("/internal-api/workspaces/{ws}/issues/{issue}"),
        None,
    )
    .await;
    let list = call(
        &app,
        &owner,
        "GET",
        &format!("/internal-api/workspaces/{ws}/issues"),
        None,
    )
    .await;
    for count in ["blocked_count", "subtask_total", "subtask_completed"] {
        assert!(detail[count].is_number());
        assert!(
            list["items"]
                .as_array()
                .unwrap()
                .iter()
                .all(|record| record[count].is_number())
        );
    }
    assert_eq!(detail["subtask_total"], 1);

    drop(app);
    store.pool.close().await;
    database.cleanup().await;
}

#[tokio::test]
async fn bootstrap_visibility_matches_pull_for_members_and_admins() {
    let database = support::TestDatabase::new().await;
    let store = Store::connect(&database.url).await.unwrap();
    let app = router(store.clone());
    let (owner, ws, team) = setup(&store, &app).await;
    let member = account(&store, "member").await;
    let admin = account(&store, "admin").await;
    for (user, role) in [(&member, "member"), (&admin, "admin")] {
        sqlx::query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,$3)")
            .bind(ws)
            .bind(user.profile.id)
            .bind(role)
            .execute(&store.pool)
            .await
            .unwrap();
    }
    let clients = [Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4()];
    let users = [&owner, &member, &admin];
    let mut cursors = Vec::new();
    for (user, client) in users.iter().zip(clients) {
        cursors.push(
            pull(&app, user, ws, client, None).await["cursor"]
                .as_str()
                .unwrap()
                .to_owned(),
        );
    }
    for user in users {
        created(
            &app,
            user,
            ws,
            json!({"type":"save_view","name":"Private","shared":false,"filter":{}}),
        )
        .await;
        command(&app, user, ws, json!({"type":"configure_alerts","assignment":true,"reply":true,"change":true,"mention":true,"deadline":true})).await;
        sqlx::query("INSERT INTO notifications(id,workspace_id,user_id,kind,message,created_at,dedup_key) VALUES(gen_random_uuid(),$1,$2,'mention','Private',now(),$2::text)").bind(ws).bind(user.profile.id).execute(&store.pool).await.unwrap();
    }
    let shared = created(
        &app,
        &owner,
        ws,
        json!({"type":"save_view","name":"Shared","shared":true,"filter":{}}),
    )
    .await;
    created(&app, &owner, ws, json!({"type":"invite","email":"invited@example.com","role":"viewer","token_hash":"hidden"})).await;
    created(&app, &owner, ws, json!({"type":"create_integration","name":"Hook","webhook_url":"https://example.com","secret":"hidden"})).await;
    let issue = created(
        &app,
        &owner,
        ws,
        json!({"type":"create_issue","input":{"team_id":team,"title":"Common"}}),
    )
    .await;
    for (index, user) in users.iter().enumerate() {
        let all = records(&lines(
            &bootstrap(&app, user, ws, clients[index], None).await.1,
        ));
        assert!(all.contains_key(&("issues".into(), issue)));
        assert!(all.contains_key(&("views".into(), shared)));
        for ((entity, _), record) in &all {
            match entity.as_str() {
                "views" => {
                    assert!(record["shared"] == true || id(&record["owner"]) == user.profile.id)
                }
                "notifications" | "alert_preferences" => {
                    assert_eq!(id(&record["user_id"]), user.profile.id)
                }
                "invitations" => {
                    assert_ne!(index, 1);
                    assert_eq!(record["token_hash"], "");
                }
                "integrations" => {
                    assert_ne!(index, 1);
                    assert_eq!(record["secret"], "");
                }
                _ => {}
            }
        }
        assert_eq!(
            all.keys().filter(|(entity, _)| entity == "views").count(),
            2
        );
        assert_eq!(
            all.keys()
                .filter(|(entity, _)| entity == "notifications")
                .count(),
            1
        );
        assert_eq!(
            all.keys()
                .filter(|(entity, _)| entity == "alert_preferences")
                .count(),
            1
        );
        for entity in ["invitations", "integrations"] {
            assert_eq!(
                all.keys().filter(|(kind, _)| kind == entity).count(),
                usize::from(index != 1)
            );
        }
        let pulled = pull(&app, user, ws, clients[index], Some(&cursors[index])).await;
        assert_eq!(pulled["reset"], false);
        for change in pulled["changes"].as_array().unwrap() {
            if change["entity"] == "activity" || change["record"].is_null() {
                continue;
            }
            assert_eq!(
                &all[&(change["entity"].as_str().unwrap().into(), id(&change["id"]))],
                &change["record"]
            );
        }
    }
    drop(app);
    store.pool.close().await;
    database.cleanup().await;
}

#[tokio::test]
async fn bootstrap_cursor_and_acknowledgment_share_the_snapshot() {
    let database = support::TestDatabase::new().await;
    let store = Store::connect(&database.url).await.unwrap();
    let app = router(store.clone());
    let (owner, ws, team) = setup(&store, &app).await;
    let client = Uuid::new_v4();
    let issue = Uuid::new_v4();
    let push_path = format!("/internal-api/workspaces/{ws}/sync/push");
    let pushed = call(&app, &owner, "POST", &push_path, Some(json!({"client_id":client,"mutations":[
        {"id":7,"name":"create_issue","args":{"input":{"id":issue,"team_id":team,"title":"Before"}},"at":"2026-10-09T12:00:00Z"}
    ]}))).await;
    assert_eq!(pushed["results"][0]["status"], "applied");
    let data = lines(&bootstrap(&app, &owner, ws, client, None).await.1);
    assert_eq!(data[0]["last_mutation_id"], 7);
    assert_eq!(records(&data)[&("issues".into(), issue)]["title"], "Before");
    let cursor = data[0]["cursor"].as_str().unwrap();
    let no_changes = pull(&app, &owner, ws, client, Some(cursor)).await;
    assert_eq!(no_changes["reset"], false);
    assert_eq!(no_changes["changes"], json!([]));
    let pushed = call(&app, &owner, "POST", &push_path, Some(json!({"client_id":client,"mutations":[
        {"id":9,"name":"update_issue","args":{"id":issue,"patch":{"title":"After"}},"at":"2026-10-09T12:01:00Z"}
    ]}))).await;
    assert_eq!(pushed["results"][0]["status"], "applied");
    let changes = pull(&app, &owner, ws, client, Some(cursor)).await;
    assert_eq!(changes["last_mutation_id"], 9);
    assert_eq!(changes["reset"], false);
    let issues: Vec<_> = changes["changes"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|change| change["entity"] == "issues")
        .collect();
    assert_eq!(issues.len(), 1);
    assert_eq!(issues[0]["record"]["title"], "After");
    drop(app);
    store.pool.close().await;
    database.cleanup().await;
}

fn gunzip(bytes: Vec<u8>) -> Vec<u8> {
    use std::{
        io::Write,
        process::{Command, Stdio},
    };
    let mut child = Command::new("gzip")
        .arg("-dc")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut input = child.stdin.take().unwrap();
    let writer = std::thread::spawn(move || input.write_all(&bytes).unwrap());
    let output = child.wait_with_output().unwrap();
    writer.join().unwrap();
    assert!(output.status.success());
    output.stdout
}

#[tokio::test]
async fn bootstrap_negotiates_gzip_only_on_its_route() {
    let database = support::TestDatabase::new().await;
    let store = Store::connect(&database.url).await.unwrap();
    let app = router(store.clone());
    let (owner, ws, team) = setup(&store, &app).await;
    created(
        &app,
        &owner,
        ws,
        json!({"type":"create_issue","input":{"team_id":team,"title":"Compress"}}),
    )
    .await;
    let client = Uuid::new_v4();
    let (plain_headers, plain) = bootstrap(&app, &owner, ws, client, None).await;
    assert!(!plain_headers.contains_key("content-encoding"));
    let (headers, compressed) = bootstrap(&app, &owner, ws, client, Some("gzip")).await;
    assert_eq!(headers["content-encoding"], "gzip");
    assert!(
        headers["vary"]
            .to_str()
            .unwrap()
            .contains("accept-encoding")
    );
    assert_eq!(&compressed[..2], &[0x1f, 0x8b]);
    let mut plain = lines(&plain);
    let mut decoded = lines(&gunzip(compressed));
    // Separate reads can have different cursors when other databases commit.
    for data in [&mut plain, &mut decoded] {
        assert_eq!(data[0]["schema"], SYNC_SCHEMA);
        assert!(data[0]["cursor"].as_str().unwrap().split(':').count() == 3);
        data[0].as_object_mut().unwrap().remove("cursor");
    }
    assert_eq!(plain, decoded);
    let (headers, _) = bootstrap(&app, &owner, ws, client, Some("gzip;q=0")).await;
    assert!(!headers.contains_key("content-encoding"));
    for path in [
        format!("/internal-api/workspaces/{ws}/sync/pull?client_id={client}"),
        format!(
            "/internal-api/workspaces/{ws}/sync/scope?client_id={client}&entity=comments&issue_id={}",
            Uuid::new_v4()
        ),
    ] {
        let response = request(&app, &owner, "GET", &path, None, Some("gzip")).await;
        assert_eq!(response.status(), StatusCode::OK);
        assert!(!response.headers().contains_key("content-encoding"));
    }
    drop(app);
    store.pool.close().await;
    database.cleanup().await;
}

async fn bulk_issues(store: &Store, ws: Uuid, team: Uuid) {
    let stage: Uuid =
        sqlx::query_scalar("SELECT id FROM stages WHERE team_id=$1 ORDER BY position LIMIT 1")
            .bind(team)
            .fetch_one(&store.pool)
            .await
            .unwrap();
    sqlx::query("INSERT INTO issues(id,workspace_id,number,title,description,team_id,stage_id,priority,position,created_at,updated_at) SELECT gen_random_uuid(),$1,n,'Bulk '||n,'',$2,$3,'normal',n*1024,now(),now() FROM generate_series(1,5000) n")
        .bind(ws).bind(team).bind(stage).execute(&store.pool).await.unwrap();
}

async fn open_snapshots(store: &Store) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND backend_xmin IS NOT NULL")
        .fetch_one(&store.pool).await.unwrap()
}

#[tokio::test]
async fn bootstrap_streams_5000_issues_with_backpressure_and_disconnect_cleanup() {
    let database = support::TestDatabase::new().await;
    let store = Store::connect(&database.url).await.unwrap();
    let app = router(store.clone());
    let (owner, ws, team) = setup(&store, &app).await;
    bulk_issues(&store, ws, team).await;
    let client = Uuid::new_v4();
    let mut receiver = store
        .sync_bootstrap(ws, owner.profile.id, client)
        .await
        .unwrap();
    let header = lines(&receiver.recv().await.unwrap().unwrap())
        .pop()
        .unwrap();
    let cursor = header["cursor"].as_str().unwrap();
    // Stop consuming: only the bounded channel may fill, holding one snapshot.
    tokio::time::timeout(std::time::Duration::from_secs(10), async {
        while receiver.len() != 16 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert_eq!(open_snapshots(&store).await, 1);
    let changed: Uuid = sqlx::query_scalar("SELECT id FROM issues WHERE workspace_id=$1 LIMIT 1")
        .bind(ws)
        .fetch_one(&store.pool)
        .await
        .unwrap();
    sqlx::query("UPDATE issues SET title='After header' WHERE id=$1")
        .bind(changed)
        .execute(&store.pool)
        .await
        .unwrap();
    let mut count = 0;
    let mut trailer = None;
    while let Some(line) = receiver.recv().await {
        let line = lines(&line.unwrap()).pop().unwrap();
        if line["entity"] == "issues" {
            count += 1;
            assert_ne!(line["record"]["title"], "After header");
        }
        if line["end"] == true {
            trailer = Some(line);
        }
    }
    assert_eq!(count, 5000);
    assert_eq!(trailer.unwrap()["records"], 5003);
    let pulled = pull(&app, &owner, ws, client, Some(cursor)).await;
    assert_eq!(pulled["reset"], false);
    assert_eq!(pulled["changes"].as_array().unwrap().len(), 1);
    assert_eq!(pulled["changes"][0]["record"]["title"], "After header");

    // Exercise the HTTP body too, then drop a second response without reading it.
    let data = lines(&bootstrap(&app, &owner, ws, client, None).await.1);
    assert_eq!(
        data.iter()
            .filter(|line| line["entity"] == "issues")
            .count(),
        5000
    );
    assert_eq!(data.last().unwrap()["records"], 5003);
    let response = request(
        &app,
        &owner,
        "GET",
        &format!("/internal-api/workspaces/{ws}/sync/bootstrap?client_id={client}"),
        None,
        None,
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    drop(response);
    tokio::time::timeout(std::time::Duration::from_secs(10), async {
        while open_snapshots(&store).await != 0 {
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    drop(app);
    store.pool.close().await;
    database.cleanup().await;
}

#[tokio::test]
async fn bootstrap_failure_ends_without_a_trailer() {
    let database = support::TestDatabase::new().await;
    let store = Store::connect(&database.url).await.unwrap();
    let app = router(store.clone());
    let (owner, ws, _) = setup(&store, &app).await;
    sqlx::query("ALTER TABLE time_entries RENAME TO unavailable_time_entries")
        .execute(&store.pool)
        .await
        .unwrap();
    let response = request(
        &app,
        &owner,
        "GET",
        &format!(
            "/internal-api/workspaces/{ws}/sync/bootstrap?client_id={}",
            Uuid::new_v4()
        ),
        None,
        None,
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let mut body = response.into_body();
    let mut bytes = Vec::new();
    let mut failed = false;
    while let Some(frame) = body.frame().await {
        match frame {
            Ok(frame) => {
                if let Ok(data) = frame.into_data() {
                    bytes.extend_from_slice(&data);
                }
            }
            Err(_) => {
                failed = true;
                break;
            }
        }
    }
    assert!(failed);
    let data = lines(&bytes);
    assert!(data[0]["cursor"].is_string());
    assert!(data.iter().any(|line| line["entity"] == "teams"));
    assert!(!data.iter().any(|line| line["end"] == true));
    drop(body);
    drop(app);
    store.pool.close().await;
    database.cleanup().await;
}

#[tokio::test]
async fn scopes_return_every_record_for_only_the_requested_target() {
    let database = support::TestDatabase::new().await;
    let store = Store::connect(&database.url).await.unwrap();
    blackwall::fixtures::load(&store, "rich").await.unwrap();
    let owner = store
        .login(blackwall::auth::Login {
            email: "owner@example.com".into(),
            password: "fixture-password-123".into(),
        })
        .await
        .unwrap();
    let app = router(store.clone());
    let ws = Uuid::from_u128(0x20000000_0000_0000_0000_000000000010);
    let issue = Uuid::from_u128(0x20000000_0000_0000_0000_000000000061);
    let other = Uuid::from_u128(0x20000000_0000_0000_0000_000000000060);
    let client = Uuid::new_v4();
    sqlx::query("DELETE FROM activity WHERE workspace_id=$1")
        .bind(ws)
        .execute(&store.pool)
        .await
        .unwrap();
    let cursor = pull(&app, &owner, ws, client, None).await["cursor"]
        .as_str()
        .unwrap()
        .to_owned();
    sqlx::query("UPDATE comments SET body=body WHERE workspace_id=$1")
        .bind(ws)
        .execute(&store.pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO activity(id,workspace_id,actor,action,entity_id,at) VALUES(gen_random_uuid(),$1,$2,'test',$3,now())")
        .bind(ws).bind(owner.profile.id).bind(issue)
        .execute(&store.pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO comments(id,workspace_id,issue_id,author,body,created_at) SELECT gen_random_uuid(),$1,CASE WHEN n<=250 THEN $2 ELSE $3 END,$4,'Comment '||n,now() FROM generate_series(1,251) n")
        .bind(ws).bind(issue).bind(other).bind(owner.profile.id).execute(&store.pool).await.unwrap();
    sqlx::query("INSERT INTO activity(id,workspace_id,entity_id,actor,action,at) SELECT gen_random_uuid(),$1,CASE WHEN n<=250 THEN $2 ELSE $3 END,$4,'test',now() FROM generate_series(1,251) n")
        .bind(ws).bind(issue).bind(other).bind(owner.profile.id).execute(&store.pool).await.unwrap();
    let pulled = pull(&app, &owner, ws, client, Some(&cursor)).await;
    assert_eq!(pulled["reset"], false);
    for (entity, column) in [("comments", "issue_id"), ("activity", "entity_id")] {
        let scope = call(&app,&owner,"GET",&format!("/internal-api/workspaces/{ws}/sync/scope?client_id={client}&entity={entity}&{column}={issue}"),None).await;
        let scope = scope["records"].as_array().unwrap();
        assert_eq!(scope.len(), 251);
        assert!(scope.iter().all(|record| id(&record[column]) == issue));
        for record in scope {
            let change = pulled["changes"]
                .as_array()
                .unwrap()
                .iter()
                .find(|change| change["entity"] == entity && change["id"] == record["id"])
                .unwrap();
            assert_eq!(record, &change["record"]);
        }
        let empty = call(
            &app,
            &owner,
            "GET",
            &format!(
                "/internal-api/workspaces/{ws}/sync/scope?client_id={client}&entity={entity}&{column}={}",
                Uuid::new_v4()
            ),
            None,
        )
        .await;
        assert_eq!(empty, json!({"records":[]}));
    }
    let scope = call(
        &app,
        &owner,
        "GET",
        &format!(
            "/internal-api/workspaces/{ws}/sync/scope?client_id={client}&entity=comments&issue_id={issue}"
        ),
        None,
    )
    .await;
    let original = scope["records"]
        .as_array()
        .unwrap()
        .iter()
        .find(|record| record["attachments"].as_array().unwrap().len() == 1)
        .unwrap();
    assert_eq!(original["mentions"].as_array().unwrap().len(), 1);
    assert_eq!(original["attachments"][0]["name"], "checklist.txt");
    drop(app);
    store.pool.close().await;
    database.cleanup().await;
}

#[tokio::test]
async fn bootstrap_and_scope_reject_invalid_requests_and_client_owners() {
    let database = support::TestDatabase::new().await;
    let store = Store::connect(&database.url).await.unwrap();
    let app = router(store.clone());
    let (owner, ws, _) = setup(&store, &app).await;
    let stranger = account(&store, "stranger").await;
    let member = account(&store, "member").await;
    sqlx::query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'member')")
        .bind(ws)
        .bind(member.profile.id)
        .execute(&store.pool)
        .await
        .unwrap();
    let other_ws = id(&call(
        &app,
        &owner,
        "POST",
        "/internal-api/workspaces",
        Some(json!({"name":"Other","slug":"other"})),
    )
    .await["workspace"]["id"]);
    let clients = [Uuid::new_v4(), Uuid::new_v4()];
    for (client, workspace, user) in [
        (clients[0], ws, member.profile.id),
        (clients[1], other_ws, owner.profile.id),
    ] {
        sqlx::query("INSERT INTO sync_clients(client_id,workspace_id,user_id) VALUES($1,$2,$3)")
            .bind(client)
            .bind(workspace)
            .bind(user)
            .execute(&store.pool)
            .await
            .unwrap();
    }
    let client = Uuid::new_v4();
    let scope = format!("&entity=comments&issue_id={}", Uuid::new_v4());
    for (route, suffix) in [("bootstrap", ""), ("scope", scope.as_str())] {
        for query in [
            String::new(),
            "?client_id=nope".into(),
            "?client_id=".into(),
            format!("?client_id={}", clients[0]),
            format!("?client_id={}", clients[1]),
        ] {
            let query = if query.is_empty() {
                "?".to_owned()
            } else {
                query
            };
            let path = format!("/internal-api/workspaces/{ws}/sync/{route}{query}{suffix}");
            assert_eq!(
                request(&app, &owner, "GET", &path, None, None)
                    .await
                    .status(),
                StatusCode::BAD_REQUEST,
                "{path}"
            );
        }
        let path = format!("/internal-api/workspaces/{ws}/sync/{route}?client_id={client}{suffix}");
        assert_eq!(
            request(&app, &stranger, "GET", &path, None, None)
                .await
                .status(),
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            request(&app, &owner, "GET", &path, None, None)
                .await
                .status(),
            StatusCode::OK
        );
    }
    for suffix in [
        String::new(),
        "&entity=issues".into(),
        "&entity=comments".into(),
        "&entity=activity".into(),
        "&entity=comments&issue_id=nope".into(),
        "&entity=activity&entity_id=nope".into(),
        "&entity=comments&issue_id=".into(),
        "&entity=activity&entity_id=".into(),
        format!("&entity=comments&entity_id={}", Uuid::new_v4()),
        format!("&entity=activity&issue_id={}", Uuid::new_v4()),
    ] {
        let path = format!("/internal-api/workspaces/{ws}/sync/scope?client_id={client}{suffix}");
        assert_eq!(
            request(&app, &owner, "GET", &path, None, None)
                .await
                .status(),
            StatusCode::BAD_REQUEST,
            "{path}"
        );
    }
    drop(app);
    store.pool.close().await;
    database.cleanup().await;
}

#[tokio::test]
async fn issue_and_stage_changes_do_not_fan_out_to_count_neighbors() {
    let database = support::TestDatabase::new().await;
    let store = Store::connect(&database.url).await.unwrap();
    let app = router(store.clone());
    let (owner, ws, team) = setup(&store, &app).await;
    let parent = created(
        &app,
        &owner,
        ws,
        json!({"type":"create_issue","input":{"team_id":team,"title":"Parent"}}),
    )
    .await;
    let child = created(
        &app,
        &owner,
        ws,
        json!({"type":"create_issue","input":{"team_id":team,"title":"Child","parent_id":parent}}),
    )
    .await;
    created(&app,&owner,ws,json!({"type":"create_issue","input":{"team_id":team,"title":"Dependent","dependencies":[child]}})).await;
    let done: Uuid = sqlx::query_scalar("SELECT id FROM stages WHERE team_id=$1 AND kind='done'")
        .bind(team)
        .fetch_one(&store.pool)
        .await
        .unwrap();
    let client = Uuid::new_v4();
    let mut cursor = pull(&app, &owner, ws, client, None).await["cursor"]
        .as_str()
        .unwrap()
        .to_owned();
    for command_value in [
        json!({"type":"move_issue","id":child,"stage_id":done,"before_id":null}),
        json!({"type":"delete_issue","id":child}),
    ] {
        let result = command(&app, &owner, ws, command_value).await;
        let changed: Vec<_> = result["changes"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|c| c["entity"] == "issues")
            .map(|c| id(&c["id"]))
            .collect();
        assert_eq!(changed, vec![child]);
        let pulled = pull(&app, &owner, ws, client, Some(&cursor)).await;
        let changed: Vec<_> = pulled["changes"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|c| c["entity"] == "issues")
            .map(|c| id(&c["id"]))
            .collect();
        assert_eq!(changed, vec![child]);
        cursor = pulled["cursor"].as_str().unwrap().to_owned();
    }
    command(&app,&owner,ws,json!({"type":"update_stage","team_id":team,"id":done,"name":"Reopened","kind":"active","position":4000})).await;
    let pulled = pull(&app, &owner, ws, client, Some(&cursor)).await;
    assert!(
        pulled["changes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|c| c["entity"] == "teams")
    );
    let changed: Vec<_> = pulled["changes"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|c| c["entity"] == "issues")
        .map(|c| id(&c["id"]))
        .collect();
    assert_eq!(changed, vec![child]);
    cursor = pulled["cursor"].as_str().unwrap().to_owned();
    sqlx::query("UPDATE stages SET kind='done' WHERE id=$1")
        .bind(done)
        .execute(&store.pool)
        .await
        .unwrap();
    let pulled = pull(&app, &owner, ws, client, Some(&cursor)).await;
    assert_eq!(pulled["changes"].as_array().unwrap().len(), 1);
    assert_eq!(pulled["changes"][0]["entity"], "teams");
    let gone: bool =
        sqlx::query_scalar("SELECT to_regprocedure('mark_issue_neighbors(uuid,uuid)') IS NULL")
            .fetch_one(&store.pool)
            .await
            .unwrap();
    assert!(gone);
    drop(app);
    store.pool.close().await;
    database.cleanup().await;
}

async fn bulk_issues_n(store: &Store, ws: Uuid, team: Uuid, n: i64) {
    let stage: Uuid =
        sqlx::query_scalar("SELECT id FROM stages WHERE team_id=$1 ORDER BY position LIMIT 1")
            .bind(team)
            .fetch_one(&store.pool)
            .await
            .unwrap();
    sqlx::query("INSERT INTO issues(id,workspace_id,number,title,description,team_id,stage_id,priority,position,created_at,updated_at) SELECT gen_random_uuid(),$1,n,'Bulk '||n,'',$2,$3,'normal',n*1024,now(),now() FROM generate_series(1,$4) n")
        .bind(ws).bind(team).bind(stage).bind(n).execute(&store.pool).await.unwrap();
}

#[tokio::test]
async fn bootstrap_concurrency_limit_returns_503_and_spares_rest() {
    let database = support::TestDatabase::new().await;
    let store = Store::connect_with_config(
        &database.url,
        StoreConfig {
            max_connections: 4,
            ..StoreConfig::default()
        },
    )
    .await
    .unwrap();
    let app = router(store.clone());
    let (owner, ws, team) = setup(&store, &app).await;
    bulk_issues_n(&store, ws, team, 200).await;
    let client = Uuid::new_v4();
    let mut filler = store
        .sync_bootstrap(ws, owner.profile.id, client)
        .await
        .unwrap();
    lines(&filler.recv().await.unwrap().unwrap());
    // The filler stops consuming with a full channel, holding its permit and
    // its snapshot while unread.
    tokio::time::timeout(Duration::from_secs(10), async {
        while filler.len() != 16 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert_eq!(open_snapshots(&store).await, 1);

    let start = Instant::now();
    let response = request(
        &app,
        &owner,
        "GET",
        &format!(
            "/internal-api/workspaces/{ws}/sync/bootstrap?client_id={}",
            Uuid::new_v4()
        ),
        None,
        None,
    )
    .await;
    let waited = start.elapsed();
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(response.headers()["retry-after"], "5");
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let body: Value = serde_json::from_slice(&bytes).unwrap();
    assert!(body["error"].is_string());
    assert!(
        waited >= Duration::from_secs(4),
        "permit wait returned after {waited:?}"
    );
    assert!(
        waited < Duration::from_secs(15),
        "permit wait took {waited:?}"
    );

    // One held bootstrap leaves the rest of the pool usable.
    let start = Instant::now();
    let response = request(&app, &owner, "GET", "/internal-api/workspaces", None, None).await;
    assert_eq!(response.status(), StatusCode::OK);
    assert!(
        start.elapsed() < Duration::from_secs(5),
        "rest blocked behind bootstrap"
    );

    drop(filler);
    tokio::time::timeout(Duration::from_secs(10), async {
        while open_snapshots(&store).await != 0 {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    drop(app);
    store.pool.close().await;
    database.cleanup().await;
}

#[tokio::test]
async fn bootstrap_slow_reader_ends_without_trailer_and_frees_connection() {
    let database = support::TestDatabase::new().await;
    let store = Store::connect_with_config(
        &database.url,
        StoreConfig {
            bootstrap_send_timeout: Duration::from_millis(200),
            ..StoreConfig::default()
        },
    )
    .await
    .unwrap();
    let app = router(store.clone());
    let (owner, ws, team) = setup(&store, &app).await;
    bulk_issues_n(&store, ws, team, 200).await;
    let mut receiver = store
        .sync_bootstrap(ws, owner.profile.id, Uuid::new_v4())
        .await
        .unwrap();
    lines(&receiver.recv().await.unwrap().unwrap());
    tokio::time::timeout(Duration::from_secs(10), async {
        while receiver.len() != 16 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    // Stop reading. The next send misses its deadline, so the body ends
    // without a trailer long before the overall deadline.
    tokio::time::sleep(Duration::from_secs(1)).await;
    let start = Instant::now();
    let mut saw_trailer = false;
    let mut received = 0;
    while let Some(item) = tokio::time::timeout(Duration::from_secs(10), receiver.recv())
        .await
        .unwrap()
    {
        let line = lines(&item.unwrap()).pop().unwrap();
        received += 1;
        if line.get("end") == Some(&json!(true)) {
            saw_trailer = true;
        }
    }
    assert!(!saw_trailer);
    assert!(received > 0);
    assert!(
        start.elapsed() < Duration::from_secs(10),
        "send deadline took {:?}",
        start.elapsed()
    );
    tokio::time::timeout(Duration::from_secs(10), async {
        while open_snapshots(&store).await != 0 {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    drop(app);
    store.pool.close().await;
    database.cleanup().await;
}

fn gunzip_lossy(compressed: &[u8]) -> Vec<u8> {
    use std::{
        io::Write,
        process::{Command, Stdio},
    };
    let mut child = Command::new("gzip")
        .arg("-dc")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let mut input = child.stdin.take().unwrap();
    let owned = compressed.to_vec();
    let writer = std::thread::spawn(move || {
        let _ = input.write_all(&owned);
    });
    let output = child.wait_with_output().unwrap();
    writer.join().unwrap();
    output.stdout
}

#[tokio::test]
async fn bootstrap_failure_without_trailer_under_gzip() {
    let database = support::TestDatabase::new().await;
    let store = Store::connect(&database.url).await.unwrap();
    let app = router(store.clone());
    let (owner, ws, team) = setup(&store, &app).await;
    // Enough issues that the gzip encoder flushes compressed bytes before the
    // failure at time_entries, so the decoded prefix is non-empty.
    bulk_issues_n(&store, ws, team, 1000).await;
    sqlx::query("ALTER TABLE time_entries RENAME TO unavailable_time_entries")
        .execute(&store.pool)
        .await
        .unwrap();
    let response = request(
        &app,
        &owner,
        "GET",
        &format!(
            "/internal-api/workspaces/{ws}/sync/bootstrap?client_id={}",
            Uuid::new_v4()
        ),
        None,
        Some("gzip"),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()["content-encoding"], "gzip");
    let mut body = response.into_body();
    let mut compressed = Vec::new();
    let mut failed = false;
    while let Some(frame) = body.frame().await {
        match frame {
            Ok(frame) => {
                if let Ok(data) = frame.into_data() {
                    compressed.extend_from_slice(&data);
                }
            }
            Err(_) => {
                failed = true;
                break;
            }
        }
    }
    assert!(failed);
    let decoded = gunzip_lossy(&compressed);
    assert!(!decoded.is_empty());
    // Truncated gzip ends mid-line; only complete lines decode as JSON.
    let complete = decoded
        .iter()
        .rposition(|b| *b == b'\n')
        .map(|i| &decoded[..i + 1])
        .unwrap_or(&decoded[..]);
    let data = lines(complete);
    assert!(data[0]["cursor"].is_string());
    assert!(data.iter().any(|line| line["entity"] == "teams"));
    assert!(!data.iter().any(|line| line["end"] == true));
    drop(body);
    drop(app);
    store.pool.close().await;
    database.cleanup().await;
}
