use super::reads::{ISSUE_JSON, authorize, collection_on};
use super::*;
use crate::exchange::{ImportSummary, Transfer, TransferMember};
use serde::de::DeserializeOwned;
use serde_json::Value;

async fn records<T: DeserializeOwned>(
    conn: &mut PgConnection,
    workspace: Uuid,
    actor: Uuid,
    kind: &str,
) -> Result<Vec<T>> {
    collection_on(conn, workspace, actor, kind, None)
        .await?
        .into_iter()
        .map(|value| serde_json::from_value(value).map_err(Into::into))
        .collect()
}

impl Store {
    pub async fn export_transfer(&self, workspace: Uuid, actor: Uuid) -> Result<Transfer> {
        let mut tx = self.pool.begin().await?;
        sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
            .execute(&mut *tx)
            .await?;

        authorize(&mut tx, workspace, actor).await?;
        let members = sqlx::query("SELECT u.id,u.email FROM users u JOIN workspace_members m ON m.user_id=u.id WHERE m.workspace_id=$1 ORDER BY u.id")
            .bind(workspace)
            .fetch_all(&mut *tx)
            .await?
            .into_iter()
            .map(|row| {
                Ok(TransferMember {
                    id: row.try_get("id")?,
                    email: row.try_get("email")?,
                })
            })
            .collect::<Result<Vec<_>>>()?;

        let sql =
            format!("SELECT {ISSUE_JSON} FROM issues i WHERE i.workspace_id=$1 ORDER BY i.number");

        let mut issues: Vec<Issue> = sqlx::query_scalar::<_, Value>(&sql)
            .bind(workspace)
            .fetch_all(&mut *tx)
            .await?
            .into_iter()
            .map(serde_json::from_value)
            .collect::<std::result::Result<_, _>>()?;

        for issue in &mut issues {
            issue.attachments.clear();
            // Transfers copy issues, not server-owned connection identity or credentials.
            issue.openproject = None;
        }

        let mut comments: Vec<Comment> = records(&mut tx, workspace, actor, "comments").await?;
        for comment in &mut comments {
            comment.attachments.clear();
        }

        let result = Transfer {
            version: 1,
            members,
            teams: records(&mut tx, workspace, actor, "teams").await?,
            labels: records(&mut tx, workspace, actor, "labels").await?,
            projects: records(&mut tx, workspace, actor, "projects").await?,
            milestones: records(&mut tx, workspace, actor, "milestones").await?,
            sprints: records(&mut tx, workspace, actor, "sprints").await?,
            issues,
            comments,
            time_entries: records(&mut tx, workspace, actor, "time_entries").await?,
            views: records(&mut tx, workspace, actor, "views").await?,
            activity: records(&mut tx, workspace, actor, "activity").await?,
        };

        tx.commit().await?;

        Ok(result)
    }

    pub async fn import_transfer(
        &self,
        workspace: Uuid,
        actor: Uuid,
        transfer: Transfer,
        expected: BTreeMap<Uuid, i64>,
        key: Option<String>,
    ) -> Result<(ImportSummary, BTreeMap<Uuid, i64>)> {
        if transfer
            .issues
            .iter()
            .any(|issue| issue.openproject.is_some())
        {
            return Err(Error::BadRequest(
                "OpenProject source metadata cannot be imported through transfers".into(),
            ));
        }
        let request = serde_json::json!({
            "transfer": transfer,
            "expected_versions": expected,
        });

        let mut op = self
            .begin_operation(workspace, actor, expected, false)
            .await?;

        op.admin()?;
        op.lock_graph().await?;
        if let Some(key) = &key
            && let Some(result) = op.claim_key(key, &request).await?
        {
            return Ok(serde_json::from_value(result)?);
        }

        let (mut candidate, by_email) = member_candidate(&mut op).await?;
        let mapping: BTreeMap<Uuid, Uuid> = transfer
            .members
            .iter()
            .filter_map(|m| by_email.get(&m.email.to_lowercase()).map(|id| (m.id, *id)))
            .collect();

        let summary = transfer.import(&mut candidate, actor, &mapping, Utc::now())?;
        check_import_capacity(&mut op, &candidate).await?;
        number_issues(&mut op, &mut candidate).await?;
        insert_import(&mut op, &candidate).await?;
        let result = (summary, op.response_versions());
        if let Some(key) = &key {
            op.save_key_result(key, serde_json::to_value(&result)?)
                .await?;
        }

        op.tx.commit().await?;

        Ok(result)
    }
}

/// An empty workspace holding only the current members, which the transfer
/// is imported into and validated against, plus member ids by lowercase email.
async fn member_candidate(op: &mut Operation<'_>) -> Result<(Workspace, BTreeMap<String, Uuid>)> {
    let rows = sqlx::query("SELECT m.user_id,m.role,m.version,u.email FROM workspace_members m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=$1 ORDER BY m.user_id FOR SHARE OF m")
        .bind(op.workspace_id)
        .fetch_all(&mut *op.tx)
        .await?;

    let mut candidate = Workspace::new("Import".into(), op.actor)?;
    candidate.id = op.workspace_id;
    candidate.members.clear();
    let mut by_email = BTreeMap::new();
    for row in rows {
        let user_id = row.try_get("user_id")?;
        by_email.insert(row.try_get::<String, _>("email")?.to_lowercase(), user_id);
        candidate.members.push(Member {
            user_id,
            role: serde_json::from_value(Value::String(row.try_get("role")?))?,
            version: row.try_get("version")?,
        });
    }
    Ok((candidate, by_email))
}

/// Each table must fit what it already holds plus the incoming rows.
async fn check_import_capacity(op: &mut Operation<'_>, candidate: &Workspace) -> Result<()> {
    let capacities = [
        ("activity", candidate.activity.len(), 50000),
        ("comments", candidate.comments.len(), 20000),
        ("issues", candidate.issues.len(), 5000),
        ("labels", candidate.labels.len(), 1000),
        ("milestones", candidate.milestones.len(), 5000),
        ("projects", candidate.projects.len(), 1000),
        ("saved_views", candidate.views.len(), 5000),
        ("sprints", candidate.sprints.len(), 2000),
        ("teams", candidate.teams.len(), 200),
        ("time_entries", candidate.time_entries.len(), 20000),
    ];
    for (table, incoming, maximum) in capacities {
        if incoming > 0 {
            op.capacity(table, maximum - incoming as i64 + 1).await?;
        }
    }
    Ok(())
}

/// Reserves a block of issue numbers and assigns them in transfer order.
async fn number_issues(op: &mut Operation<'_>, candidate: &mut Workspace) -> Result<()> {
    let count = i64::try_from(candidate.issues.len())
        .map_err(|_| Error::BadRequest("too many issues".into()))?;
    let first: i64 = sqlx::query_scalar("UPDATE workspaces SET next_issue_number=next_issue_number+$2 WHERE id=$1 RETURNING next_issue_number-$2")
        .bind(op.workspace_id)
        .bind(count)
        .fetch_one(&mut *op.tx)
        .await?;
    for (index, issue) in candidate.issues.iter_mut().enumerate() {
        issue.number = (first + index as i64) as u64;
    }
    Ok(())
}

async fn insert_import(op: &mut Operation<'_>, w: &Workspace) -> Result<()> {
    insert_planning(op, w).await?;
    insert_issues(op, w).await?;
    for issue in &w.issues {
        insert_issue_relations(op, w.id, issue).await?;
        schedule_imported_reminder(op, w, issue).await?;
    }
    insert_records(op, w).await?;
    op.activity("workspace_imported", None, vec![]).await?;
    Ok(())
}

async fn insert_planning(op: &mut Operation<'_>, w: &Workspace) -> Result<()> {
    for team in &w.teams {
        sqlx::query(
            "INSERT INTO teams(id,workspace_id,name,archive_after_days,icon,color) VALUES($1,$2,$3,$4,$5,$6)",
        )
        .bind(team.id)
        .bind(w.id)
        .bind(&team.name)
        .bind(team.archive_after_days.map(i64::from))
        .bind(&team.icon)
        .bind(&team.color)
        .execute(&mut *op.tx)
        .await?;
        op.created("teams", team.id);
        for user in &team.members {
            sqlx::query("INSERT INTO team_members(workspace_id,team_id,user_id) VALUES($1,$2,$3)")
                .bind(w.id)
                .bind(team.id)
                .bind(user)
                .execute(&mut *op.tx)
                .await?;
        }

        for stage in &team.stages {
            sqlx::query("INSERT INTO stages(id,workspace_id,team_id,name,kind,position) VALUES($1,$2,$3,$4,$5,$6)")
                .bind(stage.id)
                .bind(w.id)
                .bind(team.id)
                .bind(&stage.name)
                .bind(enum_text(&stage.kind))
                .bind(stage.position)
                .execute(&mut *op.tx)
                .await?;
            op.created("stages", stage.id);
        }
    }

    for label in &w.labels {
        sqlx::query("INSERT INTO labels(id,workspace_id,name,color) VALUES($1,$2,$3,$4)")
            .bind(label.id)
            .bind(w.id)
            .bind(&label.name)
            .bind(&label.color)
            .execute(&mut *op.tx)
            .await?;
        op.created("labels", label.id);
    }

    for project in &w.projects {
        sqlx::query("INSERT INTO projects(id,workspace_id,name,description) VALUES($1,$2,$3,$4)")
            .bind(project.id)
            .bind(w.id)
            .bind(&project.name)
            .bind(&project.description)
            .execute(&mut *op.tx)
            .await?;
        op.created("projects", project.id);
        for team in &project.team_ids {
            sqlx::query(
                "INSERT INTO project_teams(workspace_id,project_id,team_id) VALUES($1,$2,$3)",
            )
            .bind(w.id)
            .bind(project.id)
            .bind(team)
            .execute(&mut *op.tx)
            .await?;
        }
    }

    for milestone in &w.milestones {
        sqlx::query("INSERT INTO milestones(id,workspace_id,project_id,name,deadline) VALUES($1,$2,$3,$4,$5)")
            .bind(milestone.id)
            .bind(w.id)
            .bind(milestone.project_id)
            .bind(&milestone.name)
            .bind(milestone.deadline)
            .execute(&mut *op.tx)
            .await?;
        op.created("milestones", milestone.id);
    }

    for sprint in &w.sprints {
        sqlx::query("INSERT INTO sprints(id,workspace_id,team_id,number,name,goal,starts_at,ends_at,state) VALUES($1,$2,$3,(SELECT COALESCE(max(number),0)+1 FROM sprints WHERE workspace_id=$2 AND team_id=$3),$4,$5,$6,$7,$8)")
            .bind(sprint.id)
            .bind(w.id)
            .bind(sprint.team_id)
            .bind(&sprint.name)
            .bind(&sprint.goal)
            .bind(sprint.starts_at)
            .bind(sprint.ends_at)
            .bind(enum_text(&sprint.state))
            .execute(&mut *op.tx)
            .await?;
        op.created("sprints", sprint.id);
        if let Some(outcome) = &sprint.outcome {
            sqlx::query("INSERT INTO sprint_outcomes(workspace_id,sprint_id,total,completed,effort) VALUES($1,$2,$3,$4,$5)")
                .bind(w.id)
                .bind(sprint.id)
                .bind(outcome.total as i64)
                .bind(outcome.completed as i64)
                .bind(outcome.effort as i64)
                .execute(&mut *op.tx)
                .await?;
        }
    }

    Ok(())
}

async fn insert_issues(op: &mut Operation<'_>, w: &Workspace) -> Result<()> {
    for issue in &w.issues {
        sqlx::query("INSERT INTO issues(id,workspace_id,number,title,description,team_id,stage_id,assignee,priority,estimate,deadline,project_id,milestone_id,sprint_id,parent_id,position,deleted_at,archived_at,done_at,created_at,updated_at,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,(SELECT id FROM users WHERE id=$22))")
            .bind(issue.id)
            .bind(w.id)
            .bind(issue.number as i64)
            .bind(&issue.title)
            .bind(&issue.description)
            .bind(issue.team_id)
            .bind(issue.stage_id)
            .bind(issue.assignee)
            .bind(enum_text(&issue.priority))
            .bind(issue.estimate.map(i64::from))
            .bind(issue.deadline)
            .bind(issue.project_id)
            .bind(issue.milestone_id)
            .bind(issue.sprint_id)
            .bind(issue.parent_id)
            .bind(issue.position)
            .bind(issue.deleted_at)
            .bind(issue.archived_at)
            .bind(issue.done_at)
            .bind(issue.created_at)
            .bind(issue.updated_at)
            // The creator may have no account on this server.
            .bind(issue.created_by)
            .execute(&mut *op.tx)
            .await?;
        op.created("issues", issue.id);
    }

    Ok(())
}

/// Labels, dependencies, followers and source links of one imported issue.
async fn insert_issue_relations(
    op: &mut Operation<'_>,
    workspace: Uuid,
    issue: &Issue,
) -> Result<()> {
    for label in &issue.labels {
        sqlx::query("INSERT INTO issue_labels(workspace_id,issue_id,label_id) VALUES($1,$2,$3)")
            .bind(workspace)
            .bind(issue.id)
            .bind(label)
            .execute(&mut *op.tx)
            .await?;
    }

    for dependency in &issue.dependencies {
        sqlx::query(
            "INSERT INTO issue_dependencies(workspace_id,issue_id,dependency_id) VALUES($1,$2,$3)",
        )
        .bind(workspace)
        .bind(issue.id)
        .bind(dependency)
        .execute(&mut *op.tx)
        .await?;
    }

    for user in &issue.followers {
        sqlx::query("INSERT INTO issue_followers(workspace_id,issue_id,user_id) VALUES($1,$2,$3)")
            .bind(workspace)
            .bind(issue.id)
            .bind(user)
            .execute(&mut *op.tx)
            .await?;
    }

    for link in &issue.source_links {
        sqlx::query(
            "INSERT INTO source_links(id,workspace_id,issue_id,url,title) VALUES($1,$2,$3,$4,$5)",
        )
        .bind(Uuid::new_v4())
        .bind(workspace)
        .bind(issue.id)
        .bind(&link.url)
        .bind(&link.title)
        .execute(&mut *op.tx)
        .await?;
    }

    Ok(())
}

/// Queues the first deadline reminder for an open imported issue with a deadline.
async fn schedule_imported_reminder(
    op: &mut Operation<'_>,
    w: &Workspace,
    issue: &Issue,
) -> Result<()> {
    let done = w.teams.iter().flat_map(|t| &t.stages).any(|s| {
        s.id == issue.stage_id && matches!(s.kind, StageKind::Done | StageKind::Cancelled)
    });

    if issue.deleted_at.is_none()
        && !done
        && let Some(deadline) = issue.deadline
    {
        let reminder = crate::jobs::Reminder {
            workspace_id: w.id,
            issue_id: issue.id,
            generation: 1,
        };

        let job = NewJob {
            id: format!("reminder:{}:{}:1", w.id, issue.id),
            job: crate::jobs::Job::Reminder(reminder),
            due_at: Some((deadline - chrono::Duration::hours(24)).timestamp()),
            max_attempts: None,
        };

        Outbox::insert(&mut op.tx, &job).await?;
    }

    Ok(())
}

/// Comments, time entries, views and activity, minus the trailing import event.
async fn insert_records(op: &mut Operation<'_>, w: &Workspace) -> Result<()> {
    for comment in &w.comments {
        sqlx::query("INSERT INTO comments(id,workspace_id,issue_id,author,body,created_at,edited_at) VALUES($1,$2,$3,$4,$5,$6,$7)")
            .bind(comment.id)
            .bind(w.id)
            .bind(comment.issue_id)
            .bind(comment.author)
            .bind(&comment.body)
            .bind(comment.created_at)
            .bind(comment.edited_at)
            .execute(&mut *op.tx)
            .await?;
        op.created("comments", comment.id);
        for user in &comment.mentions {
            sqlx::query(
                "INSERT INTO comment_mentions(workspace_id,comment_id,user_id) VALUES($1,$2,$3)",
            )
            .bind(w.id)
            .bind(comment.id)
            .bind(user)
            .execute(&mut *op.tx)
            .await?;
        }
    }

    for entry in &w.time_entries {
        sqlx::query("INSERT INTO time_entries(id,workspace_id,issue_id,user_id,minutes,note,logged_at) VALUES($1,$2,$3,$4,$5,$6,$7)")
            .bind(entry.id)
            .bind(w.id)
            .bind(entry.issue_id)
            .bind(entry.user_id)
            .bind(i64::from(entry.minutes))
            .bind(&entry.note)
            .bind(entry.logged_at)
            .execute(&mut *op.tx)
            .await?;
        op.created("time_entries", entry.id);
    }

    for view in &w.views {
        sqlx::query("INSERT INTO saved_views(id,workspace_id,owner,name,shared,filter) VALUES($1,$2,$3,$4,$5,$6)")
            .bind(view.id)
            .bind(w.id)
            .bind(view.owner)
            .bind(&view.name)
            .bind(view.shared)
            .bind(serde_json::to_value(&view.filter)?)
            .execute(&mut *op.tx)
            .await?;
        op.created("saved_views", view.id);
    }

    for event in w.activity.iter().take(w.activity.len().saturating_sub(1)) {
        sqlx::query("INSERT INTO activity(id,workspace_id,actor,action,entity_id,at,fields) VALUES($1,$2,$3,$4,$5,$6,$7)")
            .bind(event.id)
            .bind(w.id)
            .bind(event.actor)
            .bind(&event.action)
            .bind(event.entity_id)
            .bind(event.at)
            .bind(serde_json::to_value(&event.fields)?)
            .execute(&mut *op.tx)
            .await?;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use crate::test_support as support;
    use crate::{auth::Register, domain::Command, store::Store};
    use serde_json::{Value, json};
    use std::collections::BTreeMap;
    use uuid::Uuid;

    async fn create(store: &Store, ws: Uuid, user: Uuid, cmd: Value) -> Uuid {
        store
            .operation(
                ws,
                user,
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
    async fn relational_transfer_is_append_only_idempotent_and_atomic() {
        let db = support::TestDatabase::new().await;
        let store = Store::connect(&db.url).await.unwrap();
        let user = store
            .register(Register {
                email: "transfer-check@example.com".into(),
                password: "module-check-password".into(),
                display_name: "Transfer".into(),
            })
            .await
            .unwrap()
            .profile
            .id;

        let source = Uuid::parse_str(
            store.create_workspace("Source".into(), user).await.unwrap()["id"]
                .as_str()
                .unwrap(),
        )
        .unwrap();

        let target = Uuid::parse_str(
            store.create_workspace("Target".into(), user).await.unwrap()["id"]
                .as_str()
                .unwrap(),
        )
        .unwrap();

        let team = create(
            &store,
            source,
            user,
            json!({"type":"create_team","name":"Infra","members":[user]}),
        )
        .await;

        let first = create(
            &store,
            source,
            user,
            json!({
                "type": "create_issue",
                "input": {
                    "team_id": team,
                    "title": "Parent",
                    "deadline": "2030-01-01T00:00:00Z",
                },
            }),
        )
        .await;

        let second = create(
            &store,
            source,
            user,
            json!({
                "type": "create_issue",
                "input": {
                    "team_id": team,
                    "title": "Child",
                    "parent_id": first,
                    "dependencies": [first],
                },
            }),
        )
        .await;

        let mut expected = BTreeMap::from([(second, 1)]);
        store
            .operation(
                source,
                user,
                serde_json::from_value(json!({
                    "type": "add_comment",
                    "issue_id": second,
                    "body": "Imported discussion",
                    "mentions": [user],
                    "attachments": [],
                }))
                .unwrap(),
                expected.clone(),
                None,
                None,
            )
            .await
            .unwrap();

        expected.insert(second, 2);
        store
            .operation(
                source,
                user,
                serde_json::from_value(json!({
                    "type": "log_time",
                    "issue_id": second,
                    "minutes": 45,
                    "note": "Review",
                    "logged_at": "2026-10-01T00:00:00Z",
                }))
                .unwrap(),
                expected,
                None,
                None,
            )
            .await
            .unwrap();

        let existing_team = create(
            &store,
            target,
            user,
            json!({"type":"create_team","name":"Existing","members":[user]}),
        )
        .await;

        let existing = create(
            &store,
            target,
            user,
            json!({"type":"create_issue","input":{"team_id":existing_team,"title":"Existing row"}}),
        )
        .await;

        let attachment = Uuid::new_v4();
        sqlx::query("INSERT INTO attachments(id,workspace_id,issue_id,uploader_id,filename,content_type,bytes,created_at) VALUES($1,$2,$3,$4,'secret.txt','text/plain',$5,now())")
            .bind(attachment)
            .bind(source)
            .bind(first)
            .bind(user)
            .bind(b"private attachment bytes".as_slice())
            .execute(&store.pool)
            .await
            .unwrap();

        sqlx::query("INSERT INTO integrations(id,workspace_id,name,webhook_url,secret,enabled) VALUES($1,$2,'Private integration','https://example.invalid/hook','private integration secret',false)")
            .bind(Uuid::new_v4())
            .bind(source)
            .execute(&store.pool)
            .await
            .unwrap();

        sqlx::query("INSERT INTO invitations(id,workspace_id,email,role,token_hash,expires_at,state) VALUES($1,$2,'invite@example.com','member','private invitation token',now()+interval '1 day','pending')")
            .bind(Uuid::new_v4())
            .bind(source)
            .execute(&store.pool)
            .await
            .unwrap();

        let transfer = store.export_transfer(source, user).await.unwrap();
        assert!(
            transfer
                .issues
                .iter()
                .all(|issue| issue.attachments.is_empty())
        );

        let serialized = serde_json::to_string(&transfer).unwrap();
        assert!(!serialized.contains("private integration secret"));
        assert!(!serialized.contains("private invitation token"));
        assert!(!serialized.contains("private attachment bytes"));
        assert_eq!(transfer.issues.len(), 2);
        assert_eq!(transfer.comments.len(), 1);
        assert_eq!(transfer.time_entries.len(), 1);
        let result = store
            .import_transfer(
                target,
                user,
                transfer.clone(),
                BTreeMap::new(),
                Some("import-check".into()),
            )
            .await
            .unwrap();

        assert_eq!(result.0.issues, 2);
        assert!(result.1.values().all(|version| *version == 1));
        let replay = store
            .import_transfer(
                target,
                user,
                transfer.clone(),
                BTreeMap::new(),
                Some("import-check".into()),
            )
            .await
            .unwrap();

        assert_eq!(
            serde_json::to_value(&result).unwrap(),
            serde_json::to_value(&replay).unwrap()
        );

        let imported = store.export_transfer(target, user).await.unwrap();
        assert_eq!(imported.issues.len(), 3);
        assert_eq!(
            store
                .get_issue(target, user, existing)
                .await
                .unwrap()
                .version,
            1
        );

        let parent = imported
            .issues
            .iter()
            .find(|i| i.title == "Parent")
            .unwrap();

        let child = imported.issues.iter().find(|i| i.title == "Child").unwrap();
        assert_ne!(parent.id, first);
        assert_eq!(parent.number, 2);
        assert_eq!(child.number, 3);
        assert_eq!(child.parent_id, Some(parent.id));
        assert_eq!(child.dependencies, vec![parent.id]);
        assert_eq!(child.blocked_count, 1);
        assert_eq!(parent.subtask_total, 1);
        let report = store.report_sql(target, user).await.unwrap();
        assert_eq!(report["total_minutes"], 45);
        assert_eq!(report["issue_count"], 3);
        let reminder: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM jobs WHERE kind='reminder' AND payload->>'workspace_id'=$1",
        )
        .bind(target.to_string())
        .fetch_one(&store.pool)
        .await
        .unwrap();

        assert_eq!(reminder, 1);
        let mut invalid = transfer.clone();
        invalid.teams[0].stages[0].name = String::new();
        assert!(
            store
                .import_transfer(target, user, invalid, BTreeMap::new(), None)
                .await
                .is_err()
        );

        let counter: i64 =
            sqlx::query_scalar("SELECT next_issue_number FROM workspaces WHERE id=$1")
                .bind(target)
                .fetch_one(&store.pool)
                .await
                .unwrap();

        let mut invalid = transfer;
        invalid.comments[0].mentions = vec![user, user];
        assert!(
            store
                .import_transfer(
                    target,
                    user,
                    invalid,
                    BTreeMap::new(),
                    Some("rolled-back-import".into())
                )
                .await
                .is_err()
        );

        let after: i64 = sqlx::query_scalar("SELECT next_issue_number FROM workspaces WHERE id=$1")
            .bind(target)
            .fetch_one(&store.pool)
            .await
            .unwrap();

        assert_eq!(after, counter);
        let jobs_after: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM jobs WHERE kind='reminder' AND payload->>'workspace_id'=$1",
        )
        .bind(target.to_string())
        .fetch_one(&store.pool)
        .await
        .unwrap();

        assert_eq!(jobs_after, reminder);
        let keys: i64 = sqlx::query_scalar("SELECT count(*) FROM operation_keys WHERE workspace_id=$1 AND key='rolled-back-import'")
            .bind(target)
            .fetch_one(&store.pool)
            .await
            .unwrap();

        assert_eq!(keys, 0);
        assert_eq!(
            store
                .export_transfer(target, user)
                .await
                .unwrap()
                .issues
                .len(),
            3
        );

        store.pool.close().await;
        db.cleanup().await;
    }
}
