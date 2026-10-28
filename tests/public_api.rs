mod support;

use axum::{
    body::Body,
    http::{HeaderMap, Request, StatusCode},
};
use blackwall::{
    auth::{Register, Session},
    domain::{Command, ProjectStatus},
    http::router,
    store::Store,
};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use tower::ServiceExt;
use uuid::Uuid;

struct Reply {
    status: StatusCode,
    headers: HeaderMap,
    body: Value,
}

async fn send(
    app: &axum::Router,
    method: &str,
    path: &str,
    token: Option<&str>,
    body: Option<Value>,
    headers: &[(&str, &str)],
) -> Reply {
    match body {
        Some(body) => {
            let mut headers = headers.to_vec();
            headers.push(("Content-Type", "application/json"));
            send_body(
                app,
                method,
                path,
                token,
                Body::from(body.to_string()),
                &headers,
            )
            .await
        }
        None => send_body(app, method, path, token, Body::empty(), headers).await,
    }
}

async fn send_body(
    app: &axum::Router,
    method: &str,
    path: &str,
    token: Option<&str>,
    body: Body,
    headers: &[(&str, &str)],
) -> Reply {
    let mut request = Request::builder().method(method).uri(path);
    if let Some(token) = token {
        request = request.header("Authorization", format!("Bearer {token}"));
    }
    for (name, value) in headers {
        request = request.header(*name, *value);
    }
    let response = app
        .clone()
        .oneshot(request.body(body).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let headers = response.headers().clone();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let body = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    Reply {
        status,
        headers,
        body,
    }
}

async fn call(
    app: &axum::Router,
    method: &str,
    path: &str,
    token: &str,
    body: Option<Value>,
) -> Reply {
    send(app, method, path, Some(token), body, &[]).await
}

async fn account(store: &Store, name: &str) -> Session {
    store
        .register(Register {
            email: format!("{name}-{}@example.com", Uuid::new_v4()),
            password: "public-api-password".into(),
            display_name: name.into(),
            invitation: None,
        })
        .await
        .unwrap()
        .session()
        .unwrap()
}

async fn workspace(store: &Store, owner: &Session, name: &str) -> Uuid {
    let value = store
        .create_workspace(name.into(), owner.profile.id)
        .await
        .unwrap();
    Uuid::parse_str(value["id"].as_str().unwrap()).unwrap()
}

/// Creates a token through the session-authenticated settings endpoint.
async fn token(app: &axum::Router, user: &Session, body: Value) -> String {
    let reply = call(
        app,
        "POST",
        "/internal-api/me/tokens",
        &user.token,
        Some(body),
    )
    .await;
    assert_eq!(reply.status, StatusCode::CREATED, "{}", reply.body);
    let secret = reply.body["secret"].as_str().unwrap().to_owned();
    assert!(secret.starts_with("bw_pat_"));
    assert!(secret.starts_with(reply.body["prefix"].as_str().unwrap()));
    secret
}

/// An issue list path filtered by `clauses`.
fn filtered_path(base: &str, clauses: Value) -> String {
    let query = serde_urlencoded::to_string([("where", clauses.to_string())]).unwrap();
    format!("{base}/issues?{query}")
}

fn etag(reply: &Reply) -> String {
    reply.headers["etag"].to_str().unwrap().to_owned()
}

#[tokio::test]
async fn public_api_on_postgres() {
    // SAFETY: set before the server reads it, while this test is the binary's only thread.
    unsafe { std::env::set_var("MCP_ALLOWED_ORIGINS", "https://agent.example.com/") };
    let database = support::TestDatabase::new().await;
    let store = Store::connect(&database.url).await.unwrap();
    let app = router(store.clone());

    let owner = account(&store, "owner").await;
    let member = account(&store, "member").await;
    let ws = workspace(&store, &owner, "Public API").await;
    let other = workspace(&store, &owner, "Elsewhere").await;
    sqlx::query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'member')")
        .bind(ws)
        .bind(member.profile.id)
        .execute(&store.pool)
        .await
        .unwrap();

    // The schema is public; everything else needs a token.
    let schema = send(&app, "GET", "/api/v1/openapi.json", None, None, &[]).await;
    assert_eq!(schema.status, StatusCode::OK);
    assert!(schema.body["paths"]["/api/v1/workspaces/{workspace}/issues/{issue}"].is_object());
    let anonymous = send(&app, "GET", "/api/v1/me", None, None, &[]).await;
    assert_eq!(anonymous.status, StatusCode::UNAUTHORIZED);
    assert!(anonymous.headers.contains_key("www-authenticate"));
    // Session tokens are for the app, not the public API.
    let session = call(&app, "GET", "/api/v1/me", &owner.token, None).await;
    assert_eq!(session.status, StatusCode::UNAUTHORIZED);

    let write = token(&app, &owner, json!({"name":"CI","access":"write"})).await;
    let read = token(
        &app,
        &owner,
        json!({"name":"Reports","access":"read","workspace_ids":[ws],"expires_in_days":30}),
    )
    .await;
    let foreign = call(
        &app,
        "POST",
        "/internal-api/me/tokens",
        &member.token,
        Some(json!({"name":"Sneaky","access":"read","workspace_ids":[other]})),
    )
    .await;
    assert_eq!(foreign.status, StatusCode::BAD_REQUEST, "{}", foreign.body);

    let listed = call(&app, "GET", "/internal-api/me/tokens", &owner.token, None).await;
    assert_eq!(listed.body.as_array().unwrap().len(), 2);
    assert!(listed.body[0].get("secret").is_none());

    let me = call(&app, "GET", "/api/v1/me", &write, None).await;
    assert_eq!(me.status, StatusCode::OK, "{}", me.body);
    assert_eq!(me.body["id"], json!(owner.profile.id));
    assert_eq!(me.body["token"]["access"], "write");
    assert!(me.headers.contains_key("x-ratelimit-limit"));
    assert!(me.headers.contains_key("x-ratelimit-remaining"));

    let reachable = call(&app, "GET", "/api/v1/workspaces", &read, None).await;
    assert_eq!(reachable.body["data"].as_array().unwrap().len(), 1);
    assert_eq!(reachable.body["data"][0]["role"], "owner");
    let all = call(&app, "GET", "/api/v1/workspaces", &write, None).await;
    assert_eq!(all.body["data"].as_array().unwrap().len(), 2);
    let blocked = call(
        &app,
        "GET",
        &format!("/api/v1/workspaces/{other}/teams"),
        &read,
        None,
    )
    .await;
    assert_eq!(blocked.status, StatusCode::FORBIDDEN);

    // Teams and stages.
    let base = format!("/api/v1/workspaces/{ws}");
    let denied = call(
        &app,
        "POST",
        &format!("{base}/teams"),
        &read,
        Some(json!({"name":"Nope","key":"NOPE"})),
    )
    .await;
    assert_eq!(denied.status, StatusCode::FORBIDDEN);
    assert_eq!(denied.body["error"], "this token is read-only");

    let team = call(
        &app,
        "POST",
        &format!("{base}/teams"),
        &write,
        Some(json!({"name":"Platform","key":"PLA"})),
    )
    .await;
    assert_eq!(team.status, StatusCode::CREATED, "{}", team.body);
    let team_id = team.body["id"].as_str().unwrap().to_owned();
    let stages = team.body["stages"].as_array().unwrap().clone();
    assert!(stages.len() >= 2);
    let first_stage = stages[0]["id"].as_str().unwrap().to_owned();

    let stage = call(
        &app,
        "POST",
        &format!("{base}/teams/{team_id}/stages"),
        &write,
        Some(json!({"name":"Review","kind":"active"})),
    )
    .await;
    assert_eq!(stage.status, StatusCode::CREATED, "{}", stage.body);
    let stage_id = stage.body["id"].as_str().unwrap().to_owned();
    let last = stages
        .iter()
        .map(|s| s["position"].as_i64().unwrap())
        .max()
        .unwrap();
    assert_eq!(stage.body["position"].as_i64().unwrap(), last + 1);
    let renamed = call(
        &app,
        "PATCH",
        &format!("{base}/teams/{team_id}/stages/{stage_id}"),
        &write,
        Some(json!({"name":"Code review"})),
    )
    .await;
    assert_eq!(renamed.status, StatusCode::OK, "{}", renamed.body);
    assert_eq!(renamed.body["name"], "Code review");
    assert_eq!(renamed.body["kind"], "active");

    // Labels and projects.
    let label = call(
        &app,
        "POST",
        &format!("{base}/labels"),
        &write,
        Some(json!({"name":"bug","color":"red"})),
    )
    .await;
    assert_eq!(label.status, StatusCode::CREATED, "{}", label.body);
    let label_id = label.body["id"].as_str().unwrap().to_owned();
    let project = call(
        &app,
        "POST",
        &format!("{base}/projects"),
        &write,
        Some(json!({"name":"Launch","team_ids":[team_id]})),
    )
    .await;
    assert_eq!(project.status, StatusCode::CREATED, "{}", project.body);
    let project_id = project.body["id"].as_str().unwrap().to_owned();
    let described = call(
        &app,
        "PATCH",
        &format!("{base}/projects/{project_id}"),
        &write,
        Some(json!({"description":"Q4"})),
    )
    .await;
    assert_eq!(described.body["description"], "Q4");
    assert_eq!(described.body["name"], "Launch");

    // Issues: create, read by key, merge-patch, preconditions.
    let created = call(
        &app,
        "POST",
        &format!("{base}/issues"),
        &write,
        Some(json!({
            "team": "PLA",
            "title": "Rotate certificates",
            "assignee": member.profile.email,
            "labels": ["Bug"],
            "project": project_id,
            "priority": "high"
        })),
    )
    .await;
    assert_eq!(created.status, StatusCode::CREATED, "{}", created.body);
    // Responses name what the issue points at, and say which token created it.
    assert_eq!(created.body["team"]["name"], "Platform");
    assert_eq!(created.body["stage"]["id"], json!(first_stage));
    assert_eq!(created.body["assignee"]["display_name"], "member");
    assert_eq!(created.body["labels"][0]["name"], "bug");
    assert_eq!(created.body["project"]["name"], "Launch");
    assert_eq!(created.body["created_by"]["id"], json!(owner.profile.id));
    assert_eq!(created.body["created_via"]["kind"], "api");
    assert_eq!(created.body["created_via"]["name"], "CI");
    let nameless = call(
        &app,
        "POST",
        &format!("{base}/issues"),
        &write,
        Some(json!({"team": "Platform", "title": "x", "stage": "Doing"})),
    )
    .await;
    assert_eq!(
        nameless.status,
        StatusCode::BAD_REQUEST,
        "{}",
        nameless.body
    );
    assert!(
        nameless.body["error"]
            .as_str()
            .unwrap()
            .contains("Code review"),
        "{}",
        nameless.body
    );
    let issue_id = created.body["id"].as_str().unwrap().to_owned();
    let key = created.body["key"].as_str().unwrap().to_owned();
    assert_eq!(key, "PLA-1");
    assert_eq!(etag(&created), format!("\"{}\"", created.body["version"]));

    let by_key = call(&app, "GET", &format!("{base}/issues/{key}"), &read, None).await;
    assert_eq!(by_key.status, StatusCode::OK, "{}", by_key.body);
    assert_eq!(by_key.body["id"], json!(issue_id));
    let lower = key.to_lowercase();
    let by_lower = call(&app, "GET", &format!("{base}/issues/{lower}"), &read, None).await;
    assert_eq!(by_lower.body["id"], json!(issue_id));
    let missing = call(
        &app,
        "GET",
        &format!("{base}/issues/PLA-99999"),
        &read,
        None,
    )
    .await;
    assert_eq!(missing.status, StatusCode::NOT_FOUND);
    let nonsense = call(&app, "GET", &format!("{base}/issues/banana"), &read, None).await;
    assert_eq!(nonsense.status, StatusCode::BAD_REQUEST);

    let version = etag(&by_key);
    let patched = send(
        &app,
        "PATCH",
        &format!("{base}/issues/{key}"),
        Some(&write),
        Some(json!({"assignee": null, "title": "Rotate TLS certificates", "stage": "code review"})),
        &[("If-Match", &version)],
    )
    .await;
    assert_eq!(patched.status, StatusCode::OK, "{}", patched.body);
    assert_eq!(patched.body["assignee"], Value::Null);
    assert_eq!(patched.body["title"], "Rotate TLS certificates");
    assert_eq!(patched.body["stage"]["id"], json!(stage_id));
    assert_eq!(patched.body["labels"][0]["id"], json!(label_id));
    assert_ne!(etag(&patched), version);
    let unlabeled = call(
        &app,
        "PATCH",
        &format!("{base}/issues/{key}"),
        &write,
        Some(json!({"remove_labels": ["bug"], "assignee": "me"})),
    )
    .await;
    assert_eq!(unlabeled.body["labels"], json!([]), "{}", unlabeled.body);
    assert_eq!(unlabeled.body["assignee"]["id"], json!(owner.profile.id));
    let relabeled = call(
        &app,
        "PATCH",
        &format!("{base}/issues/{key}"),
        &write,
        Some(json!({"add_labels": [label_id]})),
    )
    .await;
    assert_eq!(
        relabeled.body["labels"][0]["name"], "bug",
        "{}",
        relabeled.body
    );

    let stale = send(
        &app,
        "PATCH",
        &format!("{base}/issues/{issue_id}"),
        Some(&write),
        Some(json!({"title": "Lost update"})),
        &[("If-Match", &version)],
    )
    .await;
    assert_eq!(
        stale.status,
        StatusCode::PRECONDITION_FAILED,
        "{}",
        stale.body
    );
    let unknown = call(
        &app,
        "PATCH",
        &format!("{base}/issues/{issue_id}"),
        &write,
        Some(json!({"clear_assignee": true})),
    )
    .await;
    assert_eq!(unknown.status, StatusCode::UNPROCESSABLE_ENTITY);

    // Idempotent creates replay instead of duplicating.
    let mut keyed = Vec::new();
    for _ in 0..2 {
        let reply = send(
            &app,
            "POST",
            &format!("{base}/issues"),
            Some(&write),
            Some(json!({"team": team_id, "title": "Once"})),
            &[("Idempotency-Key", "create-once")],
        )
        .await;
        assert_eq!(reply.status, StatusCode::CREATED, "{}", reply.body);
        keyed.push(reply.body["id"].clone());
    }
    assert_eq!(keyed[0], keyed[1]);

    // Cursor pagination walks every issue once.
    for title in ["Third", "Fourth"] {
        call(
            &app,
            "POST",
            &format!("{base}/issues"),
            &write,
            Some(json!({"team": team_id, "title": title})),
        )
        .await;
    }
    for sort in ["position", "updated"] {
        let mut seen = Vec::new();
        let mut cursor: Option<String> = None;
        loop {
            let mut path = format!("{base}/issues?limit=2&sort={sort}");
            if let Some(cursor) = &cursor {
                path.push_str(&format!("&cursor={cursor}"));
            }
            let page = call(&app, "GET", &path, &read, None).await;
            assert_eq!(page.status, StatusCode::OK, "{}", page.body);
            assert_eq!(page.body["total"], 4);
            seen.extend(
                page.body["data"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|i| i["id"].clone()),
            );
            match page.body["next_cursor"].as_str() {
                Some(next) => cursor = Some(next.to_owned()),
                None => break,
            }
        }
        assert_eq!(seen.len(), 4, "{sort}");
        seen.dedup();
        assert_eq!(seen.len(), 4, "{sort}");
    }
    let filtered = call(
        &app,
        "GET",
        &format!(
            "{base}/issues?where=%5B%7B%22field%22%3A%22stage_id%22%2C%22op%22%3A%22is%22%2C%22values%22%3A%5B%22{stage_id}%22%5D%7D%5D"
        ),
        &read,
        None,
    )
    .await;
    assert_eq!(filtered.status, StatusCode::OK, "{}", filtered.body);
    assert_eq!(filtered.body["data"].as_array().unwrap().len(), 1);
    // Filters take names, keys and emails as well as ids.
    let by_name = call(
        &app,
        "GET",
        &filtered_path(
            &base,
            json!([
                {"field": "stage", "op": "is", "values": ["Code Review"]},
                {"field": "assignee", "op": "is", "values": ["me"]},
                {"field": "label", "op": "is", "values": ["bug"]},
                {"field": "team", "op": "is", "values": ["pla"]}
            ]),
        ),
        &read,
        None,
    )
    .await;
    assert_eq!(by_name.status, StatusCode::OK, "{}", by_name.body);
    assert_eq!(by_name.body["total"], 1, "{}", by_name.body);
    assert_eq!(by_name.body["data"][0]["key"], json!(key));
    let unknown_label = call(
        &app,
        "GET",
        &filtered_path(
            &base,
            json!([{"field": "label", "op": "is", "values": ["nope"]}]),
        ),
        &read,
        None,
    )
    .await;
    assert_eq!(unknown_label.status, StatusCode::BAD_REQUEST);
    // A milestone name matches that milestone in every project.
    let mut in_beta = vec![];
    for name in ["Alpha", "Gamma"] {
        let project = call(
            &app,
            "POST",
            &format!("{base}/projects"),
            &write,
            Some(json!({"name": name, "team_ids": [team_id]})),
        )
        .await;
        assert_eq!(project.status, StatusCode::CREATED, "{}", project.body);
        let milestone = call(
            &app,
            "POST",
            &format!("/internal-api/workspaces/{ws}/commands"),
            &owner.token,
            Some(json!({"command": {"type":"create_milestone","project_id":project.body["id"],"name":"Beta","deadline":null}})),
        )
        .await;
        assert_eq!(milestone.status, StatusCode::OK, "{}", milestone.body);
        let issue = call(
            &app,
            "POST",
            &format!("{base}/issues"),
            &write,
            Some(json!({"team": team_id, "title": name, "project": name, "milestone": "beta"})),
        )
        .await;
        assert_eq!(issue.status, StatusCode::CREATED, "{}", issue.body);
        in_beta.push(issue.body["id"].clone());
    }
    let by_milestone = call(
        &app,
        "GET",
        &filtered_path(
            &base,
            json!([{"field": "milestone", "op": "is", "values": ["Beta"]}]),
        ),
        &read,
        None,
    )
    .await;
    assert_eq!(by_milestone.status, StatusCode::OK, "{}", by_milestone.body);
    let mut found: Vec<Value> = by_milestone.body["data"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| i["id"].clone())
        .collect();
    found.sort_by_key(Value::to_string);
    in_beta.sort_by_key(Value::to_string);
    assert_eq!(found, in_beta);
    let unknown_milestone = call(
        &app,
        "GET",
        &filtered_path(
            &base,
            json!([{"field": "milestone", "op": "is", "values": ["nope"]}]),
        ),
        &read,
        None,
    )
    .await;
    assert_eq!(unknown_milestone.status, StatusCode::BAD_REQUEST);
    let bad_cursor = call(
        &app,
        "GET",
        &format!("{base}/issues?cursor=nope"),
        &read,
        None,
    )
    .await;
    assert_eq!(bad_cursor.status, StatusCode::BAD_REQUEST);

    // Comments.
    let comment = call(
        &app,
        "POST",
        &format!("{base}/issues/{key}/comments"),
        &write,
        Some(json!({"body":"Scheduled for Friday"})),
    )
    .await;
    assert_eq!(comment.status, StatusCode::CREATED, "{}", comment.body);
    assert_eq!(comment.body["author"]["display_name"], "owner");
    assert_eq!(comment.body["via"]["name"], "CI");
    let comment_id = comment.body["id"].as_str().unwrap().to_owned();
    let edited = call(
        &app,
        "PATCH",
        &format!("{base}/comments/{comment_id}"),
        &write,
        Some(json!({"body":"Scheduled for Monday"})),
    )
    .await;
    assert_eq!(edited.body["body"], "Scheduled for Monday");
    let thread = call(
        &app,
        "GET",
        &format!("{base}/issues/{key}/comments"),
        &read,
        None,
    )
    .await;
    assert_eq!(thread.body["data"].as_array().unwrap().len(), 1);
    let history = call(
        &app,
        "GET",
        &format!("{base}/issues/{key}/activity"),
        &read,
        None,
    )
    .await;
    assert_eq!(history.status, StatusCode::OK, "{}", history.body);
    let entries = history.body["data"].as_array().unwrap();
    assert!(entries.iter().any(|a| a["action"] == "create_issue"));
    assert!(
        entries
            .iter()
            .all(|a| a["via"]["name"] == "CI" && a["actor"]["display_name"] == "owner"),
        "{}",
        history.body
    );

    // Comment tokens write comments and nothing else.
    let commenter = token(&app, &owner, json!({"name":"Reviewer","access":"comment"})).await;
    let remark = call(
        &app,
        "POST",
        &format!("{base}/issues/{key}/comments"),
        &commenter,
        Some(json!({"body":"Looks good", "mentions": [member.profile.email]})),
    )
    .await;
    assert_eq!(remark.status, StatusCode::CREATED, "{}", remark.body);
    assert_eq!(remark.body["mentions"][0]["display_name"], "member");
    let remark_id = remark.body["id"].as_str().unwrap().to_owned();
    let meddling = call(
        &app,
        "PATCH",
        &format!("{base}/issues/{key}"),
        &commenter,
        Some(json!({"title":"Nope"})),
    )
    .await;
    assert_eq!(meddling.status, StatusCode::FORBIDDEN, "{}", meddling.body);
    let unsaid = call(
        &app,
        "DELETE",
        &format!("{base}/comments/{remark_id}"),
        &commenter,
        None,
    )
    .await;
    assert_eq!(unsaid.status, StatusCode::NO_CONTENT);

    // Trash and restore.
    let deleted = call(
        &app,
        "DELETE",
        &format!("{base}/issues/{key}"),
        &write,
        None,
    )
    .await;
    assert_eq!(deleted.status, StatusCode::NO_CONTENT);
    let gone = call(&app, "GET", &format!("{base}/issues/{key}"), &read, None).await;
    assert_eq!(gone.status, StatusCode::NOT_FOUND);
    let restored = call(
        &app,
        "POST",
        &format!("{base}/issues/{key}/restore"),
        &write,
        None,
    )
    .await;
    assert_eq!(restored.status, StatusCode::OK, "{}", restored.body);
    assert_eq!(restored.body["deleted_at"], Value::Null);

    // Tokens carry the user's role: a member's write token can't administer webhooks.
    let member_write = token(&app, &member, json!({"name":"Bot","access":"write"})).await;
    let forbidden = call(
        &app,
        "POST",
        &format!("{base}/webhooks"),
        &member_write,
        Some(json!({"name":"Hook","url":"https://hooks.example.com/blackwall"})),
    )
    .await;
    assert_eq!(forbidden.status, StatusCode::FORBIDDEN);
    let listing = call(
        &app,
        "GET",
        &format!("{base}/webhooks"),
        &member_write,
        None,
    )
    .await;
    assert_eq!(listing.status, StatusCode::FORBIDDEN);

    // Webhooks: generated secret shown once, event filtering, minimal payloads.
    let events = send(&app, "GET", "/api/v1/webhook-events", None, None, &[]).await;
    assert!(
        events.body["data"]
            .as_array()
            .unwrap()
            .contains(&json!("comment.created"))
    );
    let invalid = call(
        &app,
        "POST",
        &format!("{base}/webhooks"),
        &write,
        Some(
            json!({"name":"Hook","url":"https://hooks.example.com/b","events":["issue.exploded"]}),
        ),
    )
    .await;
    assert_eq!(invalid.status, StatusCode::BAD_REQUEST);
    let hook = call(
        &app,
        "POST",
        &format!("{base}/webhooks"),
        &write,
        Some(json!({"name":"Comments","url":"https://hooks.example.com/b","events":["comment.created"]})),
    )
    .await;
    assert_eq!(hook.status, StatusCode::CREATED, "{}", hook.body);
    assert!(hook.body["secret"].as_str().unwrap().starts_with("whsec_"));
    let hook_id = hook.body["id"].as_str().unwrap().to_owned();
    let fetched = call(
        &app,
        "GET",
        &format!("{base}/webhooks/{hook_id}"),
        &write,
        None,
    )
    .await;
    assert!(fetched.body.get("secret").is_none());
    assert_eq!(fetched.body["url"], "https://hooks.example.com/b");

    call(
        &app,
        "PATCH",
        &format!("{base}/issues/{key}"),
        &write,
        Some(json!({"priority":"low"})),
    )
    .await;
    call(
        &app,
        "POST",
        &format!("{base}/issues/{key}/comments"),
        &write,
        Some(json!({"body":"Delivered"})),
    )
    .await;
    let deliveries: Vec<Value> = sqlx::query_scalar(
        "SELECT payload::jsonb->'event' FROM jobs WHERE kind='webhook' AND payload::jsonb->>'integration_id'=$1",
    )
    .bind(&hook_id)
    .fetch_all(&store.pool)
    .await
    .unwrap();
    assert_eq!(deliveries.len(), 1, "{deliveries:?}");
    let event = &deliveries[0];
    assert_eq!(event["type"], "comment.created");
    assert_eq!(event["entity_type"], "comment");
    assert_eq!(event["workspace_id"], json!(ws));
    assert_eq!(event["actor_id"], json!(owner.profile.id));
    assert_eq!(event["via"]["kind"], "api");
    assert_eq!(event["via"]["name"], "CI");
    assert!(event.get("activity").is_none());

    let widened = call(
        &app,
        "PATCH",
        &format!("{base}/webhooks/{hook_id}"),
        &write,
        Some(json!({"events":[]})),
    )
    .await;
    assert_eq!(widened.body["events"], json!([]));
    assert_eq!(widened.body["enabled"], true);

    // MCP over the same token.
    let mcp = |token: String, body: Value| {
        let app = app.clone();
        async move { send(&app, "POST", "/mcp", Some(&token), Some(body), &[]).await }
    };
    let init = mcp(
        read.clone(),
        json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"test","version":"1"}}}),
    )
    .await;
    assert_eq!(init.body["result"]["protocolVersion"], "2025-06-18");
    let notified = mcp(
        read.clone(),
        json!({"jsonrpc":"2.0","method":"notifications/initialized"}),
    )
    .await;
    assert_eq!(notified.status, StatusCode::ACCEPTED);

    let read_tools = mcp(
        read.clone(),
        json!({"jsonrpc":"2.0","id":2,"method":"tools/list"}),
    )
    .await;
    let names: Vec<&str> = read_tools.body["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["name"].as_str().unwrap())
        .collect();
    assert!(names.contains(&"search_issues"));
    assert!(!names.contains(&"create_issue"));
    assert!(!names.contains(&"add_comment"));
    let comment_tools = mcp(
        commenter.clone(),
        json!({"jsonrpc":"2.0","id":2,"method":"tools/list"}),
    )
    .await;
    let comment_tools = comment_tools.body["result"]["tools"].as_array().unwrap();
    assert!(comment_tools.iter().any(|t| t["name"] == "add_comment"));
    assert!(!comment_tools.iter().any(|t| t["name"] == "update_issue"));
    assert!(
        comment_tools
            .iter()
            .any(|t| t["name"] == "delete_comment" && t["annotations"]["destructiveHint"] == true)
    );

    // The read token reaches one workspace, so workspace_id may be omitted.
    let found = mcp(
        read.clone(),
        json!({"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"get_issue","arguments":{"issue":key}}}),
    )
    .await;
    let result = &found.body["result"];
    assert_eq!(result["isError"], false, "{result}");
    assert_eq!(result["structuredContent"]["issue"]["key"], json!(key));
    assert_eq!(
        result["structuredContent"]["comments"]
            .as_array()
            .unwrap()
            .len(),
        2
    );

    let refused = mcp(
        read.clone(),
        json!({"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"create_issue","arguments":{"team":"PLA","title":"x"}}}),
    )
    .await;
    assert_eq!(refused.body["result"]["isError"], true);

    let ambiguous = mcp(
        write.clone(),
        json!({"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"search_issues","arguments":{}}}),
    )
    .await;
    assert_eq!(ambiguous.body["result"]["isError"], true);

    let made = mcp(
        write.clone(),
        json!({"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"create_issue","arguments":{
            "workspace_id": ws, "team": "Platform", "title": "From an agent", "parent": key,
            "stage": "Code review", "labels": ["bug"], "assignee": "me"
        }}}),
    )
    .await;
    let made = &made.body["result"]["structuredContent"]["issue"];
    assert_eq!(made["title"], "From an agent", "{made}");
    assert_eq!(made["parent"]["id"], json!(issue_id));
    assert_eq!(made["parent"]["key"], json!(key));
    assert_eq!(made["stage"]["name"], "Code review");
    assert_eq!(made["created_via"]["kind"], "mcp");
    assert_eq!(made["created_via"]["name"], "CI");

    let searched = mcp(
        write.clone(),
        json!({"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"search_issues","arguments":{
            "workspace_id": ws, "query": "agent"
        }}}),
    )
    .await;
    let hits = searched.body["result"]["structuredContent"]["issues"]
        .as_array()
        .unwrap()
        .clone();
    assert_eq!(hits.len(), 1, "{}", searched.body);
    assert_eq!(searched.body["result"]["structuredContent"]["total"], 1);
    assert_eq!(hits[0]["stage"]["name"], "Code review");
    assert_eq!(hits[0]["labels"], json!(["bug"]));
    assert_eq!(hits[0]["parent"], json!(key));
    assert_eq!(hits[0]["description"], "");
    let mine = mcp(
        write.clone(),
        json!({"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"search_issues","arguments":{
            "workspace_id": ws,
            "where": [{"field": "stage", "op": "is", "values": ["code review"]}, {"field": "parent", "op": "is", "values": [key]}]
        }}}),
    )
    .await;
    assert_eq!(
        mine.body["result"]["structuredContent"]["total"], 1,
        "{}",
        mine.body
    );

    let overview = mcp(
        write.clone(),
        json!({"jsonrpc":"2.0","id":8,"method":"tools/call","params":{"name":"get_workspace_overview","arguments":{"workspace_id":ws}}}),
    )
    .await;
    let overview = &overview.body["result"]["structuredContent"];
    assert_eq!(
        overview["members"].as_array().unwrap().len(),
        2,
        "{overview}"
    );
    assert_eq!(overview["me"]["id"], json!(owner.profile.id));
    assert_eq!(overview["teams"][0]["key"], "PLA");
    assert_eq!(overview["projects"][0]["teams"], json!(["PLA"]));
    let unknown = mcp(
        write.clone(),
        json!({"jsonrpc":"2.0","id":9,"method":"resources/list"}),
    )
    .await;
    assert_eq!(unknown.body["error"]["code"], -32601);

    // Deleting a stage moves its issues to the replacement.
    let removed = call(
        &app,
        "DELETE",
        &format!("{base}/teams/{team_id}/stages/{stage_id}?replacement={first_stage}"),
        &write,
        None,
    )
    .await;
    assert_eq!(removed.status, StatusCode::NO_CONTENT, "{}", removed.body);
    let moved = call(&app, "GET", &format!("{base}/issues/{key}"), &read, None).await;
    assert_eq!(moved.body["stage"]["id"], json!(first_stage));

    // Browsers may call the API from any origin, but never with cookies.
    let preflight = send(
        &app,
        "OPTIONS",
        &format!("{base}/issues/{key}"),
        None,
        None,
        &[
            ("Origin", "https://elsewhere.example"),
            ("Access-Control-Request-Method", "PATCH"),
            (
                "Access-Control-Request-Headers",
                "authorization,if-match,content-type",
            ),
        ],
    )
    .await;
    assert!(preflight.status.is_success(), "{}", preflight.status);
    assert_eq!(preflight.headers["access-control-allow-origin"], "*");
    assert!(
        !preflight
            .headers
            .contains_key("access-control-allow-credentials")
    );
    let cross = send(
        &app,
        "PATCH",
        &format!("{base}/issues/{key}"),
        Some(&write),
        Some(json!({"priority":"urgent"})),
        &[
            ("Origin", "https://elsewhere.example"),
            ("Host", "blackwall.example"),
        ],
    )
    .await;
    assert_eq!(cross.status, StatusCode::OK, "{}", cross.body);
    assert_eq!(cross.headers["access-control-allow-origin"], "*");
    let exposed = cross.headers["access-control-expose-headers"]
        .to_str()
        .unwrap();
    assert!(exposed.contains("etag") && exposed.contains("x-ratelimit-remaining"));
    // The cookie-authenticated app keeps refusing cross-origin writes.
    let internal = send(
        &app,
        "POST",
        "/internal-api/workspaces",
        Some(&owner.token),
        Some(json!({"name":"Cross","slug":"cross"})),
        &[
            ("Origin", "https://elsewhere.example"),
            ("Host", "blackwall.example"),
        ],
    )
    .await;
    assert_eq!(internal.status, StatusCode::FORBIDDEN);

    // MCP admits same-origin and listed origins only, against DNS rebinding.
    let ping = json!({"jsonrpc":"2.0","id":10,"method":"ping"});
    let from = |origin: &'static str| {
        let (app, write, ping) = (app.clone(), write.clone(), ping.clone());
        async move {
            send(
                &app,
                "POST",
                "/mcp",
                Some(&write),
                Some(ping),
                &[("Origin", origin), ("Host", "blackwall.example")],
            )
            .await
        }
    };
    let rebinding = from("https://evil.example").await;
    assert_eq!(rebinding.status, StatusCode::FORBIDDEN);
    assert!(
        !rebinding
            .headers
            .contains_key("access-control-allow-origin")
    );
    let same = from("https://blackwall.example").await;
    assert_eq!(same.body["result"], json!({}));
    let listed = from("https://agent.example.com").await;
    assert_eq!(listed.status, StatusCode::OK);
    assert_eq!(
        listed.headers["access-control-allow-origin"],
        "https://agent.example.com"
    );
    let mcp_preflight = send(
        &app,
        "OPTIONS",
        "/mcp",
        None,
        None,
        &[
            ("Origin", "https://agent.example.com"),
            ("Host", "blackwall.example"),
            ("Access-Control-Request-Method", "POST"),
            (
                "Access-Control-Request-Headers",
                "authorization,content-type,mcp-protocol-version",
            ),
        ],
    )
    .await;
    assert!(
        mcp_preflight.status.is_success(),
        "{}",
        mcp_preflight.status
    );

    // Revoked tokens stop working at once.
    let tokens = call(&app, "GET", "/internal-api/me/tokens", &owner.token, None).await;
    let read_id = tokens
        .body
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["name"] == "Reports")
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let revoked = call(
        &app,
        "DELETE",
        &format!("/internal-api/me/tokens/{read_id}"),
        &owner.token,
        None,
    )
    .await;
    assert_eq!(revoked.status, StatusCode::NO_CONTENT);
    let after = call(&app, "GET", "/api/v1/me", &read, None).await;
    assert_eq!(after.status, StatusCode::UNAUTHORIZED);

    database.cleanup().await;
}

#[tokio::test]
async fn deletes_labels_projects_and_milestones() {
    let database = support::TestDatabase::new().await;
    let store = Store::connect(&database.url).await.unwrap();
    let app = router(store.clone());
    let owner = account(&store, "owner").await;
    let ws = workspace(&store, &owner, "Deletes").await;
    let write = token(&app, &owner, json!({"name":"CI","access":"write"})).await;
    let read = token(&app, &owner, json!({"name":"Reports","access":"read"})).await;
    let base = format!("/api/v1/workspaces/{ws}");

    let schema = send(&app, "GET", "/api/v1/openapi.json", None, None, &[]).await;
    for path in [
        "labels/{label}",
        "projects/{project}",
        "milestones/{milestone}",
    ] {
        let operation = &schema.body["paths"][format!("/api/v1/workspaces/{{workspace}}/{path}")];
        assert!(
            operation["delete"]["responses"]["204"].is_object(),
            "{path}"
        );
    }

    let label = call(
        &app,
        "POST",
        &format!("{base}/labels"),
        &write,
        Some(json!({"name":"typo","color":"red"})),
    )
    .await;
    assert_eq!(label.status, StatusCode::CREATED, "{}", label.body);
    let project = call(
        &app,
        "POST",
        &format!("{base}/projects"),
        &write,
        Some(json!({"name":"Dead","team_ids":[]})),
    )
    .await;
    assert_eq!(project.status, StatusCode::CREATED, "{}", project.body);
    let project_id = project.body["id"].as_str().unwrap().to_owned();
    let mut milestones = vec![];
    for name in ["Beta", "GA"] {
        let created = call(
            &app,
            "POST",
            &format!("/internal-api/workspaces/{ws}/commands"),
            &owner.token,
            Some(json!({"command": {"type":"create_milestone","project_id":project_id,"name":name,"deadline":null}})),
        )
        .await;
        assert_eq!(created.status, StatusCode::OK, "{}", created.body);
        milestones.push(created.body["result"]["id"].as_str().unwrap().to_owned());
    }

    let paths = [
        format!("{base}/labels/{}", label.body["id"].as_str().unwrap()),
        format!("{base}/milestones/{}", milestones[0]),
        format!("{base}/projects/{project_id}"),
    ];
    let denied = call(&app, "DELETE", &paths[0], &read, None).await;
    assert_eq!(denied.status, StatusCode::FORBIDDEN);
    for path in &paths {
        let removed = call(&app, "DELETE", path, &write, None).await;
        assert_eq!(
            removed.status,
            StatusCode::NO_CONTENT,
            "{path}: {}",
            removed.body
        );
        let again = call(&app, "DELETE", path, &write, None).await;
        assert_eq!(again.status, StatusCode::NOT_FOUND, "{path}");
        let fetched = call(&app, "GET", path, &read, None).await;
        assert_eq!(fetched.status, StatusCode::NOT_FOUND, "{path}");
    }
    let orphan = call(
        &app,
        "GET",
        &format!("{base}/milestones/{}", milestones[1]),
        &read,
        None,
    )
    .await;
    assert_eq!(orphan.status, StatusCode::NOT_FOUND);

    drop(app);
    store.pool.close().await;
    database.cleanup().await;
}

#[tokio::test]
async fn project_plan_patches_merge_and_lose_a_removed_lead() {
    let database = support::TestDatabase::new().await;
    let store = Store::connect(&database.url).await.unwrap();
    let app = router(store.clone());
    let owner = account(&store, "owner").await;
    let lead = account(&store, "lead").await;
    let stranger = account(&store, "stranger").await;
    let ws = workspace(&store, &owner, "Plans").await;
    sqlx::query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'member')")
        .bind(ws)
        .bind(lead.profile.id)
        .execute(&store.pool)
        .await
        .unwrap();
    let write = token(&app, &lead, json!({"name":"CI","access":"write"})).await;
    let base = format!("/api/v1/workspaces/{ws}");

    let created = call(
        &app,
        "POST",
        &format!("{base}/projects"),
        &write,
        Some(json!({"name":"Launch","team_ids":[]})),
    )
    .await;
    assert_eq!(created.status, StatusCode::CREATED, "{}", created.body);
    assert_eq!(created.body["status"], "planned");
    assert_eq!(created.body["lead_id"], Value::Null);
    let path = format!("{base}/projects/{}", created.body["id"].as_str().unwrap());
    let patch = |body: Value| call(&app, "PATCH", &path, &write, Some(body));
    let plan = |body: &Value| {
        json!({
            "name": body["name"],
            "lead_id": body["lead_id"],
            "status": body["status"],
            "health": body["health"],
            "start_date": body["start_date"],
            "target_date": body["target_date"],
        })
    };

    let set = patch(json!({
        "lead_id": lead.profile.id,
        "status": "in_progress",
        "health": "at_risk",
        "start_date": "2026-11-01",
        "target_date": "2026-12-15",
    }))
    .await;
    assert_eq!(set.status, StatusCode::OK, "{}", set.body);
    let expected = json!({
        "name": "Launch",
        "lead_id": lead.profile.id,
        "status": "in_progress",
        "health": "at_risk",
        "start_date": "2026-11-01",
        "target_date": "2026-12-15",
    });
    assert_eq!(plan(&set.body), expected);
    let fetched = call(&app, "GET", &path, &write, None).await;
    assert_eq!(plan(&fetched.body), expected);

    let status_only = patch(json!({"status": "completed"})).await;
    assert_eq!(status_only.status, StatusCode::OK, "{}", status_only.body);
    let mut expected = expected;
    expected["status"] = json!("completed");
    assert_eq!(plan(&status_only.body), expected);

    let renamed = patch(json!({"name": "Relaunch"})).await;
    assert_eq!(renamed.status, StatusCode::OK, "{}", renamed.body);
    expected["name"] = json!("Relaunch");
    assert_eq!(plan(&renamed.body), expected);

    let backwards = patch(json!({"start_date": "2026-12-20"})).await;
    assert_eq!(
        backwards.status,
        StatusCode::BAD_REQUEST,
        "{}",
        backwards.body
    );
    let outsider = patch(json!({"lead_id": stranger.profile.id})).await;
    assert_eq!(outsider.status, StatusCode::FORBIDDEN, "{}", outsider.body);
    let mixed_backwards =
        patch(json!({"name": "Renamed", "start_date": "2027-01-01", "target_date": "2026-01-01"}))
            .await;
    assert_eq!(
        mixed_backwards.status,
        StatusCode::BAD_REQUEST,
        "{}",
        mixed_backwards.body
    );
    let mixed_outsider = patch(json!({"name": "Renamed", "lead_id": stranger.profile.id})).await;
    assert_eq!(
        mixed_outsider.status,
        StatusCode::FORBIDDEN,
        "{}",
        mixed_outsider.body
    );
    let unchanged = call(&app, "GET", &path, &write, None).await;
    assert_eq!(plan(&unchanged.body), expected);
    assert_eq!(unchanged.body["version"], renamed.body["version"]);

    let version = unchanged.body["version"].as_i64().unwrap();
    let mixed = send(
        &app,
        "PATCH",
        &path,
        Some(&write),
        Some(json!({"name": "Launch", "health": null})),
        &[("If-Match", &etag(&unchanged))],
    )
    .await;
    assert_eq!(mixed.status, StatusCode::OK, "{}", mixed.body);
    expected["name"] = json!("Launch");
    expected["health"] = Value::Null;
    assert_eq!(plan(&mixed.body), expected);
    assert_eq!(mixed.body["version"], version + 2);
    let stale = send(
        &app,
        "PATCH",
        &path,
        Some(&write),
        Some(json!({"status": "cancelled"})),
        &[("If-Match", &etag(&unchanged))],
    )
    .await;
    assert_eq!(stale.status, StatusCode::PRECONDITION_FAILED);

    let removed = call(
        &app,
        "POST",
        &format!("/internal-api/workspaces/{ws}/commands"),
        &owner.token,
        Some(json!({"command": {"type":"remove_member","user_id":lead.profile.id}})),
    )
    .await;
    assert_eq!(removed.status, StatusCode::OK, "{}", removed.body);
    let owner_token = token(&app, &owner, json!({"name":"Owner","access":"read"})).await;
    let orphaned = call(&app, "GET", &path, &owner_token, None).await;
    expected["lead_id"] = Value::Null;
    assert_eq!(plan(&orphaned.body), expected);
    assert_eq!(orphaned.body["version"], version + 3);

    let cleared = call(
        &app,
        "PATCH",
        &path,
        &token(&app, &owner, json!({"name":"Owner write","access":"write"})).await,
        Some(json!({"start_date": null, "target_date": null})),
    )
    .await;
    assert_eq!(cleared.status, StatusCode::OK, "{}", cleared.body);
    expected["start_date"] = Value::Null;
    expected["target_date"] = Value::Null;
    assert_eq!(plan(&cleared.body), expected);

    drop(app);
    store.pool.close().await;
    database.cleanup().await;
}

#[tokio::test]
async fn keyed_patches_replay_after_unrelated_writes() {
    let database = support::TestDatabase::new().await;
    let store = Store::connect(&database.url).await.unwrap();
    let app = router(store.clone());
    let owner = account(&store, "owner").await;
    let ws = workspace(&store, &owner, "Replays").await;
    let write = token(&app, &owner, json!({"name":"CI","access":"write"})).await;
    let base = format!("/api/v1/workspaces/{ws}");

    let project = call(
        &app,
        "POST",
        &format!("{base}/projects"),
        &write,
        Some(json!({"name":"Launch","team_ids":[]})),
    )
    .await;
    assert_eq!(project.status, StatusCode::CREATED, "{}", project.body);
    let label = call(
        &app,
        "POST",
        &format!("{base}/labels"),
        &write,
        Some(json!({"name":"bug","color":"red"})),
    )
    .await;
    assert_eq!(label.status, StatusCode::CREATED, "{}", label.body);

    for (path, keyed, unrelated, different, field) in [
        (
            format!("{base}/projects/{}", project.body["id"].as_str().unwrap()),
            json!({"status": "completed"}),
            json!({"health": "at_risk"}),
            json!({"status": "cancelled"}),
            "status",
        ),
        (
            format!("{base}/labels/{}", label.body["id"].as_str().unwrap()),
            json!({"name": "defect"}),
            json!({"color": "blue"}),
            json!({"name": "regression"}),
            "name",
        ),
    ] {
        let key = format!("patch-{field}");
        let key = [("Idempotency-Key", key.as_str())];
        let first = send(
            &app,
            "PATCH",
            &path,
            Some(&write),
            Some(keyed.clone()),
            &key,
        )
        .await;
        assert_eq!(first.status, StatusCode::OK, "{path}: {}", first.body);
        let other = call(&app, "PATCH", &path, &write, Some(unrelated)).await;
        assert_eq!(other.status, StatusCode::OK, "{path}: {}", other.body);

        let replay = send(&app, "PATCH", &path, Some(&write), Some(keyed), &key).await;
        assert_eq!(replay.status, StatusCode::OK, "{path}: {}", replay.body);
        assert_eq!(replay.body[field], first.body[field], "{path}");
        assert_eq!(replay.body["version"], other.body["version"], "{path}");

        let reused = send(&app, "PATCH", &path, Some(&write), Some(different), &key).await;
        assert_eq!(
            reused.status,
            StatusCode::CONFLICT,
            "{path}: {}",
            reused.body
        );
    }

    drop(app);
    store.pool.close().await;
    database.cleanup().await;
}

/// A workspace with an owner's write token, for keyed request tests.
struct Keyed {
    database: support::TestDatabase,
    store: Store,
    app: axum::Router,
    owner: Session,
    workspace: Uuid,
    write: String,
    base: String,
}

impl Keyed {
    async fn new() -> Self {
        let database = support::TestDatabase::new().await;
        let store = Store::connect(&database.url).await.unwrap();
        let app = router(store.clone());
        let owner = account(&store, "owner").await;
        let workspace = workspace(&store, &owner, "Keys").await;
        let write = token(&app, &owner, json!({"name":"CI","access":"write"})).await;
        let base = format!("/api/v1/workspaces/{workspace}");
        Self {
            database,
            store,
            app,
            owner,
            workspace,
            write,
            base,
        }
    }

    async fn send(&self, method: &str, path: &str, body: Body, key: Option<&str>) -> Reply {
        let mut headers = vec![("Content-Type", "application/json")];
        headers.extend(key.map(|key| ("Idempotency-Key", key)));
        send_body(&self.app, method, path, Some(&self.write), body, &headers).await
    }

    async fn label(&self) -> (Uuid, String) {
        let label = call(
            &self.app,
            "POST",
            &format!("{}/labels", self.base),
            &self.write,
            Some(json!({"name":"bug","color":"red"})),
        )
        .await;
        assert_eq!(label.status, StatusCode::CREATED, "{}", label.body);
        let id = Uuid::parse_str(label.body["id"].as_str().unwrap()).unwrap();
        (id, format!("{}/labels/{id}", self.base))
    }

    async fn cleanup(self) {
        drop(self.app);
        self.store.pool.close().await;
        self.database.cleanup().await;
    }
}

#[tokio::test]
async fn keyed_webhook_create_replays_its_secret() {
    let keyed = Keyed::new().await;
    let hooks = format!("{}/webhooks", keyed.base);
    let body = r#"{"name":"Hook","url":"https://hooks.example.com/keyed"}"#;
    let mut secrets = Vec::new();
    for _ in 0..2 {
        let reply = keyed
            .send("POST", &hooks, Body::from(body), Some("hook-once"))
            .await;
        assert_eq!(reply.status, StatusCode::CREATED, "{}", reply.body);
        let stored: String = sqlx::query_scalar("SELECT secret FROM integrations WHERE id=$1")
            .bind(Uuid::parse_str(reply.body["id"].as_str().unwrap()).unwrap())
            .fetch_one(&keyed.store.pool)
            .await
            .unwrap();
        assert_eq!(
            reply.body["secret"], stored,
            "the secret deliveries are signed with"
        );
        secrets.push(stored);
    }
    assert_eq!(secrets[0], secrets[1]);
    keyed.cleanup().await;
}

#[tokio::test]
async fn keyed_project_plan_step_ignores_client_keys() {
    let keyed = Keyed::new().await;
    let project = call(
        &keyed.app,
        "POST",
        &format!("{}/projects", keyed.base),
        &keyed.write,
        Some(json!({"name":"Launch","team_ids":[]})),
    )
    .await;
    let project = format!(
        "{}/projects/{}",
        keyed.base,
        project.body["id"].as_str().unwrap()
    );
    let mixed = r#"{"name":"Relaunch","status":"completed"}"#;
    let reset = || {
        keyed.send(
            "PATCH",
            &project,
            Body::from(r#"{"status":"planned"}"#),
            None,
        )
    };
    // The plan step used to run under `<key>:plan`, which a client may also send.
    for key in ["mixed:plan", "mixed"] {
        assert_eq!(reset().await.status, StatusCode::OK);
        let reply = keyed
            .send("PATCH", &project, Body::from(mixed), Some(key))
            .await;
        assert_eq!(reply.status, StatusCode::OK, "{key}: {}", reply.body);
        assert_eq!(reply.body["status"], "completed", "{key}");
    }

    assert_eq!(reset().await.status, StatusCode::OK);
    let replay = keyed
        .send("PATCH", &project, Body::from(mixed), Some("mixed"))
        .await;
    assert_eq!(replay.status, StatusCode::OK, "{}", replay.body);
    assert_eq!(replay.body["name"], "Relaunch");
    assert_eq!(
        replay.body["status"], "planned",
        "a replay runs neither step again"
    );
    keyed.cleanup().await;
}

#[tokio::test]
async fn keyed_requests_compare_canonical_json() {
    let keyed = Keyed::new().await;
    let (_, label) = keyed.label().await;
    let first = keyed
        .send(
            "PATCH",
            &label,
            Body::from(r#"{"name":"triage","color":"red"}"#),
            Some("reordered"),
        )
        .await;
    assert_eq!(first.status, StatusCode::OK, "{}", first.body);
    let reordered = keyed
        .send(
            "PATCH",
            &label,
            Body::from("{\n  \"color\": \"red\",\n  \"name\": \"triage\"\n}"),
            Some("reordered"),
        )
        .await;
    assert_eq!(reordered.status, StatusCode::OK, "{}", reordered.body);
    assert_eq!(reordered.body["version"], first.body["version"]);

    for (body, status) in [
        (r#"{"name":"triaged"}"#, StatusCode::OK),
        (r#"{"name":"triaged","color":null}"#, StatusCode::CONFLICT),
    ] {
        let reply = keyed
            .send("PATCH", &label, Body::from(body), Some("null"))
            .await;
        assert_eq!(reply.status, status, "{body}: {}", reply.body);
    }
    keyed.cleanup().await;
}

#[tokio::test]
async fn keys_recorded_by_command_still_replay() {
    let keyed = Keyed::new().await;
    let (id, label) = keyed.label().await;
    // Keys stored before requests were fingerprinted hold the command.
    let legacy = keyed
        .store
        .operation(
            keyed.workspace,
            keyed.owner.profile.id,
            Command::UpdateLabel {
                id,
                name: "legacy".into(),
                color: "red".into(),
            },
            Default::default(),
            Some("legacy".into()),
            None,
        )
        .await
        .unwrap();
    let replay = keyed
        .send(
            "PATCH",
            &label,
            Body::from(r#"{"name":"legacy"}"#),
            Some("legacy"),
        )
        .await;
    assert_eq!(replay.status, StatusCode::OK, "{}", replay.body);
    assert_eq!(replay.body["version"], json!(legacy.versions[&id]));
    keyed.cleanup().await;
}

#[tokio::test]
async fn project_plan_steps_recorded_by_command_still_replay() {
    let keyed = Keyed::new().await;
    let created = call(
        &keyed.app,
        "POST",
        &format!("{}/projects", keyed.base),
        &keyed.write,
        Some(json!({"name":"Launch","team_ids":[]})),
    )
    .await;
    assert_eq!(created.status, StatusCode::CREATED, "{}", created.body);
    let id = Uuid::parse_str(created.body["id"].as_str().unwrap()).unwrap();
    let project = format!("{}/projects/{id}", keyed.base);
    fn field<T: serde::de::DeserializeOwned>(project: &Value, name: &str) -> T {
        serde_json::from_value(project[name].clone()).unwrap()
    }
    // A mixed PATCH stored its plan step under `<key>:plan` before requests were fingerprinted.
    for (key, command) in [
        (
            "legacy",
            Command::UpdateProject {
                id,
                name: "Relaunch".into(),
                description: field(&created.body, "description"),
                team_ids: Vec::new(),
            },
        ),
        (
            "legacy:plan",
            Command::SetProjectPlan {
                id,
                lead_id: field(&created.body, "lead_id"),
                status: ProjectStatus::Completed,
                health: field(&created.body, "health"),
                start_date: field(&created.body, "start_date"),
                target_date: field(&created.body, "target_date"),
            },
        ),
    ] {
        keyed
            .store
            .operation(
                keyed.workspace,
                keyed.owner.profile.id,
                command,
                Default::default(),
                Some(key.into()),
                None,
            )
            .await
            .unwrap();
    }
    let reset = keyed
        .send(
            "PATCH",
            &project,
            Body::from(r#"{"status":"planned"}"#),
            None,
        )
        .await;
    assert_eq!(reset.status, StatusCode::OK, "{}", reset.body);

    let replay = keyed
        .send(
            "PATCH",
            &project,
            Body::from(r#"{"name":"Relaunch","status":"completed"}"#),
            Some("legacy"),
        )
        .await;
    assert_eq!(replay.status, StatusCode::OK, "{}", replay.body);
    assert_eq!(
        replay.body["status"], "planned",
        "a replay runs neither step again"
    );

    let other = keyed
        .send(
            "PATCH",
            &project,
            Body::from(r#"{"name":"Relaunch","status":"cancelled"}"#),
            Some("legacy"),
        )
        .await;
    assert_eq!(other.status, StatusCode::CONFLICT, "{}", other.body);
    let current = call(&keyed.app, "GET", &project, &keyed.write, None).await;
    assert_eq!(current.body["status"], "planned");
    keyed.cleanup().await;
}

#[tokio::test]
async fn keyed_webhook_create_replay_after_delete_is_not_found() {
    let keyed = Keyed::new().await;
    let hooks = format!("{}/webhooks", keyed.base);
    let body = r#"{"name":"Hook","url":"https://hooks.example.com/gone","secret":"whsec_mine"}"#;
    let created = keyed
        .send("POST", &hooks, Body::from(body), Some("hook-gone"))
        .await;
    assert_eq!(created.status, StatusCode::CREATED, "{}", created.body);
    let deleted = keyed
        .send(
            "DELETE",
            &format!("{hooks}/{}", created.body["id"].as_str().unwrap()),
            Body::empty(),
            None,
        )
        .await;
    assert_eq!(deleted.status, StatusCode::NO_CONTENT, "{}", deleted.body);

    let replay = keyed
        .send("POST", &hooks, Body::from(body), Some("hook-gone"))
        .await;
    assert_eq!(replay.status, StatusCode::NOT_FOUND, "{}", replay.body);
    keyed.cleanup().await;
}

#[tokio::test]
async fn keyed_body_read_failures_match_unkeyed() {
    let keyed = Keyed::new().await;
    let (_, label) = keyed.label().await;
    let oversized = || Body::from(format!(r#"{{"name":"{}"}}"#, "x".repeat(7 * 1024 * 1024)));
    let failing = || {
        Body::from_stream(tokio_stream::iter([Err::<axum::body::Bytes, _>(
            std::io::Error::other("connection reset"),
        )]))
    };
    for (body, status) in [
        (oversized as fn() -> Body, StatusCode::PAYLOAD_TOO_LARGE),
        (failing as fn() -> Body, StatusCode::BAD_REQUEST),
    ] {
        let unkeyed = keyed.send("PATCH", &label, body(), None).await;
        let with_key = keyed.send("PATCH", &label, body(), Some("unread")).await;
        assert_eq!(unkeyed.status, status, "{}", unkeyed.body);
        assert_eq!(with_key.status, status, "{}", with_key.body);
        assert!(with_key.body["error"].is_string(), "{}", with_key.body);
        assert_eq!(with_key.body, unkeyed.body);
    }
    keyed.cleanup().await;
}

#[tokio::test]
async fn keyed_project_patch_replays_after_dates_move() {
    let keyed = Keyed::new().await;
    let created = call(
        &keyed.app,
        "POST",
        &format!("{}/projects", keyed.base),
        &keyed.write,
        Some(json!({"name":"Launch","team_ids":[]})),
    )
    .await;
    assert_eq!(created.status, StatusCode::CREATED, "{}", created.body);
    let project = format!(
        "{}/projects/{}",
        keyed.base,
        created.body["id"].as_str().unwrap()
    );
    let mixed = r#"{"name":"Relaunch","target_date":"2026-03-01"}"#;
    let first = keyed
        .send("PATCH", &project, Body::from(mixed), Some("dated"))
        .await;
    assert_eq!(first.status, StatusCode::OK, "{}", first.body);
    let moved = keyed
        .send(
            "PATCH",
            &project,
            Body::from(r#"{"start_date":"2026-06-01","target_date":"2026-07-01"}"#),
            None,
        )
        .await;
    assert_eq!(moved.status, StatusCode::OK, "{}", moved.body);

    let replay = keyed
        .send("PATCH", &project, Body::from(mixed), Some("dated"))
        .await;
    assert_eq!(replay.status, StatusCode::OK, "{}", replay.body);
    assert_eq!(replay.body["name"], "Relaunch");
    assert_eq!(replay.body["target_date"], "2026-07-01");
    assert_eq!(replay.body["version"], moved.body["version"]);

    let reused = keyed
        .send(
            "PATCH",
            &project,
            Body::from(r#"{"name":"Other","target_date":"2026-03-01"}"#),
            Some("dated"),
        )
        .await;
    assert_eq!(reused.status, StatusCode::CONFLICT, "{}", reused.body);
    keyed.cleanup().await;
}

#[tokio::test]
async fn keyed_issue_patch_replays_after_its_references_change() {
    let keyed = Keyed::new().await;
    let mut stages = Vec::new();
    for (name, key) in [("Platform", "PLA"), ("Operations", "OPS")] {
        let team = call(
            &keyed.app,
            "POST",
            &format!("{}/teams", keyed.base),
            &keyed.write,
            Some(json!({"name":name,"key":key})),
        )
        .await;
        assert_eq!(team.status, StatusCode::CREATED, "{}", team.body);
        stages.push(team.body["stages"][1]["id"].as_str().unwrap().to_owned());
    }
    let (_, label) = keyed.label().await;
    let created = call(
        &keyed.app,
        "POST",
        &format!("{}/issues", keyed.base),
        &keyed.write,
        Some(json!({"team":"PLA","title":"Moves"})),
    )
    .await;
    assert_eq!(created.status, StatusCode::CREATED, "{}", created.body);
    let issue = format!(
        "{}/issues/{}",
        keyed.base,
        created.body["key"].as_str().unwrap()
    );
    let patch = json!({"stage": stages[0], "labels": ["bug"]}).to_string();
    let first = keyed
        .send("PATCH", &issue, Body::from(patch.clone()), Some("refs"))
        .await;
    assert_eq!(first.status, StatusCode::OK, "{}", first.body);

    let moved = keyed
        .send(
            "PATCH",
            &issue,
            Body::from(json!({"team": "OPS", "stage": stages[1]}).to_string()),
            None,
        )
        .await;
    assert_eq!(moved.status, StatusCode::OK, "{}", moved.body);
    let deleted = keyed.send("DELETE", &label, Body::empty(), None).await;
    assert_eq!(deleted.status, StatusCode::NO_CONTENT, "{}", deleted.body);

    let replay = keyed
        .send("PATCH", &issue, Body::from(patch), Some("refs"))
        .await;
    assert_eq!(replay.status, StatusCode::OK, "{}", replay.body);
    assert_eq!(replay.body["team"]["name"], "Operations");

    let reused = keyed
        .send(
            "PATCH",
            &issue,
            Body::from(r#"{"title":"Other"}"#),
            Some("refs"),
        )
        .await;
    assert_eq!(reused.status, StatusCode::CONFLICT, "{}", reused.body);
    keyed.cleanup().await;
}

#[tokio::test]
async fn keyed_replay_after_removal_is_forbidden() {
    let keyed = Keyed::new().await;
    let member = account(&keyed.store, "member").await;
    sqlx::query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'member')")
        .bind(keyed.workspace)
        .bind(member.profile.id)
        .execute(&keyed.store.pool)
        .await
        .unwrap();
    let write = token(&keyed.app, &member, json!({"name":"CI","access":"write"})).await;
    let (_, label) = keyed.label().await;
    let key = [("Idempotency-Key", "drop-label")];
    let deleted = send(&keyed.app, "DELETE", &label, Some(&write), None, &key).await;
    assert_eq!(deleted.status, StatusCode::NO_CONTENT, "{}", deleted.body);

    let removed = call(
        &keyed.app,
        "POST",
        &format!("/internal-api/workspaces/{}/commands", keyed.workspace),
        &keyed.owner.token,
        Some(json!({"command": {"type":"remove_member","user_id":member.profile.id}})),
    )
    .await;
    assert_eq!(removed.status, StatusCode::OK, "{}", removed.body);

    let replay = send(&keyed.app, "DELETE", &label, Some(&write), None, &key).await;
    assert_eq!(replay.status, StatusCode::FORBIDDEN, "{}", replay.body);
    keyed.cleanup().await;
}

#[tokio::test]
async fn keyed_empty_issue_patch_claims_its_key() {
    let keyed = Keyed::new().await;
    let team = call(
        &keyed.app,
        "POST",
        &format!("{}/teams", keyed.base),
        &keyed.write,
        Some(json!({"name":"Platform","key":"PLA"})),
    )
    .await;
    assert_eq!(team.status, StatusCode::CREATED, "{}", team.body);
    let created = call(
        &keyed.app,
        "POST",
        &format!("{}/issues", keyed.base),
        &keyed.write,
        Some(json!({"team":"PLA","title":"Empty"})),
    )
    .await;
    assert_eq!(created.status, StatusCode::CREATED, "{}", created.body);
    let issue = format!(
        "{}/issues/{}",
        keyed.base,
        created.body["key"].as_str().unwrap()
    );

    let titled = keyed
        .send(
            "PATCH",
            &issue,
            Body::from(r#"{"title":"Full"}"#),
            Some("titled"),
        )
        .await;
    assert_eq!(titled.status, StatusCode::OK, "{}", titled.body);
    let reused = keyed
        .send("PATCH", &issue, Body::from("{}"), Some("titled"))
        .await;
    assert_eq!(reused.status, StatusCode::CONFLICT, "{}", reused.body);

    let empty = keyed
        .send("PATCH", &issue, Body::from("{}"), Some("empty"))
        .await;
    assert_eq!(empty.status, StatusCode::OK, "{}", empty.body);
    assert_eq!(empty.body["version"], titled.body["version"]);
    let replay = keyed
        .send("PATCH", &issue, Body::from("{}"), Some("empty"))
        .await;
    assert_eq!(replay.status, StatusCode::OK, "{}", replay.body);
    assert_eq!(replay.body, empty.body);
    keyed.cleanup().await;
}

/// Stored deliveries of `kind` to `hook`, oldest first. A retry sends the stored event.
async fn deliveries(store: &Store, hook: &str, kind: &str) -> Vec<Value> {
    sqlx::query_scalar(
        "SELECT payload::jsonb->'event' FROM jobs WHERE kind='webhook' \
         AND payload::jsonb->>'integration_id'=$1 AND payload::jsonb->'event'->>'type'=$2 \
         ORDER BY (payload::jsonb->'event'->>'occurred_at')::timestamptz",
    )
    .bind(hook)
    .bind(kind)
    .fetch_all(&store.pool)
    .await
    .unwrap()
}

#[tokio::test]
async fn webhook_deliveries_carry_the_changed_record() {
    let database = support::TestDatabase::new().await;
    let store = Store::connect(&database.url).await.unwrap();
    let app = router(store.clone());
    let owner = account(&store, "owner").await;
    let ws = workspace(&store, &owner, "Deliveries").await;
    let write = token(&app, &owner, json!({"name":"CI","access":"write"})).await;
    let base = format!("/api/v1/workspaces/{ws}");
    let team = call(
        &app,
        "POST",
        &format!("{base}/teams"),
        &write,
        Some(json!({"name":"Platform","key":"PLA"})),
    )
    .await;
    assert_eq!(team.status, StatusCode::CREATED, "{}", team.body);
    let hook = call(
        &app,
        "POST",
        &format!("{base}/webhooks"),
        &write,
        Some(json!({"name":"Everything","url":"https://hooks.example.com/all"})),
    )
    .await;
    assert_eq!(hook.status, StatusCode::CREATED, "{}", hook.body);
    let hook = hook.body["id"].as_str().unwrap().to_owned();

    let created = call(
        &app,
        "POST",
        &format!("{base}/issues"),
        &write,
        Some(json!({"team":"PLA","title":"Rotate certificates","description":"Steps"})),
    )
    .await;
    assert_eq!(created.status, StatusCode::CREATED, "{}", created.body);
    let issue_path = format!("{base}/issues/{}", created.body["key"].as_str().unwrap());
    let issue = call(&app, "GET", &issue_path, &write, None).await.body;
    let events = deliveries(&store, &hook, "issue.created").await;
    assert_eq!(events.len(), 1, "{events:?}");
    assert_eq!(events[0]["data"], issue);
    assert_eq!(events[0]["entity_id"], issue["id"]);
    assert!(events[0].get("truncated").is_none());

    let patched = call(
        &app,
        "PATCH",
        &issue_path,
        &write,
        Some(json!({"priority":"urgent"})),
    )
    .await;
    assert_eq!(patched.status, StatusCode::OK, "{}", patched.body);
    let urgent = call(&app, "GET", &issue_path, &write, None).await.body;
    let events = deliveries(&store, &hook, "issue.updated").await;
    assert_eq!(events.len(), 1, "{events:?}");
    assert_eq!(events[0]["fields"], json!(["priority"]));
    assert_eq!(events[0]["data"], urgent);
    let first_update = events[0]["id"].clone();

    // A later change leaves the first delivery, and so its retries, as they were.
    let renamed = call(
        &app,
        "PATCH",
        &issue_path,
        &write,
        Some(json!({"title":"Renew certificates"})),
    )
    .await;
    assert_eq!(renamed.status, StatusCode::OK, "{}", renamed.body);
    let events = deliveries(&store, &hook, "issue.updated").await;
    assert_eq!(events.len(), 2, "{events:?}");
    assert_eq!(events[0]["id"], first_update);
    assert_eq!(events[0]["data"], urgent);
    assert_eq!(events[1]["data"]["title"], "Renew certificates");

    let comment = call(
        &app,
        "POST",
        &format!("{issue_path}/comments"),
        &write,
        Some(json!({"body":"Rotated"})),
    )
    .await;
    assert_eq!(comment.status, StatusCode::CREATED, "{}", comment.body);
    let comment_path = format!("{base}/comments/{}", comment.body["id"].as_str().unwrap());
    let fetched = call(&app, "GET", &comment_path, &write, None).await.body;
    let events = deliveries(&store, &hook, "comment.created").await;
    assert_eq!(events.len(), 1, "{events:?}");
    assert_eq!(events[0]["data"], fetched);
    assert_eq!(events[0]["data"]["author"]["display_name"], "owner");

    let issue_id = Uuid::parse_str(issue["id"].as_str().unwrap()).unwrap();
    let logged = store
        .operation(
            ws,
            owner.profile.id,
            Command::LogTime {
                id: None,
                issue_id,
                minutes: 45,
                note: "Rotation".into(),
                logged_at: chrono::Utc::now(),
            },
            Default::default(),
            None,
            None,
        )
        .await
        .unwrap();
    let events = deliveries(&store, &hook, "time_entry.created").await;
    assert_eq!(events.len(), 1, "{events:?}");
    let entry = &events[0]["data"];
    assert_eq!(entry["id"], json!(logged.result.id.unwrap()));
    assert_eq!(entry["issue_id"], json!(issue_id));
    assert_eq!(entry["minutes"], 45);
    assert_eq!(entry["note"], "Rotation");
    assert_eq!(entry["user"]["id"], json!(owner.profile.id));
    assert_eq!(entry["user"]["display_name"], "owner");

    // A deleted comment is gone, so only `entity_id` names it; a deleted issue is in the trash.
    let removed = call(&app, "DELETE", &comment_path, &write, None).await;
    assert_eq!(removed.status, StatusCode::NO_CONTENT, "{}", removed.body);
    let events = deliveries(&store, &hook, "comment.deleted").await;
    assert_eq!(events.len(), 1, "{events:?}");
    assert_eq!(events[0]["entity_id"], fetched["id"]);
    assert!(events[0].get("data").is_none());
    let trashed = call(&app, "DELETE", &issue_path, &write, None).await;
    assert_eq!(trashed.status, StatusCode::NO_CONTENT, "{}", trashed.body);
    let events = deliveries(&store, &hook, "issue.deleted").await;
    assert_eq!(events.len(), 1, "{events:?}");
    assert_eq!(events[0]["data"]["id"], issue["id"]);
    assert!(events[0]["data"]["deleted_at"].is_string());

    // Long Markdown is cut to 16 KiB, and the delivery says so.
    let long = call(
        &app,
        "POST",
        &format!("{base}/issues"),
        &write,
        Some(json!({"team":"PLA","title":"Runbook","description":"x".repeat(20_000)})),
    )
    .await;
    assert_eq!(long.status, StatusCode::CREATED, "{}", long.body);
    let events = deliveries(&store, &hook, "issue.created").await;
    let event = events
        .iter()
        .find(|event| event["entity_id"] == long.body["id"])
        .unwrap();
    assert_eq!(event["data"]["description"], "x".repeat(16 * 1024));
    assert_eq!(event["truncated"], json!(["description"]));

    drop(app);
    store.pool.close().await;
    database.cleanup().await;
}

#[tokio::test]
async fn webhook_data_is_opt_in_and_dropped_once_finished() {
    let database = support::TestDatabase::new().await;
    let store = Store::connect(&database.url).await.unwrap();
    let app = router(store.clone());
    let owner = account(&store, "owner").await;
    let ws = workspace(&store, &owner, "Opt in").await;
    let write = token(&app, &owner, json!({"name":"CI","access":"write"})).await;
    let base = format!("/api/v1/workspaces/{ws}");
    let team = call(
        &app,
        "POST",
        &format!("{base}/teams"),
        &write,
        Some(json!({"name":"Platform","key":"PLA"})),
    )
    .await;
    assert_eq!(team.status, StatusCode::CREATED, "{}", team.body);
    let full = call(
        &app,
        "POST",
        &format!("{base}/webhooks"),
        &write,
        Some(json!({"name":"Full","url":"https://hooks.example.com/full"})),
    )
    .await;
    assert_eq!(full.status, StatusCode::CREATED, "{}", full.body);
    assert_eq!(full.body["include_data"], true);
    let full = full.body["id"].as_str().unwrap().to_owned();
    let ids = call(
        &app,
        "POST",
        &format!("{base}/webhooks"),
        &write,
        Some(json!({"name":"Ids","url":"https://hooks.example.com/ids","include_data":false})),
    )
    .await;
    assert_eq!(ids.status, StatusCode::CREATED, "{}", ids.body);
    assert_eq!(ids.body["include_data"], false);
    let ids = ids.body["id"].as_str().unwrap().to_owned();

    let steps = "Private steps ".repeat(2_000);
    let cut = &steps[..16 * 1024];
    let created = call(
        &app,
        "POST",
        &format!("{base}/issues"),
        &write,
        Some(json!({"team":"PLA","title":"Rotate certificates","description":steps})),
    )
    .await;
    assert_eq!(created.status, StatusCode::CREATED, "{}", created.body);
    let issue_path = format!("{base}/issues/{}", created.body["key"].as_str().unwrap());
    let events = deliveries(&store, &full, "issue.created").await;
    assert_eq!(events[0]["data"]["description"], cut);
    assert_eq!(events[0]["truncated"], json!(["description"]));
    let events = deliveries(&store, &ids, "issue.created").await;
    assert_eq!(events.len(), 1, "{events:?}");
    assert_eq!(events[0]["entity_id"], created.body["id"]);
    assert!(events[0].get("data").is_none(), "{events:?}");
    assert!(events[0].get("truncated").is_none(), "{events:?}");

    let opted = call(
        &app,
        "PATCH",
        &format!("{base}/webhooks/{ids}"),
        &write,
        Some(json!({"include_data":true})),
    )
    .await;
    assert_eq!(opted.status, StatusCode::OK, "{}", opted.body);
    assert_eq!(opted.body["include_data"], true);
    assert_eq!(opted.body["enabled"], true);
    let patched = call(
        &app,
        "PATCH",
        &issue_path,
        &write,
        Some(json!({"priority":"urgent"})),
    )
    .await;
    assert_eq!(patched.status, StatusCode::OK, "{}", patched.body);
    let mut urgent = call(&app, "GET", &issue_path, &write, None).await.body;
    urgent["description"] = json!(cut);
    let events = deliveries(&store, &ids, "issue.updated").await;
    assert_eq!(events.len(), 1, "{events:?}");
    assert_eq!(events[0]["data"], urgent);

    // A finished delivery keeps its event for debugging, without the record or what was cut
    // from it.
    let outbox = blackwall::store::Outbox::new(store.pool.clone());
    let claims = outbox.claim("webhook", 10).await.unwrap();
    assert_eq!(claims.len(), 4);
    for (n, claim) in claims.iter().enumerate() {
        if n % 2 == 0 {
            assert!(outbox.complete(claim).await.unwrap());
        } else {
            assert!(outbox.fail(claim, "receiver gone").await.unwrap());
        }
    }
    let finished: Vec<(String, Value)> =
        sqlx::query_as("SELECT state,payload->'event' FROM jobs WHERE kind='webhook'")
            .fetch_all(&store.pool)
            .await
            .unwrap();
    assert_eq!(finished.len(), 4);
    for (state, event) in &finished {
        assert!(state == "succeeded" || state == "failed", "{state}");
        assert!(event.get("data").is_none(), "{event}");
        assert!(event.get("truncated").is_none(), "{event}");
        assert_eq!(event["entity_id"], created.body["id"]);
        assert!(
            event["type"].is_string() && event["id"].is_string(),
            "{event}"
        );
    }

    drop(app);
    store.pool.close().await;
    database.cleanup().await;
}
