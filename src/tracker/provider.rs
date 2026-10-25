//! The provider registry and the normalized types providers produce.
use super::{Direction, Mapping, TrackerField, TrackerOptions, openproject};
use crate::{
    domain::Priority,
    error::{Error, Result},
};
use chrono::{DateTime, NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum ProviderKind {
    #[serde(rename = "openproject")]
    OpenProject,
}

#[derive(Serialize)]
pub struct Descriptor {
    pub kind: ProviderKind,
    pub name: &'static str,
    /// Directions the provider supports per field.
    pub fields: TrackerOptions,
    /// Options for new connections.
    pub defaults: TrackerOptions,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RemoteProject {
    pub id: String,
    pub name: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RemoteStatus {
    pub id: String,
    pub name: String,
    pub is_closed: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RemotePerson {
    pub id: String,
    pub name: String,
    pub email: Option<String>,
}
#[derive(Clone, Debug)]
pub struct RemoteIssue {
    pub id: String,
    pub project_id: String,
    pub parent_id: Option<String>,
    pub title: String,
    pub description: String,
    pub assignee_id: Option<String>,
    pub author_id: Option<String>,
    pub status_id: String,
    pub status_name: Option<String>,
    pub priority: Priority,
    pub deadline: Option<DateTime<Utc>>,
    /// Remote modification time; comments are only fetched when it moves.
    pub updated_at: Option<DateTime<Utc>>,
    pub url: String,
}
/// A remote comment on an item, oldest first in listings.
#[derive(Clone, Debug)]
pub struct RemoteComment {
    pub id: String,
    pub author_id: Option<String>,
    pub author_name: String,
    pub body: String,
    pub created_at: DateTime<Utc>,
}

/// Where and how to reach a connection's provider.
#[derive(Clone, Copy)]
pub struct Endpoint<'a> {
    pub client: &'a reqwest::Client,
    pub base_url: &'a str,
    pub token: &'a str,
}

/// What a connection needs to fetch one page.
pub struct ScanContext<'a> {
    pub endpoint: Endpoint<'a>,
    pub mappings: &'a [Mapping],
}

/// A local value already mapped to provider identifiers.
#[derive(Clone, Debug, PartialEq)]
pub enum FieldValue {
    /// Statuses that represent the local stage, preferred first. A current remote
    /// status in the list is kept.
    Status(Vec<String>),
    Title(String),
    Description(String),
    /// None unassigns.
    Assignee(Option<String>),
    DueDate(Option<NaiveDate>),
}

pub enum Push {
    Fields {
        remote_id: String,
        fields: Vec<FieldValue>,
    },
    Comment {
        remote_id: String,
        body: String,
    },
}

/// Transient failures are errors; the outbox keeps their rows for a retry.
#[derive(Debug, PartialEq)]
pub enum PushOutcome {
    /// `comment_id` identifies a created comment; `status_id` is the remote status after
    /// a status push.
    Applied {
        comment_id: Option<String>,
        status_id: Option<String>,
    },
    /// The provider refused the change for good; the message is ours, never a remote body.
    Rejected(String),
    /// The connection may not push now (credentials or permissions). The row waits and
    /// the connection reports the message.
    Unavailable(String),
}

pub enum PageData {
    Projects(Vec<RemoteProject>),
    Statuses(Vec<RemoteStatus>),
    People(Vec<RemotePerson>),
    Issues {
        mapping: Mapping,
        items: Vec<RemoteIssue>,
    },
}

impl PageData {
    pub fn item_count(&self) -> usize {
        match self {
            Self::Projects(items) => items.len(),
            Self::Statuses(items) => items.len(),
            Self::People(items) => items.len(),
            Self::Issues { items, .. } => items.len(),
        }
    }
}

/// One fetched and normalized page and the scan state after it commits.
pub struct Page {
    /// Remote resource and page number, for logs and the discovery page store.
    pub resource: &'static str,
    pub number: i64,
    pub data: PageData,
    pub more: bool,
    pub started_at: DateTime<Utc>,
    /// None when this page finishes the scan.
    pub next: Option<Value>,
    /// The connection was reached and metadata or issues were checked.
    pub checked: bool,
    pub refresh_only: bool,
}

pub enum Step {
    Page(Page),
    /// The provider rejected an incremental request; restart with this unfiltered checkpoint.
    FullRescan(Value),
}

/// Inputs for the next automatic scan.
pub struct Poll {
    /// Only an idle connection starts a new scan; others keep their checkpoint.
    pub idle: bool,
    pub now: DateTime<Utc>,
    /// Refresh projects, statuses and people before importing issues.
    pub discover: bool,
    /// Start of the last successful scan, when an incremental scan is allowed.
    pub since: Option<DateTime<Utc>>,
}

const IMPORT: Direction = Direction {
    import: true,
    export: false,
};
const BOTH: Direction = Direction {
    import: true,
    export: true,
};

impl ProviderKind {
    pub const ALL: [Self; 1] = [Self::OpenProject];

    pub fn key(self) -> &'static str {
        match self {
            Self::OpenProject => "openproject",
        }
    }

    pub fn parse(key: &str) -> Result<Self> {
        Self::ALL
            .into_iter()
            .find(|kind| kind.key() == key)
            .ok_or_else(|| Error::Internal("unknown tracker provider".into()))
    }

    pub fn name(self) -> &'static str {
        match self {
            Self::OpenProject => "OpenProject",
        }
    }

    pub fn descriptor(self) -> Descriptor {
        match self {
            Self::OpenProject => {
                // Priority and parent are import-only.
                let fields = TrackerOptions::uniform(BOTH)
                    .with(TrackerField::Priority, IMPORT)
                    .with(TrackerField::Parent, IMPORT);
                Descriptor {
                    kind: self,
                    name: self.name(),
                    defaults: fields.clone(),
                    fields,
                }
            }
        }
    }

    /// Validates provider-native project and status IDs.
    pub fn valid_id(self, id: &str) -> bool {
        match self {
            Self::OpenProject => openproject::valid_id(id),
        }
    }

    /// Scan state for a full scan starting with discovery.
    pub fn checkpoint(self, refresh_only: bool) -> Value {
        match self {
            Self::OpenProject => openproject::checkpoint(refresh_only),
        }
    }

    /// Plans the next automatic scan from an idle connection's checkpoint.
    pub fn poll(self, checkpoint: Value, poll: Poll) -> Result<Value> {
        match self {
            Self::OpenProject => openproject::poll(checkpoint, poll),
        }
    }

    /// Fetches and normalizes one page.
    pub async fn step(self, context: &ScanContext<'_>, checkpoint: Value) -> Result<Step> {
        match self {
            Self::OpenProject => openproject::step(context, checkpoint).await,
        }
    }

    /// Sends one local change.
    pub async fn push(self, endpoint: &Endpoint<'_>, push: &Push) -> Result<PushOutcome> {
        match self {
            Self::OpenProject => openproject::push(endpoint, push).await,
        }
    }

    /// Lists an item's comments, oldest first. A refusal returns as the `Rejected` or
    /// `Unavailable` outcome a push would get.
    pub async fn comments(
        self,
        endpoint: &Endpoint<'_>,
        remote_id: &str,
    ) -> Result<std::result::Result<Vec<RemoteComment>, PushOutcome>> {
        match self {
            Self::OpenProject => openproject::comments(endpoint, remote_id).await,
        }
    }

    /// The remote user ID of the connection's integration account, which authors the
    /// comments it pushes. A refusal returns as an outcome, as for `comments`.
    pub async fn account(
        self,
        endpoint: &Endpoint<'_>,
    ) -> Result<std::result::Result<String, PushOutcome>> {
        match self {
            Self::OpenProject => openproject::account(endpoint).await,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_keys_round_trip_and_descriptors_match_options() {
        for kind in ProviderKind::ALL {
            assert_eq!(ProviderKind::parse(kind.key()).unwrap(), kind);
            assert_eq!(serde_json::to_value(kind).unwrap(), kind.key());
            let descriptor = kind.descriptor();
            assert!(descriptor.defaults.validate(&descriptor.fields).is_ok());
            assert!(descriptor.fields.get(TrackerField::Comments).import);
        }
        assert!(ProviderKind::parse("jira").is_err());
    }
}
