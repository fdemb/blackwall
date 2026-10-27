//! Time-based one-time passwords (RFC 6238: SHA-1, six digits, 30-second steps)
//! as a second sign-in factor, with single-use recovery codes.

use super::{Profile, Session, create_session, hash, token, verify};
use crate::{
    error::{Error, Result},
    store::Store,
};
use argon2::password_hash::rand_core::{OsRng, RngCore};
use chrono::{Duration, Utc};
use hmac::{Hmac, Mac};
use qrcode::{QrCode, render::svg};
use serde::{Deserialize, Serialize};
use sha1::Sha1;
use sqlx::{PgConnection, Postgres, Row, Transaction, types::Json};
use uuid::Uuid;

const STEP_SECONDS: i64 = 30;
const RECOVERY_CODES: usize = 10;
const PENDING_LOGIN_MINUTES: i64 = 5;
const PENDING_LOGIN_ATTEMPTS: i32 = 5;

/// A correct password on an account with TOTP. Finish signing in with a code.
#[derive(Serialize, utoipa::ToSchema)]
pub struct PendingLogin {
    pub pending_token: String,
}

#[derive(Deserialize, utoipa::ToSchema)]
pub struct TotpLogin {
    pub pending_token: String,
    /// A six-digit code from the authenticator app, or a recovery code.
    pub code: String,
}

#[derive(Serialize, utoipa::ToSchema)]
pub struct TotpStatus {
    pub enabled: bool,
    pub recovery_codes_left: i64,
}

#[derive(Serialize, utoipa::ToSchema)]
pub struct TotpSetup {
    /// The shared secret in base32, for typing into an authenticator app.
    pub secret: String,
    pub uri: String,
    /// `uri` as a QR code in an SVG document.
    pub qr_svg: String,
}

#[derive(Deserialize, utoipa::ToSchema)]
pub struct TotpCode {
    pub code: String,
}

#[derive(Deserialize, utoipa::ToSchema)]
pub struct TotpConfirm {
    pub password: String,
    /// A six-digit code from the authenticator app, or a recovery code.
    pub code: String,
}

/// Shown once. The server keeps only their hashes.
#[derive(Serialize, utoipa::ToSchema)]
pub struct RecoveryCodes {
    pub codes: Vec<String>,
}

fn random<const N: usize>() -> [u8; N] {
    let mut bytes = [0; N];
    OsRng.fill_bytes(&mut bytes);
    bytes
}

/// RFC 4648 base32 without padding, as authenticator apps expect.
fn base32(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 32] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    let mut out = String::with_capacity(bytes.len().div_ceil(5) * 8);
    let (mut buffer, mut bits) = (0u32, 0);
    for &byte in bytes {
        buffer = (buffer << 8) | u32::from(byte);
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            out.push(ALPHABET[(buffer >> bits) as usize & 31] as char);
        }
    }
    if bits > 0 {
        out.push(ALPHABET[(buffer << (5 - bits)) as usize & 31] as char);
    }
    out
}

fn code_at(secret: &[u8], step: i64) -> u32 {
    let mut mac = Hmac::<Sha1>::new_from_slice(secret).expect("HMAC accepts any key length");
    mac.update(&step.to_be_bytes());
    let digest = mac.finalize().into_bytes();
    let offset = usize::from(digest[19] & 0x0f);
    let truncated = u32::from_be_bytes([
        digest[offset],
        digest[offset + 1],
        digest[offset + 2],
        digest[offset + 3],
    ]) & 0x7fff_ffff;
    truncated % 1_000_000
}

/// The time step `code` belongs to, at most one step from `now` and newer than
/// `last`, so a code works once even while it is still on screen.
fn matching_step(secret: &[u8], code: u32, now: i64, last: Option<i64>) -> Option<i64> {
    let current = now.div_euclid(STEP_SECONDS);
    (current - 1..=current + 1)
        .filter(|step| last.is_none_or(|last| *step > last))
        .find(|step| code_at(secret, *step) == code)
}

fn totp_code(input: &str) -> Option<u32> {
    let digits: String = input.chars().filter(|c| !c.is_whitespace()).collect();
    if digits.len() == 6 && digits.bytes().all(|b| b.is_ascii_digit()) {
        digits.parse().ok()
    } else {
        None
    }
}

fn recovery_hash(user: Uuid, input: &str) -> String {
    let normalized: String = input
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .map(|c| c.to_ascii_lowercase())
        .collect();
    hash(&format!("blackwall-recovery:{user}:{normalized}"))
}

fn recovery_code() -> String {
    let mut code = String::with_capacity(19);
    for (i, c) in base32(&random::<10>()).chars().enumerate() {
        if i > 0 && i % 4 == 0 {
            code.push('-');
        }
        code.push(c.to_ascii_lowercase());
    }
    code
}

async fn replace_recovery_codes(tx: &mut PgConnection, user: Uuid) -> Result<RecoveryCodes> {
    let codes: Vec<String> = (0..RECOVERY_CODES).map(|_| recovery_code()).collect();
    let hashes: Vec<String> = codes.iter().map(|code| recovery_hash(user, code)).collect();
    sqlx::query("DELETE FROM totp_recovery_codes WHERE user_id = $1")
        .bind(user)
        .execute(&mut *tx)
        .await?;
    sqlx::query(
        "INSERT INTO totp_recovery_codes (user_id, code_hash) SELECT $1, unnest($2::text[])",
    )
    .bind(user)
    .bind(hashes)
    .execute(&mut *tx)
    .await?;

    Ok(RecoveryCodes { codes })
}

/// Accepts a current authenticator code or uses up a recovery code. Holds the
/// TOTP row lock until the transaction ends, so concurrent requests can't both
/// accept the same code.
async fn second_factor(tx: &mut PgConnection, user: Uuid, input: &str) -> Result<bool> {
    let row = sqlx::query(
        "SELECT secret, last_step FROM user_totp \
         WHERE user_id = $1 AND enabled_at IS NOT NULL FOR UPDATE",
    )
    .bind(user)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| Error::Conflict("two-factor sign-in is off".into()))?;

    if let Some(code) = totp_code(input) {
        let secret: Vec<u8> = row.try_get("secret")?;
        let now = Utc::now().timestamp();
        let Some(step) = matching_step(&secret, code, now, row.try_get("last_step")?) else {
            return Ok(false);
        };
        sqlx::query("UPDATE user_totp SET last_step = $2 WHERE user_id = $1")
            .bind(user)
            .bind(step)
            .execute(&mut *tx)
            .await?;
        return Ok(true);
    }

    let used = sqlx::query("DELETE FROM totp_recovery_codes WHERE user_id = $1 AND code_hash = $2")
        .bind(user)
        .bind(recovery_hash(user, input))
        .execute(&mut *tx)
        .await?;
    Ok(used.rows_affected() == 1)
}

fn qr_svg(uri: &str) -> Result<String> {
    let svg = QrCode::new(uri)
        .map_err(|e| Error::Internal(e.to_string()))?
        .render::<svg::Color>()
        .min_dimensions(200, 200)
        .build();
    // Drop the XML declaration so the document embeds in HTML as is.
    Ok(match svg.split_once("?>") {
        Some((_, rest)) => rest.to_owned(),
        None => svg,
    })
}

impl Store {
    pub(super) async fn pending_login(&self, user: Uuid) -> Result<PendingLogin> {
        let token = token();
        sqlx::query(
            "INSERT INTO pending_logins (token_hash, user_id, expires_at) VALUES ($1, $2, $3)",
        )
        .bind(hash(&token))
        .bind(user)
        .bind(Utc::now() + Duration::minutes(PENDING_LOGIN_MINUTES))
        .execute(&self.pool)
        .await?;

        Ok(PendingLogin {
            pending_token: token,
        })
    }

    /// Finishes a sign-in that `login` left pending. Each pending login takes
    /// one successful code and a few wrong ones.
    pub async fn login_totp(&self, input: TotpLogin) -> Result<Session> {
        let token_hash = hash(&input.pending_token);
        let mut tx = self.pool.begin().await?;
        let user: Uuid = sqlx::query_scalar(
            "SELECT user_id FROM pending_logins WHERE token_hash = $1 AND expires_at > $2 \
             FOR UPDATE",
        )
        .bind(&token_hash)
        .bind(Utc::now())
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| Error::BadRequest("sign-in expired; enter your password again".into()))?;

        if !second_factor(&mut tx, user, &input.code).await? {
            sqlx::query(
                "UPDATE pending_logins SET failed_attempts = failed_attempts + 1 \
                 WHERE token_hash = $1",
            )
            .bind(&token_hash)
            .execute(&mut *tx)
            .await?;
            sqlx::query(
                "DELETE FROM pending_logins WHERE token_hash = $1 AND failed_attempts >= $2",
            )
            .bind(&token_hash)
            .bind(PENDING_LOGIN_ATTEMPTS)
            .execute(&mut *tx)
            .await?;
            tx.commit().await?;
            return Err(Error::Unauthorized);
        }

        sqlx::query("DELETE FROM pending_logins WHERE token_hash = $1")
            .bind(&token_hash)
            .execute(&mut *tx)
            .await?;
        let profile: Json<Profile> = sqlx::query_scalar("SELECT profile FROM users WHERE id = $1")
            .bind(user)
            .fetch_one(&mut *tx)
            .await?;
        let session = create_session(&mut tx, profile.0).await?;
        tx.commit().await?;

        Ok(session)
    }

    pub async fn totp_status(&self, user: Uuid) -> Result<TotpStatus> {
        let row = sqlx::query(
            "SELECT EXISTS(SELECT 1 FROM user_totp WHERE user_id = $1 AND enabled_at IS NOT NULL) \
               AS enabled, \
             (SELECT count(*) FROM totp_recovery_codes WHERE user_id = $1) AS recovery_codes_left",
        )
        .bind(user)
        .fetch_one(&self.pool)
        .await?;

        Ok(TotpStatus {
            enabled: row.try_get("enabled")?,
            recovery_codes_left: row.try_get("recovery_codes_left")?,
        })
    }

    /// Starts TOTP setup with a fresh secret. TOTP stays off until
    /// `enable_totp` sees a code from it.
    pub async fn setup_totp(&self, profile: &Profile) -> Result<TotpSetup> {
        let secret = random::<20>();
        let started = sqlx::query(
            "INSERT INTO user_totp (user_id, secret) VALUES ($1, $2) \
             ON CONFLICT (user_id) DO UPDATE SET secret = excluded.secret \
             WHERE user_totp.enabled_at IS NULL",
        )
        .bind(profile.id)
        .bind(&secret[..])
        .execute(&self.pool)
        .await?;
        if started.rows_affected() == 0 {
            return Err(Error::Conflict("two-factor sign-in is already on".into()));
        }

        let secret = base32(&secret);
        let mut uri = reqwest::Url::parse("otpauth://totp/").expect("constant URL parses");
        uri.set_path(&format!("/Blackwall:{}", profile.email));
        uri.query_pairs_mut()
            .append_pair("secret", &secret)
            .append_pair("issuer", "Blackwall")
            .append_pair("algorithm", "SHA1")
            .append_pair("digits", "6")
            .append_pair("period", "30");
        let uri = String::from(uri);

        Ok(TotpSetup {
            qr_svg: qr_svg(&uri)?,
            secret,
            uri,
        })
    }

    /// Turns TOTP on once `code` matches the secret from setup. Other sessions
    /// are signed out, as on a password change.
    pub async fn enable_totp(
        &self,
        user: Uuid,
        current_session: Uuid,
        input: TotpCode,
    ) -> Result<RecoveryCodes> {
        let mut tx = self.pool.begin().await?;
        let secret: Vec<u8> = sqlx::query_scalar(
            "SELECT secret FROM user_totp WHERE user_id = $1 AND enabled_at IS NULL FOR UPDATE",
        )
        .bind(user)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| Error::Conflict("two-factor setup is not in progress".into()))?;

        let now = Utc::now().timestamp();
        let step = totp_code(&input.code)
            .and_then(|code| matching_step(&secret, code, now, None))
            .ok_or_else(|| Error::BadRequest("the code doesn't match".into()))?;

        sqlx::query("UPDATE user_totp SET enabled_at = now(), last_step = $2 WHERE user_id = $1")
            .bind(user)
            .bind(step)
            .execute(&mut *tx)
            .await?;
        let codes = replace_recovery_codes(&mut tx, user).await?;
        sqlx::query("DELETE FROM sessions WHERE user_id = $1 AND public_id <> $2")
            .bind(user)
            .bind(current_session)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;

        Ok(codes)
    }

    /// Turns TOTP off. Other sessions are signed out, as on a password change.
    pub async fn disable_totp(
        &self,
        user: Uuid,
        current_session: Uuid,
        input: TotpConfirm,
    ) -> Result<()> {
        let mut tx = self.confirm_totp(user, input).await?;
        sqlx::query(
            "WITH codes AS (DELETE FROM totp_recovery_codes WHERE user_id = $1), \
             pending AS (DELETE FROM pending_logins WHERE user_id = $1), \
             others AS (DELETE FROM sessions WHERE user_id = $1 AND public_id <> $2) \
             DELETE FROM user_totp WHERE user_id = $1",
        )
        .bind(user)
        .bind(current_session)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;

        Ok(())
    }

    /// Replaces every recovery code with ten new ones.
    pub async fn regenerate_recovery_codes(
        &self,
        user: Uuid,
        input: TotpConfirm,
    ) -> Result<RecoveryCodes> {
        let mut tx = self.confirm_totp(user, input).await?;
        let codes = replace_recovery_codes(&mut tx, user).await?;
        tx.commit().await?;

        Ok(codes)
    }

    /// Checks the password and a second factor. A failed check rolls back, so
    /// a recovery code given with the wrong password stays usable.
    async fn confirm_totp(
        &self,
        user: Uuid,
        input: TotpConfirm,
    ) -> Result<Transaction<'static, Postgres>> {
        let wrong = || Error::BadRequest("the password or code is wrong".into());
        let encoded: String = sqlx::query_scalar("SELECT password_hash FROM users WHERE id = $1")
            .bind(user)
            .fetch_one(&self.pool)
            .await?;
        if input.password.len() > 256 || !verify(input.password, encoded).await? {
            return Err(wrong());
        }

        let mut tx = self.pool.begin().await?;
        if !second_factor(&mut tx, user, &input.code).await? {
            return Err(wrong());
        }

        Ok(tx)
    }

    /// Turns TOTP off for the account with this email, for someone who lost
    /// both their authenticator and their recovery codes. Returns whether TOTP
    /// was on.
    pub async fn reset_totp(&self, email: &str) -> Result<bool> {
        let reset = sqlx::query(
            "WITH target AS (SELECT id FROM users WHERE email = $1), \
             codes AS (DELETE FROM totp_recovery_codes WHERE user_id IN (SELECT id FROM target)), \
             pending AS (DELETE FROM pending_logins WHERE user_id IN (SELECT id FROM target)) \
             DELETE FROM user_totp WHERE user_id IN (SELECT id FROM target) \
               AND enabled_at IS NOT NULL",
        )
        .bind(email.trim().to_lowercase())
        .execute(&self.pool)
        .await?;

        Ok(reset.rows_affected() == 1)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codes_match_the_rfc_6238_sha1_vectors() {
        let secret = b"12345678901234567890";
        // RFC 6238 appendix B lists eight digits; six-digit codes are their last six.
        for (time, expected) in [
            (59, 287_082),
            (1_111_111_109, 81_804),
            (1_111_111_111, 50_471),
            (1_234_567_890, 5_924),
            (2_000_000_000, 279_037),
            (20_000_000_000, 353_130),
        ] {
            assert_eq!(code_at(secret, time / STEP_SECONDS), expected, "at {time}");
        }
    }

    #[test]
    fn a_code_is_accepted_one_step_either_side_and_only_once() {
        let secret = b"12345678901234567890";
        let now = 1_111_111_111;
        let step = now / STEP_SECONDS;
        let code = |step| code_at(secret, step);

        assert_eq!(
            matching_step(secret, code(step - 1), now, None),
            Some(step - 1)
        );
        assert_eq!(
            matching_step(secret, code(step + 1), now, None),
            Some(step + 1)
        );
        assert_eq!(matching_step(secret, code(step + 2), now, None), None);
        assert_eq!(matching_step(secret, code(step), now, Some(step)), None);
        assert_eq!(
            matching_step(secret, code(step + 1), now, Some(step)),
            Some(step + 1)
        );
    }

    #[test]
    fn base32_matches_rfc_4648() {
        assert_eq!(base32(b""), "");
        assert_eq!(base32(b"f"), "MY");
        assert_eq!(base32(b"foob"), "MZXW6YQ");
        assert_eq!(base32(b"foobar"), "MZXW6YTBOI");
        assert_eq!(
            base32(b"12345678901234567890"),
            "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"
        );
    }

    #[test]
    fn codes_parse_with_spaces_and_recovery_codes_ignore_case_and_dashes() {
        assert_eq!(totp_code("123 456"), Some(123_456));
        assert_eq!(totp_code("12345"), None);
        assert_eq!(totp_code("abcd-efgh-ijkl-mnop"), None);
        let user = Uuid::new_v4();
        assert_eq!(
            recovery_hash(user, "abcd-efgh-ijkl-mnop"),
            recovery_hash(user, " ABCDEFGHIJKLMNOP ")
        );
    }
}
