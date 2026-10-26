pub mod proxy;

use sha2::{Digest, Sha256};
use sqlx::{ConnectOptions, Connection, PgConnection, postgres::PgConnectOptions};
use std::str::FromStr;
use uuid::Uuid;

/// Serializes template builds across the test processes nextest runs in parallel.
const TEMPLATE_LOCK: i64 = 0x626c_6163_6b77_616c;

pub struct TestDatabase {
    pub url: String,
    name: String,
    admin: PgConnection,
}

impl TestDatabase {
    /// A database with every migration applied, copied from a template so
    /// tests don't each replay the migrations.
    pub async fn new() -> Self {
        let (options, mut admin) = connect_admin().await;
        let template = migrated_template(&options, &mut admin).await;
        Self::create(options, admin, &format!("TEMPLATE {template}")).await
    }

    /// A database without migrations, for tests that replay older schemas.
    #[allow(dead_code, reason = "unit tests only use migrated databases")]
    pub async fn empty() -> Self {
        let (options, admin) = connect_admin().await;
        Self::create(options, admin, "").await
    }

    async fn create(options: PgConnectOptions, mut admin: PgConnection, from: &str) -> Self {
        let name = format!("blackwall_test_{}", Uuid::new_v4().simple());

        sqlx::query(&format!("CREATE DATABASE {name} {from}"))
            .execute(&mut admin)
            .await
            .unwrap();

        Self {
            url: options.database(&name).to_url_lossy().to_string(),
            name,
            admin,
        }
    }

    pub async fn cleanup(mut self) {
        sqlx::query(&format!("DROP DATABASE {} WITH (FORCE)", self.name))
            .execute(&mut self.admin)
            .await
            .unwrap();

        self.admin.close().await.unwrap();
    }
}

async fn connect_admin() -> (PgConnectOptions, PgConnection) {
    let url = std::env::var("TEST_POSTGRES_URL")
        .expect("TEST_POSTGRES_URL is required; use a PostgreSQL role with CREATEDB");
    assert!(
        url.starts_with("postgres://") || url.starts_with("postgresql://"),
        "TEST_POSTGRES_URL must use PostgreSQL"
    );

    let options = PgConnectOptions::from_str(&url).unwrap();
    let admin = PgConnection::connect_with(&options).await.unwrap();
    (options, admin)
}

/// Returns a database holding the embedded migrations, building it on first use.
/// The name hashes the migration checksums, so an edited migration gets a new
/// template and checkouts on different branches can share one server.
async fn migrated_template(options: &PgConnectOptions, admin: &mut PgConnection) -> String {
    let migrator = sqlx::migrate!();
    let mut hash = Sha256::new();
    for migration in migrator.iter() {
        hash.update(migration.version.to_le_bytes());
        hash.update(&migration.checksum);
    }
    let name = format!("blackwall_template_{}", &hex::encode(hash.finalize())[..16]);
    if database_exists(admin, &name).await {
        return name;
    }

    sqlx::query("SELECT pg_advisory_lock($1)")
        .bind(TEMPLATE_LOCK)
        .execute(&mut *admin)
        .await
        .unwrap();
    if !database_exists(admin, &name).await {
        // Build under another name and rename, so no test copies a half-migrated template.
        let building = format!("{name}_building");
        sqlx::query(&format!("DROP DATABASE IF EXISTS {building} WITH (FORCE)"))
            .execute(&mut *admin)
            .await
            .unwrap();
        sqlx::query(&format!("CREATE DATABASE {building}"))
            .execute(&mut *admin)
            .await
            .unwrap();
        let mut conn = PgConnection::connect_with(&options.clone().database(&building))
            .await
            .unwrap();
        migrator.run(&mut conn).await.unwrap();
        conn.close().await.unwrap();
        sqlx::query(&format!("ALTER DATABASE {building} RENAME TO {name}"))
            .execute(&mut *admin)
            .await
            .unwrap();
    }
    sqlx::query("SELECT pg_advisory_unlock($1)")
        .bind(TEMPLATE_LOCK)
        .execute(&mut *admin)
        .await
        .unwrap();
    name
}

async fn database_exists(admin: &mut PgConnection, name: &str) -> bool {
    sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname = $1)")
        .bind(name)
        .fetch_one(admin)
        .await
        .unwrap()
}
