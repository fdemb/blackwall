use crate::{
    error::{Error, Result},
    jobs::{Email, Grant, Job},
    store::{NewJob, Outbox, Store},
};
use argon2::{
    Argon2, PasswordHash, PasswordHasher, PasswordVerifier,
    password_hash::{SaltString, rand_core::OsRng},
};
use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::{PgConnection, types::Json};
use uuid::Uuid;

mod totp;
pub use totp::{
    PendingLogin, RecoveryCodes, TotpConfirm, TotpEnable, TotpLogin, TotpSetup, TotpStatus,
};

#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum Language {
    En,
    Pl,
}

#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum Theme {
    Light,
    Dark,
    System,
}

#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
pub struct Profile {
    pub id: Uuid,
    pub email: String,
    pub display_name: String,
    pub avatar_url: Option<String>,
    pub contact: String,
    pub language: Language,
    pub theme: Theme,
    /// Always on, whatever `users.profile` holds. Browser tabs loaded before workspace email
    /// preferences reject a profile without it. Drop it once those tabs are gone.
    #[serde(default, skip_deserializing)]
    pub alerts: LegacyAlerts,
}

/// The profile-wide alert switches, replaced by per-workspace alert preferences.
#[derive(Debug, Clone, Serialize, utoipa::ToSchema)]
pub struct LegacyAlerts {
    pub assignments: bool,
    pub replies: bool,
    pub changes: bool,
    pub deadlines: bool,
}

impl Default for LegacyAlerts {
    fn default() -> Self {
        Self {
            assignments: true,
            replies: true,
            changes: true,
            deadlines: true,
        }
    }
}

/// Who may create an account, from `REGISTRATION` at startup.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum RegistrationMode {
    Open,
    /// Only invited people, plus the first account of a fresh install.
    Invite,
}

impl RegistrationMode {
    pub fn parse(value: Option<&str>) -> std::result::Result<Self, String> {
        match value {
            None | Some("open") => Ok(Self::Open),
            Some("invite") => Ok(Self::Invite),
            Some(other) => Err(format!(
                "REGISTRATION must be open or invite, not {other:?}"
            )),
        }
    }
}

#[derive(Serialize, utoipa::ToSchema)]
pub struct AuthOptions {
    pub registration: RegistrationMode,
    /// Whether unverified accounts must verify their email address before signing in.
    pub email_verification: bool,
}

/// A pending invitation to the registering address, as in an invitation link.
#[derive(Deserialize, utoipa::ToSchema)]
pub struct InvitationProof {
    pub workspace_id: Uuid,
    pub token: String,
}

#[derive(Deserialize, utoipa::ToSchema)]
pub struct Register {
    pub email: String,
    pub password: String,
    pub display_name: String,
    #[serde(default)]
    pub invitation: Option<InvitationProof>,
}

pub enum Registered {
    Session(Session),
    /// Registration queued a verification email instead of creating a session.
    VerificationSent,
}

impl Registered {
    pub fn session(self) -> Option<Session> {
        match self {
            Self::Session(session) => Some(session),
            Self::VerificationSent => None,
        }
    }
}

#[derive(Deserialize, utoipa::ToSchema)]
pub struct VerifyEmail {
    pub token: String,
}

#[derive(Deserialize, utoipa::ToSchema)]
pub struct Login {
    pub email: String,
    pub password: String,
}

pub enum SignIn {
    Session(Session),
    /// The password was right, and the account also needs a TOTP or recovery code.
    TotpRequired(PendingLogin),
}

impl SignIn {
    pub fn session(self) -> Option<Session> {
        match self {
            Self::Session(session) => Some(session),
            Self::TotpRequired(_) => None,
        }
    }
}

#[derive(Serialize, utoipa::ToSchema)]
pub struct Session {
    pub token: String,
    pub csrf_token: String,
    pub session_id: Uuid,
    pub profile: Profile,
}

/// A signed-in browser or client, as security settings list it.
#[derive(Serialize, utoipa::ToSchema)]
pub struct SessionInfo {
    pub id: Uuid,
    pub created_at: DateTime<Utc>,
    pub last_seen_at: Option<DateTime<Utc>>,
    pub user_agent: Option<String>,
    /// The session making this request.
    pub current: bool,
}

#[derive(Serialize, utoipa::ToSchema)]
pub struct RevokedSessions {
    pub revoked: u64,
}

#[derive(Deserialize, utoipa::ToSchema)]
pub struct ProfileEdit {
    pub display_name: String,
    pub avatar_url: Option<String>,
    pub contact: String,
    pub language: Language,
    pub theme: Theme,
}

#[derive(Deserialize, utoipa::ToSchema)]
pub struct PasswordChange {
    pub current_password: String,
    pub new_password: String,
}

#[derive(Deserialize, utoipa::ToSchema)]
pub struct ResetRequest {
    pub email: String,
}

#[derive(Deserialize, utoipa::ToSchema)]
pub struct ResetPassword {
    pub token: String,
    pub password: String,
}

pub fn token() -> String {
    format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple())
}

pub fn hash(value: &str) -> String {
    hex::encode(Sha256::digest(value.as_bytes()))
}

pub fn csrf(value: &str) -> String {
    hash(&format!("blackwall-csrf:{value}"))
}

/// How long a login session lives. Sync clients idle longer than this are
/// pruned, since their replica's session expired first.
pub const SESSION_LIFETIME_DAYS: i64 = 30;

const MAX_USER_AGENT_BYTES: usize = 512;

fn email(value: &str) -> Result<String> {
    let value = value.trim().to_lowercase();
    let valid = value.split_once('@').is_some_and(|(local, host)| {
        !local.is_empty() && host.contains('.') && !host.starts_with('.')
    });
    if !valid || value.len() > 254 || value.chars().any(char::is_whitespace) {
        return Err(Error::BadRequest("invalid email".into()));
    }

    Ok(value)
}

fn validate_password(password: &str) -> Result<()> {
    if !(12..=256).contains(&password.len()) {
        return Err(Error::BadRequest(
            "password must contain 12 to 256 bytes".into(),
        ));
    }

    Ok(())
}

async fn password_hash(password: String) -> Result<String> {
    validate_password(&password)?;

    tokio::task::spawn_blocking(move || {
        Argon2::default()
            .hash_password(password.as_bytes(), &SaltString::generate(&mut OsRng))
            .map(|h| h.to_string())
            .map_err(|e| Error::Internal(e.to_string()))
    })
    .await
    .map_err(|e| Error::Internal(e.to_string()))?
}

async fn verify(password: String, encoded: String) -> Result<bool> {
    tokio::task::spawn_blocking(move || {
        Ok(PasswordHash::new(&encoded).is_ok_and(|hash| {
            Argon2::default()
                .verify_password(password.as_bytes(), &hash)
                .is_ok()
        }))
    })
    .await
    .map_err(|e| Error::Internal(e.to_string()))?
}

impl Store {
    pub async fn register(&self, input: Register) -> Result<Registered> {
        let email = email(&input.email)?;
        let display_name = input.display_name.trim().to_owned();

        if display_name.is_empty() || display_name.len() > 120 {
            return Err(Error::BadRequest(
                "display name must contain 1 to 120 bytes".into(),
            ));
        }

        let encoded = password_hash(input.password).await?;
        let profile = Profile {
            id: Uuid::new_v4(),
            email: email.clone(),
            display_name,
            avatar_url: None,
            contact: String::new(),
            language: Language::En,
            theme: Theme::System,
            alerts: LegacyAlerts::default(),
        };

        let mut tx = self.pool.begin().await?;
        let invited = match &input.invitation {
            // The share lock holds off cancellation until the account commits.
            Some(proof) => sqlx::query_scalar!(
                "SELECT 1 AS one FROM invitations WHERE workspace_id=$1 AND token_hash=$2 AND \
                 lower(email)=lower($3) AND state='pending' AND expires_at>clock_timestamp() \
                 FOR SHARE",
                proof.workspace_id,
                hash(&proof.token),
                &email,
            )
            .fetch_optional(&mut *tx)
            .await?
            .is_some(),
            None => false,
        };
        let verified = match &input.invitation {
            _ if invited => true,
            Some(_) if self.registration == RegistrationMode::Invite => {
                return Err(Error::BadRequest("invalid or expired invitation".into()));
            }
            Some(_) => false,
            None if self.registration == RegistrationMode::Invite => {
                sqlx::query_scalar!(
                    "SELECT pg_advisory_xact_lock(hashtextextended('first-account',0))"
                )
                .fetch_one(&mut *tx)
                .await?;
                let installed: bool =
                    sqlx::query_scalar!(r#"SELECT EXISTS(SELECT 1 FROM users) AS "exists!""#)
                        .fetch_one(&mut *tx)
                        .await?;
                if installed {
                    return Err(Error::Denied(
                        "Registration is by invitation only. Ask a workspace admin for an \
                         invitation."
                            .into(),
                    ));
                }
                false
            }
            None => false,
        };

        let insert = sqlx::query!(
            "INSERT INTO users (id, email, password_hash, profile, email_verified_at) \
             VALUES ($1, $2, $3, $4, CASE WHEN $5 THEN now() END)",
            profile.id,
            &email,
            encoded,
            Json(&profile) as _,
            verified,
        )
        .execute(&mut *tx)
        .await;

        match insert {
            Err(sqlx::Error::Database(ref e)) if e.is_unique_violation() => {
                return Err(Error::Conflict("email already registered".into()));
            }
            Err(e) => return Err(e.into()),
            _ => {}
        }

        if !verified && self.mail_enabled {
            queue_verification(&mut tx, profile.id, email).await?;
            tx.commit().await?;
            return Ok(Registered::VerificationSent);
        }

        let session = create_session(&mut tx, profile).await?;
        tx.commit().await?;
        Ok(Registered::Session(session))
    }

    /// Checks the password. Accounts with TOTP get a pending login instead of
    /// a session, after the same password check as every other account.
    pub async fn login(&self, input: Login) -> Result<SignIn> {
        if input.password.len() > 256 {
            return Err(Error::Unauthorized);
        }

        let row = sqlx::query!(
            "SELECT id, email, password_hash, email_verified_at IS NOT NULL AS \"verified!\" \
             FROM users WHERE email = $1",
            input.email.trim().to_lowercase(),
        )
        .fetch_optional(&self.pool)
        .await?;

        let Some(row) = row else {
            // Missing accounts still perform the password KDF.
            let _ = password_hash("dummy-password-for-timing".into()).await?;
            return Err(Error::Unauthorized);
        };

        let encoded = row.password_hash;
        if !verify(input.password, encoded.clone()).await? {
            return Err(Error::Unauthorized);
        }

        if self.mail_enabled && !row.verified {
            let email = row.email;
            self.remind_verification(row.id, email.clone()).await?;
            return Err(Error::Denied(format!(
                "Verify your email address first. We sent a link to {email}."
            )));
        }

        let user = row.id;
        let mut tx = self.pool.begin().await?;
        if lock_user(&mut tx, user).await? != encoded {
            return Err(Error::Unauthorized);
        }
        let needs_code: bool = sqlx::query_scalar!(
            r#"SELECT EXISTS(SELECT 1 FROM user_totp WHERE user_id = $1 AND enabled_at IS NOT NULL) AS "exists!""#,
            user,
        )
        .fetch_one(&mut *tx)
        .await?;
        let sign_in = if needs_code {
            SignIn::TotpRequired(totp::pending_login(&mut tx, user, &encoded).await?)
        } else {
            let profile: Json<Profile> = sqlx::query_scalar!(
                r#"SELECT profile AS "profile: Json<Profile>" FROM users WHERE id = $1"#,
                user,
            )
            .fetch_one(&mut *tx)
            .await?;
            SignIn::Session(create_session(&mut tx, profile.0).await?)
        };
        tx.commit().await?;

        Ok(sign_in)
    }

    async fn remind_verification(&self, user: Uuid, email: String) -> Result<()> {
        let mut tx = self.pool.begin().await?;
        // A separate statement after the lock sees tokens that concurrent logins committed.
        sqlx::query_scalar!("SELECT 1 AS one FROM users WHERE id=$1 FOR UPDATE", user)
            .fetch_optional(&mut *tx)
            .await?;
        let due: bool = sqlx::query_scalar!(
            "SELECT email_verified_at IS NULL AND NOT EXISTS(SELECT 1 FROM email_verifications \
             WHERE user_id=$1 AND created_at>now()-interval '5 minutes') AS \"due!\" \
             FROM users WHERE id=$1",
            user,
        )
        .fetch_one(&mut *tx)
        .await?;
        if due {
            queue_verification(&mut tx, user, email).await?;
        }
        tx.commit().await?;

        Ok(())
    }

    pub async fn verify_email(&self, input: VerifyEmail) -> Result<()> {
        let token_hash = hash(&input.token);
        let invalid = || Error::BadRequest("verification link invalid or expired".into());
        let mut tx = self.pool.begin().await?;
        let user: Uuid = sqlx::query_scalar!(
            "SELECT user_id FROM email_verifications WHERE token_hash=$1 AND expires_at>$2",
            &token_hash,
            Utc::now(),
        )
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(invalid)?;

        lock_user(&mut tx, user).await?;
        let consumed = sqlx::query!(
            "DELETE FROM email_verifications WHERE token_hash=$1 AND user_id=$2 AND expires_at>$3",
            token_hash,
            user,
            Utc::now(),
        )
        .execute(&mut *tx)
        .await?;
        if consumed.rows_affected() != 1 {
            return Err(invalid());
        }

        mark_verified(&mut tx, user).await?;
        tx.commit().await?;

        Ok(())
    }

    /// Resolves a session token, and records when and from which client the
    /// session was last used, at most once a minute.
    pub async fn authenticate(
        &self,
        token: &str,
        user_agent: Option<&str>,
    ) -> Result<(Profile, Uuid)> {
        let user_agent = user_agent.map(|agent| {
            let mut end = agent.len().min(MAX_USER_AGENT_BYTES);
            while !agent.is_char_boundary(end) {
                end -= 1;
            }
            &agent[..end]
        });
        let row = sqlx::query!(
            "WITH touch AS (\
               UPDATE sessions SET last_seen_at = $2, user_agent = coalesce($3, user_agent) \
               WHERE token_hash = $1 AND expires_at > $2 \
                 AND (last_seen_at IS NULL OR last_seen_at < $2 - interval '1 minute')) \
             SELECT users.profile AS \"profile!: Json<Profile>\", \
              sessions.public_id AS \"public_id!\" FROM sessions \
              JOIN users ON users.id = sessions.user_id \
              WHERE token_hash = $1 AND expires_at > $2",
            hash(token),
            Utc::now(),
            user_agent,
        )
        .fetch_optional(&self.pool)
        .await?
        .ok_or(Error::Unauthorized)?;

        Ok((row.profile.0, row.public_id))
    }

    pub async fn profile(&self, id: Uuid) -> Result<Profile> {
        let profile = sqlx::query_scalar!(
            r#"SELECT profile AS "profile: Json<Profile>" FROM users WHERE id = $1"#,
            id,
        )
        .fetch_optional(&self.pool)
        .await?
        .ok_or(Error::NotFound)?;

        Ok(profile.0)
    }

    pub async fn edit_profile(&self, mut profile: Profile, edit: ProfileEdit) -> Result<Profile> {
        if edit.display_name.trim().is_empty()
            || edit.display_name.len() > 120
            || edit.contact.len() > 2000
        {
            return Err(Error::BadRequest("invalid profile fields".into()));
        }

        if edit.avatar_url.as_ref().is_some_and(|url| {
            !(url.starts_with("https://") || url.starts_with("/api/")) || url.len() > 2048
        }) {
            return Err(Error::BadRequest(
                "avatar must use https or a local attachment URL".into(),
            ));
        }

        profile.display_name = edit.display_name.trim().into();
        profile.avatar_url = edit.avatar_url;
        profile.contact = edit.contact;
        profile.language = edit.language;
        profile.theme = edit.theme;

        sqlx::query!(
            "UPDATE users SET profile = $1 WHERE id = $2",
            Json(&profile) as _,
            profile.id,
        )
        .execute(&self.pool)
        .await?;

        Ok(profile)
    }

    pub async fn logout(&self, token: &str) -> Result<()> {
        sqlx::query!("DELETE FROM sessions WHERE token_hash = $1", hash(token))
            .execute(&self.pool)
            .await?;

        Ok(())
    }

    pub async fn sessions(&self, user: Uuid, current: Uuid) -> Result<Vec<SessionInfo>> {
        Ok(sqlx::query!(
            "SELECT public_id, created_at, last_seen_at, user_agent FROM sessions \
             WHERE user_id = $1 AND expires_at > now() \
             ORDER BY coalesce(last_seen_at, created_at) DESC, public_id",
            user,
        )
        .fetch_all(&self.pool)
        .await?
        .into_iter()
        .map(|row| SessionInfo {
            id: row.public_id,
            created_at: row.created_at,
            last_seen_at: row.last_seen_at,
            user_agent: row.user_agent,
            current: row.public_id == current,
        })
        .collect())
    }

    pub async fn revoke_session(&self, user: Uuid, id: Uuid) -> Result<()> {
        let deleted = sqlx::query!(
            "DELETE FROM sessions WHERE user_id = $1 AND public_id = $2",
            user,
            id,
        )
        .execute(&self.pool)
        .await?;
        if deleted.rows_affected() == 0 {
            return Err(Error::NotFound);
        }

        Ok(())
    }

    /// Signs out every other session and ends pending logins, so a password
    /// someone else already entered needs entering again.
    pub async fn revoke_other_sessions(&self, user: Uuid, current: Uuid) -> Result<u64> {
        let mut tx = self.pool.begin().await?;
        lock_user(&mut tx, user).await?;
        sqlx::query!("DELETE FROM pending_logins WHERE user_id = $1", user)
            .execute(&mut *tx)
            .await?;
        let revoked = sqlx::query!(
            "DELETE FROM sessions WHERE user_id = $1 AND public_id <> $2",
            user,
            current,
        )
        .execute(&mut *tx)
        .await?
        .rows_affected();
        tx.commit().await?;

        Ok(revoked)
    }

    /// Changes the password and signs out every other session. The session
    /// that made the change stays signed in.
    pub async fn change_password(
        &self,
        user: Uuid,
        current_session: Uuid,
        input: PasswordChange,
    ) -> Result<()> {
        let previous = sqlx::query_scalar!("SELECT password_hash FROM users WHERE id = $1", user)
            .fetch_one(&self.pool)
            .await?;

        if !verify(input.current_password, previous.clone()).await? {
            return Err(Error::Unauthorized);
        }

        let encoded = password_hash(input.new_password).await?;
        let mut tx = self.pool.begin().await?;
        if lock_user(&mut tx, user).await? != previous {
            return Err(Error::Conflict("password changed concurrently".into()));
        }
        sqlx::query!(
            "UPDATE users SET password_hash = $1 WHERE id = $2",
            encoded,
            user,
        )
        .execute(&mut *tx)
        .await?;

        sqlx::query!("DELETE FROM pending_logins WHERE user_id = $1", user)
            .execute(&mut *tx)
            .await?;
        sqlx::query!(
            "DELETE FROM sessions WHERE user_id = $1 AND public_id <> $2",
            user,
            current_session,
        )
        .execute(&mut *tx)
        .await?;

        sqlx::query!("DELETE FROM password_resets WHERE user_id = $1", user)
            .execute(&mut *tx)
            .await?;

        tx.commit().await?;

        Ok(())
    }

    pub async fn request_reset(&self, input: ResetRequest) -> Result<()> {
        if !self.mail_enabled {
            return Err(Error::Conflict(
                "This server can't send email, so it can't reset passwords. Ask the person who \
                 runs Blackwall for help."
                    .into(),
            ));
        }

        let mut tx = self.pool.begin().await?;
        let row = sqlx::query!(
            "SELECT id,email FROM users WHERE email = $1 FOR UPDATE",
            input.email.trim().to_lowercase(),
        )
        .fetch_optional(&mut *tx)
        .await?;

        if let Some(row) = row {
            let user = row.id;
            let email = row.email;

            let token = token();
            let now = Utc::now();
            sqlx::query!(
                "INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES ($1, $2, $3)",
                hash(&token),
                user,
                now + Duration::hours(1),
            )
            .execute(&mut *tx)
            .await?;

            let job = Job::Email(Email {
                to: email,
                subject: "Reset your Blackwall password".into(),
                grant: Grant::Reset {
                    user_id: user,
                    token_hash: hash(&token),
                },
                token,
            });
            Outbox::insert(&mut tx, &NewJob::now(Uuid::new_v4().to_string(), job)).await?;

            tx.commit().await?;
        }

        Ok(())
    }

    pub async fn reset_password(&self, input: ResetPassword) -> Result<()> {
        let encoded = password_hash(input.password).await?;

        let mut tx = self.pool.begin().await?;
        let token_hash = hash(&input.token);
        let user: Uuid = sqlx::query_scalar!(
            "SELECT users.id FROM users JOIN password_resets ON password_resets.user_id=users.id \
             WHERE password_resets.token_hash=$1 AND password_resets.expires_at>$2 \
             FOR UPDATE OF users",
            &token_hash,
            Utc::now(),
        )
        .fetch_optional(&mut *tx)
        .await?
        .ok_or(Error::BadRequest("reset token invalid or expired".into()))?;

        let consumed = sqlx::query!(
            "DELETE FROM password_resets WHERE token_hash=$1 AND user_id=$2 AND expires_at>$3",
            token_hash,
            user,
            Utc::now(),
        )
        .execute(&mut *tx)
        .await?;

        if consumed.rows_affected() != 1 {
            return Err(Error::BadRequest("reset token invalid or expired".into()));
        }

        sqlx::query!(
            "UPDATE users SET password_hash = $1 WHERE id = $2",
            encoded,
            user,
        )
        .execute(&mut *tx)
        .await?;

        sqlx::query!("DELETE FROM pending_logins WHERE user_id = $1", user)
            .execute(&mut *tx)
            .await?;
        sqlx::query!("DELETE FROM sessions WHERE user_id = $1", user)
            .execute(&mut *tx)
            .await?;
        // Recovery assumes the account may be compromised, so its API tokens go too.
        sqlx::query!("DELETE FROM api_tokens WHERE user_id = $1", user)
            .execute(&mut *tx)
            .await?;
        sqlx::query!("DELETE FROM password_resets WHERE user_id = $1", user)
            .execute(&mut *tx)
            .await?;
        mark_verified(&mut tx, user).await?;

        tx.commit().await?;

        Ok(())
    }
}

/// Locks the user row until the transaction ends and returns the password
/// hash, so a sign-in decides against credentials no one is changing.
///
/// Every transaction that changes more than one of a user's password, email
/// verifications, TOTP state, recovery codes, pending logins and sessions
/// takes this lock before it locks or changes any of those rows. Password
/// reset takes the user row with `FOR UPDATE OF users`, which conflicts with
/// this lock too. Two such transactions for one user run one after the other,
/// so the order of their later statements can't deadlock.
///
/// Logout, the expiry sweep and TOTP setup skip the user lock. Each is one
/// statement on one table that waits on nothing while holding a lock. TOTP
/// setup's insert can wait on the user row for its foreign key check, but
/// only another setup for the same user can wait on its uncommitted row.
async fn lock_user(tx: &mut PgConnection, user: Uuid) -> Result<String> {
    Ok(sqlx::query_scalar!(
        "SELECT password_hash FROM users WHERE id = $1 FOR NO KEY UPDATE",
        user,
    )
    .fetch_one(&mut *tx)
    .await?)
}

async fn create_session(conn: &mut PgConnection, profile: Profile) -> Result<Session> {
    let token = token();
    let session_id = Uuid::new_v4();
    sqlx::query!(
        "INSERT INTO sessions (token_hash, user_id, public_id, expires_at) VALUES ($1, $2, $3, $4)",
        hash(&token),
        profile.id,
        session_id,
        Utc::now() + Duration::days(SESSION_LIFETIME_DAYS),
    )
    .execute(conn)
    .await?;

    Ok(Session {
        csrf_token: csrf(&token),
        token,
        session_id,
        profile,
    })
}

async fn queue_verification(tx: &mut PgConnection, user: Uuid, email: String) -> Result<()> {
    let token = token();
    let token_hash = hash(&token);
    sqlx::query!(
        "INSERT INTO email_verifications (token_hash, user_id, expires_at) VALUES ($1, $2, $3)",
        &token_hash,
        user,
        Utc::now() + Duration::hours(24),
    )
    .execute(&mut *tx)
    .await?;

    let job = Job::Email(Email {
        to: email,
        subject: "Verify your Blackwall email address".into(),
        grant: Grant::Verification {
            user_id: user,
            verification_hash: token_hash.clone(),
        },
        token,
    });
    Outbox::insert(
        tx,
        &NewJob::now(format!("verification:{user}:{token_hash}"), job),
    )
    .await?;

    Ok(())
}

async fn mark_verified(tx: &mut PgConnection, user: Uuid) -> Result<()> {
    sqlx::query!(
        "UPDATE users SET email_verified_at = coalesce(email_verified_at, now()) WHERE id = $1",
        user,
    )
    .execute(&mut *tx)
    .await?;
    sqlx::query!("DELETE FROM email_verifications WHERE user_id = $1", user)
        .execute(&mut *tx)
        .await?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::RegistrationMode;

    #[test]
    fn registration_mode_defaults_to_open_and_rejects_typos() {
        assert_eq!(RegistrationMode::parse(None), Ok(RegistrationMode::Open));
        assert_eq!(
            RegistrationMode::parse(Some("open")),
            Ok(RegistrationMode::Open)
        );
        assert_eq!(
            RegistrationMode::parse(Some("invite")),
            Ok(RegistrationMode::Invite)
        );
        assert_eq!(
            RegistrationMode::parse(Some("invites")),
            Err("REGISTRATION must be open or invite, not \"invites\"".into())
        );
    }
}
