//! OpenProject API v3: HTTP Basic auth with an API token, HAL collections, and a
//! projects → statuses → people → work packages scan.
use super::provider::{Endpoint, Page, Poll, Push, PushOutcome, RemoteComment, ScanContext, Step};
use crate::error::{Error, Result};
use chrono::Utc;
use serde_json::{Value, json};
use std::time::Instant;

mod activities;
mod push;
mod scan;
mod transport;

use scan::{Checkpoint, Cursor};

/// OpenProject IDs are positive integers in canonical form.
pub(super) fn valid_id(id: &str) -> bool {
    id.parse::<i64>()
        .is_ok_and(|value| value > 0 && value.to_string() == id)
}

pub(super) fn checkpoint(refresh_only: bool) -> Value {
    json!(Checkpoint::new(refresh_only))
}

/// Only a finished scan on an idle connection starts over. Mapped connections between discovery refreshes
/// poll work packages modified within an overlapping window.
pub(super) fn poll(checkpoint: Value, poll: Poll) -> Result<Value> {
    let checkpoint: Checkpoint = serde_json::from_value(checkpoint)?;
    let fresh = poll.idle
        && matches!(&checkpoint, Checkpoint::Projects { cursor, refresh_only: false }
            if cursor.page == 1 && cursor.page_size.is_none() && cursor.started_at.is_none());
    if !fresh {
        return Ok(json!(checkpoint));
    }
    let next = if poll.discover {
        Checkpoint::Projects {
            cursor: Cursor {
                started_at: Some(poll.now),
                ..Cursor::default()
            },
            refresh_only: false,
        }
    } else {
        // Round the lower bound back two days to cover timestamp precision
        // and timezone differences. The checkpoint freezes the entire window.
        let cutoff = poll
            .since
            .and_then(|date| date.date_naive().checked_sub_days(chrono::Days::new(2)));
        Checkpoint::packages(poll.now, cutoff)
    };
    Ok(json!(next))
}

pub(super) async fn step(context: &ScanContext<'_>, checkpoint: Value) -> Result<Step> {
    let mut cp: Checkpoint = serde_json::from_value(checkpoint)?;
    let started_at = *cp.cursor_mut().started_at.get_or_insert_with(Utc::now);
    let (path, filters) = cp.request(context.mappings)?;
    let number = cp.cursor().page;
    tracing::debug!(
        resource = path,
        page = number,
        project_count = context.mappings.len(),
        incremental = cp.cursor().updated_since.is_some(),
        "OpenProject page started"
    );
    let http_started = Instant::now();
    let response = match transport::fetch(context, path, number, filters).await {
        Err(Error::Internal(message))
            if cp.cursor().updated_since.is_some()
                && matches!(
                    message.as_str(),
                    "OpenProject HTTP 400" | "OpenProject HTTP 422"
                ) =>
        {
            return Ok(Step::FullRescan(json!(cp.full_scan())));
        }
        result => result?,
    };
    let http_ms = http_started.elapsed().as_millis();
    let normalize_started = Instant::now();
    let page = cp
        .normalize(response, context.mappings, context.endpoint.base_url)
        .inspect_err(|_| {
            tracing::debug!(
                resource = path,
                page = number,
                "OpenProject page normalization failed"
            );
        })?;
    let transition = cp.advance(&page, context.mappings.len())?;
    tracing::debug!(resource = path, page = number, item_count = page.data.item_count(), more = page.more,
        page_size = ?page.page_size, http_ms, normalize_ms = normalize_started.elapsed().as_millis(),
        "OpenProject page normalized");
    Ok(Step::Page(Page {
        resource: path,
        number,
        data: page.data,
        more: page.more,
        started_at,
        next: transition.next.map(|next| json!(next)),
        checked: transition.checked,
        refresh_only: transition.refresh_only,
    }))
}

pub(super) async fn push(endpoint: &Endpoint<'_>, change: &Push) -> Result<PushOutcome> {
    match change {
        Push::Fields { remote_id, fields } => push::update(endpoint, remote_id, fields).await,
        Push::Comment { remote_id, body } => push::comment(endpoint, remote_id, body).await,
    }
}

pub(super) async fn comments(
    endpoint: &Endpoint<'_>,
    id: &str,
) -> Result<std::result::Result<Vec<RemoteComment>, PushOutcome>> {
    match activities::list(endpoint, id).await? {
        Ok(comments) => Ok(Ok(comments)),
        Err(status) => push::rejected(status).map(Err),
    }
}

pub(super) async fn account(
    endpoint: &Endpoint<'_>,
) -> Result<std::result::Result<String, PushOutcome>> {
    match activities::account(endpoint).await? {
        Ok(id) => Ok(Ok(id)),
        // Not about a work package.
        Err(404) => Err(transport::status_error(404)),
        Err(status) => push::rejected(status).map(Err),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::DateTime;

    #[test]
    fn ids_are_canonical_positive_integers() {
        assert!(valid_id("42"));
        for id in ["0", "-1", "042", "4.2", "", "x"] {
            assert!(!valid_id(id), "{id}");
        }
    }

    #[test]
    fn idle_scans_poll_packages_unless_discovery_is_due() {
        let now = DateTime::parse_from_rfc3339("2026-10-05T12:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let since = Some(now);
        let packages = poll(
            checkpoint(false),
            Poll {
                idle: true,
                now,
                discover: false,
                since,
            },
        )
        .unwrap();
        assert_eq!(packages["phase"], "work_packages");
        assert_eq!(packages["updated_since"], "2026-10-03");
        let discovery = poll(
            checkpoint(false),
            Poll {
                idle: true,
                now,
                discover: true,
                since,
            },
        )
        .unwrap();
        assert_eq!(discovery["phase"], "projects");
        assert!(discovery.get("started_at").is_some());
        // A running scan keeps its state.
        assert_eq!(
            poll(
                packages.clone(),
                Poll {
                    idle: true,
                    now,
                    discover: true,
                    since
                }
            )
            .unwrap(),
            packages
        );
    }
}
