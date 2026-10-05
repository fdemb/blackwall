use super::*;
use std::time::Duration;

pub(super) async fn fetch(
    base: &str,
    token: &str,
    path: &str,
    page: i64,
    filters: Option<Value>,
) -> Result<Value> {
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(20))
        .connect_timeout(Duration::from_secs(5))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| Error::Internal("OpenProject client failed".into()))?;
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
    let mut response = req
        .send()
        .await
        .map_err(|_| Error::Internal("OpenProject request failed".into()))?;
    if !response.status().is_success() {
        return Err(Error::Internal(format!(
            "OpenProject HTTP {}",
            response.status().as_u16()
        )));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| Error::Internal("OpenProject body failed".into()))?
    {
        if bytes.len() + chunk.len() > 2 * 1024 * 1024 {
            return Err(Error::Internal("OpenProject page exceeds 2 MiB".into()));
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes)
        .map_err(|_| Error::Internal("OpenProject returned invalid JSON".into()))
}
