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
use sqlx::{Row, types::Json};
use uuid::Uuid;

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
pub struct AlertPreferences {
    pub assignments: bool,
    pub replies: bool,
    pub changes: bool,
    pub deadlines: bool,
}

impl Default for AlertPreferences {
    fn default() -> Self {
        Self {
            assignments: true,
            replies: true,
            changes: true,
            deadlines: true,
        }
    }
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
    #[serde(default)]
    pub alerts: AlertPreferences,
}

#[derive(Deserialize, utoipa::ToSchema)]
pub struct Register {
    pub email: String,
    pub password: String,
    pub display_name: String,
}

#[derive(Deserialize, utoipa::ToSchema)]
pub struct Login {
    pub email: String,
    pub password: String,
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
    pub alerts: AlertPreferences,
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
    pub async fn register(&self, input: Register) -> Result<Session> {
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
            alerts: AlertPreferences::default(),
        };

        let insert = sqlx::query(
            "INSERT INTO users (id, email, password_hash, profile) VALUES ($1, $2, $3, $4)",
        )
        .bind(profile.id)
        .bind(email)
        .bind(encoded)
        .bind(Json(&profile))
        .execute(&self.pool)
        .await;

        match insert {
            Err(sqlx::Error::Database(ref e)) if e.is_unique_violation() => {
                return Err(Error::Conflict("email already registered".into()));
            }
            Err(e) => return Err(e.into()),
            _ => {}
        }

        self.create_session(profile).await
    }

    async fn create_session(&self, profile: Profile) -> Result<Session> {
        let token = token();
        let session_id = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO sessions (token_hash, user_id, public_id, expires_at) VALUES ($1, $2, $3, $4)",
        )
        .bind(hash(&token))
        .bind(profile.id)
        .bind(session_id)
        .bind(Utc::now() + Duration::days(SESSION_LIFETIME_DAYS))
        .execute(&self.pool)
        .await?;

        Ok(Session {
            csrf_token: csrf(&token),
            token,
            session_id,
            profile,
        })
    }

    pub async fn login(&self, input: Login) -> Result<Session> {
        if input.password.len() > 256 {
            return Err(Error::Unauthorized);
        }

        let row = sqlx::query("SELECT password_hash, profile FROM users WHERE email = $1")
            .bind(input.email.trim().to_lowercase())
            .fetch_optional(&self.pool)
            .await?;

        let Some(row) = row else {
            // Missing accounts still perform the password KDF.
            let _ = password_hash("dummy-password-for-timing".into()).await?;
            return Err(Error::Unauthorized);
        };

        if !verify(input.password, row.try_get("password_hash")?).await? {
            return Err(Error::Unauthorized);
        }

        self.create_session(row.try_get::<Json<Profile>, _>("profile")?.0)
            .await
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
        let row = sqlx::query(
            "WITH touch AS (\
               UPDATE sessions SET last_seen_at = $2, user_agent = coalesce($3, user_agent) \
               WHERE token_hash = $1 AND expires_at > $2 \
                 AND (last_seen_at IS NULL OR last_seen_at < $2 - interval '1 minute')) \
             SELECT users.profile, sessions.public_id FROM sessions \
              JOIN users ON users.id = sessions.user_id \
              WHERE token_hash = $1 AND expires_at > $2",
        )
        .bind(hash(token))
        .bind(Utc::now())
        .bind(user_agent)
        .fetch_optional(&self.pool)
        .await?
        .ok_or(Error::Unauthorized)?;

        Ok((
            row.try_get::<Json<Profile>, _>("profile")?.0,
            row.try_get("public_id")?,
        ))
    }

    pub async fn profile(&self, id: Uuid) -> Result<Profile> {
        let row = sqlx::query("SELECT profile FROM users WHERE id = $1")
            .bind(id)
            .fetch_optional(&self.pool)
            .await?
            .ok_or(Error::NotFound)?;

        Ok(row.try_get::<Json<Profile>, _>("profile")?.0)
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
        profile.alerts = edit.alerts;

        sqlx::query("UPDATE users SET profile = $1 WHERE id = $2")
            .bind(Json(&profile))
            .bind(profile.id)
            .execute(&self.pool)
            .await?;

        Ok(profile)
    }

    pub async fn logout(&self, token: &str) -> Result<()> {
        sqlx::query("DELETE FROM sessions WHERE token_hash = $1")
            .bind(hash(token))
            .execute(&self.pool)
            .await?;

        Ok(())
    }

    pub async fn sessions(&self, user: Uuid, current: Uuid) -> Result<Vec<SessionInfo>> {
        sqlx::query(
            "SELECT public_id, created_at, last_seen_at, user_agent FROM sessions \
             WHERE user_id = $1 AND expires_at > now() \
             ORDER BY coalesce(last_seen_at, created_at) DESC, public_id",
        )
        .bind(user)
        .fetch_all(&self.pool)
        .await?
        .iter()
        .map(|row| {
            let id: Uuid = row.try_get("public_id")?;
            Ok(SessionInfo {
                id,
                created_at: row.try_get("created_at")?,
                last_seen_at: row.try_get("last_seen_at")?,
                user_agent: row.try_get("user_agent")?,
                current: id == current,
            })
        })
        .collect()
    }

    pub async fn revoke_session(&self, user: Uuid, id: Uuid) -> Result<()> {
        let deleted = sqlx::query("DELETE FROM sessions WHERE user_id = $1 AND public_id = $2")
            .bind(user)
            .bind(id)
            .execute(&self.pool)
            .await?;
        if deleted.rows_affected() == 0 {
            return Err(Error::NotFound);
        }

        Ok(())
    }

    pub async fn revoke_other_sessions(&self, user: Uuid, current: Uuid) -> Result<u64> {
        Ok(
            sqlx::query("DELETE FROM sessions WHERE user_id = $1 AND public_id <> $2")
                .bind(user)
                .bind(current)
                .execute(&self.pool)
                .await?
                .rows_affected(),
        )
    }

    /// Changes the password and signs out every other session. The session
    /// that made the change stays signed in.
    pub async fn change_password(
        &self,
        user: Uuid,
        current_session: Uuid,
        input: PasswordChange,
    ) -> Result<()> {
        let row = sqlx::query("SELECT password_hash FROM users WHERE id = $1")
            .bind(user)
            .fetch_one(&self.pool)
            .await?;

        let previous: String = row.try_get("password_hash")?;

        if !verify(input.current_password, previous.clone()).await? {
            return Err(Error::Unauthorized);
        }

        let encoded = password_hash(input.new_password).await?;
        let mut tx = self.pool.begin().await?;
        let result =
            sqlx::query("UPDATE users SET password_hash = $1 WHERE id = $2 AND password_hash = $3")
                .bind(encoded)
                .bind(user)
                .bind(previous)
                .execute(&mut *tx)
                .await?;

        if result.rows_affected() != 1 {
            return Err(Error::Conflict("password changed concurrently".into()));
        }

        sqlx::query("DELETE FROM sessions WHERE user_id = $1 AND public_id <> $2")
            .bind(user)
            .bind(current_session)
            .execute(&mut *tx)
            .await?;

        sqlx::query("DELETE FROM password_resets WHERE user_id = $1")
            .bind(user)
            .execute(&mut *tx)
            .await?;

        tx.commit().await?;

        Ok(())
    }

    pub async fn request_reset(&self, input: ResetRequest) -> Result<()> {
        let mut tx = self.pool.begin().await?;
        let row = sqlx::query("SELECT id,email FROM users WHERE email = $1 FOR UPDATE")
            .bind(input.email.trim().to_lowercase())
            .fetch_optional(&mut *tx)
            .await?;

        if let Some(row) = row {
            let user: Uuid = row.try_get("id")?;
            let email: String = row.try_get("email")?;

            let token = token();
            let now = Utc::now();
            sqlx::query(
                "INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES ($1, $2, $3)",
            )
            .bind(hash(&token))
            .bind(user)
            .bind(now + Duration::hours(1))
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
        let user: Uuid = sqlx::query_scalar(
            "SELECT users.id FROM users JOIN password_resets ON password_resets.user_id=users.id \
             WHERE password_resets.token_hash=$1 AND password_resets.expires_at>$2 \
             FOR UPDATE OF users",
        )
        .bind(&token_hash)
        .bind(Utc::now())
        .fetch_optional(&mut *tx)
        .await?
        .ok_or(Error::BadRequest("reset token invalid or expired".into()))?;

        let consumed = sqlx::query(
            "DELETE FROM password_resets WHERE token_hash=$1 AND user_id=$2 AND expires_at>$3",
        )
        .bind(token_hash)
        .bind(user)
        .bind(Utc::now())
        .execute(&mut *tx)
        .await?;

        if consumed.rows_affected() != 1 {
            return Err(Error::BadRequest("reset token invalid or expired".into()));
        }

        sqlx::query("UPDATE users SET password_hash = $1 WHERE id = $2")
            .bind(encoded)
            .bind(user)
            .execute(&mut *tx)
            .await?;

        sqlx::query("DELETE FROM sessions WHERE user_id = $1")
            .bind(user)
            .execute(&mut *tx)
            .await?;
        // Recovery assumes the account may be compromised, so its API tokens go too.
        sqlx::query("DELETE FROM api_tokens WHERE user_id = $1")
            .bind(user)
            .execute(&mut *tx)
            .await?;
        sqlx::query("DELETE FROM password_resets WHERE user_id = $1")
            .bind(user)
            .execute(&mut *tx)
            .await?;

        tx.commit().await?;

        Ok(())
    }
}
