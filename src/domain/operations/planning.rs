use super::super::*;
use super::find_mut;
use std::collections::BTreeSet;

impl Workspace {
    pub(super) fn apply_planning(
        &mut self,
        actor: Uuid,
        command: Command,
        now: DateTime<Utc>,
    ) -> Result<Uuid> {
        match command {
            Command::CreateTeam {
                id,
                name,
                members,
                default_stage_ids,
            } => self.create_team(actor, id, name, members, default_stage_ids),
            Command::SetTeamMembers { id, members } => {
                self.admin(actor)?;
                for user in &members {
                    self.member(*user)?;
                }
                self.team_mut(id)?.members = members;
                Ok(id)
            }
            Command::SetTeamArchive {
                id,
                archive_after_days,
            } => {
                self.admin(actor)?;
                super::super::validate_archive_days(archive_after_days)?;
                self.team_mut(id)?.archive_after_days = archive_after_days;
                Ok(id)
            }
            Command::SetTeamAppearance { id, icon, color } => {
                self.admin(actor)?;
                super::super::validate_team_appearance(&icon, &color)?;
                let team = self.team_mut(id)?;
                team.icon = icon;
                team.color = color;
                Ok(id)
            }
            Command::CreateStage {
                id,
                team_id,
                name,
                kind,
                position,
            } => {
                self.admin(actor)?;
                text(&name, 200)?;
                let id = self.take_client_id(id)?;
                self.team_mut(team_id)?.stages.push(Stage {
                    version: 1,
                    id,
                    name,
                    kind,
                    position,
                });
                Ok(id)
            }
            Command::UpdateStage {
                team_id,
                id,
                name,
                kind,
                position,
            } => {
                self.admin(actor)?;
                text(&name, 200)?;
                self.update_stage(team_id, id, name, kind, position, now)?;
                Ok(id)
            }
            Command::DeleteStage {
                team_id,
                id,
                replacement,
            } => {
                self.admin(actor)?;
                self.delete_stage(team_id, id, replacement, now)?;
                Ok(id)
            }
            Command::CreateLabel { id, name, color } => {
                validate_label(&name, &color)?;
                let id = self.take_client_id(id)?;
                self.labels.push(Label {
                    version: 1,
                    id,
                    name,
                    color,
                });
                Ok(id)
            }
            Command::UpdateLabel { id, name, color } => {
                validate_label(&name, &color)?;
                let label = find_mut(&mut self.labels, |l| l.id == id)?;
                label.name = name;
                label.color = color;
                Ok(id)
            }
            Command::CreateProject {
                id,
                name,
                description,
                team_ids,
            } => {
                text(&name, 200)?;
                for team in &team_ids {
                    self.team(*team)?;
                }
                let id = self.take_client_id(id)?;
                self.projects.push(Project {
                    version: 1,
                    id,
                    name,
                    description,
                    team_ids,
                });
                Ok(id)
            }
            Command::UpdateProject {
                id,
                name,
                description,
                team_ids,
            } => {
                self.update_project(id, name, description, team_ids)?;
                Ok(id)
            }
            Command::CreateMilestone {
                id,
                project_id,
                name,
                deadline,
            } => {
                text(&name, 200)?;
                optional_timestamp(deadline)?;
                if !self.projects.iter().any(|p| p.id == project_id) {
                    return Err(Error::NotFound);
                }
                let id = self.take_client_id(id)?;
                self.milestones.push(Milestone {
                    version: 1,
                    id,
                    project_id,
                    name,
                    deadline,
                });
                Ok(id)
            }
            Command::UpdateMilestone { id, name, deadline } => {
                text(&name, 200)?;
                optional_timestamp(deadline)?;
                let milestone = find_mut(&mut self.milestones, |m| m.id == id)?;
                milestone.name = name;
                milestone.deadline = deadline;
                Ok(id)
            }
            Command::CreateSprint {
                id,
                team_id,
                name,
                goal,
                starts_at,
                ends_at,
            } => {
                self.team(team_id)?;
                validate_sprint_fields(&name, starts_at, ends_at)?;
                if ends_at <= starts_at {
                    return Err(Error::BadRequest("sprint end must follow start".into()));
                }
                let id = self.take_client_id(id)?;
                self.sprints.push(Sprint {
                    version: 1,
                    id,
                    team_id,
                    name,
                    goal,
                    starts_at,
                    ends_at,
                    state: SprintState::Planned,
                    outcome: None,
                });
                Ok(id)
            }
            Command::UpdateSprint {
                id,
                name,
                goal,
                starts_at,
                ends_at,
                state,
            } => {
                self.update_sprint(id, name, goal, starts_at, ends_at, state)?;
                Ok(id)
            }
            Command::CompleteSprint {
                id,
                carryover_sprint_id,
            } => {
                self.complete_sprint(id, carryover_sprint_id, now)?;
                Ok(id)
            }
            Command::ArchiveSprint { id } => {
                let sprint = find_mut(&mut self.sprints, |s| s.id == id)?;
                if !sprint.state.is_finished() {
                    return Err(Error::BadRequest("complete sprint before archiving".into()));
                }
                sprint.state = SprintState::Archived;
                Ok(id)
            }
            _ => unreachable!("not a planning command"),
        }
    }

    fn team_mut(&mut self, id: Uuid) -> Result<&mut Team> {
        find_mut(&mut self.teams, |t| t.id == id)
    }

    fn create_team(
        &mut self,
        actor: Uuid,
        id: Option<Uuid>,
        name: String,
        members: Vec<Uuid>,
        default_stage_ids: Option<Vec<Uuid>>,
    ) -> Result<Uuid> {
        self.admin(actor)?;
        text(&name, 200)?;
        for user in &members {
            self.member(*user)?;
        }

        if let Some(ids) = &default_stage_ids {
            self.check_default_stage_ids(ids)?;
        }
        let id = self.take_client_id(id)?;
        if default_stage_ids
            .as_ref()
            .is_some_and(|ids| ids.contains(&id))
        {
            return Err(Error::Conflict("id already exists".into()));
        }

        let mut supplied = default_stage_ids.map(Vec::into_iter);
        let stages = super::super::default_stages()
            .into_iter()
            .enumerate()
            .map(|(p, (name, kind))| Stage {
                version: 1,
                id: supplied.as_mut().map_or_else(Uuid::new_v4, |ids| {
                    ids.next()
                        .expect("checked exactly one id per default stage")
                }),
                name: name.into(),
                kind,
                position: p as i64,
            })
            .collect();
        let color =
            super::super::least_used_team_color(self.teams.iter().map(|t| t.color.as_str()));
        self.teams.push(Team {
            version: 1,
            id,
            name,
            members,
            stages,
            archive_after_days: super::super::default_archive_days(),
            icon: super::super::default_team_icon(),
            color: color.into(),
        });
        Ok(id)
    }

    fn check_default_stage_ids(&self, ids: &[Uuid]) -> Result<()> {
        if ids.len() != super::super::default_stages().len() {
            return Err(Error::BadRequest(
                "default_stage_ids must contain exactly 4 ids".into(),
            ));
        }
        let mut seen = BTreeSet::new();
        for stage in ids {
            if !seen.insert(*stage) || self.id_taken(*stage) {
                return Err(Error::Conflict("id already exists".into()));
            }
            client_id(Some(*stage))?;
        }
        Ok(())
    }

    fn update_stage(
        &mut self,
        team_id: Uuid,
        id: Uuid,
        name: String,
        kind: StageKind,
        position: i64,
        now: DateTime<Utc>,
    ) -> Result<()> {
        let became_done = matches!(kind, StageKind::Done);
        let became_backlog = matches!(kind, StageKind::Backlog);
        let stage = find_mut(&mut self.team_mut(team_id)?.stages, |s| s.id == id)?;
        stage.name = name;
        stage.kind = kind;
        stage.position = position;

        for issue in self.issues.iter_mut().filter(|i| i.stage_id == id) {
            issue.updated_at = now;
            if became_backlog {
                issue.sprint_id = None;
            }
            if became_done {
                issue.done_at.get_or_insert(now);
            } else if issue.archived_at.is_none() {
                issue.done_at = None;
            }
        }
        Ok(())
    }

    fn delete_stage(
        &mut self,
        team_id: Uuid,
        id: Uuid,
        replacement: Uuid,
        now: DateTime<Utc>,
    ) -> Result<()> {
        let stages = &self.team(team_id)?.stages;
        let replacement_stage = stages.iter().find(|s| s.id == replacement);
        if id == replacement || replacement_stage.is_none() || !stages.iter().any(|s| s.id == id) {
            return Err(Error::BadRequest("invalid replacement stage".into()));
        }
        let replacement_is_done =
            replacement_stage.is_some_and(|s| matches!(s.kind, StageKind::Done));
        let replacement_is_backlog =
            replacement_stage.is_some_and(|s| matches!(s.kind, StageKind::Backlog));

        for issue in &mut self.issues {
            if issue.stage_id == id {
                issue.stage_id = replacement;
                issue.updated_at = now;
                if replacement_is_backlog {
                    issue.sprint_id = None;
                }
            }
            if issue.stage_id != replacement || issue.archived_at.is_some() {
                continue;
            }
            if replacement_is_done {
                issue.done_at.get_or_insert(now);
            } else {
                issue.done_at = None;
            }
        }

        self.team_mut(team_id)?.stages.retain(|s| s.id != id);
        Ok(())
    }

    fn update_project(
        &mut self,
        id: Uuid,
        name: String,
        description: String,
        team_ids: Vec<Uuid>,
    ) -> Result<()> {
        text(&name, 200)?;
        for team in &team_ids {
            self.team(*team)?;
        }
        if self
            .issues
            .iter()
            .any(|i| i.project_id == Some(id) && !team_ids.contains(&i.team_id))
        {
            return Err(Error::Conflict("project teams still contain issues".into()));
        }

        let project = find_mut(&mut self.projects, |p| p.id == id)?;
        project.name = name;
        project.description = description;
        project.team_ids = team_ids;
        Ok(())
    }

    fn update_sprint(
        &mut self,
        id: Uuid,
        name: String,
        goal: String,
        starts_at: DateTime<Utc>,
        ends_at: DateTime<Utc>,
        state: SprintState,
    ) -> Result<()> {
        validate_sprint_fields(&name, starts_at, ends_at)?;
        if ends_at <= starts_at || state.is_finished() {
            return Err(Error::BadRequest(
                "use completion or archive command".into(),
            ));
        }

        let sprint = find_mut(&mut self.sprints, |s| s.id == id)?;
        if sprint.state.is_finished() {
            return Err(Error::Conflict("sprint already completed".into()));
        }
        sprint.name = name;
        sprint.goal = goal;
        sprint.starts_at = starts_at;
        sprint.ends_at = ends_at;
        sprint.state = state;
        Ok(())
    }

    fn complete_sprint(
        &mut self,
        id: Uuid,
        carryover_sprint_id: Option<Uuid>,
        now: DateTime<Utc>,
    ) -> Result<()> {
        let sprint = self
            .sprints
            .iter()
            .find(|s| s.id == id)
            .ok_or(Error::NotFound)?;
        match sprint.state {
            SprintState::Archived => return Err(Error::Conflict("sprint archived".into())),
            SprintState::Completed => return Ok(()),
            _ => {}
        }
        if let Some(target) = carryover_sprint_id {
            self.check_carryover(sprint, target)?;
        }

        let rows: Vec<_> = self
            .issues
            .iter()
            .filter(|i| i.sprint_id == Some(id) && i.deleted_at.is_none())
            .collect();
        let outcome = SprintOutcome {
            total: rows.len() as u64,
            completed: rows.iter().filter(|i| self.done(i)).count() as u64,
            effort: rows.iter().map(|i| i.estimate.unwrap_or(0) as u64).sum(),
        };
        let unfinished: Vec<_> = rows
            .iter()
            .filter(|i| !self.done(i))
            .map(|i| i.id)
            .collect();

        for issue in unfinished {
            let issue = self.issue_mut(issue)?;
            issue.sprint_id = carryover_sprint_id;
            issue.updated_at = now;
        }
        let sprint = find_mut(&mut self.sprints, |s| s.id == id)?;
        sprint.outcome = Some(outcome);
        sprint.state = SprintState::Completed;
        Ok(())
    }

    fn check_carryover(&self, sprint: &Sprint, target: Uuid) -> Result<()> {
        let carryover = self
            .sprints
            .iter()
            .find(|s| s.id == target)
            .ok_or(Error::NotFound)?;
        if target == sprint.id
            || carryover.team_id != sprint.team_id
            || carryover.state.is_finished()
        {
            return Err(Error::BadRequest("invalid carryover sprint".into()));
        }
        Ok(())
    }
}

fn validate_label(name: &str, color: &str) -> Result<()> {
    text(name, 100)?;
    if color.len() > 40 {
        return Err(Error::BadRequest("invalid color".into()));
    }
    Ok(())
}

fn validate_sprint_fields(
    name: &str,
    starts_at: DateTime<Utc>,
    ends_at: DateTime<Utc>,
) -> Result<()> {
    text(name, 200)?;
    timestamp(starts_at)?;
    timestamp(ends_at)
}
