use super::*;
use std::collections::{BTreeMap, BTreeSet};

impl Workspace {
    pub fn new(name: String, owner: Uuid) -> Result<Self> {
        text(&name, 200)?;

        Ok(Self {
            version: 1,
            id: Uuid::new_v4(),
            name,
            members: vec![Member {
                version: 1,
                user_id: owner,
                role: Role::Owner,
            }],
            teams: vec![],
            labels: vec![],
            projects: vec![],
            milestones: vec![],
            sprints: vec![],
            issues: vec![],
            comments: vec![],
            time_entries: vec![],
            invitations: vec![],
            views: vec![],
            notifications: vec![],
            alert_preferences: vec![],
            integrations: vec![],
            activity: vec![],
        })
    }

    pub fn member(&self, user: Uuid) -> Result<&Member> {
        self.members
            .iter()
            .find(|m| m.user_id == user)
            .ok_or(Error::Forbidden)
    }

    fn admin(&self, user: Uuid) -> Result<()> {
        if matches!(self.member(user)?.role, Role::Owner | Role::Admin) {
            Ok(())
        } else {
            Err(Error::Forbidden)
        }
    }

    fn issue(&self, id: Uuid) -> Result<&Issue> {
        self.issues
            .iter()
            .find(|i| i.id == id && i.deleted_at.is_none())
            .ok_or(Error::NotFound)
    }

    fn issue_mut(&mut self, id: Uuid) -> Result<&mut Issue> {
        self.issues
            .iter_mut()
            .find(|i| i.id == id && i.deleted_at.is_none())
            .ok_or(Error::NotFound)
    }

    fn team(&self, id: Uuid) -> Result<&Team> {
        self.teams
            .iter()
            .find(|t| t.id == id)
            .ok_or(Error::NotFound)
    }

    fn done(&self, i: &Issue) -> bool {
        self.teams
            .iter()
            .flat_map(|t| &t.stages)
            .any(|s| s.id == i.stage_id && matches!(s.kind, StageKind::Done | StageKind::Cancelled))
    }

    fn wants(&self, user: Uuid, kind: &AlertKind) -> bool {
        self.member(user).is_ok()
            && self
                .alert_preferences
                .iter()
                .find(|p| p.user_id == user)
                .is_none_or(|p| p.enabled(kind))
    }

    fn notify(
        &mut self,
        user: Uuid,
        issue_id: Option<Uuid>,
        kind: AlertKind,
        message: String,
        key: String,
        now: DateTime<Utc>,
    ) {
        if !self.wants(user, &kind) || self.notifications.iter().any(|n| n.dedup_key == key) {
            return;
        }

        self.notifications.push(Notification {
            version: 1,
            id: Uuid::new_v4(),
            user_id: user,
            issue_id,
            kind,
            message,
            read_at: None,
            created_at: now,
            dedup_key: key,
        });
    }

    pub fn public(&self, actor: Uuid) -> Result<Self> {
        self.member(actor)?;

        let mut out = self.clone();
        for i in &mut out.invitations {
            i.token_hash.clear();
        }
        for i in &mut out.integrations {
            i.secret.clear();
        }

        out.notifications.retain(|n| n.user_id == actor);
        out.alert_preferences.retain(|p| p.user_id == actor);
        out.views.retain(|v| v.owner == actor || v.shared);
        if out.admin(actor).is_err() {
            out.invitations.clear();
            out.integrations.clear();
        }

        Ok(out)
    }

    pub fn accept_invitation(
        &mut self,
        user: Uuid,
        email: &str,
        token_hash: &str,
        now: DateTime<Utc>,
    ) -> Result<()> {
        let invitation = self
            .invitations
            .iter_mut()
            .find(|i| {
                i.token_hash == token_hash
                    && i.email.eq_ignore_ascii_case(email)
                    && i.state == InvitationState::Pending
                    && i.expires_at > now
            })
            .ok_or(Error::BadRequest("invalid or expired invitation".into()))?;

        if !self.members.iter().any(|m| m.user_id == user) {
            self.members.push(Member {
                version: 1,
                user_id: user,
                role: invitation.role.clone(),
            });
        }

        invitation.state = InvitationState::Accepted;
        invitation.token_hash.clear();

        Ok(())
    }

    fn validate_issue(&self, issue: &Issue) -> Result<()> {
        text(&issue.title, 500)?;
        if issue.description.len() > 100_000 {
            return Err(Error::BadRequest("description too long".into()));
        }

        let team = self.team(issue.team_id)?;
        if !team.stages.iter().any(|s| s.id == issue.stage_id) {
            return Err(Error::BadRequest("stage belongs to another team".into()));
        }

        if let Some(user) = issue.assignee {
            self.member(user)?;
        }
        if issue
            .labels
            .iter()
            .any(|id| !self.labels.iter().any(|l| l.id == *id))
        {
            return Err(Error::BadRequest("unknown label".into()));
        }

        if let Some(id) = issue.project_id {
            let p = self
                .projects
                .iter()
                .find(|p| p.id == id)
                .ok_or(Error::NotFound)?;
            if !p.team_ids.contains(&issue.team_id) {
                return Err(Error::BadRequest("project does not include team".into()));
            }
        }
        if let Some(id) = issue.milestone_id {
            let m = self
                .milestones
                .iter()
                .find(|m| m.id == id)
                .ok_or(Error::NotFound)?;
            if Some(m.project_id) != issue.project_id {
                return Err(Error::BadRequest(
                    "milestone belongs to another project".into(),
                ));
            }
        }

        if let Some(id) = issue.sprint_id {
            let s = self
                .sprints
                .iter()
                .find(|s| s.id == id)
                .ok_or(Error::NotFound)?;
            if s.team_id != issue.team_id
                || (matches!(s.state, SprintState::Completed | SprintState::Archived)
                    && !(self
                        .issues
                        .iter()
                        .any(|old| old.id == issue.id && old.sprint_id == Some(id))
                        && self.done(issue)))
            {
                return Err(Error::BadRequest(
                    "sprint is unavailable for this team".into(),
                ));
            }
        }

        let starting = issue.deleted_at.is_none()
            && team.stages.iter().any(|stage| {
                stage.id == issue.stage_id
                    && matches!(stage.kind, StageKind::Active | StageKind::Done)
            });
        for dep in &issue.dependencies {
            let dependency = self.issue(*dep)?;
            if starting && !self.done(dependency) {
                return Err(Error::Conflict("issue has unfinished dependencies".into()));
            }
        }
        if let Some(parent) = issue.parent_id {
            self.issue(parent)?;
        }

        for parent_only in [true, false] {
            let mut todo = if parent_only {
                issue.parent_id.into_iter().collect::<Vec<_>>()
            } else {
                issue.dependencies.clone()
            };
            let mut seen = BTreeSet::new();
            while let Some(id) = todo.pop() {
                if id == issue.id {
                    return Err(Error::BadRequest("issue relations contain a cycle".into()));
                }
                if !seen.insert(id) {
                    continue;
                }

                let related = self.issue(id)?;
                if parent_only {
                    todo.extend(related.parent_id);
                } else {
                    todo.extend(&related.dependencies);
                }
            }
        }

        Ok(())
    }

    fn create_issue(&mut self, input: IssueInput, actor: Uuid, now: DateTime<Utc>) -> Result<Uuid> {
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

        let issue = Issue {
            openproject: None,
            blocked_count: 0,
            subtask_total: 0,
            subtask_completed: 0,
            version: 1,
            id: Uuid::new_v4(),
            number: self.issues.iter().map(|i| i.number).max().unwrap_or(0) + 1,
            title: input.title,
            description: input.description,
            team_id: input.team_id,
            stage_id,
            assignee: input.assignee,
            priority: input.priority,
            labels: input.labels,
            estimate: input.estimate,
            deadline: input.deadline,
            project_id: input.project_id,
            milestone_id: input.milestone_id,
            sprint_id: input.sprint_id,
            parent_id: input.parent_id,
            dependencies: input.dependencies,
            position: self
                .issues
                .iter()
                .filter(|i| i.team_id == input.team_id && i.stage_id == stage_id)
                .count() as i64,
            followers: vec![actor],
            attachments: vec![],
            source_links: vec![],
            deleted_at: None,
            created_at: now,
            updated_at: now,
        };

        self.validate_issue(&issue)?;

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
        let mut i = self.issue(id)?.clone();
        let old_assignee = i.assignee;

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
            i.estimate = None;
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
            i.milestone_id = None;
        } else if let Some(v) = p.project_id {
            i.project_id = Some(v)
        }
        if p.clear_milestone {
            i.milestone_id = None;
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

        i.updated_at = now;
        self.validate_issue(&i)?;

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

    pub fn apply(
        &mut self,
        actor: Uuid,
        command: Command,
        now: DateTime<Utc>,
    ) -> Result<CommandResult> {
        self.member(actor)?;

        let mut copy = self.clone();
        let result = copy.apply_inner(actor, command, now)?;
        copy.check_limits()?;

        for team in &mut copy.teams {
            team.stages.sort_by_key(|s| (s.position, s.id));
        }
        copy.check_workflow()?;

        let completed: Vec<_> = copy
            .issues
            .iter()
            .filter(|i| {
                i.deleted_at.is_none()
                    && copy.done(i)
                    && self
                        .issues
                        .iter()
                        .find(|old| old.id == i.id)
                        .is_none_or(|old| !self.done(old))
            })
            .map(|i| i.id)
            .collect();
        for id in completed {
            copy.activity.push(Activity {
                id: Uuid::new_v4(),
                actor,
                action: "issue_completed".into(),
                entity_id: Some(id),
                at: now,
                fields: vec![],
            });
        }

        copy.check_limits()?;
        *self = copy;

        Ok(result)
    }

    fn check_workflow(&self) -> Result<()> {
        for issue in self.issues.iter().filter(|i| i.deleted_at.is_none()) {
            let stage = self
                .team(issue.team_id)?
                .stages
                .iter()
                .find(|s| s.id == issue.stage_id)
                .ok_or(Error::BadRequest("unknown stage".into()))?;
            if matches!(stage.kind, StageKind::Active | StageKind::Done)
                && issue.dependencies.iter().any(|id| {
                    self.issues
                        .iter()
                        .find(|i| i.id == *id)
                        .is_none_or(|i| i.deleted_at.is_some() || !self.done(i))
                })
            {
                return Err(Error::Conflict(
                    "workflow would leave an issue with unfinished dependencies".into(),
                ));
            }
        }

        Ok(())
    }

    pub fn validate_imported(&self) -> Result<()> {
        self.check_limits()?;
        text(&self.name, 200)?;

        for team in &self.teams {
            text(&team.name, 200)?;
            if team.stages.is_empty() || team.stages.len() > 100 {
                return Err(Error::BadRequest(
                    "team must contain 1 to 100 stages".into(),
                ));
            }
            for stage in &team.stages {
                text(&stage.name, 200)?;
            }
            for user in &team.members {
                self.member(*user)?;
            }
        }

        for label in &self.labels {
            text(&label.name, 100)?;
            if label.color.len() > 40 {
                return Err(Error::BadRequest("invalid label color".into()));
            }
        }

        for project in &self.projects {
            text(&project.name, 200)?;
            if project.description.len() > 100000 {
                return Err(Error::BadRequest("project description too long".into()));
            }
            for id in &project.team_ids {
                self.team(*id)?;
            }
        }

        for milestone in &self.milestones {
            text(&milestone.name, 200)?;
            if !self.projects.iter().any(|p| p.id == milestone.project_id) {
                return Err(Error::BadRequest("unknown milestone project".into()));
            }
        }

        for sprint in &self.sprints {
            self.team(sprint.team_id)?;
            text(&sprint.name, 200)?;
            if sprint.ends_at <= sprint.starts_at || sprint.goal.len() > 100000 {
                return Err(Error::BadRequest("invalid sprint".into()));
            }
        }

        let mut check = self.clone();
        for sprint in &mut check.sprints {
            sprint.state = SprintState::Planned;
        }
        for issue in &mut check.issues {
            issue.deleted_at = None;
        }

        for issue in &self.issues {
            check.validate_issue(issue)?;
            for user in &issue.followers {
                check.member(*user)?;
            }
            for link in &issue.source_links {
                validate_url(&link.url)?;
                text(&link.title, 500)?;
            }
        }

        self.check_workflow()?;

        for comment in &self.comments {
            text(&comment.body, 100000)?;
            if !self.issues.iter().any(|i| i.id == comment.issue_id) {
                return Err(Error::BadRequest("unknown comment issue".into()));
            }
        }

        for entry in &self.time_entries {
            Self::validate_time(entry.minutes, &entry.note)?;
            if !self.issues.iter().any(|i| i.id == entry.issue_id) {
                return Err(Error::BadRequest("unknown time entry issue".into()));
            }
        }

        for view in &self.views {
            text(&view.name, 200)?;
        }

        Ok(())
    }

    fn check_limits(&self) -> Result<()> {
        if self.issues.len() > 5000
            || self.comments.len() > 20000
            || self.time_entries.len() > 20000
            || self.notifications.len() > 30000
            || self.activity.len() > 50000
            || self.members.len() > 2000
            || self.teams.len() > 200
            || self.projects.len() > 1000
            || self.sprints.len() > 2000
            || self.invitations.len() > 5000
            || self.views.len() > 5000
            || self.integrations.len() > 100
            || self.labels.len() > 1000
            || self.milestones.len() > 5000
        {
            return Err(Error::BadRequest("workspace capacity reached".into()));
        }

        Ok(())
    }

    fn apply_inner(
        &mut self,
        actor: Uuid,
        command: Command,
        now: DateTime<Utc>,
    ) -> Result<CommandResult> {
        let personal = matches!(
            &command,
            Command::MarkNotificationRead { .. }
                | Command::MarkNotificationUnread { .. }
                | Command::MarkAllNotificationsRead
                | Command::ConfigureAlerts { .. }
                | Command::SaveView { shared: false, .. }
                | Command::UpdateView { shared: false, .. }
                | Command::DeleteView { .. }
                | Command::Follow { .. }
        );
        if self.member(actor)?.role == Role::Viewer && !personal {
            return Err(Error::Forbidden);
        }

        let action = command.kind().to_string();
        let mut result = None;
        let mut fields = vec![];

        match command {
            Command::CreateTeam { name, members } => {
                self.admin(actor)?;
                text(&name, 200)?;
                for user in &members {
                    self.member(*user)?;
                }

                let id = Uuid::new_v4();
                let stages = [
                    ("Backlog", StageKind::Backlog),
                    ("Todo", StageKind::Planned),
                    ("In progress", StageKind::Active),
                    ("Done", StageKind::Done),
                ]
                .into_iter()
                .enumerate()
                .map(|(p, (name, kind))| Stage {
                    version: 1,
                    id: Uuid::new_v4(),
                    name: name.into(),
                    kind,
                    position: p as i64,
                })
                .collect();
                self.teams.push(Team {
                    version: 1,
                    id,
                    name,
                    members,
                    stages,
                });
                result = Some(id)
            }

            Command::SetTeamMembers { id, members } => {
                self.admin(actor)?;
                for user in &members {
                    self.member(*user)?;
                }

                self.teams
                    .iter_mut()
                    .find(|t| t.id == id)
                    .ok_or(Error::NotFound)?
                    .members = members;
                result = Some(id)
            }

            Command::CreateStage {
                team_id,
                name,
                kind,
                position,
            } => {
                self.admin(actor)?;
                text(&name, 200)?;

                let id = Uuid::new_v4();
                self.teams
                    .iter_mut()
                    .find(|t| t.id == team_id)
                    .ok_or(Error::NotFound)?
                    .stages
                    .push(Stage {
                        version: 1,
                        id,
                        name,
                        kind,
                        position,
                    });
                result = Some(id)
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

                let s = self
                    .teams
                    .iter_mut()
                    .find(|t| t.id == team_id)
                    .ok_or(Error::NotFound)?
                    .stages
                    .iter_mut()
                    .find(|s| s.id == id)
                    .ok_or(Error::NotFound)?;
                s.name = name;
                s.kind = kind;
                s.position = position;
                result = Some(id)
            }

            Command::DeleteStage {
                team_id,
                id,
                replacement,
            } => {
                self.admin(actor)?;
                if id == replacement
                    || !self
                        .team(team_id)?
                        .stages
                        .iter()
                        .any(|s| s.id == replacement)
                    || !self.team(team_id)?.stages.iter().any(|s| s.id == id)
                {
                    return Err(Error::BadRequest("invalid replacement stage".into()));
                }

                for i in &mut self.issues {
                    if i.stage_id == id {
                        i.stage_id = replacement;
                    }
                }

                self.teams
                    .iter_mut()
                    .find(|t| t.id == team_id)
                    .unwrap()
                    .stages
                    .retain(|s| s.id != id);
                result = Some(id)
            }

            Command::CreateLabel { name, color } => {
                text(&name, 100)?;
                if color.len() > 40 {
                    return Err(Error::BadRequest("invalid color".into()));
                }

                let id = Uuid::new_v4();
                self.labels.push(Label {
                    version: 1,
                    id,
                    name,
                    color,
                });
                result = Some(id)
            }

            Command::UpdateLabel { id, name, color } => {
                text(&name, 100)?;
                if color.len() > 40 {
                    return Err(Error::BadRequest("invalid color".into()));
                }

                let l = self
                    .labels
                    .iter_mut()
                    .find(|l| l.id == id)
                    .ok_or(Error::NotFound)?;
                l.name = name;
                l.color = color;
                result = Some(id)
            }

            Command::CreateProject {
                name,
                description,
                team_ids,
            } => {
                text(&name, 200)?;
                for id in &team_ids {
                    self.team(*id)?;
                }

                let id = Uuid::new_v4();
                self.projects.push(Project {
                    version: 1,
                    id,
                    name,
                    description,
                    team_ids,
                });
                result = Some(id)
            }

            Command::UpdateProject {
                id,
                name,
                description,
                team_ids,
            } => {
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

                let p = self
                    .projects
                    .iter_mut()
                    .find(|p| p.id == id)
                    .ok_or(Error::NotFound)?;
                p.name = name;
                p.description = description;
                p.team_ids = team_ids;
                result = Some(id)
            }

            Command::CreateMilestone {
                project_id,
                name,
                deadline,
            } => {
                text(&name, 200)?;
                if !self.projects.iter().any(|p| p.id == project_id) {
                    return Err(Error::NotFound);
                }

                let id = Uuid::new_v4();
                self.milestones.push(Milestone {
                    version: 1,
                    id,
                    project_id,
                    name,
                    deadline,
                });
                result = Some(id)
            }

            Command::UpdateMilestone { id, name, deadline } => {
                text(&name, 200)?;

                let m = self
                    .milestones
                    .iter_mut()
                    .find(|m| m.id == id)
                    .ok_or(Error::NotFound)?;
                m.name = name;
                m.deadline = deadline;
                result = Some(id)
            }

            Command::CreateSprint {
                team_id,
                name,
                goal,
                starts_at,
                ends_at,
            } => {
                self.team(team_id)?;
                text(&name, 200)?;
                if ends_at <= starts_at {
                    return Err(Error::BadRequest("sprint end must follow start".into()));
                }

                let id = Uuid::new_v4();
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
                result = Some(id)
            }

            Command::UpdateSprint {
                id,
                name,
                goal,
                starts_at,
                ends_at,
                state,
            } => {
                text(&name, 200)?;
                if ends_at <= starts_at
                    || matches!(state, SprintState::Completed | SprintState::Archived)
                {
                    return Err(Error::BadRequest(
                        "use completion or archive command".into(),
                    ));
                }

                let s = self
                    .sprints
                    .iter_mut()
                    .find(|s| s.id == id)
                    .ok_or(Error::NotFound)?;
                if matches!(s.state, SprintState::Completed | SprintState::Archived) {
                    return Err(Error::Conflict("sprint already completed".into()));
                }

                s.name = name;
                s.goal = goal;
                s.starts_at = starts_at;
                s.ends_at = ends_at;
                s.state = state;
                result = Some(id)
            }

            Command::CompleteSprint {
                id,
                carryover_sprint_id,
            } => {
                let sprint = self
                    .sprints
                    .iter()
                    .find(|s| s.id == id)
                    .ok_or(Error::NotFound)?
                    .clone();
                if sprint.state == SprintState::Archived {
                    return Err(Error::Conflict("sprint archived".into()));
                }

                if sprint.state != SprintState::Completed {
                    if let Some(target) = carryover_sprint_id {
                        let t = self
                            .sprints
                            .iter()
                            .find(|s| s.id == target)
                            .ok_or(Error::NotFound)?;
                        if target == id
                            || t.team_id != sprint.team_id
                            || matches!(t.state, SprintState::Completed | SprintState::Archived)
                        {
                            return Err(Error::BadRequest("invalid carryover sprint".into()));
                        }
                    }

                    let sprint_rows: Vec<_> = self
                        .issues
                        .iter()
                        .filter(|i| i.sprint_id == Some(id) && i.deleted_at.is_none())
                        .collect();
                    let outcome = SprintOutcome {
                        total: sprint_rows.len() as u64,
                        completed: sprint_rows.iter().filter(|i| self.done(i)).count() as u64,
                        effort: sprint_rows
                            .iter()
                            .map(|i| i.estimate.unwrap_or(0) as u64)
                            .sum(),
                    };
                    self.sprints
                        .iter_mut()
                        .find(|s| s.id == id)
                        .unwrap()
                        .outcome = Some(outcome);

                    let unfinished: Vec<_> = self
                        .issues
                        .iter()
                        .filter(|i| {
                            i.sprint_id == Some(id) && i.deleted_at.is_none() && !self.done(i)
                        })
                        .map(|i| i.id)
                        .collect();
                    for issue in unfinished {
                        let i = self.issue_mut(issue)?;
                        i.sprint_id = carryover_sprint_id;
                        i.updated_at = now;
                    }

                    self.sprints.iter_mut().find(|s| s.id == id).unwrap().state =
                        SprintState::Completed;
                }
                result = Some(id)
            }

            Command::ArchiveSprint { id } => {
                let s = self
                    .sprints
                    .iter_mut()
                    .find(|s| s.id == id)
                    .ok_or(Error::NotFound)?;
                if s.state != SprintState::Completed && s.state != SprintState::Archived {
                    return Err(Error::BadRequest("complete sprint before archiving".into()));
                }

                s.state = SprintState::Archived;
                result = Some(id)
            }

            Command::CreateIssue { input } => result = Some(self.create_issue(input, actor, now)?),

            Command::UpdateIssue { id, patch } => {
                let before = self.issue(id)?.clone();
                self.patch_issue(id, patch, actor, now)?;
                fields = changed_fields(&before, self.issue(id)?);
                result = Some(id)
            }

            Command::MoveIssue {
                id,
                stage_id,
                before_id,
            } => {
                let original = self.issue(id)?.clone();
                if !self
                    .team(original.team_id)?
                    .stages
                    .iter()
                    .any(|s| s.id == stage_id)
                {
                    return Err(Error::BadRequest("stage belongs to another team".into()));
                }

                let mut ids: Vec<_> = self
                    .issues
                    .iter()
                    .filter(|i| {
                        i.team_id == original.team_id
                            && i.stage_id == stage_id
                            && i.deleted_at.is_none()
                            && i.id != id
                    })
                    .map(|i| (i.position, i.id))
                    .collect();
                ids.sort();
                let at = if let Some(before) = before_id {
                    ids.iter()
                        .position(|(_, other)| *other == before)
                        .ok_or(Error::BadRequest("invalid ordering neighbor".into()))?
                } else {
                    ids.len()
                };
                ids.insert(at, (0, id));

                for (rank, (_, issue_id)) in ids.into_iter().enumerate() {
                    let i = self.issue_mut(issue_id)?;
                    i.position = rank as i64;
                    i.stage_id = stage_id;
                    i.updated_at = now;
                }

                if original.stage_id != stage_id {
                    fields.push("stage".into());
                }
                result = Some(id)
            }

            Command::BulkIssues { ids, action } => {
                if ids.is_empty() || ids.len() > 500 {
                    return Err(Error::BadRequest("select 1 to 500 issues".into()));
                }

                for id in ids {
                    match &action {
                        BulkAction::Update(p) => self.patch_issue(id, *p.clone(), actor, now)?,
                        BulkAction::Delete => {
                            self.issue_mut(id)?.deleted_at = Some(now);
                        }
                        BulkAction::Restore => {
                            self.restore(id, now)?;
                        }
                    }
                }
            }

            Command::DeleteIssue { id } => {
                self.issue_mut(id)?.deleted_at = Some(now);
                result = Some(id)
            }

            Command::RestoreIssue { id } => {
                self.restore(id, now)?;
                result = Some(id)
            }

            Command::AddAttachment {
                issue_id,
                attachment,
            } => {
                self.validate_attachment(&attachment)?;

                self.issue_mut(issue_id)?.attachments.push(attachment);
                result = Some(issue_id)
            }

            Command::AttachCommentFile {
                comment_id,
                attachment,
            } => {
                self.validate_attachment(&attachment)?;
                let comment = self
                    .comments
                    .iter()
                    .find(|c| c.id == comment_id)
                    .ok_or(Error::NotFound)?;
                self.issue(comment.issue_id)?;
                if comment.author != actor {
                    self.admin(actor)?;
                }

                self.comments
                    .iter_mut()
                    .find(|c| c.id == comment_id)
                    .unwrap()
                    .attachments
                    .push(attachment);
                result = Some(comment_id);
            }

            Command::RemoveAttachment {
                issue_id,
                attachment_id,
            } => {
                let i = self.issue_mut(issue_id)?;
                if !i.attachments.iter().any(|a| a.id == attachment_id) {
                    return Err(Error::NotFound);
                }

                i.attachments.retain(|a| a.id != attachment_id);
                result = Some(issue_id)
            }

            Command::AddComment {
                issue_id,
                body,
                mentions,
                attachments,
            } => {
                self.issue(issue_id)?;
                text(&body, 100_000)?;
                for user in &mentions {
                    self.member(*user)?;
                }
                for attachment in &attachments {
                    self.validate_attachment(attachment)?;
                }

                let id = Uuid::new_v4();
                let followers = self.issue(issue_id)?.followers.clone();
                for user in followers {
                    if user != actor {
                        self.notify(
                            user,
                            Some(issue_id),
                            AlertKind::Reply,
                            body.clone(),
                            format!("reply:{id}:{user}"),
                            now,
                        )
                    }
                }
                for user in &mentions {
                    if *user != actor {
                        self.notify(
                            *user,
                            Some(issue_id),
                            AlertKind::Mention,
                            body.clone(),
                            format!("mention:{id}:{user}"),
                            now,
                        )
                    }
                }

                self.comments.push(Comment {
                    version: 1,
                    id,
                    issue_id,
                    author: actor,
                    body,
                    mentions,
                    attachments,
                    created_at: now,
                    edited_at: None,
                });
                result = Some(id)
            }

            Command::EditComment { id, body, mentions } => {
                text(&body, 100_000)?;
                for user in &mentions {
                    self.member(*user)?;
                }

                let c = self
                    .comments
                    .iter()
                    .find(|c| c.id == id)
                    .ok_or(Error::NotFound)?;
                if c.author != actor {
                    self.admin(actor)?;
                }

                let c = self.comments.iter_mut().find(|c| c.id == id).unwrap();
                c.body = body;
                c.mentions = mentions;
                c.edited_at = Some(now);
                result = Some(id)
            }

            Command::DeleteComment { id } => {
                let c = self
                    .comments
                    .iter()
                    .find(|c| c.id == id)
                    .ok_or(Error::NotFound)?;
                if c.author != actor {
                    self.admin(actor)?;
                }

                self.comments.retain(|c| c.id != id);
                result = Some(id)
            }

            Command::Follow {
                issue_id,
                following,
            } => {
                let i = self.issue_mut(issue_id)?;
                i.followers.retain(|u| *u != actor);
                if following {
                    i.followers.push(actor)
                }
                result = Some(issue_id)
            }

            Command::LogTime {
                issue_id,
                minutes,
                note,
                logged_at,
            } => {
                self.issue(issue_id)?;
                Self::validate_time(minutes, &note)?;

                let id = Uuid::new_v4();
                self.time_entries.push(TimeEntry {
                    version: 1,
                    id,
                    issue_id,
                    user_id: actor,
                    minutes,
                    note,
                    logged_at,
                });
                result = Some(id)
            }

            Command::UpdateTime {
                id,
                minutes,
                note,
                logged_at,
            } => {
                Self::validate_time(minutes, &note)?;

                let e = self
                    .time_entries
                    .iter()
                    .find(|e| e.id == id)
                    .ok_or(Error::NotFound)?;
                if e.user_id != actor {
                    self.admin(actor)?;
                }

                let e = self.time_entries.iter_mut().find(|e| e.id == id).unwrap();
                e.minutes = minutes;
                e.note = note;
                e.logged_at = logged_at;
                result = Some(id)
            }

            Command::DeleteTime { id } => {
                let e = self
                    .time_entries
                    .iter()
                    .find(|e| e.id == id)
                    .ok_or(Error::NotFound)?;
                if e.user_id != actor {
                    self.admin(actor)?;
                }

                self.time_entries.retain(|e| e.id != id);
                result = Some(id)
            }

            Command::SaveView {
                name,
                shared,
                filter,
            } => {
                text(&name, 200)?;

                let id = Uuid::new_v4();
                self.views.push(SavedView {
                    version: 1,
                    id,
                    owner: actor,
                    name,
                    shared,
                    filter,
                });
                result = Some(id)
            }

            Command::UpdateView {
                id,
                name,
                shared,
                filter,
            } => {
                text(&name, 200)?;

                let owner = self
                    .views
                    .iter()
                    .find(|v| v.id == id)
                    .ok_or(Error::NotFound)?
                    .owner;
                if owner != actor {
                    self.admin(actor)?;
                }
                if shared && self.member(actor)?.role == Role::Viewer {
                    return Err(Error::Forbidden);
                }

                let v = self
                    .views
                    .iter_mut()
                    .find(|v| v.id == id)
                    .ok_or(Error::NotFound)?;
                v.name = name;
                v.shared = shared;
                v.filter = filter;
                result = Some(id)
            }

            Command::DeleteView { id } => {
                let v = self
                    .views
                    .iter()
                    .find(|v| v.id == id)
                    .ok_or(Error::NotFound)?;
                if v.owner != actor {
                    self.admin(actor)?;
                }

                self.views.retain(|v| v.id != id);
                result = Some(id)
            }

            Command::Invite {
                email,
                role,
                token_hash,
            } => {
                self.admin(actor)?;
                if role == Role::Owner && self.member(actor)?.role != Role::Owner {
                    return Err(Error::Forbidden);
                }

                validate_email(&email)?;
                validate_hash(&token_hash)?;
                if self.invitations.iter().any(|i| {
                    i.email.eq_ignore_ascii_case(&email)
                        && i.state == InvitationState::Pending
                        && i.expires_at > now
                }) {
                    return Err(Error::Conflict("invitation already pending".into()));
                }

                let id = Uuid::new_v4();
                self.invitations.push(Invitation {
                    version: 1,
                    id,
                    email: email.to_lowercase(),
                    role,
                    token_hash,
                    expires_at: now + chrono::Duration::days(7),
                    state: InvitationState::Pending,
                });
                result = Some(id)
            }

            Command::ResendInvitation { id, token_hash } => {
                self.admin(actor)?;
                validate_hash(&token_hash)?;

                let i = self
                    .invitations
                    .iter_mut()
                    .find(|i| i.id == id)
                    .ok_or(Error::NotFound)?;
                if matches!(
                    i.state,
                    InvitationState::Accepted | InvitationState::Cancelled
                ) {
                    return Err(Error::Conflict("invitation is no longer pending".into()));
                }

                i.token_hash = token_hash;
                i.expires_at = now + chrono::Duration::days(7);
                i.state = InvitationState::Pending;
                result = Some(id)
            }

            Command::CancelInvitation { id } => {
                self.admin(actor)?;

                let i = self
                    .invitations
                    .iter_mut()
                    .find(|i| i.id == id)
                    .ok_or(Error::NotFound)?;
                if i.state == InvitationState::Accepted {
                    return Err(Error::Conflict("invitation already accepted".into()));
                }

                i.state = InvitationState::Cancelled;
                i.token_hash.clear();
                result = Some(id)
            }

            Command::SetRole { user_id, role } => {
                self.admin(actor)?;
                let old = self.member(user_id)?.role.clone();
                if (old == Role::Owner || role == Role::Owner)
                    && self.member(actor)?.role != Role::Owner
                {
                    return Err(Error::Forbidden);
                }
                if old == Role::Owner
                    && role != Role::Owner
                    && self
                        .members
                        .iter()
                        .filter(|m| m.role == Role::Owner)
                        .count()
                        == 1
                {
                    return Err(Error::Conflict("workspace must retain an owner".into()));
                }

                self.members
                    .iter_mut()
                    .find(|m| m.user_id == user_id)
                    .unwrap()
                    .role = role;
                result = Some(user_id)
            }

            Command::RemoveMember { user_id } => {
                self.admin(actor)?;
                let role = self.member(user_id)?.role.clone();
                if role == Role::Owner {
                    if self.member(actor)?.role != Role::Owner {
                        return Err(Error::Forbidden);
                    }
                    if self
                        .members
                        .iter()
                        .filter(|m| m.role == Role::Owner)
                        .count()
                        == 1
                    {
                        return Err(Error::Conflict("workspace must retain an owner".into()));
                    }
                }

                self.members.retain(|m| m.user_id != user_id);
                for t in &mut self.teams {
                    t.members.retain(|u| *u != user_id);
                }
                for i in &mut self.issues {
                    if i.assignee == Some(user_id) {
                        i.assignee = None
                    }
                    i.followers.retain(|u| *u != user_id);
                }
                result = Some(user_id)
            }

            Command::MarkNotificationRead { id } => {
                let n = self
                    .notifications
                    .iter_mut()
                    .find(|n| n.id == id && n.user_id == actor)
                    .ok_or(Error::NotFound)?;
                n.read_at = Some(now);
                result = Some(id)
            }

            Command::MarkNotificationUnread { id } => {
                let n = self
                    .notifications
                    .iter_mut()
                    .find(|n| n.id == id && n.user_id == actor)
                    .ok_or(Error::NotFound)?;
                n.read_at = None;
                result = Some(id)
            }

            Command::MarkAllNotificationsRead => {
                for n in &mut self.notifications {
                    if n.user_id == actor {
                        n.read_at = Some(now)
                    }
                }
            }

            Command::ConfigureAlerts {
                assignment,
                reply,
                change,
                mention,
                deadline,
            } => {
                self.alert_preferences.retain(|p| p.user_id != actor);
                self.alert_preferences.push(AlertPreferences {
                    version: 1,
                    user_id: actor,
                    assignment,
                    reply,
                    change,
                    mention,
                    deadline,
                });
            }

            Command::CreateIntegration {
                name,
                webhook_url,
                secret,
            } => {
                self.admin(actor)?;
                text(&name, 200)?;
                validate_url(&webhook_url)?;
                text(&secret, 4096)?;

                let id = Uuid::new_v4();
                self.integrations.push(Integration {
                    version: 1,
                    id,
                    name,
                    webhook_url,
                    secret,
                    enabled: true,
                });
                result = Some(id)
            }

            Command::UpdateIntegration { id, enabled } => {
                self.admin(actor)?;

                self.integrations
                    .iter_mut()
                    .find(|i| i.id == id)
                    .ok_or(Error::NotFound)?
                    .enabled = enabled;
                result = Some(id)
            }

            Command::DeleteIntegration { id } => {
                self.admin(actor)?;
                if !self.integrations.iter().any(|i| i.id == id) {
                    return Err(Error::NotFound);
                }

                self.integrations.retain(|i| i.id != id);
                result = Some(id)
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
                result = Some(issue_id)
            }

            Command::ImportIssues { issues } => {
                if issues.len() > 1000 {
                    return Err(Error::BadRequest("import limited to 1000 issues".into()));
                }

                for input in issues {
                    self.create_issue(input, actor, now)?;
                }
            }
        }

        self.activity.push(Activity {
            id: Uuid::new_v4(),
            actor,
            action,
            entity_id: result,
            at: now,
            fields,
        });

        Ok(CommandResult { id: result })
    }

    fn restore(&mut self, id: Uuid, now: DateTime<Utc>) -> Result<()> {
        let mut issue = self
            .issues
            .iter()
            .find(|i| i.id == id)
            .ok_or(Error::NotFound)?
            .clone();

        issue.deleted_at = None;
        issue.updated_at = now;
        if issue.sprint_id.is_some_and(|id| {
            self.sprints.iter().any(|s| {
                s.id == id && matches!(s.state, SprintState::Completed | SprintState::Archived)
            })
        }) {
            issue.sprint_id = None
        }

        self.validate_issue(&issue)?;
        *self.issues.iter_mut().find(|i| i.id == id).unwrap() = issue;

        Ok(())
    }

    fn validate_attachment(&self, a: &Attachment) -> Result<()> {
        text(&a.name, 500)?;
        if a.size > 25 * 1024 * 1024 || a.content_type.len() > 200 {
            return Err(Error::BadRequest("attachment exceeds limits".into()));
        }

        Ok(())
    }

    fn validate_time(minutes: u32, note: &str) -> Result<()> {
        if minutes == 0 || minutes > 24 * 60 || note.len() > 10_000 {
            return Err(Error::BadRequest(
                "time entry must contain 1 to 1440 minutes".into(),
            ));
        }

        Ok(())
    }

    pub fn query(&self, actor: Uuid, f: IssueFilter) -> Result<Vec<Issue>> {
        self.member(actor)?;

        let mut issues: Vec<_> = self
            .issues
            .iter()
            .filter(|i| {
                i.deleted_at.is_some() == f.trash
                    && f.assignee.is_none_or(|v| i.assignee == Some(v))
                    && (!f.unassigned || i.assignee.is_none())
                    && f.team_id.is_none_or(|v| i.team_id == v)
                    && f.stage_id.is_none_or(|v| i.stage_id == v)
                    && f.priority.as_ref().is_none_or(|v| i.priority == *v)
                    && f.label_id.is_none_or(|v| i.labels.contains(&v))
                    && f.sprint_id.is_none_or(|v| i.sprint_id == Some(v))
                    && f.project_id.is_none_or(|v| i.project_id == Some(v))
                    && f.due_before
                        .is_none_or(|v| i.deadline.is_some_and(|d| d <= v))
                    && f.search.as_ref().is_none_or(|v| {
                        format!("{} {}", i.title, i.description)
                            .to_lowercase()
                            .contains(&v.to_lowercase())
                    })
            })
            .cloned()
            .collect();

        match f.sort {
            IssueSort::Position => issues.sort_by_key(|i| (i.position, i.number)),
            IssueSort::Deadline => issues.sort_by_key(|i| (i.deadline.is_none(), i.deadline)),
            IssueSort::Updated => issues.sort_by_key(|i| std::cmp::Reverse(i.updated_at)),
            IssueSort::Priority => issues.sort_by_key(|i| {
                std::cmp::Reverse(match i.priority {
                    Priority::None => 0,
                    Priority::Low => 1,
                    Priority::Normal => 2,
                    Priority::High => 3,
                    Priority::Urgent => 4,
                })
            }),
        }

        Ok(issues)
    }

    pub fn report(&self, actor: Uuid) -> Result<Report> {
        self.member(actor)?;

        let mut people = BTreeMap::new();
        let mut teams = BTreeMap::new();
        let mut projects = BTreeMap::new();
        let mut issues = BTreeMap::new();

        for entry in &self.time_entries {
            if let Some(issue) = self.issues.iter().find(|i| i.id == entry.issue_id) {
                add_minutes(&mut people, entry.user_id, entry.minutes);
                add_minutes(&mut teams, issue.team_id, entry.minutes);
                add_minutes(&mut issues, issue.id, entry.minutes);
                if let Some(id) = issue.project_id {
                    add_minutes(&mut projects, id, entry.minutes)
                }
            }
        }

        for issue in self
            .issues
            .iter()
            .filter(|i| i.deleted_at.is_none() && !self.done(i))
        {
            add_work(&mut teams, issue.team_id, issue.estimate);
            add_work(&mut issues, issue.id, issue.estimate);
            if let Some(id) = issue.assignee {
                add_work(&mut people, id, issue.estimate)
            }
            if let Some(id) = issue.project_id {
                add_work(&mut projects, id, issue.estimate)
            }
        }

        let sprints = self
            .sprints
            .iter()
            .map(|s| {
                let rows: Vec<_> = self
                    .issues
                    .iter()
                    .filter(|i| i.sprint_id == Some(s.id) && i.deleted_at.is_none())
                    .collect();
                SprintReport {
                    id: s.id,
                    total: s.outcome.as_ref().map_or(rows.len() as u64, |o| o.total),
                    completed: s.outcome.as_ref().map_or_else(
                        || rows.iter().filter(|i| self.done(i)).count() as u64,
                        |o| o.completed,
                    ),
                    effort: s.outcome.as_ref().map_or_else(
                        || rows.iter().map(|i| i.estimate.unwrap_or(0) as u64).sum(),
                        |o| o.effort,
                    ),
                }
            })
            .collect();

        let mut delivery = BTreeMap::<String, u64>::new();
        for event in self
            .activity
            .iter()
            .filter(|a| a.action == "issue_completed")
        {
            *delivery
                .entry(event.at.date_naive().to_string())
                .or_default() += 1;
        }

        Ok(Report {
            total_minutes: self.time_entries.iter().map(|e| e.minutes as u64).sum(),
            issues: issues.into_values().collect(),
            people: people.into_values().collect(),
            teams: teams.into_values().collect(),
            projects: projects.into_values().collect(),
            sprints,
            delivery: delivery
                .into_iter()
                .map(|(date, completed)| DeliveryDay { date, completed })
                .collect(),
        })
    }
}

fn validate_email(email: &str) -> Result<()> {
    if email.len() > 254
        || email.contains(char::is_whitespace)
        || !email
            .split_once('@')
            .is_some_and(|(a, b)| !a.is_empty() && b.contains('.'))
    {
        Err(Error::BadRequest("invalid email".into()))
    } else {
        Ok(())
    }
}

fn validate_hash(hash: &str) -> Result<()> {
    if hash.len() != 64 || !hash.bytes().all(|b| b.is_ascii_hexdigit()) {
        Err(Error::BadRequest("token hash must be SHA-256 hex".into()))
    } else {
        Ok(())
    }
}

fn validate_url(url: &str) -> Result<()> {
    if url.len() > 2000
        || !(url.starts_with("https://") || url.starts_with("http://"))
        || url.contains(char::is_whitespace)
    {
        Err(Error::BadRequest("HTTP or HTTPS URL required".into()))
    } else {
        Ok(())
    }
}

fn total(map: &mut BTreeMap<Uuid, Total>, id: Uuid) -> &mut Total {
    map.entry(id).or_insert(Total {
        id,
        minutes: 0,
        open_issues: 0,
        effort: 0,
    })
}

fn add_minutes(map: &mut BTreeMap<Uuid, Total>, id: Uuid, minutes: u32) {
    total(map, id).minutes += minutes as u64;
}

fn add_work(map: &mut BTreeMap<Uuid, Total>, id: Uuid, effort: Option<u32>) {
    let t = total(map, id);
    t.open_issues += 1;
    t.effort += effort.unwrap_or(0) as u64;
}

fn changed_fields(before: &Issue, after: &Issue) -> Vec<String> {
    [
        ("title", before.title != after.title),
        ("description", before.description != after.description),
        ("stage", before.stage_id != after.stage_id),
        ("assignee", before.assignee != after.assignee),
        ("priority", before.priority != after.priority),
        ("labels", before.labels != after.labels),
        ("estimate", before.estimate != after.estimate),
        ("deadline", before.deadline != after.deadline),
        ("project", before.project_id != after.project_id),
        ("milestone", before.milestone_id != after.milestone_id),
        ("sprint", before.sprint_id != after.sprint_id),
        ("parent", before.parent_id != after.parent_id),
        ("dependencies", before.dependencies != after.dependencies),
    ]
    .into_iter()
    .filter(|(_, changed)| *changed)
    .map(|(name, _)| name.to_string())
    .collect()
}
