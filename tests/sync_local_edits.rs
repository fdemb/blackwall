mod support;

use blackwall::{
    auth::{Register, Session},
    domain::{Command, IssueInput, IssuePatch, Priority, StageKind},
    error::Error,
    store::Store,
};
use serde_json::json;
use sqlx::Row;
use std::collections::BTreeMap;
use uuid::Uuid;

struct Fixture {
    db: support::TestDatabase,
    store: Store,
    owner: Session,
    workspace: Uuid,
    team: Uuid,
    stage: Uuid,
    replacement: Uuid,
    imported: Uuid,
    local: Uuid,
}

impl Fixture {
    async fn new() -> Self {
        let db = support::TestDatabase::new().await;
        let store = Store::connect(&db.url).await.unwrap();
        let owner = store
            .register(Register {
                email: format!("sync-local-{}@example.com", Uuid::new_v4()),
                password: "test-password-123".into(),
                display_name: "Owner".into(),
            })
            .await
            .unwrap();
        let workspace = store
            .create_workspace("Sync".into(), owner.profile.id)
            .await
            .unwrap();
        let workspace = Uuid::parse_str(workspace["id"].as_str().unwrap()).unwrap();
        let team = store
            .operation(
                workspace,
                owner.profile.id,
                Command::CreateTeam {
                    name: "Team".into(),
                    members: vec![],
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
        let stages = sqlx::query("SELECT id FROM stages WHERE team_id=$1 ORDER BY position")
            .bind(team)
            .fetch_all(&store.pool)
            .await
            .unwrap();
        let stage = stages[0].get("id");
        let replacement = stages[1].get("id");
        let mut ids = Vec::new();
        for title in ["Imported", "Local"] {
            let input: IssueInput = serde_json::from_value(json!({
                "title": title, "team_id": team, "stage_id": stage,
            }))
            .unwrap();
            let result = store
                .operation(
                    workspace,
                    owner.profile.id,
                    Command::CreateIssue { input },
                    BTreeMap::new(),
                    None,
                    None,
                )
                .await
                .unwrap();
            ids.push(result.result.id.unwrap());
        }
        sqlx::query("UPDATE issues SET sync=$2 WHERE id=$1")
            .bind(ids[0])
            .bind(
                json!({"provider":"openproject","connection_id":Uuid::new_v4(),"remote_id":"7",
                "project_id":"42","status_name":"Open","url":"https://op.example/work_packages/7"}),
            )
            .execute(&store.pool)
            .await
            .unwrap();
        Self {
            db,
            store,
            owner,
            workspace,
            team,
            stage,
            replacement,
            imported: ids[0],
            local: ids[1],
        }
    }

    async fn versions(&self) -> BTreeMap<Uuid, i64> {
        sqlx::query("SELECT id,version FROM issues WHERE workspace_id=$1 UNION ALL SELECT id,version FROM stages WHERE workspace_id=$1")
            .bind(self.workspace).fetch_all(&self.store.pool).await.unwrap().into_iter()
            .map(|row| (row.get("id"), row.get("version"))).collect()
    }

    async fn run(
        &self,
        command: Command,
    ) -> blackwall::error::Result<blackwall::store::OperationResult> {
        self.store
            .operation(
                self.workspace,
                self.owner.profile.id,
                command,
                self.versions().await,
                None,
                None,
            )
            .await
    }

    async fn cleanup(self) {
        self.store.pool.close().await;
        self.db.cleanup().await;
    }
}

#[tokio::test]
async fn local_edits_moves_relations_links_and_attachment_removal_succeed_on_synced_issues() {
    let f = Fixture::new().await;
    let attachment = Uuid::new_v4();
    sqlx::query("INSERT INTO attachments(id,workspace_id,issue_id,uploader_id,filename,content_type,bytes,created_at) VALUES($1,$2,$3,$4,'local.txt','text/plain',$5,now())")
        .bind(attachment).bind(f.workspace).bind(f.imported).bind(f.owner.profile.id).bind(b"local".as_slice()).execute(&f.store.pool).await.unwrap();
    let commands = [
        Command::UpdateIssue {
            id: f.imported,
            patch: IssuePatch {
                title: Some("Local edit".into()),
                ..Default::default()
            },
        },
        Command::MoveIssue {
            id: f.imported,
            stage_id: f.replacement,
            before_id: None,
        },
        Command::DeleteIssue { id: f.imported },
        Command::RestoreIssue { id: f.imported },
        Command::RemoveAttachment {
            issue_id: f.imported,
            attachment_id: attachment,
        },
        Command::AddSourceLink {
            issue_id: f.imported,
            url: "https://example.com".into(),
            title: "Local".into(),
        },
        Command::UpdateIssue {
            id: f.local,
            patch: IssuePatch {
                parent_id: Some(f.imported),
                ..Default::default()
            },
        },
        Command::UpdateIssue {
            id: f.local,
            patch: IssuePatch {
                dependencies: Some(vec![f.imported]),
                ..Default::default()
            },
        },
        Command::BulkIssues {
            ids: vec![f.local, f.imported],
            action: blackwall::domain::BulkAction::Update(Box::new(IssuePatch {
                priority: Some(Priority::High),
                ..Default::default()
            })),
        },
        Command::AddComment {
            issue_id: f.imported,
            body: "Local discussion".into(),
            mentions: vec![],
            attachments: vec![],
        },
        Command::Follow {
            issue_id: f.imported,
            following: true,
        },
        Command::LogTime {
            issue_id: f.imported,
            minutes: 30,
            note: "Local work".into(),
            logged_at: chrono::Utc::now(),
        },
    ];
    for (index, command) in commands.into_iter().enumerate() {
        f.run(command)
            .await
            .unwrap_or_else(|error| panic!("command {index} failed: {error:?}"));
    }
    let row = sqlx::query("SELECT title,stage_id,priority,deleted_at IS NULL AS live,sync->>'remote_id' AS remote_id,(SELECT count(*) FROM attachments WHERE issue_id=i.id) AS attachments,(SELECT count(*) FROM source_links WHERE issue_id=i.id) AS links FROM issues i WHERE id=$1")
        .bind(f.imported).fetch_one(&f.store.pool).await.unwrap();
    assert_eq!(row.get::<String, _>("title"), "Local edit");
    assert_eq!(row.get::<Uuid, _>("stage_id"), f.replacement);
    assert_eq!(row.get::<String, _>("priority"), "high");
    assert!(row.get::<bool, _>("live"));
    // Local writes keep the link, so the issue stays synced.
    assert_eq!(row.get::<String, _>("remote_id"), "7");
    assert_eq!(row.get::<i64, _>("attachments"), 0);
    assert_eq!(row.get::<i64, _>("links"), 1);
    let local = sqlx::query("SELECT parent_id,(SELECT array_agg(dependency_id) FROM issue_dependencies WHERE issue_id=i.id) AS dependencies FROM issues i WHERE id=$1")
        .bind(f.local).fetch_one(&f.store.pool).await.unwrap();
    assert_eq!(local.get::<Option<Uuid>, _>("parent_id"), Some(f.imported));
    assert_eq!(
        local.get::<Option<Vec<Uuid>>, _>("dependencies"),
        Some(vec![f.imported])
    );
    // Direct SQL is no longer guarded by triggers.
    sqlx::query("UPDATE issues SET title='Direct SQL edit' WHERE id=$1")
        .bind(f.imported)
        .execute(&f.store.pool)
        .await
        .unwrap();
    f.cleanup().await;
}

#[tokio::test]
async fn admin_stage_migration_moves_imported_and_local_issues_atomically() {
    let f = Fixture::new().await;
    let connection = Uuid::new_v4();
    let mappings = json!([{"project_id":"42","team_id":f.team,"stage_mapping":{"1":f.stage,"2":f.replacement}}]);
    let checkpoint = json!({"phase":"work_packages","page":3,"page_size":50,"project_index":0});
    sqlx::query("INSERT INTO sync_connections(id,workspace_id,provider,name,base_url,token,options,projects,checkpoint) VALUES($1,$2,'openproject','Test','https://op.example','token','{}',$3,$4)")
        .bind(connection).bind(f.workspace).bind(&mappings).bind(&checkpoint).execute(&f.store.pool).await.unwrap();
    let before = f.versions().await;
    let mut stale = before.clone();
    stale.insert(f.local, 0);
    let command = Command::DeleteStage {
        team_id: f.team,
        id: f.stage,
        replacement: f.replacement,
    };
    let member = f
        .store
        .register(Register {
            email: format!("member-{}@example.com", Uuid::new_v4()),
            password: "test-password-123".into(),
            display_name: "Member".into(),
        })
        .await
        .unwrap();
    sqlx::query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'member')")
        .bind(f.workspace)
        .bind(member.profile.id)
        .execute(&f.store.pool)
        .await
        .unwrap();
    assert!(matches!(
        f.store
            .operation(
                f.workspace,
                member.profile.id,
                command.clone(),
                before.clone(),
                None,
                None
            )
            .await,
        Err(Error::Forbidden)
    ));
    assert_eq!(f.versions().await, before);
    assert!(matches!(
        f.store
            .operation(
                f.workspace,
                f.owner.profile.id,
                command.clone(),
                stale,
                None,
                None
            )
            .await,
        Err(Error::Conflict(_))
    ));
    assert_eq!(f.versions().await, before);
    let projects: serde_json::Value =
        sqlx::query_scalar("SELECT projects FROM sync_connections WHERE id=$1")
            .bind(connection)
            .fetch_one(&f.store.pool)
            .await
            .unwrap();
    assert_eq!(projects, mappings);
    let result = f.run(command).await.unwrap();
    let row =
        sqlx::query("SELECT projects,generation,checkpoint FROM sync_connections WHERE id=$1")
            .bind(connection)
            .fetch_one(&f.store.pool)
            .await
            .unwrap();
    let projects: serde_json::Value = row.get("projects");
    assert_eq!(projects[0]["stage_mapping"]["1"], f.replacement.to_string());
    assert_eq!(projects[0]["stage_mapping"]["2"], f.replacement.to_string());
    assert_eq!(row.get::<i64, _>("generation"), 2);
    assert_eq!(row.get::<serde_json::Value, _>("checkpoint"), checkpoint);
    for id in [f.local, f.imported] {
        let row = sqlx::query("SELECT stage_id,version FROM issues WHERE id=$1")
            .bind(id)
            .fetch_one(&f.store.pool)
            .await
            .unwrap();
        assert_eq!(row.get::<Uuid, _>("stage_id"), f.replacement);
        assert_eq!(row.get::<i64, _>("version"), before[&id] + 1);
        assert!(
            result
                .changes
                .iter()
                .any(|change| serde_json::to_value(change).unwrap()["id"] == id.to_string())
        );
    }
    f.run(Command::MoveIssue {
        id: f.imported,
        stage_id: f.replacement,
        before_id: None,
    })
    .await
    .unwrap();
    f.run(Command::UpdateStage {
        team_id: f.team,
        id: f.replacement,
        name: "Completed".into(),
        kind: StageKind::Done,
        position: 1,
    })
    .await
    .unwrap();
    f.cleanup().await;
}
