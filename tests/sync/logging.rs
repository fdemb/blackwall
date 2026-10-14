use super::*;
use std::io::{self, Write};

#[derive(Clone, Default)]
struct LogWriter(Arc<std::sync::Mutex<Vec<u8>>>);

impl Write for LogWriter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

#[tokio::test]
async fn debug_logs_follow_sync_without_credentials_or_imported_content() {
    let logs = LogWriter::default();
    let writer = logs.clone();
    let subscriber = tracing_subscriber::fmt()
        .with_env_filter("blackwall::sync=debug")
        .with_ansi(false)
        .without_time()
        .with_writer(move || writer.clone())
        .finish();
    tracing::subscriber::set_global_default(subscriber).unwrap();
    let (url, email) = async {
        let db = support::TestDatabase::new().await;
        let store = Store::connect(&db.url).await.unwrap();
        let owner = account(&store).await;
        let (workspace, team, _) = setup(&store, &owner).await;
        let app = http::router(store.clone());
        let mock = Mock::default();
        {
            let mut remote = mock.data.lock().await;
            remote.assignee_email = Some(owner.profile.email.clone());
            remote.assignee_id = Some(10);
        }
        let (url, server) = mock_server(mock).await;
        let base = format!("/api/workspaces/{workspace}/sync/connections");
        let (status, config) = call(
            &app,
            &owner,
            "POST",
            &base,
            Some(json!({
                "provider":"openproject","name":"Private connection name","base_url":url,"token":TOKEN,
                "projects":[{"project_id":"42","team_id":team}]
            })),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED);
        drain(&store).await;
        assert_eq!(issues(&app, &owner, workspace).await.len(), 2);
        let action = format!("{base}/{}/sync", config["id"].as_str().unwrap());
        let (status, _) = call(&app, &owner, "POST", &action, None).await;
        assert_eq!(status, StatusCode::ACCEPTED);
        drain(&store).await;
        server.abort();
        store.pool.close().await;
        db.cleanup().await;
        (url, owner.profile.email)
    }
    .await;
    let output = String::from_utf8(logs.0.lock().unwrap().clone()).unwrap();
    for message in [
        "Sync configuration saved",
        "Sync scan requested",
        "Sync jobs scheduled",
        "OpenProject HTTP request started",
        "OpenProject HTTP response received",
        "OpenProject HTTP request completed",
        "OpenProject page normalized",
        "Sync status mapped",
        "Sync assignee mapped",
        "Sync remote issue reconciled in page transaction",
        "Sync page committed",
        "connection_id=",
        "remote_id=7",
        "changed=false",
        "status=200",
    ] {
        assert!(output.contains(message), "missing log entry: {message}");
    }
    for private in [
        TOKEN,
        &url,
        &email,
        "Private connection name",
        "First package",
        "Imported **description**",
    ] {
        assert!(
            !output.contains(private),
            "private data appeared in debug logs"
        );
    }
}
