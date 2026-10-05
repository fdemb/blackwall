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

/// Reconciles one fetched page inside the caller's transaction and workspace graph locks.
#[tracing::instrument(name = "openproject_page", level = "debug", skip_all,
    fields(connection_id = %import.connection, team_id = %import.mapping.team_id, item_count = items.len()))]
pub(super) async fn apply_page(
    conn: &mut PgConnection,
    import: PageImport<'_>,
    items: &[WorkPackage],
) -> Result<()> {
    let PageImport {
        workspace,
        connection,
        base,
        mapping,
        statuses,
        people,
        people_mapping,
    } = import;
    if items.is_empty() {
        return Ok(());
    }
    let rows = sqlx::query(
        "SELECT id,team_id,lower(name) AS name,kind,position FROM stages WHERE workspace_id=$1",
    )
    .bind(workspace)
    .fetch_all(&mut *conn)
    .await?;
    let mut stages = Vec::with_capacity(rows.len());
    for row in rows {
        stages.push(Stage {
            id: row.try_get("id")?,
            team: row.try_get("team_id")?,
            name: row.try_get("name")?,
            kind: row.try_get("kind")?,
            position: row.try_get("position")?,
        });
    }
    let statuses: BTreeMap<_, _> = statuses.iter().map(|status| (status.id, status)).collect();
    let status_names: Vec<String> = items
        .iter()
        .map(|item| {
            statuses
                .get(&item.status_id)
                .map(|status| status.name.as_str())
                .or(item.status_name.as_deref())
                .unwrap_or("Unknown")
                .to_owned()
        })
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    // Match PostgreSQL's case folding on both sides, including non-ASCII names.
    let normalized_names: BTreeMap<String, String> = sqlx::query_as::<_, (String, String)>(
        "SELECT name,lower(name) FROM unnest($1::text[]) AS names(name)",
    )
    .bind(status_names)
    .fetch_all(&mut *conn)
    .await?
    .into_iter()
    .collect();
    let people: BTreeMap<_, _> = people.iter().map(|person| (person.id, person)).collect();
    let emails: BTreeSet<String> = items
        .iter()
        .filter_map(|item| {
            item.assignee_id
                .and_then(|id| people.get(&id))
                .and_then(|person| person.email.as_ref())
                .map(|email| email.trim().to_lowercase())
        })
        .collect();
    let mapped: Vec<Uuid> = emails
        .iter()
        .filter_map(|email| people_mapping.get(email).copied())
        .collect();
    let mut members_by_id = BTreeSet::new();
    let mut members_by_email = BTreeMap::new();
    if !emails.is_empty() {
        let rows = sqlx::query("SELECT u.id,lower(u.email) AS email FROM users u JOIN workspace_members m ON m.user_id=u.id WHERE m.workspace_id=$1 AND (u.id=ANY($2) OR lower(u.email)=ANY($3))")
            .bind(workspace).bind(&mapped).bind(emails.iter().cloned().collect::<Vec<_>>())
            .fetch_all(&mut *conn).await?;
        for row in rows {
            let id: Uuid = row.try_get("id")?;
            members_by_id.insert(id);
            members_by_email.insert(row.try_get::<String, _>("email")?, id);
        }
    }
    let assignees: BTreeMap<_, _> = emails
        .into_iter()
        .map(|email| {
            let assignee = match people_mapping.get(&email) {
                Some(id) => members_by_id.contains(id).then_some(*id),
                None => members_by_email.get(&email).copied(),
            };
            (email, assignee)
        })
        .collect();
    let remote_ids: Vec<String> = items.iter().map(|item| item.id.to_string()).collect();
    // Related collections are not remote-owned. Empty placeholders avoid their aggregates;
    // remote persistence only updates the scalar columns carried by this projection.
    let rows: Vec<Value> = sqlx::query_scalar("SELECT (to_jsonb(i)-'workspace_id'-'reminder_generation') || jsonb_build_object('labels','[]'::jsonb,'dependencies','[]'::jsonb,'followers','[]'::jsonb,'attachments','[]'::jsonb,'source_links','[]'::jsonb) FROM issues i WHERE workspace_id=$1 AND openproject->>'connection_id'=$2 AND openproject->>'work_package_id'=ANY($3) ORDER BY id FOR UPDATE")
        .bind(workspace).bind(connection.to_string()).bind(&remote_ids)
        .fetch_all(&mut *conn).await?;
    let mut existing = BTreeMap::new();
    for row in rows {
        let issue: Issue = serde_json::from_value(row)?;
        let id = issue
            .openproject
            .as_ref()
            .ok_or_else(|| Error::Internal("imported issue has no source".into()))?
            .work_package_id;
        existing.insert(id, issue);
    }
    let connection_id = connection.to_string();
    let mut fresh = BTreeMap::new();
    for item in items {
        if !existing.contains_key(&item.id) {
            fresh.insert(item.id, Uuid::new_v4());
        }
    }
    let mut page_ids = BTreeMap::new();
    for item in items {
        let id = existing
            .get(&item.id)
            .map(|issue| issue.id)
            .or_else(|| fresh.get(&item.id).copied())
            .ok_or_else(|| Error::Internal("missing OpenProject page issue".into()))?;
        page_ids.insert(item.id, id);
    }
    // Resolve remote parents to local issues of the same connection, whether the
    // parent is already imported or arrives on this page.
    let missing: Vec<String> = items
        .iter()
        .filter_map(|item| item.parent_id)
        .filter(|id| !page_ids.contains_key(id))
        .map(|id| id.to_string())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    let mut known = BTreeMap::new();
    if !missing.is_empty() {
        let rows = sqlx::query("SELECT id,openproject->>'work_package_id' AS package FROM issues WHERE workspace_id=$1 AND openproject->>'connection_id'=$2 AND openproject->>'work_package_id'=ANY($3)")
            .bind(workspace).bind(&connection_id).bind(&missing).fetch_all(&mut *conn).await?;
        for row in rows {
            let package: String = row.try_get("package")?;
            let package: i64 = package
                .parse()
                .map_err(|_| Error::Internal("invalid OpenProject identity".into()))?;
            known.insert(package, row.try_get("id")?);
        }
    }
    let mut wanted_parents: BTreeMap<Uuid, Option<Uuid>> = BTreeMap::new();
    for item in items {
        let parent = item.parent_id.and_then(|id| {
            page_ids
                .get(&id)
                .copied()
                .or_else(|| known.get(&id).copied())
        });
        wanted_parents.insert(page_ids[&item.id], parent);
    }
    // Children scanned earlier point at packages arriving on this page. Link them
    // in the same transaction so scan order never strands a hierarchy.
    let rows: Vec<Value> = sqlx::query_scalar("SELECT (to_jsonb(i)-'workspace_id'-'reminder_generation') || jsonb_build_object('labels','[]'::jsonb,'dependencies','[]'::jsonb,'followers','[]'::jsonb,'attachments','[]'::jsonb,'source_links','[]'::jsonb) FROM issues i WHERE workspace_id=$1 AND openproject->>'connection_id'=$2 AND openproject->>'parent_work_package_id'=ANY($3) AND NOT (openproject->>'work_package_id'=ANY($3)) ORDER BY id FOR UPDATE")
        .bind(workspace).bind(&connection_id).bind(&remote_ids).fetch_all(&mut *conn).await?;
    let mut dependents = Vec::new();
    for row in rows {
        let issue: Issue = serde_json::from_value(row)?;
        let parent = issue
            .openproject
            .as_ref()
            .and_then(|source| source.parent_work_package_id)
            .and_then(|id| page_ids.get(&id).copied())
            .ok_or_else(|| Error::Internal("imported child misses its page parent".into()))?;
        wanted_parents.insert(issue.id, Some(parent));
        dependents.push(issue);
    }
    // OpenProject prevents cycles, but pages can disagree mid-scan. Skip a link
    // that would close one; a later scan repairs it once both sides agree.
    // Dependents replay stored metadata, so they lose to fresh page edges.
    let roots: Vec<Uuid> = wanted_parents
        .values()
        .filter_map(|parent| *parent)
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    let mut ancestors: BTreeMap<Uuid, Option<Uuid>> = BTreeMap::new();
    if !roots.is_empty() {
        let rows = sqlx::query("WITH RECURSIVE ancestors(id,parent_id) AS (SELECT id,parent_id FROM issues WHERE workspace_id=$1 AND id=ANY($2) UNION SELECT i.id,i.parent_id FROM issues i JOIN ancestors a ON i.id=a.parent_id WHERE i.workspace_id=$1) SELECT id,parent_id FROM ancestors")
            .bind(workspace).bind(&roots).fetch_all(&mut *conn).await?;
        for row in rows {
            ancestors.insert(row.try_get("id")?, row.try_get("parent_id")?);
        }
    }
    let dependent_ids: BTreeSet<Uuid> = dependents.iter().map(|issue| issue.id).collect();
    break_parent_cycles(&mut wanted_parents, &ancestors, &dependent_ids);
    let new_count = items
        .iter()
        .map(|item| item.id)
        .filter(|id| !existing.contains_key(id))
        .collect::<BTreeSet<_>>()
        .len() as i64;
    let mut allocation = if new_count > 0 {
        let mut count = None;
        persistence::capacity(conn, workspace, "issues", 5000, &mut count,
            "OpenProject import stopped: workspace issue capacity reached (5000); reduce project mappings. Existing issues remain unchanged").await?;
        if count.unwrap_or_default() + new_count > 5000 {
            return Err(Error::BadRequest("OpenProject import stopped: workspace issue capacity reached (5000); reduce project mappings. Existing issues remain unchanged".into()));
        }
        Some(persistence::allocate_creations(conn, workspace, mapping.team_id, new_count).await?)
    } else {
        None
    };
    let mut changes = Vec::new();
    let mut links = BTreeMap::new();
    for item in items {
        let status = statuses.get(&item.status_id);
        let status_name = status
            .map(|status| status.name.as_str())
            .or(item.status_name.as_deref())
            .unwrap_or("Unknown");
        let closed = status.is_some_and(|status| status.is_closed);
        let destination = if let Some(id) = mapping.stage_mapping.get(&item.status_id.to_string()) {
            stages
                .iter()
                .find(|stage| stage.id == *id && stage.team == mapping.team_id)
                .ok_or_else(|| {
                    Error::BadRequest(
                        "OpenProject mapped stage no longer exists; update project stage mapping"
                            .into(),
                    )
                })?
        } else {
            let name = normalized_names
                .get(status_name)
                .ok_or_else(|| Error::Internal("missing OpenProject status name".into()))?;
            let kind = if closed { "done" } else { "backlog" };
            stages
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
        tracing::debug!(work_package_id = item.id, status_id = item.status_id, stage_id = %destination.id,
            explicit_mapping = mapping.stage_mapping.contains_key(&item.status_id.to_string()),
            closed, "OpenProject status mapped");
        let source = OpenProjectSource {
            connection_id: connection,
            work_package_id: item.id,
            project_id: item.project_id,
            parent_work_package_id: item.parent_id,
            status_name: status_name.to_owned(),
            url: format!("{base}/work_packages/{}", item.id),
            unavailable: false,
        };
        let before = existing.get(&item.id).cloned();
        let id = page_ids[&item.id];
        let mut after = before.clone().unwrap_or_else(|| {
            let now = Utc::now();
            Issue {
                id,
                number: 0,
                title: String::new(),
                description: String::new(),
                team_id: mapping.team_id,
                stage_id: destination.id,
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
        });
        after.title = item.title.clone();
        after.description = item.description.clone();
        after.team_id = mapping.team_id;
        after.stage_id = destination.id;
        let email = item
            .assignee_id
            .and_then(|id| people.get(&id))
            .and_then(|person| person.email.as_ref())
            .map(|email| email.trim().to_lowercase());
        after.assignee = email
            .as_ref()
            .and_then(|email| assignees.get(email).copied().flatten());
        tracing::debug!(work_package_id = item.id, remote_assignee_id = ?item.assignee_id,
            email_available = email.is_some(), assignee_id = ?after.assignee,
            explicit_mapping = email.as_ref().is_some_and(|email| people_mapping.contains_key(email)),
            "OpenProject assignee mapped");
        after.priority = item.priority.clone();
        after.deadline = item.deadline;
        after.project_id = None;
        after.milestone_id = None;
        after.sprint_id = None;
        if destination.kind == "done" {
            if after.done_at.is_none() {
                after.done_at = Some(Utc::now());
            }
        } else {
            after.done_at = None;
            after.archived_at = None;
        }
        after.openproject = Some(source.clone());
        after.parent_id = wanted_parents.get(&after.id).copied().flatten();
        let mut fields = before
            .as_ref()
            .map(|old| persistence::changed_fields(old, &after))
            .unwrap_or_default();
        if let Some(old) = &before {
            if old.team_id != after.team_id {
                fields.push("team".into());
            }
            if old.openproject != after.openproject {
                fields.push("openproject".into());
            }
        }
        // Archive bookkeeping can change even when all visible remote fields match.
        let bookkeeping_changed = before.as_ref().is_some_and(|old| {
            old.done_at != after.done_at || old.archived_at != after.archived_at
        });
        let changed = before.is_none() || !fields.is_empty() || bookkeeping_changed;
        tracing::debug!(work_package_id = item.id, issue_id = %after.id, creating = before.is_none(), changed, fields = ?fields,
            "OpenProject work package reconciled in page transaction");
        if changed {
            if before.is_some() {
                persistence::save(
                    conn,
                    workspace,
                    &after,
                    persistence::Ownership::Remote(&source),
                )
                .await?;
                if let Some(allocation) = &mut allocation {
                    allocation.include(&after, mapping.team_id);
                }
            } else {
                persistence::create_allocated(
                    conn,
                    workspace,
                    &mut after,
                    &source,
                    allocation
                        .as_mut()
                        .ok_or_else(|| Error::Internal("missing import allocation".into()))?,
                )
                .await?;
            }
            changes.push((before, after.clone(), fields));
        }
        links.insert(after.id, source.url);
        existing.insert(item.id, after);
    }
    for old in dependents {
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
        let fields = persistence::changed_fields(&old, &after);
        tracing::debug!(issue_id = %after.id, changed = true, fields = ?fields,
            "OpenProject child linked in page transaction");
        changes.push((Some(old), after, fields));
    }
    if !changes.is_empty() {
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
    }
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
