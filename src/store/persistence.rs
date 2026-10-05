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
    sqlx::query("INSERT INTO issues(id,workspace_id,number,title,description,team_id,stage_id,assignee,priority,estimate,deadline,project_id,milestone_id,sprint_id,parent_id,position,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$17)")
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
            .bind(i.created_at)
            .execute(&mut *conn)
            .await?;
    save_fields(conn, workspace, i, ownership, false).await?;

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
    let source = match ownership {
        Ownership::Local => {
            if i.openproject.is_some() {
                return Err(Error::Conflict(
                    "OpenProject imported issues are read-only".into(),
                ));
            }
            None
        }
        Ownership::Remote(source) => Some(serde_json::to_value(source)?),
    };
    sqlx::query("UPDATE issues SET title=$3,description=$4,team_id=$16,stage_id=$5,assignee=$6,priority=$7,estimate=$8,deadline=$9,project_id=$10,milestone_id=$11,sprint_id=$12,parent_id=$13,position=$14,deleted_at=$15,updated_at=now(),openproject=$17,version=version+CASE WHEN $18 THEN 1 ELSE 0 END WHERE workspace_id=$1 AND id=$2")
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
            .bind(increment_version)
            .execute(&mut *conn)
            .await?;

    if matches!(ownership, Ownership::Remote(_)) {
        return Ok(());
    }

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
    let row = sqlx::query("UPDATE issues SET reminder_generation=reminder_generation+1 WHERE workspace_id=$1 AND id=$2 RETURNING deadline,reminder_generation,stage_id,deleted_at")
            .bind(workspace)
            .bind(id)
            .fetch_one(&mut *conn)
            .await?;

    let deadline: Option<DateTime<Utc>> = row.try_get("deadline")?;
    let generation: i64 = row.try_get("reminder_generation")?;
    let stage: Uuid = row.try_get("stage_id")?;
    let done: bool =
        sqlx::query_scalar("SELECT kind IN ('done','cancelled') FROM stages WHERE id=$1")
            .bind(stage)
            .fetch_one(&mut *conn)
            .await?;

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
            },
        )
        .await?;
    }

    Ok(())
}

pub(crate) async fn became_completed(
    conn: &mut PgConnection,
    before: Option<&Issue>,
    after: &Issue,
) -> Result<bool> {
    if after.deleted_at.is_some() {
        return Ok(false);
    }
    let done: bool =
        sqlx::query_scalar("SELECT kind IN ('done','cancelled') FROM stages WHERE id=$1")
            .bind(after.stage_id)
            .fetch_one(&mut *conn)
            .await?;
    let was_done = if let Some(i) = before {
        i.deleted_at.is_none()
            && sqlx::query_scalar::<_, bool>(
                "SELECT kind IN ('done','cancelled') FROM stages WHERE id=$1",
            )
            .bind(i.stage_id)
            .fetch_one(&mut *conn)
            .await?
    } else {
        false
    };
    Ok(done && !was_done)
}

pub(crate) fn changed_fields(before: &Issue, after: &Issue) -> Vec<String> {
    [
        ("title", before.title != after.title),
        ("description", before.description != after.description),
        ("stage", before.stage_id != after.stage_id),
        ("assignee", before.assignee != after.assignee),
        ("priority", before.priority != after.priority),
        ("labels", before.labels != after.labels),
        ("estimate", before.estimate != after.estimate),
        ("deadline", before.deadline != after.deadline),
        ("project", before.project_id != after.project_id),
        ("milestone", before.milestone_id != after.milestone_id),
        ("sprint", before.sprint_id != after.sprint_id),
        ("parent", before.parent_id != after.parent_id),
        ("dependencies", before.dependencies != after.dependencies),
    ]
    .into_iter()
    .filter(|(_, changed)| *changed)
    .map(|(name, _)| name.to_owned())
    .collect()
}

pub(crate) async fn read(conn: &mut PgConnection, workspace: Uuid, id: Uuid) -> Result<Issue> {
    super::reads::issue_on(conn, workspace, id, true).await
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
    if before.is_none_or(|old| {
        old.deadline != after.deadline
            || old.stage_id != after.stage_id
            || old.assignee != after.assignee
            || old.deleted_at != after.deleted_at
    }) {
        schedule_reminder(conn, workspace, after.id).await?;
    }

    let remote = matches!(effects, IssueEffects::Remote(_));
    if let IssueEffects::Remote(fields) = &effects {
        activity(
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
        )
        .await?;
    }

    if matches!(effects, IssueEffects::Create | IssueEffects::Update)
        && before.is_none_or(|old| old.assignee != after.assignee)
        && let Some(user) = after.assignee
        && user != actor
    {
        notify(
            conn,
            workspace,
            user,
            Some(after.id),
            AlertKind::Assignment,
            after.title.clone(),
            format!("assignment:{}:{}", after.id, Uuid::new_v4()),
        )
        .await?;
    }

    if matches!(effects, IssueEffects::Update) || (remote && before.is_some()) {
        for &user in &after.followers {
            if remote || user != actor {
                notify(
                    conn,
                    workspace,
                    user,
                    Some(after.id),
                    AlertKind::Change,
                    after.title.clone(),
                    format!("change:{}:{user}:{}", after.id, Uuid::new_v4()),
                )
                .await?;
            }
        }
    }

    if !matches!(effects, IssueEffects::DeleteRestore)
        && became_completed(conn, before, after).await?
    {
        activity(
            conn,
            workspace,
            actor,
            "issue_completed",
            Some(after.id),
            vec![],
        )
        .await?;
    }
    Ok(())
}

/// Background sync uses the workspace owner for audit, without excluding them from alerts.
pub(crate) async fn remote_effects(
    conn: &mut PgConnection,
    workspace: Uuid,
    before: Option<&Issue>,
    after: &Issue,
    fields: Vec<String>,
) -> Result<()> {
    let actor: Uuid = sqlx::query_scalar("SELECT user_id FROM workspace_members WHERE workspace_id=$1 AND role='owner' ORDER BY user_id LIMIT 1")
        .bind(workspace).fetch_one(&mut *conn).await?;
    issue_effects(
        conn,
        workspace,
        actor,
        before,
        after,
        IssueEffects::Remote(fields),
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
    let rows = sqlx::query(
        "SELECT id,webhook_url,secret FROM integrations WHERE workspace_id=$1 AND enabled",
    )
    .bind(workspace)
    .fetch_all(&mut *conn)
    .await?;
    for row in rows {
        let id: Uuid = row.try_get("id")?;
        Outbox::insert(
            conn,
            &NewJob::now(
                format!("{}:{id}", event.id),
                Job::Webhook(crate::jobs::Webhook {
                    workspace_id: workspace,
                    integration_id: id,
                    url: row.try_get("webhook_url")?,
                    secret: row.try_get("secret")?,
                    event: serde_json::json!({"workspace_id":workspace,"activity":event}),
                }),
            ),
        )
        .await?;
    }
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
