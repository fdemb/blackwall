use super::{Endpoint, ScanContext};
use crate::error::{Error, Result};
use reqwest::Method;
use serde_json::{Value, json};
use std::time::Instant;

#[tracing::instrument(name = "openproject_request", level = "debug", skip_all,
    fields(resource = path, page))]
pub(super) async fn fetch(
    context: &ScanContext<'_>,
    path: &str,
    page: i64,
    filters: Option<Value>,
) -> Result<Value> {
    let started = Instant::now();
    tracing::debug!(
        filtered = filters.is_some(),
        "OpenProject HTTP request started"
    );
    let mut req = request(&context.endpoint, Method::GET, path)
        .query(&[("pageSize", "50".to_owned()), ("offset", page.to_string())]);
    if let Some(filters) = filters {
        req = req.query(&[
            ("filters", filters.to_string()),
            ("sortBy", json!([["id", "asc"]]).to_string()),
        ]);
    }
    let response = execute(req).await?.map_err(status_error)?;
    tracing::debug!(
        elapsed_ms = started.elapsed().as_millis(),
        "OpenProject HTTP request completed"
    );
    Ok(response)
}

/// Sends one JSON request for a push. Unsuccessful statuses return as `Err(status)`
/// without reading the remote body.
#[tracing::instrument(name = "openproject_push_request", level = "debug", skip_all,
    fields(method = %method, resource = path))]
pub(super) async fn send(
    endpoint: &Endpoint<'_>,
    method: Method,
    path: &str,
    body: Option<&Value>,
) -> Result<std::result::Result<Value, u16>> {
    let mut req = request(endpoint, method, path);
    if let Some(body) = body {
        req = req.json(body);
    }
    execute(req).await
}

fn request(endpoint: &Endpoint<'_>, method: Method, path: &str) -> reqwest::RequestBuilder {
    endpoint
        .client
        .request(method, format!("{}/api/v3/{path}", endpoint.base_url))
        .basic_auth("apikey", Some(endpoint.token))
}

/// Sends a request and reads its JSON body. Unsuccessful statuses return as
/// `Err(status)` without reading the remote body.
async fn execute(req: reqwest::RequestBuilder) -> Result<std::result::Result<Value, u16>> {
    let started = Instant::now();
    let response = req.send().await.map_err(|error| {
        tracing::debug!(
            timeout = error.is_timeout(),
            connect = error.is_connect(),
            elapsed_ms = started.elapsed().as_millis(),
            "OpenProject HTTP request failed"
        );
        Error::Internal("OpenProject request failed".into())
    })?;
    let status = response.status();
    tracing::debug!(
        status = status.as_u16(),
        elapsed_ms = started.elapsed().as_millis(),
        "OpenProject HTTP response received"
    );
    if !status.is_success() {
        return Ok(Err(status.as_u16()));
    }
    Ok(Ok(read_json(response).await?))
}

/// Reads a JSON body of at most 2 MiB.
async fn read_json(mut response: reqwest::Response) -> Result<Value> {
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| {
        tracing::debug!(bytes = bytes.len(), "OpenProject HTTP response body failed");
        Error::Internal("OpenProject body failed".into())
    })? {
        if bytes.len() + chunk.len() > 2 * 1024 * 1024 {
            tracing::debug!(
                bytes = bytes.len() + chunk.len(),
                "OpenProject HTTP response exceeds size limit"
            );
            return Err(Error::Internal("OpenProject page exceeds 2 MiB".into()));
        }
        bytes.extend_from_slice(&chunk);
    }
    tracing::debug!(bytes = bytes.len(), "OpenProject HTTP response body read");
    serde_json::from_slice(&bytes).map_err(|_| {
        tracing::debug!(
            bytes = bytes.len(),
            "OpenProject HTTP response contains invalid JSON"
        );
        Error::Internal("OpenProject returned invalid JSON".into())
    })
}

/// Only our own static messages or numeric HTTP statuses reach status metadata.
pub(super) fn status_error(status: u16) -> Error {
    Error::Internal(match status {
        401 => "OpenProject authentication failed (401); check the API token".into(),
        403 => "OpenProject permission denied (403); check project access".into(),
        _ => format!("OpenProject HTTP {status}"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn failures_are_actionable_without_remote_bodies() {
        assert!(
            status_error(401)
                .to_string()
                .contains("check the API token")
        );
        assert!(
            status_error(403)
                .to_string()
                .contains("check project access")
        );
        assert_eq!(status_error(422).to_string(), "OpenProject HTTP 422");
    }
}
