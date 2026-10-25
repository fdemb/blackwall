mod support;

use blackwall::{
    auth::Register,
    domain::{Command, FilterClause, FilterField, FilterOp, IssueFilter},
    store::Store,
};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use uuid::Uuid;

async fn op(store: &Store, ws: Uuid, actor: Uuid, cmd: Value) -> Uuid {
    store
        .operation(
            ws,
            actor,
            serde_json::from_value::<Command>(cmd).unwrap(),
            BTreeMap::new(),
            None,
            None,
        )
        .await
        .unwrap()
        .result
        .id
        .unwrap()
}

#[tokio::test]
async fn issues_remember_their_creator() {
    let database = support::TestDatabase::new().await;
    let store = Store::connect(&database.url).await.unwrap();
    let owner = store
        .register(Register {
            email: "owner@example.com".into(),
            password: "creator-test-password".into(),
            display_name: "Owner".into(),
            invitation: None,
        })
        .await
        .unwrap()
        .session()
        .unwrap()
        .profile
        .id;
    let ws = Uuid::parse_str(
        store
            .create_workspace("Creators".into(), owner)
            .await
            .unwrap()["id"]
            .as_str()
            .unwrap(),
    )
    .unwrap();
    let team = op(
        &store,
        ws,
        owner,
        json!({"type":"create_team","name":"Infra", "key": "INF","members":[owner]}),
    )
    .await;
    let issue = op(
        &store,
        ws,
        owner,
        json!({"type":"create_issue","input":{"title":"Rotate keys","team_id":team}}),
    )
    .await;

    assert_eq!(
        store.get_issue(ws, owner, issue).await.unwrap().created_by,
        Some(owner)
    );

    let by = |user: Uuid| IssueFilter {
        clauses: vec![FilterClause {
            field: FilterField::CreatedBy,
            op: FilterOp::Is,
            values: vec![Some(user.to_string())],
        }],
        ..Default::default()
    };
    let mine = store
        .list_issues(ws, owner, by(owner), 100, 0)
        .await
        .unwrap();
    assert_eq!(mine["items"].as_array().unwrap().len(), 1);
    assert_eq!(mine["items"][0]["created_by"], json!(owner));
    let nobody = store
        .list_issues(ws, owner, by(Uuid::new_v4()), 100, 0)
        .await
        .unwrap();
    assert!(nobody["items"].as_array().unwrap().is_empty());
    database.cleanup().await;
}
