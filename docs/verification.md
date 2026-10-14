# Verification

PostgreSQL is mandatory for integration tests. Set `TEST_POSTGRES_URL` to a PostgreSQL role with `CREATEDB`, then run `./scripts/check.sh`. The Compose PostgreSQL 17 service provides a local test role. CI uses the same major version.

Each integration test creates a disposable database. Every pooled connection uses that database; isolation does not depend on one connection's session settings. Successful tests drop their databases. Interrupted or panicking tests can leave `blackwall_test_*` databases for inspection.

`tests/api.rs` exercises feature workflows through HTTP, including permissions, stale versions, bulk rollback, planning, issue relations, comments, time totals, uploads, JSON transfer, signed webhook deduplication, preferences, CSRF, and password recovery. A separate auth test checks native identity types, one-use reset races, enqueue rollback, session invalidation, and immediate expiry rejection.

`tests/relational.rs` covers independent issue writes, numbering, database constraints, membership locking, command and workspace-creation idempotency, reminder rescheduling and completion while claimed, preferences, and fixtures. A 5,000-issue fixture verifies SQL listing, search, reports, and an indexed board query plan. `tests/queue.rs` covers queue behavior. `tests/sync.rs` runs issue sync against a mock OpenProject server: discovery, incremental and full scans, parents, the three-way merge, outbound pushes and their failure handling, comment import and duplicate protection, logging, upgrades of pre-sync data, and an ignored scan benchmark. `tests/sync_local_edits.rs` checks that local edits of synced issues succeed and that stage deletion migrates synced issues and their mappings. Pure domain tests run without database fixtures.

The completed check run passed 16 library tests, 2 API tests, 13 queue tests, 8 relational tests, and 9 frontend contract tests, along with formatting, strict Rust Clippy, frontend typechecking, and the production build. The frontend checker still reports existing warnings; it reports no errors.

Build the server and frontend, then run `python3 scripts/smoke.py` with `TEST_POSTGRES_URL`. The script creates a disposable PostgreSQL database, applies migrations twice, sends real HTTP requests, restarts the server, forces an expired email lease, and checks recovered delivery and invitation acceptance. It also checks HTML and OpenAPI. The script uses `psql` when installed, or `docker compose exec` for the local database.

Browser checks against the production frontend and a disposable PostgreSQL fixture verified login, targeted issue lists, creation, editing, stale-version recovery, comments, byte-backed uploads, bulk priority changes, inbox acknowledgement, and JSON transfer into a nonempty workspace. These are manual checks, not part of `check.sh`.

Local verification uses a private mail spool rather than production SMTP; queue tests exercise mock SMTP and HTTP receivers. Production mail and remote webhook providers require separate integration verification. The representative workspace check is not a deployment load test.
