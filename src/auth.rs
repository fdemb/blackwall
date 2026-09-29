use crate::{
    error::{Error, Result},
    store::Store,
};
use argon2::{
    Argon2, PasswordHash, PasswordHasher, PasswordVerifier,
    password_hash::{SaltString, rand_core::OsRng},
};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::Row;
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
    pub profile: Profile,
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
            "INSERT INTO users (id, email, password_hash, profile) VALUES ($1,$2,$3,$4)",
        )
        .bind(profile.id.to_string())
        .bind(email)
        .bind(encoded)
        .bind(serde_json::to_string(&profile)?)
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
        sqlx::query("INSERT INTO sessions (token_hash,user_id,expires_at) VALUES ($1,$2,$3)")
            .bind(hash(&token))
            .bind(profile.id.to_string())
            .bind(Utc::now().timestamp() + 60 * 60 * 24 * 30)
            .execute(&self.pool)
            .await?;
        Ok(Session {
            csrf_token: csrf(&token),
            token,
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
        self.create_session(serde_json::from_str(row.try_get::<&str, _>("profile")?)?)
            .await
    }
    pub async fn authenticate(&self, token: &str) -> Result<Profile> {
        let row = sqlx::query("SELECT users.profile FROM sessions JOIN users ON users.id = sessions.user_id WHERE token_hash = $1 AND expires_at > $2").bind(hash(token)).bind(Utc::now().timestamp()).fetch_optional(&self.pool).await?.ok_or(Error::Unauthorized)?;
        Ok(serde_json::from_str(row.try_get::<&str, _>("profile")?)?)
    }
    pub async fn profile(&self, id: Uuid) -> Result<Profile> {
        let row = sqlx::query("SELECT profile FROM users WHERE id = $1")
            .bind(id.to_string())
            .fetch_optional(&self.pool)
            .await?
            .ok_or(Error::NotFound)?;
        Ok(serde_json::from_str(row.try_get::<&str, _>("profile")?)?)
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
            .bind(serde_json::to_string(&profile)?)
            .bind(profile.id.to_string())
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
    pub async fn change_password(&self, user: Uuid, input: PasswordChange) -> Result<()> {
        let row = sqlx::query("SELECT password_hash FROM users WHERE id = $1")
            .bind(user.to_string())
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
                .bind(user.to_string())
                .bind(previous)
                .execute(&mut *tx)
                .await?;
        if result.rows_affected() != 1 {
            return Err(Error::Conflict("password changed concurrently".into()));
        }
        sqlx::query("DELETE FROM sessions WHERE user_id = $1")
            .bind(user.to_string())
            .execute(&mut *tx)
            .await?;
        sqlx::query("DELETE FROM password_resets WHERE user_id = $1")
            .bind(user.to_string())
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok(())
    }
    pub async fn request_reset(&self, input: ResetRequest) -> Result<()> {
        let row = sqlx::query("SELECT id,email FROM users WHERE email = $1")
            .bind(input.email.trim().to_lowercase())
            .fetch_optional(&self.pool)
            .await?;
        if let Some(row) = row {
            let user: String = row.try_get("id")?;
            let email: String = row.try_get("email")?;
            let token = token();
            let now = Utc::now().timestamp();
            let mut tx = self.pool.begin().await?;
            sqlx::query(
                "INSERT INTO password_resets (token_hash,user_id,expires_at) VALUES ($1,$2,$3)",
            )
            .bind(hash(&token))
            .bind(&user)
            .bind(now + 3600)
            .execute(&mut *tx)
            .await?;
            sqlx::query("INSERT INTO outbox (id,kind,payload,due_at) VALUES ($1,'email',$2,$3)").bind(Uuid::new_v4().to_string()).bind(serde_json::json!({"to":email,"subject":"Reset your Blackwall password","user_id":user,"token_hash":hash(&token),"token":token}).to_string()).bind(now).execute(&mut *tx).await?;
            tx.commit().await?;
        }
        Ok(())
    }
    pub async fn reset_password(&self, input: ResetPassword) -> Result<()> {
        let encoded = password_hash(input.password).await?;
        let mut tx = self.pool.begin().await?;
        let row = sqlx::query("DELETE FROM password_resets WHERE token_hash = $1 AND expires_at > $2 RETURNING user_id").bind(hash(&input.token)).bind(Utc::now().timestamp()).fetch_optional(&mut *tx).await?.ok_or(Error::BadRequest("reset token invalid or expired".into()))?;
        let user: String = row.try_get("user_id")?;
        sqlx::query("UPDATE users SET password_hash = $1 WHERE id = $2")
            .bind(encoded)
            .bind(&user)
            .execute(&mut *tx)
            .await?;
        sqlx::query("DELETE FROM sessions WHERE user_id = $1")
            .bind(&user)
            .execute(&mut *tx)
            .await?;
        sqlx::query("DELETE FROM password_resets WHERE user_id = $1")
            .bind(&user)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok(())
    }
}

pub(crate) async fn filter_notifications(
    store: &Store,
    before: &crate::domain::Workspace,
    after: &mut crate::domain::Workspace,
) -> Result<()> {
    use std::collections::{HashMap, HashSet};
    let old: HashSet<_> = before.notifications.iter().map(|n| n.id).collect();
    let recipients: HashSet<_> = after
        .notifications
        .iter()
        .filter(|n| !old.contains(&n.id))
        .map(|n| n.user_id)
        .collect();
    let mut preferences = HashMap::new();
    for user in recipients {
        preferences.insert(user, store.profile(user).await?.alerts);
    }
    after.notifications.retain(|notification| {
        old.contains(&notification.id)
            || preferences
                .get(&notification.user_id)
                .is_some_and(|p| match notification.kind {
                    crate::domain::AlertKind::Assignment => p.assignments,
                    crate::domain::AlertKind::Reply | crate::domain::AlertKind::Mention => {
                        p.replies
                    }
                    crate::domain::AlertKind::Change => p.changes,
                    crate::domain::AlertKind::Deadline => p.deadlines,
                })
    });
    Ok(())
}
