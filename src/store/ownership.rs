use super::*;
use serde::Serialize;
use serde_json::Value;

pub const OWNERSHIP_CONSTRAINT: &str = "blackwall_issue_ownership";
pub const OWNERSHIP_MESSAGE: &str = "OpenProject imported issues are read-only";

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum IssueCapability {
    Edit,
    Move,
    Delete,
    Restore,
    SourceLinks,
    RemoveAttachment,
    Relation,
    Discussion,
    Follow,
    TimeTracking,
    AddAttachment,
}

impl IssueCapability {
    pub fn allowed(self, imported: bool) -> bool {
        match self {
            Self::Discussion | Self::Follow | Self::TimeTracking | Self::AddAttachment => true,
            _ => !imported,
        }
    }
}

#[derive(Serialize)]
pub struct OwnershipRule {
    pub command: &'static str,
    pub capability: IssueCapability,
    pub targets: &'static [&'static str],
}

// Paths address the serialized command, with * selecting every array element.
pub const OWNERSHIP_RULES: &[OwnershipRule] = &[
    OwnershipRule {
        command: "update_issue",
        capability: IssueCapability::Edit,
        targets: &["id", "patch/parent_id", "patch/dependencies/*"],
    },
    OwnershipRule {
        command: "move_issue",
        capability: IssueCapability::Move,
        targets: &["id"],
    },
    OwnershipRule {
        command: "delete_issue",
        capability: IssueCapability::Delete,
        targets: &["id"],
    },
    OwnershipRule {
        command: "restore_issue",
        capability: IssueCapability::Restore,
        targets: &["id"],
    },
    OwnershipRule {
        command: "bulk_issues",
        capability: IssueCapability::Edit,
        targets: &[
            "ids/*",
            "action/update/parent_id",
            "action/update/dependencies/*",
        ],
    },
    OwnershipRule {
        command: "add_source_link",
        capability: IssueCapability::SourceLinks,
        targets: &["issue_id"],
    },
    OwnershipRule {
        command: "remove_attachment",
        capability: IssueCapability::RemoveAttachment,
        targets: &["issue_id"],
    },
    OwnershipRule {
        command: "create_issue",
        capability: IssueCapability::Relation,
        targets: &["input/parent_id", "input/dependencies/*"],
    },
    OwnershipRule {
        command: "import_issues",
        capability: IssueCapability::Relation,
        targets: &["issues/*/parent_id", "issues/*/dependencies/*"],
    },
];

fn values_at<'a>(value: &'a Value, path: &str, output: &mut Vec<&'a Value>) {
    if path.is_empty() {
        output.push(value);
        return;
    }
    let (key, rest) = path.split_once('/').unwrap_or((path, ""));
    if key == "*" {
        if let Some(values) = value.as_array() {
            for value in values {
                values_at(value, rest, output);
            }
        }
    } else if let Some(value) = value.get(key) {
        values_at(value, rest, output);
    }
}

pub fn ownership_targets(command: &Command) -> Result<Vec<(Uuid, IssueCapability)>> {
    let value = serde_json::to_value(command)?;
    let mut targets = Vec::new();
    for rule in OWNERSHIP_RULES
        .iter()
        .filter(|rule| rule.command == command.kind())
    {
        for path in rule.targets {
            let mut values = Vec::new();
            values_at(&value, path, &mut values);
            for value in values {
                if let Some(id) = value.as_str() {
                    targets.push((
                        Uuid::parse_str(id).map_err(|e| Error::Internal(e.to_string()))?,
                        rule.capability,
                    ));
                }
            }
        }
    }
    Ok(targets)
}

pub fn frontend_policy() -> Result<String> {
    let capabilities = [
        IssueCapability::Edit,
        IssueCapability::Move,
        IssueCapability::Delete,
        IssueCapability::Restore,
        IssueCapability::SourceLinks,
        IssueCapability::RemoveAttachment,
        IssueCapability::Relation,
        IssueCapability::Discussion,
        IssueCapability::Follow,
        IssueCapability::TimeTracking,
        IssueCapability::AddAttachment,
    ];
    let mut permissions = serde_json::Map::new();
    for (name, imported) in [("local", false), ("openproject", true)] {
        let mut values = serde_json::Map::new();
        for capability in capabilities {
            let key = serde_json::to_value(capability)?
                .as_str()
                .unwrap()
                .to_owned();
            values.insert(key, Value::Bool(capability.allowed(imported)));
        }
        permissions.insert(name.into(), Value::Object(values));
    }
    Ok(format!(
        "{}\n",
        serde_json::to_string_pretty(&serde_json::json!({
            "rules": OWNERSHIP_RULES,
            "capabilities": permissions,
        }))?
    ))
}

impl Operation<'_> {
    pub(crate) async fn authorize_issue_ownership(&mut self, command: &Command) -> Result<()> {
        let targets = ownership_targets(command)?;
        if targets.is_empty() {
            return Ok(());
        }
        // Match the graph-before-row order used by issue mutations and sync.
        self.lock_graph().await?;
        let ids: Vec<_> = targets.iter().map(|(id, _)| *id).collect();
        let rows = sqlx::query("SELECT id,openproject IS NOT NULL AS imported FROM issues WHERE workspace_id=$1 AND id=ANY($2) ORDER BY id FOR UPDATE")
            .bind(self.workspace_id).bind(ids).fetch_all(&mut *self.tx).await?;
        for row in rows {
            let id: Uuid = row.try_get("id")?;
            let imported = row.try_get("imported")?;
            if targets
                .iter()
                .any(|(target, capability)| *target == id && !capability.allowed(imported))
            {
                return Err(Error::Conflict(OWNERSHIP_MESSAGE.into()));
            }
        }
        Ok(())
    }
}
