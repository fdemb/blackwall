use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use blackwall::{
    auth::{Register, Session},
    domain::{BulkAction, Command, IssueInput, IssuePatch, Priority, Role},
    http::router_with_web,
    jobs::{self, Mailer},
    store::Store,
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

async fn page(app: &axum::Router, user: &Session, id: &str, resource: &str) -> Value {
    let separator = if resource.contains('?') { '&' } else { '?' };
    let (status, value) = call(
        app,
        "GET",
        &format!("/api/workspaces/{id}/{resource}{separator}limit=200"),
        Some(&user.token),
        None,
    )
    .await;

    assert_eq!(status, StatusCode::OK, "{resource}: {value}");
    assert!(value["items"].is_array(), "{value}");
    assert_eq!(value["has_more"], false);
    value["items"].clone()
}

async fn workspace_state(app: &axum::Router, user: &Session, id: &str) -> Value {
    let (status, mut value) = call(
        app,
        "GET",
        &format!("/api/workspaces/{id}"),
        Some(&user.token),
        None,
    )
    .await;

    assert_eq!(status, StatusCode::OK, "{value}");
    assert!(value.get("revision").is_none());
    assert!(value["workspace"].get("issues").is_none());
    for resource in [
        "teams",
        "labels",
        "projects",
        "milestones",
        "sprints",
        "issues",
        "views",
        "notifications",
        "invitations",
        "integrations",
        "activity",
        "comments",
        "time_entries",
    ] {
        value["workspace"][resource] = page(app, user, id, resource).await;
    }

    let (status, members) = call(
        app,
        "GET",
        &format!("/api/workspaces/{id}/members"),
        Some(&user.token),
        None,
    )
    .await;

    assert_eq!(status, StatusCode::OK, "{members}");
    value["workspace"]["members"] = members;
    value["trash"] = page(app, user, id, "issues?trash=true").await;
    value
}

fn versions(value: &Value) -> Value {
    let mut versions = serde_json::Map::new();
    fn collect(value: &Value, versions: &mut serde_json::Map<String, Value>) {
        match value {
            Value::Object(object) => {
                if let (Some(id), Some(version)) = (
                    object.get("id").or_else(|| object.get("user_id")),
                    object.get("version"),
                ) {
                    versions.insert(id.as_str().unwrap().to_owned(), version.clone());
                }
                for value in object.values() {
                    collect(value, versions);
                }
            }
            Value::Array(values) => {
                for value in values {
                    collect(value, versions);
                }
            }
            _ => {}
        }
    }

    collect(value, &mut versions);
    Value::Object(versions)
}

async fn change(app: &axum::Router, user: &Session, id: &str, command: Command) -> Value {
    let expected_versions = versions(&workspace_state(app, user, id).await);
    let (status, value) = call(
        app,
        "POST",
        &format!("/api/workspaces/{id}/commands"),
        Some(&user.token),
        Some(json!({"expected_versions":expected_versions,"command":command})),
    )
    .await;

    assert_eq!(status, StatusCode::OK, "{value}");
    assert!(value["versions"].is_object());
    assert!(value.get("revision").is_none());
    value
}

fn uuid(value: &Value) -> Uuid {
    Uuid::parse_str(value.as_str().unwrap()).unwrap()
}

fn issue(team: Uuid, title: &str) -> IssueInput {
    serde_json::from_value(json!({"team_id":team,"title":title})).unwrap()
}

mod support;

#[tokio::test]
async fn complete_contract_on_postgres() {
    let database = support::TestDatabase::new().await;
    let store = Store::connect(&database.url).await.unwrap();
    let web = std::env::temp_dir().join(format!("blackwall-web-{}", Uuid::new_v4()));
    std::fs::create_dir_all(&web).unwrap();
    std::fs::write(
        web.join("index.html"),
        "<!DOCTYPE html><script src=\"/theme.js\"></script><script>window.boot=1</script>",
    )
    .unwrap();

    let app = router_with_web(store.clone(), web);
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
            id: None,
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
            id: None,
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
            id: None,
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
            id: None,
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
            id: None,
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
    let (status, value) = call(
        &app,
        "POST",
        &format!("/api/workspaces/{id}/commands"),
        Some(&owner.token),
        Some(json!({
            "expected_versions": {first.to_string(): -1},
            "command": {"type": "delete_issue", "id": first},
        })),
    )
    .await;

    assert_eq!(status, StatusCode::CONFLICT, "{value}");

    let result = change(
        &app,
        &owner,
        &id,
        Command::AddComment {
            id: None,
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
            id: None,
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
    assert_eq!(filtered["items"].as_array().unwrap().len(), 1);
    let before = workspace_state(&app, &owner, &id).await;
    let expected_versions = versions(&before);

    let (status, _) = call(
        &app,
        "POST",
        &format!("/api/workspaces/{id}/commands"),
        Some(&owner.token),
        Some(json!({
            "expected_versions": expected_versions,
            "command": {
                "type": "bulk_issues",
                "ids": [first, Uuid::new_v4()],
                "action": {"update": {"title": "Should roll back"}},
            },
        })),
    )
    .await;

    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(
        workspace_state(&app, &owner, &id).await["workspace"]["issues"][0]["title"],
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
    let (status, trash) = call(
        &app,
        "GET",
        &format!("/api/workspaces/{id}/issues?trash=true"),
        Some(&owner.token),
        None,
    )
    .await;

    assert_eq!(status, StatusCode::OK, "{trash}");
    assert_eq!(trash["items"].as_array().unwrap().len(), 1);
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

    let current = workspace_state(&app, &owner, &id).await;
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

    let invite_row = sqlx::query(
        "SELECT payload FROM jobs \
         WHERE kind='email' AND payload->>'to'=$1 \
         ORDER BY created_at DESC LIMIT 1",
    )
    .bind(&colleague.profile.email)
    .fetch_one(&store.pool)
    .await
    .unwrap();

    let mail: Value = invite_row.try_get("payload").unwrap();
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

    let activity = workspace_state(&app, &owner, &id).await["workspace"]["activity"].clone();
    let assignment_recorded = activity
        .as_array()
        .unwrap()
        .iter()
        .any(|entry| entry["fields"] == json!(["assignee"]));

    change(
        &app,
        &owner,
        &id,
        Command::AddComment {
            id: None,
            issue_id: first,
            body: format!("Review @{}", colleague.profile.id),
            mentions: vec![colleague.profile.id],
            attachments: vec![],
        },
    )
    .await;

    assert!(
        workspace_state(&app, &colleague, &id).await["workspace"]["notifications"]
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

    assert_eq!(
        call(
            &app,
            "POST",
            &format!("/api/workspaces/{id}/commands"),
            Some(&colleague.token),
            Some(json!({"expected_versions":{},"command":{"type":"delete_issue","id":first}}))
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );

    change(
        &app,
        &owner,
        &id,
        Command::RemoveMember {
            user_id: colleague.profile.id,
        },
    )
    .await;

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

    let current = workspace_state(&app, &owner, &id).await;
    let expected_versions = versions(&current);
    let boundary = "blackwall-test-boundary";
    let upload = format!(
        "--{boundary}\r\nContent-Disposition: form-data; name=\"expected_versions\"\r\n\r\n{expected_versions}\r\n--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"notes.txt\"\r\nContent-Type: text/plain\r\n\r\nrotation notes\r\n--{boundary}--\r\n"
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
    let current = workspace_state(&app, &owner, &id).await;
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
        StatusCode::NOT_FOUND
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
        Some(json!({"expected_versions":{},"transfer":export})),
    )
    .await;

    assert_eq!(status, StatusCode::OK, "{imported}");
    assert_eq!(imported["summary"]["issues"], 2);
    let imported = workspace_state(&app, &owner, target_id).await;
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
            id: None,
            name: "Source control".into(),
            webhook_url: "https://blackwall-test.invalid/hook".into(),
            secret: "integration-test-secret".into(),
        },
    )
    .await;

    let integration = uuid(&configured["result"]["id"]);
    assert_eq!(
        workspace_state(&app, &owner, &id).await["workspace"]["integrations"][0]["secret"],
        ""
    );

    let body = json!({
        "delivery_id": Uuid::new_v4(),
        "issue_id": first,
        "url": "https://git.example.com/pull/1",
        "title": "Rotation PR",
    })
    .to_string();

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

    let original_links =
        workspace_state(&app, &owner, &id).await["workspace"]["issues"][0]["source_links"].clone();

    assert_eq!(
        app.clone()
            .oneshot(make_request(&signature))
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );

    assert_eq!(
        workspace_state(&app, &owner, &id).await["workspace"]["issues"][0]["source_links"],
        original_links
    );

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
    jobs::tick(&store, &Mailer::Disabled).await.unwrap();
    let current = workspace_state(&app, &owner, &id).await;
    assert!(
        !current["workspace"]["notifications"]
            .as_array()
            .unwrap()
            .iter()
            .any(|n| n["issue_id"] == quiet_id && n["kind"] == "deadline")
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

    for path in ["/", "/some/client/route"] {
        let response = app
            .clone()
            .oneshot(Request::builder().uri(path).body(Body::empty()).unwrap())
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let csp = response.headers()["content-security-policy"]
            .to_str()
            .unwrap()
            .to_owned();
        assert!(
            csp.contains("'sha256-"),
            "inline bootstrap script must be hashed: {csp}"
        );
        assert!(!csp.contains("unsafe-inline"));
        assert!(
            response
                .into_body()
                .collect()
                .await
                .unwrap()
                .to_bytes()
                .starts_with(b"<!DOCTYPE html>")
        );
    }

    let (status, _) = call(&app, "GET", "/api/nope", None, None).await;

    assert_eq!(status, StatusCode::NOT_FOUND);

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

    let row = sqlx::query(
        "SELECT payload FROM jobs \
         WHERE kind='email' AND payload->>'to'=$1 \
         AND payload->>'subject'='Reset your Blackwall password' LIMIT 1",
    )
    .bind(&owner.profile.email)
    .fetch_one(&store.pool)
    .await
    .unwrap();

    let payload: Value = row.try_get("payload").unwrap();
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

    assert!(
        assignment_recorded,
        "assignment activity must name the changed field"
    );

    store.pool.close().await;
    database.cleanup().await;
}

#[tokio::test]
async fn native_identity_and_atomic_password_recovery() {
    use blackwall::auth::{Login, PasswordChange, ProfileEdit, ResetPassword, ResetRequest, hash};
    use chrono::DateTime;
    use sqlx::types::Json;

    let database = support::TestDatabase::new().await;
    let store = Store::connect(&database.url).await.unwrap();
    let session = account(&store, "identity").await;
    let second = store
        .login(Login {
            email: session.profile.email.to_uppercase(),
            password: "test-password-123".into(),
        })
        .await
        .unwrap();

    let row = sqlx::query(
        "SELECT users.id,users.profile,sessions.token_hash,sessions.expires_at \
         FROM users JOIN sessions ON sessions.user_id=users.id \
         WHERE sessions.token_hash=$1",
    )
    .bind(hash(&session.token))
    .fetch_one(&store.pool)
    .await
    .unwrap();

    assert_eq!(row.try_get::<Uuid, _>("id").unwrap(), session.profile.id);
    assert_eq!(
        row.try_get::<Json<blackwall::auth::Profile>, _>("profile")
            .unwrap()
            .0
            .email,
        session.profile.email
    );

    assert_ne!(
        row.try_get::<String, _>("token_hash").unwrap(),
        session.token
    );

    assert!(
        row.try_get::<DateTime<Utc>, _>("expires_at").unwrap() > Utc::now() + Duration::days(29)
    );

    let updated = store
        .edit_profile(
            session.profile.clone(),
            ProfileEdit {
                display_name: "Updated identity".into(),
                avatar_url: Some("https://example.com/avatar.png".into()),
                contact: "Contact".into(),
                language: blackwall::auth::Language::Pl,
                theme: blackwall::auth::Theme::Dark,
                alerts: blackwall::auth::AlertPreferences {
                    deadlines: false,
                    ..Default::default()
                },
            },
        )
        .await
        .unwrap();

    assert_eq!(
        store
            .authenticate(&session.token)
            .await
            .unwrap()
            .0
            .display_name,
        updated.display_name
    );

    store
        .request_reset(ResetRequest {
            email: "missing@example.com".into(),
        })
        .await
        .unwrap();

    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM password_resets")
            .fetch_one(&store.pool)
            .await
            .unwrap(),
        0
    );

    // A failed enqueue must roll back the reset credential too.
    sqlx::query(
        "ALTER TABLE jobs ADD CONSTRAINT reject_test_email CHECK(kind <> 'email') NOT VALID",
    )
    .execute(&store.pool)
    .await
    .unwrap();

    assert!(
        store
            .request_reset(ResetRequest {
                email: session.profile.email.clone()
            })
            .await
            .is_err()
    );

    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM password_resets")
            .fetch_one(&store.pool)
            .await
            .unwrap(),
        0
    );

    sqlx::query("ALTER TABLE jobs DROP CONSTRAINT reject_test_email")
        .execute(&store.pool)
        .await
        .unwrap();

    store
        .request_reset(ResetRequest {
            email: session.profile.email.clone(),
        })
        .await
        .unwrap();

    let payload: Value =
        sqlx::query_scalar("SELECT payload FROM jobs WHERE kind='email' AND payload->>'to'=$1")
            .bind(&session.profile.email)
            .fetch_one(&store.pool)
            .await
            .unwrap();

    let reset_token = payload["token"].as_str().unwrap().to_owned();
    assert_eq!(
        sqlx::query_scalar::<_, String>("SELECT token_hash FROM password_resets WHERE user_id=$1")
            .bind(session.profile.id)
            .fetch_one(&store.pool)
            .await
            .unwrap(),
        hash(&reset_token)
    );

    let (first, second_reset) = tokio::join!(
        store.reset_password(ResetPassword {
            token: reset_token.clone(),
            password: "recovered-password-123".into()
        }),
        store.reset_password(ResetPassword {
            token: reset_token,
            password: "recovered-password-123".into()
        }),
    );

    assert_ne!(first.is_ok(), second_reset.is_ok());
    assert!(store.authenticate(&session.token).await.is_err());
    assert!(store.authenticate(&second.token).await.is_err());
    let recovered = store
        .login(Login {
            email: session.profile.email.clone(),
            password: "recovered-password-123".into(),
        })
        .await
        .unwrap();

    store
        .request_reset(ResetRequest {
            email: session.profile.email.clone(),
        })
        .await
        .unwrap();

    store
        .change_password(
            session.profile.id,
            PasswordChange {
                current_password: "recovered-password-123".into(),
                new_password: "changed-password-123".into(),
            },
        )
        .await
        .unwrap();

    assert!(store.authenticate(&recovered.token).await.is_err());
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM password_resets WHERE user_id=$1")
            .bind(session.profile.id)
            .fetch_one(&store.pool)
            .await
            .unwrap(),
        0
    );

    for _ in 0..2 {
        store
            .request_reset(ResetRequest {
                email: session.profile.email.clone(),
            })
            .await
            .unwrap();
    }

    let competing: Vec<Value> = sqlx::query_scalar(
        "SELECT payload FROM jobs WHERE kind='email' ORDER BY created_at DESC LIMIT 2",
    )
    .fetch_all(&store.pool)
    .await
    .unwrap();

    let (left, right) = tokio::time::timeout(std::time::Duration::from_secs(10), async {
        tokio::join!(
            store.reset_password(ResetPassword {
                token: competing[0]["token"].as_str().unwrap().into(),
                password: "changed-password-123".into()
            }),
            store.reset_password(ResetPassword {
                token: competing[1]["token"].as_str().unwrap().into(),
                password: "changed-password-123".into()
            }),
        )
    })
    .await
    .unwrap();

    assert_ne!(left.is_ok(), right.is_ok());
    let rejected = left.err().or(right.err()).unwrap();
    assert!(
        matches!(rejected, blackwall::error::Error::BadRequest(_)),
        "{rejected}"
    );

    let final_session = store
        .login(Login {
            email: session.profile.email.clone(),
            password: "changed-password-123".into(),
        })
        .await
        .unwrap();

    sqlx::query(
        "UPDATE sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE token_hash=$1",
    )
    .bind(hash(&final_session.token))
    .execute(&store.pool)
    .await
    .unwrap();

    assert!(store.authenticate(&final_session.token).await.is_err());
    store
        .request_reset(ResetRequest {
            email: session.profile.email,
        })
        .await
        .unwrap();

    let payload: Value = sqlx::query_scalar(
        "SELECT payload FROM jobs WHERE kind='email' ORDER BY created_at DESC LIMIT 1",
    )
    .fetch_one(&store.pool)
    .await
    .unwrap();

    sqlx::query("UPDATE password_resets SET expires_at=clock_timestamp()-interval '1 second'")
        .execute(&store.pool)
        .await
        .unwrap();

    assert!(
        store
            .reset_password(ResetPassword {
                token: payload["token"].as_str().unwrap().into(),
                password: "expired-password-123".into()
            })
            .await
            .is_err()
    );

    store.pool.close().await;
    database.cleanup().await;
}
