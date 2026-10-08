use super::*;
use crate::jobs::Reminder;
use std::collections::BTreeSet;

impl Operation<'_> {
    pub(super) async fn lock_graph(&mut self) -> Result<()> {
        sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1, 41827))")
            .bind(self.workspace_id.to_string())
            .execute(&mut *self.tx)
            .await?;

        Ok(())
    }

    pub(super) async fn capacity(&mut self, table: &str, max: i64) -> Result<()> {
        persistence::capacity(
            &mut self.tx,
            self.workspace_id,
            table,
            max,
            &mut None,
            "workspace capacity reached",
        )
        .await
    }

    pub(super) async fn validate_workflow(&mut self) -> Result<()> {
        let affected: Vec<Uuid> = self.versions.keys().map(|(_, id)| *id).collect();

        let bad: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM issues i JOIN stages s ON s.id=i.stage_id WHERE i.workspace_id=$1 AND i.deleted_at IS NULL AND s.kind IN ('active','done') AND (i.id=ANY($2) OR i.stage_id=ANY($2) OR EXISTS(SELECT 1 FROM issue_dependencies d WHERE d.issue_id=i.id AND d.dependency_id=ANY($2))) AND EXISTS(SELECT 1 FROM issue_dependencies d JOIN issues other ON other.id=d.dependency_id JOIN stages os ON os.id=other.stage_id WHERE d.issue_id=i.id AND (other.deleted_at IS NOT NULL OR os.kind NOT IN ('done','cancelled'))))")
            .bind(self.workspace_id)
            .bind(&affected)
            .fetch_one(&mut *self.tx)
            .await?;

        if bad {
            return Err(Error::Conflict(
                "workflow would leave an issue with unfinished dependencies".into(),
            ));
        }

        Ok(())
    }

    pub(super) async fn schedule_reminder(&mut self, id: Uuid) -> Result<()> {
        persistence::schedule_reminder(&mut self.tx, self.workspace_id, id).await
    }

    async fn validate_issue_sql(&mut self, i: &Issue) -> Result<()> {
        crate::domain::text(&i.title, 500)?;

        if i.description.len() > 100_000 {
            return Err(Error::BadRequest("description too long".into()));
        }

        let stage = sqlx::query(
            "SELECT kind FROM stages WHERE workspace_id=$1 AND team_id=$2 AND id=$3 FOR SHARE",
        )
        .bind(self.workspace_id)
        .bind(i.team_id)
        .bind(i.stage_id)
        .fetch_optional(&mut *self.tx)
        .await?
        .ok_or_else(|| Error::BadRequest("stage belongs to another team".into()))?;
        let kind: String = stage.try_get("kind")?;

        if let Some(user) = i.assignee {
            self.member(user).await?;
        }

        for label in &i.labels {
            sqlx::query("SELECT id FROM labels WHERE workspace_id=$1 AND id=$2 FOR SHARE")
                .bind(self.workspace_id)
                .bind(label)
                .fetch_optional(&mut *self.tx)
                .await?
                .ok_or_else(|| Error::BadRequest("unknown label".into()))?;
        }

        if let Some(project) = i.project_id {
            sqlx::query("SELECT project_id FROM project_teams WHERE workspace_id=$1 AND project_id=$2 AND team_id=$3 FOR SHARE")
                .bind(self.workspace_id)
                .bind(project)
                .bind(i.team_id)
                .fetch_optional(&mut *self.tx)
                .await?
                .ok_or_else(||Error::BadRequest("project does not include team".into()))?;
        }

        if let Some(milestone) = i.milestone_id {
            let project: Uuid = sqlx::query_scalar(
                "SELECT project_id FROM milestones WHERE workspace_id=$1 AND id=$2 FOR SHARE",
            )
            .bind(self.workspace_id)
            .bind(milestone)
            .fetch_optional(&mut *self.tx)
            .await?
            .ok_or(Error::NotFound)?;
            if Some(project) != i.project_id {
                return Err(Error::BadRequest(
                    "milestone belongs to another project".into(),
                ));
            }
        }

        if let Some(sprint) = i.sprint_id {
            let row = sqlx::query(
                "SELECT team_id,state FROM sprints WHERE workspace_id=$1 AND id=$2 FOR SHARE",
            )
            .bind(self.workspace_id)
            .bind(sprint)
            .fetch_optional(&mut *self.tx)
            .await?
            .ok_or(Error::NotFound)?;
            let state: String = row.try_get("state")?;
            let retained: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM issues WHERE workspace_id=$1 AND id=$2 AND sprint_id=$3)")
                .bind(self.workspace_id)
                .bind(i.id)
                .bind(sprint)
                .fetch_one(&mut *self.tx)
                .await?;
            if row.try_get::<Uuid, _>("team_id")? != i.team_id
                || (matches!(state.as_str(), "completed" | "archived")
                    && !(retained && matches!(kind.as_str(), "done" | "cancelled")))
            {
                return Err(Error::BadRequest(
                    "sprint is unavailable for this team".into(),
                ));
            }
        }

        for dep in i.dependencies.iter().copied().collect::<BTreeSet<_>>() {
            let row = sqlx::query("SELECT i.deleted_at,i.openproject,s.kind FROM issues i JOIN stages s ON s.id=i.stage_id WHERE i.workspace_id=$1 AND i.id=$2")
                .bind(self.workspace_id)
                .bind(dep)
                .fetch_optional(&mut *self.tx)
                .await?
                .ok_or(Error::NotFound)?;
            if row
                .try_get::<Option<serde_json::Value>, _>("openproject")?
                .is_some()
            {
                return Err(Error::Conflict(
                    "OpenProject issues cannot be dependencies".into(),
                ));
            }
            if dep == i.id
                || row
                    .try_get::<Option<DateTime<Utc>>, _>("deleted_at")?
                    .is_some()
            {
                return Err(Error::BadRequest("invalid dependency".into()));
            }
            if i.deleted_at.is_none()
                && matches!(kind.as_str(), "active" | "done")
                && !matches!(
                    row.try_get::<String, _>("kind")?.as_str(),
                    "done" | "cancelled"
                )
            {
                return Err(Error::Conflict("issue has unfinished dependencies".into()));
            }
            let cycle: bool = sqlx::query_scalar("WITH RECURSIVE reach(id) AS (SELECT $2::uuid UNION SELECT d.dependency_id FROM issue_dependencies d JOIN reach r ON d.issue_id=r.id WHERE d.workspace_id=$1) SELECT EXISTS(SELECT 1 FROM reach WHERE id=$3)")
                .bind(self.workspace_id)
                .bind(dep)
                .bind(i.id)
                .fetch_one(&mut *self.tx)
                .await?;
            if cycle {
                return Err(Error::BadRequest("dependency cycle".into()));
            }
        }

        if let Some(parent) = i.parent_id {
            sqlx::query(
                "SELECT id FROM issues WHERE workspace_id=$1 AND id=$2 AND deleted_at IS NULL AND openproject IS NULL",
            )
            .bind(self.workspace_id)
            .bind(parent)
            .fetch_optional(&mut *self.tx)
            .await?
            .ok_or(Error::NotFound)?;
            let cycle: bool = sqlx::query_scalar("WITH RECURSIVE ancestors(id,parent_id) AS (SELECT id,parent_id FROM issues WHERE workspace_id=$1 AND id=$2 UNION SELECT i.id,i.parent_id FROM issues i JOIN ancestors a ON i.id=a.parent_id WHERE i.workspace_id=$1) SELECT EXISTS(SELECT 1 FROM ancestors WHERE id=$3)")
                .bind(self.workspace_id)
                .bind(parent)
                .bind(i.id)
                .fetch_one(&mut *self.tx)
                .await?;
            if cycle || parent == i.id {
                return Err(Error::BadRequest("parent cycle".into()));
            }
        }

        Ok(())
    }

    async fn save_issue_fields(&mut self, i: &Issue) -> Result<()> {
        persistence::save(
            &mut self.tx,
            self.workspace_id,
            i,
            persistence::Ownership::Local,
        )
        .await
    }

    async fn create_issue_sql(&mut self, input: IssueInput) -> Result<Uuid> {
        self.capacity("issues", 5000).await?;

        let stage_id = match input.stage_id {
            Some(id) => id,
            None => sqlx::query_scalar("SELECT id FROM stages WHERE workspace_id=$1 AND team_id=$2 ORDER BY position,id LIMIT 1")
                .bind(self.workspace_id)
                .bind(input.team_id)
                .fetch_optional(&mut *self.tx)
                .await?
                .ok_or(Error::NotFound)?
        };

        let now = Utc::now();
        let id = self.reserve_client_id(input.id).await?;
        let mut i = Issue {
            openproject: None,
            blocked_count: 0,
            subtask_total: 0,
            subtask_completed: 0,
            version: 1,
            id,
            number: 0,
            title: input.title,
            description: input.description,
            team_id: input.team_id,
            stage_id,
            assignee: input.assignee,
            created_by: Some(self.actor),
            priority: input.priority,
            labels: input.labels,
            estimate: input.estimate,
            deadline: input.deadline,
            project_id: input.project_id,
            milestone_id: input.milestone_id,
            sprint_id: input.sprint_id,
            parent_id: input.parent_id,
            dependencies: input.dependencies,
            position: 0,
            followers: vec![self.actor],
            attachments: vec![],
            source_links: vec![],
            deleted_at: None,
            archived_at: None,
            done_at: None,
            created_at: now,
            updated_at: now,
        };

        self.validate_issue_sql(&i).await?;
        let kind: String = sqlx::query_scalar("SELECT kind FROM stages WHERE id=$1")
            .bind(stage_id)
            .fetch_one(&mut *self.tx)
            .await?;
        if kind == "done" {
            i.done_at = Some(now);
        }
        persistence::create(
            &mut self.tx,
            self.workspace_id,
            &mut i,
            persistence::Ownership::Local,
        )
        .await
        .map_err(|error| match error {
            Error::Database(sqlx::Error::Database(db)) if db.is_unique_violation() => {
                id_conflict(sqlx::Error::Database(db))
            }
            error => error,
        })?;

        sqlx::query("INSERT INTO issue_followers(workspace_id,issue_id,user_id) VALUES($1,$2,$3)")
            .bind(self.workspace_id)
            .bind(id)
            .bind(self.actor)
            .execute(&mut *self.tx)
            .await?;

        self.created("issues", id);
        self.issue_effects(None, &i, persistence::IssueEffects::Create)
            .await?;

        Ok(id)
    }

    async fn issue_effects(
        &mut self,
        before: Option<&Issue>,
        after: &Issue,
        effects: persistence::IssueEffects,
    ) -> Result<()> {
        persistence::issue_effects(
            &mut self.tx,
            self.workspace_id,
            self.actor,
            before,
            after,
            effects,
        )
        .await
    }

    async fn patch_issue_sql(&mut self, id: Uuid, p: IssuePatch) -> Result<()> {
        self.touch("issues", id).await?;

        let old = self.issue(id).await?;
        if old.archived_at.is_some() {
            return Err(Error::Conflict("issue is archived".into()));
        }
        let mut i = old.clone();

        if let Some(v) = p.title {
            i.title = v
        }
        if let Some(v) = p.description {
            i.description = v
        }
        if let Some(v) = p.stage_id {
            i.stage_id = v
        }
        if p.clear_assignee {
            i.assignee = None
        } else if let Some(v) = p.assignee {
            i.assignee = Some(v)
        }
        if let Some(v) = p.priority {
            i.priority = v
        }
        if let Some(v) = p.labels {
            i.labels = v
        }
        if p.clear_estimate {
            i.estimate = None
        } else if let Some(v) = p.estimate {
            i.estimate = Some(v)
        }
        if p.clear_deadline {
            i.deadline = None
        } else if let Some(v) = p.deadline {
            i.deadline = Some(v)
        }
        if p.clear_project {
            i.project_id = None;
            i.milestone_id = None
        } else if let Some(v) = p.project_id {
            i.project_id = Some(v)
        }
        if p.clear_milestone {
            i.milestone_id = None
        } else if let Some(v) = p.milestone_id {
            i.milestone_id = Some(v)
        }
        if p.clear_sprint {
            i.sprint_id = None
        } else if let Some(v) = p.sprint_id {
            i.sprint_id = Some(v)
        }
        if p.clear_parent {
            i.parent_id = None
        } else if let Some(v) = p.parent_id {
            i.parent_id = Some(v)
        }
        if let Some(v) = p.dependencies {
            i.dependencies = v
        }

        self.activity_fields
            .extend(persistence::changed_fields(&old, &i));
        self.validate_issue_sql(&i).await?;
        if i.stage_id != old.stage_id {
            let kind: String = sqlx::query_scalar("SELECT kind FROM stages WHERE id=$1")
                .bind(i.stage_id)
                .fetch_one(&mut *self.tx)
                .await?;
            if kind == "done" {
                if i.done_at.is_none() {
                    i.done_at = Some(Utc::now());
                }
            } else {
                i.done_at = None;
            }
        }
        self.save_issue_fields(&i).await?;

        self.issue_effects(Some(&old), &i, persistence::IssueEffects::Update)
            .await?;

        Ok(())
    }

    async fn delete_restore(&mut self, id: Uuid, restore: bool) -> Result<()> {
        self.touch("issues", id).await?;

        let mut i = reads::issue_on(&mut self.tx, self.workspace_id, id, true).await?;
        let old = i.clone();
        if restore {
            if i.deleted_at.is_none() {
                return Err(Error::BadRequest("issue is not deleted".into()));
            }
            i.deleted_at = None;
            self.validate_issue_sql(&i).await?;
        } else {
            if i.deleted_at.is_some() {
                return Err(Error::NotFound);
            }
            i.deleted_at = Some(Utc::now());
        }

        self.save_issue_fields(&i).await?;
        self.issue_effects(Some(&old), &i, persistence::IssueEffects::DeleteRestore)
            .await?;

        Ok(())
    }

    async fn archive_restore(&mut self, id: Uuid, archive: bool) -> Result<()> {
        self.touch("issues", id).await?;

        let mut i = reads::issue_on(&mut self.tx, self.workspace_id, id, true).await?;
        if i.deleted_at.is_some() {
            return Err(Error::NotFound);
        }
        if archive {
            if i.archived_at.is_some() {
                return Err(Error::BadRequest("issue is already archived".into()));
            }
            let kind: String = sqlx::query_scalar("SELECT kind FROM stages WHERE id=$1")
                .bind(i.stage_id)
                .fetch_one(&mut *self.tx)
                .await?;
            if kind != "done" {
                return Err(Error::BadRequest(
                    "only issues in a Done stage can be archived".into(),
                ));
            }
            i.archived_at = Some(Utc::now());
        } else {
            if i.archived_at.is_none() {
                return Err(Error::BadRequest("issue is not archived".into()));
            }
            i.archived_at = None;
            let kind: String = sqlx::query_scalar("SELECT kind FROM stages WHERE id=$1")
                .bind(i.stage_id)
                .fetch_one(&mut *self.tx)
                .await?;
            // Fresh grace period if still Done.
            i.done_at = if kind == "done" {
                Some(Utc::now())
            } else {
                None
            };
        }

        self.save_issue_fields(&i).await?;

        Ok(())
    }

    pub(crate) async fn issues(&mut self, command: Command) -> Result<Option<Uuid>> {
        let graph = match &command {
            Command::UpdateIssue { patch, .. } => {
                patch.stage_id.is_some()
                    || patch.dependencies.is_some()
                    || patch.parent_id.is_some()
                    || patch.clear_parent
            }
            Command::Follow { .. } | Command::AddSourceLink { .. } => false,
            _ => true,
        };

        if graph {
            self.lock_graph().await?;
        } else {
            sqlx::query("SELECT pg_advisory_xact_lock_shared(hashtextextended($1,41827))")
                .bind(self.workspace_id.to_string())
                .execute(&mut *self.tx)
                .await?;
        }

        let result = match command {
            Command::CreateIssue { input } => Some(self.create_issue_sql(input).await?),
            Command::UpdateIssue { id, patch } => {
                self.patch_issue_sql(id, patch).await?;
                Some(id)
            }
            Command::DeleteIssue { id } => {
                self.delete_restore(id, false).await?;
                Some(id)
            }
            Command::RestoreIssue { id } => {
                self.delete_restore(id, true).await?;
                Some(id)
            }
            Command::ArchiveIssue { id } => {
                self.archive_restore(id, true).await?;
                self.activity_fields.push("archived".into());
                Some(id)
            }
            Command::UnarchiveIssue { id } => {
                self.archive_restore(id, false).await?;
                self.activity_fields.push("archived".into());
                Some(id)
            }
            Command::BulkIssues { ids, action } => {
                if ids.is_empty() || ids.len() > 500 {
                    return Err(Error::BadRequest("select 1 to 500 issues".into()));
                }
                let ids: BTreeSet<_> = ids.into_iter().collect();
                for id in &ids {
                    self.touch("issues", *id).await?;
                }
                for id in ids {
                    match &action {
                        BulkAction::Update(p) => self.patch_issue_sql(id, *p.clone()).await?,
                        BulkAction::Delete => self.delete_restore(id, false).await?,
                        BulkAction::Restore => self.delete_restore(id, true).await?,
                        BulkAction::Archive => self.archive_restore(id, true).await?,
                        BulkAction::Unarchive => self.archive_restore(id, false).await?,
                    }
                }
                None
            }
            Command::MoveIssue {
                id,
                stage_id,
                before_id,
            } => {
                self.touch("issues", id).await?;
                let old = self.issue(id).await?;
                if old.archived_at.is_some() {
                    return Err(Error::Conflict("issue is archived".into()));
                }
                let mut i = old.clone();
                i.stage_id = stage_id;
                self.validate_issue_sql(&i).await?;
                if old.stage_id != stage_id {
                    let kind: String = sqlx::query_scalar("SELECT kind FROM stages WHERE id=$1")
                        .bind(stage_id)
                        .fetch_one(&mut *self.tx)
                        .await?;
                    if kind == "done" {
                        if i.done_at.is_none() {
                            i.done_at = Some(Utc::now());
                        }
                    } else {
                        i.done_at = None;
                    }
                }
                if let Some(before) = before_id {
                    let neighbor = self.issue(before).await?;
                    if before == id
                        || neighbor.team_id != i.team_id
                        || neighbor.stage_id != stage_id
                    {
                        return Err(Error::BadRequest("invalid ordering neighbor".into()));
                    }
                    let lower: Option<i64> = sqlx::query_scalar("SELECT max(position) FROM issues WHERE workspace_id=$1 AND team_id=$2 AND stage_id=$3 AND deleted_at IS NULL AND id<>$4 AND (position,id)<($5,$6)")
                        .bind(self.workspace_id)
                        .bind(i.team_id)
                        .bind(stage_id)
                        .bind(id)
                        .bind(neighbor.position)
                        .bind(before)
                        .fetch_one(&mut *self.tx)
                        .await?;
                    let lower = lower.unwrap_or(neighbor.position.saturating_sub(2048));
                    if neighbor.position - lower <= 1 {
                        // Only this stage needs reordering; lock rows by UUID before updating ranks.
                        let rows = sqlx::query("SELECT id,position FROM issues WHERE workspace_id=$1 AND team_id=$2 AND stage_id=$3 AND deleted_at IS NULL AND id<>$4 ORDER BY id FOR UPDATE")
                            .bind(self.workspace_id)
                            .bind(i.team_id)
                            .bind(stage_id)
                            .bind(id)
                            .fetch_all(&mut *self.tx)
                            .await?;
                        let mut neighbors: Vec<(i64, Uuid)> = rows
                            .into_iter()
                            .map(|r| (r.get("position"), r.get("id")))
                            .collect();
                        neighbors.sort();
                        for (rank, (_, nid)) in neighbors.into_iter().enumerate() {
                            let rank = (rank as i64) * 1024;
                            sqlx::query("UPDATE issues SET position=$1,version=version+1 WHERE id=$2 RETURNING version")
                                .bind(rank)
                                .bind(nid)
                                .fetch_one(&mut *self.tx)
                                .await?
                                .try_get::<i64,_>("version")
                                .map(|v|{self.versions.insert(("issues".to_owned(),nid),v);})?;
                            if nid == before {
                                i.position = rank - 512;
                            }
                        }
                    } else {
                        i.position = lower + (neighbor.position - lower) / 2;
                    }
                } else {
                    i.position = sqlx::query_scalar("SELECT COALESCE(max(position),-1024)+1024 FROM issues WHERE workspace_id=$1 AND team_id=$2 AND stage_id=$3 AND deleted_at IS NULL AND id<>$4")
                        .bind(self.workspace_id)
                        .bind(i.team_id)
                        .bind(stage_id)
                        .bind(id)
                        .fetch_one(&mut *self.tx)
                        .await?;
                }
                if old.stage_id != stage_id {
                    self.activity_fields.push("stage".into());
                }
                self.save_issue_fields(&i).await?;
                self.issue_effects(Some(&old), &i, persistence::IssueEffects::Move)
                    .await?;
                Some(id)
            }
            Command::Follow {
                issue_id,
                following,
            } => {
                self.touch("issues", issue_id).await?;
                self.issue(issue_id).await?;
                sqlx::query("DELETE FROM issue_followers WHERE workspace_id=$1 AND issue_id=$2 AND user_id=$3")
                    .bind(self.workspace_id)
                    .bind(issue_id)
                    .bind(self.actor)
                    .execute(&mut *self.tx)
                    .await?;
                if following {
                    sqlx::query("INSERT INTO issue_followers(workspace_id,issue_id,user_id) VALUES($1,$2,$3)")
                        .bind(self.workspace_id)
                        .bind(issue_id)
                        .bind(self.actor)
                        .execute(&mut *self.tx)
                        .await?;
                }
                Some(issue_id)
            }
            Command::AddSourceLink {
                issue_id,
                url,
                title,
            } => {
                crate::domain::text(&title, 500)?;
                let parsed = reqwest::Url::parse(&url)
                    .map_err(|_| Error::BadRequest("invalid URL".into()))?;
                if !matches!(parsed.scheme(), "http" | "https") || url.len() > 4096 {
                    return Err(Error::BadRequest("invalid URL".into()));
                }
                self.touch("issues", issue_id).await?;
                self.issue(issue_id).await?;
                let link_archived: bool = sqlx::query_scalar(
                    "SELECT archived_at IS NOT NULL FROM issues WHERE workspace_id=$1 AND id=$2",
                )
                .bind(self.workspace_id)
                .bind(issue_id)
                .fetch_one(&mut *self.tx)
                .await?;
                if link_archived {
                    return Err(Error::Conflict("issue is archived".into()));
                }
                sqlx::query("INSERT INTO source_links(id,workspace_id,issue_id,url,title) VALUES($1,$2,$3,$4,$5) ON CONFLICT(issue_id,url,title) DO NOTHING")
                    .bind(Uuid::new_v4())
                    .bind(self.workspace_id)
                    .bind(issue_id)
                    .bind(url)
                    .bind(title)
                    .execute(&mut *self.tx)
                    .await?;
                Some(issue_id)
            }
            Command::ImportIssues { issues } => {
                self.admin()?;
                if issues.is_empty() || issues.len() > 5000 {
                    return Err(Error::BadRequest("import 1 to 5000 issues".into()));
                }
                // Reserve every supplied id up front in UUID order, before any
                // insert takes further locks, so concurrent imports cannot
                // deadlock. Issues still insert in request order so parents
                // come before children.
                let supplied: Vec<Option<Uuid>> = issues.iter().map(|input| input.id).collect();
                let resolved = self.reserve_client_ids(&supplied).await?;
                for (mut input, id) in issues.into_iter().zip(resolved) {
                    input.id = Some(id);
                    self.create_issue_sql(input).await?;
                }
                None
            }
            _ => return Err(Error::Internal("wrong issue command dispatcher".into())),
        };

        self.validate_workflow().await?;

        Ok(result)
    }
}

impl Store {
    pub async fn execute_reminder(conn: &mut PgConnection, reminder: &Reminder) -> Result<()> {
        sqlx::query("SELECT pg_advisory_xact_lock_shared(hashtextextended($1,74103))")
            .bind(reminder.workspace_id.to_string())
            .execute(&mut *conn)
            .await?;
        sqlx::query("SELECT pg_advisory_xact_lock_shared(hashtextextended($1,41827))")
            .bind(reminder.workspace_id.to_string())
            .execute(&mut *conn)
            .await?;
        let row = sqlx::query("SELECT i.title,i.assignee,i.deadline,i.reminder_generation,i.deleted_at,s.kind FROM issues i JOIN stages s ON s.id=i.stage_id WHERE i.workspace_id=$1 AND i.id=$2 FOR SHARE OF i,s")
            .bind(reminder.workspace_id)
            .bind(reminder.issue_id)
            .fetch_optional(&mut *conn)
            .await?;
        let Some(row) = row else { return Ok(()) };
        let deadline: Option<DateTime<Utc>> = row.try_get("deadline")?;
        if row.try_get::<i64, _>("reminder_generation")? != reminder.generation
            || row
                .try_get::<Option<DateTime<Utc>>, _>("deleted_at")?
                .is_some()
            || matches!(
                row.try_get::<String, _>("kind")?.as_str(),
                "done" | "cancelled"
            )
        {
            return Ok(());
        }
        let Some(deadline) = deadline else {
            return Ok(());
        };
        let now: DateTime<Utc> = sqlx::query_scalar("SELECT now()")
            .fetch_one(&mut *conn)
            .await?;
        if deadline > now + chrono::Duration::hours(24) {
            return Ok(());
        }
        let recipients: Vec<Uuid> = sqlx::query_scalar("SELECT user_id FROM issue_followers WHERE workspace_id=$1 AND issue_id=$2 UNION SELECT assignee FROM issues WHERE workspace_id=$1 AND id=$2 AND assignee IS NOT NULL ORDER BY 1")
            .bind(reminder.workspace_id)
            .bind(reminder.issue_id)
            .fetch_all(&mut *conn)
            .await?;
        for user in recipients {
            sqlx::query("SELECT user_id FROM workspace_members WHERE workspace_id=$1 AND user_id=$2 FOR SHARE")
                .bind(reminder.workspace_id)
                .bind(user)
                .fetch_optional(&mut *conn)
                .await?;
            let key = format!(
                "deadline:{}:{}:{user}",
                reminder.issue_id, reminder.generation
            );
            sqlx::query("INSERT INTO notifications(id,workspace_id,user_id,issue_id,kind,message,created_at,dedup_key) SELECT $1,$2,$3,$4,'deadline',$5,now(),$6 WHERE EXISTS(SELECT 1 FROM workspace_members WHERE workspace_id=$2 AND user_id=$3) AND COALESCE((SELECT deadline FROM alert_preferences WHERE workspace_id=$2 AND user_id=$3),true) AND COALESCE((SELECT (profile->'alerts'->>'deadlines')::bool FROM users WHERE id=$3),true) ON CONFLICT(workspace_id,dedup_key) DO NOTHING")
                .bind(Uuid::new_v4())
                .bind(reminder.workspace_id)
                .bind(user)
                .bind(reminder.issue_id)
                .bind(row.try_get::<String,_>("title")?)
                .bind(key)
                .execute(&mut *conn)
                .await?;
        }

        Ok(())
    }
}
