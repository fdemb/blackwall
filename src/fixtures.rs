use crate::{
    error::{Error, Result},
    jobs::{Job, Reminder},
    store::{NewJob, Outbox, Store},
};
use argon2::{Argon2, PasswordHasher, password_hash::SaltString};
use uuid::Uuid;

/// Development fixtures have fixed identities and timestamps. Load only into a fresh database.
/// All fixture accounts use `fixture-password-123`; these are not production credentials.
pub async fn load(store: &Store, name: &str) -> Result<()> {
    let sql = match name {
        "empty" => include_str!("../fixtures/empty.sql"),
        "rich" => include_str!("../fixtures/rich.sql"),
        _ => return Err(Error::BadRequest("fixture must be empty or rich".into())),
    };
    let password_hash = tokio::task::spawn_blocking(|| {
        let salt = SaltString::encode_b64(b"blackwall-fixture")
            .map_err(|error| Error::Internal(error.to_string()))?;
        Argon2::default()
            .hash_password(b"fixture-password-123", &salt)
            .map(|hash| hash.to_string())
            .map_err(|error| Error::Internal(error.to_string()))
    })
    .await
    .map_err(|error| Error::Internal(error.to_string()))??;
    let mut tx = store.pool.begin().await?;
    sqlx::raw_sql(&sql.replace("__FIXTURE_PASSWORD_HASH__", &password_hash))
        .execute(&mut *tx)
        .await?;
    if name == "rich" {
        let workspace_id = Uuid::from_u128(0x20000000_0000_0000_0000_000000000010);
        let issue_id = Uuid::from_u128(0x20000000_0000_0000_0000_000000000061);
        let due_at = chrono::DateTime::parse_from_rfc3339("2030-01-11T12:00:00Z")
            .map_err(|error| Error::Internal(error.to_string()))?
            .timestamp();
        Outbox::insert(
            &mut tx,
            &NewJob {
                id: format!("reminder:{issue_id}:1"),
                job: Job::Reminder(Reminder {
                    workspace_id,
                    issue_id,
                    generation: 1,
                }),
                due_at,
            },
        )
        .await?;
    }
    tx.commit().await?;
    Ok(())
}
