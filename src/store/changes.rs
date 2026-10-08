use super::{
    reads::{ISSUE_JSON, MEMBER_JSON, collection_select, push_visibility},
    *,
};
use serde_json::Value;
use sqlx::QueryBuilder;

/// One changed record. `record` holds its current state in the shape the list endpoints return,
/// or null when it was deleted or the caller can no longer see it.
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
    let rows: Vec<(String, Uuid)> = sqlx::query_as(
        "SELECT DISTINCT entity,entity_id FROM changes \
         WHERE workspace_id=$1 AND txid=pg_current_xact_id_if_assigned()::text::bigint \
         AND (user_id IS NULL OR user_id=$2) ORDER BY entity,entity_id",
    )
    .bind(workspace)
    .bind(actor)
    .fetch_all(conn)
    .await?;

    Ok(refs(rows))
}

fn refs(rows: Vec<(String, Uuid)>) -> Vec<Change> {
    rows.into_iter()
        .map(|(entity, id)| Change {
            entity,
            id,
            record: None,
        })
        .collect()
}

/// Fills each change with the record's current state as the actor sees it.
pub(super) async fn render(
    conn: &mut PgConnection,
    workspace: Uuid,
    actor: Uuid,
    changes: &mut [Change],
) -> Result<()> {
    let role: Option<String> = sqlx::query_scalar(
        "SELECT role FROM workspace_members WHERE workspace_id=$1 AND user_id=$2",
    )
    .bind(workspace)
    .bind(actor)
    .fetch_optional(&mut *conn)
    .await?;
    let admin = matches!(role.as_deref(), Some("owner" | "admin"));

    let mut kinds: BTreeMap<String, Vec<Uuid>> = BTreeMap::new();
    for change in changes.iter() {
        kinds
            .entry(change.entity.clone())
            .or_default()
            .push(change.id);
    }

    let mut records: BTreeMap<(String, Uuid), Value> = BTreeMap::new();
    for (kind, ids) in kinds {
        let mut q = match kind.as_str() {
            "workspace" => QueryBuilder::<Postgres>::new(
                "SELECT w.id,jsonb_build_object('id',w.id,'name',w.name,'version',w.version) \
                 FROM workspaces w WHERE w.id=",
            ),
            "members" => QueryBuilder::new(format!(
                "SELECT u.id,{MEMBER_JSON} FROM workspace_members m JOIN users u ON u.id=m.user_id \
                 WHERE m.workspace_id="
            )),
            "issues" => QueryBuilder::new(format!(
                "SELECT i.id,{ISSUE_JSON} FROM issues i WHERE i.workspace_id="
            )),
            "invitations" | "integrations" if !admin => continue,
            kind => {
                let (table, expression, _) = collection_select(kind)?;
                QueryBuilder::new(format!(
                    "SELECT t.{},{expression} FROM {table} WHERE t.workspace_id=",
                    key_column(kind)
                ))
            }
        };
        q.push_bind(workspace);

        match kind.as_str() {
            "workspace" => q.push(" AND w.id=ANY("),
            "members" => q.push(" AND u.id=ANY("),
            "issues" => q.push(" AND i.id=ANY("),
            kind => {
                push_visibility(&mut q, kind, actor);
                q.push(format!(" AND t.{}=ANY(", key_column(kind)))
            }
        };
        q.push_bind(ids).push(")");

        for (id, record) in q
            .build_query_as::<(Uuid, Value)>()
            .fetch_all(&mut *conn)
            .await?
        {
            records.insert((kind.clone(), id), record);
        }
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
        let mut tx = self.pool.begin().await?;

        let (count, newest): (i64, Option<i64>) = sqlx::query_as(
            "WITH gone AS (\
             DELETE FROM changes WHERE id IN (\
             SELECT id FROM changes WHERE created_at<now()-make_interval(days=>$1) \
             ORDER BY created_at,id LIMIT 10000) RETURNING txid) \
             SELECT count(*),max(txid) FROM gone",
        )
        .bind(retention_days)
        .fetch_one(&mut *tx)
        .await?;

        let Some(newest) = newest else {
            return Ok(0);
        };

        sqlx::query("UPDATE change_horizon SET txid=GREATEST(txid,$1+1)")
            .bind(newest)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;

        Ok(count as u64)
    }
}
