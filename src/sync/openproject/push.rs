//! Outbound changes: work package PATCH with optimistic locking, and comments as activities.
use super::{
    Endpoint,
    scan::{link_id, positive_id},
    transport::{self, status_error},
};
use crate::{
    error::{Error, Result},
    sync::provider::{FieldValue, PushOutcome},
};
use reqwest::Method;
use serde_json::{Map, Value, json};

/// Fetches the current `lockVersion` and patches only the given fields. A conflicting
/// concurrent edit (409) refetches and retries once.
pub(super) async fn update(
    endpoint: &Endpoint<'_>,
    id: &str,
    fields: &[FieldValue],
) -> Result<PushOutcome> {
    let path = format!("work_packages/{id}");
    let mut retried = false;
    loop {
        let package = match transport::send(endpoint, Method::GET, &path, None).await? {
            Ok(package) => package,
            Err(status) => return rejected(status),
        };
        let lock_version = package
            .get("lockVersion")
            .and_then(Value::as_i64)
            .ok_or_else(|| Error::Internal("OpenProject work package has no lockVersion".into()))?;
        let current = link_id(&package, "status").ok().map(|id| id.to_string());
        let applied = PushOutcome::Applied {
            comment_id: None,
            status_id: fields.iter().find_map(|field| match field {
                FieldValue::Status(candidates) => {
                    target_status(current.as_deref(), candidates).map(str::to_owned)
                }
                _ => None,
            }),
        };
        let Some(body) = patch_body(lock_version, current.as_deref(), fields) else {
            tracing::debug!(remote_id = id, "OpenProject work package already matches");
            return Ok(applied);
        };
        match transport::send(endpoint, Method::PATCH, &path, Some(&body)).await? {
            Ok(_) => return Ok(applied),
            Err(409) if !retried => {
                tracing::debug!(remote_id = id, "OpenProject lock conflict; retrying once");
                retried = true;
            }
            Err(status) => return rejected(status),
        }
    }
}

/// Posts a comment activity.
pub(super) async fn comment(endpoint: &Endpoint<'_>, id: &str, body: &str) -> Result<PushOutcome> {
    let path = format!("work_packages/{id}/activities");
    match transport::send(endpoint, Method::POST, &path, Some(&comment_body(body))).await? {
        Ok(activity) => Ok(PushOutcome::Applied {
            comment_id: Some(positive_id(&activity)?.to_string()),
            status_id: None,
        }),
        Err(status) => rejected(status),
    }
}

/// The PATCH body, or None when nothing would change.
fn patch_body(lock_version: i64, status: Option<&str>, fields: &[FieldValue]) -> Option<Value> {
    let mut body = Map::from_iter([("lockVersion".to_owned(), json!(lock_version))]);
    let mut links = Map::new();
    for field in fields {
        match field {
            FieldValue::Title(title) => {
                body.insert("subject".into(), json!(title));
            }
            FieldValue::Description(description) => {
                body.insert("description".into(), json!({ "raw": description }));
            }
            FieldValue::DueDate(date) => {
                body.insert("dueDate".into(), json!(date));
            }
            FieldValue::Assignee(person) => {
                let href = person.as_ref().map(|id| format!("/api/v3/users/{id}"));
                links.insert("assignee".into(), json!({ "href": href }));
            }
            FieldValue::Status(candidates) => {
                if let Some(id) = target_status(status, candidates)
                    && Some(id) != status
                {
                    links.insert(
                        "status".into(),
                        json!({ "href": format!("/api/v3/statuses/{id}") }),
                    );
                }
            }
        }
    }
    if !links.is_empty() {
        body.insert("_links".into(), Value::Object(links));
    }
    (body.len() > 1).then_some(Value::Object(body))
}

/// The current status when it represents the stage, else the preferred one.
fn target_status<'a>(current: Option<&'a str>, candidates: &'a [String]) -> Option<&'a str> {
    current
        .filter(|current| candidates.iter().any(|id| id == current))
        .or(candidates.first().map(String::as_str))
}

fn comment_body(body: &str) -> Value {
    json!({ "comment": { "raw": body } })
}

/// Authentication and permission failures concern the connection: the token or the
/// account's roles need fixing, after which queued changes go through. Other client
/// errors except timeouts, lock conflicts and rate limits will not succeed on retry.
pub(super) fn rejected(status: u16) -> Result<PushOutcome> {
    if matches!(status, 401 | 403) {
        return Ok(PushOutcome::Unavailable(status_error(status).to_string()));
    }
    if !(400..500).contains(&status) || matches!(status, 408 | 409 | 429) {
        return Err(status_error(status));
    }
    Ok(PushOutcome::Rejected(match status {
        404 => "OpenProject work package not found (404)".into(),
        422 => "OpenProject rejected the change (422); check workflow and required fields".into(),
        _ => format!("OpenProject rejected the change (HTTP {status})"),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::NaiveDate;

    #[test]
    fn patch_bodies_carry_only_the_queued_fields() {
        let fields = [
            FieldValue::Title("Title".into()),
            FieldValue::Description("**Body**".into()),
            FieldValue::DueDate(NaiveDate::from_ymd_opt(2026, 5, 10)),
            FieldValue::Assignee(Some("10".into())),
            FieldValue::Status(vec!["3".into(), "4".into()]),
        ];
        assert_eq!(
            patch_body(7, Some("1"), &fields).unwrap(),
            json!({"lockVersion":7,"subject":"Title","description":{"raw":"**Body**"},
                "dueDate":"2026-05-10","_links":{"assignee":{"href":"/api/v3/users/10"},
                "status":{"href":"/api/v3/statuses/3"}}})
        );
        assert_eq!(
            patch_body(
                2,
                None,
                &[FieldValue::Assignee(None), FieldValue::DueDate(None)]
            )
            .unwrap(),
            json!({"lockVersion":2,"dueDate":null,"_links":{"assignee":{"href":null}}})
        );
    }

    #[test]
    fn current_matching_status_needs_no_patch() {
        let fields = [FieldValue::Status(vec!["3".into(), "4".into()])];
        assert_eq!(patch_body(1, Some("4"), &fields), None);
        assert_eq!(
            patch_body(1, Some("1"), &[FieldValue::Status(vec![])]),
            None
        );
    }

    #[test]
    fn comments_post_raw_markdown() {
        assert_eq!(
            comment_body("Hi *there*"),
            json!({"comment":{"raw":"Hi *there*"}})
        );
    }

    #[test]
    fn only_final_client_errors_reject() {
        for status in [400, 404, 422] {
            assert!(
                matches!(rejected(status), Ok(PushOutcome::Rejected(_))),
                "{status}"
            );
        }
        for status in [401, 403] {
            assert!(
                matches!(rejected(status), Ok(PushOutcome::Unavailable(_))),
                "{status}"
            );
        }
        for status in [302, 408, 409, 429, 500, 503] {
            assert!(rejected(status).is_err(), "{status}");
        }
    }
}
