use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use blackwall::{
    auth::{Register, Session},
    domain::{BulkAction, Command, IssueInput, IssuePatch, Priority, Role},
    http::router,
    jobs,
    store::{NewJob, Store},
};
use chrono::{Duration, Utc};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use sqlx::Row;
use tower::ServiceExt;
use uuid::Uuid;

async fn call(
    app: &axum::Router,
    method: &str,
    path: &str,
    token: Option<&str>,
    input: Option<Value>,
) -> (StatusCode, Value) {
    let mut request = Request::builder().method(method).uri(path);
    if let Some(token) = token {
        request = request.header("Authorization", format!("Bearer {token}"));
    }
    let body = if let Some(input) = input {
        request = request.header("Content-Type", "application/json");
        Body::from(input.to_string())
    } else {
        Body::empty()
    };
    let response = app
        .clone()
        .oneshot(request.body(body).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let value = serde_json::from_slice(&bytes)
        .unwrap_or_else(|_| json!({"raw":String::from_utf8_lossy(&bytes)}));
    (status, value)
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
async fn snapshot(app: &axum::Router, user: &Session, id: &str) -> Value {
    let (status, value) = call(
        app,
        "GET",
        &format!("/api/workspaces/{id}"),
        Some(&user.token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{value}");
    value
}
async fn change(app: &axum::Router, user: &Session, id: &str, command: Command) -> Value {
    let revision = snapshot(app, user, id).await["revision"].as_i64().unwrap();
    let (status, value) = call(
        app,
        "POST",
        &format!("/api/workspaces/{id}/commands"),
        Some(&user.token),
        Some(json!({"revision":revision,"command":command})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{value}");
    value
}
fn uuid(value: &Value) -> Uuid {
    Uuid::parse_str(value.as_str().unwrap()).unwrap()
}
fn issue(team: Uuid, title: &str) -> IssueInput {
    serde_json::from_value(json!({"team_id":team,"title":title})).unwrap()
}

#[tokio::test]
async fn complete_contract_on_both_engines() {
    let mut engines = vec!["sqlite::memory:".to_string()];
    if let Ok(url) = std::env::var("TEST_POSTGRES_URL") {
        engines.push(url);
    }
    for url in engines {
        contract(&url).await;
    }
}
async fn contract(url: &str) {
    let store = Store::connect(url).await.unwrap();
    let app = router(store.clone());
    let owner = account(&store, "owner").await;
    let colleague = account(&store, "colleague").await;
    let outsider = account(&store, "outsider").await;
    let (status, value) = call(
        &app,
        "POST",
        "/api/workspaces",
        Some(&owner.token),
        Some(json!({"name":"Infrastructure"})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{value}");
    let id = value["workspace"]["id"].as_str().unwrap().to_owned();
    let workspace_id = Uuid::parse_str(&id).unwrap();
    assert_eq!(
        call(
            &app,
            "GET",
            &format!("/api/workspaces/{id}"),
            Some(&outsider.token),
            None
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    let result = change(
        &app,
        &owner,
        &id,
        Command::CreateTeam {
            name: "Operations".into(),
            members: vec![owner.profile.id],
        },
    )
    .await;
    let team = uuid(&result["result"]["id"]);
    let result = change(
        &app,
        &owner,
        &id,
        Command::CreateProject {
            name: "Certificate rotation".into(),
            description: "Renew edge certificates".into(),
            team_ids: vec![team],
        },
    )
    .await;
    let project = uuid(&result["result"]["id"]);
    let result = change(
        &app,
        &owner,
        &id,
        Command::CreateMilestone {
            project_id: project,
            name: "Renewed".into(),
            deadline: Some(Utc::now() + Duration::days(7)),
        },
    )
    .await;
    let milestone = uuid(&result["result"]["id"]);
    let result = change(
        &app,
        &owner,
        &id,
        Command::CreateLabel {
            name: "security".into(),
            color: "#ff0000".into(),
        },
    )
    .await;
    let label = uuid(&result["result"]["id"]);
    let result = change(
        &app,
        &owner,
        &id,
        Command::CreateSprint {
            team_id: team,
            name: "Week one".into(),
            goal: "Renew certificates".into(),
            starts_at: Utc::now(),
            ends_at: Utc::now() + Duration::days(7),
        },
    )
    .await;
    let sprint = uuid(&result["result"]["id"]);
    let mut input = issue(team, "Rotate signing key");
    input.assignee = Some(owner.profile.id);
    input.project_id = Some(project);
    input.milestone_id = Some(milestone);
    input.sprint_id = Some(sprint);
    input.priority = Priority::High;
    input.estimate = Some(3);
    input.deadline = Some(Utc::now() + Duration::hours(4));
    input.labels = vec![label];
    input.description = "**Rotate** before Friday".into();
    let result = change(&app, &owner, &id, Command::CreateIssue { input }).await;
    let first = uuid(&result["result"]["id"]);
    let mut input = issue(team, "Deploy new certificate");
    input.parent_id = Some(first);
    input.dependencies = vec![first];
    input.sprint_id = Some(sprint);
    let result = change(&app, &owner, &id, Command::CreateIssue { input }).await;
    let child = uuid(&result["result"]["id"]);
    let current = snapshot(&app, &owner, &id).await;
    let revision = current["revision"].as_i64().unwrap();
    let (status, value) = call(
        &app,
        "POST",
        &format!("/api/workspaces/{id}/commands"),
        Some(&owner.token),
        Some(json!({"revision":revision-1,"command":{"type":"delete_issue","id":first}})),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "{value}");
    let result = change(
        &app,
        &owner,
        &id,
        Command::AddComment {
            issue_id: first,
            body: "**Ready** for review".into(),
            mentions: vec![owner.profile.id],
            attachments: vec![],
        },
    )
    .await;
    let comment = uuid(&result["result"]["id"]);
    change(
        &app,
        &owner,
        &id,
        Command::EditComment {
            id: comment,
            body: "Reviewed".into(),
            mentions: vec![],
        },
    )
    .await;
    let result = change(
        &app,
        &owner,
        &id,
        Command::LogTime {
            issue_id: first,
            minutes: 45,
            note: "Rotation".into(),
            logged_at: Utc::now(),
        },
    )
    .await;
    let time = uuid(&result["result"]["id"]);
    change(
        &app,
        &owner,
        &id,
        Command::UpdateTime {
            id: time,
            minutes: 60,
            note: "Reviewed rotation".into(),
            logged_at: Utc::now(),
        },
    )
    .await;
    let (status, report) = call(
        &app,
        "GET",
        &format!("/api/workspaces/{id}/report"),
        Some(&owner.token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(report["total_minutes"], 60);
    assert_eq!(report["projects"][0]["id"], project.to_string());
    let (status, filtered) = call(
        &app,
        "GET",
        &format!(
            "/api/workspaces/{id}/issues?assignee={}&priority=high&label_id={label}",
            owner.profile.id
        ),
        Some(&owner.token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{filtered}");
    assert_eq!(filtered.as_array().unwrap().len(), 1);
    let before = snapshot(&app, &owner, &id).await;
    let revision = before["revision"].as_i64().unwrap();
    let(status,_)=call(&app,"POST",&format!("/api/workspaces/{id}/commands"),Some(&owner.token),Some(json!({"revision":revision,"command":{"type":"bulk_issues","ids":[first,Uuid::new_v4()],"action":{"update":{"title":"Should roll back"}}}}))).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(
        snapshot(&app, &owner, &id).await["workspace"]["issues"][0]["title"],
        "Rotate signing key"
    );
    change(
        &app,
        &owner,
        &id,
        Command::BulkIssues {
            ids: vec![first, child],
            action: BulkAction::Update(Box::new(IssuePatch {
                priority: Some(Priority::Urgent),
                ..Default::default()
            })),
        },
    )
    .await;
    change(&app, &owner, &id, Command::DeleteIssue { id: child }).await;
    assert_eq!(
        call(
            &app,
            "GET",
            &format!("/api/workspaces/{id}/issues?trash=true"),
            Some(&owner.token),
            None
        )
        .await
        .1
        .as_array()
        .unwrap()
        .len(),
        1
    );
    change(&app, &owner, &id, Command::RestoreIssue { id: child }).await;
    change(
        &app,
        &owner,
        &id,
        Command::CompleteSprint {
            id: sprint,
            carryover_sprint_id: None,
        },
    )
    .await;
    let current = snapshot(&app, &owner, &id).await;
    assert!(
        current["workspace"]["issues"]
            .as_array()
            .unwrap()
            .iter()
            .all(|i| i["sprint_id"].is_null())
    );
    assert_eq!(current["workspace"]["sprints"][0]["outcome"]["total"], 2);
    change(
        &app,
        &owner,
        &id,
        Command::Invite {
            email: colleague.profile.email.clone(),
            role: Role::Member,
            token_hash: "ignored-client-hash".into(),
        },
    )
    .await;
    let invite_row=sqlx::query("SELECT payload FROM outbox WHERE kind='email' AND payload LIKE $1 ORDER BY due_at DESC LIMIT 1").bind(format!("%{}%",colleague.profile.email)).fetch_one(&store.pool).await.unwrap();
    let mail: Value = serde_json::from_str(invite_row.try_get("payload").unwrap()).unwrap();
    let (status, value) = call(
        &app,
        "POST",
        &format!("/api/workspaces/{id}/invitations/accept"),
        Some(&colleague.token),
        Some(json!({"token":mail["token"]})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{value}");
    assert_eq!(
        call(
            &app,
            "POST",
            &format!("/api/workspaces/{id}/invitations/accept"),
            Some(&colleague.token),
            Some(json!({"token":mail["token"]}))
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    change(
        &app,
        &owner,
        &id,
        Command::UpdateIssue {
            id: first,
            patch: IssuePatch {
                assignee: Some(colleague.profile.id),
                ..Default::default()
            },
        },
    )
    .await;
    change(
        &app,
        &owner,
        &id,
        Command::AddComment {
            issue_id: first,
            body: format!("Review @{}", colleague.profile.id),
            mentions: vec![colleague.profile.id],
            attachments: vec![],
        },
    )
    .await;
    assert!(
        snapshot(&app, &colleague, &id).await["workspace"]["notifications"]
            .as_array()
            .unwrap()
            .iter()
            .all(|n| n["user_id"] == colleague.profile.id.to_string())
    );
    change(
        &app,
        &owner,
        &id,
        Command::SetRole {
            user_id: colleague.profile.id,
            role: Role::Viewer,
        },
    )
    .await;
    let revision = snapshot(&app, &colleague, &id).await["revision"]
        .as_i64()
        .unwrap();
    assert_eq!(
        call(
            &app,
            "POST",
            &format!("/api/workspaces/{id}/commands"),
            Some(&colleague.token),
            Some(json!({"revision":revision,"command":{"type":"delete_issue","id":first}}))
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    let stale = store.load_workspace(workspace_id).await.unwrap();
    change(
        &app,
        &owner,
        &id,
        Command::RemoveMember {
            user_id: colleague.profile.id,
        },
    )
    .await;
    assert!(store.save_workspace(&stale.0, stale.1).await.is_err());
    assert_eq!(
        call(
            &app,
            "GET",
            &format!("/api/workspaces/{id}"),
            Some(&colleague.token),
            None
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    let current = snapshot(&app, &owner, &id).await;
    let revision = current["revision"].as_i64().unwrap();
    let boundary = "blackwall-test-boundary";
    let upload = format!(
        "--{boundary}\r\nContent-Disposition: form-data; name=\"revision\"\r\n\r\n{revision}\r\n--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"notes.txt\"\r\nContent-Type: text/plain\r\n\r\nrotation notes\r\n--{boundary}--\r\n"
    );
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/api/workspaces/{id}/issues/{first}/attachments"))
                .header("Authorization", format!("Bearer {}", owner.token))
                .header(
                    "Content-Type",
                    format!("multipart/form-data; boundary={boundary}"),
                )
                .body(Body::from(upload))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let current = snapshot(&app, &owner, &id).await;
    let attachment = current["workspace"]["issues"][0]["attachments"][0]["id"]
        .as_str()
        .unwrap();
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!("/api/workspaces/{id}/attachments/{attachment}"))
                .header("Authorization", format!("Bearer {}", owner.token))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response.into_body().collect().await.unwrap().to_bytes(),
        "rotation notes"
    );
    assert_eq!(
        call(
            &app,
            "GET",
            &format!("/api/workspaces/{id}/attachments/{attachment}"),
            Some(&outsider.token),
            None
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    let (status, html) = call(
        &app,
        "POST",
        "/api/markdown",
        Some(&owner.token),
        Some(json!({"text":"**Hello** <script>alert(1)</script> [x](javascript:alert(1))"})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(
        html["html"]
            .as_str()
            .unwrap()
            .contains("<strong>Hello</strong>")
    );
    assert!(!html["html"].as_str().unwrap().contains("<script>"));
    assert!(!html["html"].as_str().unwrap().contains("javascript:"));
    let (status, export) = call(
        &app,
        "GET",
        &format!("/api/workspaces/{id}/export"),
        Some(&owner.token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(export["issues"].as_array().unwrap().len(), 2);
    // Portable JSON export can rebuild the work in a different workspace.
    let (status, target) = call(
        &app,
        "POST",
        "/api/workspaces",
        Some(&owner.token),
        Some(json!({"name":"Imported workspace"})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let target_id = target["workspace"]["id"].as_str().unwrap();
    let (status, imported) = call(
        &app,
        "POST",
        &format!("/api/workspaces/{target_id}/import"),
        Some(&owner.token),
        Some(json!({"revision":0,"transfer":export})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{imported}");
    assert_eq!(imported["summary"]["issues"], 2);
    let imported = snapshot(&app, &owner, target_id).await;
    let imported_issues = imported["workspace"]["issues"].as_array().unwrap();
    assert_ne!(imported_issues[0]["id"], first.to_string());
    assert_eq!(imported_issues[1]["parent_id"], imported_issues[0]["id"]);
    assert_eq!(imported["workspace"]["time_entries"][0]["minutes"], 60);

    // Signed source-control deliveries reject tampering and deduplicate retries.
    let configured = change(
        &app,
        &owner,
        &id,
        Command::CreateIntegration {
            name: "Source control".into(),
            webhook_url: "https://blackwall-test.invalid/hook".into(),
            secret: "integration-test-secret".into(),
        },
    )
    .await;
    let integration = uuid(&configured["result"]["id"]);
    assert_eq!(
        snapshot(&app, &owner, &id).await["workspace"]["integrations"][0]["secret"],
        ""
    );
    let body=json!({"delivery_id":Uuid::new_v4(),"issue_id":first,"url":"https://git.example.com/pull/1","title":"Rotation PR"}).to_string();
    use hmac::{Hmac, Mac};
    use sha2::Sha256;
    let mut mac = Hmac::<Sha256>::new_from_slice(b"integration-test-secret").unwrap();
    mac.update(body.as_bytes());
    let signature = hex::encode(mac.finalize().into_bytes());
    let path = format!("/api/workspaces/{id}/integrations/{integration}/webhook");
    let make_request = |signature: &str| {
        Request::builder()
            .method("POST")
            .uri(&path)
            .header("Content-Type", "application/json")
            .header("X-Blackwall-Signature", signature)
            .body(Body::from(body.clone()))
            .unwrap()
    };
    assert_eq!(
        app.clone()
            .oneshot(make_request("00"))
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        app.clone()
            .oneshot(make_request(&signature))
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    let revision = snapshot(&app, &owner, &id).await["revision"].clone();
    assert_eq!(
        app.clone()
            .oneshot(make_request(&signature))
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    assert_eq!(snapshot(&app, &owner, &id).await["revision"], revision);
    change(
        &app,
        &owner,
        &id,
        Command::UpdateIntegration {
            id: integration,
            enabled: false,
        },
    )
    .await;
    jobs::tick(&store).await.unwrap();
    let queued =
        sqlx::query("SELECT delivered_at FROM outbox WHERE kind='webhook' AND payload LIKE $1")
            .bind(format!("%{integration}%"))
            .fetch_all(&store.pool)
            .await
            .unwrap();
    assert!(!queued.is_empty());
    assert!(
        queued
            .iter()
            .all(|row| row.try_get::<i64, _>("delivered_at").unwrap() > 0)
    );

    // Account alert preferences suppress scheduled reminders without rewriting state each tick.
    store
        .edit_profile(
            owner.profile.clone(),
            blackwall::auth::ProfileEdit {
                display_name: owner.profile.display_name.clone(),
                avatar_url: None,
                contact: String::new(),
                language: blackwall::auth::Language::En,
                theme: blackwall::auth::Theme::System,
                alerts: blackwall::auth::AlertPreferences {
                    deadlines: false,
                    ..Default::default()
                },
            },
        )
        .await
        .unwrap();
    let mut quiet_input = issue(team, "No deadline alert");
    quiet_input.assignee = Some(owner.profile.id);
    quiet_input.deadline = Some(Utc::now() + Duration::hours(1));
    let quiet = change(
        &app,
        &owner,
        &id,
        Command::CreateIssue { input: quiet_input },
    )
    .await;
    let quiet_id = quiet["result"]["id"].clone();
    let revision = snapshot(&app, &owner, &id).await["revision"].clone();
    jobs::tick(&store).await.unwrap();
    let current = snapshot(&app, &owner, &id).await;
    assert_eq!(current["revision"], revision);
    assert!(
        !current["workspace"]["notifications"]
            .as_array()
            .unwrap()
            .iter()
            .any(|n| n["issue_id"] == quiet_id && n["kind"] == "deadline")
    );

    let (a, rev) = store.load_workspace(workspace_id).await.unwrap();
    let mut b = a.clone();
    let mut c = a;
    b.name = "writer one".into();
    c.name = "writer two".into();
    let (first_write, second_write) =
        tokio::join!(store.save_workspace(&b, rev), store.save_workspace(&c, rev));
    assert_ne!(first_write.is_ok(), second_write.is_ok());
    let now = Utc::now().timestamp();
    let job = Uuid::new_v4().to_string();
    store
        .enqueue(&job, "unknown_kind", &json!({}), now)
        .await
        .unwrap();
    jobs::tick(&store).await.unwrap();
    let row = sqlx::query("SELECT attempts,lease_until,last_error FROM outbox WHERE id=$1")
        .bind(&job)
        .fetch_one(&store.pool)
        .await
        .unwrap();
    assert_eq!(row.try_get::<i64, _>("attempts").unwrap(), 1);
    assert_eq!(row.try_get::<i64, _>("lease_until").unwrap(), 0);
    assert!(!row.try_get::<String, _>("last_error").unwrap().is_empty());
    let current = snapshot(&app, &owner, &id).await;
    let deadlines = current["workspace"]["notifications"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|n| n["kind"] == "deadline")
        .count();
    jobs::tick(&store).await.unwrap();
    assert_eq!(
        snapshot(&app, &owner, &id).await["workspace"]["notifications"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|n| n["kind"] == "deadline")
            .count(),
        deadlines
    );
    let foreign_login = Request::builder()
        .method("POST")
        .uri("/api/auth/login")
        .header("Host", "blackwall.local")
        .header("Origin", "https://attacker.example")
        .header("Content-Type", "application/json")
        .body(Body::from("{}"))
        .unwrap();
    assert_eq!(
        app.clone().oneshot(foreign_login).await.unwrap().status(),
        StatusCode::FORBIDDEN
    );
    let cookie_request = Request::builder()
        .method("POST")
        .uri("/api/workspaces")
        .header("Cookie", format!("blackwall_session={}", owner.token))
        .header("Content-Type", "application/json")
        .body(Body::from("{\"name\":\"CSRF\"}"))
        .unwrap();
    assert_eq!(
        app.clone().oneshot(cookie_request).await.unwrap().status(),
        StatusCode::FORBIDDEN
    );
    let cookie_request = Request::builder()
        .method("POST")
        .uri("/api/workspaces")
        .header("Cookie", format!("blackwall_session={}", owner.token))
        .header("X-CSRF-Token", &owner.csrf_token)
        .header("Content-Type", "application/json")
        .body(Body::from("{\"name\":\"CSRF\"}"))
        .unwrap();
    assert_eq!(
        app.clone().oneshot(cookie_request).await.unwrap().status(),
        StatusCode::OK
    );
    let (status, schema) = call(&app, "GET", "/api/schema.json", None, None).await;
    assert_eq!(status, StatusCode::OK);
    assert!(schema["components"]["schemas"]["Command"].is_object());
    let response = app
        .clone()
        .oneshot(Request::builder().uri("/").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert!(
        response
            .into_body()
            .collect()
            .await
            .unwrap()
            .to_bytes()
            .starts_with(b"<!doctype html>")
    );
    let result = store
        .register(Register {
            email: owner.profile.email.clone(),
            password: "another-password-123".into(),
            display_name: "duplicate".into(),
        })
        .await;
    assert!(result.is_err());
    store
        .request_reset(blackwall::auth::ResetRequest {
            email: owner.profile.email.clone(),
        })
        .await
        .unwrap();
    let row=sqlx::query("SELECT payload FROM outbox WHERE kind='email' AND payload LIKE $1 AND payload LIKE '%Reset your%' LIMIT 1").bind(format!("%{}%",owner.profile.email)).fetch_one(&store.pool).await.unwrap();
    let payload: Value = serde_json::from_str(row.try_get("payload").unwrap()).unwrap();
    let token = payload["token"].as_str().unwrap().to_owned();
    store
        .reset_password(blackwall::auth::ResetPassword {
            token: token.clone(),
            password: "new-password-123".into(),
        })
        .await
        .unwrap();
    assert!(store.authenticate(&owner.token).await.is_err());
    assert!(
        store
            .reset_password(blackwall::auth::ResetPassword {
                token,
                password: "new-password-123".into()
            })
            .await
            .is_err()
    );
    assert!(
        store
            .login(blackwall::auth::Login {
                email: owner.profile.email,
                password: "new-password-123".into()
            })
            .await
            .is_ok()
    );
    // An outbox insertion must roll back with a stale workspace save.
    let stale_job = Uuid::new_v4().to_string();
    let result = store
        .commit_workspace(
            &b,
            rev,
            &[NewJob {
                id: stale_job.clone(),
                kind: "email".into(),
                payload: json!({}),
                due_at: now,
            }],
            None,
        )
        .await;
    assert!(result.is_err());
    assert!(
        sqlx::query("SELECT id FROM outbox WHERE id=$1")
            .bind(stale_job)
            .fetch_optional(&store.pool)
            .await
            .unwrap()
            .is_none()
    );
    store.pool.close().await;
}
