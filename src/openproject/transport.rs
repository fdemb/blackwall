use super::*;
use std::time::Duration;

pub(crate) fn client() -> Result<reqwest::Client> {
    reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(20))
        .connect_timeout(Duration::from_secs(5))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| Error::Internal("OpenProject client failed".into()))
}

#[tracing::instrument(name = "openproject_request", level = "debug", skip_all,
    fields(resource = path, page))]
pub(super) async fn fetch(
    client: &reqwest::Client,
    base: &str,
    token: &str,
    path: &str,
    page: i64,
    filters: Option<Value>,
) -> Result<Value> {
    let started = std::time::Instant::now();
    tracing::debug!(
        filtered = filters.is_some(),
        "OpenProject HTTP request started"
    );
    let mut req = client
        .get(format!("{base}/api/v3/{path}"))
        .basic_auth("apikey", Some(token))
        .query(&[("pageSize", "50".to_owned()), ("offset", page.to_string())]);
    if let Some(filters) = filters {
        req = req.query(&[
            ("filters", filters.to_string()),
            ("sortBy", json!([["id", "asc"]]).to_string()),
        ]);
    }
    let mut response = req.send().await.map_err(|error| {
        tracing::debug!(
            timeout = error.is_timeout(),
            connect = error.is_connect(),
            elapsed_ms = started.elapsed().as_millis(),
            "OpenProject HTTP request failed"
        );
        Error::Internal("OpenProject request failed".into())
    })?;
    tracing::debug!(
        status = response.status().as_u16(),
        elapsed_ms = started.elapsed().as_millis(),
        "OpenProject HTTP response received"
    );
    if !response.status().is_success() {
        return Err(Error::Internal(format!(
            "OpenProject HTTP {}",
            response.status().as_u16()
        )));
    }
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
    let response = serde_json::from_slice(&bytes).map_err(|_| {
        tracing::debug!(
            bytes = bytes.len(),
            "OpenProject HTTP response contains invalid JSON"
        );
        Error::Internal("OpenProject returned invalid JSON".into())
    })?;
    tracing::debug!(
        bytes = bytes.len(),
        elapsed_ms = started.elapsed().as_millis(),
        "OpenProject HTTP request completed"
    );
    Ok(response)
}
