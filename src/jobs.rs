use crate::{
    error::{Error, Result},
    store::Store,
};
use chrono::Utc;
use sqlx::Row;
use std::{
    net::{IpAddr, SocketAddr},
    time::Duration,
};
use tokio::sync::watch;

pub async fn run(store: Store, mut shutdown: watch::Receiver<bool>) -> Result<()> {
    let mut interval = tokio::time::interval(Duration::from_secs(30));
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        tokio::select! {
            _=async { interval.tick().await; if let Err(error)=tick(&store).await{tracing::error!(%error,"scheduled work failed");} }=>{},
            changed=shutdown.changed()=>{if changed.is_err()||*shutdown.borrow(){break;}}
        }
    }
    Ok(())
}

pub async fn tick(store: &Store) -> Result<()> {
    let now = Utc::now();
    for id in store.workspace_ids(None).await? {
        let (mut workspace, revision) = store.load_workspace(id).await?;
        let before = workspace.clone();
        if workspace.tick(now) {
            crate::auth::filter_notifications(store, &before, &mut workspace).await?;
            if serde_json::to_value(&workspace)? == serde_json::to_value(&before)? {
                continue;
            }
            match store.save_workspace(&workspace, revision).await {
                Ok(_) => {}
                Err(Error::Conflict(_)) => {}
                Err(e) => return Err(e),
            }
        }
    }
    sqlx::query("DELETE FROM sessions WHERE expires_at <= $1")
        .bind(now.timestamp())
        .execute(&store.pool)
        .await?;
    sqlx::query("DELETE FROM password_resets WHERE expires_at <= $1")
        .bind(now.timestamp())
        .execute(&store.pool)
        .await?;
    let rows=sqlx::query("SELECT id,kind,payload,attempts FROM outbox WHERE delivered_at=0 AND due_at <= $1 AND lease_until <= $1 ORDER BY due_at,id LIMIT 20").bind(now.timestamp()).fetch_all(&store.pool).await?;
    for row in rows {
        let id: String = row.try_get("id")?;
        let claim_time = Utc::now().timestamp();
        let lease = claim_time + 120;
        let claimed=sqlx::query("UPDATE outbox SET lease_until=$1,attempts=attempts+1 WHERE id=$2 AND delivered_at=0 AND lease_until <= $3 AND due_at <= $3").bind(lease).bind(&id).bind(claim_time).execute(&store.pool).await?;
        if claimed.rows_affected() != 1 {
            continue;
        }
        let kind: String = row.try_get("kind")?;
        let payload: serde_json::Value = serde_json::from_str(row.try_get::<&str, _>("payload")?)?;
        let attempts: i64 = row.try_get("attempts")?;
        match tokio::time::timeout(
            Duration::from_secs(45),
            deliver_current(store, &id, &kind, &payload),
        )
        .await
        .unwrap_or_else(|_| Err("delivery timed out".into()))
        {
            Ok(()) => {
                sqlx::query("UPDATE outbox SET delivered_at=$1,lease_until=0,last_error='' WHERE id=$2 AND lease_until=$3").bind(Utc::now().timestamp()).bind(&id).bind(lease).execute(&store.pool).await?;
            }
            Err(error) => {
                let delay = 30_i64
                    .saturating_mul(2_i64.pow((attempts as u32).min(11)))
                    .min(86400);
                // Error text excludes tokens and URLs that may contain secrets.
                tracing::warn!(job=%id,kind=%kind,"delivery failed; retry scheduled");
                sqlx::query("UPDATE outbox SET due_at=$1,lease_until=0,last_error=$2 WHERE id=$3 AND lease_until=$4").bind(Utc::now().timestamp()+delay).bind(error).bind(&id).bind(lease).execute(&store.pool).await?;
            }
        }
    }
    Ok(())
}

fn public_address(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            let o = ip.octets();
            !ip.is_private()
                && !ip.is_loopback()
                && !ip.is_link_local()
                && !ip.is_broadcast()
                && !ip.is_documentation()
                && !ip.is_unspecified()
                && !ip.is_multicast()
                && o[0] != 0
                && o[0] < 224
                && !(o[0] == 100 && (64..=127).contains(&o[1]))
                && !(o[0] == 198 && (18..=19).contains(&o[1]))
        }
        IpAddr::V6(ip) => {
            let s = ip.segments();
            if let Some(v4) = ip.to_ipv4_mapped() {
                return public_address(IpAddr::V4(v4));
            }
            !ip.is_loopback()
                && !ip.is_unspecified()
                && !ip.is_multicast()
                && s[0] & 0xfe00 != 0xfc00
                && s[0] & 0xffc0 != 0xfe80
                && !(s[0] == 0x2001 && s[1] == 0x0db8)
                && s[0] & 0xe000 == 0x2000
        }
    }
}
async fn webhook_client(url: &reqwest::Url) -> std::result::Result<reqwest::Client, String> {
    let host = url.host_str().ok_or("webhook host missing")?;
    let addresses: Vec<SocketAddr> =
        tokio::net::lookup_host((host, url.port_or_known_default().unwrap_or(443)))
            .await
            .map_err(|_| "webhook DNS failed")?
            .collect();
    if addresses.is_empty() || addresses.iter().any(|a| !public_address(a.ip())) {
        return Err("webhook must resolve to public addresses".into());
    }
    reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .resolve_to_addrs(host, &addresses)
        .build()
        .map_err(|_| "webhook client failed".into())
}
async fn deliver_current(
    store: &Store,
    id: &str,
    kind: &str,
    payload: &serde_json::Value,
) -> std::result::Result<(), String> {
    if let Some(workspace_id) = payload["workspace_id"].as_str() {
        let id = uuid::Uuid::parse_str(workspace_id).map_err(|_| "invalid workspace job")?;
        let (workspace, _) = store
            .load_workspace(id)
            .await
            .map_err(|_| "workspace unavailable")?;
        if kind == "email" {
            let valid = workspace.invitations.iter().any(|i| {
                i.id.to_string() == payload["invitation_id"].as_str().unwrap_or("")
                    && i.state == crate::domain::InvitationState::Pending
                    && i.expires_at > Utc::now()
                    && i.token_hash == payload["token_hash"].as_str().unwrap_or("")
            });
            if !valid {
                return Ok(());
            }
        } else if kind == "webhook" {
            let valid = workspace.integrations.iter().any(|i| {
                i.id.to_string() == payload["integration_id"].as_str().unwrap_or("")
                    && i.enabled
                    && i.webhook_url == payload["url"].as_str().unwrap_or("")
                    && i.secret == payload["secret"].as_str().unwrap_or("")
            });
            if !valid {
                return Ok(());
            }
        }
    }
    if kind == "email" && payload["user_id"].is_string() {
        let live=sqlx::query("SELECT token_hash FROM password_resets WHERE user_id=$1 AND token_hash=$2 AND expires_at>$3").bind(payload["user_id"].as_str().unwrap_or("")).bind(payload["token_hash"].as_str().unwrap_or("")).bind(Utc::now().timestamp()).fetch_optional(&store.pool).await.map_err(|_|"recovery lookup failed")?;
        if live.is_none() {
            return Ok(());
        }
    }
    deliver(id, kind, payload).await
}

async fn deliver(
    id: &str,
    kind: &str,
    payload: &serde_json::Value,
) -> std::result::Result<(), String> {
    match kind {
        "email" => {
            if let Ok(directory) = std::env::var("DEV_MAIL_DIR") {
                tokio::fs::create_dir_all(&directory)
                    .await
                    .map_err(|_| "mail spool unavailable")?;
                let path = std::path::Path::new(&directory)
                    .join(format!("{}.json", crate::auth::hash(id)));
                use tokio::io::AsyncWriteExt;
                let mut options = tokio::fs::OpenOptions::new();
                options.write(true).create(true).truncate(true);
                #[cfg(unix)]
                options.mode(0o600);
                let mut file = options
                    .open(path)
                    .await
                    .map_err(|_| "mail spool write failed")?;
                file.write_all(payload.to_string().as_bytes())
                    .await
                    .map_err(|_| "mail spool write failed")?;
                return Ok(());
            }
            let endpoint = std::env::var("EMAIL_WEBHOOK_URL")
                .map_err(|_| "email adapter is not configured")?;
            let client = reqwest::Client::builder()
                .timeout(Duration::from_secs(15))
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .map_err(|_| "email client failed")?;
            let mut request = client
                .post(endpoint)
                .header("Idempotency-Key", id)
                .json(payload);
            if let Ok(token) = std::env::var("EMAIL_WEBHOOK_TOKEN") {
                request = request.bearer_auth(token);
            }
            request
                .send()
                .await
                .map_err(|_| "email adapter request failed")?
                .error_for_status()
                .map_err(|_| "email adapter rejected delivery")?;
            Ok(())
        }
        "webhook" => {
            use hmac::{Hmac, Mac};
            use sha2::Sha256;
            let url = reqwest::Url::parse(payload["url"].as_str().ok_or("webhook URL missing")?)
                .map_err(|_| "invalid webhook URL")?;
            if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() {
                return Err("webhooks require HTTPS without URL credentials".into());
            }
            let body =
                serde_json::to_vec(&payload["event"]).map_err(|_| "invalid webhook event")?;
            let mut mac = Hmac::<Sha256>::new_from_slice(
                payload["secret"]
                    .as_str()
                    .ok_or("webhook secret missing")?
                    .as_bytes(),
            )
            .map_err(|_| "invalid webhook secret")?;
            mac.update(&body);
            let client = webhook_client(&url).await?;
            client
                .post(url)
                .header("Content-Type", "application/json")
                .header("Idempotency-Key", id)
                .header(
                    "X-Blackwall-Signature",
                    format!("sha256={}", hex::encode(mac.finalize().into_bytes())),
                )
                .body(body)
                .send()
                .await
                .map_err(|_| "webhook request failed")?
                .error_for_status()
                .map_err(|_| "webhook rejected delivery")?;
            Ok(())
        }
        _ => Err("unknown job kind".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn webhook_blocks_private_targets() {
        for address in [
            "127.0.0.1",
            "10.1.2.3",
            "169.254.169.254",
            "100.64.0.1",
            "::1",
            "fc00::1",
            "::ffff:127.0.0.1",
        ] {
            assert!(!public_address(address.parse().unwrap()));
        }
        assert!(public_address("1.1.1.1".parse().unwrap()));
    }
}
