//! Work package activities: comments are activities with a non-empty `comment.raw`.
use super::{
    Endpoint,
    scan::{elements, link_id, positive_id},
    transport,
};
use crate::{
    error::{Error, Result},
    sync::provider::RemoteComment,
};
use chrono::{DateTime, Utc};
use reqwest::Method;
use serde_json::Value;

/// Activity pages fetched per work package; longer histories fail rather than import
/// partially.
const MAX_PAGES: i64 = 20;

/// Lists a work package's comments, following pagination. Unsuccessful statuses return
/// as `Err(status)`.
pub(super) async fn list(
    endpoint: &Endpoint<'_>,
    id: &str,
) -> Result<std::result::Result<Vec<RemoteComment>, u16>> {
    let mut comments = Vec::new();
    for page in 1..=MAX_PAGES {
        let path = format!("work_packages/{id}/activities?pageSize=50&offset={page}");
        let response = match transport::send(endpoint, Method::GET, &path, None).await? {
            Ok(response) => response,
            Err(status) => return Ok(Err(status)),
        };
        let (items, more) = elements(&response, page)?;
        comments.extend(items.iter().filter_map(comment));
        if !more {
            return Ok(Ok(comments));
        }
    }
    Err(Error::Internal(
        "OpenProject work package has too many activities".into(),
    ))
}

/// The integration account's user ID.
pub(super) async fn account(endpoint: &Endpoint<'_>) -> Result<std::result::Result<String, u16>> {
    match transport::send(endpoint, Method::GET, "users/me", None).await? {
        Ok(user) => Ok(Ok(positive_id(&user)?.to_string())),
        Err(status) => Ok(Err(status)),
    }
}

/// A comment activity, or None for field changes and malformed entries.
fn comment(item: &Value) -> Option<RemoteComment> {
    let body = item.pointer("/comment/raw").and_then(Value::as_str)?;
    if body.trim().is_empty() {
        return None;
    }
    Some(RemoteComment {
        id: positive_id(item).ok()?.to_string(),
        author_id: link_id(item, "user").ok().map(|id| id.to_string()),
        author_name: item
            .pointer("/_links/user/title")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
        body: body.to_owned(),
        created_at: item
            .get("createdAt")
            .and_then(Value::as_str)
            .and_then(|at| DateTime::parse_from_rfc3339(at).ok())?
            .with_timezone(&Utc),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn only_activities_with_comments_are_comments() {
        let activity = |comment: Value| {
            json!({"id":3,"_type":"Activity::Comment","comment":comment,"createdAt":"2026-10-01T10:00:00Z",
                "_links":{"user":{"href":"/api/v3/users/10","title":"Jane Doe"}}})
        };
        let parsed = comment(&activity(json!({"format":"markdown","raw":"Hi *there*"}))).unwrap();
        assert_eq!(
            (
                parsed.id.as_str(),
                parsed.author_id.as_deref(),
                parsed.author_name.as_str(),
                parsed.body.as_str()
            ),
            ("3", Some("10"), "Jane Doe", "Hi *there*")
        );
        assert_eq!(parsed.created_at.to_rfc3339(), "2026-10-01T10:00:00+00:00");
        assert!(comment(&activity(json!({"raw":" \n"}))).is_none());
        assert!(comment(&activity(json!({"raw":""}))).is_none());
        assert!(comment(&activity(Value::Null)).is_none());
        let mut deleted_user = activity(json!({"raw":"Kept"}));
        deleted_user["_links"]["user"] = json!({"href":null});
        assert!(comment(&deleted_user).unwrap().author_id.is_none());
    }
}
