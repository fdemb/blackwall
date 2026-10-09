pub mod proxy;

use sqlx::{ConnectOptions, Connection, PgConnection, postgres::PgConnectOptions};
use std::str::FromStr;
use uuid::Uuid;

pub struct TestDatabase {
    pub url: String,
    name: String,
    admin: PgConnection,
}

impl TestDatabase {
    pub async fn new() -> Self {
        let url = std::env::var("TEST_POSTGRES_URL")
            .expect("TEST_POSTGRES_URL is required; use a PostgreSQL role with CREATEDB");
        assert!(
            url.starts_with("postgres://") || url.starts_with("postgresql://"),
            "TEST_POSTGRES_URL must use PostgreSQL"
        );

        let options = PgConnectOptions::from_str(&url).unwrap();
        let mut admin = PgConnection::connect_with(&options).await.unwrap();
        let name = format!("blackwall_test_{}", Uuid::new_v4().simple());

        sqlx::query(&format!("CREATE DATABASE {name}"))
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
