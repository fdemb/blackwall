use super::{DeliveryError, Mailer};
use crate::store::Store;
use serde::{Deserialize, Serialize};
use std::{
    net::{IpAddr, SocketAddr},
    time::Duration,
};
use uuid::Uuid;

/// Work stored in the outbox. `kind` and the serialized payload are the persisted row format,
/// and the email payload is also what the development spool writes.
#[derive(Clone, Debug)]
pub enum Job {
    Email(Email),
    Webhook(Webhook),
    Reminder(Reminder),
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Reminder {
    pub workspace_id: Uuid,
    pub issue_id: Uuid,
    pub generation: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Email {
    pub to: String,
    pub subject: String,
    pub token: String,
    #[serde(flatten)]
    pub grant: Grant,
}

/// The credential an email carries. Delivery skips the email once the credential is no longer live.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Grant {
    Invitation {
        workspace_id: Uuid,
        invitation_id: Uuid,
        token_hash: String,
    },
    Reset {
        user_id: Uuid,
        token_hash: String,
    },
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Webhook {
    pub workspace_id: Uuid,
    pub integration_id: Uuid,
    pub url: String,
    pub secret: String,
    pub event: serde_json::Value,
}

impl Job {
    pub fn kind(&self) -> &'static str {
        match self {
            Job::Email(_) => "email",
            Job::Webhook(_) => "webhook",
            Job::Reminder(_) => "reminder",
        }
    }

    pub fn queue(&self) -> &'static str {
        match self {
            Job::Email(_) => "email",
            Job::Webhook(_) => "webhook",
            Job::Reminder(_) => "database",
        }
    }

    pub fn payload(&self) -> serde_json::Result<String> {
        match self {
            Job::Email(email) => serde_json::to_string(email),
            Job::Webhook(webhook) => serde_json::to_string(webhook),
            Job::Reminder(reminder) => serde_json::to_string(reminder),
        }
    }

    pub fn decode(kind: &str, payload: &str) -> Result<Self, String> {
        match kind {
            "email" => serde_json::from_str(payload).map(Job::Email),
            "webhook" => serde_json::from_str(payload).map(Job::Webhook),
            "reminder" => serde_json::from_str(payload).map(Job::Reminder),
            _ => return Err("unknown job kind".into()),
        }
        .map_err(|_| "invalid job payload".into())
    }

    /// Credential and integration checks read only the affected rows.
    pub async fn deliver(
        &self,
        store: &Store,
        mailer: &Mailer,
        id: &str,
    ) -> Result<(), DeliveryError> {
        if !self.is_current(store).await? {
            return Ok(());
        }
        match self {
            Job::Email(email) => mailer.send(id, email).await,
            Job::Webhook(webhook) => send_webhook(id, webhook).await,
            Job::Reminder(_) => Err(DeliveryError::Permanent(
                "reminders require a queue transaction",
            )),
        }
    }

    async fn is_current(&self, store: &Store) -> Result<bool, DeliveryError> {
        let result = match self {
            Job::Email(Email { grant: Grant::Invitation { workspace_id, invitation_id, token_hash }, .. }) => {
                sqlx::query_scalar::<_, bool>("SELECT EXISTS(SELECT 1 FROM invitations WHERE workspace_id=$1 AND id=$2 AND token_hash=$3 AND state='pending' AND expires_at>clock_timestamp())")
                    .bind(workspace_id).bind(invitation_id).bind(token_hash).fetch_one(&store.pool).await
            }
            Job::Email(Email { grant: Grant::Reset { user_id, token_hash }, .. }) => {
                sqlx::query_scalar::<_, bool>("SELECT EXISTS(SELECT 1 FROM password_resets WHERE user_id=$1 AND token_hash=$2 AND expires_at>clock_timestamp())")
                    .bind(user_id).bind(token_hash).fetch_one(&store.pool).await
            }
            Job::Webhook(webhook) => {
                sqlx::query_scalar::<_, bool>("SELECT EXISTS(SELECT 1 FROM integrations WHERE workspace_id=$1 AND id=$2 AND enabled AND webhook_url=$3 AND secret=$4)")
                    .bind(webhook.workspace_id).bind(webhook.integration_id).bind(&webhook.url).bind(&webhook.secret).fetch_one(&store.pool).await
            }
            Job::Reminder(_) => return Ok(true),
        };
        result.map_err(|_| DeliveryError::Transient("delivery grant lookup failed"))
    }
}

async fn send_webhook(id: &str, webhook: &Webhook) -> Result<(), DeliveryError> {
    use hmac::{Hmac, Mac};
    use sha2::Sha256;
    let url = reqwest::Url::parse(&webhook.url)
        .map_err(|_| DeliveryError::Permanent("invalid webhook URL"))?;
    if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() {
        return Err(DeliveryError::Permanent(
            "webhooks require HTTPS without URL credentials",
        ));
    }
    let body = serde_json::to_vec(&webhook.event)
        .map_err(|_| DeliveryError::Permanent("invalid webhook event"))?;
    let mut mac = Hmac::<Sha256>::new_from_slice(webhook.secret.as_bytes())
        .map_err(|_| DeliveryError::Permanent("invalid webhook secret"))?;
    mac.update(&body);
    let client = webhook_client(&url).await?;
    let response = client
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
        .map_err(|_| DeliveryError::Transient("webhook request failed"))?;
    let status = response.status();
    if status.is_success() {
        Ok(())
    } else if status.is_server_error() || matches!(status.as_u16(), 408 | 425 | 429) {
        Err(DeliveryError::Transient(
            "webhook temporarily rejected delivery",
        ))
    } else {
        Err(DeliveryError::Permanent("webhook rejected delivery"))
    }
}

// Each clause names one excluded range, which reads better than clippy's merged form.
#[allow(clippy::nonminimal_bool)]
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
async fn webhook_client(url: &reqwest::Url) -> Result<reqwest::Client, DeliveryError> {
    let host = url
        .host_str()
        .ok_or(DeliveryError::Permanent("webhook host missing"))?;
    let addresses: Vec<SocketAddr> =
        tokio::net::lookup_host((host, url.port_or_known_default().unwrap_or(443)))
            .await
            .map_err(|_| DeliveryError::Transient("webhook DNS failed"))?
            .collect();
    if addresses.is_empty() || addresses.iter().any(|a| !public_address(a.ip())) {
        return Err(DeliveryError::Permanent(
            "webhook must resolve to public addresses",
        ));
    }
    reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .resolve_to_addrs(host, &addresses)
        .build()
        .map_err(|_| DeliveryError::Transient("webhook client failed"))
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
    #[test]
    fn decodes_stored_rows() {
        let workspace = Uuid::new_v4();
        let invitation = Uuid::new_v4();
        let invite = format!(
            r#"{{"to":"a@example.com","subject":"Join","workspace_id":"{workspace}","invitation_id":"{invitation}","token_hash":"h","token":"t"}}"#
        );
        assert!(matches!(
            Job::decode("email", &invite),
            Ok(Job::Email(Email { grant: Grant::Invitation { invitation_id, .. }, .. })) if invitation_id == invitation
        ));
        let reset = format!(
            r#"{{"to":"a@example.com","subject":"Reset","user_id":"{workspace}","token_hash":"h","token":"t"}}"#
        );
        assert!(matches!(
            Job::decode("email", &reset),
            Ok(Job::Email(Email {
                grant: Grant::Reset { .. },
                ..
            }))
        ));
        assert!(Job::decode("email", "{}").is_err());
        assert!(Job::decode("unknown_kind", "{}").is_err());
    }
}
