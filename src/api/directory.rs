//! Names for the ids on issues, comments and activity, and the reverse: ids for the
//! names, keys and emails callers send in writes and filters. Loaded once per request.

use super::{Scope, issues};
use crate::{
    domain::{SprintState, StageKind},
    error::{Error, Result},
    store::Store,
};
use chrono::{DateTime, Utc};
use serde::Serialize;
use std::collections::BTreeMap;
use uuid::Uuid;

#[derive(Clone, Debug, Serialize, utoipa::ToSchema)]
pub struct TeamRef {
    pub id: Uuid,
    pub key: String,
    pub name: String,
}

#[derive(Clone, Debug, Serialize, utoipa::ToSchema)]
pub struct StageRef {
    pub id: Uuid,
    pub name: String,
    pub kind: StageKind,
}

#[derive(Clone, Debug, Serialize, utoipa::ToSchema)]
pub struct LabelRef {
    pub id: Uuid,
    pub name: String,
    pub color: String,
}

#[derive(Clone, Debug, Serialize, utoipa::ToSchema)]
pub struct NamedRef {
    pub id: Uuid,
    pub name: String,
}

#[derive(Clone, Debug, Serialize, utoipa::ToSchema)]
pub struct SprintRef {
    pub id: Uuid,
    /// Counts up per team.
    pub number: u64,
    pub name: String,
    pub state: SprintState,
}

#[derive(Clone, Debug, Serialize, utoipa::ToSchema)]
pub struct Person {
    pub id: Uuid,
    pub display_name: String,
    pub email: String,
}

#[derive(Clone, Debug, Serialize, utoipa::ToSchema)]
pub struct IssueRef {
    pub id: Uuid,
    pub key: String,
    pub title: String,
}

pub struct StageRow {
    pub team_id: Uuid,
    pub stage: StageRef,
}

pub struct MilestoneRow {
    pub project_id: Uuid,
    pub milestone: NamedRef,
    pub deadline: Option<DateTime<Utc>>,
}

pub struct SprintRow {
    pub team_id: Uuid,
    pub sprint: SprintRef,
    pub goal: String,
    pub starts_at: DateTime<Utc>,
    pub ends_at: DateTime<Utc>,
}

/// The workspace's teams, stages, labels, projects, milestones, sprints and people.
pub struct Directory {
    pub me: Uuid,
    pub teams: Vec<TeamRef>,
    pub stages: Vec<StageRow>,
    pub labels: Vec<LabelRef>,
    pub projects: Vec<NamedRef>,
    pub milestones: Vec<MilestoneRow>,
    pub sprints: Vec<SprintRow>,
    /// Members, plus former members that `include_people` added.
    pub people: BTreeMap<Uuid, Person>,
    pub members: Vec<Uuid>,
}

fn parse<T: serde::de::DeserializeOwned>(text: String) -> Result<T> {
    Ok(serde_json::from_value(serde_json::Value::String(text))?)
}

impl Directory {
    pub async fn load(store: &Store, scope: Scope) -> Result<Self> {
        let people = Self::people(store, scope).await?;
        let pool = &store.pool;
        let ws = scope.workspace;

        let teams = sqlx::query_as::<_, (Uuid, String, String)>(
            "SELECT id,key,name FROM teams WHERE workspace_id=$1 ORDER BY name,id",
        )
        .bind(ws)
        .fetch_all(pool)
        .await?
        .into_iter()
        .map(|(id, key, name)| TeamRef { id, key, name })
        .collect();

        let stages = sqlx::query_as::<_, (Uuid, Uuid, String, String)>(
            "SELECT team_id,id,name,kind FROM stages WHERE workspace_id=$1 ORDER BY team_id,position,id",
        )
        .bind(ws)
        .fetch_all(pool)
        .await?
        .into_iter()
        .map(|(team_id, id, name, kind)| {
            Ok(StageRow {
                team_id,
                stage: StageRef {
                    id,
                    name,
                    kind: parse(kind)?,
                },
            })
        })
        .collect::<Result<_>>()?;

        let labels = sqlx::query_as::<_, (Uuid, String, String)>(
            "SELECT id,name,color FROM labels WHERE workspace_id=$1 ORDER BY name,id",
        )
        .bind(ws)
        .fetch_all(pool)
        .await?
        .into_iter()
        .map(|(id, name, color)| LabelRef { id, name, color })
        .collect();

        let projects = sqlx::query_as::<_, (Uuid, String)>(
            "SELECT id,name FROM projects WHERE workspace_id=$1 ORDER BY name,id",
        )
        .bind(ws)
        .fetch_all(pool)
        .await?
        .into_iter()
        .map(|(id, name)| NamedRef { id, name })
        .collect();

        let milestones = sqlx::query_as::<_, (Uuid, Uuid, String, Option<DateTime<Utc>>)>(
            "SELECT project_id,id,name,deadline FROM milestones WHERE workspace_id=$1 ORDER BY name,id",
        )
        .bind(ws)
        .fetch_all(pool)
        .await?
        .into_iter()
        .map(|(project_id, id, name, deadline)| MilestoneRow {
            project_id,
            milestone: NamedRef { id, name },
            deadline,
        })
        .collect();

        let sprints = sqlx::query_as::<
            _,
            (
                Uuid,
                Uuid,
                i64,
                String,
                String,
                String,
                DateTime<Utc>,
                DateTime<Utc>,
            ),
        >(
            "SELECT team_id,id,number,name,state,goal,starts_at,ends_at FROM sprints \
             WHERE workspace_id=$1 ORDER BY team_id,starts_at,id",
        )
        .bind(ws)
        .fetch_all(pool)
        .await?
        .into_iter()
        .map(
            |(team_id, id, number, name, state, goal, starts_at, ends_at)| {
                Ok(SprintRow {
                    team_id,
                    sprint: SprintRef {
                        id,
                        number: number.max(0) as u64,
                        name,
                        state: parse(state)?,
                    },
                    goal,
                    starts_at,
                    ends_at,
                })
            },
        )
        .collect::<Result<_>>()?;

        Ok(Self {
            teams,
            stages,
            labels,
            projects,
            milestones,
            sprints,
            ..people
        })
    }

    /// Only the workspace's members, for records that name nothing else.
    pub async fn people(store: &Store, scope: Scope) -> Result<Self> {
        let rows = sqlx::query_as::<_, (Uuid, String, Option<String>)>(
            "SELECT u.id,u.email,u.profile->>'display_name' FROM workspace_members m \
             JOIN users u ON u.id=m.user_id WHERE m.workspace_id=$1 \
             ORDER BY lower(u.profile->>'display_name'),u.id",
        )
        .bind(scope.workspace)
        .fetch_all(&store.pool)
        .await?;
        if !rows.iter().any(|(id, _, _)| *id == scope.user) {
            return Err(Error::Forbidden);
        }
        Ok(Self {
            me: scope.user,
            teams: vec![],
            stages: vec![],
            labels: vec![],
            projects: vec![],
            milestones: vec![],
            sprints: vec![],
            members: rows.iter().map(|(id, _, _)| *id).collect(),
            people: rows
                .into_iter()
                .map(|(id, email, display_name)| (id, person(id, email, display_name)))
                .collect(),
        })
    }

    /// Loads people the records name who have since left the workspace.
    pub async fn include_people(
        &mut self,
        store: &Store,
        ids: impl IntoIterator<Item = Uuid>,
    ) -> Result<()> {
        let mut missing: Vec<Uuid> = ids
            .into_iter()
            .filter(|id| !self.people.contains_key(id))
            .collect();
        missing.sort();
        missing.dedup();
        if missing.is_empty() {
            return Ok(());
        }
        let rows = sqlx::query_as::<_, (Uuid, String, Option<String>)>(
            "SELECT id,email,profile->>'display_name' FROM users WHERE id=ANY($1)",
        )
        .bind(&missing)
        .fetch_all(&store.pool)
        .await?;
        for (id, email, display_name) in rows {
            self.people.insert(id, person(id, email, display_name));
        }
        Ok(())
    }

    pub fn team(&self, id: Uuid) -> TeamRef {
        self.teams
            .iter()
            .find(|t| t.id == id)
            .cloned()
            .unwrap_or_else(|| TeamRef {
                id,
                key: String::new(),
                name: String::new(),
            })
    }

    pub fn stage(&self, id: Uuid) -> Option<StageRef> {
        self.stages
            .iter()
            .find(|s| s.stage.id == id)
            .map(|s| s.stage.clone())
    }

    pub fn label(&self, id: Uuid) -> Option<LabelRef> {
        self.labels.iter().find(|l| l.id == id).cloned()
    }

    pub fn project(&self, id: Uuid) -> Option<NamedRef> {
        self.projects.iter().find(|p| p.id == id).cloned()
    }

    pub fn milestone(&self, id: Uuid) -> Option<NamedRef> {
        self.milestones
            .iter()
            .find(|m| m.milestone.id == id)
            .map(|m| m.milestone.clone())
    }

    pub fn sprint(&self, id: Uuid) -> Option<SprintRef> {
        self.sprints
            .iter()
            .find(|s| s.sprint.id == id)
            .map(|s| s.sprint.clone())
    }

    /// A person by id. Users that no longer exist keep their id and lose their name.
    pub fn person(&self, id: Uuid) -> Person {
        self.people.get(&id).cloned().unwrap_or_else(|| Person {
            id,
            display_name: String::new(),
            email: String::new(),
        })
    }

    pub fn issue_key(&self, team: Uuid, number: u64) -> String {
        format!("{}-{number}", self.team(team).key)
    }

    // Resolving references. Each accepts a UUID as well as the names listed.

    /// A team by UUID, key or name.
    pub fn find_team(&self, reference: &str) -> Result<Uuid> {
        pick(
            "team",
            reference,
            self.teams
                .iter()
                .map(|t| (t.id, vec![t.key.as_str(), t.name.as_str()])),
        )
    }

    /// A stage by UUID or by name within `team`.
    pub fn find_stage(&self, team: Uuid, reference: &str) -> Result<Uuid> {
        pick(
            &format!("stage in team {}", self.team(team).key),
            reference,
            self.stages
                .iter()
                .filter(|s| s.team_id == team)
                .map(|s| (s.stage.id, vec![s.stage.name.as_str()])),
        )
    }

    /// A user by UUID, email, display name, or `me` for the token's user.
    pub fn find_person(&self, reference: &str) -> Result<Uuid> {
        if reference.eq_ignore_ascii_case("me") {
            return Ok(self.me);
        }
        pick(
            "member",
            reference,
            self.members.iter().filter_map(|id| {
                let p = self.people.get(id)?;
                Some((p.id, vec![p.email.as_str(), p.display_name.as_str()]))
            }),
        )
    }

    pub fn find_label(&self, reference: &str) -> Result<Uuid> {
        pick(
            "label",
            reference,
            self.labels.iter().map(|l| (l.id, vec![l.name.as_str()])),
        )
    }

    pub fn find_project(&self, reference: &str) -> Result<Uuid> {
        pick(
            "project",
            reference,
            self.projects.iter().map(|p| (p.id, vec![p.name.as_str()])),
        )
    }

    /// A milestone by UUID or name, within `project` when one is known.
    pub fn find_milestone(&self, project: Option<Uuid>, reference: &str) -> Result<Uuid> {
        pick(
            "milestone",
            reference,
            self.milestones
                .iter()
                .filter(|m| project.is_none_or(|p| m.project_id == p))
                .map(|m| (m.milestone.id, vec![m.milestone.name.as_str()])),
        )
    }

    /// A sprint by UUID, name or number (`12` or `#12`) within `team`.
    pub fn find_sprint(&self, team: Uuid, reference: &str) -> Result<Uuid> {
        pick(
            &format!("sprint in team {}", self.team(team).key),
            reference,
            self.sprints.iter().filter(|s| s.team_id == team).map(|s| {
                let n = s.sprint.number;
                (
                    s.sprint.id,
                    vec![s.sprint.name.clone(), format!("#{n}"), n.to_string()],
                )
            }),
        )
    }

    /// Every id a filter value names. Stage and sprint names may repeat across teams,
    /// and a filter on either matches all of them.
    pub async fn filter_ids(
        &self,
        store: &Store,
        scope: Scope,
        field: crate::domain::FilterField,
        reference: &str,
    ) -> Result<Vec<Uuid>> {
        use crate::domain::FilterField as F;
        if let Ok(id) = Uuid::parse_str(reference) {
            return Ok(vec![id]);
        }
        let all = |kind: &str, ids: Vec<Uuid>, names: Vec<&str>| {
            if ids.is_empty() {
                Err(not_found(kind, reference, names))
            } else {
                Ok(ids)
            }
        };
        match field {
            F::Assignee | F::CreatedBy => Ok(vec![self.find_person(reference)?]),
            F::TeamId => Ok(vec![self.find_team(reference)?]),
            F::Labels => Ok(vec![self.find_label(reference)?]),
            F::ProjectId => Ok(vec![self.find_project(reference)?]),
            F::StageId => all(
                "stage",
                self.stages
                    .iter()
                    .filter(|s| same(&s.stage.name, reference))
                    .map(|s| s.stage.id)
                    .collect(),
                self.stages.iter().map(|s| s.stage.name.as_str()).collect(),
            ),
            F::SprintId => all(
                "sprint",
                self.sprints
                    .iter()
                    .filter(|s| same(&s.sprint.name, reference))
                    .map(|s| s.sprint.id)
                    .collect(),
                self.sprints
                    .iter()
                    .map(|s| s.sprint.name.as_str())
                    .collect(),
            ),
            F::ParentId | F::Dependencies => {
                Ok(vec![issues::resolve(store, scope, reference).await?])
            }
            _ => Err(Error::BadRequest(format!(
                "filter value {reference:?} is not valid for {}",
                field.name()
            ))),
        }
    }

    /// Keys and titles for the issues `ids` name.
    pub async fn issue_refs(
        &self,
        store: &Store,
        scope: Scope,
        ids: impl IntoIterator<Item = Uuid>,
    ) -> Result<BTreeMap<Uuid, IssueRef>> {
        let mut ids: Vec<Uuid> = ids.into_iter().collect();
        ids.sort();
        ids.dedup();
        if ids.is_empty() {
            return Ok(BTreeMap::new());
        }
        Ok(sqlx::query_as::<_, (Uuid, Uuid, i64, String)>(
            "SELECT id,team_id,number,title FROM issues WHERE workspace_id=$1 AND id=ANY($2)",
        )
        .bind(scope.workspace)
        .bind(&ids)
        .fetch_all(&store.pool)
        .await?
        .into_iter()
        .map(|(id, team, number, title)| {
            let key = self.issue_key(team, number.max(0) as u64);
            (id, IssueRef { id, key, title })
        })
        .collect())
    }
}

/// Names compare case-insensitively, including outside ASCII.
fn same(name: &str, reference: &str) -> bool {
    name.trim().to_lowercase() == reference.trim().to_lowercase()
}

fn person(id: Uuid, email: String, display_name: Option<String>) -> Person {
    Person {
        id,
        display_name: display_name.unwrap_or_default(),
        email,
    }
}

/// The one candidate `reference` names, by UUID or case-insensitively by any of its names.
fn pick<S: AsRef<str>>(
    kind: &str,
    reference: &str,
    candidates: impl Iterator<Item = (Uuid, Vec<S>)>,
) -> Result<Uuid> {
    if let Ok(id) = Uuid::parse_str(reference) {
        return Ok(id);
    }
    let reference = reference.trim();
    let candidates: Vec<_> = candidates.collect();
    let mut matches: Vec<Uuid> = candidates
        .iter()
        .filter(|(_, names)| names.iter().any(|n| same(n.as_ref(), reference)))
        .map(|(id, _)| *id)
        .collect();
    matches.dedup();
    match matches.as_slice() {
        [id] => Ok(*id),
        [] => Err(not_found(
            kind,
            reference,
            candidates
                .iter()
                .filter_map(|(_, names)| names.first().map(AsRef::as_ref))
                .collect(),
        )),
        _ => Err(Error::BadRequest(format!(
            "{reference:?} matches more than one {kind}; use its id"
        ))),
    }
}

fn not_found(kind: &str, reference: &str, mut names: Vec<&str>) -> Error {
    names.sort_unstable();
    names.dedup();
    let total = names.len();
    names.truncate(30);
    let more = if total > names.len() { ", …" } else { "" };
    let known = if names.is_empty() {
        format!("there is no {kind}")
    } else {
        format!("known: {}{more}", names.join(", "))
    };
    Error::BadRequest(format!("no {kind} named {reference:?}; {known}"))
}
