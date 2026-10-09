use super::*;
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::QueryBuilder;

#[derive(Clone, Copy, Debug)]
pub struct CollectionQuery {
    pub limit: i64,
    pub offset: i64,
    pub issue_id: Option<Uuid>,
    pub entity_id: Option<Uuid>,
}

macro_rules! issue_json {
    () => {
        r#"(to_jsonb(i)-'workspace_id'-'reminder_generation') || jsonb_build_object(
 'labels',COALESCE((SELECT jsonb_agg(l.label_id ORDER BY l.label_id) FROM issue_labels l WHERE l.workspace_id=i.workspace_id AND l.issue_id=i.id),'[]'::jsonb),
 'dependencies',COALESCE((SELECT jsonb_agg(d.dependency_id ORDER BY d.dependency_id) FROM issue_dependencies d WHERE d.workspace_id=i.workspace_id AND d.issue_id=i.id),'[]'::jsonb),
 'followers',COALESCE((SELECT jsonb_agg(f.user_id ORDER BY f.user_id) FROM issue_followers f WHERE f.workspace_id=i.workspace_id AND f.issue_id=i.id),'[]'::jsonb),
 'attachments',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',a.id,'name',a.filename,'content_type',a.content_type,'size',octet_length(a.bytes)) ORDER BY a.id) FROM attachments a WHERE a.workspace_id=i.workspace_id AND a.issue_id=i.id AND a.comment_id IS NULL),'[]'::jsonb),
 'source_links',COALESCE((SELECT jsonb_agg(jsonb_build_object('url',s.url,'title',s.title) ORDER BY s.id) FROM source_links s WHERE s.workspace_id=i.workspace_id AND s.issue_id=i.id),'[]'::jsonb))"#
    };
}

pub(super) const SYNC_ISSUE_JSON: &str = issue_json!();
pub(super) const ISSUE_JSON: &str = concat!(
    "(",
    issue_json!(),
    ") || jsonb_build_object(\n",
    r#" 'blocked_count',(SELECT count(*) FROM issue_dependencies d JOIN issues dependency ON dependency.id=d.dependency_id JOIN stages stage ON stage.id=dependency.stage_id WHERE d.issue_id=i.id AND dependency.deleted_at IS NULL AND stage.kind NOT IN ('done','cancelled')),
 'subtask_total',(SELECT count(*) FROM issues child WHERE child.workspace_id=i.workspace_id AND child.parent_id=i.id AND child.deleted_at IS NULL),
 'subtask_completed',(SELECT count(*) FROM issues child JOIN stages stage ON stage.id=child.stage_id WHERE child.workspace_id=i.workspace_id AND child.parent_id=i.id AND child.deleted_at IS NULL AND stage.kind IN ('done','cancelled')))"#
);

const ISSUE_SUMMARY_JSON: &str = r#"jsonb_build_object(
 'id',i.id,'number',i.number,'title',i.title,'team_id',i.team_id,'stage_id',i.stage_id,
 'assignee',i.assignee,'created_by',i.created_by,'priority',i.priority,'estimate',i.estimate,'deadline',i.deadline,
 'project_id',i.project_id,'milestone_id',i.milestone_id,'sprint_id',i.sprint_id,
 'parent_id',i.parent_id,'position',i.position,'version',i.version,
 'created_at',i.created_at,'updated_at',i.updated_at,'deleted_at',i.deleted_at,
 'archived_at',i.archived_at,'done_at',i.done_at,'openproject',i.openproject,
 'blocked_count',(SELECT count(*) FROM issue_dependencies d JOIN issues dependency ON dependency.id=d.dependency_id JOIN stages stage ON stage.id=dependency.stage_id WHERE d.issue_id=i.id AND dependency.deleted_at IS NULL AND stage.kind NOT IN ('done','cancelled')),
 'subtask_total',(SELECT count(*) FROM issues child WHERE child.workspace_id=i.workspace_id AND child.parent_id=i.id AND child.deleted_at IS NULL),
 'subtask_completed',(SELECT count(*) FROM issues child JOIN stages stage ON stage.id=child.stage_id WHERE child.workspace_id=i.workspace_id AND child.parent_id=i.id AND child.deleted_at IS NULL AND stage.kind IN ('done','cancelled')),
 'labels',COALESCE((SELECT jsonb_agg(l.label_id ORDER BY l.label_id) FROM issue_labels l WHERE l.workspace_id=i.workspace_id AND l.issue_id=i.id),'[]'::jsonb))"#;

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct IssueCursor {
    version: u8,
    workspace: Uuid,
    scope: String,
    updated_at: DateTime<Utc>,
    id: Uuid,
}

fn cursor_scope(filter: &IssueFilter) -> Result<String> {
    let mut filter = filter.clone();
    filter.after = None;
    filter.projection = IssueProjection::Full;
    Ok(hex::encode(Sha256::digest(serde_json::to_vec(&filter)?)))
}

fn updated_cursor_sort(filter: &IssueFilter) -> bool {
    matches!(filter.sort, IssueSort::Updated)
        && matches!(filter.group_by, None | Some(IssueGroup::None))
}

fn decode_issue_cursor(
    filter: &IssueFilter,
    workspace: Uuid,
    offset: i64,
) -> Result<Option<IssueCursor>> {
    let Some(encoded) = &filter.after else {
        return Ok(None);
    };
    if !updated_cursor_sort(filter) || offset != 0 {
        return Err(Error::BadRequest(
            "after requires sort=updated, no grouping, and offset=0".into(),
        ));
    }
    let invalid = || Error::BadRequest("invalid issue cursor for this workspace or filter".into());
    if encoded.len() > 2048 {
        return Err(invalid());
    }
    let bytes = URL_SAFE_NO_PAD.decode(encoded).map_err(|_| invalid())?;
    let cursor: IssueCursor = serde_json::from_slice(&bytes).map_err(|_| invalid())?;
    if cursor.version != 1 || cursor.workspace != workspace || cursor.scope != cursor_scope(filter)?
    {
        return Err(invalid());
    }
    Ok(Some(cursor))
}

fn push_issue_filters(
    q: &mut QueryBuilder<'_, Postgres>,
    workspace: Uuid,
    filter: &IssueFilter,
) -> Result<()> {
    q.push("i.workspace_id=").push_bind(workspace);
    q.push(if filter.trash {
        " AND i.deleted_at IS NOT NULL"
    } else if filter.archived {
        " AND i.deleted_at IS NULL AND i.archived_at IS NOT NULL"
    } else {
        " AND i.deleted_at IS NULL AND i.archived_at IS NULL"
    });
    for (column, value) in [
        ("assignee", filter.assignee),
        ("created_by", filter.created_by),
        ("team_id", filter.team_id),
        ("stage_id", filter.stage_id),
        ("sprint_id", filter.sprint_id),
        ("project_id", filter.project_id),
        ("parent_id", filter.parent_id),
    ] {
        if let Some(value) = value {
            q.push(format!(" AND i.{column}=")).push_bind(value);
        }
    }
    if let Some(id) = filter.label_id {
        q.push(" AND EXISTS(SELECT 1 FROM issue_labels l WHERE l.issue_id=i.id AND l.label_id=")
            .push_bind(id)
            .push(")");
    }
    if let Some(id) = filter.dependency_id {
        q.push(" AND EXISTS(SELECT 1 FROM issue_dependencies d WHERE d.issue_id=i.id AND d.dependency_id=")
            .push_bind(id)
            .push(")");
    }
    if let Some(priority) = &filter.priority {
        q.push(" AND i.priority=").push_bind(enum_text(priority));
    }
    if let Some(due) = filter.due_before {
        q.push(" AND i.deadline<=").push_bind(due);
    }
    if filter.unassigned {
        q.push(" AND i.assignee IS NULL");
    }
    if filter.no_sprint {
        q.push(" AND i.sprint_id IS NULL");
    }
    if filter.open {
        q.push(" AND EXISTS(SELECT 1 FROM stages s WHERE s.id=i.stage_id AND s.kind NOT IN ('done','cancelled'))");
    }
    if let Some(ids) = &filter.ids {
        let values: Vec<Uuid> = ids
            .split(',')
            .map(|s| {
                s.parse()
                    .map_err(|_| Error::BadRequest("ids must be comma-separated UUIDs".into()))
            })
            .collect::<Result<_>>()?;
        if values.len() > 200 {
            return Err(Error::BadRequest(
                "ids may contain at most 200 UUIDs".into(),
            ));
        }
        q.push(" AND i.id=ANY(").push_bind(values).push(")");
    }
    Ok(())
}

fn push_issue_order(q: &mut QueryBuilder<'_, Postgres>, filter: &IssueFilter) {
    q.push(" ORDER BY ");
    match filter.group_by {
        Some(IssueGroup::Stage) => {
            q.push("i.stage_id,");
        }
        Some(IssueGroup::Priority) => {
            q.push("CASE i.priority WHEN 'urgent' THEN 4 WHEN 'high' THEN 3 WHEN 'normal' THEN 2 WHEN 'low' THEN 1 ELSE 0 END DESC,");
        }
        Some(IssueGroup::Assignee) => {
            q.push("i.assignee NULLS LAST,");
        }
        _ => {}
    }
    q.push(match filter.sort {
        IssueSort::Position => "i.position,i.number,i.id",
        IssueSort::Deadline => "i.deadline ASC NULLS LAST,i.position,i.id",
        IssueSort::Updated => "i.updated_at DESC,i.id",
        IssueSort::Priority => "CASE i.priority WHEN 'urgent' THEN 4 WHEN 'high' THEN 3 WHEN 'normal' THEN 2 WHEN 'low' THEN 1 ELSE 0 END DESC,i.position,i.id",
    });
}

fn issue_number_search(search: &str) -> Option<i64> {
    let raw = search.trim_start_matches('#');
    let number = raw.parse::<i64>().ok()?;
    (number > 0 && number.to_string() == raw).then_some(number)
}

fn push_issue_search(
    q: &mut QueryBuilder<'_, Postgres>,
    workspace: Uuid,
    filter: &IssueFilter,
    search: &str,
) -> Result<()> {
    q.push("search_matches AS (SELECT i.id FROM issues i WHERE ");
    push_issue_filters(q, workspace, filter)?;
    q.push(
        " AND to_tsvector('simple',i.title || ' ' || i.description) @@ plainto_tsquery('simple',",
    )
    .push_bind(search.to_owned())
    .push(") UNION SELECT i.id FROM issues i WHERE ");
    push_issue_filters(q, workspace, filter)?;
    let pattern = format!(
        "%{}%",
        search
            .replace('\\', "\\\\")
            .replace('%', "\\%")
            .replace('_', "\\_")
    );
    q.push(" AND (i.title || ' ' || i.description) ILIKE ")
        .push_bind(pattern)
        .push(" ESCAPE E'\\\\'");
    if let Some(number) = issue_number_search(search) {
        q.push(" UNION SELECT i.id FROM issues i WHERE ");
        push_issue_filters(q, workspace, filter)?;
        q.push(" AND i.number=").push_bind(number);
    }
    q.push("), ");
    Ok(())
}

pub(super) const MEMBER_JSON: &str = r#"jsonb_build_object('id',u.id,'email',u.email,'display_name',u.profile->>'display_name','avatar_url',u.profile->'avatar_url','contact',u.profile->>'contact','role',m.role,'version',m.version,'team_ids',COALESCE((SELECT jsonb_agg(tm.team_id ORDER BY tm.team_id) FROM team_members tm WHERE tm.workspace_id=m.workspace_id AND tm.user_id=u.id),'[]'::jsonb))"#;

pub(super) async fn authorize(
    conn: &mut PgConnection,
    workspace: Uuid,
    actor: Uuid,
) -> Result<Role> {
    let role: Option<String> = sqlx::query_scalar(
        "SELECT role FROM workspace_members WHERE workspace_id=$1 AND user_id=$2",
    )
    .bind(workspace)
    .bind(actor)
    .fetch_optional(conn)
    .await?;
    serde_json::from_value(Value::String(role.ok_or(Error::Forbidden)?)).map_err(Into::into)
}

pub async fn issue_on(
    conn: &mut PgConnection,
    workspace: Uuid,
    id: Uuid,
    include_deleted: bool,
) -> Result<Issue> {
    let sql = format!(
        "SELECT {ISSUE_JSON} FROM issues i WHERE i.workspace_id=$1 AND i.id=$2 AND ($3 OR i.deleted_at IS NULL)"
    );
    let value: Value = sqlx::query_scalar(&sql)
        .bind(workspace)
        .bind(id)
        .bind(include_deleted)
        .fetch_optional(conn)
        .await?
        .ok_or(Error::NotFound)?;

    Ok(serde_json::from_value(value)?)
}

fn bounds(limit: i64, offset: i64) -> Result<()> {
    if !(1..=200).contains(&limit) || !(0..=i64::MAX - 201).contains(&offset) {
        return Err(Error::BadRequest(
            "limit must be 1..200 and offset must be nonnegative".into(),
        ));
    }

    Ok(())
}

pub(super) fn page(mut items: Vec<Value>, limit: i64, offset: i64) -> Value {
    let has_more = items.len() > limit as usize;
    items.truncate(limit as usize);
    json!({
        "items": items,
        "has_more": has_more,
        "next_offset": if has_more { Some(offset + limit) } else { None }
    })
}

pub(super) fn collection_select(kind: &str) -> Result<(&'static str, &'static str, &'static str)> {
    Ok(match kind {
        "teams" => (
            "teams t",
            r#"(to_jsonb(t)-'workspace_id') || jsonb_build_object('members',COALESCE((SELECT jsonb_agg(m.user_id ORDER BY m.user_id) FROM team_members m WHERE m.team_id=t.id),'[]'::jsonb),'stages',COALESCE((SELECT jsonb_agg(to_jsonb(s)-'workspace_id'-'team_id' ORDER BY s.position,s.id) FROM stages s WHERE s.team_id=t.id),'[]'::jsonb))"#,
            "t.name,t.id",
        ),
        "labels" => ("labels t", "to_jsonb(t)-'workspace_id'", "t.name,t.id"),
        "projects" => (
            "projects t",
            "(to_jsonb(t)-'workspace_id') || jsonb_build_object('team_ids',COALESCE((SELECT jsonb_agg(p.team_id ORDER BY p.team_id) FROM project_teams p WHERE p.project_id=t.id),'[]'::jsonb))",
            "t.name,t.id",
        ),
        "milestones" => ("milestones t", "to_jsonb(t)-'workspace_id'", "t.name,t.id"),
        "sprints" => (
            "sprints t",
            "(to_jsonb(t)-'workspace_id') || jsonb_build_object('outcome',(SELECT to_jsonb(o)-'workspace_id'-'sprint_id' FROM sprint_outcomes o WHERE o.sprint_id=t.id))",
            "t.starts_at,t.id",
        ),
        "views" => ("saved_views t", "to_jsonb(t)-'workspace_id'", "t.name,t.id"),
        "notifications" => (
            "notifications t",
            "to_jsonb(t)-'workspace_id'",
            "t.created_at DESC,t.id",
        ),
        "alert_preferences" => (
            "alert_preferences t",
            "to_jsonb(t)-'workspace_id'",
            "t.user_id",
        ),
        "invitations" => (
            "invitations t",
            "(to_jsonb(t)-'workspace_id') || jsonb_build_object('token_hash','')",
            "t.expires_at DESC,t.id",
        ),
        "integrations" => (
            "integrations t",
            "(to_jsonb(t)-'workspace_id') || jsonb_build_object('secret','')",
            "t.name,t.id",
        ),
        "activity" => ("activity t", "to_jsonb(t)-'workspace_id'", "t.at DESC,t.id"),
        "comments" => (
            "comments t",
            r#"(to_jsonb(t)-'workspace_id') || jsonb_build_object('mentions',COALESCE((SELECT jsonb_agg(m.user_id ORDER BY m.user_id) FROM comment_mentions m WHERE m.comment_id=t.id),'[]'::jsonb),'attachments',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',a.id,'name',a.filename,'content_type',a.content_type,'size',octet_length(a.bytes)) ORDER BY a.id) FROM attachments a WHERE a.comment_id=t.id),'[]'::jsonb))"#,
            "t.created_at,t.id",
        ),
        "time_entries" => (
            "time_entries t",
            "to_jsonb(t)-'workspace_id'",
            "t.logged_at DESC,t.id",
        ),
        "members" => (
            "workspace_members t",
            "to_jsonb(t)-'workspace_id'",
            "t.user_id",
        ),
        _ => return Err(Error::NotFound),
    })
}

/// Restricts private records to their owner and administrative records to administrators.
pub(super) fn push_visibility(q: &mut QueryBuilder<'_, Postgres>, kind: &str, actor: Uuid) {
    match kind {
        "views" => {
            q.push(" AND (t.shared OR t.owner=")
                .push_bind(actor)
                .push(")");
        }
        "notifications" | "alert_preferences" => {
            q.push(" AND t.user_id=").push_bind(actor);
        }
        "invitations" | "integrations" => {
            q.push(" AND EXISTS(SELECT 1 FROM workspace_members m WHERE m.workspace_id=t.workspace_id AND m.user_id=")
                .push_bind(actor)
                .push(" AND m.role IN ('owner','admin'))");
        }
        _ => {}
    }
}

pub(super) async fn collection_on(
    conn: &mut PgConnection,
    workspace: Uuid,
    actor: Uuid,
    kind: &str,
    query: Option<CollectionQuery>,
) -> Result<Vec<Value>> {
    let issue_id = query.and_then(|q| q.issue_id);
    let entity_id = query.and_then(|q| q.entity_id);
    let (table, expression, order) = collection_select(kind)?;
    let mut q = QueryBuilder::<Postgres>::new(format!(
        "SELECT {expression} FROM {table} WHERE t.workspace_id="
    ));
    q.push_bind(workspace);
    push_visibility(&mut q, kind, actor);

    match kind {
        "comments" | "time_entries" => {
            if let Some(id) = issue_id {
                q.push(" AND t.issue_id=").push_bind(id);
            }
        }
        "activity" => {
            if let Some(id) = entity_id {
                q.push(" AND t.entity_id=").push_bind(id);
            }
        }
        _ => {}
    }

    q.push(format!(" ORDER BY {order}"));
    if let Some(query) = query {
        q.push(" LIMIT ")
            .push_bind(query.limit)
            .push(" OFFSET ")
            .push_bind(query.offset);
    }

    Ok(q.build_query_scalar::<Value>().fetch_all(conn).await?)
}

impl Store {
    pub async fn list_workspaces(&self, actor: Uuid) -> Result<Vec<Value>> {
        let rows = sqlx::query!(
            "SELECT w.id,w.name,w.version FROM workspaces w JOIN workspace_members m ON m.workspace_id=w.id WHERE m.user_id=$1 ORDER BY w.name,w.id",
            actor,
        )
        .fetch_all(&self.pool)
        .await?;

        Ok(rows
            .into_iter()
            .map(|row| json!({"id":row.id,"name":row.name,"version":row.version}))
            .collect())
    }

    pub async fn workspace_metadata(&self, workspace: Uuid, actor: Uuid) -> Result<Value> {
        let mut conn = self.pool.acquire().await?;
        authorize(&mut conn, workspace, actor).await?;

        let row = sqlx::query!(
            "SELECT id,name,version FROM workspaces WHERE id=$1",
            workspace,
        )
        .fetch_one(&mut *conn)
        .await?;

        Ok(json!({"workspace":{"id":row.id,"name":row.name,"version":row.version}}))
    }

    pub async fn create_workspace(&self, name: String, actor: Uuid) -> Result<Value> {
        self.create_workspace_with_key(name, actor, None).await
    }

    pub async fn create_workspace_with_key(
        &self,
        name: String,
        actor: Uuid,
        key: Option<String>,
    ) -> Result<Value> {
        text(&name, 200)?;

        let mut tx = self.pool.begin().await?;
        if let Some(key) = &key {
            text(key, 200)?;
            sqlx::query("INSERT INTO workspace_creation_keys(actor,key,name) VALUES($1,$2,$3) ON CONFLICT DO NOTHING")
                .bind(actor)
                .bind(key)
                .bind(&name)
                .execute(&mut *tx)
                .await?;
            let row = sqlx::query("SELECT name,result FROM workspace_creation_keys WHERE actor=$1 AND key=$2 FOR UPDATE")
                .bind(actor)
                .bind(key)
                .fetch_one(&mut *tx)
                .await?;
            if row.try_get::<String, _>("name")? != name {
                return Err(Error::Conflict(
                    "idempotency key reused for a different workspace".into(),
                ));
            }
            if let Some(result) = row.try_get::<Option<Value>, _>("result")? {
                return Ok(result);
            }
        }

        let id = Uuid::new_v4();
        sqlx::query("INSERT INTO workspaces(id,name) VALUES($1,$2)")
            .bind(id)
            .bind(&name)
            .execute(&mut *tx)
            .await?;
        sqlx::query(
            "INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner')",
        )
        .bind(id)
        .bind(actor)
        .execute(&mut *tx)
        .await?;

        let result = json!({"id":id,"name":name,"version":1});
        if let Some(key) = key {
            sqlx::query("UPDATE workspace_creation_keys SET result=$3 WHERE actor=$1 AND key=$2")
                .bind(actor)
                .bind(key)
                .bind(&result)
                .execute(&mut *tx)
                .await?;
        }
        tx.commit().await?;

        Ok(result)
    }

    pub async fn get_issue(&self, workspace: Uuid, actor: Uuid, id: Uuid) -> Result<Issue> {
        let mut conn = self.pool.acquire().await?;
        authorize(&mut conn, workspace, actor).await?;
        issue_on(&mut conn, workspace, id, false).await
    }

    pub async fn list_issues(
        &self,
        workspace: Uuid,
        actor: Uuid,
        filter: IssueFilter,
        limit: i64,
        offset: i64,
    ) -> Result<Value> {
        bounds(limit, offset)?;
        let cursor = decode_issue_cursor(&filter, workspace, offset)?;
        let search = filter.search.as_deref().filter(|s| !s.trim().is_empty());
        if filter.search.as_ref().is_some_and(|s| s.len() > 200) {
            return Err(Error::BadRequest("search query too long".into()));
        }

        let mut conn = self.pool.acquire().await?;
        authorize(&mut conn, workspace, actor).await?;

        let mut q = QueryBuilder::<Postgres>::new("WITH ");
        if let Some(search) = search {
            push_issue_search(&mut q, workspace, &filter, search)?;
        }
        q.push("issue_page AS MATERIALIZED (SELECT i.id,i.updated_at,i.position,i.number,i.deadline,i.priority,i.stage_id,i.assignee FROM issues i WHERE ");
        push_issue_filters(&mut q, workspace, &filter)?;
        if search.is_some() {
            q.push(" AND i.id IN (SELECT id FROM search_matches)");
        }
        if let Some(cursor) = cursor {
            // Updated uses descending timestamps and ascending UUIDs, including at ties.
            // The explicit upper bound lets the index start at the cursor timestamp
            // instead of scanning all newer rows before applying the tie predicate.
            q.push(" AND i.updated_at<=")
                .push_bind(cursor.updated_at)
                .push(" AND (i.updated_at<")
                .push_bind(cursor.updated_at)
                .push(" OR (i.updated_at=")
                .push_bind(cursor.updated_at)
                .push(" AND i.id>")
                .push_bind(cursor.id)
                .push("))");
        }
        push_issue_order(&mut q, &filter);
        q.push(" LIMIT ")
            .push_bind(limit + 1)
            .push(" OFFSET ")
            .push_bind(offset);
        let expression = match filter.projection {
            IssueProjection::Full => ISSUE_JSON,
            IssueProjection::Summary => ISSUE_SUMMARY_JSON,
        };
        q.push(format!(
            ") SELECT {expression} FROM issue_page p JOIN issues i ON i.id=p.id"
        ));
        push_issue_order(&mut q, &filter);
        let mut items = q
            .build_query_scalar::<Value>()
            .fetch_all(&mut *conn)
            .await?;
        let has_more = items.len() > limit as usize;
        items.truncate(limit as usize);
        let next_cursor = if has_more && updated_cursor_sort(&filter) {
            let last = items
                .last()
                .ok_or_else(|| Error::Internal("missing last issue".into()))?;
            Some(URL_SAFE_NO_PAD.encode(serde_json::to_vec(&IssueCursor {
                version: 1,
                workspace,
                scope: cursor_scope(&filter)?,
                updated_at: serde_json::from_value(last["updated_at"].clone())?,
                id: serde_json::from_value(last["id"].clone())?,
            })?))
        } else {
            None
        };
        let mut result = page(items, limit, offset);
        result["has_more"] = json!(has_more);
        result["next_offset"] = json!(if has_more && filter.after.is_none() {
            Some(offset + limit)
        } else {
            None
        });
        result["next_cursor"] = json!(next_cursor);
        Ok(result)
    }

    pub async fn collection(
        &self,
        workspace: Uuid,
        actor: Uuid,
        kind: &str,
        query: CollectionQuery,
    ) -> Result<Value> {
        bounds(query.limit, query.offset)?;

        let mut conn = self.pool.acquire().await?;
        authorize(&mut conn, workspace, actor).await?;

        let rows = collection_on(
            &mut conn,
            workspace,
            actor,
            kind,
            Some(CollectionQuery {
                limit: query.limit + 1,
                ..query
            }),
        )
        .await?;

        Ok(page(rows, query.limit, query.offset))
    }

    pub async fn member_profiles(
        &self,
        workspace: Uuid,
        actor: Uuid,
        search: Option<&str>,
    ) -> Result<Value> {
        if search.is_some_and(|s| s.len() > 200) {
            return Err(Error::BadRequest("search query too long".into()));
        }

        let mut conn = self.pool.acquire().await?;
        authorize(&mut conn, workspace, actor).await?;

        let search = search.map(|s| {
            format!(
                "%{}%",
                s.replace('\\', "\\\\")
                    .replace('%', "\\%")
                    .replace('_', "\\_")
            )
        });
        let rows: Vec<Value> = sqlx::query_scalar(&format!("SELECT {MEMBER_JSON} FROM workspace_members m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=$1 AND ($2::text IS NULL OR u.email ILIKE $2 OR u.profile->>'display_name' ILIKE $2) ORDER BY lower(u.profile->>'display_name'),u.id LIMIT 2000"))
            .bind(workspace)
            .bind(search)
            .fetch_all(&mut *conn)
            .await?;

        Ok(json!(rows))
    }
}

impl Store {
    pub async fn report_sql(&self, workspace: Uuid, actor: Uuid) -> Result<Value> {
        let mut conn = self.pool.acquire().await?;
        authorize(&mut conn, workspace, actor).await?;

        let sql = r#"
WITH work AS (
 SELECT i.*,s.kind IN ('done','cancelled') AS done FROM issues i JOIN stages s ON s.id=i.stage_id WHERE i.workspace_id=$1
), minutes AS (
 SELECT e.issue_id,e.user_id,e.minutes,i.team_id,i.project_id FROM time_entries e JOIN work i ON i.id=e.issue_id WHERE e.workspace_id=$1
), totals AS (
 SELECT 'issues' AS category,issue_id AS id,sum(minutes)::bigint AS minutes,0::bigint AS open_issues,0::bigint AS effort FROM minutes GROUP BY issue_id
 UNION ALL SELECT 'people',user_id,sum(minutes)::bigint,0,0 FROM minutes GROUP BY user_id
 UNION ALL SELECT 'teams',team_id,sum(minutes)::bigint,0,0 FROM minutes GROUP BY team_id
 UNION ALL SELECT 'projects',project_id,sum(minutes)::bigint,0,0 FROM minutes WHERE project_id IS NOT NULL GROUP BY project_id
 UNION ALL SELECT 'issues',id,0,1,COALESCE(estimate,0) FROM work WHERE deleted_at IS NULL AND archived_at IS NULL AND NOT done
 UNION ALL SELECT 'people',assignee,0,1,COALESCE(estimate,0) FROM work WHERE deleted_at IS NULL AND archived_at IS NULL AND NOT done AND assignee IS NOT NULL
 UNION ALL SELECT 'teams',team_id,0,1,COALESCE(estimate,0) FROM work WHERE deleted_at IS NULL AND archived_at IS NULL AND NOT done
 UNION ALL SELECT 'projects',project_id,0,1,COALESCE(estimate,0) FROM work WHERE deleted_at IS NULL AND archived_at IS NULL AND NOT done AND project_id IS NOT NULL
), grouped AS (
 SELECT category,id,sum(minutes)::bigint AS minutes,sum(open_issues)::bigint AS open_issues,sum(effort)::bigint AS effort FROM totals GROUP BY category,id
), category_rows AS (
 SELECT category,jsonb_agg(jsonb_build_object('id',g.id,'minutes',g.minutes,'open_issues',g.open_issues,'effort',g.effort) || CASE WHEN category='issues' THEN jsonb_build_object('title',i.title,'number',i.number) ELSE '{}'::jsonb END ORDER BY g.id) AS rows FROM grouped g LEFT JOIN work i ON category='issues' AND i.id=g.id GROUP BY category
), sprint_rows AS (
 SELECT s.id,COALESCE(o.total,count(i.id)) AS total,COALESCE(o.completed,count(i.id) FILTER(WHERE i.done)) AS completed,COALESCE(o.effort,COALESCE(sum(i.estimate),0)::bigint) AS effort FROM sprints s LEFT JOIN sprint_outcomes o ON o.sprint_id=s.id LEFT JOIN work i ON i.sprint_id=s.id AND i.deleted_at IS NULL WHERE s.workspace_id=$1 GROUP BY s.id,o.total,o.completed,o.effort
), delivery_rows AS (
 SELECT (at AT TIME ZONE 'UTC')::date::text AS date,count(*) AS completed FROM activity WHERE workspace_id=$1 AND action='issue_completed' GROUP BY (at AT TIME ZONE 'UTC')::date
), label_rows AS (
 SELECT l.id,count(i.id) AS count FROM labels l LEFT JOIN issue_labels il ON il.label_id=l.id LEFT JOIN work i ON i.id=il.issue_id AND i.deleted_at IS NULL AND i.archived_at IS NULL WHERE l.workspace_id=$1 GROUP BY l.id
), project_rows AS (
 SELECT p.id,count(i.id) AS total,count(i.id) FILTER(WHERE i.done) AS completed,max(i.updated_at) AS updated_at,
 COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM (SELECT i2.team_id AS id,count(*) AS total,count(*) FILTER(WHERE i2.done) AS completed FROM work i2 WHERE i2.project_id=p.id AND i2.deleted_at IS NULL AND i2.archived_at IS NULL GROUP BY i2.team_id) t),'[]'::jsonb) AS teams,
 COALESCE((SELECT jsonb_agg(to_jsonb(m) ORDER BY m.id) FROM (SELECT i2.milestone_id AS id,count(*) AS total,count(*) FILTER(WHERE i2.done) AS completed FROM work i2 WHERE i2.project_id=p.id AND i2.deleted_at IS NULL AND i2.archived_at IS NULL AND i2.milestone_id IS NOT NULL GROUP BY i2.milestone_id) m),'[]'::jsonb) AS milestones
 FROM projects p LEFT JOIN work i ON i.project_id=p.id AND i.deleted_at IS NULL AND i.archived_at IS NULL WHERE p.workspace_id=$1 GROUP BY p.id
)
SELECT jsonb_build_object(
 'total_minutes',(SELECT COALESCE(sum(minutes),0)::bigint FROM time_entries WHERE workspace_id=$1),
 'issues',COALESCE((SELECT rows FROM category_rows WHERE category='issues'),'[]'::jsonb),
 'people',COALESCE((SELECT rows FROM category_rows WHERE category='people'),'[]'::jsonb),
 'teams',COALESCE((SELECT rows FROM category_rows WHERE category='teams'),'[]'::jsonb),
 'projects',COALESCE((SELECT rows FROM category_rows WHERE category='projects'),'[]'::jsonb),
 'sprints',COALESCE((SELECT jsonb_agg(to_jsonb(s) ORDER BY s.id) FROM sprint_rows s),'[]'::jsonb),
 'delivery',COALESCE((SELECT jsonb_agg(to_jsonb(d) ORDER BY d.date) FROM delivery_rows d),'[]'::jsonb),
 'issue_count',(SELECT count(*) FROM work WHERE deleted_at IS NULL AND archived_at IS NULL),
 'inbox_unread',(SELECT count(*) FROM notifications WHERE workspace_id=$1 AND user_id=$2 AND read_at IS NULL),
 'label_counts',COALESCE((SELECT jsonb_object_agg(id::text,count) FROM label_rows),'{}'::jsonb),
 'project_stats',COALESCE((SELECT jsonb_agg(to_jsonb(p) ORDER BY p.id) FROM project_rows p),'[]'::jsonb))
"#;

        Ok(sqlx::query_scalar(sql)
            .bind(workspace)
            .bind(actor)
            .fetch_one(&mut *conn)
            .await?)
    }
}
