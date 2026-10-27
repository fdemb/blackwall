mod support;

use blackwall::{auth::Register, domain::Command, store::Store};
use chrono::{DateTime, Duration, FixedOffset, Utc};
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

struct Fixture {
    store: Store,
    ws: Uuid,
    owner: Uuid,
    label: Uuid,
    milestone: Uuid,
    done: Uuid,
    assigned: Uuid,
    labelled: Uuid,
    bare: Uuid,
    due: DateTime<Utc>,
}

async fn fixture(database: &support::TestDatabase) -> Fixture {
    let store = Store::connect(&database.url).await.unwrap();
    let owner = store
        .register(Register {
            email: "owner@example.com".into(),
            password: "filters-test-password".into(),
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
            .create_workspace("Filters".into(), owner)
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
    let done: Uuid = sqlx::query_scalar("SELECT id FROM stages WHERE team_id=$1 AND kind='done'")
        .bind(team)
        .fetch_one(&store.pool)
        .await
        .unwrap();
    let label = op(
        &store,
        ws,
        owner,
        json!({"type":"create_label","name":"Ops","color":"#000000"}),
    )
    .await;
    let project = op(
        &store,
        ws,
        owner,
        json!({"type":"create_project","name":"Launch","team_ids":[team]}),
    )
    .await;
    let milestone = op(
        &store,
        ws,
        owner,
        json!({"type":"create_milestone","project_id":project,"name":"Beta","deadline":null}),
    )
    .await;
    let due = (Utc::now() + Duration::days(30))
        .date_naive()
        .and_hms_opt(12, 0, 0)
        .unwrap()
        .and_utc();
    let assigned = op(
        &store,
        ws,
        owner,
        json!({"type":"create_issue","input":{"title":"Assigned urgent","team_id":team,"assignee":owner,"priority":"urgent","estimate":8,"deadline":due,"project_id":project,"milestone_id":milestone}}),
    )
    .await;
    let labelled = op(
        &store,
        ws,
        owner,
        json!({"type":"create_issue","input":{"title":"Labelled done","team_id":team,"labels":[label],"priority":"high","estimate":3,"stage_id":done,"deadline":"2020-01-01T00:00:00Z"}}),
    )
    .await;
    let bare = op(
        &store,
        ws,
        owner,
        json!({"type":"create_issue","input":{"title":"Bare","team_id":team}}),
    )
    .await;
    Fixture {
        store,
        ws,
        owner,
        label,
        milestone,
        done,
        assigned,
        labelled,
        bare,
        due,
    }
}

async fn ids(f: &Fixture, clauses: Value) -> Vec<Uuid> {
    let filter = serde_json::from_value(json!({"where": clauses})).unwrap();
    let page = f
        .store
        .list_issues(f.ws, f.owner, filter, 100, 0)
        .await
        .unwrap();
    let mut ids: Vec<Uuid> = page["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| Uuid::parse_str(i["id"].as_str().unwrap()).unwrap())
        .collect();
    ids.sort();
    ids
}

fn sorted(mut ids: Vec<Uuid>) -> Vec<Uuid> {
    ids.sort();
    ids
}

#[tokio::test]
async fn sql_clauses_match_the_documented_semantics() {
    let database = support::TestDatabase::new().await;
    let f = fixture(&database).await;
    let owner = f.owner.to_string();
    let label = f.label.to_string();
    let done = f.done.to_string();
    let milestone = f.milestone.to_string();
    let all = sorted(vec![f.assigned, f.labelled, f.bare]);
    let not_assigned = sorted(vec![f.labelled, f.bare]);

    let cases: Vec<(Value, Vec<Uuid>)> = vec![
        (
            json!([{"field":"assignee","op":"is","values":[owner]}]),
            vec![f.assigned],
        ),
        (
            json!([{"field":"assignee","op":"is","values":[null]}]),
            not_assigned.clone(),
        ),
        (
            json!([{"field":"assignee","op":"is_not","values":[owner]}]),
            not_assigned.clone(),
        ),
        (
            json!([{"field":"assignee","op":"is_not","values":[null]}]),
            vec![f.assigned],
        ),
        (
            json!([{"field":"assignee","op":"is","values":[owner, null]}]),
            all.clone(),
        ),
        (
            json!([{"field":"assignee","op":"is","values":[Uuid::new_v4().to_string()]}]),
            vec![],
        ),
        (
            json!([{"field":"labels","op":"is","values":[label]}]),
            vec![f.labelled],
        ),
        (
            json!([{"field":"labels","op":"is_not","values":[label]}]),
            sorted(vec![f.assigned, f.bare]),
        ),
        (
            json!([{"field":"labels","op":"is","values":[null]}]),
            sorted(vec![f.assigned, f.bare]),
        ),
        (
            json!([{"field":"labels","op":"is_not","values":[null]}]),
            vec![f.labelled],
        ),
        (
            json!([{"field":"milestone_id","op":"is","values":[milestone]}]),
            vec![f.assigned],
        ),
        (
            json!([{"field":"milestone_id","op":"is_not","values":[milestone]}]),
            not_assigned.clone(),
        ),
        (
            json!([{"field":"milestone_id","op":"is","values":[null]}]),
            not_assigned.clone(),
        ),
        (
            json!([{"field":"milestone_id","op":"is_not","values":[null]}]),
            vec![f.assigned],
        ),
        (
            json!([{"field":"milestone","op":"is","values":[milestone, null]}]),
            all.clone(),
        ),
        (
            json!([{"field":"stage_kind","op":"is","values":["done"]}]),
            vec![f.labelled],
        ),
        (
            json!([{"field":"stage_kind","op":"is_not","values":["done","cancelled"]}]),
            sorted(vec![f.assigned, f.bare]),
        ),
        (
            json!([{"field":"stage_id","op":"is","values":[done]}]),
            vec![f.labelled],
        ),
        (
            json!([{"field":"priority","op":"is","values":["urgent","high"]}]),
            sorted(vec![f.assigned, f.labelled]),
        ),
        (
            json!([{"field":"priority","op":"gte","values":["high"]}]),
            sorted(vec![f.assigned, f.labelled]),
        ),
        (
            json!([{"field":"priority","op":"gt","values":["high"]}]),
            vec![f.assigned],
        ),
        (
            json!([{"field":"priority","op":"lt","values":["high"]}]),
            vec![f.bare],
        ),
        (
            json!([{"field":"priority","op":"is_not","values":["none"]}]),
            sorted(vec![f.assigned, f.labelled]),
        ),
        (
            json!([{"field":"estimate","op":"gte","values":["5"]}]),
            vec![f.assigned],
        ),
        (
            json!([{"field":"estimate","op":"lte","values":["3"]}]),
            vec![f.labelled],
        ),
        (
            json!([{"field":"estimate","op":"is","values":[null]}]),
            vec![f.bare],
        ),
        (
            json!([{"field":"estimate","op":"is","values":["3","8"]}]),
            sorted(vec![f.assigned, f.labelled]),
        ),
        (
            json!([{"field":"deadline","op":"is","values":[null]}]),
            vec![f.bare],
        ),
        (
            json!([{"field":"deadline","op":"lt","values":["-1d"]}]),
            vec![f.labelled],
        ),
        (
            json!([{"field":"deadline","op":"lte","values":[f.due.with_timezone(&FixedOffset::east_opt(2 * 3600).unwrap()).to_rfc3339()]}]),
            sorted(vec![f.assigned, f.labelled]),
        ),
        (
            json!([{"field":"deadline","op":"gt","values":[f.due.to_rfc3339()]}]),
            vec![],
        ),
        (
            json!([{"field":"deadline","op":"is_not","values":[null]}]),
            sorted(vec![f.assigned, f.labelled]),
        ),
        (
            json!([{"field":"created_at","op":"gte","values":["-1d"]}]),
            all.clone(),
        ),
        (
            json!([{"field":"updated_at","op":"lt","values":["-1d"]}]),
            vec![],
        ),
        (
            json!([
                {"field":"assignee","op":"is","values":[null]},
                {"field":"priority","op":"gte","values":["high"]}
            ]),
            vec![f.labelled],
        ),
        (json!([]), all.clone()),
    ];
    for (clauses, expected) in cases {
        assert_eq!(ids(&f, clauses.clone()).await, expected, "{clauses}");
    }

    let rejected = [
        (
            json!([{"field":"assignee","op":"lt","values":[owner]}]),
            "filter op lt does not apply to assignee",
        ),
        (
            json!([{"field":"team_id","op":"is","values":[null]}]),
            "filter value null does not apply to team_id",
        ),
        (
            json!([{"field":"assignee","op":"is","values":["nope"]}]),
            "filter value \"nope\" is not valid for assignee",
        ),
        (
            json!([{"field":"deadline","op":"lt","values":["+1d","+2d"]}]),
            "filter comparison takes one non-null value",
        ),
    ];
    for (clauses, message) in rejected {
        let filter = serde_json::from_value(json!({"where": clauses})).unwrap();
        let error = f
            .store
            .list_issues(f.ws, f.owner, filter, 100, 0)
            .await
            .unwrap_err();
        assert_eq!(error.to_string(), message, "{clauses}");
    }

    let view = f
        .store
        .operation(
            f.ws,
            f.owner,
            serde_json::from_value(json!({"type":"save_view","name":"Bad","shared":false,"filter":{"where":[{"field":"priority","op":"is","values":["Urgent"]}]}})).unwrap(),
            BTreeMap::new(),
            None,
            None,
        )
        .await;
    assert_eq!(
        view.unwrap_err().to_string(),
        "filter value \"Urgent\" is not valid for priority"
    );
    database.cleanup().await;
}
