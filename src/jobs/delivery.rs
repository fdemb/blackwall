use super::{Content, DeliveryError, Digest, Mailer};
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
    Digest(Digest),
    Webhook(Webhook),
    Reminder(Reminder),
    Tracker(crate::tracker::TrackerJob),
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
    #[serde(default)]
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
    pub event: serde_json::Value,
}

impl Job {
    pub fn kind(&self) -> &'static str {
        match self {
            Job::Email(_) => "email",
            Job::Digest(_) => "digest",
            Job::Webhook(_) => "webhook",
            Job::Reminder(_) => "reminder",
            Job::Tracker(_) => "tracker",
        }
    }

    pub fn queue(&self) -> &'static str {
        match self {
            Job::Email(_) | Job::Digest(_) => "email",
            Job::Webhook(_) => "webhook",
            Job::Reminder(_) => "database",
            Job::Tracker(_) => "tracker",
        }
    }

    pub fn payload(&self) -> serde_json::Result<String> {
        match self {
            Job::Email(email) => serde_json::to_string(email),
            Job::Digest(digest) => serde_json::to_string(digest),
            Job::Webhook(webhook) => serde_json::to_string(webhook),
            Job::Reminder(reminder) => serde_json::to_string(reminder),
            Job::Tracker(job) => serde_json::to_string(job),
        }
    }

    pub fn decode(kind: &str, payload: &str) -> Result<Self, String> {
        match kind {
            "email" => serde_json::from_str(payload).map(Job::Email),
            "digest" => serde_json::from_str(payload).map(Job::Digest),
            "webhook" => serde_json::from_str(payload).map(Job::Webhook),
            "reminder" => serde_json::from_str(payload).map(Job::Reminder),
            "tracker" => serde_json::from_str(payload).map(Job::Tracker),
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
        match self {
            Job::Email(email) => {
                if email.token.is_empty() {
                    return Err(DeliveryError::Permanent(
                        "email token is missing; ask the user to request a new link",
                    ));
                }
                if !self.is_current(store, id).await? {
                    return Ok(());
                }
                mailer.send(id, Content::Grant(email)).await
            }
            Job::Digest(digest) => match digest.summary(store).await? {
                Some(summary) => mailer.send(id, Content::Digest(&summary)).await,
                None => Ok(()),
            },
            Job::Webhook(webhook) => {
                let Some(secret) = webhook.current_secret(store).await? else {
                    return Ok(());
                };
                send_webhook(id, webhook, &secret).await
            }
            Job::Tracker(_) => Err(DeliveryError::Permanent(
                "tracker jobs require a fenced transaction",
            )),
            Job::Reminder(_) => Err(DeliveryError::Permanent(
                "reminders require a queue transaction",
            )),
        }
    }

    async fn is_current(&self, store: &Store, id: &str) -> Result<bool, DeliveryError> {
        let result = match self {
            Job::Email(Email {
                grant:
                    Grant::Invitation {
                        workspace_id,
                        invitation_id,
                        token_hash,
                    },
                ..
            }) => {
                sqlx::query_scalar::<_, bool>(
                    "SELECT EXISTS(SELECT 1 FROM invitations \
                     WHERE workspace_id=$1 AND id=$2 AND token_hash=$3 \
                     AND state='pending' AND expires_at>clock_timestamp())",
                )
                .bind(workspace_id)
                .bind(invitation_id)
                .bind(token_hash)
                .fetch_one(&store.pool)
                .await
            }
            Job::Email(Email {
                grant:
                    Grant::Reset {
                        user_id,
                        token_hash,
                    },
                ..
            }) => {
                sqlx::query_scalar::<_, bool>(
                    "SELECT EXISTS(SELECT 1 FROM password_resets \
                     WHERE user_id=$1 AND token_hash=$2 AND expires_at>clock_timestamp())",
                )
                .bind(user_id)
                .bind(token_hash)
                .fetch_one(&store.pool)
                .await
            }
            _ => return Ok(true),
        };

        result.map_err(|error| {
            tracing::warn!(job = %id, error = %error, "delivery grant lookup failed");
            DeliveryError::Transient("delivery grant lookup failed")
        })
    }
}

impl Webhook {
    pub async fn current_secret(&self, store: &Store) -> Result<Option<String>, DeliveryError> {
        sqlx::query_scalar::<_, String>(
            "SELECT secret FROM integrations \
             WHERE workspace_id=$1 AND id=$2 AND enabled AND webhook_url=$3",
        )
        .bind(self.workspace_id)
        .bind(self.integration_id)
        .bind(&self.url)
        .fetch_optional(&store.pool)
        .await
        .map_err(|error| {
            tracing::warn!(integration = %self.integration_id, error = %error, "webhook secret lookup failed");
            DeliveryError::Transient("delivery grant lookup failed")
        })
    }
}

fn signature(secret: &[u8], body: &[u8]) -> String {
    use hmac::{Hmac, Mac};
    use sha2::Sha256;

    let mut mac = Hmac::<Sha256>::new_from_slice(secret).expect("HMAC accepts any key length");
    mac.update(body);
    format!("sha256={}", hex::encode(mac.finalize().into_bytes()))
}

async fn send_webhook(id: &str, webhook: &Webhook, secret: &str) -> Result<(), DeliveryError> {
    let url = reqwest::Url::parse(&webhook.url)
        .map_err(|_| DeliveryError::Permanent("invalid webhook URL"))?;
    if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() {
        return Err(DeliveryError::Permanent(
            "webhooks require HTTPS without URL credentials",
        ));
    }

    let body = serde_json::to_vec(&webhook.event)
        .map_err(|_| DeliveryError::Permanent("invalid webhook event"))?;

    let signature = signature(secret.as_bytes(), &body);

    let client = webhook_client(id, &url).await?;
    let mut request = client
        .post(url)
        .header("Content-Type", "application/json")
        .header("Idempotency-Key", id)
        .header("X-Blackwall-Signature", signature);
    // Jobs queued before typed events carry no type.
    if let Some(kind) = webhook.event["type"].as_str() {
        request = request.header("X-Blackwall-Event", kind);
    }
    let response = request.body(body).send().await.map_err(|error| {
        let timeout = error.is_timeout();
        let connect = error.is_connect();
        let status = error.status();
        tracing::warn!(
            job = %id,
            error = %error.without_url(),
            timeout,
            connect,
            status = ?status,
            "webhook request failed"
        );
        DeliveryError::Transient("webhook request failed")
    })?;

    let status = response.status();

    if status.is_success() {
        Ok(())
    } else if status.is_server_error() || matches!(status.as_u16(), 408 | 425 | 429) {
        tracing::warn!(
            job = %id,
            status = status.as_u16(),
            "webhook temporarily rejected delivery"
        );
        Err(DeliveryError::Transient(
            "webhook temporarily rejected delivery",
        ))
    } else {
        tracing::warn!(job = %id, status = status.as_u16(), "webhook rejected delivery");
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

async fn webhook_client(id: &str, url: &reqwest::Url) -> Result<reqwest::Client, DeliveryError> {
    let host = url
        .host_str()
        .ok_or(DeliveryError::Permanent("webhook host missing"))?;

    let addresses: Vec<SocketAddr> =
        tokio::net::lookup_host((host, url.port_or_known_default().unwrap_or(443)))
            .await
            .map_err(|error| {
                tracing::warn!(job = %id, error = %error, "webhook DNS failed");
                DeliveryError::Transient("webhook DNS failed")
            })?
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
        .map_err(|error| {
            let timeout = error.is_timeout();
            let connect = error.is_connect();
            let status = error.status();
            tracing::warn!(
                job = %id,
                error = %error.without_url(),
                timeout,
                connect,
                status = ?status,
                "webhook client failed"
            );
            DeliveryError::Transient("webhook client failed")
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn webhook_signature_matches_rfc4231_case2() {
        assert_eq!(
            super::signature(b"Jefe", b"what do ya want for nothing?"),
            "sha256=5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"
        );
    }

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

        let user = Uuid::new_v4();
        let notification = Uuid::new_v4();
        let digest = format!(
            r#"{{"workspace_id":"{workspace}","user_id":"{user}","notification_ids":["{notification}"]}}"#
        );
        let decoded = Job::decode("digest", &digest).unwrap();
        assert_eq!(decoded.queue(), "email");
        assert!(matches!(
            decoded,
            Job::Digest(Digest { user_id, notification_ids, .. })
                if user_id == user && notification_ids == [notification]
        ));

        assert!(Job::decode("email", "{}").is_err());
        assert!(Job::decode("digest", "{}").is_err());
        assert!(Job::decode("unknown_kind", "{}").is_err());
    }
}
