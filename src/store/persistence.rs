//! Canonical issue writes. Integration mapping belongs to the caller.
use super::*;
use crate::jobs::{Job, Reminder};
use std::collections::BTreeSet;

/// Who writes the issue. Local writes keep the stored tracker link; tracker writes replace it.
#[derive(Clone, Copy)]
pub(crate) enum Origin<'a> {
    Local,
    Remote(&'a TrackerLink),
}

pub(crate) async fn create(
    conn: &mut PgConnection,
    workspace: Uuid,
    i: &mut Issue,
    origin: Origin<'_>,
) -> Result<()> {
    i.number = next_number(conn, workspace, i.team_id).await?;
    i.position = sqlx::query_scalar("SELECT COALESCE(max(position),-1024)+1024 FROM issues WHERE workspace_id=$1 AND team_id=$2 AND stage_id=$3 AND deleted_at IS NULL")
            .bind(workspace)
            .bind(i.team_id)
            .bind(i.stage_id)
            .fetch_one(&mut *conn)
            .await?;
    insert(conn, workspace, i, origin).await
}

/// Serializes allocation of the team's issue and sprint numbers.
pub(crate) async fn lock_team_numbers(
    conn: &mut PgConnection,
    workspace: Uuid,
    team: Uuid,
) -> Result<()> {
    sqlx::query("SELECT 1 FROM teams WHERE workspace_id=$1 AND id=$2 FOR NO KEY UPDATE")
        .bind(workspace)
        .bind(team)
        .fetch_optional(&mut *conn)
        .await?
        .ok_or(Error::NotFound)?;
    Ok(())
}

pub(crate) async fn next_number(
    conn: &mut PgConnection,
    workspace: Uuid,
    team: Uuid,
) -> Result<u64> {
    lock_team_numbers(conn, workspace, team).await?;
    let number: i64 = sqlx::query_scalar(
        "SELECT GREATEST((SELECT max(number) FROM issues WHERE workspace_id=$1 AND team_id=$2),\
         (SELECT number FROM purged_issue_numbers WHERE workspace_id=$1 AND team_id=$2),\
         (SELECT max(number) FROM issue_key_aliases WHERE workspace_id=$1 AND team_id=$2),0)+1",
    )
    .bind(workspace)
    .bind(team)
    .fetch_one(&mut *conn)
    .await?;
    Ok(number as u64)
}

pub(crate) async fn claim_former_key(
    conn: &mut PgConnection,
    workspace: Uuid,
    issue: Uuid,
    key: FormerKey,
) -> Result<()> {
    // The issue losing the key changes too, so replicas stop resolving the key to it.
    sqlx::query("WITH previous AS (SELECT issue_id FROM issue_key_aliases WHERE workspace_id=$1 AND team_id=$2 AND number=$3 AND issue_id<>$4), \
         claimed AS (INSERT INTO issue_key_aliases(workspace_id,team_id,number,issue_id) VALUES($1,$2,$3,$4) ON CONFLICT(workspace_id,team_id,number) DO UPDATE SET issue_id=excluded.issue_id,seq=excluded.seq) \
         UPDATE issues SET version=version+1 WHERE workspace_id=$1 AND id IN (SELECT issue_id FROM previous)")
        .bind(workspace)
        .bind(key.team_id)
        .bind(key.number as i64)
        .bind(issue)
        .execute(conn)
        .await?;
    Ok(())
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

    /// Gives an issue moving into the batch's team the team's next number.
    pub(crate) fn renumber(&mut self, issue: &mut Issue) {
        issue.number = self.next_number;
        self.next_number += 1;
    }
}

/// The caller holds the workspace graph lock for the entire allocation and writes.
pub(crate) async fn allocate_creations(
    conn: &mut PgConnection,
    workspace: Uuid,
    team: Uuid,
) -> Result<CreationBatch> {
    let next_number = next_number(conn, workspace, team).await?;
    let rows = sqlx::query("SELECT stage_id,max(position) AS position FROM issues WHERE workspace_id=$1 AND team_id=$2 AND deleted_at IS NULL GROUP BY stage_id")
        .bind(workspace).bind(team).fetch_all(&mut *conn).await?;
    let mut positions = BTreeMap::new();
    for row in rows {
        positions.insert(row.try_get("stage_id")?, row.try_get("position")?);
    }
    Ok(CreationBatch {
        next_number,
        positions,
    })
}

pub(crate) async fn create_allocated(
    conn: &mut PgConnection,
    workspace: Uuid,
    issue: &mut Issue,
    source: &TrackerLink,
    allocation: &mut CreationBatch,
) -> Result<()> {
    issue.number = allocation.next_number;
    allocation.next_number += 1;
    let position = allocation.positions.entry(issue.stage_id).or_insert(-1024);
    *position = position
        .checked_add(1024)
        .ok_or_else(|| Error::Conflict("issue position exhausted".into()))?;
    issue.position = *position;
    insert(conn, workspace, issue, Origin::Remote(source)).await
}

fn source_value(origin: Origin<'_>) -> Result<Option<serde_json::Value>> {
    match origin {
        Origin::Local => Ok(None),
        Origin::Remote(source) => Ok(Some(serde_json::to_value(source)?)),
    }
}

async fn insert(
    conn: &mut PgConnection,
    workspace: Uuid,
    i: &Issue,
    origin: Origin<'_>,
) -> Result<()> {
    let source = source_value(origin)?;
    sqlx::query("INSERT INTO issues(id,workspace_id,number,title,description,team_id,stage_id,assignee,priority,estimate,deadline,project_id,milestone_id,sprint_id,parent_id,position,archived_at,done_at,created_at,updated_at,tracker,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$19,$20,$21)")
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
    if matches!(origin, Origin::Local) {
        save_relations(conn, workspace, i).await?;
    }

    Ok(())
}

pub(crate) async fn save(
    conn: &mut PgConnection,
    workspace: Uuid,
    i: &Issue,
    origin: Origin<'_>,
) -> Result<()> {
    save_fields(
        conn,
        workspace,
        i,
        origin,
        matches!(origin, Origin::Remote(_)),
    )
    .await
}

async fn save_fields(
    conn: &mut PgConnection,
    workspace: Uuid,
    i: &Issue,
    origin: Origin<'_>,
    increment_version: bool,
) -> Result<()> {
    let source = source_value(origin)?;
    let remote = matches!(origin, Origin::Remote(_));
    sqlx::query("UPDATE issues SET title=$3,description=$4,team_id=$16,stage_id=$5,assignee=$6,priority=$7,estimate=$8,deadline=$9,project_id=$10,milestone_id=$11,sprint_id=$12,parent_id=$13,position=$14,deleted_at=$15,updated_at=now(),tracker=CASE WHEN $21 THEN $17 ELSE tracker END,archived_at=$18,done_at=$19,version=version+CASE WHEN $20 THEN 1 ELSE 0 END,number=$22 WHERE workspace_id=$1 AND id=$2")
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
            .bind(i.number as i64)
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
                due_at: Some((deadline - chrono::Duration::hours(24)).timestamp()),
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
    // Local edits of synced issues queue their exported fields; imports use `PageEffects`.
    if let (IssueEffects::Update | IssueEffects::Move, Some(before)) = (&effects, before) {
        crate::tracker::enqueue_fields(conn, workspace, before, after).await?;
    }
    issue_effects_with_context(conn, workspace, actor, before, after, effects, None).await
}

struct Integration {
    id: Uuid,
    url: String,
    /// Subscribed public event types; empty means all.
    events: Vec<String>,
}

impl Integration {
    fn wants(&self, event: &str) -> bool {
        self.events.is_empty() || self.events.iter().any(|e| e == event)
    }
}

/// The member that tracker activity is attributed to: the workspace's first owner.
pub(crate) async fn tracker_actor(conn: &mut PgConnection, workspace: Uuid) -> Result<Uuid> {
    Ok(sqlx::query_scalar("SELECT user_id FROM workspace_members WHERE workspace_id=$1 AND role='owner' ORDER BY user_id LIMIT 1")
        .bind(workspace).fetch_one(conn).await?)
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
        Ok(Self {
            actor: tracker_actor(conn, workspace).await?,
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
            before.map_or_else(Vec::new, |old| old.changes(after)),
            context.map(|context| context.integrations.as_slice()),
        )
        .await?;
    }

    if matches!(effects, IssueEffects::Create | IssueEffects::Update) {
        notify_new_assignee(conn, workspace, actor, before, after).await?;
    }

    let notifies_followers = match effects {
        IssueEffects::Update => true,
        IssueEffects::Move => before.is_some_and(|old| old.stage_id != after.stage_id),
        IssueEffects::Remote(_) => before.is_some(),
        IssueEffects::Create | IssueEffects::DeleteRestore => false,
    };
    if notifies_followers {
        let fields = before.map_or_else(Vec::new, |old| old.changed_fields(after));
        notify_changes(conn, workspace, actor, after, &fields, remote).await?;
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
        Some(actor),
        user,
        Some(after.id),
        AlertKind::Assignment,
        after.title.clone(),
        format!("assignment:{}:{}", after.id, Uuid::new_v4()),
        &[],
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
    changes: Vec<FieldChange>,
) -> Result<()> {
    activity_with_integrations(conn, workspace, actor, action, issue, fields, changes, None).await
}

async fn integrations(conn: &mut PgConnection, workspace: Uuid) -> Result<Vec<Integration>> {
    let rows = sqlx::query(
        "SELECT id,webhook_url,events FROM integrations WHERE workspace_id=$1 AND enabled",
    )
    .bind(workspace)
    .fetch_all(conn)
    .await?;
    rows.into_iter()
        .map(|row| {
            Ok(Integration {
                id: row.try_get("id")?,
                url: row.try_get("webhook_url")?,
                events: row.try_get("events")?,
            })
        })
        .collect()
}

#[allow(clippy::too_many_arguments)]
async fn activity_with_integrations(
    conn: &mut PgConnection,
    workspace: Uuid,
    actor: Uuid,
    action: &str,
    issue: Option<Uuid>,
    fields: Vec<String>,
    changes: Vec<FieldChange>,
    cached: Option<&[Integration]>,
) -> Result<()> {
    let event = Activity {
        id: Uuid::new_v4(),
        actor,
        action: action.into(),
        entity_id: issue,
        at: Utc::now(),
        fields,
        changes,
        via: None,
    };
    let via: Option<serde_json::Value> = match continued_description_edit(conn, workspace, &event).await? {
        Some(via) => via,
        None => sqlx::query_scalar("INSERT INTO activity(id,workspace_id,actor,action,entity_id,at,fields,changes) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING via")
            .bind(event.id).bind(workspace).bind(actor).bind(action).bind(issue).bind(event.at).bind(serde_json::to_value(&event.fields)?).bind(serde_json::to_value(&event.changes)?).fetch_one(&mut *conn).await?,
    };
    // Only public events leave the workspace; see `WEBHOOK_EVENTS`.
    let Some((kind, entity_type)) = crate::domain::webhook_event(action) else {
        return Ok(());
    };
    let loaded;
    let integrations = if let Some(cached) = cached {
        cached
    } else {
        loaded = integrations(conn, workspace).await?;
        &loaded
    };
    let mut payload = serde_json::json!({
        "id": event.id,
        "type": kind,
        "workspace_id": workspace,
        "occurred_at": event.at,
        "actor_id": actor,
        "entity_type": entity_type,
        "entity_id": issue,
    });
    if !event.fields.is_empty() {
        payload["fields"] = serde_json::json!(event.fields);
    }
    if !event.changes.is_empty() {
        payload["changes"] = serde_json::json!(event.changes);
    }
    if let Some(via) = via {
        payload["via"] = via;
    }
    for integration in integrations.iter().filter(|i| i.wants(kind)) {
        let id = integration.id;
        Outbox::insert(
            conn,
            &NewJob::now(
                format!("{}:{id}", event.id),
                Job::Webhook(crate::jobs::Webhook {
                    workspace_id: workspace,
                    integration_id: id,
                    url: integration.url.clone(),
                    event: payload.clone(),
                }),
            ),
        )
        .await?;
    }
    Ok(())
}

/// Description autosave saves after every pause in typing. A save continues the latest
/// activity row of the issue when that row is a description-only edit by the same actor through
/// the same client (`via`) from the last ten minutes, and returns that row's `via`. Ten minutes
/// spans the pauses of one sitting but splits separate ones. The row keeps its first `at`,
/// because activity rows sync to clients only on insert.
async fn continued_description_edit(
    conn: &mut PgConnection,
    workspace: Uuid,
    event: &Activity,
) -> Result<Option<Option<serde_json::Value>>> {
    let Some(issue) = event.entity_id else {
        return Ok(None);
    };
    if event.action != "update_issue" || event.fields != ["description"] {
        return Ok(None);
    }
    Ok(sqlx::query_scalar(
        "SELECT via FROM (SELECT actor,action,fields,at,via FROM activity \
         WHERE workspace_id=$1 AND entity_id=$2 ORDER BY at DESC,id DESC LIMIT 1) latest \
         WHERE actor=$3 AND action='update_issue' AND fields='[\"description\"]'::jsonb AND at>$4 \
         AND via IS NOT DISTINCT FROM nullif(current_setting('blackwall.via',true),'')::jsonb",
    )
    .bind(workspace)
    .bind(issue)
    .bind(event.actor)
    .bind(event.at - chrono::TimeDelta::minutes(10))
    .fetch_optional(conn)
    .await?)
}

async fn notify_changes(
    conn: &mut PgConnection,
    workspace: Uuid,
    actor: Uuid,
    issue: &Issue,
    fields: &[String],
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
        .map(|user| format!("change:{}:{user}", issue.id))
        .collect();
    sqlx::query("INSERT INTO notifications(id,workspace_id,user_id,issue_id,kind,message,created_at,dedup_key,actor_id,fields) SELECT input.id,$1,input.user_id,$2,'change',$3,now(),input.key,$7,$8 FROM unnest($4::uuid[],$5::uuid[],$6::text[]) AS input(id,user_id,key) JOIN workspace_members m ON m.workspace_id=$1 AND m.user_id=input.user_id LEFT JOIN alert_preferences p ON p.workspace_id=$1 AND p.user_id=input.user_id WHERE COALESCE(p.change,true) ON CONFLICT(workspace_id,dedup_key) DO UPDATE SET message=EXCLUDED.message,created_at=EXCLUDED.created_at,actor_id=EXCLUDED.actor_id,fields=COALESCE((SELECT jsonb_agg(DISTINCT f) FROM jsonb_array_elements_text(notifications.fields||EXCLUDED.fields) f),'[]'),version=notifications.version+1 WHERE notifications.read_at IS NULL")
        .bind(workspace).bind(issue.id).bind(&issue.title).bind(ids).bind(users).bind(keys).bind((!remote).then_some(actor)).bind(serde_json::to_value(fields)?)
        .execute(conn).await?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub(crate) async fn notify(
    conn: &mut PgConnection,
    workspace: Uuid,
    actor: Option<Uuid>,
    user: Uuid,
    issue_id: Option<Uuid>,
    kind: AlertKind,
    message: String,
    key: String,
    fields: &[&str],
) -> Result<()> {
    let column = enum_text(&kind);

    let sql = format!(
        "INSERT INTO notifications(id,workspace_id,user_id,issue_id,kind,message,created_at,dedup_key,actor_id,fields) \
             SELECT $1,$2,$3,$4,$5,$6,now(),$7,$8,$9 \
             WHERE EXISTS(SELECT 1 FROM workspace_members WHERE workspace_id=$2 AND user_id=$3) \
             AND COALESCE((SELECT {column} FROM alert_preferences WHERE workspace_id=$2 AND user_id=$3),true) \
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
        .bind(actor)
        .bind(serde_json::to_value(fields)?)
        .execute(&mut *conn)
        .await?;

    Ok(())
}

pub(crate) async fn room(
    conn: &mut PgConnection,
    workspace: Uuid,
    resource: Resource,
    limit: Option<u32>,
) -> Result<Option<i64>> {
    let Some(limit) = limit else {
        return Ok(None);
    };
    let table = resource.table();
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,30269))")
        .bind(format!("{}:{table}", workspace))
        .execute(&mut *conn)
        .await?;
    let count: i64 = sqlx::query_scalar(&format!(
        "SELECT count(*) FROM {table} WHERE workspace_id=$1"
    ))
    .bind(workspace)
    .fetch_one(&mut *conn)
    .await?;
    Ok(Some(i64::from(limit) - count))
}
