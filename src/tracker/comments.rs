//! Inbound comments. Activities are fetched before the page transaction, only for items
//! whose remote modification time moved since their comments were last imported; the
//! page transaction inserts the missing ones. Local comments are never edited or deleted.
use super::{
    ProviderKind,
    provider::{Endpoint, RemoteComment, RemoteIssue},
};
use crate::{
    domain::{AlertKind, TrackerLink},
    error::{Error, Result},
    store::{Store, persistence},
};
use chrono::{DateTime, Utc};
use sqlx::PgConnection;
use std::{
    collections::{BTreeMap, BTreeSet},
    hash::{DefaultHasher, Hash, Hasher},
    time::Duration,
};
use uuid::Uuid;

/// Clock skew allowed between us and the provider when matching a sent comment.
pub(super) const SKEW: chrono::TimeDelta = chrono::TimeDelta::minutes(5);
/// Comment listings per page, one per item at most.
const MAX_FETCHES: usize = 50;
/// One slow listing cannot take the whole comment budget of a job.
const LISTING_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_BODY: usize = 100_000;
const MAX_COMMENTS: i64 = 20_000;

/// Lists comments of the page's items that are new or changed since their last complete
/// comment import, skipping trashed issues; a failed listing maps to None. Items that
/// fail or miss the deadline are retried when seen again: the next incremental scan if
/// they change, else the next full scan after discovery. Items never listed go first,
/// then the longest since their last listing, rotating among equals per scan, so a slow
/// or failing item cannot starve the rest. With listings taking well under a second, a
/// first import of a large workspace takes about one listing per item, e.g. 5,000 items
/// in roughly 20–40 minutes of back-to-back scan jobs.
pub(super) async fn fetch(
    store: &Store,
    connection: Uuid,
    provider: ProviderKind,
    endpoint: &Endpoint<'_>,
    items: &[RemoteIssue],
    scan: DateTime<Utc>,
    deadline: tokio::time::Instant,
) -> Result<BTreeMap<String, Option<Vec<RemoteComment>>>> {
    let ids: Vec<&str> = items.iter().map(|item| item.id.as_str()).collect();
    let rows: Vec<(serde_json::Value, bool)> = sqlx::query_as("SELECT tracker,deleted_at IS NOT NULL FROM issues WHERE tracker->>'connection_id'=$1 AND tracker->>'remote_id'=ANY($2)")
        .bind(connection.to_string()).bind(&ids).fetch_all(&store.pool).await?;
    let mut links = BTreeMap::new();
    for (link, trashed) in rows {
        let link: TrackerLink = serde_json::from_value(link)?;
        let progress = (!trashed).then_some(Listing {
            imported: link.comments_imported,
            at: link.comments_at,
            tried: link.comments_tried_at,
        });
        links.insert(link.remote_id, progress);
    }
    let mut fetched = BTreeMap::new();
    for item in due(items, &links, scan).into_iter().take(MAX_FETCHES) {
        if tokio::time::Instant::now() >= deadline {
            tracing::debug!(
                listed = fetched.len(),
                "Tracker comment fetching reached its deadline"
            );
            break;
        }
        let limit = deadline.min(tokio::time::Instant::now() + LISTING_TIMEOUT);
        let listing = tokio::time::timeout_at(limit, provider.comments(endpoint, &item.id)).await;
        let comments = match listing {
            Ok(Ok(Ok(comments))) => Some(comments),
            Ok(Ok(Err(outcome))) => {
                tracing::debug!(remote_id = %item.id, outcome = ?outcome,
                    "Tracker comments skipped for an item");
                None
            }
            Ok(Err(error)) => {
                tracing::debug!(remote_id = %item.id, error = %super::failure_message(&error),
                    "Tracker comments skipped for an item");
                None
            }
            Err(_) => {
                tracing::debug!(remote_id = %item.id, "Tracker comment listing timed out");
                None
            }
        };
        fetched.insert(item.id.clone(), comments);
    }
    Ok(fetched)
}

/// Comment import progress of a link: whether history was imported, the remote
/// modification time of the last complete import, and the last listing.
struct Listing {
    imported: bool,
    at: Option<DateTime<Utc>>,
    tried: Option<DateTime<Utc>>,
}

/// Progress by remote ID; None for trashed issues.
type Progress = BTreeMap<String, Option<Listing>>;

/// Items to list, in order: never listed first, then the longest since their last
/// listing, rotating among equals by scan.
fn due<'a>(
    items: &'a [RemoteIssue],
    links: &Progress,
    scan: DateTime<Utc>,
) -> Vec<&'a RemoteIssue> {
    let mut due: Vec<_> = items
        .iter()
        .filter_map(|item| match links.get(&item.id) {
            None => Some((None, item)),
            Some(None) => None,
            Some(Some(link)) => (!link.imported || link.at.is_none() || link.at != item.updated_at)
                .then_some((link.tried, item)),
        })
        .collect();
    due.sort_by_cached_key(|(tried, item)| {
        let mut hasher = DefaultHasher::new();
        (&item.id, scan).hash(&mut hasher);
        (*tried, hasher.finish())
    });
    due.into_iter().map(|(_, item)| item).collect()
}

/// A remote comment for a local issue, with its author already mapped.
pub(super) struct Incoming<'a> {
    pub issue: Uuid,
    /// History of a link whose comments were never imported: no notifications.
    pub silent: bool,
    pub comment: &'a RemoteComment,
    /// The mapped member; None imports as the tracker actor.
    pub author: Option<Uuid>,
    pub author_name: Option<String>,
}

/// Inserts comments not yet linked and returns the issues with comments left out: those
/// past the workspace limit, and the integration account's comments on an issue with a
/// comment push that may have reached the provider, which that push adopts or rules out.
pub(super) async fn import(
    conn: &mut PgConnection,
    workspace: Uuid,
    connection: Uuid,
    provider: ProviderKind,
    incoming: Vec<Incoming<'_>>,
) -> Result<BTreeSet<Uuid>> {
    let mut incomplete = BTreeSet::new();
    if incoming.is_empty() {
        return Ok(incomplete);
    }
    let remote_ids: Vec<&str> = incoming
        .iter()
        .map(|item| item.comment.id.as_str())
        .collect();
    let known: BTreeSet<String> = sqlx::query_scalar("SELECT tracker->>'remote_id' FROM comments WHERE workspace_id=$1 AND tracker->>'connection_id'=$2 AND tracker->>'remote_id'=ANY($3)")
        .bind(workspace).bind(connection.to_string()).bind(&remote_ids)
        .fetch_all(&mut *conn).await?.into_iter().collect();
    let issues: Vec<Uuid> = incoming.iter().map(|item| item.issue).collect();
    // The account that sent each uncertain push; when unknown, every comment on the issue waits.
    let uncertain: Vec<(Uuid, Option<String>)> = sqlx::query_as("SELECT issue_id,sent_account FROM tracker_outbox WHERE connection_id=$1 AND kind='comment' AND sent_at IS NOT NULL AND issue_id=ANY($2)")
        .bind(connection).bind(&issues).fetch_all(&mut *conn).await?;
    let mut held = 0;
    let mut incoming: Vec<_> = incoming
        .into_iter()
        .filter(|item| !known.contains(&item.comment.id))
        .filter(|item| {
            let hold = uncertain.iter().any(|(issue, account)| {
                *issue == item.issue && (account.is_none() || item.comment.author_id == *account)
            });
            if hold {
                held += 1;
                incomplete.insert(item.issue);
            }
            !hold
        })
        .collect();
    if held > 0 {
        tracing::debug!(held, "Tracker comments held back until their push resolves");
    }
    if incoming.is_empty() {
        return Ok(incomplete);
    }
    let mut count = None;
    let room = match persistence::capacity(
        conn,
        workspace,
        "comments",
        MAX_COMMENTS,
        &mut count,
        "",
    )
    .await
    {
        Ok(()) => MAX_COMMENTS - count.unwrap_or_default(),
        Err(Error::BadRequest(_)) => 0,
        Err(error) => return Err(error),
    };
    let room = room.max(0) as usize;
    if incoming.len() > room {
        tracing::debug!(
            skipped = incoming.len() - room,
            "Tracker comments skipped: workspace comment capacity reached"
        );
        incomplete.extend(incoming.drain(room..).map(|item| item.issue));
    }
    if incoming.is_empty() {
        return Ok(incomplete);
    }
    let actor = persistence::tracker_actor(conn, workspace).await?;
    let ids: Vec<Uuid> = incoming.iter().map(|_| Uuid::new_v4()).collect();
    let issues: Vec<Uuid> = incoming.iter().map(|item| item.issue).collect();
    let authors: Vec<Uuid> = incoming
        .iter()
        .map(|item| item.author.unwrap_or(actor))
        .collect();
    let bodies: Vec<&str> = incoming
        .iter()
        .map(|item| truncate(&item.comment.body))
        .collect();
    let created: Vec<DateTime<Utc>> = incoming
        .iter()
        .map(|item| item.comment.created_at)
        .collect();
    let trackers: Vec<serde_json::Value> = incoming
        .iter()
        .map(|item| {
            link(
                provider,
                connection,
                &item.comment.id,
                item.author_name.as_deref(),
            )
        })
        .collect();
    let inserted: BTreeSet<Uuid> = sqlx::query_scalar("INSERT INTO comments(id,workspace_id,issue_id,author,body,created_at,tracker) SELECT input.id,$1,input.issue_id,input.author,input.body,input.created_at,input.tracker FROM unnest($2::uuid[],$3::uuid[],$4::uuid[],$5::text[],$6::timestamptz[],$7::jsonb[]) AS input(id,issue_id,author,body,created_at,tracker) ON CONFLICT((tracker->>'connection_id'),(tracker->>'remote_id')) WHERE tracker IS NOT NULL DO NOTHING RETURNING id")
        .bind(workspace).bind(&ids).bind(&issues).bind(&authors).bind(&bodies).bind(&created).bind(&trackers)
        .fetch_all(&mut *conn).await?.into_iter().collect();
    tracing::debug!(
        inserted = inserted.len(),
        "Tracker comments imported in page transaction"
    );
    let notify: Vec<(Uuid, &Incoming)> = ids
        .into_iter()
        .zip(&incoming)
        .filter(|(id, item)| !item.silent && inserted.contains(id))
        .collect();
    notify_followers(conn, workspace, actor, &notify).await?;
    Ok(incomplete)
}

/// Comment tracker metadata; `author_name` is set for imported comments.
pub(super) fn link(
    provider: ProviderKind,
    connection: Uuid,
    remote_id: &str,
    author_name: Option<&str>,
) -> serde_json::Value {
    serde_json::json!({"provider":provider.key(),"connection_id":connection,"remote_id":remote_id,"author_name":author_name})
}

/// Followers other than the author get a reply notification, as for local comments.
async fn notify_followers(
    conn: &mut PgConnection,
    workspace: Uuid,
    actor: Uuid,
    comments: &[(Uuid, &Incoming<'_>)],
) -> Result<()> {
    if comments.is_empty() {
        return Ok(());
    }
    let issues: Vec<Uuid> = comments.iter().map(|(_, item)| item.issue).collect();
    let rows: Vec<(Uuid, Uuid)> = sqlx::query_as("SELECT issue_id,user_id FROM issue_followers WHERE workspace_id=$1 AND issue_id=ANY($2) ORDER BY issue_id,user_id")
        .bind(workspace).bind(&issues).fetch_all(&mut *conn).await?;
    for (id, item) in comments {
        let author = item.author.unwrap_or(actor);
        for (_, user) in rows
            .iter()
            .filter(|(issue, user)| *issue == item.issue && *user != author)
        {
            persistence::notify(
                conn,
                workspace,
                *user,
                Some(item.issue),
                AlertKind::Reply,
                truncate(&item.comment.body).to_owned(),
                format!("reply:{id}:{user}"),
            )
            .await?;
        }
    }
    Ok(())
}

/// Bodies beyond the local limit are cut at a character boundary.
fn truncate(body: &str) -> &str {
    let mut end = body.len().min(MAX_BODY);
    while !body.is_char_boundary(end) {
        end -= 1;
    }
    &body[..end]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn listings_put_never_listed_then_stalest_listings_first_and_rotate_ties() {
        let at = |hour: u32| {
            chrono::NaiveDate::from_ymd_opt(2026, 10, 1)
                .unwrap()
                .and_hms_opt(hour, 0, 0)
                .unwrap()
                .and_utc()
        };
        let items: Vec<RemoteIssue> = (1..=12)
            .map(|id| RemoteIssue {
                id: id.to_string(),
                project_id: "1".into(),
                parent_id: None,
                title: String::new(),
                description: String::new(),
                assignee_id: None,
                author_id: None,
                status_id: "1".into(),
                status_name: None,
                priority: Default::default(),
                deadline: None,
                updated_at: Some(at(12)),
                url: String::new(),
            })
            .collect();
        let link = |imported, at: Option<DateTime<Utc>>, tried| {
            Some(Listing {
                imported,
                at,
                tried,
            })
        };
        let mut links: Progress = (5..=12)
            .map(|id| (id.to_string(), link(true, Some(at(10)), Some(at(10)))))
            .collect();
        // Never imported but tried recently, never listed, up to date, trashed, and
        // changed after a listing long ago.
        links.insert("1".into(), link(false, None, Some(at(11))));
        links.insert("2".into(), link(true, Some(at(12)), Some(at(12))));
        links.insert("3".into(), None);
        links.insert("4".into(), link(true, Some(at(8)), Some(at(8))));
        links.insert("6".into(), link(true, Some(at(6)), None));
        let order = |scan| -> Vec<&str> {
            due(&items, &links, at(scan))
                .into_iter()
                .map(|item| item.id.as_str())
                .collect()
        };
        let first = order(0);
        assert_eq!(first.len(), 10, "up to date and trashed items are skipped");
        assert_eq!(first[..2], ["6", "4"]);
        assert_eq!(
            first.last(),
            Some(&"1"),
            "a failing first import waits its turn"
        );
        let rotated = (1..24).any(|scan| order(scan)[2..9] != first[2..9]);
        assert!(rotated, "equals rotate between scans");
    }

    #[test]
    fn long_bodies_are_cut_at_character_boundaries() {
        assert_eq!(truncate("short"), "short");
        let long = "é".repeat(MAX_BODY);
        let cut = truncate(&long);
        assert!(cut.len() <= MAX_BODY && cut.len() > MAX_BODY - 2);
        assert!(cut.chars().all(|c| c == 'é'));
    }
}
