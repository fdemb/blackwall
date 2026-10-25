use crate::error::{Error, Result};
use serde::Serialize;

/// A kind of record a workspace can hold only so many of.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum Resource {
    Issues,
    Comments,
    TimeEntries,
    Teams,
    Projects,
    Labels,
    Milestones,
    Sprints,
    SavedViews,
    Invitations,
    Integrations,
}

struct Spec {
    table: &'static str,
    noun: &'static str,
    env: &'static str,
    default: u32,
}

impl Resource {
    pub const ALL: [Resource; 11] = [
        Resource::Issues,
        Resource::Comments,
        Resource::TimeEntries,
        Resource::Teams,
        Resource::Projects,
        Resource::Labels,
        Resource::Milestones,
        Resource::Sprints,
        Resource::SavedViews,
        Resource::Invitations,
        Resource::Integrations,
    ];

    const fn spec(self) -> Spec {
        let (table, noun, env, default) = match self {
            Resource::Issues => ("issues", "issues", "WORKSPACE_LIMIT_ISSUES", 50_000),
            Resource::Comments => ("comments", "comments", "WORKSPACE_LIMIT_COMMENTS", 250_000),
            Resource::TimeEntries => (
                "time_entries",
                "time entries",
                "WORKSPACE_LIMIT_TIME_ENTRIES",
                250_000,
            ),
            Resource::Teams => ("teams", "teams", "WORKSPACE_LIMIT_TEAMS", 500),
            Resource::Projects => ("projects", "projects", "WORKSPACE_LIMIT_PROJECTS", 5_000),
            Resource::Labels => ("labels", "labels", "WORKSPACE_LIMIT_LABELS", 1_000),
            Resource::Milestones => (
                "milestones",
                "milestones",
                "WORKSPACE_LIMIT_MILESTONES",
                5_000,
            ),
            Resource::Sprints => ("sprints", "sprints", "WORKSPACE_LIMIT_SPRINTS", 2_000),
            Resource::SavedViews => (
                "saved_views",
                "saved views",
                "WORKSPACE_LIMIT_SAVED_VIEWS",
                5_000,
            ),
            Resource::Invitations => (
                "invitations",
                "invitations",
                "WORKSPACE_LIMIT_INVITATIONS",
                5_000,
            ),
            Resource::Integrations => (
                "integrations",
                "integrations",
                "WORKSPACE_LIMIT_INTEGRATIONS",
                100,
            ),
        };
        Spec {
            table,
            noun,
            env,
            default,
        }
    }

    pub fn table(self) -> &'static str {
        self.spec().table
    }

    pub fn env(self) -> &'static str {
        self.spec().env
    }

    /// The error for a workspace that already holds `limit` of this resource.
    pub fn reached(self, limit: u32) -> Error {
        let spec = self.spec();
        Error::BadRequest(format!(
            "This workspace has reached its limit of {limit} {}. A server administrator can raise it with {}.",
            spec.noun, spec.env
        ))
    }
}

/// How many of one resource a workspace holds, against its limit.
#[derive(Debug, Serialize, utoipa::ToSchema)]
pub struct Usage {
    pub resource: Resource,
    pub used: i64,
    /// None when the resource is unlimited.
    pub limit: Option<u32>,
}

/// How many of each resource one workspace may hold; `None` means no limit.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Limits([Option<u32>; Resource::ALL.len()]);

impl Default for Limits {
    fn default() -> Self {
        Self(Resource::ALL.map(|r| Some(r.spec().default)))
    }
}

impl Limits {
    /// Reads `WORKSPACE_LIMIT_*`: a positive integer, or `unlimited`.
    pub fn from_env() -> Result<Self> {
        let mut limits = Self::default();
        for resource in Resource::ALL {
            match std::env::var(resource.env()) {
                Ok(value) => limits = limits.with(resource, parse(resource.env(), &value)?),
                Err(std::env::VarError::NotPresent) => {}
                Err(_) => {
                    return Err(Error::BadRequest(format!(
                        "{} must be valid text",
                        resource.env()
                    )));
                }
            }
        }
        Ok(limits)
    }

    pub fn with(mut self, resource: Resource, limit: Option<u32>) -> Self {
        self.0[resource as usize] = limit;
        self
    }

    pub fn get(&self, resource: Resource) -> Option<u32> {
        self.0[resource as usize]
    }
}

fn parse(name: &str, value: &str) -> Result<Option<u32>> {
    let value = value.trim();
    if value.eq_ignore_ascii_case("unlimited") {
        return Ok(None);
    }
    match value.parse::<u32>() {
        Ok(limit) if limit > 0 => Ok(Some(limit)),
        _ => Err(Error::BadRequest(format!(
            "{name} must be a positive integer or \"unlimited\""
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_numbers_and_unlimited() {
        assert_eq!(parse("X", "120").unwrap(), Some(120));
        assert_eq!(parse("X", " Unlimited ").unwrap(), None);
        assert!(parse("X", "0").is_err());
        assert!(parse("X", "-5").is_err());
        assert!(parse("X", "lots").is_err());
    }

    #[test]
    fn resources_index_their_own_slot() {
        for (index, resource) in Resource::ALL.into_iter().enumerate() {
            assert_eq!(resource as usize, index);
        }
    }
}
