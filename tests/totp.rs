mod support;

use axum::{
    body::Body,
    http::{Request, StatusCode, header},
};
use blackwall::{
    auth::{
        Login, Register, ResetPassword, ResetRequest, Session, SignIn, TotpCode, TotpConfirm,
        TotpLogin,
    },
    error::Error,
    store::Store,
};
use chrono::Utc;
use hmac::{Hmac, Mac};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use sha1::Sha1;
use tower::ServiceExt;
use uuid::Uuid;

const PASSWORD: &str = "test-password-123";

/// Returns the status, the JSON body and the `Set-Cookie` header.
async fn call(
    app: &axum::Router,
    method: &str,
    path: &str,
    token: Option<&str>,
    input: Option<Value>,
) -> (StatusCode, Value, Option<String>) {
    let mut request = Request::builder().method(method).uri(path);
    if let Some(token) = token {
        request = request.header("Authorization", format!("Bearer {token}"));
    }
    let body = match input {
        Some(input) => {
            request = request.header("Content-Type", "application/json");
            Body::from(input.to_string())
        }
        None => Body::empty(),
    };

    let response = app
        .clone()
        .oneshot(request.body(body).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let cookie = response
        .headers()
        .get(header::SET_COOKIE)
        .map(|value| value.to_str().unwrap().to_owned());
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);

    (status, value, cookie)
}

async fn account(store: &Store) -> Session {
    store
        .register(Register {
            email: format!("totp-{}@example.com", Uuid::new_v4()),
            password: PASSWORD.into(),
            display_name: "TOTP".into(),
            invitation: None,
        })
        .await
        .unwrap()
        .session()
        .unwrap()
}

fn decode_base32(text: &str) -> Vec<u8> {
    let (mut buffer, mut bits, mut out) = (0u32, 0, Vec::new());
    for c in text.bytes() {
        let value = match c {
            b'A'..=b'Z' => c - b'A',
            b'2'..=b'7' => c - b'2' + 26,
            _ => panic!("{text} is not base32"),
        };
        buffer = (buffer << 5) | u32::from(value);
        bits += 5;
        if bits >= 8 {
            bits -= 8;
            out.push((buffer >> bits) as u8);
        }
    }
    out
}

/// An authenticator app, computing RFC 6238 codes independently of the server.
struct Authenticator {
    secret: Vec<u8>,
    last: i64,
}

impl Authenticator {
    fn new(secret: &str) -> Self {
        Self {
            secret: decode_base32(secret),
            last: 0,
        }
    }

    fn code(&self, step: i64) -> String {
        let mut mac = Hmac::<Sha1>::new_from_slice(&self.secret).unwrap();
        mac.update(&step.to_be_bytes());
        let digest = mac.finalize().into_bytes();
        let offset = usize::from(digest[19] & 0x0f);
        let value =
            u32::from_be_bytes(digest[offset..offset + 4].try_into().unwrap()) & 0x7fff_ffff;
        format!("{:06}", value % 1_000_000)
    }

    fn now() -> i64 {
        Utc::now().timestamp() / 30
    }

    /// A code the server hasn't seen, from the oldest step it still accepts.
    fn next(&mut self) -> String {
        self.last = (self.last + 1).max(Self::now() - 1);
        self.code(self.last)
    }

    fn reused(&self) -> String {
        self.code(self.last)
    }

    fn wrong(&self) -> String {
        self.code(Self::now() + 10)
    }
}

/// Turns TOTP on through the store, returning the authenticator and recovery codes.
async fn enable(store: &Store, session: &Session) -> (Authenticator, Vec<String>) {
    let setup = store.setup_totp(&session.profile).await.unwrap();
    let mut authenticator = Authenticator::new(&setup.secret);
    let codes = store
        .enable_totp(
            session.profile.id,
            session.session_id,
            TotpCode {
                code: authenticator.next(),
            },
        )
        .await
        .unwrap()
        .codes;
    (authenticator, codes)
}

async fn login(store: &Store, session: &Session, password: &str) -> SignIn {
    store
        .login(Login {
            email: session.profile.email.clone(),
            password: password.into(),
        })
        .await
        .unwrap()
}

async fn pending(store: &Store, session: &Session) -> String {
    match login(store, session, PASSWORD).await {
        SignIn::TotpRequired(pending) => pending.pending_token,
        SignIn::Session(_) => panic!("TOTP is on, so the password alone must not sign in"),
    }
}

#[tokio::test]
async fn enabling_needs_a_code_then_login_needs_a_second_factor() {
    let database = support::TestDatabase::new().await;
    let store = Store::connect(&database.url).await.unwrap();
    let app = blackwall::http::router(store.clone());
    let laptop = account(&store).await;
    let phone = login(&store, &laptop, PASSWORD).await.session().unwrap();
    let token = Some(laptop.token.as_str());
    let credentials = json!({"email": laptop.profile.email, "password": PASSWORD});

    let (status, setup, _) = call(&app, "POST", "/internal-api/auth/totp/setup", token, None).await;
    assert_eq!(status, StatusCode::OK, "{setup}");
    let secret = setup["secret"].as_str().unwrap();
    assert_eq!(decode_base32(secret).len(), 20);
    assert!(
        setup["uri"]
            .as_str()
            .unwrap()
            .starts_with("otpauth://totp/Blackwall:totp-"),
        "{setup}"
    );
    assert!(setup["qr_svg"].as_str().unwrap().starts_with("<svg"));
    let mut authenticator = Authenticator::new(secret);

    let wrong = json!({"code": authenticator.wrong()});
    let (status, _, _) = call(
        &app,
        "POST",
        "/internal-api/auth/totp/enable",
        token,
        Some(wrong),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (_, status_after_wrong, _) =
        call(&app, "GET", "/internal-api/auth/totp", token, None).await;
    assert_eq!(
        status_after_wrong["enabled"], false,
        "a wrong code leaves TOTP off"
    );
    let (status, _, cookie) = call(
        &app,
        "POST",
        "/internal-api/auth/login",
        None,
        Some(credentials.clone()),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(cookie.is_some(), "the password alone still signs in");

    let right = json!({"code": authenticator.next()});
    let (status, codes, _) = call(
        &app,
        "POST",
        "/internal-api/auth/totp/enable",
        token,
        Some(right),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{codes}");
    let codes: Vec<String> = serde_json::from_value(codes["codes"].clone()).unwrap();
    assert_eq!(codes.len(), 10);
    assert!(store.authenticate(&laptop.token, None).await.is_ok());
    assert!(
        store.authenticate(&phone.token, None).await.is_err(),
        "turning TOTP on signs out other sessions"
    );

    let (status, value, cookie) = call(
        &app,
        "POST",
        "/internal-api/auth/login",
        None,
        Some(credentials.clone()),
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED, "{value}");
    assert!(cookie.is_none(), "no session before the second factor");
    assert!(value.get("token").is_none(), "{value}");
    let pending_token = value["pending_token"].as_str().unwrap().to_owned();

    let attempt = |code: String| json!({"pending_token": pending_token, "code": code});
    let (status, _, cookie) = call(
        &app,
        "POST",
        "/internal-api/auth/login/totp",
        None,
        Some(attempt(authenticator.wrong())),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert!(cookie.is_none());

    let (status, session, cookie) = call(
        &app,
        "POST",
        "/internal-api/auth/login/totp",
        None,
        Some(attempt(authenticator.next())),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{session}");
    assert!(cookie.unwrap().starts_with("blackwall_session="));
    let session_token = session["token"].as_str().unwrap();
    assert!(store.authenticate(session_token, None).await.is_ok());

    let (status, _, _) = call(
        &app,
        "POST",
        "/internal-api/auth/login/totp",
        None,
        Some(attempt(authenticator.reused())),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::BAD_REQUEST,
        "a pending login takes one code"
    );

    let replay = store
        .login_totp(TotpLogin {
            pending_token: pending(&store, &laptop).await,
            code: authenticator.reused(),
        })
        .await;
    assert!(
        matches!(replay, Err(Error::Unauthorized)),
        "a code works once, even inside its window"
    );

    store.pool.close().await;
    database.cleanup().await;
}

#[tokio::test]
async fn recovery_codes_work_once() {
    let database = support::TestDatabase::new().await;
    let store = Store::connect(&database.url).await.unwrap();
    let user = account(&store).await;
    let (_, codes) = enable(&store, &user).await;
    let use_code = |pending_token: String, code: &str| {
        store.login_totp(TotpLogin {
            pending_token,
            code: code.into(),
        })
    };

    let typed = codes[0].to_uppercase().replace('-', " ");
    use_code(pending(&store, &user).await, &typed)
        .await
        .expect("a recovery code signs in, however it is typed");
    assert!(matches!(
        use_code(pending(&store, &user).await, &codes[0]).await,
        Err(Error::Unauthorized)
    ));
    assert_eq!(
        store
            .totp_status(user.profile.id)
            .await
            .unwrap()
            .recovery_codes_left,
        9
    );

    let pending_token = pending(&store, &user).await;
    for _ in 0..5 {
        assert!(matches!(
            use_code(pending_token.clone(), "wrong-code").await,
            Err(Error::Unauthorized)
        ));
    }
    assert!(
        matches!(
            use_code(pending_token, &codes[1]).await,
            Err(Error::BadRequest(_))
        ),
        "five wrong codes end the pending login"
    );

    store.pool.close().await;
    database.cleanup().await;
}

#[tokio::test]
async fn disabling_and_new_recovery_codes_need_the_password_and_a_code() {
    let database = support::TestDatabase::new().await;
    let store = Store::connect(&database.url).await.unwrap();
    let user = account(&store).await;
    let (mut authenticator, codes) = enable(&store, &user).await;
    let other = store
        .login_totp(TotpLogin {
            pending_token: pending(&store, &user).await,
            code: authenticator.next(),
        })
        .await
        .unwrap();
    let confirm = |password: &str, code: &str| TotpConfirm {
        password: password.into(),
        code: code.into(),
    };
    let disable = |input| store.disable_totp(user.profile.id, user.session_id, input);
    let enabled = || async { store.totp_status(user.profile.id).await.unwrap().enabled };

    assert!(matches!(
        disable(confirm(PASSWORD, &authenticator.wrong())).await,
        Err(Error::BadRequest(_))
    ));
    assert!(matches!(
        disable(confirm("wrong-password-123", &codes[0])).await,
        Err(Error::BadRequest(_))
    ));
    assert!(enabled().await);

    let fresh = store
        .regenerate_recovery_codes(user.profile.id, confirm(PASSWORD, &codes[0]))
        .await
        .expect("the recovery code given with a wrong password stayed usable")
        .codes;
    assert_eq!(fresh.len(), 10);
    assert!(
        matches!(
            disable(confirm(PASSWORD, &codes[1])).await,
            Err(Error::BadRequest(_))
        ),
        "new recovery codes replace the old ones"
    );

    disable(confirm(PASSWORD, &authenticator.next()))
        .await
        .unwrap();
    assert!(!enabled().await);
    assert!(store.authenticate(&user.token, None).await.is_ok());
    assert!(
        store.authenticate(&other.token, None).await.is_err(),
        "turning TOTP off signs out other sessions"
    );
    assert!(login(&store, &user, PASSWORD).await.session().is_some());

    store.pool.close().await;
    database.cleanup().await;
}

#[tokio::test]
async fn password_reset_leaves_totp_on() {
    let database = support::TestDatabase::new().await;
    let mut store = Store::connect(&database.url).await.unwrap();
    let user = account(&store).await;
    let (mut authenticator, _) = enable(&store, &user).await;
    store.mail_enabled = true;

    store
        .request_reset(ResetRequest {
            email: user.profile.email.clone(),
        })
        .await
        .unwrap();
    let reset: String = sqlx::query_scalar(
        "SELECT payload->>'token' FROM jobs WHERE kind='email' \
         AND payload->>'subject'='Reset your Blackwall password' AND payload->>'to'=$1",
    )
    .bind(&user.profile.email)
    .fetch_one(&store.pool)
    .await
    .unwrap();
    store
        .reset_password(ResetPassword {
            token: reset,
            password: "recovered-password-123".into(),
        })
        .await
        .unwrap();

    let SignIn::TotpRequired(pending) = login(&store, &user, "recovered-password-123").await else {
        panic!("a reset link alone must not remove the second factor");
    };
    store
        .login_totp(TotpLogin {
            pending_token: pending.pending_token,
            code: authenticator.next(),
        })
        .await
        .unwrap();

    store.pool.close().await;
    database.cleanup().await;
}

#[tokio::test]
async fn cli_disables_totp_for_one_email() {
    let database = support::TestDatabase::new().await;
    let store = Store::connect(&database.url).await.unwrap();
    let locked_out = account(&store).await;
    let bystander = account(&store).await;
    enable(&store, &locked_out).await;
    enable(&store, &bystander).await;
    let run = |email: &str| {
        std::process::Command::new(env!("CARGO_BIN_EXE_blackwall"))
            .args(["totp", "disable", email])
            .env("DATABASE_URL", &database.url)
            .output()
            .unwrap()
    };

    let output = run(&locked_out.profile.email.to_uppercase());
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(
        login(&store, &locked_out, PASSWORD)
            .await
            .session()
            .is_some()
    );
    assert!(
        store
            .totp_status(bystander.profile.id)
            .await
            .unwrap()
            .enabled
    );
    assert!(
        !run(&locked_out.profile.email).status.success(),
        "TOTP is already off"
    );
    assert!(!run("nobody@example.com").status.success());

    store.pool.close().await;
    database.cleanup().await;
}

/// Takes the user's row lock, as TOTP enrollment and password changes do, and
/// holds it until the returned transaction ends.
async fn lock_user(store: &Store, user: Uuid) -> sqlx::Transaction<'static, sqlx::Postgres> {
    let mut tx = store.pool.begin().await.unwrap();
    sqlx::query("SELECT 1 FROM users WHERE id = $1 FOR UPDATE")
        .bind(user)
        .execute(&mut *tx)
        .await
        .unwrap();
    tx
}

/// Whether `count` other connections end up waiting on a lock in this database.
async fn lock_waiters(store: &Store, count: i64) -> bool {
    for _ in 0..100 {
        let waiting: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM pg_stat_activity \
             WHERE datname = current_database() AND wait_event_type = 'Lock'",
        )
        .fetch_one(&store.pool)
        .await
        .unwrap();
        if waiting >= count {
            return true;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    false
}

fn spawn_login(
    store: &Store,
    email: &str,
    password: &str,
) -> tokio::task::JoinHandle<Result<SignIn, Error>> {
    let (store, input) = (
        store.clone(),
        Login {
            email: email.into(),
            password: password.into(),
        },
    );
    tokio::spawn(async move { store.login(input).await })
}

#[tokio::test]
async fn a_login_decides_after_a_concurrent_enrollment_commits() {
    let database = support::TestDatabase::new().await;
    let store = Store::connect(&database.url).await.unwrap();
    let user = account(&store).await;

    let mut enrollment = lock_user(&store, user.profile.id).await;
    let login = spawn_login(&store, &user.profile.email, PASSWORD);
    lock_waiters(&store, 1).await;
    sqlx::query(
        "INSERT INTO user_totp (user_id, secret, enabled_at, last_step) \
         VALUES ($1, '\\x3132333435363738393031323334353637383930', now(), 0)",
    )
    .bind(user.profile.id)
    .execute(&mut *enrollment)
    .await
    .unwrap();
    enrollment.commit().await.unwrap();

    assert!(
        matches!(login.await.unwrap(), Ok(SignIn::TotpRequired(_))),
        "a login that checked the password before TOTP turned on still needs a code"
    );

    store.pool.close().await;
    database.cleanup().await;
}

#[tokio::test]
async fn enabling_waits_for_a_login_in_progress() {
    let database = support::TestDatabase::new().await;
    let store = Store::connect(&database.url).await.unwrap();
    let app = blackwall::http::router(store.clone());
    let user = account(&store).await;
    let token = Some(user.token.as_str());
    let (_, setup, _) = call(&app, "POST", "/internal-api/auth/totp/setup", token, None).await;
    let mut authenticator = Authenticator::new(setup["secret"].as_str().unwrap());

    let login = lock_user(&store, user.profile.id).await;
    let enable = tokio::spawn({
        let app = app.clone();
        let (token, code) = (user.token.clone(), authenticator.next());
        async move {
            call(
                &app,
                "POST",
                "/internal-api/auth/totp/enable",
                Some(&token),
                Some(json!({"password": PASSWORD, "code": code})),
            )
            .await
        }
    });
    assert!(
        lock_waiters(&store, 1).await,
        "enrollment waits for the user row a login holds"
    );
    login.commit().await.unwrap();
    assert_eq!(enable.await.unwrap().0, StatusCode::OK);

    store.pool.close().await;
    database.cleanup().await;
}

#[tokio::test]
async fn a_login_fails_if_the_password_changes_before_it_finishes() {
    let database = support::TestDatabase::new().await;
    let store = Store::connect(&database.url).await.unwrap();
    let app = blackwall::http::router(store.clone());
    let user = account(&store).await;
    let token = Some(user.token.as_str());
    let (_, setup, _) = call(&app, "POST", "/internal-api/auth/totp/setup", token, None).await;
    let mut authenticator = Authenticator::new(setup["secret"].as_str().unwrap());
    let enable = json!({"password": PASSWORD, "code": authenticator.next()});
    let (status, _, _) = call(
        &app,
        "POST",
        "/internal-api/auth/totp/enable",
        token,
        Some(enable),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    let mut change = lock_user(&store, user.profile.id).await;
    let login = spawn_login(&store, &user.profile.email, PASSWORD);
    lock_waiters(&store, 1).await;
    sqlx::query("UPDATE users SET password_hash = 'changed' WHERE id = $1")
        .bind(user.profile.id)
        .execute(&mut *change)
        .await
        .unwrap();
    sqlx::query("DELETE FROM pending_logins WHERE user_id = $1")
        .bind(user.profile.id)
        .execute(&mut *change)
        .await
        .unwrap();
    change.commit().await.unwrap();

    assert!(
        matches!(login.await.unwrap(), Err(Error::Unauthorized)),
        "a login that checked the old password gets no pending login after the change"
    );
    let pending: i64 = sqlx::query_scalar("SELECT count(*) FROM pending_logins WHERE user_id = $1")
        .bind(user.profile.id)
        .fetch_one(&store.pool)
        .await
        .unwrap();
    assert_eq!(pending, 0);

    store.pool.close().await;
    database.cleanup().await;
}

#[tokio::test]
async fn enabling_needs_the_password_and_the_session_that_started_setup() {
    let database = support::TestDatabase::new().await;
    let store = Store::connect(&database.url).await.unwrap();
    let app = blackwall::http::router(store.clone());
    let laptop = account(&store).await;
    let phone = login(&store, &laptop, PASSWORD).await.session().unwrap();
    let (laptop_token, phone_token) = (Some(laptop.token.as_str()), Some(phone.token.as_str()));
    let enabled = || async { store.totp_status(laptop.profile.id).await.unwrap().enabled };

    let (status, setup, _) = call(
        &app,
        "POST",
        "/internal-api/auth/totp/setup",
        laptop_token,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{setup}");
    let mut authenticator = Authenticator::new(setup["secret"].as_str().unwrap());

    let (status, _, _) = call(
        &app,
        "POST",
        "/internal-api/auth/totp/enable",
        phone_token,
        Some(json!({"password": PASSWORD, "code": authenticator.next()})),
    )
    .await;
    assert_ne!(
        status,
        StatusCode::OK,
        "another session can't confirm the setup"
    );
    assert!(!enabled().await);

    let (status, _, _) = call(
        &app,
        "POST",
        "/internal-api/auth/totp/setup",
        phone_token,
        None,
    )
    .await;
    assert_eq!(
        status,
        StatusCode::CONFLICT,
        "another session can't replace the secret"
    );

    let (status, _, _) = call(
        &app,
        "POST",
        "/internal-api/auth/totp/enable",
        laptop_token,
        Some(json!({"password": "wrong-password-123", "code": authenticator.next()})),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::BAD_REQUEST,
        "enabling needs the password"
    );
    assert!(!enabled().await);

    let (status, value, _) = call(
        &app,
        "POST",
        "/internal-api/auth/totp/enable",
        laptop_token,
        Some(json!({"password": PASSWORD, "code": authenticator.next()})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{value}");
    assert!(enabled().await);

    store.pool.close().await;
    database.cleanup().await;
}

#[tokio::test]
async fn an_abandoned_setup_can_be_restarted_from_another_session() {
    let database = support::TestDatabase::new().await;
    let store = Store::connect(&database.url).await.unwrap();
    let app = blackwall::http::router(store.clone());
    let laptop = account(&store).await;
    let phone = login(&store, &laptop, PASSWORD).await.session().unwrap();
    let phone_token = Some(phone.token.as_str());

    call(
        &app,
        "POST",
        "/internal-api/auth/totp/setup",
        Some(&laptop.token),
        None,
    )
    .await;
    sqlx::query("UPDATE user_totp SET setup_started_at = now() - interval '11 minutes'")
        .execute(&store.pool)
        .await
        .unwrap();
    let (status, setup, _) = call(
        &app,
        "POST",
        "/internal-api/auth/totp/setup",
        phone_token,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{setup}");
    let mut authenticator = Authenticator::new(setup["secret"].as_str().unwrap());
    let (status, value, _) = call(
        &app,
        "POST",
        "/internal-api/auth/totp/enable",
        phone_token,
        Some(json!({"password": PASSWORD, "code": authenticator.next()})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{value}");

    store.pool.close().await;
    database.cleanup().await;
}

#[tokio::test]
async fn the_otpauth_label_keeps_a_percent_sign_in_the_email() {
    let database = support::TestDatabase::new().await;
    let store = Store::connect(&database.url).await.unwrap();
    let app = blackwall::http::router(store.clone());
    let local = format!("totp-{}%40ops", Uuid::new_v4().simple());
    let user = store
        .register(Register {
            email: format!("{local}@example.com"),
            password: PASSWORD.into(),
            display_name: "TOTP".into(),
            invitation: None,
        })
        .await
        .unwrap()
        .session()
        .unwrap();

    let (_, setup, _) = call(
        &app,
        "POST",
        "/internal-api/auth/totp/setup",
        Some(&user.token),
        None,
    )
    .await;
    let uri = setup["uri"].as_str().unwrap();
    let encoded = local.replace('%', "%25");
    assert!(
        uri.starts_with(&format!("otpauth://totp/Blackwall:{encoded}@example.com?")),
        "{uri}"
    );

    store.pool.close().await;
    database.cleanup().await;
}
