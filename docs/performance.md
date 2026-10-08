# Backend performance

## Changes

OpenProject workers reuse an HTTP client across pages. Reconciliation resolves stages and assignees, locks existing imported issues, and repairs source links in batches. Unchanged issues avoid detail hydration and individual queries. New imports allocate issue numbers and stage positions together and insert complete issue rows. Shared persistence caches audit owners, stage kinds, and webhook destinations per page. Follower change notifications use one set-based insert per changed issue and still apply membership and alert preferences.

Discovery stores each normalized page separately and publishes a cache only when its resource finishes. Work-package checkpoint updates do not read or rewrite those caches. Configuration validation checks referenced IDs in batches; name-only and no-op saves leave active scans alone.

Automatic polling uses fixed, overlapping datetime windows between periodic unfiltered discovery scans. Unsupported date filters fall back to full polling. See [OpenProject sync](openproject.md) for the cadence, overlap, and recovery rules. The workspace graph lock remains in place, but reconciliation performs fewer queries while holding it. Increasing worker concurrency does not parallelize one connection.

Issue lists select a bounded page of IDs before building their JSON records. Search combines independent full-text, substring, and numeric-ID branches. Migration `0011_read_performance.sql` installs the trusted PostgreSQL `pg_trgm` extension and adds a substring GIN index and an active-issue Updated ordering index. The migration role needs permission to install the extension, or an administrator must install it first. Short substring searches can still scan a workspace; they do not silently exclude older matches.

## Read contracts

Existing issue lists, issue details, change-feed records, and exports retain their full shapes by default.

For a lighter list response, request `projection=summary`. Summary includes issue scalar fields, source ownership metadata, labels, and blocker/subtask counts. It omits `description`, `dependencies`, `followers`, `attachments`, and `source_links`. Do not replace a complete offline issue record with a summary.

Ungrouped `sort=updated` lists return `next_cursor` when another page exists. Pass that token as `after` with `offset=0` to continue. Cursors use descending update times and ascending UUIDs, preserve ties, and validate their version, workspace, and filter scope. The projection and page size can change without invalidating the cursor. Filters cannot. Existing `offset` and `next_offset` pagination remains available.

Cursor pagination is not a snapshot. An issue updated between pages can move ahead of the cursor. Consumers that need a complete synchronized copy should use the sync protocol in [sync engine](sync.md).

## Measurement

OpenProject debug logs split each page's work into `http_ms`, `normalize_ms`, `pool_ms`, `connection_lock_ms`, `lock_ms`, and `reconcile_ms`, plus total elapsed time. No tokens, URLs, emails, titles, descriptions, or response bodies enter these logs. Existing queue maintenance logs expose pool and lock pressure.

Run the repeatable benchmark against disposable PostgreSQL databases and a local mock OpenProject server:

```sh
TEST_POSTGRES_URL=postgres://blackwall:blackwall@127.0.0.1:5432/blackwall \
  cargo test --locked --test openproject benchmark_thousand_issue_scans \
  -- --ignored --nocapture
```

One local debug-build run with 1,000 remote issues, 50-item pages, and 25 concurrent local writes produced:

| Work | Time |
| --- | --- |
| Initial import with concurrent writes | 1,059 ms |
| Unchanged full scan | 250 ms |
| Full scan with one changed package | 206 ms |
| Empty incremental scan | 6 ms |
| Concurrent local write p95 | 45 ms |

The unchanged full scan emitted 503 SQLx query events, including configuration, scheduling, claiming, transactions, and reconciliation. The former per-item reconciliation path alone required roughly 6,000 queries for 1,000 unassigned packages using default stage resolution. The benchmark checks a query-event budget to catch a return to per-item lookups.

These results measure a local mock and PostgreSQL, not a production OpenProject installation. HTTP/TLS latency, response sizes, assignees, follower counts, webhook fan-out, and database placement affect deployment results. Use the phase timings to compare initial imports, unchanged polls, and small updates in the actual deployment before raising concurrency or page sizes.

Regression tests cover connection reuse, unchanged local data, source-link repair, alert preferences, completed-cache publication, configuration no-ops, incremental windows, unsupported-filter fallback, watermark fencing, upgrade recovery, summary responses, search equivalence, and cursor scope/ties.
