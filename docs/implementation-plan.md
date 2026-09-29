# Implementation plan

- [x] Ground: empty repository; no existing integration constraints.
- [x] Sketch: compare relational and aggregate designs.
- [x] Agree: synthesize design and proceed under existing authorization.
- [x] Implement: typed Rust domain, persistence, auth, work API, scheduler, HTML client.
- [x] Verify: compile, integration tests, real HTTP flows on SQLite and PostgreSQL.
- [x] Scrap: reviewed persistence and API boundaries; retained snapshots with explicit limits and upgraded portable transfer after verification.

Design evaluation: capability coverage, tenant isolation, portable persistence, atomic updates, typed contracts, and maintainability.
