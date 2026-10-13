mod support;

use sqlx::{Connection, PgConnection};
use uuid::Uuid;

/// Applies the migrations before `version` from disk, as a database from before that release.
async fn migrate_before(conn: &mut PgConnection, version: &str) {
    let mut files: Vec<_> = std::fs::read_dir("migrations")
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| path.file_name().unwrap().to_str().unwrap() < version)
        .collect();
    files.sort();
    for file in files {
        sqlx::raw_sql(&std::fs::read_to_string(&file).unwrap())
            .execute(&mut *conn)
            .await
            .unwrap_or_else(|error| panic!("{}: {error}", file.display()));
    }
}

/// Ids in ascending order, so the migration's id tiebreak is predictable.
fn ids(n: u128) -> Vec<Uuid> {
    (1..=n).map(Uuid::from_u128).collect()
}

#[tokio::test]
async fn slugs_and_team_keys_avoid_every_assigned_value() {
    let database = support::TestDatabase::new().await;
    let mut conn = PgConnection::connect(&database.url).await.unwrap();
    migrate_before(&mut conn, "0026").await;

    // "Acme 2" naturally wants acme-2, which the second "Acme" must not take; "Login" is reserved.
    let workspaces = ids(5);
    for (id, name) in workspaces
        .iter()
        .zip(["Acme", "Acme!", "Acme 2", "Login", "Login"])
    {
        sqlx::query("INSERT INTO workspaces(id,name) VALUES($1,$2)")
            .bind(id)
            .bind(name)
            .execute(&mut conn)
            .await
            .unwrap();
    }
    // A and A! both want A; A2 naturally holds A2, so the second A moves on to A3.
    let teams: Vec<_> = (1..=4).map(|n| Uuid::from_u128(100 + n)).collect();
    for (id, name) in teams.iter().zip(["A", "A!", "A2", "Engineering"]) {
        sqlx::query("INSERT INTO teams(id,workspace_id,name) VALUES($1,$2,$3)")
            .bind(id)
            .bind(workspaces[0])
            .bind(name)
            .execute(&mut conn)
            .await
            .unwrap();
    }
    // Another workspace keeps its own key space.
    sqlx::query("INSERT INTO teams(id,workspace_id,name) VALUES($1,$2,'A')")
        .bind(Uuid::from_u128(200))
        .bind(workspaces[1])
        .execute(&mut conn)
        .await
        .unwrap();

    sqlx::raw_sql(include_str!("../migrations/0026_slugs_and_team_keys.sql"))
        .execute(&mut conn)
        .await
        .unwrap();

    let slugs: Vec<String> = sqlx::query_scalar("SELECT slug FROM workspaces ORDER BY id")
        .fetch_all(&mut conn)
        .await
        .unwrap();
    assert_eq!(slugs, ["acme", "acme-3", "acme-2", "login-2", "login-3"]);
    let keys: Vec<String> = sqlx::query_scalar("SELECT key FROM teams ORDER BY id")
        .fetch_all(&mut conn)
        .await
        .unwrap();
    assert_eq!(keys, ["A", "A3", "A2", "ENG", "A"]);

    conn.close().await.unwrap();
    database.cleanup().await;
}
