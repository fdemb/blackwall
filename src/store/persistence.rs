//! Canonical issue writes. Integration mapping belongs to the caller.
use super::*;
use crate::jobs::{Job, Reminder};
use std::collections::BTreeSet;

#[derive(Clone, Copy)]
pub(crate) enum Ownership<'a> {
    Local,
    Remote(&'a OpenProjectSource),
}

pub(crate) async fn create(
    conn: &mut PgConnection,
    workspace: Uuid,
    i: &mut Issue,
    ownership: Ownership<'_>,
) -> Result<()> {
    i.number = sqlx::query_scalar::<_,i64>("UPDATE workspaces SET next_issue_number=next_issue_number+1 WHERE id=$1 RETURNING next_issue_number-1")
            .bind(workspace)
            .fetch_one(&mut *conn)
            .await? as u64;
    i.position = sqlx::query_scalar("SELECT COALESCE(max(position),-1024)+1024 FROM issues WHERE workspace_id=$1 AND team_id=$2 AND stage_id=$3 AND deleted_at IS NULL")
            .bind(workspace)
            .bind(i.team_id)
            .bind(i.stage_id)
            .fetch_one(&mut *conn)
            .await?;
    insert(conn, workspace, i, ownership).await
}

pub(crate) struct CreationBatch {
    next_number: u64,
    positions: BTreeMap<Uuid, i64>,
}

impl CreationBatch {
    pub(crate) fn include(&mut self, issue: &Issue, team: Uuid) {
        if issue.team_id == team && issue.deleted_at.is_none() {
            let position = self.positions.entry(issue.stage_id).or_insert(-1024);
            *position = (*position).max(issue.position);
        }
    }
}

/// The caller holds the workspace graph lock for the entire allocation and writes.
pub(crate) async fn allocate_creations(
    conn: &mut PgConnection,
    workspace: Uuid,
    team: Uuid,
    count: i64,
) -> Result<CreationBatch> {
    let next_number: i64 = sqlx::query_scalar("UPDATE workspaces SET next_issue_number=next_issue_number+$2 WHERE id=$1 RETURNING next_issue_number-$2")
        .bind(workspace).bind(count).fetch_one(&mut *conn).await?;
    let rows = sqlx::query("SELECT stage_id,max(position) AS position FROM issues WHERE workspace_id=$1 AND team_id=$2 AND deleted_at IS NULL GROUP BY stage_id")
        .bind(workspace).bind(team).fetch_all(&mut *conn).await?;
    let mut positions = BTreeMap::new();
    for row in rows {
        positions.insert(row.try_get("stage_id")?, row.try_get("position")?);
    }
    Ok(CreationBatch {
        next_number: next_number as u64,
        positions,
    })
}

pub(crate) async fn create_allocated(
    conn: &mut PgConnection,
    workspace: Uuid,
    issue: &mut Issue,
    source: &OpenProjectSource,
    allocation: &mut CreationBatch,
) -> Result<()> {
    issue.number = allocation.next_number;
    allocation.next_number += 1;
    let position = allocation.positions.entry(issue.stage_id).or_insert(-1024);
    *position = position
        .checked_add(1024)
        .ok_or_else(|| Error::Conflict("issue position exhausted".into()))?;
    issue.position = *position;
    insert(conn, workspace, issue, Ownership::Remote(source)).await
}

fn source_value(i: &Issue, ownership: Ownership<'_>) -> Result<Option<serde_json::Value>> {
    match ownership {
        Ownership::Local if i.openproject.is_some() => Err(Error::Conflict(
            "OpenProject imported issues are read-only".into(),
        )),
        Ownership::Local => Ok(None),
        Ownership::Remote(source) => Ok(Some(serde_json::to_value(source)?)),
    }
}

async fn insert(
    conn: &mut PgConnection,
    workspace: Uuid,
    i: &Issue,
    ownership: Ownership<'_>,
) -> Result<()> {
    let source = source_value(i, ownership)?;
    sqlx::query("INSERT INTO issues(id,workspace_id,number,title,description,team_id,stage_id,assignee,priority,estimate,deadline,project_id,milestone_id,sprint_id,parent_id,position,archived_at,done_at,created_at,updated_at,openproject,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$19,$20,$21)")
            .bind(i.id)
            .bind(workspace)
            .bind(i.number as i64)
            .bind(&i.title)
            .bind(&i.description)
            .bind(i.team_id)
            .bind(i.stage_id)
            .bind(i.assignee)
            .bind(enum_text(&i.priority))
            .bind(i.estimate.map(i64::from))
            .bind(i.deadline)
            .bind(i.project_id)
            .bind(i.milestone_id)
            .bind(i.sprint_id)
            .bind(i.parent_id)
            .bind(i.position)
            .bind(i.archived_at)
            .bind(i.done_at)
            .bind(i.created_at)
            .bind(source)
            .bind(i.created_by)
            .execute(&mut *conn)
            .await?;
    if matches!(ownership, Ownership::Local) {
        save_relations(conn, workspace, i).await?;
    }

    Ok(())
}

pub(crate) async fn save(
    conn: &mut PgConnection,
    workspace: Uuid,
    i: &Issue,
    ownership: Ownership<'_>,
) -> Result<()> {
    save_fields(
        conn,
        workspace,
        i,
        ownership,
        matches!(ownership, Ownership::Remote(_)),
    )
    .await
}

async fn save_fields(
    conn: &mut PgConnection,
    workspace: Uuid,
    i: &Issue,
    ownership: Ownership<'_>,
    increment_version: bool,
) -> Result<()> {
    let source = source_value(i, ownership)?;
    // Only OpenProject reassigns the creator, when its author or the people mapping changes.
    let remote = matches!(ownership, Ownership::Remote(_));
    sqlx::query("UPDATE issues SET title=$3,description=$4,team_id=$16,stage_id=$5,assignee=$6,priority=$7,estimate=$8,deadline=$9,project_id=$10,milestone_id=$11,sprint_id=$12,parent_id=$13,position=$14,deleted_at=$15,updated_at=now(),openproject=$17,archived_at=$18,done_at=$19,version=version+CASE WHEN $20 THEN 1 ELSE 0 END,created_by=CASE WHEN $21 THEN $22 ELSE created_by END WHERE workspace_id=$1 AND id=$2")
            .bind(workspace)
            .bind(i.id)
            .bind(&i.title)
            .bind(&i.description)
            .bind(i.stage_id)
            .bind(i.assignee)
            .bind(enum_text(&i.priority))
            .bind(i.estimate.map(i64::from))
            .bind(i.deadline)
            .bind(i.project_id)
            .bind(i.milestone_id)
            .bind(i.sprint_id)
            .bind(i.parent_id)
            .bind(i.position)
            .bind(i.deleted_at)
            .bind(i.team_id)
            .bind(source)
            .bind(i.archived_at)
            .bind(i.done_at)
            .bind(increment_version)
            .bind(remote)
            .bind(i.created_by)
            .execute(&mut *conn)
            .await?;

    if remote {
        return Ok(());
    }

    save_relations(conn, workspace, i).await
}

async fn save_relations(conn: &mut PgConnection, workspace: Uuid, i: &Issue) -> Result<()> {
    sqlx::query("DELETE FROM issue_labels WHERE issue_id=$1")
        .bind(i.id)
        .execute(&mut *conn)
        .await?;

    for label in i.labels.iter().copied().collect::<BTreeSet<_>>() {
        sqlx::query("INSERT INTO issue_labels(workspace_id,issue_id,label_id) VALUES($1,$2,$3)")
            .bind(workspace)
            .bind(i.id)
            .bind(label)
            .execute(&mut *conn)
            .await?;
    }

    sqlx::query("DELETE FROM issue_dependencies WHERE issue_id=$1")
        .bind(i.id)
        .execute(&mut *conn)
        .await?;
    for dep in i.dependencies.iter().copied().collect::<BTreeSet<_>>() {
        sqlx::query(
            "INSERT INTO issue_dependencies(workspace_id,issue_id,dependency_id) VALUES($1,$2,$3)",
        )
        .bind(workspace)
        .bind(i.id)
        .bind(dep)
        .execute(&mut *conn)
        .await?;
    }

    Ok(())
}

pub(crate) async fn schedule_reminder(
    conn: &mut PgConnection,
    workspace: Uuid,
    id: Uuid,
) -> Result<()> {
    schedule_reminder_with_stage(conn, workspace, id, None).await
}

async fn schedule_reminder_with_stage(
    conn: &mut PgConnection,
    workspace: Uuid,
    id: Uuid,
    completed: Option<bool>,
) -> Result<()> {
    let row = sqlx::query("UPDATE issues SET reminder_generation=reminder_generation+1 WHERE workspace_id=$1 AND id=$2 RETURNING deadline,reminder_generation,stage_id,deleted_at")
            .bind(workspace)
            .bind(id)
            .fetch_one(&mut *conn)
            .await?;

    let deadline: Option<DateTime<Utc>> = row.try_get("deadline")?;
    let generation: i64 = row.try_get("reminder_generation")?;
    let stage: Uuid = row.try_get("stage_id")?;
    let done = match completed {
        Some(done) => done,
        None => stage_completed(conn, stage, None).await?,
    };

    if let Some(deadline) = deadline
        && !done
        && row
            .try_get::<Option<DateTime<Utc>>, _>("deleted_at")?
            .is_none()
    {
        Outbox::insert(
            conn,
            &NewJob {
                id: format!("reminder:{id}:{generation}"),
                job: Job::Reminder(Reminder {
                    workspace_id: workspace,
                    issue_id: id,
                    generation,
                }),
                due_at: (deadline - chrono::Duration::hours(24)).timestamp(),
                max_attempts: None,
            },
        )
        .await?;
    }

    Ok(())
}

async fn stage_completed(
    conn: &mut PgConnection,
    stage: Uuid,
    stages: Option<&BTreeMap<Uuid, String>>,
) -> Result<bool> {
    if let Some(stages) = stages {
        let kind = stages.get(&stage).ok_or(Error::NotFound)?;
        return Ok(matches!(kind.as_str(), "done" | "cancelled"));
    }
    Ok(
        sqlx::query_scalar("SELECT kind IN ('done','cancelled') FROM stages WHERE id=$1")
            .bind(stage)
            .fetch_one(conn)
            .await?,
    )
}

async fn became_completed_with_stages(
    conn: &mut PgConnection,
    before: Option<&Issue>,
    after: &Issue,
    stages: Option<&BTreeMap<Uuid, String>>,
) -> Result<bool> {
    if after.deleted_at.is_some() {
        return Ok(false);
    }
    let done = stage_completed(conn, after.stage_id, stages).await?;
    let was_done = if let Some(i) = before {
        i.deleted_at.is_none() && stage_completed(conn, i.stage_id, stages).await?
    } else {
        false
    };
    Ok(done && !was_done)
}

/// The action determines which effects a caller explicitly requests.
pub(crate) enum IssueEffects {
    Create,
    Update,
    Move,
    DeleteRestore,
    Remote(Vec<String>),
}

pub(crate) async fn issue_effects(
    conn: &mut PgConnection,
    workspace: Uuid,
    actor: Uuid,
    before: Option<&Issue>,
    after: &Issue,
    effects: IssueEffects,
) -> Result<()> {
    issue_effects_with_context(conn, workspace, actor, before, after, effects, None).await
}

struct Integration {
    id: Uuid,
    url: String,
}

pub(crate) struct PageEffects {
    actor: Uuid,
    integrations: Vec<Integration>,
    stages: BTreeMap<Uuid, String>,
}

impl PageEffects {
    pub(crate) async fn load(
        conn: &mut PgConnection,
        workspace: Uuid,
        stages: BTreeMap<Uuid, String>,
    ) -> Result<Self> {
        let actor = sqlx::query_scalar("SELECT user_id FROM workspace_members WHERE workspace_id=$1 AND role='owner' ORDER BY user_id LIMIT 1")
            .bind(workspace).fetch_one(&mut *conn).await?;
        Ok(Self {
            actor,
            integrations: integrations(conn, workspace).await?,
            stages,
        })
    }

    pub(crate) async fn apply(
        &self,
        conn: &mut PgConnection,
        workspace: Uuid,
        before: Option<&Issue>,
        after: &Issue,
        fields: Vec<String>,
    ) -> Result<()> {
        issue_effects_with_context(
            conn,
            workspace,
            self.actor,
            before,
            after,
            IssueEffects::Remote(fields),
            Some(self),
        )
        .await
    }
}

async fn issue_effects_with_context(
    conn: &mut PgConnection,
    workspace: Uuid,
    actor: Uuid,
    before: Option<&Issue>,
    after: &Issue,
    effects: IssueEffects,
    context: Option<&PageEffects>,
) -> Result<()> {
    if affects_reminder(before, after) {
        let completed = match context {
            Some(context) => {
                Some(stage_completed(conn, after.stage_id, Some(&context.stages)).await?)
            }
            None => None,
        };
        schedule_reminder_with_stage(conn, workspace, after.id, completed).await?;
    }

    let remote = matches!(effects, IssueEffects::Remote(_));
    if let IssueEffects::Remote(fields) = &effects {
        activity_with_integrations(
            conn,
            workspace,
            actor,
            if before.is_some() {
                "update_issue"
            } else {
                "create_issue"
            },
            Some(after.id),
            fields.clone(),
            context.map(|context| context.integrations.as_slice()),
        )
        .await?;
    }

    if matches!(effects, IssueEffects::Create | IssueEffects::Update) {
        notify_new_assignee(conn, workspace, actor, before, after).await?;
    }

    if matches!(effects, IssueEffects::Update) || (remote && before.is_some()) {
        notify_changes(conn, workspace, actor, after, remote).await?;
    }

    if !matches!(effects, IssueEffects::DeleteRestore)
        && became_completed_with_stages(conn, before, after, context.map(|context| &context.stages))
            .await?
    {
        activity_with_integrations(
            conn,
            workspace,
            actor,
            "issue_completed",
            Some(after.id),
            vec![],
            context.map(|context| context.integrations.as_slice()),
        )
        .await?;
    }
    Ok(())
}

/// The deadline reminder depends on the deadline, stage, assignee and trash state.
fn affects_reminder(before: Option<&Issue>, after: &Issue) -> bool {
    before.is_none_or(|old| {
        old.deadline != after.deadline
            || old.stage_id != after.stage_id
            || old.assignee != after.assignee
            || old.deleted_at != after.deleted_at
    })
}

/// Alerts a newly assigned user, unless they assigned themselves.
async fn notify_new_assignee(
    conn: &mut PgConnection,
    workspace: Uuid,
    actor: Uuid,
    before: Option<&Issue>,
    after: &Issue,
) -> Result<()> {
    if before.is_some_and(|old| old.assignee == after.assignee) {
        return Ok(());
    }
    let Some(user) = after.assignee.filter(|user| *user != actor) else {
        return Ok(());
    };
    notify(
        conn,
        workspace,
        user,
        Some(after.id),
        AlertKind::Assignment,
        after.title.clone(),
        format!("assignment:{}:{}", after.id, Uuid::new_v4()),
    )
    .await
}

pub(crate) async fn activity(
    conn: &mut PgConnection,
    workspace: Uuid,
    actor: Uuid,
    action: &str,
    issue: Option<Uuid>,
    fields: Vec<String>,
) -> Result<()> {
    activity_with_integrations(conn, workspace, actor, action, issue, fields, None).await
}

async fn integrations(conn: &mut PgConnection, workspace: Uuid) -> Result<Vec<Integration>> {
    let rows =
        sqlx::query("SELECT id,webhook_url FROM integrations WHERE workspace_id=$1 AND enabled")
            .bind(workspace)
            .fetch_all(conn)
            .await?;
    rows.into_iter()
        .map(|row| {
            Ok(Integration {
                id: row.try_get("id")?,
                url: row.try_get("webhook_url")?,
            })
        })
        .collect()
}

async fn activity_with_integrations(
    conn: &mut PgConnection,
    workspace: Uuid,
    actor: Uuid,
    action: &str,
    issue: Option<Uuid>,
    fields: Vec<String>,
    cached: Option<&[Integration]>,
) -> Result<()> {
    let event = Activity {
        id: Uuid::new_v4(),
        actor,
        action: action.into(),
        entity_id: issue,
        at: Utc::now(),
        fields,
    };
    sqlx::query("INSERT INTO activity(id,workspace_id,actor,action,entity_id,at,fields) VALUES($1,$2,$3,$4,$5,$6,$7)")
        .bind(event.id).bind(workspace).bind(actor).bind(action).bind(issue).bind(event.at).bind(serde_json::to_value(&event.fields)?).execute(&mut *conn).await?;
    let loaded;
    let integrations = if let Some(cached) = cached {
        cached
    } else {
        loaded = integrations(conn, workspace).await?;
        &loaded
    };
    for integration in integrations {
        let id = integration.id;
        Outbox::insert(
            conn,
            &NewJob::now(
                format!("{}:{id}", event.id),
                Job::Webhook(crate::jobs::Webhook {
                    workspace_id: workspace,
                    integration_id: id,
                    url: integration.url.clone(),
                    event: serde_json::json!({"workspace_id":workspace,"activity":event}),
                }),
            ),
        )
        .await?;
    }
    Ok(())
}

async fn notify_changes(
    conn: &mut PgConnection,
    workspace: Uuid,
    actor: Uuid,
    issue: &Issue,
    remote: bool,
) -> Result<()> {
    let users: Vec<Uuid> = issue
        .followers
        .iter()
        .copied()
        .filter(|user| remote || *user != actor)
        .collect();
    if users.is_empty() {
        return Ok(());
    }
    let ids: Vec<Uuid> = users.iter().map(|_| Uuid::new_v4()).collect();
    let keys: Vec<String> = users
        .iter()
        .map(|user| format!("change:{}:{user}:{}", issue.id, Uuid::new_v4()))
        .collect();
    sqlx::query("INSERT INTO notifications(id,workspace_id,user_id,issue_id,kind,message,created_at,dedup_key) SELECT input.id,$1,input.user_id,$2,'change',$3,now(),input.key FROM unnest($4::uuid[],$5::uuid[],$6::text[]) AS input(id,user_id,key) JOIN workspace_members m ON m.workspace_id=$1 AND m.user_id=input.user_id JOIN users u ON u.id=input.user_id LEFT JOIN alert_preferences p ON p.workspace_id=$1 AND p.user_id=input.user_id WHERE COALESCE(p.change,true) AND COALESCE((u.profile->'alerts'->>'changes')::bool,true) ON CONFLICT(workspace_id,dedup_key) DO NOTHING")
        .bind(workspace).bind(issue.id).bind(&issue.title).bind(ids).bind(users).bind(keys)
        .execute(conn).await?;
    Ok(())
}

pub(crate) async fn notify(
    conn: &mut PgConnection,
    workspace: Uuid,
    user: Uuid,
    issue_id: Option<Uuid>,
    kind: AlertKind,
    message: String,
    key: String,
) -> Result<()> {
    let column = enum_text(&kind);

    let global = match kind {
        AlertKind::Assignment => "assignments",
        AlertKind::Reply | AlertKind::Mention => "replies",
        AlertKind::Change => "changes",
        AlertKind::Deadline => "deadlines",
    };

    let sql = format!(
        "INSERT INTO notifications(id,workspace_id,user_id,issue_id,kind,message,created_at,dedup_key) \
             SELECT $1,$2,$3,$4,$5,$6,now(),$7 \
             WHERE EXISTS(SELECT 1 FROM workspace_members WHERE workspace_id=$2 AND user_id=$3) \
             AND COALESCE((SELECT {column} FROM alert_preferences WHERE workspace_id=$2 AND user_id=$3),true) \
             AND COALESCE((SELECT (profile->'alerts'->>'{global}')::bool FROM users WHERE id=$3),true) \
             ON CONFLICT(workspace_id,dedup_key) DO NOTHING"
    );

    sqlx::query(&sql)
        .bind(Uuid::new_v4())
        .bind(workspace)
        .bind(user)
        .bind(issue_id)
        .bind(column)
        .bind(message)
        .bind(key)
        .execute(&mut *conn)
        .await?;

    Ok(())
}

pub(crate) async fn capacity(
    conn: &mut PgConnection,
    workspace: Uuid,
    table: &str,
    max: i64,
    cached_count: &mut Option<i64>,
    message: &str,
) -> Result<()> {
    assert!(matches!(
        table,
        "issues"
            | "teams"
            | "projects"
            | "sprints"
            | "comments"
            | "time_entries"
            | "notifications"
            | "activity"
            | "workspace_members"
            | "invitations"
            | "saved_views"
            | "integrations"
            | "labels"
            | "milestones"
    ));
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,30269))")
        .bind(format!("{}:{table}", workspace))
        .execute(&mut *conn)
        .await?;

    let count = if let Some(count) = *cached_count {
        count
    } else {
        let count: i64 = sqlx::query_scalar(&format!(
            "SELECT count(*) FROM {table} WHERE workspace_id=$1"
        ))
        .bind(workspace)
        .fetch_one(&mut *conn)
        .await?;

        *cached_count = Some(count);
        count
    };

    if count >= max {
        return Err(Error::BadRequest(message.into()));
    }

    Ok(())
}
