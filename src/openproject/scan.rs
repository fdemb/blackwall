use super::*;
use crate::domain::Priority;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(super) struct Cursor {
    pub page: i64,
    #[serde(default)]
    pub page_size: Option<i64>,
}
impl Default for Cursor {
    fn default() -> Self {
        Self {
            page: 1,
            page_size: None,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "phase", rename_all = "snake_case")]
pub(super) enum Checkpoint {
    Projects {
        #[serde(flatten)]
        cursor: Cursor,
        refresh_only: bool,
    },
    Statuses {
        #[serde(flatten)]
        cursor: Cursor,
        refresh_only: bool,
    },
    WorkPackages {
        #[serde(flatten)]
        cursor: Cursor,
        project_index: usize,
    },
}
impl Default for Checkpoint {
    fn default() -> Self {
        Self::new(false)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(super) struct Project {
    pub id: i64,
    pub name: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub(super) struct Status {
    pub id: i64,
    pub name: String,
    pub is_closed: bool,
}
#[derive(Debug)]
pub(super) struct WorkPackage {
    pub id: i64,
    pub project_id: i64,
    pub title: String,
    pub description: String,
    pub status_id: i64,
    pub status_name: Option<String>,
    pub priority: Priority,
    pub deadline: Option<DateTime<Utc>>,
}
pub(super) enum PageData {
    Projects(Vec<Project>),
    Statuses(Vec<Status>),
    WorkPackages {
        mapping: Mapping,
        items: Vec<WorkPackage>,
    },
}
pub(super) struct Page {
    pub data: PageData,
    pub more: bool,
    pub page_size: Option<i64>,
}
pub(super) struct Transition {
    pub next: Option<Checkpoint>,
    pub checked: bool,
    pub refresh_only: bool,
}

impl Checkpoint {
    pub fn new(refresh_only: bool) -> Self {
        Self::Projects {
            cursor: Cursor::default(),
            refresh_only,
        }
    }
    pub fn cursor(&self) -> &Cursor {
        match self {
            Self::Projects { cursor, .. }
            | Self::Statuses { cursor, .. }
            | Self::WorkPackages { cursor, .. } => cursor,
        }
    }
    fn mapping<'a>(&self, mappings: &'a [Mapping]) -> Result<&'a Mapping> {
        let Self::WorkPackages { project_index, .. } = self else {
            return Err(Error::Internal("invalid OpenProject scan phase".into()));
        };
        mappings.get(*project_index).ok_or_else(|| {
            Error::Internal(
                "invalid OpenProject project checkpoint; run sync now to restart".into(),
            )
        })
    }
    pub fn request(&self, mappings: &[Mapping]) -> Result<(&'static str, Option<Value>)> {
        if !(1..=1000).contains(&self.cursor().page) {
            return Err(Error::Internal("OpenProject page limit reached".into()));
        }
        Ok(match self {
            Self::Projects { .. } => ("projects", None),
            Self::Statuses { .. } => ("statuses", None),
            Self::WorkPackages { .. } => (
                "work_packages",
                Some(
                    json!([{"project":{"operator":"=","values":[self.mapping(mappings)?.project_id.to_string()]}}]),
                ),
            ),
        })
    }
    pub fn normalize(&self, response: Value, mappings: &[Mapping]) -> Result<Page> {
        let page_size = response.get("pageSize").and_then(Value::as_i64);
        if self.cursor().page > 1 && self.cursor().page_size != page_size {
            return Err(Error::Internal(
                "OpenProject page size changed during scan; run sync now to restart".into(),
            ));
        }
        let (items, more) = elements(&response, self.cursor().page)?;
        let data = match self {
            Self::Projects { .. } => PageData::Projects(
                items
                    .iter()
                    .map(|item| {
                        Ok(Project {
                            id: positive_id(item)?,
                            name: name(item)?,
                        })
                    })
                    .collect::<Result<_>>()?,
            ),
            Self::Statuses { .. } => PageData::Statuses(
                items
                    .iter()
                    .map(|item| {
                        Ok(Status {
                            id: positive_id(item)?,
                            name: name(item)?,
                            is_closed: item
                                .get("isClosed")
                                .and_then(Value::as_bool)
                                .unwrap_or(false),
                        })
                    })
                    .collect::<Result<_>>()?,
            ),
            Self::WorkPackages { .. } => {
                if items.len() > 50 {
                    return Err(Error::Internal(
                        "OpenProject work package page exceeds 50 items".into(),
                    ));
                }
                let mapping = self.mapping(mappings)?.clone();
                let items = items
                    .iter()
                    .map(|item| work_package(item, mapping.project_id))
                    .collect::<Result<_>>()?;
                PageData::WorkPackages { mapping, items }
            }
        };
        Ok(Page {
            data,
            more,
            page_size,
        })
    }
    pub fn advance(&self, page: &Page, mapping_count: usize) -> Result<Transition> {
        let refresh_only = match self {
            Self::Projects { refresh_only, .. } | Self::Statuses { refresh_only, .. } => {
                *refresh_only
            }
            Self::WorkPackages { .. } => false,
        };
        let next = if page.more {
            let mut next = self.clone();
            let cursor = match &mut next {
                Self::Projects { cursor, .. }
                | Self::Statuses { cursor, .. }
                | Self::WorkPackages { cursor, .. } => cursor,
            };
            cursor.page += 1;
            cursor.page_size = page.page_size;
            if cursor.page > 1000 {
                return Err(Error::Internal("OpenProject page limit reached".into()));
            }
            Some(next)
        } else {
            match self {
                Self::Projects { .. } => Some(Self::Statuses {
                    cursor: Cursor::default(),
                    refresh_only,
                }),
                Self::Statuses { .. } if refresh_only || mapping_count == 0 => None,
                Self::Statuses { .. } => Some(Self::WorkPackages {
                    cursor: Cursor::default(),
                    project_index: 0,
                }),
                Self::WorkPackages { project_index, .. } if project_index + 1 < mapping_count => {
                    Some(Self::WorkPackages {
                        cursor: Cursor::default(),
                        project_index: project_index + 1,
                    })
                }
                Self::WorkPackages { .. } => None,
            }
        };
        let checked = matches!(self, Self::WorkPackages { .. })
            || matches!(self, Self::Statuses { .. }) && !page.more;
        Ok(Transition {
            next,
            checked,
            refresh_only,
        })
    }
}

pub(super) fn append_cache<T: Serialize>(cache: &mut Value, items: &[T], page: i64) -> Result<()> {
    if page == 1 {
        *cache = json!([]);
    }
    let entries = cache
        .as_array_mut()
        .ok_or_else(|| Error::Internal("invalid OpenProject cache".into()))?;
    entries.extend(
        items
            .iter()
            .map(serde_json::to_value)
            .collect::<std::result::Result<Vec<_>, _>>()?,
    );
    if entries.len() > 5000 {
        return Err(Error::Internal(
            "OpenProject discovery limit reached".into(),
        ));
    }
    Ok(())
}
fn positive_id(item: &Value) -> Result<i64> {
    item.get("id")
        .and_then(Value::as_i64)
        .filter(|id| *id > 0)
        .ok_or_else(|| Error::Internal("invalid OpenProject ID".into()))
}
fn name(item: &Value) -> Result<String> {
    item.get("name")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| Error::Internal("missing OpenProject name".into()))
}
fn link_id(item: &Value, kind: &str) -> Result<i64> {
    item.pointer(&format!("/_links/{kind}/href"))
        .and_then(Value::as_str)
        .and_then(|href| href.rsplit('/').next())
        .and_then(|id| id.parse().ok())
        .filter(|id| *id > 0)
        .ok_or_else(|| Error::Internal(format!("missing work package {kind}")))
}
fn work_package(item: &Value, expected_project: i64) -> Result<WorkPackage> {
    let id = positive_id(item)?;
    let project_id = link_id(item, "project")?;
    if project_id != expected_project {
        return Err(Error::Internal(
            "work package outside requested project".into(),
        ));
    }
    let title = item
        .get("subject")
        .and_then(Value::as_str)
        .ok_or_else(|| Error::Internal("missing work package subject".into()))?
        .to_owned();
    crate::domain::text(&title, 500)?;
    let description = item
        .pointer("/description/raw")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned();
    if description.len() > 100_000 {
        return Err(Error::Internal("work package description too large".into()));
    }
    let status_id = link_id(item, "status")?;
    let status_name = item
        .pointer("/_links/status/title")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let priority = match item
        .pointer("/_links/priority/title")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "low" => Priority::Low,
        "normal" => Priority::Normal,
        "high" => Priority::High,
        "urgent" | "immediate" => Priority::Urgent,
        _ => Priority::None,
    };
    let deadline = match item.get("dueDate") {
        None | Some(Value::Null) => None,
        Some(Value::String(date)) => Some(
            chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d")
                .map_err(|_| Error::Internal("invalid work package due date".into()))?
                .and_hms_opt(0, 0, 0)
                .unwrap()
                .and_utc(),
        ),
        Some(_) => return Err(Error::Internal("invalid work package due date".into())),
    };
    Ok(WorkPackage {
        id,
        project_id,
        title,
        description,
        status_id,
        status_name,
        priority,
        deadline,
    })
}

pub(super) fn elements(value: &Value, page: i64) -> Result<(Vec<Value>, bool)> {
    let items = value
        .pointer("/_embedded/elements")
        .and_then(Value::as_array)
        .ok_or_else(|| Error::Internal("invalid OpenProject collection".into()))?;
    let total = value
        .get("total")
        .and_then(Value::as_i64)
        .ok_or_else(|| Error::Internal("missing OpenProject total".into()))?;
    if total < 0
        || items.len() > 5000
        || value
            .get("count")
            .and_then(Value::as_u64)
            .is_some_and(|count| count != items.len() as u64)
    {
        return Err(Error::Internal(
            "invalid OpenProject collection count".into(),
        ));
    }
    let more = match value.get("pageSize").and_then(Value::as_i64) {
        Some(size) => {
            if !(1..=50).contains(&size)
                || items.len() as i64 > size
                || value.get("offset").and_then(Value::as_i64) != Some(page)
            {
                return Err(Error::Internal("invalid OpenProject pagination".into()));
            }
            page * size < total
        }
        None => {
            if page != 1 || total != items.len() as i64 {
                return Err(Error::Internal(
                    "incomplete unpaginated OpenProject collection".into(),
                ));
            }
            false
        }
    };
    if more && value.get("pageSize").and_then(Value::as_u64) != Some(items.len() as u64) {
        return Err(Error::Internal(
            "empty OpenProject page with continuation".into(),
        ));
    }
    Ok((items.clone(), more))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn page(data: PageData) -> Page {
        Page {
            data,
            more: false,
            page_size: None,
        }
    }

    #[test]
    fn discovery_finishes_without_constructing_an_unmapped_work_package_scan() {
        for refresh_only in [false, true] {
            let projects = Checkpoint::new(refresh_only);
            let statuses = projects
                .advance(&page(PageData::Projects(vec![])), 0)
                .unwrap()
                .next
                .unwrap();
            assert_eq!(statuses.request(&[]).unwrap().0, "statuses");
            let finished = statuses
                .advance(&page(PageData::Statuses(vec![])), 0)
                .unwrap();
            assert!(finished.next.is_none());
            assert!(finished.checked);
            assert_eq!(finished.refresh_only, refresh_only);
        }
    }

    #[test]
    fn checkpoint_variants_only_serialize_fields_used_by_the_phase() {
        let projects = serde_json::to_value(Checkpoint::default()).unwrap();
        assert!(projects.get("project_index").is_none());
        let packages = Checkpoint::WorkPackages {
            cursor: Cursor::default(),
            project_index: 0,
        };
        assert!(
            serde_json::to_value(&packages)
                .unwrap()
                .get("refresh_only")
                .is_none()
        );
        assert!(packages.request(&[]).is_err());
        assert!(serde_json::from_value::<Checkpoint>(json!({"phase":"unknown","page":1})).is_err());
        // Old checkpoints remain readable and serialize back without obsolete fields.
        let old: Checkpoint = serde_json::from_value(
            json!({"phase":"projects","page":1,"refresh_only":false,"project_index":0}),
        )
        .unwrap();
        assert!(
            serde_json::to_value(old)
                .unwrap()
                .get("project_index")
                .is_none()
        );
    }

    #[test]
    fn work_package_normalization_checks_every_item_and_requested_project() {
        let mappings = [Mapping {
            project_id: 42,
            team_id: Uuid::nil(),
            stage_mapping: BTreeMap::new(),
        }];
        let cp = Checkpoint::WorkPackages {
            cursor: Cursor::default(),
            project_index: 0,
        };
        let valid = json!({"id":7,"subject":"Valid","_links":{"project":{"href":"/api/v3/projects/42"},"status":{"href":"/api/v3/statuses/1"}}});
        for invalid in [
            json!({"id":8,"subject":"Wrong project","_links":{"project":{"href":"/api/v3/projects/43"},"status":{"href":"/api/v3/statuses/1"}}}),
            json!({"id":8,"subject":"Bad deadline","dueDate":42,"_links":{"project":{"href":"/api/v3/projects/42"},"status":{"href":"/api/v3/statuses/1"}}}),
        ] {
            let response = json!({"total":2,"count":2,"pageSize":50,"offset":1,"_embedded":{"elements":[valid,invalid]}});
            assert!(cp.normalize(response, &mappings).is_err());
        }
    }

    #[test]
    fn continuation_preserves_page_size_and_resets_it_for_the_next_project() {
        let cp = Checkpoint::WorkPackages {
            cursor: Cursor::default(),
            project_index: 0,
        };
        let page = Page {
            data: PageData::WorkPackages {
                mapping: Mapping {
                    project_id: 42,
                    team_id: Uuid::nil(),
                    stage_mapping: BTreeMap::new(),
                },
                items: vec![],
            },
            more: true,
            page_size: Some(1),
        };
        let next = cp.advance(&page, 2).unwrap().next.unwrap();
        assert_eq!(next.cursor().page, 2);
        assert_eq!(next.cursor().page_size, Some(1));
        let last = Page {
            more: false,
            ..page
        };
        let next = next.advance(&last, 2).unwrap().next.unwrap();
        assert_eq!(next.cursor().page, 1);
        assert_eq!(next.cursor().page_size, None);
        assert!(matches!(
            next,
            Checkpoint::WorkPackages {
                project_index: 1,
                ..
            }
        ));
    }
}
