use super::{DeliveryError, Job};
use crate::{
    domain::AlertKind,
    error::Result,
    store::{NewJob, Outbox, Store},
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{Row, types::Json};
use uuid::Uuid;

/// One email covering a member's unread notifications in a workspace.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Digest {
    pub workspace_id: Uuid,
    pub user_id: Uuid,
    pub notification_ids: Vec<Uuid>,
}

/// Unread notifications a member wants by email and hasn't been sent, batched per member once the
/// oldest has waited `$1`. The one-minute margin covers transactions still open with an earlier
/// `now()`, and the one-day floor keeps a backlog from flooding inboxes when mail is turned on.
const DUE_BATCHES: &str = "WITH eligible AS (\
    SELECT n.workspace_id,n.user_id,n.id,n.created_at FROM notifications n \
    JOIN workspace_members m ON m.workspace_id=n.workspace_id AND m.user_id=n.user_id \
    LEFT JOIN alert_preferences p ON p.workspace_id=n.workspace_id AND p.user_id=n.user_id \
    LEFT JOIN notification_digests d ON d.workspace_id=n.workspace_id AND d.user_id=n.user_id \
    WHERE n.read_at IS NULL \
    AND n.created_at>GREATEST(d.sent_through,now()-interval '1 day') \
    AND CASE n.kind \
        WHEN 'assignment' THEN COALESCE(p.email_assignment,true) \
        WHEN 'reply' THEN COALESCE(p.email_reply,true) \
        WHEN 'change' THEN COALESCE(p.email_change,false) \
        WHEN 'mention' THEN COALESCE(p.email_mention,true) \
        WHEN 'deadline' THEN COALESCE(p.email_deadline,true) END), \
    due AS (SELECT workspace_id,user_id FROM eligible GROUP BY workspace_id,user_id \
    HAVING min(created_at)<=now()-make_interval(mins=>$1)) \
    SELECT e.workspace_id,e.user_id,array_agg(e.id ORDER BY e.created_at,e.id),max(e.created_at) \
    FROM eligible e JOIN due USING(workspace_id,user_id) \
    WHERE e.created_at<=now()-interval '1 minute' \
    GROUP BY e.workspace_id,e.user_id";

const DELAY_MINUTES: i32 = 10;

/// Queues a digest for every member whose batch is due and advances their cursor past it.
pub(super) async fn enqueue(store: &Store) -> Result<()> {
    let mut tx = store.pool.begin().await?;
    // Concurrent workers would cut overlapping batches under different dedup keys.
    let locked: bool = sqlx::query_scalar(
        "SELECT pg_try_advisory_xact_lock(hashtextextended('notification_digests',0))",
    )
    .fetch_one(&mut *tx)
    .await?;
    if !locked {
        return Ok(());
    }

    let batches: Vec<(Uuid, Uuid, Vec<Uuid>, DateTime<Utc>)> = sqlx::query_as(DUE_BATCHES)
        .bind(DELAY_MINUTES)
        .fetch_all(&mut *tx)
        .await?;
    if batches.is_empty() {
        return Ok(());
    }

    let mut cursors = (vec![], vec![], vec![]);
    for (workspace_id, user_id, notification_ids, through) in batches {
        let key = format!(
            "digest:{workspace_id}:{user_id}:{}",
            through.timestamp_micros()
        );
        let digest = Digest {
            workspace_id,
            user_id,
            notification_ids,
        };
        Outbox::insert(&mut tx, &NewJob::now(key, Job::Digest(digest))).await?;
        cursors.0.push(workspace_id);
        cursors.1.push(user_id);
        cursors.2.push(through);
    }
    sqlx::query(
        "INSERT INTO notification_digests(workspace_id,user_id,sent_through) \
         SELECT * FROM unnest($1::uuid[],$2::uuid[],$3::timestamptz[]) \
         ON CONFLICT(workspace_id,user_id) DO UPDATE SET sent_through=EXCLUDED.sent_through",
    )
    .bind(cursors.0)
    .bind(cursors.1)
    .bind(cursors.2)
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;
    Ok(())
}

/// What a digest email says, read when it is sent.
pub(super) struct Summary {
    pub to: String,
    pub workspace: String,
    pub slug: String,
    pub entries: Vec<Entry>,
}

pub(super) struct Entry {
    pub kind: AlertKind,
    pub actor: Option<String>,
    pub fields: Vec<String>,
    pub key: String,
    pub title: String,
}

impl Digest {
    /// `None` once the member has left or read everything the digest listed.
    pub(super) async fn summary(
        &self,
        store: &Store,
    ) -> std::result::Result<Option<Summary>, DeliveryError> {
        self.load(store).await.map_err(|error| {
            tracing::warn!(user = %self.user_id, error = %error, "digest lookup failed");
            DeliveryError::Transient("digest lookup failed")
        })
    }

    async fn load(&self, store: &Store) -> Result<Option<Summary>> {
        let recipient: Option<(String, String, String)> = sqlx::query_as(
            "SELECT u.email,w.name,w.slug FROM workspace_members m \
             JOIN users u ON u.id=m.user_id JOIN workspaces w ON w.id=m.workspace_id \
             WHERE m.workspace_id=$1 AND m.user_id=$2",
        )
        .bind(self.workspace_id)
        .bind(self.user_id)
        .fetch_optional(&store.pool)
        .await?;
        let Some((to, workspace, slug)) = recipient else {
            return Ok(None);
        };

        let rows = sqlx::query(
            "SELECT n.kind,a.profile->>'display_name' AS actor,n.fields,\
             t.key||'-'||i.number AS key,i.title \
             FROM notifications n \
             JOIN issues i ON i.workspace_id=n.workspace_id AND i.id=n.issue_id \
             JOIN teams t ON t.id=i.team_id \
             LEFT JOIN users a ON a.id=n.actor_id \
             WHERE n.workspace_id=$1 AND n.user_id=$2 AND n.id=ANY($3) AND n.read_at IS NULL AND i.deleted_at IS NULL \
             ORDER BY n.created_at,n.id",
        )
        .bind(self.workspace_id)
        .bind(self.user_id)
        .bind(&self.notification_ids)
        .fetch_all(&store.pool)
        .await?;
        if rows.is_empty() {
            return Ok(None);
        }

        let entries = rows
            .iter()
            .map(|row| {
                Ok(Entry {
                    kind: serde_json::from_value(serde_json::Value::String(row.try_get("kind")?))?,
                    actor: row.try_get("actor")?,
                    fields: row.try_get::<Json<_>, _>("fields")?.0,
                    key: row.try_get("key")?,
                    title: row.try_get("title")?,
                })
            })
            .collect::<Result<_>>()?;
        Ok(Some(Summary {
            to,
            workspace,
            slug,
            entries,
        }))
    }
}
