mod support;

use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use blackwall::{auth::Register, http::router, store::Store};
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

/// A registered user's session and write API token.
async fn api_token(store: &Store, app: &axum::Router, name: &str) -> (Uuid, String, String) {
    let session = store
        .register(Register {
            email: format!("{name}-{}@example.com", Uuid::new_v4()),
            password: "team-admin-password".into(),
            display_name: name.into(),
            invitation: None,
        })
        .await
        .unwrap()
        .session()
        .unwrap();
    let (status, token) = call(
        app,
        "POST",
        "/internal-api/me/tokens",
        &session.token,
        Some(json!({"name":"CI","access":"write"})),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{token}");
    (
        session.profile.id,
        session.token,
        token["secret"].as_str().unwrap().to_owned(),
    )
}

struct Fixture {
    database: support::TestDatabase,
    store: Store,
    app: axum::Router,
    workspace: Uuid,
    base: String,
    owner_session: String,
    owner: String,
    member: String,
}

impl Fixture {
    async fn new() -> Self {
        let database = support::TestDatabase::new().await;
        let store = Store::connect(&database.url).await.unwrap();
        let app = router(store.clone());
        let (owner_id, owner_session, owner) = api_token(&store, &app, "owner").await;
        let (member_id, _, member) = api_token(&store, &app, "member").await;
        let created = store
            .create_workspace("Teams".into(), owner_id)
            .await
            .unwrap();
        let workspace = Uuid::parse_str(created["id"].as_str().unwrap()).unwrap();
        sqlx::query(
            "INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'member')",
        )
        .bind(workspace)
        .bind(member_id)
        .execute(&store.pool)
        .await
        .unwrap();
        Self {
            database,
            store,
            app,
            workspace,
            base: format!("/api/v1/workspaces/{workspace}"),
            owner_session,
            owner,
            member,
        }
    }

    async fn send(&self, method: &str, path: &str, body: Option<Value>) -> (StatusCode, Value) {
        self.send_as(&self.owner, method, path, body).await
    }

    async fn send_as(
        &self,
        token: &str,
        method: &str,
        path: &str,
        body: Option<Value>,
    ) -> (StatusCode, Value) {
        call(
            &self.app,
            method,
            &format!("{}/{path}", self.base),
            token,
            body,
        )
        .await
    }

    async fn team(&self, name: &str, key: &str) -> String {
        let (status, team) = self
            .send("POST", "teams", Some(json!({"name":name,"key":key})))
            .await;
        assert_eq!(status, StatusCode::CREATED, "{team}");
        team["id"].as_str().unwrap().to_owned()
    }

    async fn close(self) {
        self.store.pool.close().await;
        self.database.cleanup().await;
    }
}

#[tokio::test]
async fn renamed_and_rekeyed_teams_keep_old_issue_keys() {
    let f = Fixture::new().await;
    let eng = f.team("Engineering", "ENG").await;
    let (status, issue) = f
        .send(
            "POST",
            "issues",
            Some(json!({"title":"Old link","team":"ENG"})),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{issue}");
    assert_eq!(issue["key"], "ENG-1");

    let (status, team) = f
        .send(
            "PATCH",
            &format!("teams/{eng}"),
            Some(json!({"name":"Platform","key":"PLAT"})),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{team}");
    assert_eq!(team["name"], "Platform");
    assert_eq!(team["key"], "PLAT");
    assert_eq!(team["former_keys"], json!(["ENG"]));

    for key in ["ENG-1", "eng-1", "PLAT-1"] {
        let (status, found) = f.send("GET", &format!("issues/{key}"), None).await;
        assert_eq!(status, StatusCode::OK, "{key}: {found}");
        assert_eq!(found["id"], issue["id"], "{key}");
        assert_eq!(found["key"], "PLAT-1", "{key}");
    }
    let (_, searched) = f.send("GET", "issues?search=ENG-1", None).await;
    assert_eq!(searched["data"][0]["id"], issue["id"], "{searched}");

    let (status, renamed) = f
        .send(
            "PATCH",
            &format!("teams/{eng}"),
            Some(json!({"name":"Platform team"})),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{renamed}");
    assert_eq!(renamed["key"], "PLAT", "a rename alone keeps the key");

    let (status, back) = f
        .send("PATCH", &format!("teams/{eng}"), Some(json!({"key":"ENG"})))
        .await;
    assert_eq!(
        status,
        StatusCode::OK,
        "a team can take back its own key: {back}"
    );
    assert_eq!(back["former_keys"], json!(["PLAT"]));
    let (status, found) = f.send("GET", "issues/PLAT-1", None).await;
    assert_eq!(status, StatusCode::OK, "{found}");
    assert_eq!(found["key"], "ENG-1");

    f.close().await;
}

#[tokio::test]
async fn retired_keys_stay_reserved_for_their_team() {
    let f = Fixture::new().await;
    let eng = f.team("Engineering", "ENG").await;
    let ops = f.team("Operations", "OPS").await;
    let (status, _) = f
        .send(
            "PATCH",
            &format!("teams/{eng}"),
            Some(json!({"key":"PLAT"})),
        )
        .await;
    assert_eq!(status, StatusCode::OK);

    let (status, created) = f
        .send("POST", "teams", Some(json!({"name":"Hijack","key":"ENG"})))
        .await;
    assert_eq!(status, StatusCode::CONFLICT, "{created}");
    let (status, rekeyed) = f
        .send("PATCH", &format!("teams/{ops}"), Some(json!({"key":"ENG"})))
        .await;
    assert_eq!(status, StatusCode::CONFLICT, "{rekeyed}");
    let (status, current) = f
        .send(
            "PATCH",
            &format!("teams/{ops}"),
            Some(json!({"key":"PLAT"})),
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT, "{current}");
    let (_, unchanged) = f.send("GET", &format!("teams/{ops}"), None).await;
    assert_eq!(unchanged["key"], "OPS");
    assert_eq!(unchanged["former_keys"], json!([]));

    f.close().await;
}

#[tokio::test]
async fn teams_delete_only_when_empty_and_only_for_admins() {
    let f = Fixture::new().await;
    let eng = f.team("Engineering", "ENG").await;
    let empty = f.team("Empty", "EMP").await;
    let (status, project) = f
        .send(
            "POST",
            "projects",
            Some(json!({"name":"Shared","team_ids":[eng, empty]})),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{project}");

    for (method, body) in [("DELETE", None), ("PATCH", Some(json!({"name":"Mine"})))] {
        let (status, denied) = f
            .send_as(&f.member, method, &format!("teams/{empty}"), body)
            .await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{method}: {denied}");
    }

    let (_, issue) = f
        .send(
            "POST",
            "issues",
            Some(json!({"title":"Keeps the team","team":"ENG"})),
        )
        .await;
    let (status, refused) = f.send("DELETE", &format!("teams/{eng}"), None).await;
    assert_eq!(status, StatusCode::CONFLICT, "{refused}");
    let (status, _) = f
        .send(
            "DELETE",
            &format!("issues/{}", issue["key"].as_str().unwrap()),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (status, refused) = f.send("DELETE", &format!("teams/{eng}"), None).await;
    assert_eq!(
        status,
        StatusCode::CONFLICT,
        "a trashed issue still holds the team: {refused}"
    );

    let shipped = f.team("Shipped", "SHP").await;
    let (status, done) = f
        .send(
            "POST",
            "issues",
            Some(json!({"title":"Shipped","team":"SHP","stage":"Done"})),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{done}");
    let (status, archived) = f
        .send(
            "POST",
            &format!("issues/{}/archive", done["key"].as_str().unwrap()),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{archived}");
    let (status, refused) = f.send("DELETE", &format!("teams/{shipped}"), None).await;
    assert_eq!(
        status,
        StatusCode::CONFLICT,
        "an archived issue still holds the team: {refused}"
    );

    let (status, removed) = f.send("DELETE", &format!("teams/{empty}"), None).await;
    assert_eq!(status, StatusCode::NO_CONTENT, "{removed}");
    for path in [format!("teams/{empty}"), format!("teams/{empty}/stages")] {
        let (status, _) = f.send("GET", &path, None).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{path}");
    }
    let (_, project) = f
        .send(
            "GET",
            &format!("projects/{}", project["id"].as_str().unwrap()),
            None,
        )
        .await;
    assert_eq!(project["team_ids"], json!([eng]));
    let (status, reused) = f
        .send(
            "POST",
            "teams",
            Some(json!({"name":"Empty again","key":"EMP"})),
        )
        .await;
    assert_eq!(
        status,
        StatusCode::CREATED,
        "a deleted team's key is free: {reused}"
    );

    f.close().await;
}

#[tokio::test]
async fn tracker_mappings_hold_teams_until_disconnected() {
    let f = Fixture::new().await;
    let imported = f.team("Imported", "IMP").await;
    let gone = f.team("Gone", "GON").await;
    let connections = format!(
        "/internal-api/workspaces/{}/trackers/connections",
        f.workspace
    );
    let (status, removed) = f.send("DELETE", &format!("teams/{gone}"), None).await;
    assert_eq!(status, StatusCode::NO_CONTENT, "{removed}");
    let (status, refused) = call(
        &f.app,
        "POST",
        &connections,
        &f.owner_session,
        Some(json!({"provider":"openproject","name":"Stale","base_url":"http://127.0.0.1:3000","token":"op-token",
            "projects":[{"project_id":"42","team_id":gone}]})),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::BAD_REQUEST,
        "a deleted team takes no mapping: {refused}"
    );

    let (status, connection) = call(
        &f.app,
        "POST",
        &connections,
        &f.owner_session,
        Some(json!({"provider":"openproject","name":"OP","base_url":"http://127.0.0.1:3000","token":"op-token",
            "projects":[{"project_id":"42","team_id":imported}]})),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{connection}");
    let (status, refused) = f.send("DELETE", &format!("teams/{imported}"), None).await;
    assert_eq!(status, StatusCode::CONFLICT, "{refused}");

    let (status, _) = call(
        &f.app,
        "DELETE",
        &format!("{connections}/{}", connection["id"].as_str().unwrap()),
        &f.owner_session,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (status, removed) = f.send("DELETE", &format!("teams/{imported}"), None).await;
    assert_eq!(
        status,
        StatusCode::NO_CONTENT,
        "a disconnected tracker releases the team: {removed}"
    );

    f.close().await;
}
