# Verification

The final build passed `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, and the `web/` typecheck and production build.

`cargo test` passed 10 unit tests and the API workflow suite. The workflow ran against both SQLite and a temporary PostgreSQL 18 instance using `TEST_POSTGRES_URL`.

The API suite exercised tenant isolation, role revocation, competing writes, bulk rollback, projects and milestones, filtered issues, sprint carryover, comments, time corrections and totals, uploads and authorized downloads, private response fields, portable import, signed webhook validation and deduplication, disabled integration jobs, account alert preferences, deadline deduplication, CSRF, cross-origin login protection, one-use recovery tokens, session invalidation, and outbox rollback and retry.

`cargo build` followed by `python3 scripts/smoke.py` passed against a real HTTP server. The script created a disk-backed SQLite workspace, restarted the server, checked persisted issues, observed delivery of an active invitation to a private development mail spool, checked cancellation of another invitation, and accepted the delivered token from a second account. It also fetched the rendered HTML, JavaScript asset, and generated OpenAPI schema.

No browser checks were performed. A production mail adapter and remote webhook receiver were not used during verification; tests covered local spool delivery and signed webhook ingress.
