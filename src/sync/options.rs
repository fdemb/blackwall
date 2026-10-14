use crate::error::{Error, Result};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// Issue data a connection can import from or send to its provider.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SyncField {
    Status,
    Title,
    Description,
    Assignee,
    DueDate,
    Priority,
    Parent,
    Comments,
}

impl SyncField {
    pub const ALL: [Self; 8] = [
        Self::Status,
        Self::Title,
        Self::Description,
        Self::Assignee,
        Self::DueDate,
        Self::Priority,
        Self::Parent,
        Self::Comments,
    ];

    pub fn key(self) -> &'static str {
        match self {
            Self::Status => "status",
            Self::Title => "title",
            Self::Description => "description",
            Self::Assignee => "assignee",
            Self::DueDate => "due_date",
            Self::Priority => "priority",
            Self::Parent => "parent",
            Self::Comments => "comments",
        }
    }

    pub fn parse(key: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|field| field.key() == key)
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Direction {
    pub import: bool,
    pub export: bool,
}

/// Per-field directions. Provider descriptors use the same shape for support and defaults.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct SyncOptions(BTreeMap<SyncField, Direction>);

impl SyncOptions {
    pub fn uniform(direction: Direction) -> Self {
        Self(SyncField::ALL.map(|field| (field, direction)).into())
    }

    pub fn with(mut self, field: SyncField, direction: Direction) -> Self {
        self.0.insert(field, direction);
        self
    }

    pub fn get(&self, field: SyncField) -> Direction {
        self.0.get(&field).copied().unwrap_or_default()
    }

    /// Overlays the requested fields on `base`, keeping every field the request omits.
    pub fn merged(&self, base: &Self) -> Self {
        let mut merged = base.clone();
        merged.0.extend(&self.0);
        merged
    }

    /// Rejects directions the provider does not support.
    pub fn validate(&self, supported: &Self) -> Result<()> {
        for (field, direction) in &self.0 {
            let support = supported.get(*field);
            if direction.import && !support.import || direction.export && !support.export {
                return Err(Error::BadRequest(format!(
                    "{} sync direction is not supported by this provider",
                    serde_json::to_value(field)?.as_str().unwrap_or("field")
                )));
            }
        }
        Ok(())
    }

    /// Export-only changes need no rescan.
    pub fn imports_changed(&self, other: &Self) -> bool {
        SyncField::ALL
            .iter()
            .any(|field| self.get(*field).import != other.get(*field).import)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const IMPORT: Direction = Direction {
        import: true,
        export: false,
    };
    const BOTH: Direction = Direction {
        import: true,
        export: true,
    };

    #[test]
    fn merged_options_keep_omitted_fields_and_reject_unsupported_directions() {
        let supported = SyncOptions::uniform(IMPORT);
        let requested: SyncOptions =
            serde_json::from_value(serde_json::json!({"title":{"import":false,"export":false}}))
                .unwrap();
        let merged = requested.merged(&supported);
        assert!(!merged.get(SyncField::Title).import);
        assert!(merged.get(SyncField::Status).import);
        assert!(merged.validate(&supported).is_ok());
        assert!(merged.imports_changed(&supported));
        let export = SyncOptions::default().with(SyncField::Title, BOTH);
        assert!(export.validate(&supported).is_err());
        assert!(!export.merged(&supported).imports_changed(&supported));
        assert!(
            serde_json::from_value::<SyncOptions>(serde_json::json!({"labels":IMPORT})).is_err()
        );
        for field in SyncField::ALL {
            assert_eq!(serde_json::to_value(field).unwrap(), field.key());
            assert_eq!(SyncField::parse(field.key()), Some(field));
        }
    }
}
