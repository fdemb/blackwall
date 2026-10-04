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
        for user in mapping.values() {
            workspace.member(*user)?;
        }
        let mut identities = BTreeMap::new();
        let mut ids = BTreeMap::new();
        for id in self
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
            )
        {
            if ids.insert(id, Uuid::new_v4()).is_some() {
                return Err(Error::BadRequest(
                    "transfer contains duplicate entity IDs".into(),
                ));
            }
        }
        for team in &mut self.teams {
            team.id = entity(&ids, team.id)?;
            team.members = team
                .members
                .iter()
                .filter_map(|u| mapping.get(u).copied())
                .collect::<BTreeSet<_>>()
                .into_iter()
                .collect();
            for stage in &mut team.stages {
                stage.id = entity(&ids, stage.id)?;
            }
        }
        for label in &mut self.labels {
            label.id = entity(&ids, label.id)?;
        }
        for project in &mut self.projects {
            project.id = entity(&ids, project.id)?;
            for id in &mut project.team_ids {
                *id = entity(&ids, *id)?;
            }
        }
        for milestone in &mut self.milestones {
            milestone.id = entity(&ids, milestone.id)?;
            milestone.project_id = entity(&ids, milestone.project_id)?;
        }
        for sprint in &mut self.sprints {
            sprint.id = entity(&ids, sprint.id)?;
            sprint.team_id = entity(&ids, sprint.team_id)?;
        }
        let mut number = workspace.issues.iter().map(|i| i.number).max().unwrap_or(0);
        for issue in &mut self.issues {
            number = number
                .checked_add(1)
                .ok_or(Error::BadRequest("issue number overflow".into()))?;
            issue.number = number;
            issue.id = entity(&ids, issue.id)?;
            issue.team_id = entity(&ids, issue.team_id)?;
            issue.stage_id = entity(&ids, issue.stage_id)?;
            issue.assignee = issue.assignee.and_then(|u| mapping.get(&u).copied());
            for id in &mut issue.labels {
                *id = entity(&ids, *id)?;
            }
            issue.project_id = optional(&ids, issue.project_id)?;
            issue.milestone_id = optional(&ids, issue.milestone_id)?;
            issue.sprint_id = optional(&ids, issue.sprint_id)?;
            issue.parent_id = optional(&ids, issue.parent_id)?;
            for id in &mut issue.dependencies {
                *id = entity(&ids, *id)?;
            }
            issue.followers = issue
                .followers
                .iter()
                .filter_map(|u| mapping.get(u).copied())
                .collect::<BTreeSet<_>>()
                .into_iter()
                .collect();
            issue.attachments.clear();
        }
        for comment in &mut self.comments {
            comment.id = entity(&ids, comment.id)?;
            comment.issue_id = entity(&ids, comment.issue_id)?;
            comment.author = identity(comment.author, actor, mapping, &mut identities);
            comment.mentions = comment
                .mentions
                .iter()
                .filter_map(|u| mapping.get(u).copied())
                .collect();
            comment.attachments.clear();
        }
        for entry in &mut self.time_entries {
            entry.id = entity(&ids, entry.id)?;
            entry.issue_id = entity(&ids, entry.issue_id)?;
            entry.user_id = identity(entry.user_id, actor, mapping, &mut identities);
        }
        for view in &mut self.views {
            view.id = entity(&ids, view.id)?;
            view.owner = identity(view.owner, actor, mapping, &mut identities);
            view.filter.assignee = view.filter.assignee.and_then(|u| mapping.get(&u).copied());
            view.filter.team_id = optional(&ids, view.filter.team_id)?;
            view.filter.stage_id = optional(&ids, view.filter.stage_id)?;
            view.filter.label_id = optional(&ids, view.filter.label_id)?;
            view.filter.sprint_id = optional(&ids, view.filter.sprint_id)?;
            view.filter.project_id = optional(&ids, view.filter.project_id)?;
            view.filter.parent_id = optional(&ids, view.filter.parent_id)?;
            view.filter.dependency_id = optional(&ids, view.filter.dependency_id)?;
            if let Some(filter_ids) = &view.filter.ids {
                let remapped = filter_ids
                    .split(',')
                    .map(|value| {
                        let id = value
                            .parse()
                            .map_err(|_| Error::BadRequest("filter ids must be UUIDs".into()))?;
                        entity(&ids, id).map(|id| id.to_string())
                    })
                    .collect::<Result<Vec<_>>>()?;
                view.filter.ids = Some(remapped.join(","));
            }
        }
        for activity in &mut self.activity {
            activity.id = entity(&ids, activity.id)?;
            activity.actor = identity(activity.actor, actor, mapping, &mut identities);
            activity.entity_id = activity
                .entity_id
                .and_then(|id| ids.get(&id).copied().or_else(|| mapping.get(&id).copied()));
        }
        let summary = ImportSummary {
            issues: self.issues.len(),
            comments: self.comments.len(),
            time_entries: self.time_entries.len(),
            identities: identities.into_values().collect(),
        };
        let mut candidate = workspace.clone();
        candidate.teams.extend(self.teams);
        candidate.labels.extend(self.labels);
        candidate.projects.extend(self.projects);
        candidate.milestones.extend(self.milestones);
        candidate.sprints.extend(self.sprints);
        candidate.issues.extend(self.issues);
        candidate.comments.extend(self.comments);
        candidate.time_entries.extend(self.time_entries);
        candidate.views.extend(self.views);
        candidate.activity.extend(self.activity);
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
}
fn entity(ids: &BTreeMap<Uuid, Uuid>, id: Uuid) -> Result<Uuid> {
    ids.get(&id).copied().ok_or(Error::BadRequest(
        "transfer references an entity it does not contain".into(),
    ))
}
fn optional(ids: &BTreeMap<Uuid, Uuid>, id: Option<Uuid>) -> Result<Option<Uuid>> {
    id.map(|id| entity(ids, id)).transpose()
}
fn identity(
    source: Uuid,
    actor: Uuid,
    mapping: &BTreeMap<Uuid, Uuid>,
    identities: &mut BTreeMap<Uuid, IdentityRemap>,
) -> Uuid {
    let target = mapping.get(&source).copied().unwrap_or(actor);
    identities.entry(source).or_insert(IdentityRemap {
        source,
        target,
        fallback: !mapping.contains_key(&source),
    });
    target
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
                    name: "Infra".into(),
                    members: vec![source_user],
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
    fn invalid_transfer_is_atomic_and_unknown_authors_report_fallback() {
        let actor = Uuid::new_v4();
        let mut source = Workspace::new("Source".into(), actor).unwrap();
        let now = Utc::now();
        source
            .apply(
                actor,
                Command::CreateTeam {
                    name: "Team".into(),
                    members: vec![],
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
