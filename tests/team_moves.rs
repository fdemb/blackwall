mod support;

use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use blackwall::{auth::Register, http::router, store::Store};
use chrono::{Duration, Utc};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use tower::ServiceExt;
use uuid::Uuid;

async fn call(
    app: &axum::Router,
    method: &str,
    path: &str,
    token: &str,
    body: Option<Value>,
) -> (StatusCode, Value) {
    let mut request = Request::builder()
        .method(method)
        .uri(path)
        .header("Authorization", format!("Bearer {token}"));
    let body = match body {
        Some(body) => {
            request = request.header("Content-Type", "application/json");
            Body::from(body.to_string())
        }
        None => Body::empty(),
    };
    let response = app
        .clone()
        .oneshot(request.body(body).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

fn id(value: &Value) -> String {
    value["id"].as_str().unwrap().to_owned()
}

#[tokio::test]
async fn issues_move_between_teams_and_keep_their_old_keys() {
    let database = support::TestDatabase::new().await;
    let store = Store::connect(&database.url).await.unwrap();
    let app = router(store.clone());
    let owner = store
        .register(Register {
            email: format!("mover-{}@example.com", Uuid::new_v4()),
            password: "team-move-password".into(),
            display_name: "Mover".into(),
            invitation: None,
        })
        .await
        .unwrap()
        .session()
        .unwrap();
    let created = store
        .create_workspace("Moves".into(), owner.profile.id)
        .await
        .unwrap();
    let ws = created["id"].as_str().unwrap();
    let (status, token) = call(
        &app,
        "POST",
        "/internal-api/me/tokens",
        &owner.token,
        Some(json!({"name":"CI","access":"write"})),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{token}");
    let token = token["secret"].as_str().unwrap().to_owned();
    let base = format!("/api/v1/workspaces/{ws}");
    let post = |path: &str, body: Value| {
        let path = format!("{base}/{path}");
        let (app, token) = (&app, &token);
        async move { call(app, "POST", &path, token, Some(body)).await }
    };
    let patch = |issue: &str, body: Value| {
        let path = format!("{base}/issues/{issue}");
        let (app, token) = (&app, &token);
        async move { call(app, "PATCH", &path, token, Some(body)).await }
    };
    let get = |path: &str| {
        let path = format!("{base}/{path}");
        let (app, token) = (&app, &token);
        async move { call(app, "GET", &path, token, None).await }
    };

    let (_, alpha) = post("teams", json!({"name":"Alpha","key":"ALP"})).await;
    let (_, beta) = post("teams", json!({"name":"Beta","key":"BET"})).await;
    let (status, alpha_only) = post(
        "projects",
        json!({"name":"Alpha only","team_ids":[id(&alpha)]}),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{alpha_only}");
    let (_, shared) = post(
        "projects",
        json!({"name":"Shared","team_ids":[id(&alpha), id(&beta)]}),
    )
    .await;
    let now = Utc::now();
    let (status, sprint) = call(
        &app,
        "POST",
        &format!("/internal-api/workspaces/{ws}/commands"),
        &owner.token,
        Some(
            json!({"command": {"type":"create_sprint","id":null,"team_id":id(&alpha),
            "name":"Alpha 1","goal":"","starts_at":now,"ends_at":now + Duration::days(14)}}),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{sprint}");

    let (_, first) = post("issues", json!({"title":"Stays put","team":"ALP"})).await;
    let (status, second) = post(
        "issues",
        json!({"title":"Filed in the wrong team","team":"ALP","stage":"In progress",
            "project":"Alpha only","sprint":"Alpha 1"}),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{second}");
    assert_eq!(second["key"], "ALP-2");

    let (status, moved) = patch("ALP-2", json!({"team":"Beta"})).await;
    assert_eq!(status, StatusCode::OK, "{moved}");
    assert_eq!(moved["key"], "BET-1");
    assert_eq!(moved["former_keys"], json!(["ALP-2"]));
    assert_eq!(moved["stage"]["name"], "In progress", "same kind in Beta");
    assert_eq!(moved["stage"]["kind"], "active");
    assert_eq!(moved["sprint"], Value::Null, "sprints belong to one team");
    assert_eq!(moved["project"], Value::Null, "the project excludes Beta");

    let (status, redirected) = get("issues/ALP-2").await;
    assert_eq!(status, StatusCode::OK, "{redirected}");
    assert_eq!(redirected["id"], second["id"]);
    assert_eq!(redirected["key"], "BET-1");

    let (_, third) = post("issues", json!({"title":"Next in Alpha","team":"ALP"})).await;
    assert_eq!(
        third["key"], "ALP-3",
        "a moved issue's number is never reused"
    );

    let (status, kept) = patch(
        &id(&first),
        json!({"project":"Shared","team":"BET","stage":"Done"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{kept}");
    assert_eq!(kept["key"], "BET-2");
    assert_eq!(kept["stage"]["name"], "Done");
    assert_eq!(kept["project"]["id"], shared["id"], "Shared includes Beta");
    assert!(kept["done_at"].is_string());

    let (status, back) = patch("BET-1", json!({"team":"ALP"})).await;
    assert_eq!(status, StatusCode::OK, "{back}");
    assert_eq!(back["key"], "ALP-4");
    assert_eq!(back["former_keys"], json!(["ALP-2", "BET-1"]));
    for key in ["ALP-2", "BET-1", "ALP-4"] {
        let (status, found) = get(&format!("issues/{key}")).await;
        assert_eq!(status, StatusCode::OK, "{key}: {found}");
        assert_eq!(found["id"], second["id"], "{key}");
    }

    let (_, searched) = get("issues?search=ALP-2").await;
    let keys: Vec<&Value> = searched["data"]
        .as_array()
        .unwrap_or_else(|| panic!("{searched}"))
        .iter()
        .map(|issue| &issue["key"])
        .collect();
    assert_eq!(keys, [&json!("ALP-4")], "an old key finds the issue");

    let (_, history) = get("issues/ALP-4/activity").await;
    let fields = history["data"][0]["fields"].as_array().unwrap();
    assert!(fields.contains(&json!("team")), "{history}");

    let (status, same) = patch("ALP-4", json!({"team":"ALP"})).await;
    assert_eq!(status, StatusCode::OK, "{same}");
    assert_eq!(
        same["key"], "ALP-4",
        "naming the current team moves nothing"
    );

    let (status, wrong_stage) = patch("ALP-4", json!({"team":"BET","stage":"Alpha 1"})).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{wrong_stage}");

    let (_, purged) = post("issues", json!({"title":"Purged later","team":"ALP"})).await;
    assert_eq!(purged["key"], "ALP-5");
    patch("ALP-5", json!({"team":"BET"})).await;
    let (status, _) = call(
        &app,
        "DELETE",
        &format!("{base}/issues/ALP-5"),
        &token,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    sqlx::query("UPDATE issues SET deleted_at=now()-interval '31 days' WHERE id=$1")
        .bind(Uuid::parse_str(&id(&purged)).unwrap())
        .execute(&store.pool)
        .await
        .unwrap();
    assert_eq!(store.purge_trash().await.unwrap(), 1);
    let (status, _) = get("issues/ALP-5").await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (_, after_purge) = post("issues", json!({"title":"After purge","team":"ALP"})).await;
    assert_eq!(
        after_purge["key"], "ALP-6",
        "a purged issue's former number stays taken"
    );

    let (_, dependency) = post(
        "issues",
        json!({"title":"Shipped","team":"ALP","stage":"Done"}),
    )
    .await;
    let dependency_key = dependency["key"].as_str().unwrap().to_owned();
    let (status, blocked) = post(
        "issues",
        json!({"title":"Started on it","team":"ALP","stage":"In progress","dependencies":[dependency_key]}),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{blocked}");
    patch(&dependency_key, json!({"stage":"Todo"})).await;
    let (status, moved) = patch(blocked["key"].as_str().unwrap(), json!({"team":"BET"})).await;
    assert_eq!(
        status,
        StatusCode::OK,
        "a reopened dependency doesn't pin it: {moved}"
    );
    assert_eq!(moved["stage"]["name"], "In progress");
    let (_, waiting) = post(
        "issues",
        json!({"title":"Not started","team":"ALP","stage":"Todo","dependencies":[dependency_key]}),
    )
    .await;
    let (status, refused) = patch(
        waiting["key"].as_str().unwrap(),
        json!({"team":"BET","stage":"In progress"}),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::CONFLICT,
        "starting still waits: {refused}"
    );

    // A previous release ignores aliases, so it can number a new issue ALP-2 again.
    let (_, reused) = post(
        "issues",
        json!({"title":"Numbered by the old binary","team":"ALP"}),
    )
    .await;
    sqlx::query("UPDATE issues SET number=2 WHERE id=$1")
        .bind(Uuid::parse_str(&id(&reused)).unwrap())
        .execute(&store.pool)
        .await
        .unwrap();
    let (_, holder) = get(&format!("issues/{}", id(&second))).await;
    let (status, reused) = patch("ALP-2", json!({"team":"BET"})).await;
    assert_eq!(status, StatusCode::OK, "{reused}");
    assert_eq!(reused["former_keys"], json!(["ALP-2"]));
    let (_, loser) = get(&format!("issues/{}", id(&second))).await;
    assert_eq!(loser["former_keys"], json!(["BET-1"]));
    assert_eq!(
        loser["version"].as_i64().unwrap(),
        holder["version"].as_i64().unwrap() + 1,
        "replicas must hear that the key left the issue"
    );
    let (_, found) = get("issues/ALP-2").await;
    assert_eq!(found["id"], reused["id"]);

    drop(app);
    store.pool.close().await;
    database.cleanup().await;
}
