//! Personal access tokens: storage, authentication and the session-authenticated
//! management endpoints under `/internal-api/me/tokens`.

use crate::{
    auth,
    error::{Error, Result},
    http::Actor,
    store::Store,
};
use axum::{
    Json,
    extract::{Path, State},
    http::StatusCode,
};
use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{Row, postgres::PgRow};
use uuid::Uuid;

/// Every token secret starts with this, so leaked tokens are recognizable.
pub const TOKEN_PREFIX: &str = "bw_pat_";
const MAX_TOKENS_PER_USER: i64 = 50;
const MAX_LIFETIME_DAYS: u32 = 366;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum Access {
    /// Reads only.
    Read,
    /// Reads, and writes comments.
    Comment,
    /// Reads and writes.
    Write,
}

#[derive(Clone, Debug, Serialize, utoipa::ToSchema)]
pub struct ApiToken {
    pub id: Uuid,
    pub name: String,
    /// The secret's first characters, for recognizing a token without revealing it.
    pub prefix: String,
    pub access: Access,
    /// Null allows every workspace the user belongs to.
    pub workspace_ids: Option<Vec<Uuid>>,
    pub created_at: DateTime<Utc>,
    pub expires_at: Option<DateTime<Utc>>,
    pub last_used_at: Option<DateTime<Utc>>,
}

#[derive(Deserialize, utoipa::ToSchema)]
pub struct CreateToken {
    pub name: String,
    pub access: Access,
    /// Restrict the token to these workspaces. Omit to allow all of the user's workspaces.
    #[serde(default)]
    pub workspace_ids: Option<Vec<Uuid>>,
    /// Days until expiry, 1 to 366. Omit for a token that never expires.
    #[serde(default)]
    pub expires_in_days: Option<u32>,
}

#[derive(Serialize, utoipa::ToSchema)]
pub struct CreatedToken {
    #[serde(flatten)]
    pub token: ApiToken,
    /// Shown once. Only its hash is stored.
    pub secret: String,
}

/// What an authenticated token may do: act as `user`, narrowed by `access` and `workspaces`.
#[derive(Clone, Debug)]
pub struct TokenGrant {
    pub token_id: Uuid,
    pub user: Uuid,
    pub access: Access,
    pub workspaces: Option<Vec<Uuid>>,
}

fn access_text(access: Access) -> &'static str {
    match access {
        Access::Read => "read",
        Access::Comment => "comment",
        Access::Write => "write",
    }
}

fn parse_access(text: &str) -> Result<Access> {
    match text {
        "read" => Ok(Access::Read),
        "comment" => Ok(Access::Comment),
        "write" => Ok(Access::Write),
        _ => Err(Error::Internal(format!("unknown token access {text}"))),
    }
}

fn token_row(row: &PgRow) -> Result<ApiToken> {
    Ok(ApiToken {
        id: row.try_get("id")?,
        name: row.try_get("name")?,
        prefix: row.try_get("prefix")?,
        access: parse_access(row.try_get("access")?)?,
        workspace_ids: row.try_get("workspace_ids")?,
        created_at: row.try_get("created_at")?,
        expires_at: row.try_get("expires_at")?,
        last_used_at: row.try_get("last_used_at")?,
    })
}

const TOKEN_COLUMNS: &str =
    "id,name,prefix,access,workspace_ids,created_at,expires_at,last_used_at";

impl Store {
    pub async fn create_api_token(&self, user: Uuid, input: CreateToken) -> Result<CreatedToken> {
        let name = input.name.trim().to_owned();
        if name.is_empty() || name.len() > 100 {
            return Err(Error::BadRequest(
                "token name must contain 1 to 100 bytes".into(),
            ));
        }
        if input
            .expires_in_days
            .is_some_and(|days| !(1..=MAX_LIFETIME_DAYS).contains(&days))
        {
            return Err(Error::BadRequest(format!(
                "expires_in_days must be between 1 and {MAX_LIFETIME_DAYS}"
            )));
        }
        let workspaces = match input.workspace_ids {
            Some(mut ids) => {
                ids.sort();
                ids.dedup();
                if ids.is_empty() || ids.len() > 100 {
                    return Err(Error::BadRequest(
                        "workspace_ids must list 1 to 100 workspaces, or be omitted".into(),
                    ));
                }
                Some(ids)
            }
            None => None,
        };

        let mut tx = self.pool.begin().await?;
        // Serializes concurrent creations per user so the cap holds.
        sqlx::query("SELECT id FROM users WHERE id=$1 FOR UPDATE")
            .bind(user)
            .fetch_one(&mut *tx)
            .await?;
        if let Some(ids) = &workspaces {
            let member: i64 = sqlx::query_scalar(
                "SELECT count(*) FROM workspace_members WHERE user_id=$1 AND workspace_id=ANY($2)",
            )
            .bind(user)
            .bind(ids)
            .fetch_one(&mut *tx)
            .await?;
            if member != ids.len() as i64 {
                return Err(Error::BadRequest(
                    "workspace_ids may only name workspaces you belong to".into(),
                ));
            }
        }
        let count: i64 = sqlx::query_scalar("SELECT count(*) FROM api_tokens WHERE user_id=$1")
            .bind(user)
            .fetch_one(&mut *tx)
            .await?;
        if count >= MAX_TOKENS_PER_USER {
            return Err(Error::Conflict(format!(
                "token limit of {MAX_TOKENS_PER_USER} reached; revoke one first"
            )));
        }

        let secret = format!("{TOKEN_PREFIX}{}", auth::token());
        let row = sqlx::query(&format!(
            "INSERT INTO api_tokens(id,user_id,name,token_hash,prefix,access,workspace_ids,expires_at) \
             VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING {TOKEN_COLUMNS}"
        ))
        .bind(Uuid::new_v4())
        .bind(user)
        .bind(name)
        .bind(auth::hash(&secret))
        .bind(&secret[..TOKEN_PREFIX.len() + 8])
        .bind(access_text(input.access))
        .bind(workspaces)
        .bind(
            input
                .expires_in_days
                .map(|days| Utc::now() + Duration::days(days.into())),
        )
        .fetch_one(&mut *tx)
        .await?;
        tx.commit().await?;

        Ok(CreatedToken {
            token: token_row(&row)?,
            secret,
        })
    }

    pub async fn api_tokens(&self, user: Uuid) -> Result<Vec<ApiToken>> {
        sqlx::query(&format!(
            "SELECT {TOKEN_COLUMNS} FROM api_tokens WHERE user_id=$1 ORDER BY created_at DESC,id"
        ))
        .bind(user)
        .fetch_all(&self.pool)
        .await?
        .iter()
        .map(token_row)
        .collect()
    }

    pub async fn revoke_api_token(&self, user: Uuid, id: Uuid) -> Result<()> {
        let deleted = sqlx::query("DELETE FROM api_tokens WHERE user_id=$1 AND id=$2")
            .bind(user)
            .bind(id)
            .execute(&self.pool)
            .await?;
        if deleted.rows_affected() == 0 {
            return Err(Error::NotFound);
        }
        Ok(())
    }

    pub async fn authenticate_api_token(&self, secret: &str) -> Result<TokenGrant> {
        if !secret.starts_with(TOKEN_PREFIX) || secret.len() > 200 {
            return Err(Error::Unauthorized);
        }
        let row = sqlx::query(
            "SELECT id,user_id,access,workspace_ids FROM api_tokens \
             WHERE token_hash=$1 AND (expires_at IS NULL OR expires_at>now())",
        )
        .bind(auth::hash(secret))
        .fetch_optional(&self.pool)
        .await?
        .ok_or(Error::Unauthorized)?;
        let grant = TokenGrant {
            token_id: row.try_get("id")?,
            user: row.try_get("user_id")?,
            access: parse_access(row.try_get("access")?)?,
            workspaces: row.try_get("workspace_ids")?,
        };

        // Coarse on purpose: one write per token per minute, not per request.
        sqlx::query(
            "UPDATE api_tokens SET last_used_at=now() WHERE id=$1 \
             AND (last_used_at IS NULL OR last_used_at<now()-interval '1 minute')",
        )
        .bind(grant.token_id)
        .execute(&self.pool)
        .await?;

        Ok(grant)
    }
}

#[utoipa::path(
    get,
    path = "/internal-api/me/tokens",
    responses((status = 200, body = Vec<ApiToken>))
)]
pub async fn list(State(store): State<Store>, actor: Actor) -> Result<Json<Vec<ApiToken>>> {
    Ok(Json(store.api_tokens(actor.profile.id).await?))
}

#[utoipa::path(
    post,
    path = "/internal-api/me/tokens",
    request_body = CreateToken,
    responses((status = 201, body = CreatedToken))
)]
pub async fn create(
    State(store): State<Store>,
    actor: Actor,
    Json(input): Json<CreateToken>,
) -> Result<(StatusCode, Json<CreatedToken>)> {
    Ok((
        StatusCode::CREATED,
        Json(store.create_api_token(actor.profile.id, input).await?),
    ))
}

#[utoipa::path(
    delete,
    path = "/internal-api/me/tokens/{token}",
    params(("token" = Uuid, Path)),
    responses((status = 204))
)]
pub async fn revoke(
    State(store): State<Store>,
    actor: Actor,
    Path(id): Path<Uuid>,
) -> Result<StatusCode> {
    store.revoke_api_token(actor.profile.id, id).await?;
    Ok(StatusCode::NO_CONTENT)
}
