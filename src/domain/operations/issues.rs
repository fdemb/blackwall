use super::super::*;
use super::find_mut;

impl Workspace {
    pub(super) fn apply_issue(
        &mut self,
        actor: Uuid,
        command: Command,
        now: DateTime<Utc>,
        fields: &mut Vec<String>,
    ) -> Result<Option<Uuid>> {
        let id = match command {
            Command::CreateIssue { input } => self.create_issue(input, actor, now)?,
            Command::UpdateIssue { id, patch } => {
                let before = self.issue(id)?.clone();
                self.patch_issue(id, patch, actor, now)?;
                *fields = before.changed_fields(self.issue(id)?);
                id
            }
            Command::MoveIssue {
                id,
                stage_id,
                before_id,
            } => {
                let sprint = self.issue(id)?.sprint_id;
                if self.move_issue(id, stage_id, before_id, now)? {
                    fields.push("stage".into());
                }
                if self.issue(id)?.sprint_id != sprint {
                    fields.push("sprint".into());
                }
                id
            }
            Command::BulkIssues { ids, action } => {
                self.bulk_issues(ids, action, actor, now)?;
                return Ok(None);
            }
            Command::DeleteIssue { id } => {
                self.issue_mut(id)?.deleted_at = Some(now);
                id
            }
            Command::RestoreIssue { id } => {
                self.restore(id, now)?;
                id
            }
            Command::ArchiveIssue { id } => {
                self.archive(id, now)?;
                fields.push("archived".into());
                id
            }
            Command::UnarchiveIssue { id } => {
                self.unarchive(id, now)?;
                fields.push("archived".into());
                id
            }
            Command::Follow {
                issue_id,
                following,
            } => {
                let issue = self.issue_mut(issue_id)?;
                issue.followers.retain(|u| *u != actor);
                if following {
                    issue.followers.push(actor)
                }
                issue_id
            }
            Command::AddSourceLink {
                issue_id,
                url,
                title,
            } => {
                validate_url(&url)?;
                text(&title, 500)?;
                self.issue_mut(issue_id)?
                    .source_links
                    .push(SourceLink { url, title });
                issue_id
            }
            Command::ImportIssues { issues } => {
                if issues.len() > 1000 {
                    return Err(Error::BadRequest("import limited to 1000 issues".into()));
                }
                for input in issues {
                    self.create_issue(input, actor, now)?;
                }
                return Ok(None);
            }
            _ => unreachable!("not an issue command"),
        };
        Ok(Some(id))
    }

    /// Reorders the target stage with the issue inserted before `before_id`.
    /// Returns whether the issue changed stage.
    fn move_issue(
        &mut self,
        id: Uuid,
        stage_id: Uuid,
        before_id: Option<Uuid>,
        now: DateTime<Utc>,
    ) -> Result<bool> {
        let original = self.issue(id)?.clone();
        let (team_id, original_stage) = (original.team_id, original.stage_id);
        if original.archived_at.is_some() {
            return Err(Error::Conflict("issue is archived".into()));
        }
        let target = self
            .team(team_id)?
            .stages
            .iter()
            .find(|s| s.id == stage_id)
            .ok_or(Error::BadRequest("stage belongs to another team".into()))?;
        let target_is_done = matches!(target.kind, StageKind::Done);
        let target_is_backlog = matches!(target.kind, StageKind::Backlog);
        let mut moved = original.clone();
        moved.stage_id = stage_id;
        self.check_dependencies(&moved, Some(&original))?;

        let mut ids: Vec<_> = self
            .issues
            .iter()
            .filter(|i| {
                i.team_id == team_id
                    && i.stage_id == stage_id
                    && i.deleted_at.is_none()
                    && i.id != id
            })
            .map(|i| (i.position, i.id))
            .collect();
        ids.sort();
        let at = match before_id {
            Some(before) => ids
                .iter()
                .position(|(_, other)| *other == before)
                .ok_or(Error::BadRequest("invalid ordering neighbor".into()))?,
            None => ids.len(),
        };
        ids.insert(at, (0, id));

        for (rank, (_, issue_id)) in ids.into_iter().enumerate() {
            let issue = self.issue_mut(issue_id)?;
            issue.position = rank as i64;
            issue.stage_id = stage_id;
            issue.updated_at = now;
            if target_is_done {
                issue.done_at.get_or_insert(now);
            } else {
                issue.done_at = None;
            }
        }
        if target_is_backlog {
            self.issue_mut(id)?.sprint_id = None;
        }

        Ok(original_stage != stage_id)
    }

    fn bulk_issues(
        &mut self,
        ids: Vec<Uuid>,
        action: BulkAction,
        actor: Uuid,
        now: DateTime<Utc>,
    ) -> Result<()> {
        if ids.is_empty() || ids.len() > 500 {
            return Err(Error::BadRequest("select 1 to 500 issues".into()));
        }

        for id in ids {
            match &action {
                BulkAction::Update(p) => self.patch_issue(id, *p.clone(), actor, now)?,
                BulkAction::Delete => self.issue_mut(id)?.deleted_at = Some(now),
                BulkAction::Restore => self.restore(id, now)?,
                BulkAction::Archive => self.archive(id, now)?,
                BulkAction::Unarchive => self.unarchive(id, now)?,
            }
        }
        Ok(())
    }

    fn create_issue(&mut self, input: IssueInput, actor: Uuid, now: DateTime<Utc>) -> Result<Uuid> {
        let id = self.take_client_id(input.id)?;
        let stage_id = match input.stage_id {
            Some(id) => id,
            None => {
                self.team(input.team_id)?
                    .stages
                    .first()
                    .ok_or(Error::BadRequest("team has no workflow".into()))?
                    .id
            }
        };

        let mut issue = Issue {
            tracker: None,
            blocked_count: 0,
            subtask_total: 0,
            subtask_completed: 0,
            version: 1,
            id,
            number: self
                .issues
                .iter()
                .filter(|i| i.team_id == input.team_id)
                .map(|i| i.number)
                .max()
                .unwrap_or(0)
                + 1,
            title: input.title,
            description: input.description,
            team_id: input.team_id,
            stage_id,
            assignee: input.assignee,
            created_by: Some(actor),
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
            followers: vec![actor],
            attachments: vec![],
            source_links: vec![],
            deleted_at: None,
            archived_at: None,
            done_at: None,
            created_at: now,
            updated_at: now,
        };

        self.fit_sprint(&mut issue, input.stage_id.is_some())?;
        issue.position = self
            .issues
            .iter()
            .filter(|i| i.team_id == issue.team_id && i.stage_id == issue.stage_id)
            .count() as i64;
        self.validate_issue(&issue, None)?;
        self.refresh_done_at(&mut issue, now);

        let id = issue.id;
        if let Some(user) = issue.assignee
            && user != actor
        {
            self.notify(
                user,
                Some(id),
                AlertKind::Assignment,
                issue.title.clone(),
                format!("assignment:{id}:{}", Uuid::new_v4()),
                now,
            )
        }

        self.issues.push(issue);

        Ok(id)
    }

    fn patch_issue(
        &mut self,
        id: Uuid,
        p: IssuePatch,
        actor: Uuid,
        now: DateTime<Utc>,
    ) -> Result<()> {
        let old = self.issue(id)?.clone();
        if old.archived_at.is_some() {
            return Err(Error::Conflict("issue is archived".into()));
        }
        let mut i = old.clone();
        let (old_assignee, old_stage) = (i.assignee, i.stage_id);

        i.apply_patch(p);
        let entered_stage = i.stage_id != old_stage;
        self.fit_sprint(&mut i, entered_stage)?;

        i.updated_at = now;
        self.validate_issue(&i, Some(&old))?;
        self.refresh_done_at(&mut i, now);

        if i.assignee != old_assignee
            && let Some(user) = i.assignee
            && user != actor
        {
            self.notify(
                user,
                Some(id),
                AlertKind::Assignment,
                i.title.clone(),
                format!("assignment:{id}:{}", Uuid::new_v4()),
                now,
            )
        }

        for user in &i.followers {
            if *user != actor {
                self.notify(
                    *user,
                    Some(id),
                    AlertKind::Change,
                    i.title.clone(),
                    format!("change:{id}:{user}:{}", Uuid::new_v4()),
                    now,
                )
            }
        }

        *self.issue_mut(id)? = i;

        Ok(())
    }

    /// Keeps backlog work out of sprints; see [`Issue::sprint_fit`].
    fn fit_sprint(&self, issue: &mut Issue, entered_stage: bool) -> Result<()> {
        let team = self.team(issue.team_id)?;
        let in_backlog = team
            .stages
            .iter()
            .any(|s| s.id == issue.stage_id && s.kind == StageKind::Backlog);
        match issue.sprint_fit(in_backlog, entered_stage) {
            SprintFit::Keep => {}
            SprintFit::LeaveSprint => issue.sprint_id = None,
            SprintFit::Plan => issue.stage_id = team.sprint_stage()?,
        }
        Ok(())
    }

    fn restore(&mut self, id: Uuid, now: DateTime<Utc>) -> Result<()> {
        let mut issue = self
            .issues
            .iter()
            .find(|i| i.id == id)
            .ok_or(Error::NotFound)?
            .clone();

        let old = issue.clone();
        issue.deleted_at = None;
        issue.updated_at = now;
        if issue.sprint_id.is_some_and(|id| {
            self.sprints
                .iter()
                .any(|s| s.id == id && s.state.is_finished())
        }) {
            issue.sprint_id = None
        }

        self.validate_issue(&issue, Some(&old))?;
        *find_mut(&mut self.issues, |i| i.id == id)? = issue;

        Ok(())
    }

    fn archive(&mut self, id: Uuid, now: DateTime<Utc>) -> Result<()> {
        let mut issue = self
            .issues
            .iter()
            .find(|i| i.id == id && i.deleted_at.is_none())
            .ok_or(Error::NotFound)?
            .clone();

        if issue.archived_at.is_some() {
            return Err(Error::BadRequest("issue is already archived".into()));
        }
        if !self.archivable_done(&issue) {
            return Err(Error::BadRequest(
                "only issues in a Done stage can be archived".into(),
            ));
        }

        issue.archived_at = Some(now);
        issue.updated_at = now;
        *find_mut(&mut self.issues, |i| i.id == id)? = issue;

        Ok(())
    }

    fn unarchive(&mut self, id: Uuid, now: DateTime<Utc>) -> Result<()> {
        let mut issue = self
            .issues
            .iter()
            .find(|i| i.id == id && i.deleted_at.is_none())
            .ok_or(Error::NotFound)?
            .clone();

        if issue.archived_at.is_none() {
            return Err(Error::BadRequest("issue is not archived".into()));
        }

        // Fresh grace period if it is still Done; otherwise the clock clears.
        issue.archived_at = None;
        issue.updated_at = now;
        self.refresh_done_at(&mut issue, now);
        if self.archivable_done(&issue) {
            issue.done_at = Some(now);
        }
        *find_mut(&mut self.issues, |i| i.id == id)? = issue;

        Ok(())
    }
}
