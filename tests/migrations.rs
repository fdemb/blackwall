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

#[tokio::test]
async fn change_notifications_take_the_coalescing_key_and_release_it_on_read() {
    let database = support::TestDatabase::new().await;
    let mut conn = PgConnection::connect(&database.url).await.unwrap();
    migrate_before(&mut conn, "0035").await;

    let (workspace, user, team, stage, issue) = (
        Uuid::from_u128(1),
        Uuid::from_u128(2),
        Uuid::from_u128(3),
        Uuid::from_u128(4),
        Uuid::from_u128(5),
    );
    let [older, newer, read] = [10, 11, 12].map(Uuid::from_u128);
    sqlx::query("INSERT INTO workspaces(id,name,slug) VALUES($1,'W','w')")
        .bind(workspace)
        .execute(&mut conn)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO users(id,email,password_hash,profile) VALUES($1,'b@example.com','x','{}')",
    )
    .bind(user)
    .execute(&mut conn)
    .await
    .unwrap();
    sqlx::query("INSERT INTO teams(id,workspace_id,name,key) VALUES($1,$2,'T','T')")
        .bind(team)
        .bind(workspace)
        .execute(&mut conn)
        .await
        .unwrap();
    sqlx::query("INSERT INTO stages(id,workspace_id,team_id,name,kind,position) VALUES($1,$2,$3,'Todo','planned',0)")
        .bind(stage)
        .bind(workspace)
        .bind(team)
        .execute(&mut conn)
        .await
        .unwrap();
    sqlx::query("INSERT INTO issues(id,workspace_id,number,title,description,team_id,stage_id,priority,position,created_at,updated_at) VALUES($1,$2,1,'I','',$3,$4,'none',0,now(),now())")
        .bind(issue)
        .bind(workspace)
        .bind(team)
        .bind(stage)
        .execute(&mut conn)
        .await
        .unwrap();
    for (id, age, is_read) in [(older, 2, false), (newer, 1, false), (read, 0, true)] {
        sqlx::query("INSERT INTO notifications(id,workspace_id,user_id,issue_id,kind,message,created_at,read_at,dedup_key) VALUES($1,$2,$3,$4,'change','I',now()-make_interval(mins=>$5),CASE WHEN $6 THEN now() END,'change:legacy:'||$1)")
            .bind(id)
            .bind(workspace)
            .bind(user)
            .bind(issue)
            .bind(age)
            .bind(is_read)
            .execute(&mut conn)
            .await
            .unwrap();
    }

    sqlx::raw_sql(include_str!(
        "../migrations/0035_notification_change_coalescing.sql"
    ))
    .execute(&mut conn)
    .await
    .unwrap();

    let keys = async |conn: &mut PgConnection| -> Vec<(Uuid, String, bool)> {
        sqlx::query_as("SELECT id,dedup_key,read_at IS NULL FROM notifications ORDER BY id")
            .fetch_all(conn)
            .await
            .unwrap()
    };
    let stable = format!("change:{issue}:{user}");
    assert_eq!(
        keys(&mut conn).await,
        [
            (older, format!("change:legacy:{older}"), true),
            (newer, stable.clone(), true),
            (read, format!("change:legacy:{read}"), false),
        ]
    );

    sqlx::query("UPDATE notifications SET read_at=now() WHERE id=$1")
        .bind(newer)
        .execute(&mut conn)
        .await
        .unwrap();
    assert_eq!(
        keys(&mut conn).await[1],
        (newer, format!("{stable}:{newer}"), false)
    );

    conn.close().await.unwrap();
    database.cleanup().await;
}

#[tokio::test]
async fn profile_alerts_fold_into_workspace_preferences() {
    let database = support::TestDatabase::new().await;
    let mut conn = PgConnection::connect(&database.url).await.unwrap();
    migrate_before(&mut conn, "0043").await;

    let [first, second] = [1, 2].map(Uuid::from_u128);
    let [no_assignments, defaults, no_profile_alerts, no_replies] =
        [11, 12, 13, 14].map(Uuid::from_u128);
    for (workspace, slug) in [(first, "first"), (second, "second")] {
        sqlx::query("INSERT INTO workspaces(id,name,slug) VALUES($1,$2,$2)")
            .bind(workspace)
            .bind(slug)
            .execute(&mut conn)
            .await
            .unwrap();
    }
    let on = r#"{"assignments":true,"replies":true,"changes":true,"deadlines":true}"#;
    for (user, alerts) in [
        (
            no_assignments,
            Some(r#"{"assignments":false,"replies":true,"changes":true,"deadlines":true}"#),
        ),
        (defaults, Some(on)),
        (no_profile_alerts, None),
        (
            no_replies,
            Some(r#"{"assignments":true,"replies":false,"changes":true,"deadlines":true}"#),
        ),
    ] {
        sqlx::query("INSERT INTO users(id,email,password_hash,profile) VALUES($1,$1::text||'@example.com','x',jsonb_strip_nulls(jsonb_build_object('alerts',$2::jsonb)))")
            .bind(user)
            .bind(alerts)
            .execute(&mut conn)
            .await
            .unwrap();
    }
    for (workspace, user) in [
        (first, no_assignments),
        (second, no_assignments),
        (first, defaults),
        (first, no_profile_alerts),
        (first, no_replies),
    ] {
        sqlx::query(
            "INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'member')",
        )
        .bind(workspace)
        .bind(user)
        .execute(&mut conn)
        .await
        .unwrap();
    }
    for (user, column) in [
        (no_assignments, "deadline"),
        (no_profile_alerts, "change"),
        (no_replies, "deadline"),
    ] {
        sqlx::query(&format!(
            "INSERT INTO alert_preferences(workspace_id,user_id,{column}) VALUES($1,$2,false)"
        ))
        .bind(first)
        .bind(user)
        .execute(&mut conn)
        .await
        .unwrap();
    }

    sqlx::raw_sql(include_str!("../migrations/0043_email_notifications.sql"))
        .execute(&mut conn)
        .await
        .unwrap();

    let rows: Vec<(Uuid, Uuid, Vec<bool>, i64)> = sqlx::query_as(
        "SELECT workspace_id,user_id,ARRAY[assignment,reply,change,mention,deadline],version \
         FROM alert_preferences ORDER BY workspace_id,user_id",
    )
    .fetch_all(&mut conn)
    .await
    .unwrap();
    assert_eq!(
        rows,
        [
            (
                first,
                no_assignments,
                vec![false, true, true, true, false],
                2
            ),
            (
                first,
                no_profile_alerts,
                vec![true, true, false, true, true],
                1
            ),
            (first, no_replies, vec![true, false, true, false, false], 2),
            (
                second,
                no_assignments,
                vec![false, true, true, true, true],
                1
            ),
        ]
    );
    let email: Vec<(bool, bool, bool, bool, bool)> = sqlx::query_as(
        "SELECT DISTINCT email_assignment,email_reply,email_change,email_mention,email_deadline \
         FROM alert_preferences",
    )
    .fetch_all(&mut conn)
    .await
    .unwrap();
    assert_eq!(email, [(true, true, false, true, true)]);

    conn.close().await.unwrap();
    database.cleanup().await;
}

#[tokio::test]
async fn session_metadata_dates_existing_sessions_and_accepts_old_inserts() {
    let database = support::TestDatabase::new().await;
    let mut conn = PgConnection::connect(&database.url).await.unwrap();
    migrate_before(&mut conn, "0036").await;

    let user = Uuid::from_u128(1);
    sqlx::query(
        "INSERT INTO users(id,email,password_hash,profile) VALUES($1,'s@example.com','x','{}')",
    )
    .bind(user)
    .execute(&mut conn)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO sessions(token_hash,user_id,expires_at) \
         VALUES('old',$1,'2026-11-01T00:00:00Z')",
    )
    .bind(user)
    .execute(&mut conn)
    .await
    .unwrap();

    sqlx::raw_sql(include_str!("../migrations/0036_session_metadata.sql"))
        .execute(&mut conn)
        .await
        .unwrap();

    sqlx::query(
        "INSERT INTO sessions(token_hash,user_id,public_id,expires_at) \
         VALUES('new',$1,gen_random_uuid(),now()+interval '30 days')",
    )
    .bind(user)
    .execute(&mut conn)
    .await
    .unwrap();

    let old: (String, bool, bool) = sqlx::query_as(
        "SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD'), \
         last_seen_at IS NULL, user_agent IS NULL FROM sessions WHERE token_hash='old'",
    )
    .fetch_one(&mut conn)
    .await
    .unwrap();
    assert_eq!(old, ("2026-10-02".into(), true, true));
    let fresh: bool = sqlx::query_scalar(
        "SELECT created_at > now() - interval '1 minute' FROM sessions WHERE token_hash='new'",
    )
    .fetch_one(&mut conn)
    .await
    .unwrap();
    assert!(
        fresh,
        "an old-binary insert gets its sign-in time from the default"
    );

    conn.close().await.unwrap();
    database.cleanup().await;
}

#[tokio::test]
async fn store_starts_on_a_database_migrated_by_a_newer_release() {
    let database = support::TestDatabase::new().await;
    blackwall::store::Store::connect(&database.url)
        .await
        .unwrap()
        .pool
        .close()
        .await;

    let mut conn = PgConnection::connect(&database.url).await.unwrap();
    sqlx::raw_sql(
        "CREATE TABLE from_newer_release(id int); \
         INSERT INTO _sqlx_migrations(version,description,success,checksum,execution_time) \
         VALUES(99999999,'from newer release',true,'\\x00',0)",
    )
    .execute(&mut conn)
    .await
    .unwrap();
    conn.close().await.unwrap();

    let store = blackwall::store::Store::connect(&database.url)
        .await
        .expect("a rollback binary starts after a newer release migrated the database");
    store.pool.close().await;
    database.cleanup().await;
}

#[tokio::test]
async fn email_verification_counts_existing_and_old_binary_users_as_verified() {
    let database = support::TestDatabase::new().await;
    let mut conn = PgConnection::connect(&database.url).await.unwrap();
    migrate_before(&mut conn, "0044").await;

    sqlx::query(
        "INSERT INTO users(id,email,password_hash,profile) VALUES($1,'old@example.com','x','{}')",
    )
    .bind(Uuid::from_u128(1))
    .execute(&mut conn)
    .await
    .unwrap();

    sqlx::raw_sql(include_str!("../migrations/0044_email_verification.sql"))
        .execute(&mut conn)
        .await
        .unwrap();

    sqlx::query(
        "INSERT INTO users(id,email,password_hash,profile) VALUES($1,'new@example.com','x','{}')",
    )
    .bind(Uuid::from_u128(2))
    .execute(&mut conn)
    .await
    .unwrap();

    let unverified: Vec<String> =
        sqlx::query_scalar("SELECT email FROM users WHERE email_verified_at IS NULL")
            .fetch_all(&mut conn)
            .await
            .unwrap();
    assert!(
        unverified.is_empty(),
        "existing and old-binary accounts stay able to sign in: {unverified:?}"
    );

    conn.close().await.unwrap();
    database.cleanup().await;
}
