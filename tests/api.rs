use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use blackwall::{
    auth::{Register, Session},
    domain::{BulkAction, Command, IssueInput, IssuePatch, Priority, Role},
    http::router_with_web,
    ids::{IssueId, TeamId},
    jobs::{self, Mailer},
    limits::{Limits, Resource},
    store::{Store, StoreConfig},
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
            invitation: None,
        })
        .await
        .unwrap()
        .session()
        .unwrap()
}

async fn page(app: &axum::Router, user: &Session, id: &str, resource: &str) -> Value {
    let separator = if resource.contains('?') { '&' } else { '?' };
    let (status, value) = call(
        app,
        "GET",
        &format!("/internal-api/workspaces/{id}/{resource}{separator}limit=200"),
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
        &format!("/internal-api/workspaces/{id}"),
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
        &format!("/internal-api/workspaces/{id}/members"),
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
        &format!("/internal-api/workspaces/{id}/commands"),
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
    let mut store = Store::connect(&database.url).await.unwrap();
    let web = std::env::temp_dir().join(format!("blackwall-web-{}", Uuid::new_v4()));
    std::fs::create_dir_all(&web).unwrap();
    std::fs::write(
        web.join("index.html"),
        "<!DOCTYPE html><script src=\"/theme.js\"></script><script>window.boot=1</script>",
    )
    .unwrap();
    std::fs::create_dir_all(web.join("assets")).unwrap();
    std::fs::write(web.join("assets/issue-B1x9.js"), "export {}").unwrap();

    let owner = account(&store, "owner").await;
    let colleague = account(&store, "colleague").await;
    let outsider = account(&store, "outsider").await;
    store.mail_enabled = true;
    let app = router_with_web(store.clone(), web);

    let (status, value) = call(
        &app,
        "POST",
        "/internal-api/workspaces",
        Some(&owner.token),
        Some(json!({"name":"Infrastructure","slug":"infrastructure"})),
    )
    .await;

    assert_eq!(status, StatusCode::OK, "{value}");
    let id = value["workspace"]["id"].as_str().unwrap().to_owned();
    assert_eq!(
        call(
            &app,
            "GET",
            &format!("/internal-api/workspaces/{id}"),
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
            key: "OPE".into(),
            members: vec![owner.profile.id],
            default_stage_ids: None,
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
            team_ids: vec![TeamId(team)],
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
            team_id: TeamId(team),
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
    input.parent_id = Some(IssueId(first));
    input.dependencies = vec![IssueId(first)];
    input.sprint_id = Some(sprint);

    let result = change(&app, &owner, &id, Command::CreateIssue { input }).await;
    let child = uuid(&result["result"]["id"]);
    let (status, value) = call(
        &app,
        "POST",
        &format!("/internal-api/workspaces/{id}/commands"),
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
            issue_id: IssueId(first),
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
            issue_id: IssueId(first),
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
        &format!("/internal-api/workspaces/{id}/report"),
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
            "/internal-api/workspaces/{id}/issues?{}",
            serde_urlencoded::to_string([(
                "where",
                serde_json::json!([
                    {"field": "assignee", "op": "is", "values": [owner.profile.id]},
                    {"field": "priority", "op": "is", "values": ["high"]},
                    {"field": "labels", "op": "is", "values": [label]},
                ])
                .to_string()
            )])
            .unwrap()
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
        &format!("/internal-api/workspaces/{id}/commands"),
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
            ids: vec![IssueId(first), IssueId(child)],
            action: BulkAction::Update(Box::new(IssuePatch {
                priority: Some(Priority::Urgent),
                ..Default::default()
            })),
        },
    )
    .await;

    change(
        &app,
        &owner,
        &id,
        Command::DeleteIssue { id: IssueId(child) },
    )
    .await;
    let (status, trash) = call(
        &app,
        "GET",
        &format!("/internal-api/workspaces/{id}/issues?trash=true"),
        Some(&owner.token),
        None,
    )
    .await;

    assert_eq!(status, StatusCode::OK, "{trash}");
    assert_eq!(trash["items"].as_array().unwrap().len(), 1);
    change(
        &app,
        &owner,
        &id,
        Command::RestoreIssue { id: IssueId(child) },
    )
    .await;

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
        &format!("/internal-api/workspaces/{id}/invitations/accept"),
        Some(&colleague.token),
        Some(json!({"token":mail["token"]})),
    )
    .await;

    assert_eq!(status, StatusCode::OK, "{value}");
    assert_eq!(
        call(
            &app,
            "POST",
            &format!("/internal-api/workspaces/{id}/invitations/accept"),
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
            id: IssueId(first),
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
            issue_id: IssueId(first),
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
            &format!("/internal-api/workspaces/{id}/commands"),
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
            &format!("/internal-api/workspaces/{id}"),
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
                .uri(format!(
                    "/internal-api/workspaces/{id}/issues/{first}/attachments"
                ))
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
        "/internal-api/markdown",
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

    let (_, html) = call(
        &app,
        "POST",
        "/internal-api/markdown",
        Some(&owner.token),
        Some(json!({"text": format!("Ask [@Ana](mention:{})", Uuid::new_v4())})),
    )
    .await;
    assert_eq!(
        html["html"],
        "<p>Ask <span class=\"mention\">@Ana</span></p>\n"
    );

    let (status, export) = call(
        &app,
        "GET",
        &format!("/internal-api/workspaces/{id}/export"),
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
        "/internal-api/workspaces",
        Some(&owner.token),
        Some(json!({"name":"Imported workspace","slug":"imported-workspace"})),
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    let target_id = target["workspace"]["id"].as_str().unwrap();

    let (status, imported) = call(
        &app,
        "POST",
        &format!("/internal-api/workspaces/{target_id}/import"),
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
            events: vec![],
            include_data: true,
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
            events: None,
            include_data: None,
        },
    )
    .await;

    // Alert preferences suppress scheduled reminders without rewriting state each tick.
    change(
        &app,
        &owner,
        &id,
        Command::ConfigureAlerts {
            assignment: true,
            reply: true,
            change: true,
            mention: true,
            deadline: false,
            email_assignment: Some(true),
            email_reply: Some(true),
            email_change: Some(true),
            email_mention: Some(true),
            email_deadline: Some(true),
        },
    )
    .await;

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
        .uri("/internal-api/auth/login")
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
        .uri("/internal-api/workspaces")
        .header("Cookie", format!("blackwall_session={}", owner.token))
        .header("Content-Type", "application/json")
        .body(Body::from("{\"name\":\"CSRF\",\"slug\":\"csrf\"}"))
        .unwrap();

    assert_eq!(
        app.clone().oneshot(cookie_request).await.unwrap().status(),
        StatusCode::FORBIDDEN
    );

    let cookie_request = Request::builder()
        .method("POST")
        .uri("/internal-api/workspaces")
        .header("Cookie", format!("blackwall_session={}", owner.token))
        .header("X-CSRF-Token", &owner.csrf_token)
        .header("Content-Type", "application/json")
        .body(Body::from("{\"name\":\"CSRF\",\"slug\":\"csrf\"}"))
        .unwrap();

    assert_eq!(
        app.clone().oneshot(cookie_request).await.unwrap().status(),
        StatusCode::OK
    );

    let (status, schema) = call(&app, "GET", "/internal-api/schema.json", None, None).await;

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

    let mut cache = Vec::new();
    for path in [
        "/some/client/route",
        "/assets/issue-B1x9.js",
        "/assets/missing-C2y8.js",
        "/internal-api/schema.json",
    ] {
        let response = app
            .clone()
            .oneshot(Request::builder().uri(path).body(Body::empty()).unwrap())
            .await
            .unwrap();
        let header = response.headers()["cache-control"]
            .to_str()
            .unwrap()
            .to_owned();
        cache.push((path, response.status().as_u16(), header));
    }

    assert_eq!(
        cache,
        [
            ("/some/client/route", 200, "no-cache".to_owned()),
            (
                "/assets/issue-B1x9.js",
                200,
                "public, max-age=31536000, immutable".to_owned()
            ),
            ("/assets/missing-C2y8.js", 404, "no-store".to_owned()),
            ("/internal-api/schema.json", 200, "no-store".to_owned()),
        ]
    );

    let (status, _) = call(&app, "GET", "/internal-api/nope", None, None).await;

    assert_eq!(status, StatusCode::NOT_FOUND);

    let result = store
        .register(Register {
            email: owner.profile.email.clone(),
            password: "another-password-123".into(),
            display_name: "duplicate".into(),
            invitation: None,
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

    assert!(store.authenticate(&owner.token, None).await.is_err());
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
    let mut store = Store::connect(&database.url).await.unwrap();
    let session = account(&store, "identity").await;
    let second = store
        .login(Login {
            email: session.profile.email.to_uppercase(),
            password: "test-password-123".into(),
        })
        .await
        .unwrap()
        .session()
        .unwrap();
    store.mail_enabled = true;

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
            },
        )
        .await
        .unwrap();

    assert_eq!(
        store
            .authenticate(&session.token, None)
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
    assert!(store.authenticate(&session.token, None).await.is_err());
    assert!(store.authenticate(&second.token, None).await.is_err());
    let recovered = store
        .login(Login {
            email: session.profile.email.clone(),
            password: "recovered-password-123".into(),
        })
        .await
        .unwrap()
        .session()
        .unwrap();

    store
        .request_reset(ResetRequest {
            email: session.profile.email.clone(),
        })
        .await
        .unwrap();

    let elsewhere = store
        .login(Login {
            email: session.profile.email.clone(),
            password: "recovered-password-123".into(),
        })
        .await
        .unwrap()
        .session()
        .unwrap();

    store
        .change_password(
            session.profile.id,
            recovered.session_id,
            PasswordChange {
                current_password: "recovered-password-123".into(),
                new_password: "changed-password-123".into(),
            },
        )
        .await
        .unwrap();

    assert!(store.authenticate(&recovered.token, None).await.is_ok());
    assert!(store.authenticate(&elsewhere.token, None).await.is_err());
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
        .unwrap()
        .session()
        .unwrap();

    sqlx::query(
        "UPDATE sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE token_hash=$1",
    )
    .bind(hash(&final_session.token))
    .execute(&store.pool)
    .await
    .unwrap();

    assert!(
        store
            .authenticate(&final_session.token, None)
            .await
            .is_err()
    );
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

async fn follow_fixture(
    store: &Store,
    app: &axum::Router,
) -> (String, Uuid, Session, Session, Session, Session) {
    let owner = account(store, "owner").await;
    let assignee = account(store, "assignee").await;
    let commenter = account(store, "commenter").await;
    let mentioned = account(store, "mentioned").await;

    let (status, value) = call(
        app,
        "POST",
        "/internal-api/workspaces",
        Some(&owner.token),
        Some(json!({"name":"Followers","slug":"followers"})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{value}");
    let workspace = value["workspace"]["id"].as_str().unwrap().to_owned();

    for user in [&assignee, &commenter, &mentioned] {
        sqlx::query(
            "INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'member')",
        )
        .bind(Uuid::parse_str(&workspace).unwrap())
        .bind(user.profile.id)
        .execute(&store.pool)
        .await
        .unwrap();
    }

    let result = change(
        app,
        &owner,
        &workspace,
        Command::CreateTeam {
            id: None,
            name: "Operations".into(),
            key: "OPE".into(),
            members: vec![owner.profile.id],
            default_stage_ids: None,
        },
    )
    .await;
    let team = uuid(&result["result"]["id"]);

    (workspace, team, owner, assignee, commenter, mentioned)
}

fn issue_row(state: &Value, id: Uuid) -> Value {
    state["workspace"]["issues"]
        .as_array()
        .unwrap()
        .iter()
        .find(|issue| issue["id"] == id.to_string())
        .cloned()
        .unwrap()
}

fn follower_ids(state: &Value, id: Uuid) -> Vec<Uuid> {
    issue_row(state, id)["followers"]
        .as_array()
        .unwrap()
        .iter()
        .map(uuid)
        .collect()
}

fn notified(state: &Value, issue: Uuid, kind: &str) -> bool {
    state["workspace"]["notifications"]
        .as_array()
        .unwrap()
        .iter()
        .any(|n| n["issue_id"] == issue.to_string() && n["kind"] == kind)
}

#[tokio::test]
async fn followers_follow_assignments_comments_and_mentions_on_postgres() {
    let database = support::TestDatabase::new().await;
    let store = Store::connect(&database.url).await.unwrap();
    let app = router_with_web(store.clone(), std::env::temp_dir());
    let (workspace, team, owner, assignee, commenter, mentioned) =
        follow_fixture(&store, &app).await;

    let created = change(
        &app,
        &owner,
        &workspace,
        Command::CreateIssue {
            input: issue(team, "Rotate signing key"),
        },
    )
    .await;
    let id = uuid(&created["result"]["id"]);
    change(
        &app,
        &owner,
        &workspace,
        Command::UpdateIssue {
            id: IssueId(id),
            patch: IssuePatch {
                assignee: Some(assignee.profile.id),
                ..Default::default()
            },
        },
    )
    .await;
    let state = workspace_state(&app, &assignee, &workspace).await;
    assert!(notified(&state, id, "assignment"));
    assert!(
        !notified(&state, id, "change"),
        "the assignment edit alerts the new assignee once"
    );

    change(
        &app,
        &owner,
        &workspace,
        Command::AddComment {
            id: None,
            issue_id: IssueId(id),
            body: "Rotating now".into(),
            mentions: vec![],
            attachments: vec![],
        },
    )
    .await;
    assert!(
        notified(
            &workspace_state(&app, &assignee, &workspace).await,
            id,
            "reply"
        ),
        "the assignee hears about a comment"
    );

    change(
        &app,
        &commenter,
        &workspace,
        Command::AddComment {
            id: None,
            issue_id: IssueId(id),
            body: "Thanks".into(),
            mentions: vec![],
            attachments: vec![],
        },
    )
    .await;
    let state = workspace_state(&app, &owner, &workspace).await;
    assert!(follower_ids(&state, id).contains(&commenter.profile.id));

    change(
        &app,
        &owner,
        &workspace,
        Command::AddComment {
            id: None,
            issue_id: IssueId(id),
            body: "One more".into(),
            mentions: vec![],
            attachments: vec![],
        },
    )
    .await;
    assert!(
        notified(
            &workspace_state(&app, &commenter, &workspace).await,
            id,
            "reply"
        ),
        "the earlier commenter hears about a later comment"
    );

    change(
        &app,
        &owner,
        &workspace,
        Command::AddComment {
            id: None,
            issue_id: IssueId(id),
            body: "Looping in".into(),
            mentions: vec![mentioned.profile.id],
            attachments: vec![],
        },
    )
    .await;
    let state = workspace_state(&app, &owner, &workspace).await;
    assert!(follower_ids(&state, id).contains(&mentioned.profile.id));
    let state = workspace_state(&app, &mentioned, &workspace).await;
    assert!(notified(&state, id, "mention"));
    assert!(
        !notified(&state, id, "reply"),
        "the mentioning comment alerts the mentioned user once"
    );

    change(
        &app,
        &owner,
        &workspace,
        Command::UpdateIssue {
            id: IssueId(id),
            patch: IssuePatch {
                title: Some("Rotate signing key today".into()),
                ..Default::default()
            },
        },
    )
    .await;
    assert!(
        notified(
            &workspace_state(&app, &mentioned, &workspace).await,
            id,
            "change"
        ),
        "the mentioned user hears about a later change"
    );

    change(
        &app,
        &owner,
        &workspace,
        Command::UpdateIssue {
            id: IssueId(id),
            patch: IssuePatch {
                clear_assignee: true,
                ..Default::default()
            },
        },
    )
    .await;
    let state = workspace_state(&app, &owner, &workspace).await;
    assert!(
        follower_ids(&state, id).contains(&assignee.profile.id),
        "unassigning keeps the follow"
    );

    let mut input = issue(team, "Renew certificates");
    input.assignee = Some(assignee.profile.id);
    let created = change(&app, &owner, &workspace, Command::CreateIssue { input }).await;
    let renewal = uuid(&created["result"]["id"]);
    let state = workspace_state(&app, &owner, &workspace).await;
    let mut expected = vec![owner.profile.id, assignee.profile.id];
    expected.sort();
    assert_eq!(
        follower_ids(&state, renewal),
        expected,
        "a new issue's assignee follows it"
    );

    store.pool.close().await;
    database.cleanup().await;
}

#[tokio::test]
async fn members_manage_other_followers_but_viewers_cannot_on_postgres() {
    let database = support::TestDatabase::new().await;
    let store = Store::connect(&database.url).await.unwrap();
    let app = router_with_web(store.clone(), std::env::temp_dir());
    let (workspace, team, owner, assignee, commenter, _) = follow_fixture(&store, &app).await;
    let outsider = account(&store, "outsider").await;

    let mut input = issue(team, "Rotate signing key");
    input.assignee = Some(assignee.profile.id);
    let created = change(&app, &owner, &workspace, Command::CreateIssue { input }).await;
    let id = uuid(&created["result"]["id"]);

    change(
        &app,
        &owner,
        &workspace,
        Command::Follow {
            issue_id: IssueId(id),
            following: false,
            user_id: Some(assignee.profile.id),
        },
    )
    .await;
    let state = workspace_state(&app, &owner, &workspace).await;
    assert!(!follower_ids(&state, id).contains(&assignee.profile.id));

    change(
        &app,
        &owner,
        &workspace,
        Command::Follow {
            issue_id: IssueId(id),
            following: true,
            user_id: Some(assignee.profile.id),
        },
    )
    .await;
    let state = workspace_state(&app, &owner, &workspace).await;
    assert!(follower_ids(&state, id).contains(&assignee.profile.id));

    change(
        &app,
        &owner,
        &workspace,
        Command::SetRole {
            user_id: assignee.profile.id,
            role: Role::Viewer,
        },
    )
    .await;

    let (status, value) = call(
        &app,
        "POST",
        &format!("/internal-api/workspaces/{workspace}/commands"),
        Some(&assignee.token),
        Some(json!({
            "expected_versions": {},
            "command": {
                "type": "follow",
                "issue_id": id,
                "following": true,
                "user_id": commenter.profile.id
            }
        })),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{value}");

    change(
        &app,
        &owner,
        &workspace,
        Command::Follow {
            issue_id: IssueId(id),
            following: false,
            user_id: Some(assignee.profile.id),
        },
    )
    .await;
    let (status, value) = call(
        &app,
        "POST",
        &format!("/internal-api/workspaces/{workspace}/commands"),
        Some(&assignee.token),
        Some(json!({
            "expected_versions": {},
            "command": {"type": "follow", "issue_id": id, "following": true}
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{value}");
    let state = workspace_state(&app, &owner, &workspace).await;
    assert!(follower_ids(&state, id).contains(&assignee.profile.id));

    let (status, value) = call(
        &app,
        "POST",
        &format!("/internal-api/workspaces/{workspace}/commands"),
        Some(&assignee.token),
        Some(json!({
            "expected_versions": {},
            "command": {
                "type": "follow",
                "issue_id": id,
                "following": false,
                "user_id": assignee.profile.id
            }
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "a viewer names themselves: {value}");
    let state = workspace_state(&app, &owner, &workspace).await;
    assert!(!follower_ids(&state, id).contains(&assignee.profile.id));

    let (status, value) = call(
        &app,
        "POST",
        &format!("/internal-api/workspaces/{workspace}/commands"),
        Some(&owner.token),
        Some(json!({
            "expected_versions": {},
            "command": {
                "type": "follow",
                "issue_id": id,
                "following": true,
                "user_id": outsider.profile.id
            }
        })),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{value}");

    store.pool.close().await;
    database.cleanup().await;
}

#[tokio::test]
async fn sessions_list_revoke_and_survive_password_change() {
    use blackwall::auth::Login;

    let database = support::TestDatabase::new().await;
    let store = Store::connect(&database.url).await.unwrap();
    let app = blackwall::http::router(store.clone());
    let laptop = account(&store, "sessions").await;
    let login = || {
        store.login(Login {
            email: laptop.profile.email.clone(),
            password: "test-password-123".into(),
        })
    };
    let phone = login().await.unwrap().session().unwrap();
    let tablet = login().await.unwrap().session().unwrap();
    let stranger = account(&store, "stranger").await;

    let response = app
        .clone()
        .oneshot(
            Request::get("/internal-api/me")
                .header("Authorization", format!("Bearer {}", phone.token))
                .header(
                    "User-Agent",
                    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)",
                )
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);

    let (status, list) = call(
        &app,
        "GET",
        "/internal-api/me/sessions",
        Some(&laptop.token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{list}");
    let list = list.as_array().unwrap();
    assert_eq!(list.len(), 3, "the stranger's session stays out: {list:?}");
    let entry = |id: Uuid| {
        list.iter()
            .find(|s| s["id"] == json!(id))
            .unwrap_or_else(|| panic!("{id} listed"))
    };
    assert_eq!(entry(laptop.session_id)["current"], true);
    assert_eq!(entry(phone.session_id)["current"], false);
    assert_eq!(
        entry(phone.session_id)["user_agent"],
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)"
    );
    assert!(entry(phone.session_id)["last_seen_at"].is_string());
    assert!(entry(tablet.session_id)["last_seen_at"].is_null());

    let (status, _) = call(
        &app,
        "DELETE",
        &format!("/internal-api/me/sessions/{}", stranger.session_id),
        Some(&laptop.token),
        None,
    )
    .await;
    assert_eq!(
        status,
        StatusCode::NOT_FOUND,
        "another user's session is not revocable"
    );
    assert!(store.authenticate(&stranger.token, None).await.is_ok());

    let (status, _) = call(
        &app,
        "DELETE",
        &format!("/internal-api/me/sessions/{}", phone.session_id),
        Some(&laptop.token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert!(store.authenticate(&phone.token, None).await.is_err());

    let (status, revoked) = call(
        &app,
        "POST",
        "/internal-api/me/sessions/revoke-others",
        Some(&laptop.token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{revoked}");
    assert_eq!(revoked["revoked"], 1);
    assert!(store.authenticate(&tablet.token, None).await.is_err());
    assert!(store.authenticate(&laptop.token, None).await.is_ok());

    let desktop = login().await.unwrap().session().unwrap();
    let (status, value) = call(
        &app,
        "POST",
        "/internal-api/auth/password",
        Some(&laptop.token),
        Some(json!({
            "current_password": "test-password-123",
            "new_password": "changed-password-123"
        })),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT, "{value}");
    assert!(store.authenticate(&desktop.token, None).await.is_err());
    let (status, list) = call(
        &app,
        "GET",
        "/internal-api/me/sessions",
        Some(&laptop.token),
        None,
    )
    .await;
    assert_eq!(
        status,
        StatusCode::OK,
        "the session that changed the password stays signed in"
    );
    assert_eq!(list.as_array().unwrap().len(), 1, "{list}");
    assert!(store.authenticate(&stranger.token, None).await.is_ok());

    store.pool.close().await;
    database.cleanup().await;
}

#[tokio::test]
async fn invitation_links_work_without_mail() {
    let database = support::TestDatabase::new().await;
    let mut store = Store::connect(&database.url).await.unwrap();
    store.mail_enabled = false;
    let app = blackwall::http::router(store.clone());
    let owner = account(&store, "owner").await;
    let colleague = account(&store, "colleague").await;

    let (status, value) = call(
        &app,
        "POST",
        "/internal-api/workspaces",
        Some(&owner.token),
        Some(json!({"name":"Links","slug":"links"})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{value}");
    let id = value["workspace"]["id"].as_str().unwrap().to_owned();

    let invite = json!({
        "idempotency_key": "invite-once",
        "command": {"type":"invite","email":colleague.profile.email,"role":"member","token_hash":""},
    });
    let commands = format!("/internal-api/workspaces/{id}/commands");
    let (status, value) = call(
        &app,
        "POST",
        &commands,
        Some(&owner.token),
        Some(invite.clone()),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{value}");
    assert_eq!(value["result"]["invitation"]["emailed"], false, "{value}");
    let token = value["result"]["invitation"]["token"]
        .as_str()
        .unwrap()
        .to_owned();

    let jobs: i64 = sqlx::query_scalar("SELECT count(*) FROM jobs WHERE kind='email'")
        .fetch_one(&store.pool)
        .await
        .unwrap();
    assert_eq!(jobs, 0, "no email job waits for mail that can't be sent");

    let (status, replay) = call(&app, "POST", &commands, Some(&owner.token), Some(invite)).await;
    assert_eq!(status, StatusCode::OK, "{replay}");
    assert_eq!(replay["result"]["id"], value["result"]["id"]);
    assert!(replay["result"].get("invitation").is_none(), "{replay}");
    let stored: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM operation_keys WHERE position($1 in result::text) > 0",
    )
    .bind(&token)
    .fetch_one(&store.pool)
    .await
    .unwrap();
    assert_eq!(stored, 0, "the plaintext token is never stored");

    let (status, value) = call(
        &app,
        "POST",
        &format!("/internal-api/workspaces/{id}/invitations/accept"),
        Some(&colleague.token),
        Some(json!({"token":token})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{value}");

    let (status, value) = call(
        &app,
        "POST",
        "/internal-api/auth/reset-request",
        None,
        Some(json!({"email":owner.profile.email})),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "{value}");
    assert!(
        value["error"]
            .as_str()
            .unwrap()
            .starts_with("This server can't send email"),
        "{value}"
    );
    let (missing, _) = call(
        &app,
        "POST",
        "/internal-api/auth/reset-request",
        None,
        Some(json!({"email":"nobody@example.com"})),
    )
    .await;
    assert_eq!(
        missing, status,
        "the answer doesn't reveal which accounts exist"
    );
    let resets: i64 = sqlx::query_scalar("SELECT count(*) FROM password_resets")
        .fetch_one(&store.pool)
        .await
        .unwrap();
    assert_eq!(resets, 0);

    let mut mailing = store.clone();
    mailing.mail_enabled = true;
    let app = blackwall::http::router(mailing);
    let (status, value) = call(
        &app,
        "POST",
        &commands,
        Some(&owner.token),
        Some(json!({"command":{"type":"invite","email":"later@example.com","role":"viewer","token_hash":""}})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{value}");
    assert_eq!(value["result"]["invitation"]["emailed"], true, "{value}");
    let invitation = value["result"]["id"].as_str().unwrap().to_owned();

    let (status, value) = call(
        &app,
        "POST",
        &commands,
        Some(&owner.token),
        Some(json!({"command":{"type":"resend_invitation","id":invitation,"token_hash":""}})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{value}");
    let renewed = value["result"]["invitation"]["token"].as_str().unwrap();
    let emailed: Vec<String> = sqlx::query_scalar(
        "SELECT payload->>'token' FROM jobs WHERE kind='email' AND payload->>'invitation_id'=$1 \
         ORDER BY created_at",
    )
    .bind(&invitation)
    .fetch_all(&store.pool)
    .await
    .unwrap();
    assert_eq!(emailed.len(), 2);
    assert_eq!(
        emailed[1], renewed,
        "the email and the copied link carry one token"
    );

    let later = store
        .register(Register {
            email: "later@example.com".into(),
            password: "test-password-123".into(),
            display_name: "Later".into(),
            invitation: None,
        })
        .await
        .unwrap()
        .session()
        .unwrap();
    let accept = format!("/internal-api/workspaces/{id}/invitations/accept");
    let (status, value) = call(
        &app,
        "POST",
        &accept,
        Some(&later.token),
        Some(json!({"token":emailed[0]})),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::BAD_REQUEST,
        "resend retires the old link: {value}"
    );
    let (status, value) = call(
        &app,
        "POST",
        &accept,
        Some(&later.token),
        Some(json!({"token":renewed})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{value}");
}

#[tokio::test]
async fn workspace_limits_name_the_resource_and_report_usage() {
    let database = support::TestDatabase::new().await;
    let config = StoreConfig {
        limits: Limits::default()
            .with(Resource::Issues, Some(2))
            .with(Resource::Labels, None),
        ..StoreConfig::default()
    };
    let store = Store::connect_with_config(&database.url, config)
        .await
        .unwrap();
    let app = blackwall::http::router(store.clone());
    let owner = account(&store, "owner").await;
    let outsider = account(&store, "outsider").await;
    let (status, value) = call(
        &app,
        "POST",
        "/internal-api/workspaces",
        Some(&owner.token),
        Some(json!({"name":"Limits","slug":"limits"})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{value}");
    let id = value["workspace"]["id"].as_str().unwrap().to_owned();
    let created = change(
        &app,
        &owner,
        &id,
        Command::CreateTeam {
            id: None,
            name: "Operations".into(),
            key: "OPE".into(),
            members: vec![owner.profile.id],
            default_stage_ids: None,
        },
    )
    .await;
    let team = uuid(&created["result"]["id"]);

    for title in ["One", "Two"] {
        change(
            &app,
            &owner,
            &id,
            Command::CreateIssue {
                input: issue(team, title),
            },
        )
        .await;
    }
    let (status, value) = call(
        &app,
        "POST",
        &format!("/internal-api/workspaces/{id}/commands"),
        Some(&owner.token),
        Some(json!({"command":{"type":"create_issue","input":{"team_id":team,"title":"Three"}}})),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{value}");
    assert_eq!(
        value["error"],
        "This workspace has reached its limit of 2 issues. A server administrator can raise it with WORKSPACE_LIMIT_ISSUES."
    );

    let usage = format!("/internal-api/workspaces/{id}/usage");
    let (status, value) = call(&app, "GET", &usage, Some(&owner.token), None).await;
    assert_eq!(status, StatusCode::OK, "{value}");
    let entry = |resource: &str| {
        value
            .as_array()
            .unwrap()
            .iter()
            .find(|entry| entry["resource"] == resource)
            .cloned()
            .unwrap()
    };
    assert_eq!(
        entry("issues"),
        json!({"resource":"issues","used":2,"limit":2})
    );
    assert_eq!(entry("labels")["limit"], Value::Null);
    assert_eq!(entry("time_entries")["limit"], 250_000);

    let (status, _) = call(&app, "GET", &usage, Some(&outsider.token), None).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    database.cleanup().await;
}

#[tokio::test]
async fn unlimited_sprints_still_number_concurrent_creates() {
    let database = support::TestDatabase::new().await;
    let config = StoreConfig {
        limits: Limits::default().with(Resource::Sprints, None),
        ..StoreConfig::default()
    };
    let store = Store::connect_with_config(&database.url, config)
        .await
        .unwrap();
    let app = blackwall::http::router(store.clone());
    let owner = account(&store, "owner").await;
    let (status, value) = call(
        &app,
        "POST",
        "/internal-api/workspaces",
        Some(&owner.token),
        Some(json!({"name":"Sprints","slug":"sprints"})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{value}");
    let id = value["workspace"]["id"].as_str().unwrap().to_owned();
    let created = change(
        &app,
        &owner,
        &id,
        Command::CreateTeam {
            id: None,
            name: "Operations".into(),
            key: "OPE".into(),
            members: vec![owner.profile.id],
            default_stage_ids: None,
        },
    )
    .await;
    let team = uuid(&created["result"]["id"]);

    let path = format!("/internal-api/workspaces/{id}/commands");
    let requests = (0..10).map(|n| {
        let (app, path, token) = (app.clone(), path.clone(), owner.token.clone());
        tokio::spawn(async move {
            let command = json!({"command":{"type":"create_sprint","team_id":team,"name":format!("Sprint {n}"),
                "goal":"","starts_at":"2026-11-02T00:00:00Z","ends_at":"2026-11-16T00:00:00Z"}});
            call(&app, "POST", &path, Some(&token), Some(command)).await
        })
    });
    for request in requests.collect::<Vec<_>>() {
        let (status, value) = request.await.unwrap();
        assert_eq!(status, StatusCode::OK, "{value}");
    }
    let numbers: Vec<i64> =
        sqlx::query_scalar("SELECT number FROM sprints WHERE team_id=$1 ORDER BY number")
            .bind(team)
            .fetch_all(&store.pool)
            .await
            .unwrap();
    assert_eq!(numbers, (1..=10).collect::<Vec<i64>>());
    database.cleanup().await;
}

async fn verification_tokens(store: &Store, email: &str) -> Vec<String> {
    sqlx::query_scalar(
        "SELECT payload->>'token' FROM jobs WHERE kind='email' AND payload->>'to'=$1 \
         AND payload ? 'verification_hash' ORDER BY created_at",
    )
    .bind(email)
    .fetch_all(&store.pool)
    .await
    .unwrap()
}

#[tokio::test]
async fn email_verification_gates_sign_in_while_mail_works() {
    use blackwall::{
        auth::{Login, ResetPassword, ResetRequest},
        error::Error,
    };

    let database = support::TestDatabase::new().await;
    let mut store = Store::connect(&database.url).await.unwrap();
    store.mail_enabled = true;
    let app = blackwall::http::router(store.clone());
    let login = |email: &str, password: &str| {
        store.login(Login {
            email: email.into(),
            password: password.into(),
        })
    };

    let (status, value) = call(&app, "GET", "/internal-api/auth/options", None, None).await;
    assert_eq!(status, StatusCode::OK, "{value}");
    assert_eq!(
        value,
        json!({"registration":"open","email_verification":true})
    );

    let (status, value) = call(
        &app,
        "POST",
        "/internal-api/auth/register",
        None,
        Some(
            json!({"email":"new@example.com","password":"test-password-123","display_name":"New"}),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED, "{value}");
    assert_eq!(value, json!({"verification_sent":true}));
    assert_eq!(
        verification_tokens(&store, "new@example.com").await.len(),
        1
    );

    let denied = login("new@example.com", "test-password-123").await;
    assert!(
        matches!(&denied, Err(Error::Denied(message)) if message.contains("new@example.com")),
        "{:?}",
        denied.err()
    );
    assert_eq!(
        verification_tokens(&store, "new@example.com").await.len(),
        1,
        "the link sent at registration is recent enough"
    );

    sqlx::query("UPDATE email_verifications SET created_at=now()-interval '6 minutes'")
        .execute(&store.pool)
        .await
        .unwrap();
    assert!(matches!(
        login("new@example.com", "test-password-123").await,
        Err(Error::Denied(_))
    ));
    assert!(matches!(
        login("new@example.com", "test-password-123").await,
        Err(Error::Denied(_))
    ));
    let tokens = verification_tokens(&store, "new@example.com").await;
    assert_eq!(
        tokens.len(),
        2,
        "a second sign-in within minutes sends nothing"
    );
    assert!(matches!(
        login("new@example.com", "wrong-password-123").await,
        Err(Error::Unauthorized)
    ));

    let verify = |token: &str| {
        call(
            &app,
            "POST",
            "/internal-api/auth/verify",
            None,
            Some(json!({ "token": token })),
        )
    };
    assert_eq!(verify("not-a-token").await.0, StatusCode::BAD_REQUEST);
    assert_eq!(verify(&tokens[1]).await.0, StatusCode::NO_CONTENT);
    assert_eq!(
        verify(&tokens[0]).await.0,
        StatusCode::BAD_REQUEST,
        "verifying retires every link"
    );
    login("new@example.com", "test-password-123").await.unwrap();

    let registered = store
        .register(Register {
            email: "forgetful@example.com".into(),
            password: "test-password-123".into(),
            display_name: "Forgetful".into(),
            invitation: None,
        })
        .await
        .unwrap();
    assert!(registered.session().is_none());
    store
        .request_reset(ResetRequest {
            email: "forgetful@example.com".into(),
        })
        .await
        .unwrap();
    let reset: String = sqlx::query_scalar(
        "SELECT payload->>'token' FROM jobs WHERE kind='email' AND payload->>'to'=$1 \
         AND payload->>'subject' LIKE 'Reset%'",
    )
    .bind("forgetful@example.com")
    .fetch_one(&store.pool)
    .await
    .unwrap();
    store
        .reset_password(ResetPassword {
            token: reset,
            password: "recovered-password-123".into(),
        })
        .await
        .unwrap();
    login("forgetful@example.com", "recovered-password-123")
        .await
        .unwrap();

    let password_hash: String =
        sqlx::query_scalar("SELECT password_hash FROM users WHERE email='new@example.com'")
            .fetch_one(&store.pool)
            .await
            .unwrap();
    sqlx::query(
        "INSERT INTO users(id,email,password_hash,profile) \
         SELECT $1,'old@example.com',password_hash,profile || jsonb_build_object('id',$1::text) \
         FROM users WHERE password_hash=$2",
    )
    .bind(Uuid::new_v4())
    .bind(password_hash)
    .execute(&store.pool)
    .await
    .unwrap();
    login("old@example.com", "test-password-123")
        .await
        .expect("an account the previous release inserted signs in");

    store.pool.close().await;
    database.cleanup().await;
}

#[tokio::test]
async fn unverified_accounts_sign_in_without_mail() {
    use blackwall::auth::Login;

    let database = support::TestDatabase::new().await;
    let store = Store::connect(&database.url).await.unwrap();
    let app = blackwall::http::router(store.clone());

    let (_, value) = call(&app, "GET", "/internal-api/auth/options", None, None).await;
    assert_eq!(value["email_verification"], false);

    let (status, value) = call(
        &app,
        "POST",
        "/internal-api/auth/register",
        None,
        Some(json!({"email":"plain@example.com","password":"test-password-123","display_name":"Plain"})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{value}");
    assert!(value["token"].is_string(), "{value}");
    store
        .login(Login {
            email: "plain@example.com".into(),
            password: "test-password-123".into(),
        })
        .await
        .unwrap();

    store.pool.close().await;
    database.cleanup().await;
}

#[tokio::test]
async fn invite_only_registration_needs_a_matching_invitation() {
    use blackwall::{
        auth::{InvitationProof, Registered, RegistrationMode},
        error::Error,
    };

    let database = support::TestDatabase::new().await;
    let mut store = Store::connect(&database.url).await.unwrap();
    store.registration = RegistrationMode::Invite;
    let register = |store: Store, email: &str, invitation: Option<(Uuid, &str)>| {
        let input = Register {
            email: email.into(),
            password: "test-password-123".into(),
            display_name: "Person".into(),
            invitation: invitation.map(|(workspace_id, token)| InvitationProof {
                workspace_id,
                token: token.into(),
            }),
        };
        async move { store.register(input).await }
    };

    let owner = register(store.clone(), "owner@example.com", None)
        .await
        .expect("the first account of a fresh install needs no invitation")
        .session()
        .unwrap();

    store.mail_enabled = true;
    let app = blackwall::http::router(store.clone());
    let (_, value) = call(&app, "GET", "/internal-api/auth/options", None, None).await;
    assert_eq!(
        value,
        json!({"registration":"invite","email_verification":true})
    );

    let (status, value) = call(
        &app,
        "POST",
        "/internal-api/auth/register",
        None,
        Some(json!({"email":"stranger@example.com","password":"test-password-123","display_name":"Stranger"})),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{value}");
    assert!(
        value["error"].as_str().unwrap().contains("invitation"),
        "{value}"
    );

    let (status, value) = call(
        &app,
        "POST",
        "/internal-api/workspaces",
        Some(&owner.token),
        Some(json!({"name":"Invites","slug":"invites"})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{value}");
    let workspace: Uuid = value["workspace"]["id"].as_str().unwrap().parse().unwrap();
    let (status, value) = call(
        &app,
        "POST",
        &format!("/internal-api/workspaces/{workspace}/commands"),
        Some(&owner.token),
        Some(json!({"command":{"type":"invite","email":"Guest@example.com","role":"member","token_hash":""}})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{value}");
    let token = value["result"]["invitation"]["token"]
        .as_str()
        .unwrap()
        .to_owned();

    for (email, proof) in [
        ("guest@example.com", (workspace, "wrong-token")),
        ("guest@example.com", (Uuid::new_v4(), token.as_str())),
        ("other@example.com", (workspace, token.as_str())),
    ] {
        let result = register(store.clone(), email, Some(proof)).await;
        assert!(
            matches!(result, Err(Error::BadRequest(_))),
            "{email} registered with a mismatched invitation"
        );
    }

    let mut open = store.clone();
    open.registration = RegistrationMode::Open;
    let result = register(open, "other@example.com", Some((workspace, &token))).await;
    assert!(
        matches!(result, Ok(Registered::VerificationSent)),
        "open registration ignores an invitation for another address"
    );

    let guest = register(
        store.clone(),
        "guest@example.com",
        Some((workspace, &token)),
    )
    .await
    .unwrap()
    .session()
    .expect("an invited account signs in at once, even while mail works");
    let verified: bool = sqlx::query_scalar(
        "SELECT email_verified_at IS NOT NULL FROM users WHERE email='guest@example.com'",
    )
    .fetch_one(&store.pool)
    .await
    .unwrap();
    assert!(verified);

    let (status, value) = call(
        &app,
        "POST",
        &format!("/internal-api/workspaces/{workspace}/invitations/accept"),
        Some(&guest.token),
        Some(json!({ "token": token })),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::OK,
        "registering leaves the invitation to accept: {value}"
    );

    store.pool.close().await;
    database.cleanup().await;
}

#[tokio::test]
async fn cancelled_invitations_stop_invite_only_registration() {
    use blackwall::{
        auth::{InvitationProof, RegistrationMode},
        error::Error,
    };

    let database = support::TestDatabase::new().await;
    let mut store = Store::connect(&database.url).await.unwrap();
    store.registration = RegistrationMode::Invite;
    let owner = account(&store, "owner").await;
    store.mail_enabled = true;
    let app = blackwall::http::router(store.clone());
    let (status, value) = call(
        &app,
        "POST",
        "/internal-api/workspaces",
        Some(&owner.token),
        Some(json!({"name":"Revocation","slug":"revocation"})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{value}");
    let workspace: Uuid = value["workspace"]["id"].as_str().unwrap().parse().unwrap();
    let commands = format!("/internal-api/workspaces/{workspace}/commands");
    let invite = |email: &'static str| {
        let (app, commands, token) = (app.clone(), commands.clone(), owner.token.clone());
        async move {
            let (status, value) = call(
                &app,
                "POST",
                &commands,
                Some(&token),
                Some(json!({"command":{"type":"invite","email":email,"role":"member","token_hash":""}})),
            )
            .await;
            assert_eq!(status, StatusCode::OK, "{value}");
            let id = value["result"]["id"].as_str().unwrap().to_owned();
            let token = value["result"]["invitation"]["token"]
                .as_str()
                .unwrap()
                .to_owned();
            let version = value["versions"][&id].clone();
            (id, version, token)
        }
    };
    let register = |email: &'static str, token: String| {
        let (store, workspace) = (store.clone(), workspace);
        async move {
            store
                .register(Register {
                    email: email.into(),
                    password: "test-password-123".into(),
                    display_name: "Invitee".into(),
                    invitation: Some(InvitationProof {
                        workspace_id: workspace,
                        token,
                    }),
                })
                .await
        }
    };

    let (id, version, token) = invite("first@example.com").await;
    let mut expected = serde_json::Map::new();
    expected.insert(id.clone(), version);
    let (status, value) = call(
        &app,
        "POST",
        &commands,
        Some(&owner.token),
        Some(json!({"expected_versions":expected,"command":{"type":"cancel_invitation","id":id}})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{value}");
    assert!(
        matches!(
            register("first@example.com", token).await,
            Err(Error::BadRequest(_))
        ),
        "a cancelled invitation still registered an account"
    );

    let (id, _, token) = invite("second@example.com").await;
    let mut cancel = store.pool.begin().await.unwrap();
    sqlx::query("UPDATE invitations SET state='cancelled',token_hash='' WHERE id=$1")
        .bind(Uuid::parse_str(&id).unwrap())
        .execute(&mut *cancel)
        .await
        .unwrap();
    let registration = tokio::spawn(register("second@example.com", token));
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(30);
    loop {
        let waiting: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM pg_stat_activity \
             WHERE datname = current_database() AND wait_event_type = 'Lock'",
        )
        .fetch_one(&store.pool)
        .await
        .unwrap();
        if waiting > 0 {
            break;
        }
        assert!(
            !registration.is_finished(),
            "registration finished without waiting for the cancellation"
        );
        assert!(
            tokio::time::Instant::now() < deadline,
            "registration never blocked"
        );
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    cancel.commit().await.unwrap();
    assert!(
        matches!(registration.await.unwrap(), Err(Error::BadRequest(_))),
        "a cancellation that committed during registration still let the account through"
    );
    let accounts: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM users WHERE email IN ('first@example.com','second@example.com')",
    )
    .fetch_one(&store.pool)
    .await
    .unwrap();
    assert_eq!(accounts, 0);

    store.pool.close().await;
    database.cleanup().await;
}
