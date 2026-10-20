use super::{
    Mapping, Metadata, ProviderKind, TrackerField,
    comments::{self, Incoming},
    merge::Merge,
    outbox,
    provider::{RemoteComment, RemoteIssue, RemotePerson, RemoteStatus},
};
use crate::{
    domain::{Baseline, Issue, TrackerLink},
    error::{Error, Result},
    store::persistence::{self, CreationBatch},
};
use chrono::{DateTime, Utc};
use serde_json::Value;
use sqlx::PgConnection;
use std::collections::{BTreeMap, BTreeSet};
use uuid::Uuid;

pub(super) struct PageImport<'a> {
    pub workspace: Uuid,
    pub connection: Uuid,
    pub provider: ProviderKind,
    pub mapping: &'a Mapping,
    pub metadata: &'a Metadata,
    /// Listed items' comments, None for failed listings; None while comment import is off.
    pub comments: Option<&'a BTreeMap<String, Option<Vec<RemoteComment>>>>,
}

/// Reconciles one fetched page inside the caller's transaction and workspace graph locks.
#[tracing::instrument(name = "tracker_page", level = "debug", skip_all,
    fields(connection_id = %import.connection, team_id = %import.mapping.team_id, item_count = items.len()))]
pub(super) async fn apply_page(
    conn: &mut PgConnection,
    import: PageImport<'_>,
    items: &[RemoteIssue],
) -> Result<()> {
    if items.is_empty() {
        return Ok(());
    }
    let lookups = Lookups::load(conn, import, items).await?;
    let mut local = Local::lock(conn, &lookups.import, items).await?;
    let parents = Parents::plan(conn, &lookups.import, &local, items).await?;
    let mut allocation = allocate(conn, &lookups.import, &local).await?;
    let mut writes = Writes::default();
    let mut progress = CommentProgress::default();
    let listed_at = Utc::now();
    for item in items {
        let id = local.ids[&item.id];
        let before = local.existing.get(&item.id).cloned();
        progress.collect(&lookups, item, id, before.as_ref());
        let reconciled =
            lookups.reconcile(item, id, before, &local.pending, &parents, listed_at)?;
        let after = writes
            .item(conn, &lookups.import, &mut allocation, reconciled)
            .await?;
        local.existing.insert(item.id.clone(), after);
    }
    for old in local.dependents {
        writes
            .dependent(conn, lookups.import.workspace, &parents, old)
            .await?;
    }
    let Lookups { import, stages, .. } = lookups;
    writes.finish(conn, &import, stages).await?;
    progress.record(conn, &import).await
}

struct Stage {
    id: Uuid,
    team: Uuid,
    name: String,
    kind: String,
    position: i64,
}

/// What a page maps remote values with.
struct Lookups<'a> {
    import: PageImport<'a>,
    stages: Vec<Stage>,
    statuses: BTreeMap<&'a str, &'a RemoteStatus>,
    /// Status names folded as PostgreSQL folds stage names.
    folded: BTreeMap<String, String>,
    people: BTreeMap<&'a str, &'a RemotePerson>,
    /// Members by remote email; None when no member matches.
    members: BTreeMap<String, Option<Uuid>>,
}

impl<'a> Lookups<'a> {
    async fn load(
        conn: &mut PgConnection,
        import: PageImport<'a>,
        items: &[RemoteIssue],
    ) -> Result<Self> {
        let stages = sqlx::query_as::<_, (Uuid, Uuid, String, String, i64)>(
            "SELECT id,team_id,lower(name),kind,position FROM stages WHERE workspace_id=$1",
        )
        .bind(import.workspace)
        .fetch_all(&mut *conn)
        .await?
        .into_iter()
        .map(|(id, team, name, kind, position)| Stage {
            id,
            team,
            name,
            kind,
            position,
        })
        .collect();
        let metadata = import.metadata;
        let mut lookups = Self {
            import,
            stages,
            statuses: metadata
                .statuses
                .iter()
                .map(|status| (status.id.as_str(), status))
                .collect(),
            folded: BTreeMap::new(),
            people: metadata
                .people
                .iter()
                .map(|person| (person.id.as_str(), person))
                .collect(),
            members: BTreeMap::new(),
        };
        let names: BTreeSet<String> = items
            .iter()
            .map(|item| lookups.status_name(item).to_owned())
            .collect();
        // Match PostgreSQL's case folding on both sides, including non-ASCII names.
        lookups.folded =
            sqlx::query_as("SELECT name,lower(name) FROM unnest($1::text[]) AS names(name)")
                .bind(names.into_iter().collect::<Vec<_>>())
                .fetch_all(&mut *conn)
                .await?
                .into_iter()
                .collect();
        // Assignees and authors, of items and comments, map to members by the same rules.
        let emails: BTreeSet<String> = items
            .iter()
            .flat_map(|item| {
                let authors = lookups
                    .fetched(item)
                    .iter()
                    .map(|comment| &comment.author_id);
                [&item.assignee_id, &item.author_id]
                    .into_iter()
                    .chain(authors)
            })
            .filter_map(|person| lookups.email_of(person))
            .collect();
        lookups.members = members(conn, lookups.import.workspace, metadata, emails).await?;
        Ok(lookups)
    }

    fn status(&self, item: &RemoteIssue) -> Option<&'a RemoteStatus> {
        self.statuses.get(item.status_id.as_str()).copied()
    }

    fn status_name<'s>(&'s self, item: &'s RemoteIssue) -> &'s str {
        self.status(item)
            .map(|status| status.name.as_str())
            .or(item.status_name.as_deref())
            .unwrap_or("Unknown")
    }

    fn email_of(&self, person: &Option<String>) -> Option<String> {
        person
            .as_deref()
            .and_then(|id| self.people.get(id))
            .and_then(|person| person.email.as_ref())
            .map(|email| email.trim().to_lowercase())
    }

    fn member(&self, email: &Option<String>) -> Option<Uuid> {
        email
            .as_ref()
            .and_then(|email| self.members.get(email).copied().flatten())
    }

    /// The item's listed comments; none for failed listings or while comment import is off.
    fn fetched(&self, item: &RemoteIssue) -> &'a [RemoteComment] {
        self.import
            .comments
            .and_then(|comments| comments.get(&item.id))
            .and_then(Option::as_deref)
            .unwrap_or_default()
    }

    /// The explicitly mapped stage, else the team's stage named like the status,
    /// preferring the kind that matches whether the status is closed.
    fn destination(&self, item: &RemoteIssue) -> Result<&Stage> {
        let mapping = self.import.mapping;
        let closed = self.status(item).is_some_and(|status| status.is_closed);
        let explicit = mapping.stage_mapping.get(&item.status_id);
        let destination = if let Some(id) = explicit {
            self.stages
                .iter()
                .find(|stage| stage.id == *id && stage.team == mapping.team_id)
                .ok_or_else(|| {
                    Error::BadRequest(
                        "mapped stage no longer exists; update project stage mapping".into(),
                    )
                })?
        } else {
            let name = self
                .folded
                .get(self.status_name(item))
                .ok_or_else(|| Error::Internal("missing tracker status name".into()))?;
            let kind = if closed { "done" } else { "backlog" };
            self.stages
                .iter()
                .filter(|stage| stage.team == mapping.team_id)
                .min_by_key(|stage| {
                    (
                        stage.name != *name,
                        stage.kind != kind,
                        stage.position,
                        stage.id,
                    )
                })
                .ok_or_else(|| Error::Internal("destination team has no stage".into()))?
        };
        tracing::debug!(remote_id = %item.id, status_id = %item.status_id, stage_id = %destination.id,
            explicit_mapping = explicit.is_some(), closed, "Tracker status mapped");
        Ok(destination)
    }

    /// The item's new link. Comment progress carries over while comment import is on and
    /// moves only once the page's import of them is complete (`CommentProgress::record`).
    fn link(
        &self,
        item: &RemoteIssue,
        previous: Option<&TrackerLink>,
        listed_at: DateTime<Utc>,
    ) -> TrackerLink {
        let comments = self.import.comments;
        let carried = previous.filter(|_| comments.is_some());
        let listed = comments.is_some_and(|comments| comments.contains_key(&item.id));
        TrackerLink {
            provider: self.import.provider.key().into(),
            connection_id: self.import.connection,
            remote_id: item.id.clone(),
            project_id: item.project_id.clone(),
            parent_remote_id: item.parent_id.clone(),
            status_name: self.status_name(item).to_owned(),
            url: item.url.clone(),
            baseline: None,
            push_error: previous.and_then(|link| link.push_error.clone()),
            comments_at: carried.and_then(|link| link.comments_at),
            comments_imported: carried.is_some_and(|link| link.comments_imported),
            comments_tried_at: if listed {
                Some(listed_at)
            } else {
                carried.and_then(|link| link.comments_tried_at)
            },
        }
    }

    /// Merges a remote item into its local issue, or a new one, without writing it.
    fn reconcile(
        &self,
        item: &RemoteIssue,
        id: Uuid,
        before: Option<Issue>,
        pending: &BTreeMap<Uuid, BTreeSet<TrackerField>>,
        parents: &Parents,
        listed_at: DateTime<Utc>,
    ) -> Result<Reconciled> {
        let team = self.import.mapping.team_id;
        let destination = self.destination(item)?;
        let previous = before.as_ref().and_then(|issue| issue.tracker.as_ref());
        let mut source = self.link(item, previous, listed_at);
        let mut after = before
            .clone()
            .unwrap_or_else(|| new_issue(id, team, destination.id));
        let remote = self.remote(item, destination.id, parents.remote[&id]);
        if before.is_none() {
            let author_email = self.email_of(&item.author_id);
            after.created_by = self.member(&author_email);
            tracing::debug!(remote_id = %item.id, remote_author_id = ?item.author_id,
                email_available = author_email.is_some(), created_by = ?after.created_by,
                explicit_mapping = self.explicit(&author_email), "Tracker author mapped");
        }
        let merge = Merge::new(&self.import.metadata.options, pending, before.as_ref());
        if merge.apply(&mut after, &remote) {
            if before
                .as_ref()
                .is_some_and(|old| old.team_id != after.team_id)
            {
                // Planning records belong to the previous team.
                after.project_id = None;
                after.milestone_id = None;
                after.sprint_id = None;
            }
            if destination.kind == "done" {
                if after.done_at.is_none() {
                    after.done_at = Some(Utc::now());
                }
            } else {
                after.done_at = None;
                after.archived_at = None;
            }
            // Backlog work has no sprint.
            if destination.kind == "backlog" && after.stage_id == destination.id {
                after.sprint_id = None;
            }
        }
        after.parent_id = parents.wanted.get(&id).copied().flatten();
        // A parent skipped for a cycle stays unapplied in the baseline, so a later scan retries it.
        let parent_id = if parents.rejected.contains(&id) {
            previous
                .and_then(|link| link.baseline.as_ref())
                .map_or(after.parent_id, |base| base.parent_id)
        } else {
            remote.parent_id
        };
        source.baseline = Some(Baseline {
            parent_id,
            ..remote
        });
        after.tracker = Some(source.clone());
        let reconciled = Reconciled::new(before, after, source);
        tracing::debug!(remote_id = %item.id, issue_id = %reconciled.after.id, creating = reconciled.before.is_none(),
            changed = reconciled.changed, fields = ?reconciled.fields, "Tracker remote issue reconciled in page transaction");
        Ok(reconciled)
    }

    /// The item's values mapped to local ones.
    fn remote(&self, item: &RemoteIssue, stage: Uuid, parent: Option<Uuid>) -> Baseline {
        let email = self.email_of(&item.assignee_id);
        let remote = Baseline {
            title: item.title.clone(),
            description: item.description.clone(),
            team_id: self.import.mapping.team_id,
            stage_id: stage,
            assignee: self.member(&email),
            priority: item.priority.clone(),
            deadline: item.deadline,
            parent_id: parent,
        };
        tracing::debug!(remote_id = %item.id, remote_assignee_id = ?item.assignee_id,
            email_available = email.is_some(), assignee_id = ?remote.assignee,
            explicit_mapping = self.explicit(&email), "Tracker assignee mapped");
        remote
    }

    /// Whether a people mapping names the email, for logs.
    fn explicit(&self, email: &Option<String>) -> bool {
        email
            .as_ref()
            .is_some_and(|email| self.import.metadata.people_mapping.contains_key(email))
    }
}

/// Members for remote emails: the explicitly mapped member while it belongs to the
/// workspace, else the member with that email.
async fn members(
    conn: &mut PgConnection,
    workspace: Uuid,
    metadata: &Metadata,
    emails: BTreeSet<String>,
) -> Result<BTreeMap<String, Option<Uuid>>> {
    if emails.is_empty() {
        return Ok(BTreeMap::new());
    }
    let people_mapping = &metadata.people_mapping;
    let mapped: Vec<Uuid> = emails
        .iter()
        .filter_map(|email| people_mapping.get(email).copied())
        .collect();
    let rows: Vec<(Uuid, String)> = sqlx::query_as("SELECT u.id,lower(u.email) FROM users u JOIN workspace_members m ON m.user_id=u.id WHERE m.workspace_id=$1 AND (u.id=ANY($2) OR lower(u.email)=ANY($3))")
        .bind(workspace).bind(&mapped).bind(emails.iter().collect::<Vec<_>>())
        .fetch_all(&mut *conn).await?;
    let by_id: BTreeSet<Uuid> = rows.iter().map(|(id, _)| *id).collect();
    let by_email: BTreeMap<String, Uuid> =
        rows.into_iter().map(|(id, email)| (email, id)).collect();
    Ok(emails
        .into_iter()
        .map(|email| {
            let member = match people_mapping.get(&email) {
                Some(id) => by_id.contains(id).then_some(*id),
                None => by_email.get(&email).copied(),
            };
            (email, member)
        })
        .collect())
}

fn new_issue(id: Uuid, team_id: Uuid, stage_id: Uuid) -> Issue {
    let now = Utc::now();
    Issue {
        id,
        number: 0,
        title: String::new(),
        description: String::new(),
        team_id,
        stage_id,
        assignee: None,
        created_by: None,
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
        tracker: None,
        blocked_count: 0,
        subtask_total: 0,
        subtask_completed: 0,
        version: 1,
    }
}

/// The page's local issues, locked for the transaction.
struct Local {
    /// Imported issues of the page's items, by remote ID.
    existing: BTreeMap<String, Issue>,
    /// Local IDs by remote ID: the page's items, new ones included, and their imported
    /// parents.
    ids: BTreeMap<String, Uuid>,
    /// Issues the page creates.
    new_count: i64,
    /// Imported issues that move into the mapping's team, which need its numbers.
    moved_count: usize,
    /// Imported children of the page's items, scanned earlier.
    dependents: Vec<Issue>,
    /// Local fields waiting in the outbox, per issue. Imports keep those local values
    /// until the push resolves them.
    pending: BTreeMap<Uuid, BTreeSet<TrackerField>>,
}

impl Local {
    async fn lock(
        conn: &mut PgConnection,
        import: &PageImport<'_>,
        items: &[RemoteIssue],
    ) -> Result<Self> {
        let remote_ids: Vec<&str> = items.iter().map(|item| item.id.as_str()).collect();
        let mut existing = BTreeMap::new();
        for issue in lock_issues(conn, import, &remote_ids, "tracker->>'remote_id'=ANY($3)").await?
        {
            let remote_id = issue
                .tracker
                .as_ref()
                .ok_or_else(|| Error::Internal("imported issue has no tracker link".into()))?
                .remote_id
                .clone();
            existing.insert(remote_id, issue);
        }
        let mut ids = BTreeMap::new();
        for item in items {
            let imported = existing.get(&item.id).map(|issue: &Issue| issue.id);
            ids.entry(item.id.clone())
                .or_insert_with(|| imported.unwrap_or_else(Uuid::new_v4));
        }
        // Every imported issue is on the page.
        let new_count = (ids.len() - existing.len()) as i64;
        // Resolve remote parents to local issues of the same connection, whether the
        // parent is already imported or arrives on this page.
        let missing: BTreeSet<&str> = items
            .iter()
            .filter_map(|item| item.parent_id.as_deref())
            .filter(|id| !ids.contains_key(*id))
            .collect();
        if !missing.is_empty() {
            let known: Vec<(String, Uuid)> = sqlx::query_as("SELECT tracker->>'remote_id',id FROM issues WHERE workspace_id=$1 AND tracker->>'connection_id'=$2 AND tracker->>'remote_id'=ANY($3)")
                .bind(import.workspace).bind(import.connection.to_string()).bind(missing.into_iter().collect::<Vec<_>>())
                .fetch_all(&mut *conn).await?;
            ids.extend(known);
        }
        // Children scanned earlier point at packages arriving on this page. Link them
        // in the same transaction so scan order never strands a hierarchy.
        let dependents = lock_issues(
            conn,
            import,
            &remote_ids,
            "tracker->>'parent_remote_id'=ANY($3) AND NOT (tracker->>'remote_id'=ANY($3))",
        )
        .await?;
        let local_ids: Vec<Uuid> = existing
            .values()
            .chain(&dependents)
            .map(|issue| issue.id)
            .collect();
        let pending = outbox::pending_fields(conn, &local_ids).await?;
        let moved_count = existing
            .values()
            .filter(|issue| issue.team_id != import.mapping.team_id)
            .count();
        Ok(Self {
            existing,
            ids,
            new_count,
            moved_count,
            dependents,
            pending,
        })
    }
}

/// Locks the connection's issues matching `filter`, in which `$3` holds the page's remote
/// IDs. Related collections are not remote-owned. Empty placeholders avoid their
/// aggregates; remote persistence only updates the scalar columns carried by this projection.
async fn lock_issues(
    conn: &mut PgConnection,
    import: &PageImport<'_>,
    remote_ids: &[&str],
    filter: &str,
) -> Result<Vec<Issue>> {
    let rows: Vec<Value> = sqlx::query_scalar(&format!("SELECT (to_jsonb(i)-'workspace_id'-'reminder_generation') || jsonb_build_object('labels','[]'::jsonb,'dependencies','[]'::jsonb,'followers','[]'::jsonb,'attachments','[]'::jsonb,'source_links','[]'::jsonb) FROM issues i WHERE workspace_id=$1 AND tracker->>'connection_id'=$2 AND {filter} ORDER BY id FOR UPDATE"))
        .bind(import.workspace).bind(import.connection.to_string()).bind(remote_ids)
        .fetch_all(&mut *conn).await?;
    rows.into_iter()
        .map(|row| Ok(serde_json::from_value(row)?))
        .collect()
}

/// Parent decisions for the page's items and the dependents linking to them.
#[derive(Default)]
struct Parents {
    /// Remote parents resolved to local issues, as baselines record them.
    remote: BTreeMap<Uuid, Option<Uuid>>,
    /// Parents to store.
    wanted: BTreeMap<Uuid, Option<Uuid>>,
    /// Accepted remote changes skipped for a cycle.
    rejected: BTreeSet<Uuid>,
}

impl Parents {
    /// Accepted remote changes map to the previous local parent; kept local parents still
    /// join the cycle check. Trashed dependents keep their parent.
    async fn plan(
        conn: &mut PgConnection,
        import: &PageImport<'_>,
        local: &Local,
        items: &[RemoteIssue],
    ) -> Result<Self> {
        let mut parents = Self::default();
        let mut accepted = BTreeMap::new();
        let mut decide = |id: Uuid, before: Option<&Issue>, remote: Option<Uuid>| {
            let previous = before.and_then(|issue| issue.parent_id);
            let takes = Merge::new(&import.metadata.options, &local.pending, before).takes(
                Some(TrackerField::Parent),
                |base| &base.parent_id,
                &remote,
            );
            if takes {
                accepted.insert(id, previous);
            }
            parents.remote.insert(id, remote);
            parents
                .wanted
                .insert(id, if takes { remote } else { previous });
        };
        for item in items {
            let remote = item
                .parent_id
                .as_deref()
                .and_then(|id| local.ids.get(id).copied());
            decide(local.ids[&item.id], local.existing.get(&item.id), remote);
        }
        for issue in &local.dependents {
            let parent = issue
                .tracker
                .as_ref()
                .and_then(|link| link.parent_remote_id.as_deref())
                .and_then(|id| local.ids.get(id).copied())
                .ok_or_else(|| Error::Internal("imported child misses its page parent".into()))?;
            if issue.deleted_at.is_none() {
                decide(issue.id, Some(issue), Some(parent));
            }
        }
        // Trackers prevent cycles, but pages can disagree mid-scan. Skip a remote change
        // that would close one; a later scan retries it once both sides agree.
        let roots: BTreeSet<Uuid> = parents.wanted.values().flatten().copied().collect();
        let mut ancestors = BTreeMap::new();
        if !roots.is_empty() {
            let rows: Vec<(Uuid, Option<Uuid>)> = sqlx::query_as("WITH RECURSIVE ancestors(id,parent_id) AS (SELECT id,parent_id FROM issues WHERE workspace_id=$1 AND id=ANY($2) UNION SELECT i.id,i.parent_id FROM issues i JOIN ancestors a ON i.id=a.parent_id WHERE i.workspace_id=$1) SELECT id,parent_id FROM ancestors")
                .bind(import.workspace).bind(roots.into_iter().collect::<Vec<_>>()).fetch_all(&mut *conn).await?;
            ancestors.extend(rows);
        }
        let dependents: BTreeSet<Uuid> = local.dependents.iter().map(|issue| issue.id).collect();
        parents.rejected =
            break_parent_cycles(&mut parents.wanted, &ancestors, &accepted, &dependents);
        Ok(parents)
    }
}

fn creates_cycle(
    wanted_parents: &BTreeMap<Uuid, Option<Uuid>>,
    ancestors: &BTreeMap<Uuid, Option<Uuid>>,
    child: Uuid,
    parent: Uuid,
) -> bool {
    let mut current = Some(parent);
    let mut seen = BTreeSet::new();
    while let Some(id) = current {
        if id == child {
            return true;
        }
        if !seen.insert(id) {
            return false;
        }
        current = if let Some(next) = wanted_parents.get(&id) {
            *next
        } else {
            ancestors.get(&id).copied().flatten()
        };
    }
    false
}

/// Rejects accepted remote parent changes (child → previous local parent) that would
/// close a cycle, restoring the previous local parent, and returns the rejected children.
/// Preserved local edges join the check but never change. Rejecting every change
/// restores the stored, acyclic graph, so the loop ends.
fn break_parent_cycles(
    wanted_parents: &mut BTreeMap<Uuid, Option<Uuid>>,
    ancestors: &BTreeMap<Uuid, Option<Uuid>>,
    accepted: &BTreeMap<Uuid, Option<Uuid>>,
    dependents: &BTreeSet<Uuid>,
) -> BTreeSet<Uuid> {
    let mut rejected = BTreeSet::new();
    loop {
        let cyclic = |stale: bool| -> Vec<Uuid> {
            accepted
                .keys()
                .filter(|child| !rejected.contains(*child) && dependents.contains(*child) == stale)
                .filter(|child| {
                    wanted_parents
                        .get(*child)
                        .copied()
                        .flatten()
                        .is_some_and(|id| creates_cycle(wanted_parents, ancestors, **child, id))
                })
                .copied()
                .collect()
        };
        // Dependent edges replay stored metadata, so they lose to fresh page edges.
        let mut skipped = cyclic(true);
        if skipped.is_empty() {
            skipped = cyclic(false);
        }
        if skipped.is_empty() {
            return rejected;
        }
        for child in skipped {
            tracing::debug!(issue_id = %child, "Tracker parent link skipped: cycle until a later scan");
            wanted_parents.insert(child, accepted[&child]);
            rejected.insert(child);
        }
    }
}

/// The link without tracker bookkeeping, which alone is no visible change.
fn without_bookkeeping(link: &Option<TrackerLink>) -> Option<TrackerLink> {
    link.clone().map(|link| TrackerLink {
        baseline: None,
        comments_at: None,
        comments_imported: false,
        comments_tried_at: None,
        ..link
    })
}

/// Reserves numbers and positions for the page's new issues within the workspace's issue
/// capacity, and numbers for issues moving into the mapping's team.
async fn allocate(
    conn: &mut PgConnection,
    import: &PageImport<'_>,
    local: &Local,
) -> Result<Option<CreationBatch>> {
    let count = local.new_count;
    if count > 0 {
        let capacity_error = format!(
            "{} import stopped: workspace issue capacity reached (5000); reduce project mappings. Existing issues remain unchanged",
            import.provider.name()
        );
        let mut stored = None;
        persistence::capacity(
            conn,
            import.workspace,
            "issues",
            5000,
            &mut stored,
            &capacity_error,
        )
        .await?;
        if stored.unwrap_or_default() + count > 5000 {
            return Err(Error::BadRequest(capacity_error));
        }
    } else if local.moved_count == 0 {
        return Ok(None);
    }
    let team = import.mapping.team_id;
    Ok(Some(
        persistence::allocate_creations(conn, import.workspace, team).await?,
    ))
}

/// An issue merged with its remote item, not yet written.
struct Reconciled {
    before: Option<Issue>,
    after: Issue,
    source: TrackerLink,
    /// Changed fields for the activity.
    fields: Vec<String>,
    /// More than the baseline changed, so the issue is saved.
    changed: bool,
}

impl Reconciled {
    fn new(before: Option<Issue>, after: Issue, source: TrackerLink) -> Self {
        let mut fields = before
            .as_ref()
            .map(|old| old.changed_fields(&after))
            .unwrap_or_default();
        if let Some(old) = &before {
            if old.team_id != after.team_id {
                fields.push("team".into());
            }
            if without_bookkeeping(&old.tracker) != without_bookkeeping(&after.tracker) {
                fields.push("tracker".into());
            }
        }
        // Archive bookkeeping can change even when all visible remote fields match.
        let bookkeeping_changed = before.as_ref().is_some_and(|old| {
            old.done_at != after.done_at || old.archived_at != after.archived_at
        });
        let changed = before.is_none() || !fields.is_empty() || bookkeeping_changed;
        Self {
            before,
            after,
            source,
            fields,
            changed,
        }
    }
}

/// The page's writes, and what follows them once every issue is written.
#[derive(Default)]
struct Writes {
    /// Saved issues: (before, after, changed fields).
    changes: Vec<(Option<Issue>, Issue, Vec<String>)>,
    /// Links whose baseline alone moved: no visible change, version bump or activity.
    baselines: BTreeMap<Uuid, Value>,
    /// Source link URLs of the page's issues.
    links: BTreeMap<Uuid, String>,
}

impl Writes {
    /// Saves or creates a reconciled item and returns it as stored.
    async fn item(
        &mut self,
        conn: &mut PgConnection,
        import: &PageImport<'_>,
        allocation: &mut Option<CreationBatch>,
        reconciled: Reconciled,
    ) -> Result<Issue> {
        let Reconciled {
            before,
            mut after,
            source,
            fields,
            changed,
        } = reconciled;
        if changed {
            if let Some(old) = &before {
                // Numbers are unique per team.
                if old.team_id != after.team_id {
                    allocation
                        .as_mut()
                        .ok_or_else(|| Error::Internal("missing import allocation".into()))?
                        .renumber(&mut after);
                }
                persistence::save(
                    conn,
                    import.workspace,
                    &after,
                    persistence::Origin::Remote(&source),
                )
                .await?;
                if let Some(allocation) = allocation {
                    allocation.include(&after, import.mapping.team_id);
                }
            } else {
                let allocation = allocation
                    .as_mut()
                    .ok_or_else(|| Error::Internal("missing import allocation".into()))?;
                persistence::create_allocated(
                    conn,
                    import.workspace,
                    &mut after,
                    &source,
                    allocation,
                )
                .await?;
            }
            self.changes.push((before, after.clone(), fields));
        } else if before
            .as_ref()
            .is_some_and(|old| old.tracker != after.tracker)
        {
            self.baselines
                .insert(after.id, serde_json::to_value(&source)?);
        }
        self.links.insert(after.id, source.url);
        Ok(after)
    }

    /// Links a child scanned earlier to its parent on this page.
    async fn dependent(
        &mut self,
        conn: &mut PgConnection,
        workspace: Uuid,
        parents: &Parents,
        old: Issue,
    ) -> Result<()> {
        let Some(&parent) = parents.wanted.get(&old.id) else {
            return Ok(());
        };
        let mut source = old
            .tracker
            .clone()
            .ok_or_else(|| Error::Internal("imported issue has no tracker link".into()))?;
        // The baseline records the remote parent even when the local one is kept, but
        // not one skipped for a cycle, so a later scan retries it.
        if !parents.rejected.contains(&old.id)
            && let Some(baseline) = &mut source.baseline
        {
            baseline.parent_id = parents.remote[&old.id];
        }
        if old.parent_id == parent {
            if old.tracker.as_ref() != Some(&source) {
                self.baselines
                    .insert(old.id, serde_json::to_value(&source)?);
            }
            return Ok(());
        }
        let mut after = old.clone();
        after.parent_id = parent;
        after.tracker = Some(source.clone());
        persistence::save(
            conn,
            workspace,
            &after,
            persistence::Origin::Remote(&source),
        )
        .await?;
        let fields = old.changed_fields(&after);
        tracing::debug!(issue_id = %after.id, changed = true, fields = ?fields,
            "Tracker child linked in page transaction");
        self.changes.push((Some(old), after, fields));
        Ok(())
    }

    /// Writes the batched baselines, the saved issues' page effects and the source links.
    async fn finish(
        self,
        conn: &mut PgConnection,
        import: &PageImport<'_>,
        stages: Vec<Stage>,
    ) -> Result<()> {
        let workspace = import.workspace;
        if !self.baselines.is_empty() {
            let (ids, values): (Vec<Uuid>, Vec<Value>) = self.baselines.into_iter().unzip();
            sqlx::query("UPDATE issues i SET tracker=input.tracker FROM unnest($2::uuid[],$3::jsonb[]) AS input(id,tracker) WHERE i.workspace_id=$1 AND i.id=input.id")
                .bind(workspace).bind(ids).bind(values).execute(&mut *conn).await?;
        }
        if !self.changes.is_empty() {
            let updated: Vec<Uuid> = self
                .changes
                .iter()
                .filter(|(before, _, _)| before.is_some())
                .map(|(_, after, _)| after.id)
                .collect();
            let mut followers: BTreeMap<Uuid, Vec<Uuid>> = BTreeMap::new();
            if !updated.is_empty() {
                let rows: Vec<(Uuid, Uuid)> = sqlx::query_as("SELECT issue_id,user_id FROM issue_followers WHERE workspace_id=$1 AND issue_id=ANY($2) ORDER BY issue_id,user_id")
                    .bind(workspace).bind(&updated).fetch_all(&mut *conn).await?;
                for (issue, user) in rows {
                    followers.entry(issue).or_default().push(user);
                }
            }
            let stages = stages
                .into_iter()
                .map(|stage| (stage.id, stage.kind))
                .collect();
            let effects = persistence::PageEffects::load(conn, workspace, stages).await?;
            for (before, mut after, fields) in self.changes {
                after.followers = followers.get(&after.id).cloned().unwrap_or_default();
                effects
                    .apply(conn, workspace, before.as_ref(), &after, fields)
                    .await?;
            }
        }
        let (ids, urls): (Vec<Uuid>, Vec<String>) = self.links.into_iter().unzip();
        let link_ids: Vec<Uuid> = ids.iter().map(|_| Uuid::new_v4()).collect();
        sqlx::query("INSERT INTO source_links(id,workspace_id,issue_id,url,title) SELECT input.id,$1,input.issue_id,input.url,$5 FROM unnest($2::uuid[],$3::uuid[],$4::text[]) AS input(id,issue_id,url) WHERE NOT EXISTS(SELECT 1 FROM source_links s WHERE s.workspace_id=$1 AND s.issue_id=input.issue_id AND s.url=input.url AND s.title=$5) ON CONFLICT DO NOTHING")
            .bind(workspace).bind(link_ids).bind(ids).bind(urls).bind(import.provider.name()).execute(&mut *conn).await?;
        Ok(())
    }
}

/// Comments to import, and the listed items whose comment import they complete.
#[derive(Default)]
struct CommentProgress<'a> {
    incoming: Vec<Incoming<'a>>,
    /// Listed items: (issue, remote modification time, already recorded).
    listed: Vec<(Uuid, Option<DateTime<Utc>>, bool)>,
}

impl<'a> CommentProgress<'a> {
    /// Collects an item's listed comments. Trashed issues get no comments until restored
    /// and seen again.
    fn collect(
        &mut self,
        lookups: &Lookups<'a>,
        item: &RemoteIssue,
        id: Uuid,
        before: Option<&Issue>,
    ) {
        let Some(Some(comments)) = lookups.import.comments.and_then(|all| all.get(&item.id)) else {
            return;
        };
        if before.is_some_and(|issue| issue.deleted_at.is_some()) {
            return;
        }
        let previous = before.and_then(|issue| issue.tracker.as_ref());
        let imported = previous.is_some_and(|link| link.comments_imported);
        let recorded = imported && previous.is_some_and(|link| link.comments_at == item.updated_at);
        self.listed.push((id, item.updated_at, recorded));
        for comment in comments {
            let author_name = if comment.author_name.is_empty() {
                comment
                    .author_id
                    .as_deref()
                    .and_then(|id| lookups.people.get(id))
                    .map(|person| person.name.clone())
            } else {
                Some(comment.author_name.clone())
            };
            self.incoming.push(Incoming {
                issue: id,
                silent: !imported,
                comment,
                author: lookups.member(&lookups.email_of(&comment.author_id)),
                author_name,
            });
        }
    }

    /// Imports the comments. Listed items whose comments are all linked now record the
    /// import; without a remote modification time, the item is listed again on every scan.
    async fn record(self, conn: &mut PgConnection, import: &PageImport<'_>) -> Result<()> {
        let incomplete = comments::import(
            conn,
            import.workspace,
            import.connection,
            import.provider,
            self.incoming,
        )
        .await?;
        let (ids, times): (Vec<Uuid>, Vec<Option<DateTime<Utc>>>) = self
            .listed
            .into_iter()
            .filter(|(id, _, recorded)| !recorded && !incomplete.contains(id))
            .map(|(id, at, _)| (id, at))
            .unzip();
        if !ids.is_empty() {
            sqlx::query("UPDATE issues i SET tracker=(i.tracker-'comments_at')||jsonb_strip_nulls(jsonb_build_object('comments_imported',true,'comments_at',input.at)) FROM unnest($2::uuid[],$3::timestamptz[]) AS input(id,at) WHERE i.workspace_id=$1 AND i.id=input.id")
                .bind(import.workspace).bind(&ids).bind(&times).execute(&mut *conn).await?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn link(wanted: &mut BTreeMap<Uuid, Option<Uuid>>, child: &Uuid, parent: Option<&Uuid>) {
        wanted.insert(*child, parent.copied());
    }

    fn flagged(
        wanted: &BTreeMap<Uuid, Option<Uuid>>,
        ancestors: &BTreeMap<Uuid, Option<Uuid>>,
    ) -> BTreeSet<Uuid> {
        wanted
            .iter()
            .filter(|(child, parent)| {
                parent.is_some_and(|id| creates_cycle(wanted, ancestors, **child, id))
            })
            .map(|(child, _)| *child)
            .collect()
    }

    #[test]
    fn two_cycle_flags_both_members() {
        let (x, y) = (Uuid::new_v4(), Uuid::new_v4());
        let mut wanted = BTreeMap::new();
        link(&mut wanted, &x, Some(&y));
        link(&mut wanted, &y, Some(&x));
        assert_eq!(flagged(&wanted, &BTreeMap::new()), BTreeSet::from([x, y]));
    }

    #[test]
    fn self_parent_is_a_cycle() {
        let x = Uuid::new_v4();
        let mut wanted = BTreeMap::new();
        link(&mut wanted, &x, Some(&x));
        assert_eq!(flagged(&wanted, &BTreeMap::new()), BTreeSet::from([x]));
    }

    #[test]
    fn child_pointing_into_another_cycle_is_not_flagged() {
        let (x, y, z) = (Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4());
        let mut wanted = BTreeMap::new();
        link(&mut wanted, &x, Some(&y));
        link(&mut wanted, &y, Some(&z));
        link(&mut wanted, &z, Some(&y));
        assert_eq!(flagged(&wanted, &BTreeMap::new()), BTreeSet::from([y, z]));
    }

    #[test]
    fn chain_through_stored_ancestors_closing_a_cycle_is_flagged() {
        let (a, b) = (Uuid::new_v4(), Uuid::new_v4());
        let mut wanted = BTreeMap::new();
        link(&mut wanted, &a, Some(&b));
        let ancestors = BTreeMap::from([(b, Some(a)), (a, None)]);
        assert_eq!(flagged(&wanted, &ancestors), BTreeSet::from([a]));
    }

    #[test]
    fn acyclic_chain_is_not_flagged() {
        let (a, b, c) = (Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4());
        let mut wanted = BTreeMap::new();
        link(&mut wanted, &a, Some(&b));
        link(&mut wanted, &b, Some(&c));
        link(&mut wanted, &c, None);
        let ancestors = BTreeMap::from([(c, None)]);
        assert!(flagged(&wanted, &ancestors).is_empty());
    }

    #[test]
    fn fresh_page_edge_wins_over_stale_dependent_edge() {
        let (a, b) = (Uuid::new_v4(), Uuid::new_v4());
        let mut wanted = BTreeMap::new();
        link(&mut wanted, &a, Some(&b));
        link(&mut wanted, &b, Some(&a));
        let accepted = BTreeMap::from([(a, None), (b, None)]);
        let rejected = break_parent_cycles(
            &mut wanted,
            &BTreeMap::new(),
            &accepted,
            &BTreeSet::from([b]),
        );
        assert_eq!(rejected, BTreeSet::from([b]));
        assert_eq!(wanted[&a], Some(b));
        assert_eq!(wanted[&b], None);
    }

    #[test]
    fn preserved_local_parent_survives_a_remote_cycle() {
        // Locally A sits under B and the remote, unchanged for A, moves B under A.
        let (a, b, c) = (Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4());
        let mut wanted = BTreeMap::new();
        link(&mut wanted, &a, Some(&b));
        link(&mut wanted, &b, Some(&a));
        let accepted = BTreeMap::from([(b, Some(c))]);
        let ancestors = BTreeMap::from([(a, Some(b)), (b, Some(c)), (c, None)]);
        let rejected = break_parent_cycles(&mut wanted, &ancestors, &accepted, &BTreeSet::new());
        assert_eq!(rejected, BTreeSet::from([b]));
        assert_eq!(wanted[&a], Some(b), "the preserved local edge stays");
        assert_eq!(
            wanted[&b],
            Some(c),
            "the rejected change keeps the local parent"
        );
    }

    #[test]
    fn restored_parent_closing_a_new_cycle_rejects_again() {
        // Rejecting X's change restores X under Z, which closes Z → W → X.
        let (x, y, z, w) = (
            Uuid::new_v4(),
            Uuid::new_v4(),
            Uuid::new_v4(),
            Uuid::new_v4(),
        );
        let mut wanted = BTreeMap::new();
        link(&mut wanted, &x, Some(&y));
        link(&mut wanted, &y, Some(&x));
        link(&mut wanted, &z, Some(&w));
        link(&mut wanted, &w, Some(&x));
        let accepted = BTreeMap::from([(x, Some(z)), (y, None), (z, None), (w, None)]);
        let rejected =
            break_parent_cycles(&mut wanted, &BTreeMap::new(), &accepted, &BTreeSet::new());
        assert!(flagged(&wanted, &BTreeMap::new()).is_empty());
        assert!(rejected.contains(&x) && rejected.contains(&y));
        assert_eq!(wanted[&x], Some(z));
    }
}
