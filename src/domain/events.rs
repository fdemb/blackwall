use crate::error::{Error, Result};

/// Public webhook event types, in documentation order. Personal, private and
/// administrative actions (notifications, alerts, views, invitations,
/// integrations, follows) have no public event and are never delivered.
pub const WEBHOOK_EVENTS: &[&str] = &[
    "issue.created",
    "issue.updated",
    "issue.completed",
    "issue.deleted",
    "issue.restored",
    "issue.archived",
    "issue.unarchived",
    "issues.bulk_changed",
    "issues.imported",
    "comment.created",
    "comment.updated",
    "comment.deleted",
    "team.created",
    "team.updated",
    "stage.created",
    "stage.updated",
    "stage.deleted",
    "label.created",
    "label.updated",
    "label.deleted",
    "project.created",
    "project.updated",
    "project.deleted",
    "milestone.created",
    "milestone.updated",
    "milestone.deleted",
    "sprint.created",
    "sprint.updated",
    "sprint.completed",
    "sprint.archived",
    "time_entry.created",
    "time_entry.updated",
    "time_entry.deleted",
    "member.role_changed",
    "member.removed",
];

/// The public event for an activity action, and the kind of entity its id names.
pub fn webhook_event(action: &str) -> Option<(&'static str, &'static str)> {
    Some(match action {
        "create_issue" => ("issue.created", "issue"),
        "update_issue"
        | "move_issue"
        | "add_attachment"
        | "remove_attachment"
        | "add_source_link"
        | "integration.source_link" => ("issue.updated", "issue"),
        "issue_completed" => ("issue.completed", "issue"),
        "delete_issue" => ("issue.deleted", "issue"),
        "restore_issue" => ("issue.restored", "issue"),
        "archive_issue" => ("issue.archived", "issue"),
        "unarchive_issue" => ("issue.unarchived", "issue"),
        "bulk_issues" => ("issues.bulk_changed", "issue"),
        "import_issues" | "workspace_imported" => ("issues.imported", "workspace"),
        "add_comment" => ("comment.created", "comment"),
        "edit_comment" | "attach_comment_file" => ("comment.updated", "comment"),
        "delete_comment" => ("comment.deleted", "comment"),
        "create_team" => ("team.created", "team"),
        "set_team_members" | "set_team_archive" | "set_team_appearance" => ("team.updated", "team"),
        "create_stage" => ("stage.created", "stage"),
        "update_stage" => ("stage.updated", "stage"),
        "delete_stage" => ("stage.deleted", "stage"),
        "create_label" => ("label.created", "label"),
        "update_label" => ("label.updated", "label"),
        "delete_label" => ("label.deleted", "label"),
        "create_project" => ("project.created", "project"),
        "update_project" => ("project.updated", "project"),
        "delete_project" => ("project.deleted", "project"),
        "create_milestone" => ("milestone.created", "milestone"),
        "update_milestone" => ("milestone.updated", "milestone"),
        "delete_milestone" => ("milestone.deleted", "milestone"),
        "create_sprint" => ("sprint.created", "sprint"),
        "update_sprint" => ("sprint.updated", "sprint"),
        "complete_sprint" => ("sprint.completed", "sprint"),
        "archive_sprint" => ("sprint.archived", "sprint"),
        "log_time" => ("time_entry.created", "time_entry"),
        "update_time" => ("time_entry.updated", "time_entry"),
        "delete_time" => ("time_entry.deleted", "time_entry"),
        "set_role" => ("member.role_changed", "member"),
        "remove_member" => ("member.removed", "member"),
        _ => return None,
    })
}

/// Rejects unknown event types and duplicates. An empty list subscribes to every event.
pub fn validate_webhook_events(events: &[String]) -> Result<()> {
    for (index, event) in events.iter().enumerate() {
        if !WEBHOOK_EVENTS.contains(&event.as_str()) {
            return Err(Error::BadRequest(format!("unknown webhook event {event}")));
        }
        if events[..index].contains(event) {
            return Err(Error::BadRequest(format!(
                "duplicate webhook event {event}"
            )));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_mapped_event_is_published() {
        for action in [
            "create_issue",
            "move_issue",
            "issue_completed",
            "bulk_issues",
            "add_comment",
            "delete_stage",
            "delete_label",
            "delete_project",
            "delete_milestone",
            "remove_member",
            "integration.source_link",
        ] {
            let (event, _) = webhook_event(action).unwrap();
            assert!(WEBHOOK_EVENTS.contains(&event), "{event}");
        }
        for private in ["save_view", "invite", "mark_notification_read", "follow"] {
            assert!(webhook_event(private).is_none(), "{private}");
        }
    }
}
