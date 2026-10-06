use super::{DeliveryError, Email, Grant};
use lettre::{
    AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor,
    message::{Mailbox, header::ContentType},
};
use std::{path::PathBuf, time::Duration};

/// Where email jobs go. Configured once at startup from the environment.
#[derive(Clone)]
pub enum Mailer {
    Smtp {
        transport: AsyncSmtpTransport<Tokio1Executor>,
        from: Mailbox,
    },
    /// Writes each email's JSON payload to a private directory instead of sending it.
    Spool(PathBuf),
    /// Email jobs stay pending until mail is configured.
    Disabled,
}

impl Mailer {
    /// `DEV_MAIL_DIR` selects the spool. `SMTP_URL` and `SMTP_FROM` configure SMTP,
    /// for example `smtps://user:password@smtp.example.com` or
    /// `smtp://smtp.example.com:587?tls=required`.
    /// `DEV_MAIL_DIR` and `SMTP_URL` are mutually exclusive.
    pub fn from_env() -> Result<Self, String> {
        let directory = std::env::var("DEV_MAIL_DIR").ok();
        let url = std::env::var("SMTP_URL").ok();
        let from = std::env::var("SMTP_FROM").ok();
        Self::from_config(directory.as_deref(), url.as_deref(), from.as_deref())
    }

    fn from_config(
        directory: Option<&str>,
        url: Option<&str>,
        from: Option<&str>,
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
        let from = from
            .ok_or("SMTP_FROM is required with SMTP_URL")?
            .parse()
            .map_err(|_| "SMTP_FROM must be an address like Blackwall <noreply@example.com>")?;

        // The URL can hold credentials, so errors leave it out.
        let transport = AsyncSmtpTransport::<Tokio1Executor>::from_url(url)
            .map_err(|_| "SMTP_URL is not a valid smtp:// or smtps:// URL")?
            .timeout(Some(Duration::from_secs(15)))
            .build();

        Ok(Self::Smtp { transport, from })
    }

    pub fn describe(&self) -> &'static str {
        match self {
            Self::Smtp { .. } => "smtp",
            Self::Spool(_) => "development spool",
            Self::Disabled => "disabled",
        }
    }

    pub fn enabled(&self) -> bool {
        !matches!(self, Self::Disabled)
    }

    pub(super) async fn send(&self, id: &str, email: &Email) -> Result<(), DeliveryError> {
        match self {
            Self::Smtp { transport, from } => {
                let message = message(id, from, email).map_err(DeliveryError::Permanent)?;
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
            Self::Spool(directory) => spool(directory, id, email)
                .await
                .map_err(DeliveryError::Transient),
            Self::Disabled => Err(DeliveryError::Transient("email is not configured")),
        }
    }
}

fn message(id: &str, from: &Mailbox, email: &Email) -> Result<Message, &'static str> {
    // Stable across retries. SMTP still permits duplicate delivery.
    let message_id = format!("<{}@{}>", crate::auth::hash(id), from.email.domain());

    Message::builder()
        .from(from.clone())
        .to(email.to.parse().map_err(|_| "invalid recipient address")?)
        .subject(&email.subject)
        .message_id(Some(message_id))
        .header(ContentType::TEXT_PLAIN)
        .body(body(email))
        .map_err(|_| "invalid email")
}

fn body(email: &Email) -> String {
    match &email.grant {
        Grant::Invitation { workspace_id, .. } => format!(
            "You've been invited to a Blackwall workspace.\n\n\
             Sign in or register with this email address. On the welcome page, choose Join \
             workspace and enter:\n\n\
             Workspace ID: {workspace_id}\n\
             Invitation token: {}\n\n\
             If you weren't expecting this invitation, you can ignore this email.\n",
            email.token
        ),
        Grant::Reset { .. } => format!(
            "Someone asked to reset the password for your Blackwall account.\n\n\
             Enter this recovery token on the password recovery page within one hour:\n\n\
             {}\n\n\
             If you didn't ask for this, ignore this email. Your password stays the same.\n",
            email.token
        ),
    }
}

async fn spool(directory: &PathBuf, id: &str, email: &Email) -> Result<(), &'static str> {
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

    let body = serde_json::to_vec(email).map_err(|_| "invalid email")?;
    file.write_all(&body)
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
        let result = Mailer::from_config(Some("dev-mail"), Some("smtp://localhost:1025"), None);
        assert_eq!(
            result.err().as_deref(),
            Some("set either DEV_MAIL_DIR or SMTP_URL, not both")
        );
    }

    #[test]
    fn selects_spool() {
        let mailer = Mailer::from_config(Some("dev-mail"), None, None).unwrap();
        assert!(matches!(mailer, Mailer::Spool(path) if path == std::path::Path::new("dev-mail")));
    }

    #[tokio::test]
    async fn selects_smtp() {
        let mailer = Mailer::from_config(
            None,
            Some("smtp://localhost:1025"),
            Some("Blackwall <noreply@example.com>"),
        )
        .unwrap();
        assert!(
            matches!(mailer, Mailer::Smtp { from, .. } if from.to_string() == "Blackwall <noreply@example.com>")
        );
    }

    #[test]
    fn disables_unconfigured_mail() {
        let mailer = Mailer::from_config(None, None, None).unwrap();
        assert!(matches!(mailer, Mailer::Disabled));
    }

    #[test]
    fn requires_smtp_from() {
        let result = Mailer::from_config(None, Some("smtp://localhost:1025"), None);
        assert_eq!(
            result.err().as_deref(),
            Some("SMTP_FROM is required with SMTP_URL")
        );
    }

    #[test]
    fn rejects_invalid_smtp_from() {
        let result = Mailer::from_config(None, Some("smtp://localhost:1025"), Some("invalid"));
        assert_eq!(
            result.err().as_deref(),
            Some("SMTP_FROM must be an address like Blackwall <noreply@example.com>")
        );
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

        mailer.send("job-1", &email).await.unwrap();
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
