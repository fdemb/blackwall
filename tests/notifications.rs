mod support;

use blackwall::{
    auth::{Register, Session},
    domain::{BulkAction, Command, IssueInput, IssuePatch, SeenNotification},
    error::Error,
    jobs::{self, Mailer},
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
                user_id: None,
                following: true,
            },
        )
        .await;
    }

    async fn read(&self, user: Uuid, notification: &Value) {
        self.run(
            user,
            Command::MarkNotificationRead {
                id: id(notification),
                created_at: Some(created_at(notification)),
            },
        )
        .await;
    }

    async fn notifications(&self, user: Uuid, issue: Uuid) -> Vec<Value> {
        self.alerts(user, issue, "change").await
    }

    async fn alerts(&self, user: Uuid, issue: Uuid, kind: &str) -> Vec<Value> {
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
                notification["issue_id"] == json!(issue) && notification["kind"] == kind
            })
            .cloned()
            .collect()
    }

    async fn followers(&self, issue: Uuid) -> Vec<Uuid> {
        sqlx::query_scalar("SELECT user_id FROM issue_followers WHERE issue_id=$1 ORDER BY user_id")
            .bind(issue)
            .fetch_all(&self.store.pool)
            .await
            .unwrap()
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
            invitation: None,
        })
        .await
        .unwrap()
        .session()
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

fn id(notification: &Value) -> Uuid {
    Uuid::parse_str(notification["id"].as_str().unwrap()).unwrap()
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

#[tokio::test]
async fn reading_a_notification_before_a_newer_change_keeps_that_change_unread() {
    let f = Fixture::new().await;
    let (owner, follower) = (f.owner.profile.id, f.follower.profile.id);
    let issue = f.create_issue("Patch the firewall", f.stages[1]).await;
    f.follow(follower, issue).await;

    f.run(owner, description_update(issue, "one")).await;
    let seen = f.notifications(follower, issue).await;
    f.run(owner, description_update(issue, "one two")).await;
    f.run(
        owner,
        Command::MoveIssue {
            id: issue,
            stage_id: f.stages[2],
            before_id: None,
        },
    )
    .await;

    f.read(follower, &seen[0]).await;

    let inbox = f.notifications(follower, issue).await;
    assert_eq!(unread(&inbox).len(), 1, "{inbox:?}");
    assert!(created_at(unread(&inbox)[0]) > created_at(&seen[0]));

    f.cleanup().await;
}

#[tokio::test]
async fn marking_all_read_covers_only_what_the_reader_saw() {
    let f = Fixture::new().await;
    let (owner, follower) = (f.owner.profile.id, f.follower.profile.id);
    let bumped = f.create_issue("Rotate keys", f.stages[1]).await;
    let untouched = f.create_issue("Audit logs", f.stages[1]).await;
    let late = f.create_issue("Renew certificates", f.stages[1]).await;
    for issue in [bumped, untouched, late] {
        f.follow(follower, issue).await;
    }

    f.run(owner, description_update(bumped, "one")).await;
    f.run(owner, description_update(untouched, "one")).await;
    let mut seen = Vec::new();
    for issue in [bumped, untouched] {
        for notification in f.notifications(follower, issue).await {
            seen.push(SeenNotification {
                id: id(&notification),
                created_at: created_at(&notification),
            });
        }
    }
    f.run(
        owner,
        Command::MoveIssue {
            id: bumped,
            stage_id: f.stages[2],
            before_id: None,
        },
    )
    .await;
    f.run(owner, description_update(late, "one")).await;

    f.run(
        follower,
        Command::MarkAllNotificationsRead {
            notifications: Some(seen),
        },
    )
    .await;

    assert_eq!(unread(&f.notifications(follower, bumped).await).len(), 1);
    assert!(unread(&f.notifications(follower, untouched).await).is_empty());
    assert_eq!(unread(&f.notifications(follower, late).await).len(), 1);

    f.cleanup().await;
}

/// A command as a client from before coalesced change notifications sends it. Its
/// serialization is the idempotency fingerprint, so it must not change either.
fn older_client_command(raw: Value) -> Command {
    let command: Command = serde_json::from_value(raw.clone()).unwrap();
    assert_eq!(serde_json::to_value(&command).unwrap(), raw);
    command
}

#[tokio::test]
async fn an_older_client_marking_one_read_still_reads_it() {
    let f = Fixture::new().await;
    let (owner, follower) = (f.owner.profile.id, f.follower.profile.id);
    let issue = f.create_issue("Patch the firewall", f.stages[1]).await;
    f.follow(follower, issue).await;
    f.run(owner, description_update(issue, "one")).await;
    let seen = f.notifications(follower, issue).await;
    f.run(owner, description_update(issue, "one two")).await;

    f.run(
        follower,
        older_client_command(json!({"type": "mark_notification_read", "id": id(&seen[0])})),
    )
    .await;

    assert!(unread(&f.notifications(follower, issue).await).is_empty());

    f.cleanup().await;
}

#[tokio::test]
async fn an_older_client_marking_all_read_reads_every_unread_notification() {
    let f = Fixture::new().await;
    let (owner, follower) = (f.owner.profile.id, f.follower.profile.id);
    let first = f.create_issue("Rotate keys", f.stages[1]).await;
    let second = f.create_issue("Audit logs", f.stages[1]).await;
    for issue in [first, second] {
        f.follow(follower, issue).await;
        f.run(owner, description_update(issue, "one")).await;
    }

    f.run(
        follower,
        older_client_command(json!({"type": "mark_all_notifications_read"})),
    )
    .await;

    assert!(unread(&f.notifications(follower, first).await).is_empty());
    assert!(unread(&f.notifications(follower, second).await).is_empty());

    f.cleanup().await;
}

/// The deadline inbox switch and the five email switches, in command order.
async fn stored_alerts(f: &Fixture, user: Uuid) -> (bool, Vec<bool>) {
    sqlx::query_as(
        "SELECT deadline,ARRAY[email_assignment,email_reply,email_change,email_mention,\
         email_deadline] FROM alert_preferences WHERE workspace_id=$1 AND user_id=$2",
    )
    .bind(f.workspace)
    .bind(user)
    .fetch_one(&f.store.pool)
    .await
    .unwrap()
}

#[tokio::test]
async fn an_older_client_configuring_alerts_keeps_the_email_choices() {
    let f = Fixture::new().await;
    let follower = f.follower.profile.id;
    let older = |deadline: bool| {
        older_client_command(json!({
            "type": "configure_alerts",
            "assignment": true,
            "reply": true,
            "change": true,
            "mention": true,
            "deadline": deadline,
        }))
    };

    f.run(follower, older(false)).await;
    assert_eq!(
        stored_alerts(&f, follower).await,
        (false, vec![true, true, false, true, true])
    );

    f.run(
        follower,
        Command::ConfigureAlerts {
            assignment: true,
            reply: true,
            change: true,
            mention: true,
            deadline: false,
            email_assignment: Some(true),
            email_reply: Some(false),
            email_change: Some(true),
            email_mention: Some(true),
            email_deadline: Some(true),
        },
    )
    .await;
    f.run(follower, older(true)).await;
    assert_eq!(
        stored_alerts(&f, follower).await,
        (true, vec![true, false, true, true, true])
    );

    f.cleanup().await;
}

fn mention(user: Uuid, label: &str) -> String {
    format!("[@{label}](mention:{user})")
}

#[tokio::test]
async fn description_mentions_alert_and_subscribe_each_newly_mentioned_member_once() {
    let f = Fixture::new().await;
    let (owner, follower) = (f.owner.profile.id, f.follower.profile.id);
    let issue = f.create_issue("Rotate certificates", f.stages[1]).await;
    let outsider = account(&f.store, "outsider").await.profile.id;

    let text = format!(
        "Ask {} and {}, not {}",
        mention(follower, "Old Name"),
        mention(owner, "me"),
        mention(outsider, "outsider"),
    );
    f.run(owner, description_update(issue, &text)).await;
    f.run(owner, description_update(issue, &format!("{text}, soon")))
        .await;

    let alerts = f.alerts(follower, issue, "mention").await;
    assert_eq!(alerts.len(), 1, "{alerts:?}");
    assert_eq!(alerts[0]["message"], "Rotate certificates");
    assert_eq!(alerts[0]["fields"], json!(["description"]));
    assert!(f.alerts(owner, issue, "mention").await.is_empty());
    let mut expected = vec![owner, follower];
    expected.sort();
    assert_eq!(f.followers(issue).await, expected);

    f.cleanup().await;
}

#[tokio::test]
async fn creating_an_issue_with_a_mention_alerts_the_member() {
    let f = Fixture::new().await;
    let follower = f.follower.profile.id;
    let input: IssueInput = serde_json::from_value(json!({
        "title": "Patch the firewall",
        "description": format!("cc {}", mention(follower, "follower")),
        "team_id": f.team,
    }))
    .unwrap();
    let issue = f
        .run(f.owner.profile.id, Command::CreateIssue { input })
        .await
        .result
        .id
        .unwrap();

    assert_eq!(f.alerts(follower, issue, "mention").await.len(), 1);
    assert!(f.followers(issue).await.contains(&follower));

    f.cleanup().await;
}

#[tokio::test]
async fn editing_a_comment_alerts_only_people_it_newly_mentions() {
    let f = Fixture::new().await;
    let (owner, follower) = (f.owner.profile.id, f.follower.profile.id);
    let issue = f.create_issue("Audit logs", f.stages[1]).await;
    let comment = f
        .run(
            owner,
            Command::AddComment {
                id: None,
                issue_id: issue,
                body: "First draft".into(),
                mentions: vec![],
                attachments: vec![],
            },
        )
        .await
        .result
        .id
        .unwrap();
    let edit = |mentions: Vec<Uuid>| Command::EditComment {
        id: comment,
        body: format!("Edited {}", mention(follower, "follower")),
        mentions,
    };

    f.run(owner, edit(vec![follower])).await;
    let mentions = f.alerts(follower, issue, "mention").await;
    assert_eq!(mentions.len(), 1);
    assert_eq!(mentions[0]["actor_id"], json!(owner));
    assert_eq!(mentions[0]["fields"], json!([]));
    assert!(f.followers(issue).await.contains(&follower));

    f.run(owner, edit(vec![follower])).await;
    f.run(owner, edit(vec![])).await;
    f.run(owner, edit(vec![follower])).await;
    assert_eq!(f.alerts(follower, issue, "mention").await.len(), 1);

    f.cleanup().await;
}

#[tokio::test]
async fn change_notifications_name_the_latest_actor_and_every_field_since_the_last_read() {
    let f = Fixture::new().await;
    let (owner, follower) = (f.owner.profile.id, f.follower.profile.id);
    let editor = account(&f.store, "editor").await.profile.id;
    sqlx::query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'member')")
        .bind(f.workspace)
        .bind(editor)
        .execute(&f.store.pool)
        .await
        .unwrap();
    let issue = f
        .create_issue("Renew the TLS certificate", f.stages[0])
        .await;
    f.follow(follower, issue).await;

    f.run(owner, description_update(issue, "Expires Friday"))
        .await;
    let first = f.notifications(follower, issue).await;
    assert_eq!(first[0]["actor_id"], json!(owner), "{first:?}");
    assert_eq!(first[0]["fields"], json!(["description"]));

    f.run(
        editor,
        Command::MoveIssue {
            id: issue,
            stage_id: f.stages[1],
            before_id: None,
        },
    )
    .await;
    let coalesced = f.notifications(follower, issue).await;
    assert_eq!(coalesced.len(), 1, "{coalesced:?}");
    assert_eq!(coalesced[0]["actor_id"], json!(editor));
    assert_eq!(coalesced[0]["fields"], json!(["description", "stage"]));

    f.read(follower, &coalesced[0]).await;
    f.run(
        owner,
        Command::UpdateIssue {
            id: issue,
            patch: IssuePatch {
                assignee: Some(follower),
                ..Default::default()
            },
        },
    )
    .await;
    let fresh = f.notifications(follower, issue).await;
    let fresh = unread(&fresh);
    assert_eq!(fresh.len(), 1, "{fresh:?}");
    assert_eq!(fresh[0]["actor_id"], json!(owner));
    assert_eq!(fresh[0]["fields"], json!(["assignee"]));

    let assignment = f.alerts(follower, issue, "assignment").await;
    assert_eq!(assignment.len(), 1, "{assignment:?}");
    assert_eq!(assignment[0]["actor_id"], json!(owner));
    assert_eq!(assignment[0]["fields"], json!([]));

    f.cleanup().await;
}

#[derive(Debug, PartialEq)]
struct Trace {
    version: i64,
    updated_at: DateTime<Utc>,
    changes: i64,
    jobs: i64,
    activity: usize,
}

async fn trace(f: &Fixture, issue: Uuid) -> Trace {
    let (version, updated_at) = sqlx::query_as("SELECT version,updated_at FROM issues WHERE id=$1")
        .bind(issue)
        .fetch_one(&f.store.pool)
        .await
        .unwrap();
    let changes = sqlx::query_scalar("SELECT count(*) FROM changes WHERE workspace_id=$1")
        .bind(f.workspace)
        .fetch_one(&f.store.pool)
        .await
        .unwrap();
    let jobs = sqlx::query_scalar("SELECT count(*) FROM jobs")
        .fetch_one(&f.store.pool)
        .await
        .unwrap();
    Trace {
        version,
        updated_at,
        changes,
        jobs,
        activity: f.activity(issue).await.len(),
    }
}

#[tokio::test]
async fn a_patch_that_changes_nothing_leaves_no_trace() {
    let f = Fixture::new().await;
    let (owner, follower) = (f.owner.profile.id, f.follower.profile.id);
    let mut labels = vec![];
    for name in ["tls", "ops"] {
        let created = f
            .run(
                owner,
                Command::CreateLabel {
                    id: None,
                    name: name.into(),
                    color: "#aabbcc".into(),
                },
            )
            .await;
        labels.push(created.result.id.unwrap());
    }
    let deadline: DateTime<Utc> = "2026-11-02T09:00:00Z".parse().unwrap();
    let issue = f.create_issue("Rotate certificates", f.stages[1]).await;
    f.follow(follower, issue).await;
    f.run(
        owner,
        Command::UpdateIssue {
            id: issue,
            patch: IssuePatch {
                description: Some("Expires Friday".into()),
                labels: Some(labels.clone()),
                deadline: Some(deadline),
                ..Default::default()
            },
        },
    )
    .await;
    f.read(follower, &f.notifications(follower, issue).await[0])
        .await;

    let before = trace(&f, issue).await;

    let mut reordered = labels.clone();
    reordered.reverse();
    reordered.push(labels[0]);
    let same = IssuePatch {
        title: Some("Rotate certificates".into()),
        description: Some("Expires Friday".into()),
        stage_id: Some(f.stages[1]),
        labels: Some(reordered),
        deadline: Some(deadline + chrono::Duration::nanoseconds(400)),
        ..Default::default()
    };
    let commands = [
        Command::UpdateIssue {
            id: issue,
            patch: same.clone(),
        },
        Command::BulkIssues {
            ids: vec![issue],
            action: BulkAction::Update(Box::new(same.clone())),
        },
    ];
    for command in commands {
        let result = f.run(owner, command).await;
        assert!(result.versions.is_empty(), "{:?}", result.versions);
        assert!(result.changes.is_empty(), "{:?}", result.changes);
    }

    assert_eq!(trace(&f, issue).await, before);
    let inbox = f.notifications(follower, issue).await;
    assert!(unread(&inbox).is_empty(), "{inbox:?}");

    let stale = f
        .store
        .operation(
            f.workspace,
            owner,
            Command::UpdateIssue {
                id: issue,
                patch: same,
            },
            BTreeMap::from([(issue, before.version - 1)]),
            None,
            None,
        )
        .await;
    assert!(matches!(stale, Err(Error::Stale(_))), "{stale:?}");

    f.cleanup().await;
}

#[tokio::test]
async fn workspace_preferences_gate_the_inbox_and_profile_alerts_do_not() {
    let f = Fixture::new().await;
    let (owner, follower) = (f.owner.profile.id, f.follower.profile.id);
    sqlx::query(
        "UPDATE users SET profile=profile||'{\"alerts\":{\"assignments\":false,\"replies\":false,\"changes\":false,\"deadlines\":false}}' WHERE id=$1",
    )
    .bind(follower)
    .execute(&f.store.pool)
    .await
    .unwrap();
    let assign = |issue| Command::UpdateIssue {
        id: issue,
        patch: IssuePatch {
            assignee: Some(follower),
            ..Default::default()
        },
    };

    let first = f.create_issue("Legacy switches", f.stages[0]).await;
    f.run(owner, assign(first)).await;
    assert_eq!(f.alerts(follower, first, "assignment").await.len(), 1);

    f.run(
        follower,
        Command::ConfigureAlerts {
            assignment: false,
            reply: true,
            change: true,
            mention: true,
            deadline: true,
            email_assignment: Some(true),
            email_reply: Some(true),
            email_change: Some(true),
            email_mention: Some(true),
            email_deadline: Some(true),
        },
    )
    .await;
    let second = f.create_issue("Workspace switch", f.stages[0]).await;
    f.run(owner, assign(second)).await;
    assert!(f.alerts(follower, second, "assignment").await.is_empty());

    f.cleanup().await;
}

impl Fixture {
    /// An unread notification for the follower, created `minutes` ago by the owner.
    async fn backdated(&self, issue: Uuid, kind: &str, minutes: f64, fields: Value) -> Uuid {
        let id = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO notifications(id,workspace_id,user_id,issue_id,kind,message,created_at,dedup_key,actor_id,fields) \
             VALUES($1,$2,$3,$4,$5,'',now()-make_interval(secs=>$6*60),'test:'||$1,$7,$8)",
        )
        .bind(id)
        .bind(self.workspace)
        .bind(self.follower.profile.id)
        .bind(issue)
        .bind(kind)
        .bind(minutes)
        .bind(self.owner.profile.id)
        .bind(fields)
        .execute(&self.store.pool)
        .await
        .unwrap();
        id
    }

    async fn digest_jobs(&self) -> Vec<String> {
        sqlx::query_scalar("SELECT state FROM jobs WHERE kind='digest' ORDER BY created_at")
            .fetch_all(&self.store.pool)
            .await
            .unwrap()
    }
}

/// The subject and body of each digest job's spooled email, oldest first.
async fn spooled(store: &Store, directory: &std::path::Path) -> Vec<(String, String)> {
    let ids: Vec<Uuid> =
        sqlx::query_scalar("SELECT id FROM jobs WHERE kind='digest' ORDER BY created_at")
            .fetch_all(&store.pool)
            .await
            .unwrap();
    let mut letters = vec![];
    for id in ids {
        let path = directory.join(format!("{}.json", blackwall::auth::hash(&id.to_string())));
        let letter: Value = serde_json::from_slice(&tokio::fs::read(path).await.unwrap()).unwrap();
        letters.push((
            letter["subject"].as_str().unwrap().to_owned(),
            letter["body"].as_str().unwrap().to_owned(),
        ));
    }
    letters
}

#[tokio::test]
async fn unread_notifications_are_emailed_once_as_a_digest_after_a_delay() {
    let f = Fixture::new().await;
    let follower = f.follower.profile.id;
    let spool = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("target")
        .join(format!("digest-spool-{}", Uuid::new_v4()));
    let mail = Mailer::Spool(spool.clone());
    let rotate = f.create_issue("Rotate certificates", f.stages[0]).await;
    let audit = f.create_issue("Audit logs", f.stages[0]).await;

    f.backdated(rotate, "assignment", 15.0, json!([])).await;
    f.backdated(audit, "change", 14.0, json!(["stage"])).await;
    let read = f.backdated(audit, "mention", 13.0, json!([])).await;
    sqlx::query("UPDATE notifications SET read_at=now() WHERE id=$1")
        .bind(read)
        .execute(&f.store.pool)
        .await
        .unwrap();
    f.backdated(rotate, "reply", 0.2, json!([])).await;

    jobs::tick(&f.store, &Mailer::Disabled).await.unwrap();
    assert!(
        f.digest_jobs().await.is_empty(),
        "disabled mail sends nothing"
    );
    let marks: i64 = sqlx::query_scalar("SELECT count(*) FROM notification_emails")
        .fetch_one(&f.store.pool)
        .await
        .unwrap();
    assert_eq!(marks, 0);

    jobs::tick(&f.store, &mail).await.unwrap();
    assert_eq!(f.digest_jobs().await, ["succeeded"]);
    let letters = spooled(&f.store, &spool).await;
    assert_eq!(letters.len(), 1, "{letters:?}");
    // Once the oldest is due, the batch takes the fresh reply along.
    assert_eq!(letters[0].0, "2 new notifications in Notifications");
    assert!(
        letters[0].1.contains(
            "\nowner assigned you TEAM-1: Rotate certificates\n\
             \nowner replied on TEAM-1: Rotate certificates\n"
        ),
        "{}",
        letters[0].1
    );
    assert!(!letters[0].1.contains("TEAM-2"), "{}", letters[0].1);

    jobs::tick(&f.store, &mail).await.unwrap();
    assert_eq!(f.digest_jobs().await.len(), 1, "the marks stop a resend");

    // A fresh notification alone isn't due yet.
    f.backdated(audit, "assignment", 5.0, json!([])).await;
    jobs::tick(&f.store, &mail).await.unwrap();
    assert_eq!(f.digest_jobs().await.len(), 1);

    f.run(
        follower,
        Command::ConfigureAlerts {
            assignment: true,
            reply: true,
            change: true,
            mention: true,
            deadline: true,
            email_assignment: Some(true),
            email_reply: Some(true),
            email_change: Some(true),
            email_mention: Some(false),
            email_deadline: Some(true),
        },
    )
    .await;
    f.backdated(rotate, "change", 11.0, json!(["assignee", "stage"]))
        .await;
    f.backdated(audit, "mention", 11.0, json!([])).await;
    jobs::tick(&f.store, &mail).await.unwrap();
    assert_eq!(f.digest_jobs().await, ["succeeded", "succeeded"]);
    let letters = spooled(&f.store, &spool).await;
    assert_eq!(letters.len(), 2, "{letters:?}");
    // The change from before the switch is still unread, and no digest covered it.
    assert_eq!(letters[1].0, "3 new notifications in Notifications");
    assert!(
        letters[1].1.contains(
            "\nowner changed status on TEAM-2: Audit logs\n\
             \nowner changed status, assignee on TEAM-1: Rotate certificates\n\
             \nowner assigned you TEAM-2: Audit logs\n"
        ),
        "{}",
        letters[1].1
    );
    for left_out in ["assigned you TEAM-1", "mentioned", "replied"] {
        assert!(!letters[1].1.contains(left_out), "{}", letters[1].1);
    }

    // A transaction that stamped its notification early and committed after both digests.
    f.backdated(rotate, "deadline", 30.0, json!([])).await;
    jobs::tick(&f.store, &mail).await.unwrap();
    let letters = spooled(&f.store, &spool).await;
    assert_eq!(letters.len(), 3, "{letters:?}");
    assert_eq!(letters[2].0, "Deadline is near for TEAM-1");

    tokio::fs::remove_dir_all(spool).await.unwrap();
    f.cleanup().await;
}

fn alerts(assignment: bool) -> Command {
    Command::ConfigureAlerts {
        assignment,
        reply: true,
        change: true,
        mention: true,
        deadline: true,
        email_assignment: Some(true),
        email_reply: Some(true),
        email_change: Some(true),
        email_mention: Some(true),
        email_deadline: Some(true),
    }
}

#[tokio::test]
async fn turning_a_kind_out_of_the_inbox_stops_its_pending_email() {
    let f = Fixture::new().await;
    let spool = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("target")
        .join(format!("digest-spool-{}", Uuid::new_v4()));
    let mail = Mailer::Spool(spool.clone());
    let issue = f.create_issue("Rotate certificates", f.stages[0]).await;

    f.backdated(issue, "assignment", 15.0, json!([])).await;
    f.backdated(issue, "reply", 15.0, json!([])).await;
    f.run(f.follower.profile.id, alerts(false)).await;
    jobs::tick(&f.store, &mail).await.unwrap();

    let letters = spooled(&f.store, &spool).await;
    assert_eq!(letters.len(), 1, "{letters:?}");
    assert!(
        letters[0].1.contains("replied on TEAM-1"),
        "{}",
        letters[0].1
    );
    assert!(!letters[0].1.contains("assigned you"), "{}", letters[0].1);

    f.run(f.follower.profile.id, alerts(true)).await;
    jobs::tick(&f.store, &mail).await.unwrap();
    let letters = spooled(&f.store, &spool).await;
    assert_eq!(letters.len(), 2, "{letters:?}");
    assert!(
        letters[1].1.contains("assigned you TEAM-1"),
        "{}",
        letters[1].1
    );

    tokio::fs::remove_dir_all(spool).await.unwrap();
    f.cleanup().await;
}

#[tokio::test]
async fn notifications_older_than_a_day_are_never_emailed() {
    let f = Fixture::new().await;
    let spool = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("target")
        .join(format!("digest-spool-{}", Uuid::new_v4()));
    let mail = Mailer::Spool(spool.clone());
    let recent = f.create_issue("Rotate certificates", f.stages[0]).await;
    let stale = f.create_issue("Audit logs", f.stages[0]).await;

    f.backdated(recent, "assignment", 24.0 * 60.0 - 1.0, json!([]))
        .await;
    f.backdated(stale, "assignment", 24.0 * 60.0 + 1.0, json!([]))
        .await;
    jobs::tick(&f.store, &mail).await.unwrap();

    let letters = spooled(&f.store, &spool).await;
    assert_eq!(letters.len(), 1, "{letters:?}");
    assert!(
        letters[0].1.contains("assigned you TEAM-1"),
        "{}",
        letters[0].1
    );
    assert!(!letters[0].1.contains("TEAM-2"), "{}", letters[0].1);

    tokio::fs::remove_dir_all(spool).await.unwrap();
    f.cleanup().await;
}
