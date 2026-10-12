use crate::{
    domain::*,
    error::{Error, Result},
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use utoipa::ToSchema;
use uuid::Uuid;

#[derive(Clone, Debug, Serialize, Deserialize, ToSchema)]
pub struct TransferMember {
    pub id: Uuid,
    pub email: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, ToSchema)]
pub struct Transfer {
    pub version: u32,
    pub members: Vec<TransferMember>,
    pub teams: Vec<Team>,
    pub labels: Vec<Label>,
    pub projects: Vec<Project>,
    pub milestones: Vec<Milestone>,
    pub sprints: Vec<Sprint>,
    pub issues: Vec<Issue>,
    pub comments: Vec<Comment>,
    pub time_entries: Vec<TimeEntry>,
    pub views: Vec<SavedView>,
    pub activity: Vec<Activity>,
}

#[derive(Clone, Debug, Serialize, Deserialize, ToSchema)]
pub struct IdentityRemap {
    pub source: Uuid,
    pub target: Uuid,
    pub fallback: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, ToSchema)]
pub struct ImportSummary {
    pub issues: usize,
    pub comments: usize,
    pub time_entries: usize,
    pub identities: Vec<IdentityRemap>,
}

impl Transfer {
    pub fn export(workspace: &Workspace, members: Vec<TransferMember>) -> Self {
        let mut issues = workspace.issues.clone();
        for issue in &mut issues {
            issue.attachments.clear();
        }

        let mut comments = workspace.comments.clone();
        for comment in &mut comments {
            comment.attachments.clear();
        }

        Self {
            version: 1,
            members,
            teams: workspace.teams.clone(),
            labels: workspace.labels.clone(),
            projects: workspace.projects.clone(),
            milestones: workspace.milestones.clone(),
            sprints: workspace.sprints.clone(),
            issues,
            comments,
            time_entries: workspace.time_entries.clone(),
            views: workspace.views.clone(),
            activity: workspace.activity.clone(),
        }
    }

    pub fn import(
        mut self,
        workspace: &mut Workspace,
        actor: Uuid,
        mapping: &BTreeMap<Uuid, Uuid>,
        now: DateTime<Utc>,
    ) -> Result<ImportSummary> {
        if !matches!(workspace.member(actor)?.role, Role::Owner | Role::Admin) {
            return Err(Error::Forbidden);
        }
        if self.version != 1 {
            return Err(Error::BadRequest("unsupported transfer version".into()));
        }
        self.check_limits()?;
        for user in mapping.values() {
            workspace.member(*user)?;
        }

        let mut remap = Remap {
            ids: self.fresh_ids()?,
            mapping,
            actor,
            identities: BTreeMap::new(),
        };
        self.remap_planning(&remap)?;
        let last_number = workspace.issues.iter().map(|i| i.number).max().unwrap_or(0);
        self.remap_issues(&remap, last_number)?;
        self.remap_records(&mut remap)?;

        let summary = ImportSummary {
            issues: self.issues.len(),
            comments: self.comments.len(),
            time_entries: self.time_entries.len(),
            identities: remap.identities.into_values().collect(),
        };

        let mut candidate = workspace.clone();
        self.merge_into(&mut candidate);
        candidate.activity.push(Activity {
            id: Uuid::new_v4(),
            actor,
            action: "workspace_imported".into(),
            entity_id: None,
            at: now,
            fields: vec![],
        });

        candidate.validate_imported()?;
        *workspace = candidate;

        Ok(summary)
    }

    fn check_limits(&self) -> Result<()> {
        if self.issues.len() > 5000
            || self.comments.len() > 20000
            || self.time_entries.len() > 20000
            || self.activity.len() > 50000
            || self.teams.len() > 200
            || self.members.len() > 2000
            || self.labels.len() > 1000
            || self.projects.len() > 1000
            || self.sprints.len() > 2000
            || self.milestones.len() > 5000
            || self.views.len() > 5000
        {
            return Err(Error::BadRequest("transfer exceeds import limits".into()));
        }
        Ok(())
    }

    /// A fresh id for every entity in the transfer, so imports never collide.
    fn fresh_ids(&self) -> Result<BTreeMap<Uuid, Uuid>> {
        let mut ids = BTreeMap::new();
        let all = self
            .teams
            .iter()
            .map(|v| v.id)
            .chain(self.labels.iter().map(|v| v.id))
            .chain(self.projects.iter().map(|v| v.id))
            .chain(self.milestones.iter().map(|v| v.id))
            .chain(self.sprints.iter().map(|v| v.id))
            .chain(self.issues.iter().map(|v| v.id))
            .chain(self.comments.iter().map(|v| v.id))
            .chain(self.time_entries.iter().map(|v| v.id))
            .chain(self.views.iter().map(|v| v.id))
            .chain(self.activity.iter().map(|v| v.id))
            .chain(
                self.teams
                    .iter()
                    .flat_map(|v| v.stages.iter().map(|s| s.id)),
            );
        for id in all {
            if ids.insert(id, Uuid::new_v4()).is_some() {
                return Err(Error::BadRequest(
                    "transfer contains duplicate entity IDs".into(),
                ));
            }
        }
        Ok(ids)
    }

    fn remap_planning(&mut self, remap: &Remap) -> Result<()> {
        for team in &mut self.teams {
            team.id = remap.entity(team.id)?;
            team.members = remap.users(&team.members);
            for stage in &mut team.stages {
                stage.id = remap.entity(stage.id)?;
            }
        }
        for label in &mut self.labels {
            label.id = remap.entity(label.id)?;
        }
        for project in &mut self.projects {
            project.id = remap.entity(project.id)?;
            for id in &mut project.team_ids {
                *id = remap.entity(*id)?;
            }
        }
        for milestone in &mut self.milestones {
            milestone.id = remap.entity(milestone.id)?;
            milestone.project_id = remap.entity(milestone.project_id)?;
        }
        for sprint in &mut self.sprints {
            sprint.id = remap.entity(sprint.id)?;
            sprint.team_id = remap.entity(sprint.team_id)?;
        }
        Ok(())
    }

    /// Remaps issue references and numbers the issues after `last_number`.
    fn remap_issues(&mut self, remap: &Remap, mut last_number: u64) -> Result<()> {
        for issue in &mut self.issues {
            last_number = last_number
                .checked_add(1)
                .ok_or(Error::BadRequest("issue number overflow".into()))?;
            issue.number = last_number;

            issue.id = remap.entity(issue.id)?;
            issue.team_id = remap.entity(issue.team_id)?;
            issue.stage_id = remap.entity(issue.stage_id)?;
            issue.assignee = remap.user(issue.assignee);
            issue.created_by = remap.user(issue.created_by);
            for id in &mut issue.labels {
                *id = remap.entity(*id)?;
            }
            issue.project_id = remap.optional(issue.project_id)?;
            issue.milestone_id = remap.optional(issue.milestone_id)?;
            issue.sprint_id = remap.optional(issue.sprint_id)?;
            issue.parent_id = remap.optional(issue.parent_id)?;
            for id in &mut issue.dependencies {
                *id = remap.entity(*id)?;
            }
            issue.followers = remap.users(&issue.followers);
            issue.attachments.clear();
        }
        Ok(())
    }

    /// Comments, time entries, views and activity. Their authors fall back to
    /// the importing actor when unmapped.
    fn remap_records(&mut self, remap: &mut Remap) -> Result<()> {
        for comment in &mut self.comments {
            comment.id = remap.entity(comment.id)?;
            comment.issue_id = remap.entity(comment.issue_id)?;
            comment.author = remap.identity(comment.author);
            comment.mentions = comment
                .mentions
                .iter()
                .filter_map(|u| remap.mapping.get(u).copied())
                .collect();
            comment.attachments.clear();
        }
        for entry in &mut self.time_entries {
            entry.id = remap.entity(entry.id)?;
            entry.issue_id = remap.entity(entry.issue_id)?;
            entry.user_id = remap.identity(entry.user_id);
        }
        for view in &mut self.views {
            view.id = remap.entity(view.id)?;
            view.owner = remap.identity(view.owner);
            remap.filter(&mut view.filter)?;
        }
        for activity in &mut self.activity {
            activity.id = remap.entity(activity.id)?;
            activity.actor = remap.identity(activity.actor);
            activity.entity_id = activity.entity_id.and_then(|id| {
                remap
                    .ids
                    .get(&id)
                    .copied()
                    .or_else(|| remap.mapping.get(&id).copied())
            });
        }
        Ok(())
    }

    fn merge_into(self, workspace: &mut Workspace) {
        workspace.teams.extend(self.teams);
        workspace.labels.extend(self.labels);
        workspace.projects.extend(self.projects);
        workspace.milestones.extend(self.milestones);
        workspace.sprints.extend(self.sprints);
        workspace.issues.extend(self.issues);
        workspace.comments.extend(self.comments);
        workspace.time_entries.extend(self.time_entries);
        workspace.views.extend(self.views);
        workspace.activity.extend(self.activity);
    }
}

/// Translates transfer ids to fresh ids and source users to workspace members.
struct Remap<'a> {
    ids: BTreeMap<Uuid, Uuid>,
    mapping: &'a BTreeMap<Uuid, Uuid>,
    actor: Uuid,
    identities: BTreeMap<Uuid, IdentityRemap>,
}

impl Remap<'_> {
    fn entity(&self, id: Uuid) -> Result<Uuid> {
        self.ids.get(&id).copied().ok_or(Error::BadRequest(
            "transfer references an entity it does not contain".into(),
        ))
    }

    fn optional(&self, id: Option<Uuid>) -> Result<Option<Uuid>> {
        id.map(|id| self.entity(id)).transpose()
    }

    /// The mapped member, or none when the source user has no mapping.
    fn user(&self, user: Option<Uuid>) -> Option<Uuid> {
        user.and_then(|u| self.mapping.get(&u).copied())
    }

    /// Mapped members, sorted and deduplicated; unmapped users drop out.
    fn users(&self, users: &[Uuid]) -> Vec<Uuid> {
        users
            .iter()
            .filter_map(|u| self.mapping.get(u).copied())
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect()
    }

    /// The mapped member, or the importing actor; records each decision once.
    fn identity(&mut self, source: Uuid) -> Uuid {
        let target = self.mapping.get(&source).copied().unwrap_or(self.actor);
        self.identities.entry(source).or_insert(IdentityRemap {
            source,
            target,
            fallback: !self.mapping.contains_key(&source),
        });
        target
    }

    /// Remaps the ids a view filter names. Unmapped users drop out of their clause, and a clause
    /// left without values drops out of the filter.
    fn filter(&self, filter: &mut IssueFilter) -> Result<()> {
        let mut clauses = Vec::with_capacity(filter.clauses.len());
        for mut clause in filter.clauses.drain(..) {
            let users = matches!(clause.field, FilterField::Assignee | FilterField::CreatedBy);
            let entities = matches!(
                clause.field,
                FilterField::TeamId
                    | FilterField::StageId
                    | FilterField::Labels
                    | FilterField::ProjectId
                    | FilterField::SprintId
                    | FilterField::ParentId
                    | FilterField::Dependencies
            );
            if users || entities {
                let mut values = Vec::with_capacity(clause.values.len());
                for value in &clause.values {
                    let Some(text) = value else {
                        values.push(None);
                        continue;
                    };
                    let id: Uuid = text
                        .parse()
                        .map_err(|_| Error::BadRequest("filter values must be UUIDs".into()))?;
                    let mapped = if users {
                        self.user(Some(id))
                    } else {
                        Some(self.entity(id)?)
                    };
                    if let Some(mapped) = mapped {
                        values.push(Some(mapped.to_string()));
                    }
                }
                if values.is_empty() {
                    continue;
                }
                clause.values = values;
            }
            clauses.push(clause);
        }
        filter.clauses = clauses;
        if let Some(ids) = &filter.ids {
            let remapped = ids
                .split(',')
                .map(|value| {
                    let id = value
                        .parse()
                        .map_err(|_| Error::BadRequest("filter ids must be UUIDs".into()))?;
                    self.entity(id).map(|id| id.to_string())
                })
                .collect::<Result<Vec<_>>>()?;
            filter.ids = Some(remapped.join(","));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_remaps_relations_and_preserves_sprint_history() {
        let now = Utc::now();
        let source_user = Uuid::new_v4();
        let target_user = Uuid::new_v4();
        let mut source = Workspace::new("Source".into(), source_user).unwrap();

        let team = source
            .apply(
                source_user,
                Command::CreateTeam {
                    id: None,
                    name: "Infra".into(),
                    members: vec![source_user],
                    default_stage_ids: None,
                },
                now,
            )
            .unwrap()
            .id
            .unwrap();

        let sprint = source
            .apply(
                source_user,
                Command::CreateSprint {
                    id: None,
                    team_id: team,
                    name: "September".into(),
                    goal: "Deliver".into(),
                    starts_at: now,
                    ends_at: now + chrono::Duration::days(14),
                },
                now,
            )
            .unwrap()
            .id
            .unwrap();

        let input = |title: &str| IssueInput {
            id: None,
            title: title.into(),
            description: "Description".into(),
            team_id: team,
            stage_id: Some(source.teams[0].stages[3].id),
            assignee: Some(source_user),
            priority: Priority::High,
            labels: vec![],
            estimate: Some(5),
            deadline: None,
            project_id: None,
            milestone_id: None,
            sprint_id: Some(sprint),
            parent_id: None,
            dependencies: vec![],
        };
        let first_input = input("First");
        let mut second_input = input("Second");

        let first = source
            .apply(
                source_user,
                Command::CreateIssue { input: first_input },
                now,
            )
            .unwrap()
            .id
            .unwrap();

        second_input.dependencies = vec![first];
        second_input.parent_id = Some(first);
        let second = source
            .apply(
                source_user,
                Command::CreateIssue {
                    input: second_input,
                },
                now,
            )
            .unwrap()
            .id
            .unwrap();

        source
            .apply(
                source_user,
                Command::AddComment {
                    id: None,
                    issue_id: second,
                    body: "Done".into(),
                    mentions: vec![source_user],
                    attachments: vec![],
                },
                now,
            )
            .unwrap();

        source
            .apply(
                source_user,
                Command::LogTime {
                    id: None,
                    issue_id: second,
                    minutes: 45,
                    note: "Review".into(),
                    logged_at: now,
                },
                now,
            )
            .unwrap();

        source
            .apply(
                source_user,
                Command::CompleteSprint {
                    id: sprint,
                    carryover_sprint_id: None,
                },
                now,
            )
            .unwrap();
        source
            .apply(source_user, Command::ArchiveSprint { id: sprint }, now)
            .unwrap();

        let transfer = Transfer::export(
            &source,
            vec![TransferMember {
                id: source_user,
                email: "filip@example.com".into(),
            }],
        );
        let wire = serde_json::to_string(&transfer).unwrap();
        let transfer: Transfer = serde_json::from_str(&wire).unwrap();

        let mut target = Workspace::new("Target".into(), target_user).unwrap();
        let mapping = BTreeMap::from([(source_user, target_user)]);
        let summary = transfer
            .import(&mut target, target_user, &mapping, now)
            .unwrap();

        assert_eq!(summary.issues, 2);
        assert_eq!(target.issues[1].parent_id, Some(target.issues[0].id));
        assert_eq!(target.issues[1].dependencies, vec![target.issues[0].id]);
        assert_ne!(target.issues[0].id, first);
        assert_ne!(target.teams[0].id, team);
        assert_eq!(target.comments[0].issue_id, target.issues[1].id);
        assert_eq!(target.comments[0].author, target_user);
        assert_eq!(target.time_entries[0].user_id, target_user);
        assert_eq!(target.report(target_user).unwrap().total_minutes, 45);
        assert_eq!(target.sprints[0].state, SprintState::Archived);
        assert_eq!(target.report(target_user).unwrap().sprints[0].total, 2);
        assert_eq!(target.report(target_user).unwrap().delivery[0].completed, 2);
    }

    #[test]
    fn import_rejects_timestamps_outside_years_1_to_9999() {
        use chrono::NaiveDate;

        fn utc(year: i32, month: u32, day: u32) -> DateTime<Utc> {
            DateTime::from_naive_utc_and_offset(
                NaiveDate::from_ymd_opt(year, month, day)
                    .unwrap()
                    .and_hms_opt(0, 0, 0)
                    .unwrap(),
                Utc,
            )
        }

        let now = Utc::now();
        let source_user = Uuid::new_v4();
        let mut source = Workspace::new("Source".into(), source_user).unwrap();
        let team = source
            .apply(
                source_user,
                Command::CreateTeam {
                    id: None,
                    name: "Infra".into(),
                    members: vec![source_user],
                    default_stage_ids: None,
                },
                now,
            )
            .unwrap()
            .id
            .unwrap();
        source
            .apply(
                source_user,
                Command::CreateIssue {
                    input: IssueInput {
                        id: None,
                        title: "Timed".into(),
                        description: String::new(),
                        team_id: team,
                        stage_id: None,
                        assignee: None,
                        priority: Priority::Normal,
                        labels: vec![],
                        estimate: None,
                        deadline: None,
                        project_id: None,
                        milestone_id: None,
                        sprint_id: None,
                        parent_id: None,
                        dependencies: vec![],
                    },
                },
                now,
            )
            .unwrap();

        let target_user = Uuid::new_v4();
        let fresh_target = || Workspace::new("Target".into(), target_user).unwrap();

        // Year 10000 in UTC cannot be ingested back by the sync client.
        let mut late = Transfer::export(&source, vec![]);
        late.issues[0].deadline = Some(utc(10000, 1, 1));
        assert!(matches!(
            late.import(&mut fresh_target(), target_user, &BTreeMap::new(), now),
            Err(Error::BadRequest(_))
        ));

        // Year 0 in UTC is rejected too.
        let mut early = Transfer::export(&source, vec![]);
        early.issues[0].deadline = Some(utc(0, 12, 31));
        assert!(matches!(
            early.import(&mut fresh_target(), target_user, &BTreeMap::new(), now),
            Err(Error::BadRequest(_))
        ));

        // The largest valid UTC instant imports fine.
        let mut valid = Transfer::export(&source, vec![]);
        valid.issues[0].deadline = Some(utc(9999, 12, 31));
        valid
            .import(&mut fresh_target(), target_user, &BTreeMap::new(), now)
            .unwrap();
    }

    #[test]
    fn invalid_transfer_is_atomic_and_unknown_authors_report_fallback() {
        let actor = Uuid::new_v4();
        let mut source = Workspace::new("Source".into(), actor).unwrap();
        let now = Utc::now();

        source
            .apply(
                actor,
                Command::CreateTeam {
                    id: None,
                    name: "Team".into(),
                    members: vec![],
                    default_stage_ids: None,
                },
                now,
            )
            .unwrap();

        let transfer = Transfer::export(&source, vec![]);
        let mut invalid = transfer.clone();
        invalid.teams[0].stages[0].name = String::new();

        let target_actor = Uuid::new_v4();
        let mut target = Workspace::new("Target".into(), target_actor).unwrap();
        let before = serde_json::to_string(&target).unwrap();

        assert!(
            invalid
                .import(&mut target, target_actor, &BTreeMap::new(), now)
                .is_err()
        );
        assert_eq!(before, serde_json::to_string(&target).unwrap());

        let summary = transfer
            .import(&mut target, target_actor, &BTreeMap::new(), now)
            .unwrap();

        assert!(
            summary
                .identities
                .iter()
                .any(|identity| identity.source == actor
                    && identity.target == target_actor
                    && identity.fallback)
        );
    }
}
