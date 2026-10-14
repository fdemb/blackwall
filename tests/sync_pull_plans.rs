mod support;

use blackwall::store::{PULL_BATCH_RANGE_SQL, PULL_BATCH_XIP_SQL, PULL_ROLE_CHANGED_SQL, Store};
use serde_json::Value;
use uuid::Uuid;

fn plan_nodes(plan: &Value) -> Vec<&Value> {
    fn visit<'a>(node: &'a Value, nodes: &mut Vec<&'a Value>) {
        nodes.push(node);
        if let Some(children) = node["Plans"].as_array() {
            for child in children {
                visit(child, nodes);
            }
        }
    }
    let mut nodes = Vec::new();
    visit(&plan[0]["Plan"], &mut nodes);
    nodes
}

fn rows_read(node: &Value) -> f64 {
    let rows = node["Actual Rows"].as_f64().unwrap()
        + node["Rows Removed by Filter"].as_f64().unwrap_or(0.0)
        + node["Rows Removed by Index Recheck"]
            .as_f64()
            .unwrap_or(0.0);
    rows * node["Actual Loops"].as_f64().unwrap()
}

fn assert_ordered_batch(label: &str, plan: &Value) {
    let nodes = plan_nodes(plan);
    assert!(
        nodes
            .iter()
            .all(|node| !node["Node Type"].as_str().unwrap().contains("Sort")),
        "{label}: {plan}"
    );
    let scans: Vec<_> = nodes
        .iter()
        .filter(|node| node["Index Name"] == "changes_feed")
        .collect();
    assert_eq!(scans.len(), 1, "{label}: {plan}");
    let scan = scans[0];
    assert_eq!(scan["Node Type"], "Index Scan", "{label}: {plan}");
    let condition = scan["Index Cond"].as_str().unwrap();
    assert!(condition.contains("workspace_id ="), "{label}: {plan}");
    assert!(condition.contains("ROW(txid, id) >"), "{label}: {plan}");
    assert!(
        condition.contains("txid >=") || condition.contains("txid = ANY"),
        "{label}: {plan}"
    );
    assert_eq!(scan["Actual Rows"], 2000, "{label}: {plan}");
    let read = rows_read(scan);
    assert!(read <= 2001.0, "{label}: {read} rows read: {plan}");
    eprintln!("{label}: changes_feed, {read} rows read, no sort; {plan}");
}

#[tokio::test]
async fn pull_batches_bound_large_transaction_and_keyset_continuations() {
    let database = support::TestDatabase::new().await;
    let store = Store::connect(&database.url).await.unwrap();
    let workspace = Uuid::new_v4();
    let actor = Uuid::new_v4();
    let txid = 100_i64;
    sqlx::query(
        "INSERT INTO changes(workspace_id, entity, entity_id, txid) \
         SELECT $1, 'issues', gen_random_uuid(), $2 FROM generate_series(1, 100000)",
    )
    .bind(workspace)
    .bind(txid)
    .execute(&store.pool)
    .await
    .unwrap();
    sqlx::query("ANALYZE changes")
        .execute(&store.pool)
        .await
        .unwrap();
    let continuation_id: i64 = sqlx::query_scalar(
        "SELECT id FROM changes WHERE workspace_id = $1 AND txid = $2 \
         ORDER BY id OFFSET 999 LIMIT 1",
    )
    .bind(workspace)
    .bind(txid)
    .fetch_one(&store.pool)
    .await
    .unwrap();

    for (position, last) in [
        ("first", (-1, -1)),
        ("continuation", (txid, continuation_id)),
    ] {
        for (branch, sql) in [("range", PULL_BATCH_RANGE_SQL), ("xip", PULL_BATCH_XIP_SQL)] {
            let explain = format!("EXPLAIN (ANALYZE, FORMAT JSON) {sql}");
            let query = sqlx::query_scalar::<_, Value>(&explain).bind(workspace);
            let query = if branch == "range" {
                query.bind(txid)
            } else {
                query.bind(vec![txid - 1, txid, txid + 1])
            };
            let plan = query
                .bind(last.0)
                .bind(last.1)
                .bind(actor)
                .bind(2000_i64)
                .fetch_one(&store.pool)
                .await
                .unwrap();
            assert_ordered_batch(&format!("batch {branch} {position}"), &plan);
        }
    }

    store.pool.close().await;
    database.cleanup().await;
}

#[tokio::test]
async fn pull_role_check_generic_plan_skips_historical_markers() {
    let database = support::TestDatabase::new().await;
    let store = Store::connect(&database.url).await.unwrap();
    let workspace = Uuid::new_v4();
    let actor = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO changes(workspace_id, entity, entity_id, user_id, txid) \
         SELECT $1, 'roles', $2, $2, n FROM generate_series(1, 100001) n",
    )
    .bind(workspace)
    .bind(actor)
    .execute(&store.pool)
    .await
    .unwrap();
    let mut connection = store.pool.acquire().await.unwrap();
    sqlx::query("ANALYZE changes")
        .execute(&mut *connection)
        .await
        .unwrap();
    sqlx::query("SET plan_cache_mode = force_generic_plan")
        .execute(&mut *connection)
        .await
        .unwrap();
    sqlx::query(&format!(
        "PREPARE pull_role_check(uuid, uuid, bigint, bigint[]) AS {PULL_ROLE_CHANGED_SQL}"
    ))
    .execute(&mut *connection)
    .await
    .unwrap();
    let execute = format!(
        "EXECUTE pull_role_check('{workspace}', '{actor}', 100004, ARRAY[100002, 100003]::bigint[])"
    );
    let plan: Value = sqlx::query_scalar(&format!("EXPLAIN (ANALYZE, FORMAT JSON) {execute}"))
        .fetch_one(&mut *connection)
        .await
        .unwrap();
    let nodes = plan_nodes(&plan);
    let scans: Vec<_> = nodes
        .iter()
        .filter(|node| node["Relation Name"] == "changes")
        .collect();
    assert_eq!(scans.len(), 2, "{plan}");
    for (scan, predicate) in scans.iter().zip(["txid >= $3", "txid = ANY ($4)"]) {
        assert!(
            matches!(
                scan["Node Type"].as_str(),
                Some("Index Scan" | "Index Only Scan")
            ),
            "{plan}"
        );
        assert_eq!(scan["Actual Loops"], 1, "{plan}");
        assert!(
            scan["Index Cond"].as_str().unwrap().contains(predicate),
            "{plan}"
        );
    }
    let read: f64 = scans.iter().map(|scan| rows_read(scan)).sum();
    assert!(read < 10.0, "{read} rows read: {plan}");
    let changed: bool = sqlx::query_scalar(&execute)
        .fetch_one(&mut *connection)
        .await
        .unwrap();
    assert!(!changed);
    eprintln!("role check generic plan: {read} rows read; {plan}");

    drop(connection);
    store.pool.close().await;
    database.cleanup().await;
}
