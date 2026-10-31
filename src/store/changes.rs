use super::{
    reads::{
        ISSUE_JSON, MEMBER_JSON, SYNC_INTEGRATION_JSON, SYNC_ISSUE_JSON, collection_select,
        push_visibility,
    },
    *,
};
use serde_json::Value;
use sqlx::QueryBuilder;

/// One changed record in the requested REST or sync shape, or null when deleted or invisible.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, utoipa::ToSchema)]
pub struct Change {
    /// `workspace`, `members`, `issues`, or a workspace collection name such as `teams`.
    pub entity: String,
    pub id: Uuid,
    #[serde(default)]
    pub record: Option<Value>,
}

/// Records written by the current transaction that the actor may see, without their contents.
pub(super) async fn pending(
    conn: &mut PgConnection,
    workspace: Uuid,
    actor: Uuid,
) -> Result<Vec<Change>> {
    let rows = sqlx::query!(
        "SELECT DISTINCT entity AS \"entity!\",entity_id AS \"entity_id!\" FROM changes \
         WHERE workspace_id=$1 AND txid=pg_current_xact_id_if_assigned()::text::bigint \
         AND (user_id IS NULL OR user_id=$2) AND entity <> 'roles' ORDER BY entity,entity_id",
        workspace,
        actor,
    )
    .fetch_all(conn)
    .await?;

    Ok(rows
        .into_iter()
        .map(|row| Change {
            entity: row.entity,
            id: row.entity_id,
            record: None,
        })
        .collect())
}

#[derive(Clone, Copy)]
pub(super) enum RecordShape {
    Rest,
    Sync,
}

/// How the record column leaves the query: as `jsonb` for the driver to
/// decode, or as the JSON text itself for a caller that forwards the bytes.
#[derive(Clone, Copy)]
pub(super) enum Column {
    Json,
    Text,
}

impl Column {
    fn wrap(self, expression: &str) -> String {
        let cast = match self {
            Column::Json => "jsonb",
            Column::Text => "text",
        };
        format!("({expression})::{cast}")
    }
}

/// The same selection and visibility rules serve command responses and sync reads.
pub(super) fn select(
    workspace: Uuid,
    actor: Uuid,
    kind: &str,
    shape: RecordShape,
    column: Column,
) -> Result<QueryBuilder<'static, Postgres>> {
    let mut q = QueryBuilder::<Postgres>::new("");
    push_select(&mut q, workspace, actor, kind, shape, column)?;
    Ok(q)
}

/// Appends `SELECT <id>, <record> FROM ... WHERE <workspace and visibility>`.
fn push_select(
    q: &mut QueryBuilder<'static, Postgres>,
    workspace: Uuid,
    actor: Uuid,
    kind: &str,
    shape: RecordShape,
    column: Column,
) -> Result<()> {
    match kind {
        "workspace" => {
            q.push(format!(
                "SELECT w.id,{} FROM workspaces w WHERE w.id=",
                column.wrap(
                    "jsonb_build_object('id',w.id,'name',w.name,'slug',w.slug,'version',w.version)"
                )
            ));
        }
        "members" => {
            q.push(format!(
                "SELECT u.id,{} FROM workspace_members m JOIN users u ON u.id=m.user_id \
                 WHERE m.workspace_id=",
                column.wrap(MEMBER_JSON)
            ));
        }
        "issues" => {
            let expression = match shape {
                RecordShape::Rest => ISSUE_JSON,
                RecordShape::Sync => SYNC_ISSUE_JSON,
            };
            q.push(format!(
                "SELECT i.id,{} FROM issues i WHERE i.workspace_id=",
                column.wrap(expression)
            ));
        }
        kind => {
            let (table, expression, _) = collection_select(kind)?;
            let expression = match (kind, shape) {
                ("integrations", RecordShape::Sync) => SYNC_INTEGRATION_JSON,
                _ => expression,
            };
            q.push(format!(
                "SELECT t.{},{} FROM {table} WHERE t.workspace_id=",
                key_column(kind),
                column.wrap(expression)
            ));
        }
    }
    q.push_bind(workspace);
    if !matches!(kind, "workspace" | "members" | "issues") {
        push_visibility(q, kind, actor);
    }
    Ok(())
}

/// Fills each change with the record's current state as the actor sees it.
/// All entity kinds read in one round trip.
pub(super) async fn render(
    conn: &mut PgConnection,
    workspace: Uuid,
    actor: Uuid,
    changes: &mut [Change],
    shape: RecordShape,
) -> Result<()> {
    let mut kinds: BTreeMap<String, Vec<Uuid>> = BTreeMap::new();
    for change in changes.iter() {
        kinds
            .entry(change.entity.clone())
            .or_default()
            .push(change.id);
    }
    if kinds.is_empty() {
        return Ok(());
    }

    let mut q = QueryBuilder::<Postgres>::new("");
    for (position, (kind, ids)) in kinds.into_iter().enumerate() {
        if position > 0 {
            q.push(" UNION ALL ");
        }
        // Each branch is a complete SELECT; the kind rides along as a column.
        q.push("SELECT ")
            .push_bind(kind.clone())
            .push(" AS kind,r.* FROM (");
        push_select(&mut q, workspace, actor, &kind, shape, Column::Json)?;
        match kind.as_str() {
            "workspace" => q.push(" AND w.id=ANY("),
            "members" => q.push(" AND u.id=ANY("),
            "issues" => q.push(" AND i.id=ANY("),
            kind => q.push(format!(" AND t.{}=ANY(", key_column(kind))),
        };
        q.push_bind(ids).push(")) AS r(id,record)");
    }

    let mut records: BTreeMap<(String, Uuid), Value> = BTreeMap::new();
    for (kind, id, record) in q
        .build_query_as::<(String, Uuid, Value)>()
        .fetch_all(&mut *conn)
        .await?
    {
        records.insert((kind, id), record);
    }

    for change in changes {
        change.record = records.remove(&(change.entity.clone(), change.id));
    }

    Ok(())
}

fn key_column(kind: &str) -> &'static str {
    if kind == "alert_preferences" {
        "user_id"
    } else {
        "id"
    }
}

impl Store {
    /// Deletes change rows older than the retention period. Clients whose cursor predates them
    /// get `reset` and reload.
    pub async fn prune_changes(&self, retention_days: i32) -> Result<u64> {
        // Rows from another history carry txids that would put the horizon
        // past every cursor this database can issue.
        self.adopt_sync_history().await?;
        let mut tx = self.pool.begin().await?;

        let gone = sqlx::query!(
            "WITH gone AS (\
             DELETE FROM changes WHERE id IN (\
             SELECT id FROM changes WHERE created_at<now()-make_interval(days=>$1) \
             ORDER BY created_at,id LIMIT 10000) RETURNING txid) \
             SELECT count(*) AS \"count!\",max(txid) AS newest FROM gone",
            retention_days,
        )
        .fetch_one(&mut *tx)
        .await?;

        let Some(newest) = gone.newest else {
            return Ok(0);
        };

        sqlx::query!(
            "UPDATE change_horizon SET txid=GREATEST(txid,$1::bigint+1)",
            newest
        )
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;

        Ok(gone.count as u64)
    }
}
