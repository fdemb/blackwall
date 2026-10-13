mod support;

use axum::{http::StatusCode, response::IntoResponse};
use blackwall::{
    auth::{Register, Session},
    domain::{Command, IssueInput, IssuePatch, Priority, StageKind},
    error::Error,
    store::{Store, ownership},
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
                email: format!("ownership-{}@example.com", Uuid::new_v4()),
                password: "test-password-123".into(),
                display_name: "Owner".into(),
            })
            .await
            .unwrap();
        let workspace = store
            .create_workspace("Policy".into(), owner.profile.id)
            .await
            .unwrap();
        let workspace = Uuid::parse_str(workspace["id"].as_str().unwrap()).unwrap();
        let team = store
            .operation(
                workspace,
                owner.profile.id,
                Command::CreateTeam {
                    id: None,
                    name: "Team".into(),
                    key: "TEA".into(),
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
        sqlx::query("UPDATE issues SET openproject=$2 WHERE id=$1")
            .bind(ids[0]).bind(json!({"connection_id":Uuid::new_v4(),"work_package_id":7,
                "project_id":42,"status_name":"Open","url":"https://op.example/work_packages/7","unavailable":false}))
            .execute(&store.pool).await.unwrap();
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

#[test]
fn generated_frontend_policy_is_current() {
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(include_str!(
            "../web/app/lib/ownership-policy.generated.json"
        ))
        .unwrap(),
        serde_json::from_str::<serde_json::Value>(&ownership::frontend_policy().unwrap()).unwrap()
    );
}

#[tokio::test]
async fn direct_edits_links_attachment_removal_and_relations_reject_imports() {
    let f = Fixture::new().await;
    let before = f.versions().await;
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
            attachment_id: Uuid::new_v4(),
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
    ];
    for command in commands {
        assert!(
            matches!(f.run(command).await, Err(Error::Conflict(message)) if message == ownership::OWNERSHIP_MESSAGE)
        );
        assert_eq!(f.versions().await, before);
    }
    f.run(Command::AddComment {
        id: None,
        issue_id: f.imported,
        body: "Local discussion".into(),
        mentions: vec![],
        attachments: vec![],
    })
    .await
    .unwrap();
    f.run(Command::Follow {
        issue_id: f.imported,
        following: true,
    })
    .await
    .unwrap();
    f.run(Command::LogTime {
        id: None,
        issue_id: f.imported,
        minutes: 30,
        note: "Local work".into(),
        logged_at: chrono::Utc::now(),
    })
    .await
    .unwrap();
    f.cleanup().await;
}

#[tokio::test]
async fn admin_stage_migration_moves_imported_and_local_issues_atomically() {
    let f = Fixture::new().await;
    let connection = Uuid::new_v4();
    let mappings =
        json!([{"project_id":42,"team_id":f.team,"stage_mapping":{"1":f.stage,"2":f.replacement}}]);
    let checkpoint = json!({"phase":"work_packages","page":3,"page_size":50,"project_index":0});
    sqlx::query("INSERT INTO openproject_connections(id,workspace_id,name,base_url,token,projects,checkpoint) VALUES($1,$2,'Test','https://op.example','token',$3,$4)")
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
        Err(Error::Stale(_))
    ));
    assert_eq!(f.versions().await, before);
    let projects: serde_json::Value =
        sqlx::query_scalar("SELECT projects FROM openproject_connections WHERE id=$1")
            .bind(connection)
            .fetch_one(&f.store.pool)
            .await
            .unwrap();
    assert_eq!(projects, mappings);
    let result = f.run(command).await.unwrap();
    let row = sqlx::query(
        "SELECT projects,generation,checkpoint FROM openproject_connections WHERE id=$1",
    )
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
    assert!(matches!(
        f.run(Command::MoveIssue {
            id: f.imported,
            stage_id: f.replacement,
            before_id: None
        })
        .await,
        Err(Error::Conflict(_))
    ));
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

#[tokio::test]
async fn database_ownership_guard_uses_constraint_identifier_and_narrow_migration_scope() {
    let f = Fixture::new().await;
    let error = sqlx::query("UPDATE issues SET title='Direct SQL edit' WHERE id=$1")
        .bind(f.imported)
        .execute(&f.store.pool)
        .await
        .unwrap_err();
    let database = error.as_database_error().unwrap();
    assert_eq!(database.code().as_deref(), Some("23514"));
    assert_eq!(database.constraint(), Some(ownership::OWNERSHIP_CONSTRAINT));
    assert_eq!(
        Error::Database(error).into_response().status(),
        StatusCode::CONFLICT
    );

    // Identical text on an unrelated database violation must stay an internal error.
    let unrelated = sqlx::query("DO $$ BEGIN RAISE EXCEPTION 'OpenProject imported issues are read-only' USING ERRCODE='23514',CONSTRAINT='unrelated'; END $$")
        .execute(&f.store.pool).await.unwrap_err();
    assert_eq!(
        Error::Database(unrelated).into_response().status(),
        StatusCode::INTERNAL_SERVER_ERROR
    );

    let mut tx = f.store.pool.begin().await.unwrap();
    sqlx::query("SELECT set_config('blackwall.stage_migration',$1,true)")
        .bind(json!({"workspace_id":f.workspace,"from":f.stage,"to":f.replacement}).to_string())
        .execute(&mut *tx)
        .await
        .unwrap();
    let error = sqlx::query("UPDATE issues SET stage_id=$2,title='Sneaked edit' WHERE id=$1")
        .bind(f.imported)
        .bind(f.replacement)
        .execute(&mut *tx)
        .await
        .unwrap_err();
    assert_eq!(
        error.as_database_error().unwrap().constraint(),
        Some(ownership::OWNERSHIP_CONSTRAINT)
    );
    tx.rollback().await.unwrap();

    let error = sqlx::query("INSERT INTO source_links(id,workspace_id,issue_id,url,title) VALUES($1,$2,$3,'https://example.com','Local')")
        .bind(Uuid::new_v4()).bind(f.workspace).bind(f.imported).execute(&f.store.pool).await.unwrap_err();
    assert_eq!(
        error.as_database_error().unwrap().constraint(),
        Some(ownership::OWNERSHIP_CONSTRAINT)
    );
    let source_link = Uuid::new_v4();
    let mut tx = f.store.pool.begin().await.unwrap();
    sqlx::query("SELECT set_config('blackwall.openproject_sync','on',true)")
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query("INSERT INTO source_links(id,workspace_id,issue_id,url,title) VALUES($1,$2,$3,'https://op.example/source','Remote')")
        .bind(source_link).bind(f.workspace).bind(f.imported).execute(&mut *tx).await.unwrap();
    tx.commit().await.unwrap();
    let error = sqlx::query("UPDATE source_links SET issue_id=$2 WHERE id=$1")
        .bind(source_link)
        .bind(f.local)
        .execute(&f.store.pool)
        .await
        .unwrap_err();
    assert_eq!(
        error.as_database_error().unwrap().constraint(),
        Some(ownership::OWNERSHIP_CONSTRAINT)
    );
    let local_link = Uuid::new_v4();
    sqlx::query("INSERT INTO source_links(id,workspace_id,issue_id,url,title) VALUES($1,$2,$3,'https://example.com/local','Local')")
        .bind(local_link).bind(f.workspace).bind(f.local).execute(&f.store.pool).await.unwrap();
    sqlx::query("UPDATE source_links SET title='Updated local link' WHERE id=$1")
        .bind(local_link)
        .execute(&f.store.pool)
        .await
        .unwrap();
    let error = sqlx::query("UPDATE source_links SET issue_id=$2 WHERE id=$1")
        .bind(local_link)
        .bind(f.imported)
        .execute(&f.store.pool)
        .await
        .unwrap_err();
    assert_eq!(
        error.as_database_error().unwrap().constraint(),
        Some(ownership::OWNERSHIP_CONSTRAINT)
    );
    let attachment = Uuid::new_v4();
    sqlx::query("INSERT INTO attachments(id,workspace_id,issue_id,uploader_id,filename,content_type,bytes,created_at) VALUES($1,$2,$3,$4,'local.txt','text/plain',$5,now())")
        .bind(attachment).bind(f.workspace).bind(f.imported).bind(f.owner.profile.id).bind(b"local".as_slice()).execute(&f.store.pool).await.unwrap();
    let error = sqlx::query("DELETE FROM attachments WHERE id=$1")
        .bind(attachment)
        .execute(&f.store.pool)
        .await
        .unwrap_err();
    assert_eq!(
        error.as_database_error().unwrap().constraint(),
        Some(ownership::OWNERSHIP_CONSTRAINT)
    );
    f.cleanup().await;
}
