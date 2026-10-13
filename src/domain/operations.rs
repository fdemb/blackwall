use super::*;
use std::collections::{BTreeMap, BTreeSet};

mod discussion;
mod issues;
mod planning;

/// The first item matching `matches`, or `NotFound`.
fn find_mut<T>(items: &mut [T], matches: impl Fn(&T) -> bool) -> Result<&mut T> {
    items
        .iter_mut()
        .find(|item| matches(item))
        .ok_or(Error::NotFound)
}

impl Workspace {
    /// A client-chosen id is taken when any collection already uses it.
    /// Source links carry no id in the model and OpenProject connections are
    /// not modeled; both are still covered by the SQL check.
    fn id_taken(&self, id: Uuid) -> bool {
        self.id == id
            || self.members.iter().any(|m| m.user_id == id)
            || self.teams.iter().any(|t| t.id == id)
            || self
                .teams
                .iter()
                .flat_map(|t| &t.stages)
                .any(|s| s.id == id)
            || self.labels.iter().any(|l| l.id == id)
            || self.projects.iter().any(|p| p.id == id)
            || self.milestones.iter().any(|m| m.id == id)
            || self.sprints.iter().any(|s| s.id == id)
            || self
                .issues
                .iter()
                .any(|i| i.id == id || i.attachments.iter().any(|a| a.id == id))
            || self
                .comments
                .iter()
                .any(|c| c.id == id || c.attachments.iter().any(|a| a.id == id))
            || self.time_entries.iter().any(|e| e.id == id)
            || self.views.iter().any(|v| v.id == id)
            || self.invitations.iter().any(|i| i.id == id)
            || self.integrations.iter().any(|i| i.id == id)
            || self.notifications.iter().any(|n| n.id == id)
            || self.activity.iter().any(|a| a.id == id)
    }

    /// Resolve a client-chosen id, rejecting one used by any collection.
    fn take_client_id(&self, provided: Option<Uuid>) -> Result<Uuid> {
        let id = client_id(provided)?;
        if self.id_taken(id) {
            return Err(Error::Conflict("id already exists".into()));
        }
        Ok(id)
    }
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

    /// Done-only check for archiving. Cancelled is excluded per product decision.
    fn archivable_done(&self, i: &Issue) -> bool {
        self.teams
            .iter()
            .flat_map(|t| &t.stages)
            .any(|s| s.id == i.stage_id && matches!(s.kind, StageKind::Done))
    }

    fn refresh_done_at(&self, issue: &mut Issue, now: DateTime<Utc>) {
        if self.archivable_done(issue) {
            if issue.done_at.is_none() {
                issue.done_at = Some(now);
            }
        } else {
            issue.done_at = None;
        }
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
        optional_timestamp(issue.deadline)?;
        if issue.description.len() > 100_000 {
            return Err(Error::BadRequest("description too long".into()));
        }

        let stage = self
            .team(issue.team_id)?
            .stages
            .iter()
            .find(|s| s.id == issue.stage_id)
            .ok_or(Error::BadRequest("stage belongs to another team".into()))?;

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
        self.validate_issue_project(issue)?;
        self.validate_issue_sprint(issue)?;

        let starting =
            issue.deleted_at.is_none() && matches!(stage.kind, StageKind::Active | StageKind::Done);
        for dep in &issue.dependencies {
            let dependency = self.issue(*dep)?;
            if starting && !self.done(dependency) {
                return Err(Error::Conflict("issue has unfinished dependencies".into()));
            }
        }
        if let Some(parent) = issue.parent_id {
            self.issue(parent)?;
        }

        self.check_relation_cycle(issue, issue.parent_id.into_iter().collect(), |i| {
            i.parent_id.into_iter().collect()
        })?;
        self.check_relation_cycle(issue, issue.dependencies.clone(), |i| {
            i.dependencies.clone()
        })
    }

    fn validate_issue_project(&self, issue: &Issue) -> Result<()> {
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
        Ok(())
    }

    /// A finished sprint only keeps issues that were already in it and are done.
    fn validate_issue_sprint(&self, issue: &Issue) -> Result<()> {
        let Some(id) = issue.sprint_id else {
            return Ok(());
        };
        let sprint = self
            .sprints
            .iter()
            .find(|s| s.id == id)
            .ok_or(Error::NotFound)?;
        let retained = || {
            self.issues
                .iter()
                .any(|old| old.id == issue.id && old.sprint_id == Some(id))
                && self.done(issue)
        };
        if sprint.team_id != issue.team_id || (sprint.state.is_finished() && !retained()) {
            return Err(Error::BadRequest(
                "sprint is unavailable for this team".into(),
            ));
        }
        Ok(())
    }

    /// Walks one relation (parents or dependencies) from `start` and rejects
    /// a path back to `issue`.
    fn check_relation_cycle(
        &self,
        issue: &Issue,
        start: Vec<Uuid>,
        next: impl Fn(&Issue) -> Vec<Uuid>,
    ) -> Result<()> {
        let mut todo = start;
        let mut seen = BTreeSet::new();
        while let Some(id) = todo.pop() {
            if id == issue.id {
                return Err(Error::BadRequest("issue relations contain a cycle".into()));
            }
            if seen.insert(id) {
                todo.extend(next(self.issue(id)?));
            }
        }
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
        self.validate_imported_planning()?;
        self.validate_imported_issues()?;
        self.check_workflow()?;
        self.validate_imported_records()
    }

    fn validate_imported_planning(&self) -> Result<()> {
        let mut keys = BTreeSet::new();
        for team in &self.teams {
            text(&team.name, 200)?;
            super::validate_team_key(&team.key)?;
            if !keys.insert(team.key.as_str()) {
                return Err(Error::BadRequest("team keys must be unique".into()));
            }
            super::validate_archive_days(team.archive_after_days)?;
            super::validate_team_appearance(&team.icon, &team.color)?;
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
            optional_timestamp(milestone.deadline)?;
            if !self.projects.iter().any(|p| p.id == milestone.project_id) {
                return Err(Error::BadRequest("unknown milestone project".into()));
            }
        }

        for sprint in &self.sprints {
            self.team(sprint.team_id)?;
            text(&sprint.name, 200)?;
            timestamp(sprint.starts_at)?;
            timestamp(sprint.ends_at)?;
            if sprint.ends_at <= sprint.starts_at || sprint.goal.len() > 100000 {
                return Err(Error::BadRequest("invalid sprint".into()));
            }
        }

        Ok(())
    }

    /// Issues are checked against a copy with every sprint planned and every
    /// issue live, so trashed issues and finished sprints still validate.
    fn validate_imported_issues(&self) -> Result<()> {
        let mut check = self.clone();
        for sprint in &mut check.sprints {
            sprint.state = SprintState::Planned;
        }
        for issue in &mut check.issues {
            issue.deleted_at = None;
        }

        for issue in &self.issues {
            check.validate_issue(issue)?;
            optional_timestamp(issue.deleted_at)?;
            optional_timestamp(issue.archived_at)?;
            optional_timestamp(issue.done_at)?;
            timestamp(issue.created_at)?;
            timestamp(issue.updated_at)?;
            if issue.archived_at.is_some() && !check.archivable_done(issue) {
                return Err(Error::BadRequest(
                    "only issues in a Done stage can be archived".into(),
                ));
            }
            for user in &issue.followers {
                check.member(*user)?;
            }
            for link in &issue.source_links {
                validate_url(&link.url)?;
                text(&link.title, 500)?;
            }
        }

        let mut numbers = BTreeSet::new();
        if self
            .issues
            .iter()
            .any(|i| i.number == 0 || !numbers.insert((i.team_id, i.number)))
        {
            return Err(Error::BadRequest(
                "issue numbers must be positive and unique per team".into(),
            ));
        }

        Ok(())
    }

    fn validate_imported_records(&self) -> Result<()> {
        for comment in &self.comments {
            text(&comment.body, 100000)?;
            timestamp(comment.created_at)?;
            optional_timestamp(comment.edited_at)?;
            if !self.issues.iter().any(|i| i.id == comment.issue_id) {
                return Err(Error::BadRequest("unknown comment issue".into()));
            }
        }

        for entry in &self.time_entries {
            discussion::validate_time(entry.minutes, &entry.note)?;
            timestamp(entry.logged_at)?;
            if !self.issues.iter().any(|i| i.id == entry.issue_id) {
                return Err(Error::BadRequest("unknown time entry issue".into()));
            }
        }

        for event in &self.activity {
            timestamp(event.at)?;
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
        if self.member(actor)?.role == Role::Viewer && !command.is_personal() {
            return Err(Error::Forbidden);
        }

        let action = command.kind().to_string();
        let mut fields = vec![];
        let result = match command.family() {
            CommandFamily::Planning => Some(self.apply_planning(actor, command, now)?),
            CommandFamily::Issues => self.apply_issue(actor, command, now, &mut fields)?,
            CommandFamily::Discussion => self.apply_discussion(actor, command, now)?,
        };

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

    pub fn query(&self, actor: Uuid, f: IssueFilter) -> Result<Vec<Issue>> {
        self.member(actor)?;
        let clauses = f.compile(Utc::now())?;
        let kind_of = |stage: Uuid| {
            self.teams
                .iter()
                .flat_map(|t| &t.stages)
                .find(|s| s.id == stage)
                .map(|s| s.kind.clone())
        };

        let mut issues: Vec<_> = self
            .issues
            .iter()
            .filter(|i| matches_filter(&f, i) && clauses.iter().all(|c| c.matches(i, kind_of)))
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

fn matches_filter(f: &IssueFilter, i: &Issue) -> bool {
    let lifecycle =
        i.deleted_at.is_some() == f.trash && (f.trash || i.archived_at.is_some() == f.archived);
    let search = |v: &String| {
        format!("{} {}", i.title, i.description)
            .to_lowercase()
            .contains(&v.to_lowercase())
    };
    lifecycle && f.search.as_ref().is_none_or(search)
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
