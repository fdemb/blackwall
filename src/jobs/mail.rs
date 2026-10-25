use super::{
    DeliveryError, Email, Grant,
    digest::{Entry, Summary},
};
use crate::domain::AlertKind;
use lettre::{
    AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor,
    message::{Mailbox, header::ContentType},
};
use reqwest::Url;
use serde::Serialize;
use std::{path::PathBuf, time::Duration};

/// Where email jobs go. Configured once at startup from the environment.
#[derive(Clone)]
pub enum Mailer {
    Smtp {
        transport: AsyncSmtpTransport<Tokio1Executor>,
        from: Mailbox,
        public_url: Option<Url>,
    },
    /// Writes each email as JSON to a private directory instead of sending it: the job payload for
    /// invitations and resets, so scripts can read the token, and the rendered text for digests.
    Spool(PathBuf),
    /// Email jobs stay pending until mail is configured.
    Disabled,
}

impl Mailer {
    /// `DEV_MAIL_DIR` selects the spool. `SMTP_URL` and `SMTP_FROM` configure SMTP,
    /// for example `smtps://user:password@smtp.example.com` or
    /// `smtp://smtp.example.com:587?tls=required`.
    /// `DEV_MAIL_DIR` and `SMTP_URL` are mutually exclusive. `PUBLIC_URL`, such as
    /// `https://blackwall.example.com`, puts links in emails.
    pub fn from_env() -> Result<Self, String> {
        let directory = std::env::var("DEV_MAIL_DIR").ok();
        let url = std::env::var("SMTP_URL").ok();
        let from = std::env::var("SMTP_FROM").ok();
        let public_url = std::env::var("PUBLIC_URL").ok();
        Self::from_config(
            directory.as_deref(),
            url.as_deref(),
            from.as_deref(),
            public_url.as_deref(),
        )
    }

    fn from_config(
        directory: Option<&str>,
        url: Option<&str>,
        from: Option<&str>,
        public_url: Option<&str>,
    ) -> Result<Self, String> {
        if directory.is_some() && url.is_some() {
            return Err("set either DEV_MAIL_DIR or SMTP_URL, not both".into());
        }

        if let Some(directory) = directory {
            return Ok(Self::Spool(directory.into()));
        }

        let Some(url) = url else {
            return Ok(Self::Disabled);
        };
        let public_url = public_url.map(parse_public_url).transpose()?;
        let from = from
            .ok_or("SMTP_FROM is required with SMTP_URL")?
            .parse()
            .map_err(|_| "SMTP_FROM must be an address like Blackwall <noreply@example.com>")?;

        // The URL can hold credentials, so errors leave it out.
        let transport = AsyncSmtpTransport::<Tokio1Executor>::from_url(url)
            .map_err(|_| "SMTP_URL is not a valid smtp:// or smtps:// URL")?
            .timeout(Some(Duration::from_secs(15)))
            .build();

        Ok(Self::Smtp {
            transport,
            from,
            public_url,
        })
    }

    pub fn describe(&self) -> &'static str {
        match self {
            Self::Smtp { .. } => "smtp",
            Self::Spool(_) => "development spool",
            Self::Disabled => "disabled",
        }
    }

    pub fn lacks_links(&self) -> bool {
        matches!(
            self,
            Self::Smtp {
                public_url: None,
                ..
            }
        )
    }

    pub fn enabled(&self) -> bool {
        !matches!(self, Self::Disabled)
    }

    pub(super) async fn send(&self, id: &str, content: Content<'_>) -> Result<(), DeliveryError> {
        match self {
            Self::Smtp {
                transport,
                from,
                public_url,
            } => {
                let letter = content.letter(public_url.as_ref());
                let message = message(id, from, &letter).map_err(DeliveryError::Permanent)?;
                transport.send(message).await.map_err(|error| {
                    if error.is_permanent() {
                        tracing::warn!(
                            job = %id,
                            status = ?error.status(),
                            timeout = error.is_timeout(),
                            tls = error.is_tls(),
                            "smtp server rejected the message"
                        );
                        DeliveryError::Permanent("smtp server rejected the message")
                    } else {
                        tracing::warn!(
                            job = %id,
                            status = ?error.status(),
                            timeout = error.is_timeout(),
                            tls = error.is_tls(),
                            "smtp delivery failed"
                        );
                        DeliveryError::Transient("smtp delivery failed")
                    }
                })?;

                Ok(())
            }
            Self::Spool(directory) => {
                let payload = match content {
                    Content::Grant(email) => serde_json::to_vec(email),
                    Content::Digest(_) => serde_json::to_vec(&content.letter(None)),
                }
                .map_err(|_| DeliveryError::Permanent("invalid email"))?;
                spool(directory, id, &payload)
                    .await
                    .map_err(DeliveryError::Transient)
            }
            Self::Disabled => Err(DeliveryError::Transient("email is not configured")),
        }
    }
}

/// Ends the path with a slash so joining keeps a subpath such as `/blackwall/`.
fn parse_public_url(value: &str) -> Result<Url, String> {
    let invalid = || "PUBLIC_URL must be an http:// or https:// URL without a query".to_string();
    let mut url = Url::parse(value).map_err(|_| invalid())?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host().is_none()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(invalid());
    }
    if !url.path().ends_with('/') {
        url.set_path(&format!("{}/", url.path()));
    }
    Ok(url)
}

fn link(public_url: &Url, path: &str, query: &[(&str, &str)]) -> String {
    let mut url = public_url.join(path).expect("relative path joins");
    url.query_pairs_mut().extend_pairs(query);
    url.into()
}

/// What an email job says, before the mailer renders it.
pub(super) enum Content<'a> {
    Grant(&'a Email),
    Digest(&'a Summary),
}

#[derive(Serialize)]
struct Letter {
    to: String,
    subject: String,
    body: String,
}

impl Content<'_> {
    fn letter(&self, public_url: Option<&Url>) -> Letter {
        match self {
            Content::Grant(email) => Letter {
                to: email.to.clone(),
                subject: email.subject.clone(),
                body: body(email, public_url),
            },
            Content::Digest(summary) => Letter {
                to: summary.to.clone(),
                subject: digest_subject(summary),
                body: digest_body(summary, public_url),
            },
        }
    }
}

fn message(id: &str, from: &Mailbox, letter: &Letter) -> Result<Message, &'static str> {
    // Stable across retries. SMTP still permits duplicate delivery.
    let message_id = format!("<{}@{}>", crate::auth::hash(id), from.email.domain());

    Message::builder()
        .from(from.clone())
        .to(letter.to.parse().map_err(|_| "invalid recipient address")?)
        .subject(&letter.subject)
        .message_id(Some(message_id))
        .header(ContentType::TEXT_PLAIN)
        .body(letter.body.clone())
        .map_err(|_| "invalid email")
}

fn body(email: &Email, public_url: Option<&Url>) -> String {
    match (&email.grant, public_url) {
        (Grant::Invitation { workspace_id, .. }, Some(public_url)) => format!(
            "You've been invited to a Blackwall workspace.\n\n\
             Open this link to join. Sign in or register with this email address first if \
             Blackwall asks you to:\n\n\
             {}\n\n\
             The link works for seven days. If you weren't expecting this invitation, you can \
             ignore this email.\n",
            link(
                public_url,
                "welcome",
                &[
                    ("workspace", &workspace_id.to_string()),
                    ("token", &email.token)
                ]
            )
        ),
        (Grant::Invitation { workspace_id, .. }, None) => format!(
            "You've been invited to a Blackwall workspace.\n\n\
             Sign in or register with this email address. On the welcome page, choose Join \
             workspace and enter:\n\n\
             Workspace ID: {workspace_id}\n\
             Invitation token: {}\n\n\
             If you weren't expecting this invitation, you can ignore this email.\n",
            email.token
        ),
        (Grant::Reset { .. }, Some(public_url)) => format!(
            "Someone asked to reset the password for your Blackwall account.\n\n\
             Open this link within one hour to choose a new password:\n\n\
             {}\n\n\
             If you didn't ask for this, ignore this email. Your password stays the same.\n",
            link(public_url, "recover", &[("token", &email.token)])
        ),
        (Grant::Reset { .. }, None) => format!(
            "Someone asked to reset the password for your Blackwall account.\n\n\
             Enter this recovery token on the password recovery page within one hour:\n\n\
             {}\n\n\
             If you didn't ask for this, ignore this email. Your password stays the same.\n",
            email.token
        ),
        (Grant::Verification { .. }, Some(public_url)) => format!(
            "Someone registered a Blackwall account with this email address.\n\n\
             Open this link within 24 hours to verify it:\n\n\
             {}\n\n\
             If you didn't register, ignore this email.\n",
            link(public_url, "verify", &[("token", &email.token)])
        ),
        (Grant::Verification { .. }, None) => format!(
            "Someone registered a Blackwall account with this email address.\n\n\
             Enter this verification token on the email verification page within 24 hours:\n\n\
             {}\n\n\
             If you didn't register, ignore this email.\n",
            email.token
        ),
    }
}

/// Issue fields as the inbox names them, in its order.
const FIELD_LABELS: [(&str, &str); 14] = [
    ("title", "title"),
    ("description", "description"),
    ("team", "team"),
    ("stage", "status"),
    ("assignee", "assignee"),
    ("priority", "priority"),
    ("labels", "labels"),
    ("estimate", "estimate"),
    ("deadline", "deadline"),
    ("project", "project"),
    ("milestone", "milestone"),
    ("sprint", "sprint"),
    ("parent", "parent"),
    ("dependencies", "dependencies"),
];

impl Entry {
    /// What happened, worded to precede the issue key.
    fn headline(&self) -> String {
        let actor = self.actor.as_deref().unwrap_or("Someone");
        match self.kind {
            AlertKind::Assignment => format!("{actor} assigned you"),
            AlertKind::Reply => format!("{actor} replied on"),
            AlertKind::Mention => format!("{actor} mentioned you on"),
            AlertKind::Deadline => "Deadline is near for".into(),
            AlertKind::Change => {
                let fields: Vec<&str> = FIELD_LABELS
                    .iter()
                    .filter(|(name, _)| self.fields.iter().any(|field| field == name))
                    .map(|(_, label)| *label)
                    .collect();
                if fields.is_empty() {
                    format!("{actor} updated")
                } else {
                    format!("{actor} changed {} on", fields.join(", "))
                }
            }
        }
    }
}

fn digest_subject(summary: &Summary) -> String {
    match summary.entries.as_slice() {
        [entry] => format!("{} {}", entry.headline(), entry.key),
        entries => format!(
            "{} new notifications in {}",
            entries.len(),
            summary.workspace
        ),
    }
}

fn digest_body(summary: &Summary, public_url: Option<&Url>) -> String {
    let mut text = match summary.entries.len() {
        1 => format!(
            "You have an unread notification in {}.\n",
            summary.workspace
        ),
        n => format!(
            "You have {n} unread notifications in {}.\n",
            summary.workspace
        ),
    };
    for entry in &summary.entries {
        text.push_str(&format!(
            "\n{} {}: {}\n",
            entry.headline(),
            entry.key,
            entry.title
        ));
        if let Some(public_url) = public_url {
            let url = public_url
                .join(&format!("{}/issue/{}", summary.slug, entry.key))
                .expect("relative path joins");
            text.push_str(&format!("{url}\n"));
        }
    }
    match public_url {
        Some(public_url) => {
            let url = public_url
                .join(&format!("{}/settings/notifications", summary.slug))
                .expect("relative path joins");
            text.push_str(&format!(
                "\nChoose which notifications Blackwall emails you:\n{url}\n"
            ));
        }
        None => text.push_str(
            "\nTo choose which notifications Blackwall emails you, open Settings, then \
             Notifications.\n",
        ),
    }
    text
}

async fn spool(directory: &PathBuf, id: &str, payload: &[u8]) -> Result<(), &'static str> {
    use tokio::io::AsyncWriteExt;

    tokio::fs::create_dir_all(directory)
        .await
        .map_err(|_| "mail spool unavailable")?;

    let path = directory.join(format!("{}.json", crate::auth::hash(id)));
    let mut options = tokio::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    options.mode(0o600);

    let mut file = options
        .open(path)
        .await
        .map_err(|_| "mail spool write failed")?;

    file.write_all(payload)
        .await
        .map_err(|_| "mail spool write failed")?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::{
        io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
        net::TcpListener,
    };
    use uuid::Uuid;

    #[test]
    fn rejects_spool_with_smtp() {
        let result =
            Mailer::from_config(Some("dev-mail"), Some("smtp://localhost:1025"), None, None);
        assert_eq!(
            result.err().as_deref(),
            Some("set either DEV_MAIL_DIR or SMTP_URL, not both")
        );
    }

    #[test]
    fn selects_spool() {
        let mailer = Mailer::from_config(Some("dev-mail"), None, None, None).unwrap();
        assert!(matches!(mailer, Mailer::Spool(path) if path == std::path::Path::new("dev-mail")));
    }

    #[tokio::test]
    async fn selects_smtp() {
        let mailer = Mailer::from_config(
            None,
            Some("smtp://localhost:1025"),
            Some("Blackwall <noreply@example.com>"),
            None,
        )
        .unwrap();
        assert!(
            matches!(mailer, Mailer::Smtp { from, .. } if from.to_string() == "Blackwall <noreply@example.com>")
        );
    }

    #[test]
    fn disables_unconfigured_mail() {
        let mailer = Mailer::from_config(None, None, None, None).unwrap();
        assert!(matches!(mailer, Mailer::Disabled));
    }

    #[test]
    fn requires_smtp_from() {
        let result = Mailer::from_config(None, Some("smtp://localhost:1025"), None, None);
        assert_eq!(
            result.err().as_deref(),
            Some("SMTP_FROM is required with SMTP_URL")
        );
    }

    #[test]
    fn rejects_invalid_smtp_from() {
        let result =
            Mailer::from_config(None, Some("smtp://localhost:1025"), Some("invalid"), None);
        assert_eq!(
            result.err().as_deref(),
            Some("SMTP_FROM must be an address like Blackwall <noreply@example.com>")
        );
    }

    #[test]
    fn rejects_invalid_public_url() {
        for value in [
            "blackwall.example.com",
            "ftp://blackwall.example.com",
            "https://blackwall.example.com/?a=1",
        ] {
            let result = Mailer::from_config(
                None,
                Some("smtp://localhost:1025"),
                Some("Blackwall <noreply@example.com>"),
                Some(value),
            );
            assert_eq!(
                result.err().as_deref(),
                Some("PUBLIC_URL must be an http:// or https:// URL without a query"),
                "{value}"
            );
            // Only SMTP mail carries links, so a bad value can't stop a server without it.
            assert!(Mailer::from_config(None, None, None, Some(value)).is_ok());
        }
    }

    fn email(grant: Grant) -> Email {
        Email {
            to: "colleague@example.com".into(),
            subject: "Subject".into(),
            token: "tok/en+1".into(),
            grant,
        }
    }

    #[test]
    fn links_invitation_to_welcome_page() {
        let workspace_id = Uuid::new_v4();
        let invitation = email(Grant::Invitation {
            workspace_id,
            invitation_id: Uuid::new_v4(),
            token_hash: "hash".into(),
        });

        for (public_url, expected) in [
            (
                "https://blackwall.example.com",
                "https://blackwall.example.com/welcome",
            ),
            (
                "https://example.com/blackwall",
                "https://example.com/blackwall/welcome",
            ),
        ] {
            let public_url = parse_public_url(public_url).unwrap();
            let text = body(&invitation, Some(&public_url));
            assert!(
                text.contains(&format!(
                    "{expected}?workspace={workspace_id}&token=tok%2Fen%2B1\n"
                )),
                "{text}"
            );
            assert!(!text.contains("Workspace ID"), "{text}");
        }
    }

    #[test]
    fn links_reset_to_recovery_page() {
        let reset = email(Grant::Reset {
            user_id: Uuid::new_v4(),
            token_hash: "hash".into(),
        });
        let public_url = parse_public_url("http://127.0.0.1:3000/").unwrap();

        let text = body(&reset, Some(&public_url));
        assert!(
            text.contains("http://127.0.0.1:3000/recover?token=tok%2Fen%2B1\n"),
            "{text}"
        );

        let text = body(&reset, None);
        assert!(text.contains("\n\ntok/en+1\n\n"), "{text}");
    }

    fn entry(kind: AlertKind, actor: Option<&str>, fields: &[&str], key: &str) -> Entry {
        Entry {
            kind,
            actor: actor.map(Into::into),
            fields: fields.iter().map(|field| field.to_string()).collect(),
            key: key.into(),
            title: format!("Title of {key}"),
        }
    }

    fn summary(entries: Vec<Entry>) -> Summary {
        Summary {
            to: "member@example.com".into(),
            workspace: "Acme".into(),
            slug: "acme".into(),
            entries,
        }
    }

    #[test]
    fn digest_links_each_notification_and_the_settings() {
        let digest = summary(vec![
            entry(AlertKind::Assignment, Some("Ana"), &[], "ENG-12"),
            entry(
                AlertKind::Change,
                None,
                &["assignee", "stage", "internal"],
                "ENG-3",
            ),
            entry(AlertKind::Change, Some("Ana"), &[], "ENG-4"),
            entry(AlertKind::Deadline, None, &[], "OPS-1"),
        ]);
        let public_url = parse_public_url("https://example.com/blackwall").unwrap();

        let letter = Content::Digest(&digest).letter(Some(&public_url));

        assert_eq!(letter.to, "member@example.com");
        assert_eq!(letter.subject, "4 new notifications in Acme");
        assert_eq!(
            letter.body,
            "You have 4 unread notifications in Acme.\n\
             \n\
             Ana assigned you ENG-12: Title of ENG-12\n\
             https://example.com/blackwall/acme/issue/ENG-12\n\
             \n\
             Someone changed status, assignee on ENG-3: Title of ENG-3\n\
             https://example.com/blackwall/acme/issue/ENG-3\n\
             \n\
             Ana updated ENG-4: Title of ENG-4\n\
             https://example.com/blackwall/acme/issue/ENG-4\n\
             \n\
             Deadline is near for OPS-1: Title of OPS-1\n\
             https://example.com/blackwall/acme/issue/OPS-1\n\
             \n\
             Choose which notifications Blackwall emails you:\n\
             https://example.com/blackwall/acme/settings/notifications\n"
        );
    }

    #[test]
    fn digest_without_public_url_names_the_settings_page() {
        let digest = summary(vec![entry(AlertKind::Mention, Some("Ana"), &[], "ENG-12")]);

        let letter = Content::Digest(&digest).letter(None);

        assert_eq!(letter.subject, "Ana mentioned you on ENG-12");
        assert_eq!(
            letter.body,
            "You have an unread notification in Acme.\n\
             \n\
             Ana mentioned you on ENG-12: Title of ENG-12\n\
             \n\
             To choose which notifications Blackwall emails you, open Settings, then \
             Notifications.\n"
        );
    }

    #[test]
    fn links_verification_to_verify_page() {
        let verification = email(Grant::Verification {
            user_id: Uuid::new_v4(),
            verification_hash: "hash".into(),
        });
        let public_url = parse_public_url("https://example.com/blackwall").unwrap();

        let text = body(&verification, Some(&public_url));
        assert!(
            text.contains("https://example.com/blackwall/verify?token=tok%2Fen%2B1\n"),
            "{text}"
        );

        let text = body(&verification, None);
        assert!(text.contains("verification page"), "{text}");
        assert!(text.contains("\n\ntok/en+1\n\n"), "{text}");
    }

    /// Accepts one SMTP session and returns the message data.
    async fn smtp_sink(listener: TcpListener) -> String {
        let (stream, _) = listener.accept().await.unwrap();
        let (read, mut write) = stream.into_split();
        let mut lines = BufReader::new(read).lines();

        write.write_all(b"220 sink ESMTP\r\n").await.unwrap();
        let mut data = None::<String>;

        while let Some(line) = lines.next_line().await.unwrap() {
            if let Some(received) = &mut data {
                if line == "." {
                    write.write_all(b"250 queued\r\n").await.unwrap();
                    return data.unwrap();
                }

                received.push_str(&line);
                received.push('\n');
                continue;
            }

            let reply: &[u8] = match line.to_ascii_uppercase().get(..4) {
                Some("EHLO") => b"250-sink\r\n250 8BITMIME\r\n",
                Some("DATA") => {
                    data = Some(String::new());
                    b"354 go ahead\r\n"
                }
                _ => b"250 ok\r\n",
            };
            write.write_all(reply).await.unwrap();
        }

        panic!("client closed before sending data");
    }

    #[tokio::test]
    async fn sends_invitation_over_smtp() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let sink = tokio::spawn(smtp_sink(listener));
        let mailer = Mailer::Smtp {
            transport: AsyncSmtpTransport::<Tokio1Executor>::builder_dangerous("127.0.0.1")
                .port(port)
                .build(),
            from: "Blackwall <noreply@example.com>".parse().unwrap(),
            public_url: None,
        };

        let workspace_id = Uuid::new_v4();
        let email = Email {
            to: "colleague@example.com".into(),
            subject: "Join a Blackwall workspace".into(),
            token: "invite-token-123".into(),
            grant: Grant::Invitation {
                workspace_id,
                invitation_id: Uuid::new_v4(),
                token_hash: "hash".into(),
            },
        };

        mailer.send("job-1", Content::Grant(&email)).await.unwrap();
        let data = sink.await.unwrap();

        assert!(data.contains("To: colleague@example.com"), "{data}");
        assert!(
            data.contains("Subject: Join a Blackwall workspace"),
            "{data}"
        );
        assert!(
            data.contains(&format!(
                "Message-ID: <{}@example.com>",
                crate::auth::hash("job-1")
            )),
            "{data}"
        );
        assert!(
            data.contains(&format!("Workspace ID: {workspace_id}")),
            "{data}"
        );
        assert!(
            data.contains("Invitation token: invite-token-123"),
            "{data}"
        );
    }
}
