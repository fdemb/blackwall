use super::*;
use crate::{
    domain::{Issue, OpenProjectSource},
    store::persistence,
};
use scan::{Person, Status, WorkPackage};

struct Stage {
    id: Uuid,
    team: Uuid,
    name: String,
    kind: String,
    position: i64,
}

pub(super) struct PageImport<'a> {
    pub workspace: Uuid,
    pub connection: Uuid,
    pub base: &'a str,
    pub mapping: &'a Mapping,
    pub statuses: &'a [Status],
    pub people: &'a [Person],
    pub people_mapping: &'a BTreeMap<String, Uuid>,
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

fn break_parent_cycles(
    wanted_parents: &mut BTreeMap<Uuid, Option<Uuid>>,
    ancestors: &BTreeMap<Uuid, Option<Uuid>>,
    dependents: &BTreeSet<Uuid>,
) {
    // Dependent edges replay stored metadata, so they lose to fresh page edges.
    let stale: Vec<Uuid> = dependents
        .iter()
        .filter(|child| {
            wanted_parents
                .get(*child)
                .copied()
                .flatten()
                .is_some_and(|id| creates_cycle(wanted_parents, ancestors, **child, id))
        })
        .copied()
        .collect();
    for child in stale {
        tracing::debug!(issue_id = %child, "OpenProject parent link skipped: cycle until a later scan");
        wanted_parents.insert(child, None);
    }
    let cyclic: Vec<Uuid> = wanted_parents
        .iter()
        .filter(|(child, parent)| {
            !dependents.contains(*child)
                && parent.is_some_and(|id| creates_cycle(wanted_parents, ancestors, **child, id))
        })
        .map(|(child, _)| *child)
        .collect();
    for child in cyclic {
        tracing::debug!(issue_id = %child, "OpenProject parent link skipped: cycle until a later scan");
        wanted_parents.insert(child, None);
    }
}

/// Issue columns as JSON with empty placeholders for related collections, which
/// are not remote-owned. Remote persistence only updates the scalar columns.
const ISSUE_PROJECTION: &str = "(to_jsonb(i)-'workspace_id'-'reminder_generation') || jsonb_build_object('labels','[]'::jsonb,'dependencies','[]'::jsonb,'followers','[]'::jsonb,'attachments','[]'::jsonb,'source_links','[]'::jsonb)";

const CAPACITY_MESSAGE: &str = "OpenProject import stopped: workspace issue capacity reached (5000); reduce project mappings. Existing issues remain unchanged";

/// One issue's state before and after the page, with its changed fields.
type Change = (Option<Issue>, Issue, Vec<String>);

/// Reconciles one fetched page inside the caller's transaction and workspace graph locks.
#[tracing::instrument(name = "openproject_page", level = "debug", skip_all,
    fields(connection_id = %import.connection, team_id = %import.mapping.team_id, item_count = items.len()))]
pub(super) async fn apply_page(
    conn: &mut PgConnection,
    import: PageImport<'_>,
    items: &[WorkPackage],
) -> Result<()> {
    if items.is_empty() {
        return Ok(());
    }
    let workspace = import.workspace;
    let stages = load_stages(conn, workspace).await?;
    let statuses: BTreeMap<_, _> = import.statuses.iter().map(|s| (s.id, s)).collect();
    let status_names = lowercase_status_names(conn, items, &statuses).await?;
    let people = People::load(conn, &import, items).await?;
    let remote_ids: Vec<String> = items.iter().map(|item| item.id.to_string()).collect();
    let mut existing = load_existing(conn, &import, &remote_ids).await?;
    let page_ids: BTreeMap<i64, Uuid> = items
        .iter()
        .map(|item| {
            let id = existing
                .get(&item.id)
                .map_or_else(Uuid::new_v4, |issue| issue.id);
            (item.id, id)
        })
        .collect();

    let mut wanted_parents = page_parents(conn, &import, items, &page_ids).await?;
    // Children scanned earlier point at packages arriving on this page. Link them
    // in the same transaction so scan order never strands a hierarchy.
    let dependents = load_dependents(conn, &import, &remote_ids, &page_ids).await?;
    for (issue, parent) in &dependents {
        wanted_parents.insert(issue.id, Some(*parent));
    }
    // OpenProject prevents cycles, but pages can disagree mid-scan. Skip a link
    // that would close one; a later scan repairs it once both sides agree.
    // Dependents replay stored metadata, so they lose to fresh page edges.
    let ancestors = load_ancestors(conn, workspace, &wanted_parents).await?;
    let dependent_ids: BTreeSet<Uuid> = dependents.iter().map(|(issue, _)| issue.id).collect();
    break_parent_cycles(&mut wanted_parents, &ancestors, &dependent_ids);

    let new_count = items
        .iter()
        .map(|item| item.id)
        .filter(|id| !existing.contains_key(id))
        .collect::<BTreeSet<_>>()
        .len() as i64;
    let mut allocation = reserve_allocation(conn, &import, new_count).await?;

    let lookups = Lookups {
        import: &import,
        stages: &stages,
        statuses: &statuses,
        status_names: &status_names,
        people: &people,
        wanted_parents: &wanted_parents,
    };
    let mut changes = Vec::new();
    let mut links = BTreeMap::new();
    for item in items {
        let before = existing.get(&item.id).cloned();
        let (mut after, source, fields) = lookups.reconcile(item, &before, page_ids[&item.id])?;
        // Archive bookkeeping and the creator can change even when all visible remote fields match.
        let bookkeeping_changed = before.as_ref().is_some_and(|old| {
            old.done_at != after.done_at
                || old.archived_at != after.archived_at
                || old.created_by != after.created_by
        });
        let changed = before.is_none() || !fields.is_empty() || bookkeeping_changed;
        tracing::debug!(work_package_id = item.id, issue_id = %after.id, creating = before.is_none(), changed, fields = ?fields,
            "OpenProject work package reconciled in page transaction");
        if changed {
            persist_item(conn, &import, &before, &mut after, &source, &mut allocation).await?;
            changes.push((before, after.clone(), fields));
        }
        links.insert(after.id, source.url);
        existing.insert(item.id, after);
    }
    relink_dependents(conn, workspace, dependents, &wanted_parents, &mut changes).await?;
    apply_effects(conn, workspace, changes, stages).await?;
    insert_source_links(conn, workspace, links).await
}

async fn load_stages(conn: &mut PgConnection, workspace: Uuid) -> Result<Vec<Stage>> {
    let rows = sqlx::query(
        "SELECT id,team_id,lower(name) AS name,kind,position FROM stages WHERE workspace_id=$1",
    )
    .bind(workspace)
    .fetch_all(&mut *conn)
    .await?;
    rows.into_iter()
        .map(|row| {
            Ok(Stage {
                id: row.try_get("id")?,
                team: row.try_get("team_id")?,
                name: row.try_get("name")?,
                kind: row.try_get("kind")?,
                position: row.try_get("position")?,
            })
        })
        .collect()
}

fn status_name<'a>(statuses: &BTreeMap<i64, &'a Status>, item: &'a WorkPackage) -> &'a str {
    statuses
        .get(&item.status_id)
        .map(|status| status.name.as_str())
        .or(item.status_name.as_deref())
        .unwrap_or("Unknown")
}

/// Status names mapped to their lowercase form. Match PostgreSQL's case
/// folding on both sides, including non-ASCII names.
async fn lowercase_status_names(
    conn: &mut PgConnection,
    items: &[WorkPackage],
    statuses: &BTreeMap<i64, &Status>,
) -> Result<BTreeMap<String, String>> {
    let names: BTreeSet<String> = items
        .iter()
        .map(|item| status_name(statuses, item).to_owned())
        .collect();
    Ok(sqlx::query_as::<_, (String, String)>(
        "SELECT name,lower(name) FROM unnest($1::text[]) AS names(name)",
    )
    .bind(names.into_iter().collect::<Vec<_>>())
    .fetch_all(&mut *conn)
    .await?
    .into_iter()
    .collect())
}

/// Remote people and the workspace members they map to. Assignees and
/// authors map to members by the same rules.
struct People<'a> {
    by_id: BTreeMap<i64, &'a Person>,
    mapping: &'a BTreeMap<String, Uuid>,
    users: BTreeMap<String, Option<Uuid>>,
}

impl<'a> People<'a> {
    async fn load(
        conn: &mut PgConnection,
        import: &PageImport<'a>,
        items: &[WorkPackage],
    ) -> Result<Self> {
        let mut people = Self {
            by_id: import
                .people
                .iter()
                .map(|person| (person.id, person))
                .collect(),
            mapping: import.people_mapping,
            users: BTreeMap::new(),
        };
        let emails: BTreeSet<String> = items
            .iter()
            .flat_map(|item| [people.email(item.assignee_id), people.email(item.author_id)])
            .flatten()
            .collect();
        if emails.is_empty() {
            return Ok(people);
        }

        let mapped: Vec<Uuid> = emails
            .iter()
            .filter_map(|email| people.mapping.get(email).copied())
            .collect();
        let rows = sqlx::query("SELECT u.id,lower(u.email) AS email FROM users u JOIN workspace_members m ON m.user_id=u.id WHERE m.workspace_id=$1 AND (u.id=ANY($2) OR lower(u.email)=ANY($3))")
            .bind(import.workspace).bind(&mapped).bind(emails.iter().cloned().collect::<Vec<_>>())
            .fetch_all(&mut *conn).await?;
        let mut members_by_id = BTreeSet::new();
        let mut members_by_email = BTreeMap::new();
        for row in rows {
            let id: Uuid = row.try_get("id")?;
            members_by_id.insert(id);
            members_by_email.insert(row.try_get::<String, _>("email")?, id);
        }
        // An explicit mapping wins, but only while the mapped user is still a member.
        for email in emails {
            let user = match people.mapping.get(&email) {
                Some(id) => members_by_id.contains(id).then_some(*id),
                None => members_by_email.get(&email).copied(),
            };
            people.users.insert(email, user);
        }
        Ok(people)
    }

    fn email(&self, id: Option<i64>) -> Option<String> {
        id.and_then(|id| self.by_id.get(&id))
            .and_then(|person| person.email.as_ref())
            .map(|email| email.trim().to_lowercase())
    }

    fn user(&self, email: &Option<String>) -> Option<Uuid> {
        email
            .as_ref()
            .and_then(|email| self.users.get(email).copied().flatten())
    }

    fn explicitly_mapped(&self, email: &Option<String>) -> bool {
        email
            .as_ref()
            .is_some_and(|email| self.mapping.contains_key(email))
    }
}

async fn fetch_issues(
    conn: &mut PgConnection,
    query: &str,
    workspace: Uuid,
    connection: Uuid,
    remote_ids: &[String],
) -> Result<Vec<Issue>> {
    let rows: Vec<Value> = sqlx::query_scalar(query)
        .bind(workspace)
        .bind(connection.to_string())
        .bind(remote_ids)
        .fetch_all(&mut *conn)
        .await?;
    rows.into_iter()
        .map(|row| Ok(serde_json::from_value(row)?))
        .collect()
}

/// Already imported issues for the page, locked and keyed by work package id.
async fn load_existing(
    conn: &mut PgConnection,
    import: &PageImport<'_>,
    remote_ids: &[String],
) -> Result<BTreeMap<i64, Issue>> {
    let query = format!(
        "SELECT {ISSUE_PROJECTION} FROM issues i WHERE workspace_id=$1 AND openproject->>'connection_id'=$2 AND openproject->>'work_package_id'=ANY($3) ORDER BY id FOR UPDATE"
    );
    let issues = fetch_issues(
        conn,
        &query,
        import.workspace,
        import.connection,
        remote_ids,
    )
    .await?;
    issues
        .into_iter()
        .map(|issue| {
            let id = issue
                .openproject
                .as_ref()
                .ok_or_else(|| Error::Internal("imported issue has no source".into()))?
                .work_package_id;
            Ok((id, issue))
        })
        .collect()
}

/// Resolves remote parents to local issues of the same connection, whether the
/// parent is already imported or arrives on this page.
async fn page_parents(
    conn: &mut PgConnection,
    import: &PageImport<'_>,
    items: &[WorkPackage],
    page_ids: &BTreeMap<i64, Uuid>,
) -> Result<BTreeMap<Uuid, Option<Uuid>>> {
    let missing: BTreeSet<String> = items
        .iter()
        .filter_map(|item| item.parent_id)
        .filter(|id| !page_ids.contains_key(id))
        .map(|id| id.to_string())
        .collect();
    let mut known = BTreeMap::new();
    if !missing.is_empty() {
        let rows = sqlx::query("SELECT id,openproject->>'work_package_id' AS package FROM issues WHERE workspace_id=$1 AND openproject->>'connection_id'=$2 AND openproject->>'work_package_id'=ANY($3)")
            .bind(import.workspace).bind(import.connection.to_string()).bind(missing.into_iter().collect::<Vec<_>>()).fetch_all(&mut *conn).await?;
        for row in rows {
            let package: String = row.try_get("package")?;
            let package: i64 = package
                .parse()
                .map_err(|_| Error::Internal("invalid OpenProject identity".into()))?;
            known.insert(package, row.try_get("id")?);
        }
    }
    Ok(items
        .iter()
        .map(|item| {
            let parent = item
                .parent_id
                .and_then(|id| page_ids.get(&id).or_else(|| known.get(&id)).copied());
            (page_ids[&item.id], parent)
        })
        .collect())
}

/// Imported issues off this page whose parent arrives on it, each with that parent's local id.
async fn load_dependents(
    conn: &mut PgConnection,
    import: &PageImport<'_>,
    remote_ids: &[String],
    page_ids: &BTreeMap<i64, Uuid>,
) -> Result<Vec<(Issue, Uuid)>> {
    let query = format!(
        "SELECT {ISSUE_PROJECTION} FROM issues i WHERE workspace_id=$1 AND openproject->>'connection_id'=$2 AND openproject->>'parent_work_package_id'=ANY($3) AND NOT (openproject->>'work_package_id'=ANY($3)) ORDER BY id FOR UPDATE"
    );
    let issues = fetch_issues(
        conn,
        &query,
        import.workspace,
        import.connection,
        remote_ids,
    )
    .await?;
    issues
        .into_iter()
        .map(|issue| {
            let parent = issue
                .openproject
                .as_ref()
                .and_then(|source| source.parent_work_package_id)
                .and_then(|id| page_ids.get(&id).copied())
                .ok_or_else(|| Error::Internal("imported child misses its page parent".into()))?;
            Ok((issue, parent))
        })
        .collect()
}

/// Stored parent links above every wanted parent.
async fn load_ancestors(
    conn: &mut PgConnection,
    workspace: Uuid,
    wanted_parents: &BTreeMap<Uuid, Option<Uuid>>,
) -> Result<BTreeMap<Uuid, Option<Uuid>>> {
    let roots: BTreeSet<Uuid> = wanted_parents
        .values()
        .filter_map(|parent| *parent)
        .collect();
    if roots.is_empty() {
        return Ok(BTreeMap::new());
    }
    let rows = sqlx::query("WITH RECURSIVE ancestors(id,parent_id) AS (SELECT id,parent_id FROM issues WHERE workspace_id=$1 AND id=ANY($2) UNION SELECT i.id,i.parent_id FROM issues i JOIN ancestors a ON i.id=a.parent_id WHERE i.workspace_id=$1) SELECT id,parent_id FROM ancestors")
        .bind(workspace).bind(roots.into_iter().collect::<Vec<_>>()).fetch_all(&mut *conn).await?;
    rows.into_iter()
        .map(|row| Ok((row.try_get("id")?, row.try_get("parent_id")?)))
        .collect()
}

async fn reserve_allocation(
    conn: &mut PgConnection,
    import: &PageImport<'_>,
    new_count: i64,
) -> Result<Option<persistence::CreationBatch>> {
    if new_count == 0 {
        return Ok(None);
    }
    let mut count = None;
    persistence::capacity(
        conn,
        import.workspace,
        "issues",
        5000,
        &mut count,
        CAPACITY_MESSAGE,
    )
    .await?;
    if count.unwrap_or_default() + new_count > 5000 {
        return Err(Error::BadRequest(CAPACITY_MESSAGE.into()));
    }
    Ok(Some(
        persistence::allocate_creations(conn, import.workspace, import.mapping.team_id, new_count)
            .await?,
    ))
}

/// Everything `reconcile` reads to map one work package onto an issue.
struct Lookups<'a> {
    import: &'a PageImport<'a>,
    stages: &'a [Stage],
    statuses: &'a BTreeMap<i64, &'a Status>,
    status_names: &'a BTreeMap<String, String>,
    people: &'a People<'a>,
    wanted_parents: &'a BTreeMap<Uuid, Option<Uuid>>,
}

impl Lookups<'_> {
    /// An explicit stage mapping wins; otherwise the team stage named like the
    /// status, then one of the matching kind, by position.
    fn destination(&self, item: &WorkPackage) -> Result<&Stage> {
        let team = self.import.mapping.team_id;
        if let Some(id) = self
            .import
            .mapping
            .stage_mapping
            .get(&item.status_id.to_string())
        {
            return self
                .stages
                .iter()
                .find(|stage| stage.id == *id && stage.team == team)
                .ok_or_else(|| {
                    Error::BadRequest(
                        "OpenProject mapped stage no longer exists; update project stage mapping"
                            .into(),
                    )
                });
        }
        let name = self
            .status_names
            .get(status_name(self.statuses, item))
            .ok_or_else(|| Error::Internal("missing OpenProject status name".into()))?;
        let kind = if self.closed(item) { "done" } else { "backlog" };
        self.stages
            .iter()
            .filter(|stage| stage.team == team)
            .min_by_key(|stage| {
                (
                    stage.name != *name,
                    stage.kind != kind,
                    stage.position,
                    stage.id,
                )
            })
            .ok_or_else(|| Error::Internal("destination team has no stage".into()))
    }

    fn closed(&self, item: &WorkPackage) -> bool {
        self.statuses
            .get(&item.status_id)
            .is_some_and(|status| status.is_closed)
    }

    /// The issue as the page describes it, its source and the fields that changed.
    fn reconcile(
        &self,
        item: &WorkPackage,
        before: &Option<Issue>,
        id: Uuid,
    ) -> Result<(Issue, OpenProjectSource, Vec<String>)> {
        let PageImport {
            connection,
            base,
            mapping,
            ..
        } = self.import;
        let destination = self.destination(item)?;
        tracing::debug!(work_package_id = item.id, status_id = item.status_id, stage_id = %destination.id,
            explicit_mapping = mapping.stage_mapping.contains_key(&item.status_id.to_string()),
            closed = self.closed(item), "OpenProject status mapped");
        let source = OpenProjectSource {
            connection_id: *connection,
            work_package_id: item.id,
            project_id: item.project_id,
            parent_work_package_id: item.parent_id,
            status_name: status_name(self.statuses, item).to_owned(),
            url: format!("{base}/work_packages/{}", item.id),
            unavailable: false,
        };

        let mut after = before
            .clone()
            .unwrap_or_else(|| new_issue(id, mapping.team_id, destination.id));
        after.title = item.title.clone();
        after.description = item.description.clone();
        after.team_id = mapping.team_id;
        after.stage_id = destination.id;
        let email = self.people.email(item.assignee_id);
        after.assignee = self.people.user(&email);
        tracing::debug!(work_package_id = item.id, remote_assignee_id = ?item.assignee_id,
            email_available = email.is_some(), assignee_id = ?after.assignee,
            explicit_mapping = self.people.explicitly_mapped(&email),
            "OpenProject assignee mapped");
        let author_email = self.people.email(item.author_id);
        after.created_by = self.people.user(&author_email);
        tracing::debug!(work_package_id = item.id, remote_author_id = ?item.author_id,
            email_available = author_email.is_some(), created_by = ?after.created_by,
            explicit_mapping = self.people.explicitly_mapped(&author_email),
            "OpenProject author mapped");
        after.priority = item.priority.clone();
        after.deadline = item.deadline;
        after.project_id = None;
        after.milestone_id = None;
        after.sprint_id = None;
        if destination.kind == "done" {
            after.done_at.get_or_insert_with(Utc::now);
        } else {
            after.done_at = None;
            after.archived_at = None;
        }
        after.openproject = Some(source.clone());
        after.parent_id = self.wanted_parents.get(&after.id).copied().flatten();

        let mut fields = Vec::new();
        if let Some(old) = before {
            fields = old.changed_fields(&after);
            if old.team_id != after.team_id {
                fields.push("team".into());
            }
            if old.openproject != after.openproject {
                fields.push("openproject".into());
            }
        }
        Ok((after, source, fields))
    }
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
        openproject: None,
        blocked_count: 0,
        subtask_total: 0,
        subtask_completed: 0,
        version: 1,
    }
}

async fn persist_item(
    conn: &mut PgConnection,
    import: &PageImport<'_>,
    before: &Option<Issue>,
    after: &mut Issue,
    source: &OpenProjectSource,
    allocation: &mut Option<persistence::CreationBatch>,
) -> Result<()> {
    if before.is_none() {
        let allocation = allocation
            .as_mut()
            .ok_or_else(|| Error::Internal("missing import allocation".into()))?;
        return persistence::create_allocated(conn, import.workspace, after, source, allocation)
            .await;
    }
    persistence::save(
        conn,
        import.workspace,
        after,
        persistence::Ownership::Remote(source),
    )
    .await?;
    if let Some(allocation) = allocation {
        allocation.include(after, import.mapping.team_id);
    }
    Ok(())
}

async fn relink_dependents(
    conn: &mut PgConnection,
    workspace: Uuid,
    dependents: Vec<(Issue, Uuid)>,
    wanted_parents: &BTreeMap<Uuid, Option<Uuid>>,
    changes: &mut Vec<Change>,
) -> Result<()> {
    for (old, _) in dependents {
        let parent = wanted_parents.get(&old.id).copied().flatten();
        if old.parent_id == parent {
            continue;
        }
        let mut after = old.clone();
        after.parent_id = parent;
        let source = after
            .openproject
            .clone()
            .ok_or_else(|| Error::Internal("imported issue has no source".into()))?;
        persistence::save(
            conn,
            workspace,
            &after,
            persistence::Ownership::Remote(&source),
        )
        .await?;
        let fields = old.changed_fields(&after);
        tracing::debug!(issue_id = %after.id, changed = true, fields = ?fields,
            "OpenProject child linked in page transaction");
        changes.push((Some(old), after, fields));
    }
    Ok(())
}

/// Runs notifications, reminders and activity for every changed issue.
async fn apply_effects(
    conn: &mut PgConnection,
    workspace: Uuid,
    changes: Vec<Change>,
    stages: Vec<Stage>,
) -> Result<()> {
    if changes.is_empty() {
        return Ok(());
    }
    let changed_ids: Vec<Uuid> = changes
        .iter()
        .filter(|(before, _, _)| before.is_some())
        .map(|(_, after, _)| after.id)
        .collect();
    let mut followers: BTreeMap<Uuid, Vec<Uuid>> = BTreeMap::new();
    if !changed_ids.is_empty() {
        let rows = sqlx::query("SELECT issue_id,user_id FROM issue_followers WHERE workspace_id=$1 AND issue_id=ANY($2) ORDER BY issue_id,user_id")
            .bind(workspace).bind(&changed_ids).fetch_all(&mut *conn).await?;
        for row in rows {
            followers
                .entry(row.try_get("issue_id")?)
                .or_default()
                .push(row.try_get("user_id")?);
        }
    }
    let effects = persistence::PageEffects::load(
        conn,
        workspace,
        stages
            .into_iter()
            .map(|stage| (stage.id, stage.kind))
            .collect(),
    )
    .await?;
    for (before, mut after, fields) in changes {
        after.followers = followers.get(&after.id).cloned().unwrap_or_default();
        effects
            .apply(conn, workspace, before.as_ref(), &after, fields)
            .await?;
    }
    Ok(())
}

async fn insert_source_links(
    conn: &mut PgConnection,
    workspace: Uuid,
    links: BTreeMap<Uuid, String>,
) -> Result<()> {
    let ids: Vec<Uuid> = links.keys().copied().collect();
    let urls: Vec<String> = links.into_values().collect();
    let link_ids: Vec<Uuid> = ids.iter().map(|_| Uuid::new_v4()).collect();
    sqlx::query("INSERT INTO source_links(id,workspace_id,issue_id,url,title) SELECT input.id,$1,input.issue_id,input.url,'OpenProject' FROM unnest($2::uuid[],$3::uuid[],$4::text[]) AS input(id,issue_id,url) WHERE NOT EXISTS(SELECT 1 FROM source_links s WHERE s.workspace_id=$1 AND s.issue_id=input.issue_id AND s.url=input.url AND s.title='OpenProject') ON CONFLICT DO NOTHING")
        .bind(workspace).bind(link_ids).bind(ids).bind(urls).execute(conn).await?;
    Ok(())
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
        break_parent_cycles(&mut wanted, &BTreeMap::new(), &BTreeSet::from([b]));
        assert_eq!(wanted[&a], Some(b));
        assert_eq!(wanted[&b], None);
    }
}
