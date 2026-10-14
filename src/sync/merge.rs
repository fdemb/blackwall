//! Three-way merge of imported remote values with local edits.
use super::{SyncField, SyncOptions};
use crate::domain::{Baseline, Issue};
use std::collections::{BTreeMap, BTreeSet};
use uuid::Uuid;

/// Decides which remote values an import applies to one local issue.
pub(super) struct Merge<'a> {
    options: &'a SyncOptions,
    pending: Option<&'a BTreeSet<SyncField>>,
    baseline: Option<&'a Baseline>,
    creating: bool,
    trashed: bool,
}

impl<'a> Merge<'a> {
    pub fn new(
        options: &'a SyncOptions,
        pending: &'a BTreeMap<Uuid, BTreeSet<SyncField>>,
        issue: Option<&'a Issue>,
    ) -> Self {
        Self {
            options,
            pending: issue.and_then(|issue| pending.get(&issue.id)),
            baseline: issue
                .and_then(|issue| issue.sync.as_ref())
                .and_then(|link| link.baseline.as_ref()),
            creating: issue.is_none(),
            trashed: issue.is_some_and(|issue| issue.deleted_at.is_some()),
        }
    }

    /// New issues copy the remote. Otherwise the remote value applies when its import
    /// is on, no local change waits to be pushed, and it moved since the baseline;
    /// without a baseline the remote wins. `None` fields have no toggle. Trashed issues
    /// keep every local value.
    pub fn takes<T: PartialEq>(
        &self,
        field: Option<SyncField>,
        value: impl Fn(&Baseline) -> &T,
        remote: &T,
    ) -> bool {
        self.creating
            || !self.trashed
                && field.is_none_or(|field| {
                    self.options.get(field).import
                        && !self.pending.is_some_and(|pending| pending.contains(&field))
                })
                && self.baseline.is_none_or(|base| value(base) != remote)
    }

    /// Applies the remote scalar fields and returns whether the issue was re-placed.
    /// Stages belong to teams, so the mapped team and stage move together, and the
    /// team follows project mapping changes regardless of the status toggle.
    pub fn apply(&self, issue: &mut Issue, remote: &Baseline) -> bool {
        if self.takes(Some(SyncField::Title), |b| &b.title, &remote.title) {
            issue.title.clone_from(&remote.title);
        }
        if self.takes(
            Some(SyncField::Description),
            |b| &b.description,
            &remote.description,
        ) {
            issue.description.clone_from(&remote.description);
        }
        if self.takes(Some(SyncField::Assignee), |b| &b.assignee, &remote.assignee) {
            issue.assignee = remote.assignee;
        }
        if self.takes(Some(SyncField::Priority), |b| &b.priority, &remote.priority) {
            issue.priority = remote.priority.clone();
        }
        if self.takes(Some(SyncField::DueDate), |b| &b.deadline, &remote.deadline) {
            issue.deadline = remote.deadline;
        }
        let placed = self.takes(None, |b| &b.team_id, &remote.team_id)
            || self.takes(Some(SyncField::Status), |b| &b.stage_id, &remote.stage_id);
        if placed {
            issue.team_id = remote.team_id;
            issue.stage_id = remote.stage_id;
        }
        placed
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        domain::{Priority, SyncLink},
        sync::Direction,
    };

    fn baseline(title: &str) -> Baseline {
        Baseline {
            title: title.into(),
            description: String::new(),
            team_id: Uuid::nil(),
            stage_id: Uuid::nil(),
            assignee: None,
            priority: Priority::None,
            deadline: None,
            parent_id: None,
        }
    }

    fn issue(title: &str, base: Option<Baseline>) -> Issue {
        let mut issue: Issue = serde_json::from_value(serde_json::json!({
            "id": Uuid::new_v4(), "number": 1, "title": title, "description": "",
            "team_id": Uuid::nil(), "stage_id": Uuid::nil(), "assignee": null,
            "priority": "none", "labels": [], "estimate": null, "deadline": null,
            "project_id": null, "milestone_id": null, "sprint_id": null, "parent_id": null,
            "dependencies": [], "position": 0, "followers": [], "attachments": [],
            "source_links": [], "deleted_at": null, "archived_at": null, "done_at": null,
            "created_at": "2026-01-01T00:00:00Z", "updated_at": "2026-01-01T00:00:00Z",
        }))
        .unwrap();
        issue.sync = Some(SyncLink {
            provider: "openproject".into(),
            connection_id: Uuid::nil(),
            remote_id: "1".into(),
            project_id: "1".into(),
            parent_remote_id: None,
            status_name: "New".into(),
            url: String::new(),
            baseline: base,
            push_error: None,
            comments_at: None,
            comments_imported: false,
            comments_tried_at: None,
        });
        issue
    }

    fn merged(local: &Issue, options: &SyncOptions, remote: &str) -> String {
        merged_with(local, options, &BTreeMap::new(), remote)
    }

    fn merged_with(
        local: &Issue,
        options: &SyncOptions,
        pending: &BTreeMap<Uuid, BTreeSet<SyncField>>,
        remote: &str,
    ) -> String {
        let mut after = local.clone();
        Merge::new(options, pending, Some(local)).apply(&mut after, &baseline(remote));
        after.title
    }

    const IMPORT: Direction = Direction {
        import: true,
        export: false,
    };

    #[test]
    fn new_issues_copy_every_remote_field() {
        let options = SyncOptions::default();
        let mut after = issue("", None);
        let placed =
            Merge::new(&options, &BTreeMap::new(), None).apply(&mut after, &baseline("remote"));
        assert!(placed);
        assert_eq!(after.title, "remote");
    }

    #[test]
    fn remote_wins_without_baseline() {
        let options = SyncOptions::uniform(IMPORT);
        assert_eq!(merged(&issue("local", None), &options, "remote"), "remote");
    }

    #[test]
    fn local_edit_survives_unchanged_remote() {
        let options = SyncOptions::uniform(IMPORT);
        let local = issue("local", Some(baseline("remote")));
        assert_eq!(merged(&local, &options, "remote"), "local");
    }

    #[test]
    fn changed_remote_wins_over_local_edit() {
        let options = SyncOptions::uniform(IMPORT);
        let local = issue("local", Some(baseline("old")));
        assert_eq!(merged(&local, &options, "new"), "new");
    }

    #[test]
    fn disabled_import_keeps_local_value() {
        let options = SyncOptions::uniform(IMPORT).with(SyncField::Title, Direction::default());
        assert_eq!(merged(&issue("local", None), &options, "remote"), "local");
        let local = issue("local", Some(baseline("old")));
        assert_eq!(merged(&local, &options, "new"), "local");
    }

    #[test]
    fn pending_push_keeps_local_value() {
        let options = SyncOptions::uniform(IMPORT);
        let local = issue("local", Some(baseline("old")));
        let pending = BTreeMap::from([(local.id, BTreeSet::from([SyncField::Title]))]);
        assert_eq!(merged_with(&local, &options, &pending, "new"), "local");
    }

    #[test]
    fn trashed_issue_keeps_every_field() {
        let options = SyncOptions::uniform(IMPORT);
        let mut local = issue("local", None);
        local.deleted_at = Some(local.created_at);
        let mut remote = baseline("remote");
        remote.team_id = Uuid::new_v4();
        let mut after = local.clone();
        let placed =
            Merge::new(&options, &BTreeMap::new(), Some(&local)).apply(&mut after, &remote);
        assert!(!placed);
        assert_eq!((after.title, after.team_id), (local.title, local.team_id));
    }

    #[test]
    fn team_follows_mapping_even_with_status_import_off() {
        let options = SyncOptions::uniform(IMPORT).with(SyncField::Status, Direction::default());
        let local = issue("local", Some(baseline("local")));
        let mut remote = baseline("local");
        remote.team_id = Uuid::new_v4();
        remote.stage_id = Uuid::new_v4();
        let mut after = local.clone();
        assert!(Merge::new(&options, &BTreeMap::new(), Some(&local)).apply(&mut after, &remote));
        assert_eq!(
            (after.team_id, after.stage_id),
            (remote.team_id, remote.stage_id)
        );
    }
}
