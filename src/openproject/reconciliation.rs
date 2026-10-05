use super::*;
use crate::{
    domain::{Issue, OpenProjectSource},
    store::persistence,
};
use scan::{Person, Status, WorkPackage};

pub(super) struct PageImport<'a> {
    workspace: Uuid,
    connection: Uuid,
    base: &'a str,
    mapping: &'a Mapping,
    statuses: &'a [Status],
    people: &'a [Person],
    people_mapping: &'a BTreeMap<String, Uuid>,
    issue_count: Option<i64>,
}
impl<'a> PageImport<'a> {
    pub fn new(
        workspace: Uuid,
        connection: Uuid,
        base: &'a str,
        mapping: &'a Mapping,
        statuses: &'a [Status],
        people: &'a [Person],
        people_mapping: &'a BTreeMap<String, Uuid>,
    ) -> Self {
        Self {
            workspace,
            connection,
            base,
            mapping,
            statuses,
            people,
            people_mapping,
            issue_count: None,
        }
    }
}

#[tracing::instrument(name = "openproject_work_package", level = "debug", skip_all,
    fields(connection_id = %import.connection, work_package_id = item.id,
        project_id = item.project_id, team_id = %import.mapping.team_id))]
pub(super) async fn apply(
    conn: &mut PgConnection,
    import: &mut PageImport<'_>,
    item: &WorkPackage,
) -> Result<()> {
    let workspace = import.workspace;
    let mapping = import.mapping;
    let status = import
        .statuses
        .iter()
        .find(|status| status.id == item.status_id);
    let status_name = status
        .map(|status| status.name.as_str())
        .or(item.status_name.as_deref())
        .unwrap_or("Unknown");
    let closed = status.is_some_and(|status| status.is_closed);
    let stage = if let Some(stage) = mapping.stage_mapping.get(&item.status_id.to_string()) {
        *stage
    } else {
        sqlx::query_scalar("SELECT id FROM stages WHERE workspace_id=$1 AND team_id=$2 ORDER BY (lower(name)=lower($3)) DESC,(kind=$4) DESC,position,id LIMIT 1")
            .bind(workspace).bind(mapping.team_id).bind(status_name).bind(if closed {"done"}else{"backlog"}).fetch_optional(&mut *conn).await?.ok_or_else(||Error::Internal("destination team has no stage".into()))?
    };
    let stage_exists: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM stages WHERE workspace_id=$1 AND team_id=$2 AND id=$3)",
    )
    .bind(workspace)
    .bind(mapping.team_id)
    .bind(stage)
    .fetch_one(&mut *conn)
    .await?;
    if !stage_exists {
        return Err(Error::BadRequest(
            "OpenProject mapped stage no longer exists; update project stage mapping".into(),
        ));
    }
    tracing::debug!(status_id = item.status_id, stage_id = %stage,
        explicit_mapping = mapping.stage_mapping.contains_key(&item.status_id.to_string()),
        closed, "OpenProject status mapped");
    let source = OpenProjectSource {
        connection_id: import.connection,
        work_package_id: item.id,
        project_id: item.project_id,
        status_name: status_name.to_owned(),
        url: format!("{}/work_packages/{}", import.base, item.id),
        unavailable: false,
    };
    let existing: Option<Uuid> = sqlx::query_scalar("SELECT id FROM issues WHERE workspace_id=$1 AND openproject->>'connection_id'=$2 AND openproject->>'work_package_id'=$3 FOR UPDATE")
        .bind(workspace).bind(import.connection.to_string()).bind(item.id.to_string()).fetch_optional(&mut *conn).await?;
    let before = if let Some(id) = existing {
        Some(crate::store::persistence::read(conn, workspace, id).await?)
    } else {
        None
    };
    let mut after = match &before {
        Some(issue) => issue.clone(),
        None => {
            persistence::capacity(conn, workspace, "issues", 5000, &mut import.issue_count,
                "OpenProject import stopped: workspace issue capacity reached (5000); reduce project mappings. Existing issues remain unchanged").await?;
            let now = Utc::now();
            Issue {
                id: Uuid::new_v4(),
                number: 0,
                title: String::new(),
                description: String::new(),
                team_id: mapping.team_id,
                stage_id: stage,
                assignee: None,
                priority: Default::default(),
                labels: vec![],
                estimate: None,
                deadline: None,
                project_id: None,
                milestone_id: None,
                sprint_id: None,
                parent_id: None,
                dependencies: vec![],
                position: 0,
                followers: vec![],
                attachments: vec![],
                source_links: vec![],
                deleted_at: None,
                archived_at: None,
                done_at: None,
                created_at: now,
                updated_at: now,
                openproject: None,
                blocked_count: 0,
                subtask_total: 0,
                subtask_completed: 0,
                version: 1,
            }
        }
    };
    after.title = item.title.clone();
    after.description = item.description.clone();
    after.team_id = mapping.team_id;
    after.stage_id = stage;
    let email = item
        .assignee_id
        .and_then(|id| import.people.iter().find(|person| person.id == id))
        .and_then(|person| person.email.as_deref());
    after.assignee = match email {
        Some(email) => {
            let mapped = import.people_mapping.get(email).copied();
            sqlx::query_scalar("SELECT u.id FROM users u JOIN workspace_members m ON m.user_id=u.id WHERE m.workspace_id=$1 AND CASE WHEN $2::uuid IS NOT NULL THEN u.id=$2 ELSE lower(u.email)=$3 END")
                .bind(workspace).bind(mapped).bind(email).fetch_optional(&mut *conn).await?
        }
        None => None,
    };
    tracing::debug!(remote_assignee_id = ?item.assignee_id, email_available = email.is_some(),
        explicit_mapping = email.is_some_and(|email| import.people_mapping.contains_key(email)),
        assignee_id = ?after.assignee, "OpenProject assignee mapped");
    after.priority = item.priority.clone();
    after.deadline = item.deadline;
    after.project_id = None;
    after.milestone_id = None;
    after.sprint_id = None;
    after.openproject = Some(source.clone());
    let mut fields = before
        .as_ref()
        .map(|old| persistence::changed_fields(old, &after))
        .unwrap_or_default();
    if let Some(old) = &before {
        if old.team_id != after.team_id {
            fields.push("team".into());
        }
        if serde_json::to_value(&old.openproject)? != serde_json::to_value(&after.openproject)? {
            fields.push("openproject".into());
        }
    }
    let changed = before.is_none() || !fields.is_empty();
    tracing::debug!(issue_id = %after.id, creating = before.is_none(), changed, fields = ?fields,
        "OpenProject work package reconciled in page transaction");
    if changed {
        let ownership = persistence::Ownership::Remote(&source);
        if before.is_some() {
            persistence::save(conn, workspace, &after, ownership).await?;
        } else {
            persistence::create(conn, workspace, &mut after, ownership).await?;
            import.issue_count = import.issue_count.map(|count| count + 1);
        }
        persistence::remote_effects(conn, workspace, before.as_ref(), &after, fields).await?;
    }
    sqlx::query("INSERT INTO source_links(id,workspace_id,issue_id,url,title) VALUES($1,$2,$3,$4,'OpenProject') ON CONFLICT DO NOTHING")
        .bind(Uuid::new_v4()).bind(workspace).bind(after.id).bind(source.url).execute(conn).await?;
    Ok(())
}
