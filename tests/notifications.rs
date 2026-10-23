mod support;

use blackwall::{
    auth::{Register, Session},
    domain::{Command, IssueInput, IssuePatch},
    store::{CollectionQuery, OperationResult, Store},
};
use chrono::{DateTime, Utc};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use uuid::Uuid;

struct Fixture {
    db: support::TestDatabase,
    store: Store,
    owner: Session,
    follower: Session,
    workspace: Uuid,
    team: Uuid,
    stages: Vec<Uuid>,
}

impl Fixture {
    async fn new() -> Self {
        let db = support::TestDatabase::new().await;
        let store = Store::connect(&db.url).await.unwrap();
        let owner = account(&store, "owner").await;
        let follower = account(&store, "follower").await;
        let workspace = store
            .create_workspace("Notifications".into(), owner.profile.id)
            .await
            .unwrap();
        let workspace = Uuid::parse_str(workspace["id"].as_str().unwrap()).unwrap();
        sqlx::query(
            "INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'member')",
        )
        .bind(workspace)
        .bind(follower.profile.id)
        .execute(&store.pool)
        .await
        .unwrap();
        let team = store
            .operation(
                workspace,
                owner.profile.id,
                Command::CreateTeam {
                    id: None,
                    name: "Team".into(),
                    key: "TEAM".into(),
                    members: vec![],
                    default_stage_ids: None,
                },
                BTreeMap::new(),
                None,
                None,
            )
            .await
            .unwrap()
            .result
            .id
            .unwrap();
        let stages = sqlx::query_scalar("SELECT id FROM stages WHERE team_id=$1 ORDER BY position")
            .bind(team)
            .fetch_all(&store.pool)
            .await
            .unwrap();
        Self {
            db,
            store,
            owner,
            follower,
            workspace,
            team,
            stages,
        }
    }

    async fn run(&self, actor: Uuid, command: Command) -> OperationResult {
        self.store
            .operation(self.workspace, actor, command, BTreeMap::new(), None, None)
            .await
            .unwrap()
    }

    async fn create_issue(&self, title: &str, stage: Uuid) -> Uuid {
        let input: IssueInput = serde_json::from_value(json!({
            "title": title,
            "team_id": self.team,
            "stage_id": stage,
        }))
        .unwrap();
        self.run(self.owner.profile.id, Command::CreateIssue { input })
            .await
            .result
            .id
            .unwrap()
    }

    async fn follow(&self, user: Uuid, issue: Uuid) {
        self.run(
            user,
            Command::Follow {
                issue_id: issue,
                following: true,
            },
        )
        .await;
    }

    async fn read(&self, user: Uuid, notification: &Value) {
        let id = Uuid::parse_str(notification["id"].as_str().unwrap()).unwrap();
        self.run(user, Command::MarkNotificationRead { id }).await;
    }

    async fn notifications(&self, user: Uuid, issue: Uuid) -> Vec<Value> {
        let page = self
            .store
            .collection(
                self.workspace,
                user,
                "notifications",
                CollectionQuery {
                    limit: 200,
                    offset: 0,
                    issue_id: None,
                    entity_id: None,
                },
            )
            .await
            .unwrap();
        page["items"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|notification| {
                notification["issue_id"] == json!(issue) && notification["kind"] == "change"
            })
            .cloned()
            .collect()
    }

    async fn activity(&self, issue: Uuid) -> Vec<Value> {
        let page = self
            .store
            .collection(
                self.workspace,
                self.owner.profile.id,
                "activity",
                CollectionQuery {
                    limit: 200,
                    offset: 0,
                    issue_id: None,
                    entity_id: Some(issue),
                },
            )
            .await
            .unwrap();
        page["items"].as_array().unwrap().clone()
    }

    async fn cleanup(self) {
        self.store.pool.close().await;
        self.db.cleanup().await;
    }
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

fn description_update(id: Uuid, text: &str) -> Command {
    Command::UpdateIssue {
        id,
        patch: IssuePatch {
            description: Some(text.into()),
            ..Default::default()
        },
    }
}

fn created_at(notification: &Value) -> DateTime<Utc> {
    notification["created_at"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap()
}

fn unread(notifications: &[Value]) -> Vec<&Value> {
    notifications
        .iter()
        .filter(|notification| notification["read_at"].is_null())
        .collect()
}

#[tokio::test]
async fn moving_between_stages_notifies_followers_but_reordering_does_not() {
    let f = Fixture::new().await;
    let (owner, follower) = (f.owner.profile.id, f.follower.profile.id);
    let moved = f.create_issue("Move me", f.stages[0]).await;
    let neighbor = f.create_issue("Stay put", f.stages[1]).await;
    f.follow(owner, moved).await;
    f.follow(follower, moved).await;

    f.run(
        owner,
        Command::MoveIssue {
            id: moved,
            stage_id: f.stages[1],
            before_id: None,
        },
    )
    .await;

    let after_move = f.notifications(follower, moved).await;
    assert_eq!(unread(&after_move).len(), 1, "{after_move:?}");
    let actor_inbox = f.notifications(owner, moved).await;
    assert!(actor_inbox.is_empty(), "{actor_inbox:?}");

    f.read(follower, &after_move[0]).await;
    f.run(
        owner,
        Command::MoveIssue {
            id: moved,
            stage_id: f.stages[1],
            before_id: Some(neighbor),
        },
    )
    .await;

    let after_reorder = f.notifications(follower, moved).await;
    assert!(unread(&after_reorder).is_empty(), "{after_reorder:?}");

    f.cleanup().await;
}

#[tokio::test]
async fn description_autosave_coalesces_notifications_and_activity() {
    let f = Fixture::new().await;
    let (owner, follower) = (f.owner.profile.id, f.follower.profile.id);
    let issue = f.create_issue("Rotate certificates", f.stages[1]).await;
    f.follow(follower, issue).await;

    f.run(owner, description_update(issue, "one")).await;
    let first = f.notifications(follower, issue).await;
    assert_eq!(first.len(), 1, "{first:?}");

    for text in ["one two", "one two three", "one two three four"] {
        f.run(owner, description_update(issue, text)).await;
    }

    let coalesced = f.notifications(follower, issue).await;
    assert_eq!(coalesced.len(), 1, "{coalesced:?}");
    assert!(coalesced[0]["read_at"].is_null());
    assert_eq!(coalesced[0]["id"], first[0]["id"]);
    assert!(created_at(&coalesced[0]) > created_at(&first[0]));

    let description_rows: Vec<_> = f
        .activity(issue)
        .await
        .into_iter()
        .filter(|entry| entry["action"] == "update_issue")
        .collect();
    assert_eq!(description_rows.len(), 1, "{description_rows:?}");
    assert_eq!(description_rows[0]["fields"], json!(["description"]));

    f.read(follower, &coalesced[0]).await;
    f.run(owner, description_update(issue, "one two three four five"))
        .await;

    let after_read = f.notifications(follower, issue).await;
    assert_eq!(after_read.len(), 2, "{after_read:?}");
    let fresh = unread(&after_read);
    assert_eq!(fresh.len(), 1, "{after_read:?}");
    assert_ne!(fresh[0]["id"], coalesced[0]["id"]);

    f.cleanup().await;
}
