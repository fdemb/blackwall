//! Sends queued local changes. Each row reads current local values, maps them to the
//! provider's identifiers and records the outcome in its own short transaction.
use super::{
    Mapping, Metadata, ProviderKind, TrackerField, TrackerOptions, comments,
    outbox::DUE,
    provider::{
        Endpoint, FieldValue, Push, PushOutcome, RemoteComment, RemotePerson, RemoteStatus,
    },
    runner::failure_message,
};
use crate::{
    domain::{Baseline, TrackerLink},
    error::{Error, Result},
    store::Store,
};
use chrono::{DateTime, NaiveDate, Utc};
use serde_json::Value;
use sqlx::Row;
use std::{collections::BTreeMap, future::Future, time::Duration};
use tokio::time::Instant;
use uuid::Uuid;

/// Rows per job; the scheduler starts another job for the rest.
const BATCH: i64 = 20;
/// Pushes finish within this long, leaving room for the scan page in the same job
/// (see `runner::COMMENTS_DEADLINE`).
const BUDGET: Duration = Duration::from_secs(30);
/// Transient failures after which a row is dropped with an error on the issue.
const MAX_ATTEMPTS: i32 = 10;

pub(super) struct Connection<'a> {
    pub id: Uuid,
    pub generation: i64,
    pub workspace: Uuid,
    pub provider: ProviderKind,
    pub endpoint: Endpoint<'a>,
    pub mappings: &'a [Mapping],
}

struct Queued {
    id: Uuid,
    issue: Uuid,
    fields: Vec<String>,
    comment: Option<Uuid>,
    revision: i64,
    attempts: i32,
    /// A comment send that may have reached the provider: when it started, the body it
    /// sent, and the remote account that sent it (unknown for sends before upgrading).
    sent: Option<(DateTime<Utc>, String, Option<String>)>,
}

enum Sent {
    Done,
    Retry,
}

/// Sends the connection's oldest due rows. A transient failure stops the batch: the
/// provider is probably unavailable, and the row waits out its backoff.
pub(super) async fn drain(store: &Store, connection: &Connection<'_>) -> Result<()> {
    let rows = sqlx::query(&format!("SELECT id,issue_id,fields,comment_id,revision,attempts,sent_at,sent_body,sent_account FROM tracker_outbox o WHERE connection_id=$1 AND {DUE} ORDER BY created_at,id LIMIT $2"))
        .bind(connection.id).bind(BATCH).fetch_all(&store.pool).await?;
    if rows.is_empty() {
        return Ok(());
    }
    let Some(mut metadata) = Metadata::load(&store.pool, connection.id).await? else {
        return Ok(());
    };
    let deadline = Instant::now() + BUDGET;
    for row in rows {
        if Instant::now() >= deadline {
            break;
        }
        // Configuration changes while the batch runs apply to the next row: a new
        // generation (disabled, deleted, credentials or mappings) stops the batch, and
        // export toggles reload.
        let Some(options) = current_options(store, connection).await? else {
            tracing::debug!(
                "Tracker push batch stopped: connection disabled, deleted or superseded"
            );
            break;
        };
        metadata.options = options;
        let row = Queued {
            id: row.try_get("id")?,
            issue: row.try_get("issue_id")?,
            fields: row.try_get("fields")?,
            comment: row.try_get("comment_id")?,
            revision: row.try_get("revision")?,
            attempts: row.try_get("attempts")?,
            sent: match row.try_get("sent_at")? {
                Some(at) => Some((at, row.try_get("sent_body")?, row.try_get("sent_account")?)),
                None => None,
            },
        };
        if let Sent::Retry = send(store, connection, &metadata, &row, deadline).await? {
            break;
        }
    }
    Ok(())
}

async fn current_options(
    store: &Store,
    connection: &Connection<'_>,
) -> Result<Option<TrackerOptions>> {
    let options: Option<Value> = sqlx::query_scalar("SELECT options FROM tracker_connections WHERE id=$1 AND generation=$2 AND enabled AND NOT deleted")
        .bind(connection.id).bind(connection.generation).fetch_optional(&store.pool).await?;
    Ok(options.map(serde_json::from_value).transpose()?)
}

/// Bounds one push by the batch deadline; expiry is an ordinary transient failure, so a
/// row that keeps timing out still reaches the attempt limit.
async fn bounded<T>(deadline: Instant, push: impl Future<Output = Result<T>>) -> Result<T> {
    tokio::time::timeout_at(deadline, push)
        .await
        .unwrap_or_else(|_| Err(Error::Internal("Tracker push timed out".into())))
}

/// Local values of a synced issue, read when the push is sent.
struct Local {
    link: TrackerLink,
    title: String,
    description: String,
    stage: Uuid,
    stage_name: String,
    assignee: Option<Uuid>,
    assignee_email: Option<String>,
    deadline: Option<DateTime<Utc>>,
}

async fn local(store: &Store, connection: &Connection<'_>, issue: Uuid) -> Result<Option<Local>> {
    let Some(row) = sqlx::query("SELECT i.title,i.description,i.stage_id,s.name AS stage_name,i.assignee,u.email,i.deadline,i.tracker FROM issues i JOIN stages s ON s.id=i.stage_id LEFT JOIN users u ON u.id=i.assignee WHERE i.workspace_id=$1 AND i.id=$2 AND i.tracker IS NOT NULL")
        .bind(connection.workspace).bind(issue).fetch_optional(&store.pool).await?
    else {
        return Ok(None);
    };
    let link: TrackerLink = serde_json::from_value(row.try_get("tracker")?)?;
    if link.connection_id != connection.id {
        return Ok(None);
    }
    Ok(Some(Local {
        link,
        title: row.try_get("title")?,
        description: row.try_get("description")?,
        stage: row.try_get("stage_id")?,
        stage_name: row.try_get("stage_name")?,
        assignee: row.try_get("assignee")?,
        assignee_email: row.try_get("email")?,
        deadline: row.try_get("deadline")?,
    }))
}

async fn send(
    store: &Store,
    connection: &Connection<'_>,
    metadata: &Metadata,
    row: &Queued,
    deadline: Instant,
) -> Result<Sent> {
    let Some(local) = local(store, connection, row.issue).await? else {
        tracing::debug!(issue_id = %row.issue, "Tracker push dropped: issue no longer linked");
        return discard(store, row).await;
    };
    let push = match row.comment {
        Some(comment) => {
            if !metadata.options.get(TrackerField::Comments).export {
                return discard(store, row).await;
            }
            let body: Option<String> = sqlx::query_scalar(
                "SELECT body FROM comments WHERE workspace_id=$1 AND id=$2 AND tracker IS NULL",
            )
            .bind(connection.workspace)
            .bind(comment)
            .fetch_optional(&store.pool)
            .await?;
            let Some(body) = body else {
                return discard(store, row).await;
            };
            Push::Comment {
                remote_id: local.link.remote_id.clone(),
                body,
            }
        }
        None => {
            let fields = row
                .fields
                .iter()
                .filter_map(|key| TrackerField::parse(key))
                .filter(|field| metadata.options.get(*field).export)
                .filter_map(|field| map_field(field, &local, connection, metadata))
                .collect::<Vec<_>>();
            if fields.is_empty() {
                return discard(store, row).await;
            }
            Push::Fields {
                remote_id: local.link.remote_id.clone(),
                fields,
            }
        }
    };
    let started = Instant::now();
    let outcome = bounded(deadline, async {
        match &push {
            Push::Comment { remote_id, body } => {
                send_comment(store, connection, row, &push, remote_id, body).await
            }
            Push::Fields { .. } => connection.provider.push(&connection.endpoint, &push).await,
        }
    })
    .await;
    tracing::debug!(issue_id = %row.issue, comment = row.comment.is_some(), elapsed_ms = started.elapsed().as_millis(),
        outcome = ?outcome.as_ref().map_err(failure_message), "Tracker push sent");
    match outcome {
        Ok(PushOutcome::Applied {
            comment_id,
            status_id,
        }) => {
            if let (Some(comment), Some(remote_id)) = (row.comment, comment_id) {
                sqlx::query("UPDATE comments SET tracker=$3 WHERE workspace_id=$1 AND id=$2")
                    .bind(connection.workspace)
                    .bind(comment)
                    .bind(comments::link(
                        connection.provider,
                        connection.id,
                        &remote_id,
                        None,
                    ))
                    .execute(&store.pool)
                    .await?;
            }
            reachable(store, connection).await?;
            let fields = match &push {
                Push::Fields { fields, .. } => fields.as_slice(),
                Push::Comment { .. } => &[],
            };
            let status_name = status_id.and_then(|id| {
                metadata
                    .statuses
                    .iter()
                    .find(|status| status.id == id)
                    .map(|status| status.name.clone())
            });
            finish(store, row, None, false, |link| {
                if let Some(name) = status_name {
                    link.status_name = name;
                }
                if let Some(baseline) = &mut link.baseline {
                    for field in fields {
                        sent(baseline, field, &local);
                    }
                }
            })
            .await
        }
        Ok(PushOutcome::Rejected(message)) => {
            reachable(store, connection).await?;
            finish(store, row, Some(message), false, |_| {}).await
        }
        Ok(PushOutcome::Unavailable(message)) => {
            unavailable(store, connection, row, &message).await
        }
        Err(error) if row.attempts + 1 >= MAX_ATTEMPTS => {
            let message = format!("Tracker push gave up: {}", failure_message(&error));
            // A newer edit restarted the row; it keeps its fresh retry state.
            finish(store, row, Some(message), true, |_| {}).await?;
            Ok(Sent::Retry)
        }
        Err(error) => {
            backoff(store, row, &failure_message(&error)).await?;
            Ok(Sent::Retry)
        }
    }
}

/// Sends a comment at most once. The row records the post, in its own statement, before
/// each send; a recorded row first adopts the copy the recorded account posted with the
/// recorded body, if any, and otherwise sends the current body. Imports hold back that
/// account's comments on the issue while the record is set.
async fn send_comment(
    store: &Store,
    connection: &Connection<'_>,
    row: &Queued,
    push: &Push,
    remote_id: &str,
    body: &str,
) -> Result<PushOutcome> {
    let account = match account(store, connection).await? {
        Ok(account) => account,
        Err(refused) => return Ok(refused),
    };
    if let Some((sent_at, sent_body, sent_account)) = &row.sent {
        let comments = match connection
            .provider
            .comments(&connection.endpoint, remote_id)
            .await?
        {
            Ok(comments) => comments,
            Err(refused) => return Ok(refused),
        };
        let linked: Vec<String> = sqlx::query_scalar("SELECT tracker->>'remote_id' FROM comments WHERE workspace_id=$1 AND issue_id=$2 AND tracker->>'connection_id'=$3")
            .bind(connection.workspace).bind(row.issue).bind(connection.id.to_string())
            .fetch_all(&store.pool).await?;
        let window = (*sent_at - comments::SKEW, Utc::now() + comments::SKEW);
        let sender = sent_account.as_deref().unwrap_or(&account);
        if let Some(id) = adoptable(&comments, sender, sent_body, window, &linked) {
            tracing::debug!(issue_id = %row.issue, "Tracker comment already on the remote; adopting it");
            return Ok(PushOutcome::Applied {
                comment_id: Some(id.to_owned()),
                status_id: None,
            });
        }
    }
    // An earlier send was ruled out above, so this one replaces its record.
    sqlx::query(
        "UPDATE tracker_outbox SET sent_at=clock_timestamp(),sent_body=$2,sent_account=$3 WHERE id=$1",
    )
    .bind(row.id)
    .bind(body)
    .bind(&account)
    .execute(&store.pool)
    .await?;
    let outcome = connection.provider.push(&connection.endpoint, push).await;
    if let Ok(PushOutcome::Rejected(_) | PushOutcome::Unavailable(_)) = &outcome {
        // Refused, so nothing was posted; an earlier send was ruled out above.
        sqlx::query(
            "UPDATE tracker_outbox SET sent_at=NULL,sent_body=NULL,sent_account=NULL WHERE id=$1",
        )
        .bind(row.id)
        .execute(&store.pool)
        .await?;
    }
    outcome
}

/// The integration account's remote user, looked up once until the credentials change.
async fn account(
    store: &Store,
    connection: &Connection<'_>,
) -> Result<std::result::Result<String, PushOutcome>> {
    let cached: Option<Option<String>> = sqlx::query_scalar(
        "SELECT remote_user_id FROM tracker_connections WHERE id=$1 AND generation=$2",
    )
    .bind(connection.id)
    .bind(connection.generation)
    .fetch_optional(&store.pool)
    .await?;
    if let Some(Some(account)) = cached {
        return Ok(Ok(account));
    }
    let found = connection.provider.account(&connection.endpoint).await?;
    if let Ok(account) = &found {
        sqlx::query(
            "UPDATE tracker_connections SET remote_user_id=$3 WHERE id=$1 AND generation=$2",
        )
        .bind(connection.id)
        .bind(connection.generation)
        .bind(account)
        .execute(&store.pool)
        .await?;
    }
    Ok(found)
}

/// The oldest comment with this body that the integration account created within the
/// window and that is not linked yet. The account's identical comments in that window
/// are the same post for our purposes.
fn adoptable<'a>(
    comments: &'a [RemoteComment],
    account: &str,
    body: &str,
    (since, until): (DateTime<Utc>, DateTime<Utc>),
    linked: &[String],
) -> Option<&'a str> {
    comments
        .iter()
        .filter(|comment| {
            comment.author_id.as_deref() == Some(account)
                && comment.body == body
                && (since..=until).contains(&comment.created_at)
                && !linked.contains(&comment.id)
        })
        .min_by_key(|comment| comment.created_at)
        .map(|comment| comment.id.as_str())
}

/// Delays a failed row by a doubling backoff (30s up to an hour), unless a newer edit
/// restarted it meanwhile.
async fn backoff(store: &Store, row: &Queued, message: &str) -> Result<()> {
    sqlx::query("UPDATE tracker_outbox SET attempts=attempts+1,last_error=$3,retry_at=clock_timestamp()+make_interval(secs=>least(30*power(2,attempts),3600)) WHERE id=$1 AND revision=$2")
        .bind(row.id).bind(row.revision).bind(message).execute(&store.pool).await?;
    Ok(())
}

/// Keeps the row without counting towards giving up, and reports the problem on the
/// connection until a push goes through or the configuration changes.
async fn unavailable(
    store: &Store,
    connection: &Connection<'_>,
    row: &Queued,
    message: &str,
) -> Result<Sent> {
    let mut tx = store.pool.begin().await?;
    sqlx::query("UPDATE tracker_outbox SET last_error=$3,retry_at=clock_timestamp()+interval '5 minutes' WHERE id=$1 AND revision=$2")
        .bind(row.id).bind(row.revision).bind(message).execute(&mut *tx).await?;
    sqlx::query(
        "UPDATE tracker_connections SET push_error=$3 WHERE id=$1 AND generation=$2 AND NOT deleted",
    )
    .bind(connection.id)
    .bind(connection.generation)
    .bind(message)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(Sent::Retry)
}

/// The provider accepted or judged a push, so the connection may push again.
async fn reachable(store: &Store, connection: &Connection<'_>) -> Result<()> {
    sqlx::query("UPDATE tracker_connections SET push_error=NULL WHERE id=$1 AND generation=$2 AND push_error IS NOT NULL")
        .bind(connection.id).bind(connection.generation).execute(&store.pool).await?;
    Ok(())
}

/// Removes the row unless more fields coalesced into it meanwhile.
async fn discard(store: &Store, row: &Queued) -> Result<Sent> {
    delete(&store.pool, row).await?;
    Ok(Sent::Done)
}

/// Whether the row was still at the sent revision.
async fn delete<'c>(conn: impl sqlx::PgExecutor<'c>, row: &Queued) -> Result<bool> {
    let deleted = sqlx::query("DELETE FROM tracker_outbox WHERE id=$1 AND revision=$2")
        .bind(row.id)
        .bind(row.revision)
        .execute(conn)
        .await?
        .rows_affected();
    Ok(deleted > 0)
}

/// Discards the row and records the outcome on the issue link: `error` replaces
/// `push_error`, and `update` records what was sent. Neither bumps the issue version or
/// adds activity; the change feed still reports the link. With `current_only`, nothing
/// is recorded once a newer edit changed the row.
async fn finish(
    store: &Store,
    row: &Queued,
    error: Option<String>,
    current_only: bool,
    update: impl FnOnce(&mut TrackerLink),
) -> Result<Sent> {
    let mut tx = store.pool.begin().await?;
    // Lock the issue before the row, as enqueueing commands do.
    let link: Option<serde_json::Value> = sqlx::query_scalar(
        "SELECT tracker FROM issues WHERE id=$1 AND tracker IS NOT NULL FOR UPDATE",
    )
    .bind(row.issue)
    .fetch_optional(&mut *tx)
    .await?;
    if !delete(&mut *tx, row).await? && current_only {
        return Ok(Sent::Done);
    }
    if let Some(link) = link {
        let mut link: TrackerLink = serde_json::from_value(link)?;
        let before = link.clone();
        update(&mut link);
        link.push_error = error;
        if link != before {
            sqlx::query("UPDATE issues SET tracker=$2 WHERE id=$1")
                .bind(row.issue)
                .bind(serde_json::to_value(&link)?)
                .execute(&mut *tx)
                .await?;
        }
    }
    tx.commit().await?;
    Ok(Sent::Done)
}

/// Moves the baseline to a sent value, as the next import will normalize it, so the
/// import does not mistake the push for a remote change.
fn sent(baseline: &mut Baseline, field: &FieldValue, local: &Local) {
    match field {
        FieldValue::Status(_) => baseline.stage_id = local.stage,
        FieldValue::Title(title) => baseline.title.clone_from(title),
        FieldValue::Description(description) => baseline.description.clone_from(description),
        FieldValue::Assignee(_) => baseline.assignee = local.assignee,
        FieldValue::DueDate(date) => baseline.deadline = date.map(midnight),
    }
}

/// Date-only providers report deadlines as midnight UTC.
fn midnight(date: NaiveDate) -> DateTime<Utc> {
    date.and_time(chrono::NaiveTime::MIN).and_utc()
}

/// Maps one local field to the provider, or None when it has no remote counterpart.
fn map_field(
    field: TrackerField,
    local: &Local,
    connection: &Connection<'_>,
    metadata: &Metadata,
) -> Option<FieldValue> {
    let value = match field {
        TrackerField::Title => Some(FieldValue::Title(local.title.clone())),
        TrackerField::Description => Some(FieldValue::Description(local.description.clone())),
        TrackerField::DueDate => Some(FieldValue::DueDate(
            local.deadline.map(|deadline| deadline.date_naive()),
        )),
        TrackerField::Status => {
            let mapping = connection
                .mappings
                .iter()
                .find(|mapping| mapping.project_id == local.link.project_id);
            let statuses = statuses(mapping, &metadata.statuses, local.stage, &local.stage_name);
            (!statuses.is_empty()).then_some(FieldValue::Status(statuses))
        }
        TrackerField::Assignee => match local.assignee {
            None => Some(FieldValue::Assignee(None)),
            Some(member) => person(
                &metadata.people,
                &metadata.people_mapping,
                member,
                local.assignee_email.as_deref(),
            )
            .map(|id| FieldValue::Assignee(Some(id))),
        },
        TrackerField::Priority | TrackerField::Parent | TrackerField::Comments => None,
    };
    if value.is_none() {
        tracing::debug!(remote_id = %local.link.remote_id, field = field.key(), "Tracker push skipped an unmappable field");
    }
    value
}

/// Remote statuses that represent a stage, preferred first: explicit mappings to it, with
/// one named like the stage first; otherwise statuses named like the stage that are not
/// explicitly mapped elsewhere. Imports map each of them back to the same stage.
fn statuses(
    mapping: Option<&Mapping>,
    statuses: &[RemoteStatus],
    stage: Uuid,
    stage_name: &str,
) -> Vec<String> {
    let stage_name = stage_name.to_lowercase();
    let named = |id: &str| {
        statuses
            .iter()
            .any(|status| status.id == id && status.name.to_lowercase() == stage_name)
    };
    let explicit = |id: &str| mapping.and_then(|mapping| mapping.stage_mapping.get(id));
    let mut ids: Vec<&str> = mapping
        .into_iter()
        .flat_map(|mapping| &mapping.stage_mapping)
        .filter(|(_, mapped)| **mapped == stage)
        .map(|(id, _)| id.as_str())
        .collect();
    if ids.is_empty() {
        ids = statuses
            .iter()
            .map(|status| status.id.as_str())
            .filter(|id| named(id) && explicit(id).is_none())
            .collect();
    }
    ids.sort_by_key(|id| (!named(id), id.len(), *id));
    ids.into_iter().map(str::to_owned).collect()
}

/// The remote person for a member: an explicit people mapping, else a person with the
/// member's email that no mapping claims.
fn person(
    people: &[RemotePerson],
    people_mapping: &BTreeMap<String, Uuid>,
    member: Uuid,
    email: Option<&str>,
) -> Option<String> {
    let email_of = |person: &RemotePerson| {
        person
            .email
            .as_deref()
            .map(|email| email.trim().to_lowercase())
    };
    let mut people: Vec<&RemotePerson> = people.iter().collect();
    people.sort_by_key(|person| (person.id.len(), person.id.as_str()));
    let explicit = people.iter().find(|person| {
        email_of(person).is_some_and(|email| people_mapping.get(&email) == Some(&member))
    });
    let email = email.map(|email| email.trim().to_lowercase());
    explicit
        .or_else(|| {
            people.iter().find(|person| {
                email_of(person).is_some_and(|remote| {
                    Some(&remote) == email.as_ref() && !people_mapping.contains_key(&remote)
                })
            })
        })
        .map(|person| person.id.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn status(id: &str, name: &str) -> RemoteStatus {
        RemoteStatus {
            id: id.into(),
            name: name.into(),
            is_closed: false,
        }
    }

    #[tokio::test]
    async fn expired_pushes_fail_like_transient_errors() {
        let deadline = Instant::now() + Duration::from_millis(10);
        let outcome = bounded(deadline, std::future::pending::<Result<()>>()).await;
        assert_eq!(
            failure_message(&outcome.unwrap_err()),
            "Tracker push timed out"
        );
        let deadline = Instant::now() + Duration::from_secs(5);
        assert!(bounded(deadline, async { Ok(()) }).await.is_ok());
    }

    #[test]
    fn uncertain_sends_adopt_the_oldest_unlinked_matching_comment_by_the_account() {
        let at = |minute: u32| {
            NaiveDate::from_ymd_opt(2026, 10, 1)
                .unwrap()
                .and_hms_opt(10, minute, 0)
                .unwrap()
                .and_utc()
        };
        let comment = |id: &str, author: &str, body: &str, minute| RemoteComment {
            id: id.into(),
            author_id: Some(author.into()),
            author_name: String::new(),
            body: body.into(),
            created_at: at(minute),
        };
        let comments = [
            comment("1", "5", "Hello", 0),
            comment("2", "6", "Hello", 20),
            comment("3", "5", "Hello!", 20),
            comment("4", "5", "Hello", 20),
            comment("5", "5", "Hello", 30),
            comment("6", "5", "Hello", 25),
            comment("7", "5", "Hello", 50),
        ];
        let window = (at(10), at(40));
        let linked = ["4".to_owned()];
        assert_eq!(
            adoptable(&comments, "5", "Hello", window, &linked),
            Some("6")
        );
        assert_eq!(adoptable(&comments, "7", "Hello", window, &linked), None);
        assert_eq!(
            adoptable(&comments, "5", "Hello", (at(26), at(40)), &linked),
            Some("5")
        );
    }

    #[test]
    fn stages_map_to_explicit_statuses_before_names() {
        let (stage, other) = (Uuid::new_v4(), Uuid::new_v4());
        let cached = [
            status("1", "New"),
            status("2", "Doing"),
            status("10", "Doing"),
            status("3", "In progress"),
        ];
        let mapping = Mapping {
            project_id: "42".into(),
            team_id: Uuid::nil(),
            stage_mapping: BTreeMap::from([
                ("10".into(), stage),
                ("3".into(), stage),
                ("2".into(), other),
            ]),
        };
        // An explicit status named like the stage leads, then by ID.
        assert_eq!(
            statuses(Some(&mapping), &cached, stage, "In Progress"),
            ["3", "10"]
        );
        // Name matches skip statuses explicitly mapped to another stage.
        assert_eq!(
            statuses(Some(&mapping), &cached, Uuid::new_v4(), "doing"),
            Vec::<String>::new()
        );
        assert_eq!(
            statuses(None, &cached, Uuid::new_v4(), "DOING"),
            ["2", "10"]
        );
        assert!(statuses(None, &cached, Uuid::new_v4(), "Review").is_empty());
    }

    #[test]
    fn members_map_to_mapped_or_matching_people() {
        let (member, other) = (Uuid::new_v4(), Uuid::new_v4());
        let person = |id: &str, email: &str| RemotePerson {
            id: id.into(),
            name: id.into(),
            email: Some(email.into()),
        };
        let people = [
            person("5", "alias@remote.example"),
            person("6", " Member@Example.com "),
            person("7", "taken@example.com"),
        ];
        let explicit = BTreeMap::from([("alias@remote.example".into(), member)]);
        assert_eq!(
            super::person(&people, &explicit, member, Some("member@example.com")),
            Some("5".into())
        );
        assert_eq!(
            super::person(
                &people,
                &BTreeMap::new(),
                member,
                Some("member@example.com")
            ),
            Some("6".into())
        );
        let claimed = BTreeMap::from([("taken@example.com".into(), other)]);
        assert_eq!(
            super::person(&people, &claimed, member, Some("taken@example.com")),
            None
        );
    }
}
