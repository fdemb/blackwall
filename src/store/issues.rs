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

    pub(super) async fn capacity(&mut self, resource: Resource, incoming: usize) -> Result<()> {
        let limit = self.limits.get(resource);
        let room = persistence::room(&mut self.tx, self.workspace_id, resource, limit).await?;
        match (room, limit) {
            (Some(room), Some(limit)) if room < incoming as i64 => Err(resource.reached(limit)),
            _ => Ok(()),
        }
    }

    pub(super) async fn schedule_reminder(&mut self, id: Uuid) -> Result<()> {
        persistence::schedule_reminder(&mut self.tx, self.workspace_id, id).await
    }

    /// `before` is the stored issue; None when creating.
    async fn validate_issue_sql(&mut self, i: &Issue, before: Option<&Issue>) -> Result<()> {
        crate::domain::text(&i.title, 500)?;
        crate::domain::optional_timestamp(i.deadline)?;

        if i.description.len() > 100_000 {
            return Err(Error::BadRequest("description too long".into()));
        }

        let kind: String = sqlx::query_scalar(
            "SELECT kind FROM stages WHERE workspace_id=$1 AND team_id=$2 AND id=$3 FOR SHARE",
        )
        .bind(self.workspace_id)
        .bind(i.team_id)
        .bind(i.stage_id)
        .fetch_optional(&mut *self.tx)
        .await?
        .ok_or_else(|| Error::BadRequest("stage belongs to another team".into()))?;

        self.validate_issue_references(i).await?;
        if let Some(sprint) = i.sprint_id {
            self.validate_issue_sprint(i, sprint, &kind).await?;
        }
        // Dependencies gate entering an active or done stage from another kind, and new
        // dependencies of a started issue. Ones that reopen later leave the issue blocked, not
        // invalid, so it can still move between stages of its kind, in its team or another.
        let started = i.deleted_at.is_none() && matches!(kind.as_str(), "active" | "done");
        let entered = match before {
            None => true,
            Some(old) if old.stage_id == i.stage_id => false,
            Some(old) => self.stage_kind(old.stage_id).await? != kind,
        };
        for dep in i.dependencies.iter().copied().collect::<BTreeSet<_>>() {
            let added = before.is_none_or(|old| !old.dependencies.contains(&dep));
            if added {
                self.validate_dependency(i, dep).await?;
            }
            if started && (added || entered) && self.unfinished(dep).await? {
                return Err(Error::Conflict("issue has unfinished dependencies".into()));
            }
            if added {
                self.reject_dependency_cycle(i, dep).await?;
            }
        }
        if let Some(parent) = i.parent_id {
            self.validate_parent(i, parent).await?;
        }

        Ok(())
    }

    async fn validate_issue_references(&mut self, i: &Issue) -> Result<()> {
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

        Ok(())
    }

    /// A finished sprint only keeps issues that were already in it and are done or cancelled.
    async fn validate_issue_sprint(&mut self, i: &Issue, sprint: Uuid, kind: &str) -> Result<()> {
        let row = sqlx::query(
            "SELECT team_id,state FROM sprints WHERE workspace_id=$1 AND id=$2 FOR SHARE",
        )
        .bind(self.workspace_id)
        .bind(sprint)
        .fetch_optional(&mut *self.tx)
        .await?
        .ok_or(Error::NotFound)?;
        let state: String = row.try_get("state")?;
        let retained: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM issues WHERE workspace_id=$1 AND id=$2 AND sprint_id=$3)",
        )
        .bind(self.workspace_id)
        .bind(i.id)
        .bind(sprint)
        .fetch_one(&mut *self.tx)
        .await?;
        let finished = matches!(state.as_str(), "completed" | "archived");
        let may_stay = retained && matches!(kind, "done" | "cancelled");
        if row.try_get::<Uuid, _>("team_id")? != i.team_id || (finished && !may_stay) {
            return Err(Error::BadRequest(
                "sprint is unavailable for this team".into(),
            ));
        }
        Ok(())
    }

    /// A new dependency must be another live issue.
    async fn validate_dependency(&mut self, i: &Issue, dep: Uuid) -> Result<()> {
        let deleted: Option<DateTime<Utc>> =
            sqlx::query_scalar("SELECT deleted_at FROM issues WHERE workspace_id=$1 AND id=$2")
                .bind(self.workspace_id)
                .bind(dep)
                .fetch_optional(&mut *self.tx)
                .await?
                .ok_or(Error::NotFound)?;
        if dep == i.id || deleted.is_some() {
            return Err(Error::BadRequest("invalid dependency".into()));
        }
        Ok(())
    }

    async fn reject_dependency_cycle(&mut self, i: &Issue, dep: Uuid) -> Result<()> {
        let cycle: bool = sqlx::query_scalar("WITH RECURSIVE reach(id) AS (SELECT $2::uuid UNION SELECT d.dependency_id FROM issue_dependencies d JOIN reach r ON d.issue_id=r.id WHERE d.workspace_id=$1) SELECT EXISTS(SELECT 1 FROM reach WHERE id=$3)")
            .bind(self.workspace_id)
            .bind(dep)
            .bind(i.id)
            .fetch_one(&mut *self.tx)
            .await?;
        if cycle {
            return Err(Error::BadRequest("dependency cycle".into()));
        }
        Ok(())
    }

    /// Counts towards `blocked_count`: live and not done or cancelled.
    async fn unfinished(&mut self, dep: Uuid) -> Result<bool> {
        Ok(sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM issues i JOIN stages s ON s.id=i.stage_id WHERE i.workspace_id=$1 AND i.id=$2 AND i.deleted_at IS NULL AND s.kind NOT IN ('done','cancelled'))")
            .bind(self.workspace_id)
            .bind(dep)
            .fetch_one(&mut *self.tx)
            .await?)
    }

    async fn validate_parent(&mut self, i: &Issue, parent: Uuid) -> Result<()> {
        sqlx::query("SELECT id FROM issues WHERE workspace_id=$1 AND id=$2 AND deleted_at IS NULL")
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
        Ok(())
    }

    /// Keeps backlog work out of sprints; see [`Issue::sprint_fit`]. A stage
    /// from another team is left for `validate_issue_sql` to reject.
    async fn fit_sprint(&mut self, i: &mut Issue, entered_stage: bool) -> Result<()> {
        if i.sprint_id.is_none() {
            return Ok(());
        }
        let kind: Option<String> = sqlx::query_scalar(
            "SELECT kind FROM stages WHERE workspace_id=$1 AND team_id=$2 AND id=$3",
        )
        .bind(self.workspace_id)
        .bind(i.team_id)
        .bind(i.stage_id)
        .fetch_optional(&mut *self.tx)
        .await?;
        match i.sprint_fit(kind.as_deref() == Some("backlog"), entered_stage) {
            SprintFit::Keep => {}
            SprintFit::LeaveSprint => i.sprint_id = None,
            SprintFit::Plan => {
                // Mirrors `Team::sprint_stage`: the first planned stage, else the first active one.
                i.stage_id = sqlx::query_scalar("SELECT id FROM stages WHERE workspace_id=$1 AND team_id=$2 AND kind IN ('planned','active') ORDER BY kind='active',position,id LIMIT 1")
                    .bind(self.workspace_id)
                    .bind(i.team_id)
                    .fetch_optional(&mut *self.tx)
                    .await?
                    .ok_or_else(|| Error::BadRequest("team has no stage for sprint work".into()))?;
            }
        }
        Ok(())
    }

    async fn stage_kind(&mut self, stage_id: Uuid) -> Result<String> {
        Ok(sqlx::query_scalar("SELECT kind FROM stages WHERE id=$1")
            .bind(stage_id)
            .fetch_one(&mut *self.tx)
            .await?)
    }

    /// Entering a done stage starts the Done clock; any other stage clears it.
    async fn restamp_done(&mut self, i: &mut Issue) -> Result<()> {
        if self.stage_kind(i.stage_id).await? == "done" {
            i.done_at.get_or_insert_with(Utc::now);
        } else {
            i.done_at = None;
        }
        Ok(())
    }

    async fn save_issue_fields(&mut self, i: &Issue) -> Result<()> {
        persistence::save(
            &mut self.tx,
            self.workspace_id,
            i,
            persistence::Origin::Local,
        )
        .await
    }

    async fn create_issue_sql(&mut self, input: IssueInput) -> Result<Uuid> {
        self.capacity(Resource::Issues, 1).await?;

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
            tracker: None,
            blocked_count: 0,
            subtask_total: 0,
            subtask_completed: 0,
            version: 1,
            id,
            number: 0,
            former_keys: vec![],
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
        if let Some(user) = i.assignee {
            i.follow(user);
        }

        self.fit_sprint(&mut i, input.stage_id.is_some()).await?;
        self.validate_issue_sql(&i, None).await?;
        if self.stage_kind(i.stage_id).await? == "done" {
            i.done_at = Some(now);
        }
        persistence::create(
            &mut self.tx,
            self.workspace_id,
            &mut i,
            persistence::Origin::Local,
        )
        .await
        .map_err(|error| match error {
            Error::Database(sqlx::Error::Database(db)) if db.is_unique_violation() => {
                id_conflict(sqlx::Error::Database(db))
            }
            error => error,
        })?;

        for user in &i.followers {
            self.add_follower(id, *user).await?;
        }

        self.created("issues", id);
        self.issue_effects(None, &i, persistence::IssueEffects::Create)
            .await?;
        self.mention(None, &i).await?;

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
        let version = self.lock("issues", id).await?;

        let old = self.issue(id).await?;
        if old.archived_at.is_some() {
            return Err(Error::Conflict("issue is archived".into()));
        }
        let mut i = old.clone();

        let team = p.team_id.filter(|team| *team != old.team_id);
        i.apply_patch(p);
        if let Some(team) = team {
            self.enter_team(&old, &mut i, team).await?;
        }
        let entered_stage = i.stage_id != old.stage_id;
        self.fit_sprint(&mut i, entered_stage).await?;

        let fields = old.changed_fields(&i);
        if fields.is_empty() {
            return Ok(());
        }
        self.touch_locked("issues", id, version).await?;
        self.activity_fields.extend(fields);
        self.validate_issue_sql(&i, Some(&old)).await?;
        if i.stage_id != old.stage_id {
            self.restamp_done(&mut i).await?;
        }
        self.save_issue_fields(&i).await?;
        if team.is_some() {
            let key = FormerKey {
                team_id: old.team_id,
                number: old.number,
            };
            persistence::claim_former_key(&mut self.tx, self.workspace_id, id, key).await?;
        }

        self.issue_effects(Some(&old), &i, persistence::IssueEffects::Update)
            .await?;

        if i.assignee != old.assignee
            && let Some(user) = i.assignee
        {
            self.add_follower(id, user).await?;
        }
        self.mention(Some(&old), &i).await
    }

    async fn enter_team(&mut self, old: &Issue, i: &mut Issue, team: Uuid) -> Result<()> {
        if old.tracker.is_some() {
            return Err(Error::BadRequest(
                "synced issues follow their tracker project's team".into(),
            ));
        }
        i.leave_team(old, team);
        i.number = persistence::next_number(&mut self.tx, self.workspace_id, i.team_id).await?;
        if i.stage_id == old.stage_id {
            let kind = self.stage_kind(old.stage_id).await?;
            i.stage_id = sqlx::query_scalar("SELECT id FROM stages WHERE workspace_id=$1 AND team_id=$2 ORDER BY kind<>$3,position,id LIMIT 1")
                .bind(self.workspace_id)
                .bind(i.team_id)
                .bind(kind)
                .fetch_optional(&mut *self.tx)
                .await?
                .ok_or(Error::NotFound)?;
        }
        if let Some(project) = i.project_id.filter(|_| i.project_id == old.project_id) {
            let included: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM project_teams WHERE workspace_id=$1 AND project_id=$2 AND team_id=$3)")
                .bind(self.workspace_id)
                .bind(project)
                .bind(i.team_id)
                .fetch_one(&mut *self.tx)
                .await?;
            if !included {
                i.project_id = None;
                i.milestone_id = None;
            }
        }
        i.position = self.position_last(i).await?;
        Ok(())
    }

    async fn mention(&mut self, before: Option<&Issue>, after: &Issue) -> Result<()> {
        let mentioned = after.new_mentions(before);
        if mentioned.is_empty() {
            return Ok(());
        }
        let members: Vec<Uuid> = sqlx::query_scalar(
            "SELECT user_id FROM workspace_members WHERE workspace_id=$1 AND \
            user_id=ANY($2) ORDER BY user_id",
        )
        .bind(self.workspace_id)
        .bind(&mentioned)
        .fetch_all(&mut *self.tx)
        .await?;
        for user in members {
            if user != self.actor {
                self.notify(
                    user,
                    Some(after.id),
                    AlertKind::Mention,
                    after.title.clone(),
                    format!("mention:{}:{user}:{}", after.id, Uuid::new_v4()),
                    &["description"],
                )
                .await?;
            }
            self.add_follower(after.id, user).await?;
        }
        Ok(())
    }

    /// Locks the issue and reads it, including deleted rows.
    async fn issue_for_lifecycle(&mut self, id: Uuid) -> Result<Issue> {
        self.touch("issues", id).await?;
        reads::issue_on(&mut self.tx, self.workspace_id, id, true).await
    }

    async fn delete_issue(&mut self, id: Uuid) -> Result<()> {
        let mut i = self.issue_for_lifecycle(id).await?;
        let old = i.clone();
        if i.deleted_at.is_some() {
            return Err(Error::NotFound);
        }
        i.deleted_at = Some(Utc::now());
        self.save_issue_fields(&i).await?;
        self.issue_effects(Some(&old), &i, persistence::IssueEffects::DeleteRestore)
            .await
    }

    async fn restore_issue(&mut self, id: Uuid) -> Result<()> {
        let mut i = self.issue_for_lifecycle(id).await?;
        let old = i.clone();
        if i.deleted_at.is_none() {
            return Err(Error::BadRequest("issue is not deleted".into()));
        }
        i.deleted_at = None;
        self.validate_issue_sql(&i, Some(&old)).await?;
        self.save_issue_fields(&i).await?;
        self.issue_effects(Some(&old), &i, persistence::IssueEffects::DeleteRestore)
            .await
    }

    async fn archive_issue(&mut self, id: Uuid) -> Result<()> {
        let mut i = self.issue_for_lifecycle(id).await?;
        if i.deleted_at.is_some() {
            return Err(Error::NotFound);
        }
        if i.archived_at.is_some() {
            return Err(Error::BadRequest("issue is already archived".into()));
        }
        if self.stage_kind(i.stage_id).await? != "done" {
            return Err(Error::BadRequest(
                "only issues in a Done stage can be archived".into(),
            ));
        }
        i.archived_at = Some(Utc::now());
        self.save_issue_fields(&i).await
    }

    async fn unarchive_issue(&mut self, id: Uuid) -> Result<()> {
        let mut i = self.issue_for_lifecycle(id).await?;
        if i.deleted_at.is_some() {
            return Err(Error::NotFound);
        }
        if i.archived_at.is_none() {
            return Err(Error::BadRequest("issue is not archived".into()));
        }
        i.archived_at = None;
        // Fresh grace period if still Done.
        i.done_at = (self.stage_kind(i.stage_id).await? == "done").then(Utc::now);
        self.save_issue_fields(&i).await
    }

    pub(crate) async fn issues(&mut self, command: Command) -> Result<Option<Uuid>> {
        if changes_graph(&command) {
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
                self.delete_issue(id).await?;
                Some(id)
            }
            Command::RestoreIssue { id } => {
                self.restore_issue(id).await?;
                Some(id)
            }
            Command::ArchiveIssue { id } => {
                self.archive_issue(id).await?;
                self.activity_fields.push("archived".into());
                Some(id)
            }
            Command::UnarchiveIssue { id } => {
                self.unarchive_issue(id).await?;
                self.activity_fields.push("archived".into());
                Some(id)
            }
            Command::BulkIssues { ids, action } => {
                self.bulk_issues(ids, action).await?;
                None
            }
            Command::MoveIssue {
                id,
                stage_id,
                before_id,
            } => {
                self.move_issue(id, stage_id, before_id).await?;
                Some(id)
            }
            Command::Follow {
                issue_id,
                following,
                user_id,
            } => {
                self.follow_issue(issue_id, following, user_id).await?;
                Some(issue_id)
            }
            Command::AddSourceLink {
                issue_id,
                url,
                title,
            } => {
                self.add_source_link(issue_id, url, title).await?;
                Some(issue_id)
            }
            Command::ImportIssues { issues } => {
                self.import_issues(issues).await?;
                None
            }
            _ => return Err(Error::Internal("wrong issue command dispatcher".into())),
        };

        Ok(result)
    }

    async fn bulk_issues(&mut self, ids: Vec<Uuid>, action: BulkAction) -> Result<()> {
        if ids.is_empty() || ids.len() > 500 {
            return Err(Error::BadRequest("select 1 to 500 issues".into()));
        }
        let ids: BTreeSet<_> = ids.into_iter().collect();
        for id in &ids {
            self.lock("issues", *id).await?;
        }
        for id in ids {
            match &action {
                BulkAction::Update(p) => self.patch_issue_sql(id, *p.clone()).await?,
                BulkAction::Delete => self.delete_issue(id).await?,
                BulkAction::Restore => self.restore_issue(id).await?,
                BulkAction::Archive => self.archive_issue(id).await?,
                BulkAction::Unarchive => self.unarchive_issue(id).await?,
            }
        }
        Ok(())
    }

    async fn move_issue(
        &mut self,
        id: Uuid,
        stage_id: Uuid,
        before_id: Option<Uuid>,
    ) -> Result<()> {
        self.touch("issues", id).await?;
        let old = self.issue(id).await?;
        if old.archived_at.is_some() {
            return Err(Error::Conflict("issue is archived".into()));
        }
        let mut i = old.clone();
        i.stage_id = stage_id;
        self.fit_sprint(&mut i, true).await?;
        self.validate_issue_sql(&i, Some(&old)).await?;
        if old.stage_id != stage_id {
            self.restamp_done(&mut i).await?;
            self.activity_fields.push("stage".into());
        }
        if old.sprint_id != i.sprint_id {
            self.activity_fields.push("sprint".into());
        }
        i.position = match before_id {
            Some(before) => self.position_before(&i, before).await?,
            None => self.position_last(&i).await?,
        };
        self.save_issue_fields(&i).await?;
        self.issue_effects(Some(&old), &i, persistence::IssueEffects::Move)
            .await
    }

    /// One past the last issue in the stage, `0` when it is empty.
    async fn position_last(&mut self, i: &Issue) -> Result<i64> {
        Ok(sqlx::query_scalar("SELECT COALESCE(max(position),-1024)+1024 FROM issues WHERE workspace_id=$1 AND team_id=$2 AND stage_id=$3 AND deleted_at IS NULL AND id<>$4")
            .bind(self.workspace_id)
            .bind(i.team_id)
            .bind(i.stage_id)
            .bind(i.id)
            .fetch_one(&mut *self.tx)
            .await?)
    }

    /// The midpoint between `before` and the next lower issue, rebalancing
    /// the stage when no integer fits between them.
    async fn position_before(&mut self, i: &Issue, before: Uuid) -> Result<i64> {
        let neighbor = self.issue(before).await?;
        if before == i.id || neighbor.team_id != i.team_id || neighbor.stage_id != i.stage_id {
            return Err(Error::BadRequest("invalid ordering neighbor".into()));
        }
        let lower: Option<i64> = sqlx::query_scalar("SELECT max(position) FROM issues WHERE workspace_id=$1 AND team_id=$2 AND stage_id=$3 AND deleted_at IS NULL AND id<>$4 AND (position,id)<($5,$6)")
            .bind(self.workspace_id)
            .bind(i.team_id)
            .bind(i.stage_id)
            .bind(i.id)
            .bind(neighbor.position)
            .bind(before)
            .fetch_one(&mut *self.tx)
            .await?;
        let lower = lower.unwrap_or(neighbor.position.saturating_sub(2048));
        if neighbor.position - lower > 1 {
            return Ok(lower + (neighbor.position - lower) / 2);
        }
        let before_rank = self.rebalance_stage(i, before).await?;
        Ok(before_rank - 512)
    }

    /// Spreads the stage's other issues 1024 apart and returns the new
    /// position of `before`.
    async fn rebalance_stage(&mut self, i: &Issue, before: Uuid) -> Result<i64> {
        // Only this stage needs reordering; lock rows by UUID before updating ranks.
        let rows = sqlx::query("SELECT id,position FROM issues WHERE workspace_id=$1 AND team_id=$2 AND stage_id=$3 AND deleted_at IS NULL AND id<>$4 ORDER BY id FOR UPDATE")
            .bind(self.workspace_id)
            .bind(i.team_id)
            .bind(i.stage_id)
            .bind(i.id)
            .fetch_all(&mut *self.tx)
            .await?;
        let mut neighbors: Vec<(i64, Uuid)> = rows
            .into_iter()
            .map(|r| (r.get("position"), r.get("id")))
            .collect();
        neighbors.sort();

        let mut before_rank = 0;
        for (rank, (_, nid)) in neighbors.into_iter().enumerate() {
            let rank = (rank as i64) * 1024;
            let version: i64 = sqlx::query_scalar(
                "UPDATE issues SET position=$1,version=version+1 WHERE id=$2 RETURNING version",
            )
            .bind(rank)
            .bind(nid)
            .fetch_one(&mut *self.tx)
            .await?;
            self.versions.insert(("issues".to_owned(), nid), version);
            if nid == before {
                before_rank = rank;
            }
        }
        Ok(before_rank)
    }

    async fn follow_issue(
        &mut self,
        issue_id: Uuid,
        following: bool,
        user_id: Option<Uuid>,
    ) -> Result<()> {
        let user = user_id.unwrap_or(self.actor);
        self.member(user).await?;
        self.touch("issues", issue_id).await?;
        self.issue(issue_id).await?;
        if following {
            self.add_follower(issue_id, user).await?;
        } else {
            sqlx::query(
                "DELETE FROM issue_followers WHERE workspace_id=$1 AND issue_id=$2 AND user_id=$3",
            )
            .bind(self.workspace_id)
            .bind(issue_id)
            .bind(user)
            .execute(&mut *self.tx)
            .await?;
        }
        Ok(())
    }

    async fn add_source_link(&mut self, issue_id: Uuid, url: String, title: String) -> Result<()> {
        crate::domain::text(&title, 500)?;
        let parsed =
            reqwest::Url::parse(&url).map_err(|_| Error::BadRequest("invalid URL".into()))?;
        if !matches!(parsed.scheme(), "http" | "https") || url.len() > 4096 {
            return Err(Error::BadRequest("invalid URL".into()));
        }
        self.touch("issues", issue_id).await?;
        if self.issue(issue_id).await?.archived_at.is_some() {
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
        Ok(())
    }

    async fn import_issues(&mut self, issues: Vec<IssueInput>) -> Result<()> {
        self.admin()?;
        if issues.is_empty() || issues.len() > 5000 {
            return Err(Error::BadRequest("import 1 to 5000 issues".into()));
        }
        // Reserve every supplied id up front in bucket order, before any
        // insert takes further locks, so concurrent imports cannot
        // deadlock. Generated ids skip locking entirely; supplied ids
        // are already held when create_issue_sql re-reserves them.
        // Issues still insert in request order so parents
        // come before children.
        let supplied: Vec<Option<Uuid>> = issues.iter().map(|input| input.id).collect();
        self.reserve_client_ids(&supplied).await?;
        for input in issues {
            self.create_issue_sql(input).await?;
        }
        Ok(())
    }
}

/// Commands that can change stages, dependencies or parents take the
/// exclusive graph lock; the rest share it.
fn changes_graph(command: &Command) -> bool {
    match command {
        Command::UpdateIssue { patch, .. } => {
            patch.stage_id.is_some()
                || patch.team_id.is_some()
                || patch.dependencies.is_some()
                || patch.parent_id.is_some()
                || patch.clear_parent
        }
        Command::Follow { .. } | Command::AddSourceLink { .. } => false,
        _ => true,
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
        let Some(title) = due_reminder_title(conn, reminder).await? else {
            return Ok(());
        };

        let recipients: Vec<Uuid> = sqlx::query_scalar("SELECT user_id FROM issue_followers WHERE workspace_id=$1 AND issue_id=$2 UNION SELECT assignee FROM issues WHERE workspace_id=$1 AND id=$2 AND assignee IS NOT NULL ORDER BY 1")
            .bind(reminder.workspace_id)
            .bind(reminder.issue_id)
            .fetch_all(&mut *conn)
            .await?;
        for user in recipients {
            notify_deadline(conn, reminder, user, &title).await?;
        }

        Ok(())
    }
}

/// The issue title when the reminder is current, the issue is open and its
/// deadline is within 24 hours; `None` when the reminder should do nothing.
async fn due_reminder_title(
    conn: &mut PgConnection,
    reminder: &Reminder,
) -> Result<Option<String>> {
    let row = sqlx::query("SELECT i.title,i.assignee,i.deadline,i.reminder_generation,i.deleted_at,s.kind FROM issues i JOIN stages s ON s.id=i.stage_id WHERE i.workspace_id=$1 AND i.id=$2 FOR SHARE OF i,s")
        .bind(reminder.workspace_id)
        .bind(reminder.issue_id)
        .fetch_optional(&mut *conn)
        .await?;
    let Some(row) = row else { return Ok(None) };
    let stale = row.try_get::<i64, _>("reminder_generation")? != reminder.generation;
    let deleted = row
        .try_get::<Option<DateTime<Utc>>, _>("deleted_at")?
        .is_some();
    let finished = matches!(
        row.try_get::<String, _>("kind")?.as_str(),
        "done" | "cancelled"
    );
    let deadline: Option<DateTime<Utc>> = row.try_get("deadline")?;
    let Some(deadline) = deadline.filter(|_| !stale && !deleted && !finished) else {
        return Ok(None);
    };
    let now: DateTime<Utc> = sqlx::query_scalar("SELECT now()")
        .fetch_one(&mut *conn)
        .await?;
    if deadline > now + chrono::Duration::hours(24) {
        return Ok(None);
    }
    Ok(Some(row.try_get("title")?))
}

async fn notify_deadline(
    conn: &mut PgConnection,
    reminder: &Reminder,
    user: Uuid,
    title: &str,
) -> Result<()> {
    sqlx::query(
        "SELECT user_id FROM workspace_members WHERE workspace_id=$1 AND user_id=$2 FOR SHARE",
    )
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
        .bind(title)
        .bind(key)
        .execute(&mut *conn)
        .await?;
    Ok(())
}
