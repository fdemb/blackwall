# PostgreSQL migration plan

Replace Blackwall's current persistence with PostgreSQL-only relational storage and a durable PostgreSQL job queue. Keep Axum, Tokio, and the React frontend.

The app is not deployed. Existing development data can be discarded. Change backend and frontend contracts together without supporting old versions.

Implemented and verified against PostgreSQL 17. See [verification](verification.md) for test coverage, browser checks, and deployment limits.

## Scope and decisions

- PostgreSQL is the only runtime and integration-test database.
- Replace workspace snapshots with normalized records. A driver swap alone would keep workspace-wide write conflicts and in-memory queries.
- Start with a clean schema and recreate development databases. No legacy converter, dual writes, data preservation, or cutover procedure.
- Keep one Rust crate and one application deployment. Organize operations by feature rather than adding generic repository abstractions.
- Keep useful business rules, credential/session hashing, CSRF protection, and atomic job enqueueing.
- Use a PostgreSQL queue in the same database. No Redis, external broker, or workflow engine.
- Replace the workspace revision contract directly with per-entity versions. Update the frontend and tests in the same work.

## 1. PostgreSQL foundation

- [x] Replace SQLx `AnyPool` and portable connection types with `PgPool` and PostgreSQL types in storage, auth, and jobs.
- [x] Remove SQLx `any` and SQLite features. Enable PostgreSQL, migrations, macros, UUID, chrono, and JSON support as needed.
- [x] Require `DATABASE_URL` and reject non-PostgreSQL URLs. Remove the implicit SQLite default.
- [x] Add PostgreSQL to `compose.yaml` alongside Mailpit, with loopback ports, a health check, and persistent local storage. Pin a supported major version for development and CI.
- [x] Replace the custom migration runner with SQLx migrations in `migrations/`. Provide a simple migrate/reset workflow for development and tests.
- [x] Configure database pool size and acquisition timeout. Establish checked SQL queries and offline metadata where practical.
- [x] Update `.env.example` and startup instructions.

Done when a fresh PostgreSQL database starts the app, migrations apply successfully, and no runtime SQLite path remains.

## 2. Relational schema

Build the new schema from the current domain model, preserving product behavior rather than existing storage formats.

- [x] Identity: users, sessions, password resets, workspace memberships, and invitations.
- [x] Planning: workspaces, teams, team memberships, workflow stages, labels, projects, project teams, milestones, sprints, and sprint outcomes.
- [x] Work: issues, labels, dependencies, followers, source links, ordering, and soft deletion.
- [x] Discussion: comments, mentions, time entries, attachment metadata, and attachment bytes stored as `bytea` instead of hexadecimal text.
- [x] Personal and integration data: saved views, alert preferences, notifications, activity, integrations, and inbound webhook deduplication.
- [x] Jobs: queue records as described in section 4.

Use native UUIDs and `timestamptz`. Keep JSONB for flexible preferences, saved filters, job payloads, and historical details, not whole workspaces.

Add foreign keys, uniqueness, and checks for domain invariants. Include workspace ownership in tenant-scoped records and prevent cross-workspace references, including issue/team/stage and project/milestone relationships. Preserve historical authorship when someone leaves a workspace.

- [x] Add per-entity versions for editable records and atomic issue-number allocation with uniqueness at the existing numbering scope.
- [x] Index actual list, detail, deadline, notification, session, and job queries.
- [x] Create deterministic fixtures for empty and feature-rich workspaces. Use these instead of migrating old development data.

Done when fixtures load and database constraints reject invalid references and duplicate identities.

## 3. Feature operations and frontend contracts

- [x] Move authorization, validation, affected-row reads, business writes, activity entries, and job creation into transaction-owning feature operations.
- [x] Start with issue create/update, then cover memberships, planning, discussion, uploads, bulk edits, imports, and integrations.
- [x] Extract reusable rules from `Workspace::apply` and workspace operations. Normal requests must not load or rewrite a full workspace.
- [x] Define one authorization locking protocol for mutations and member revocation. For example, mutations hold a shared membership-row lock through commit and revocation takes an exclusive lock. Recheck permissions after acquiring locks.
- [x] Replace workspace revision preconditions with versions on affected entities. Unrelated issue edits must succeed independently.
- [x] Lock affected rows in a deterministic order for multi-record operations. Preserve all-or-nothing bulk edits and sprint completion.
- [x] Replace whole-workspace frontend reads with targeted detail requests and paginated lists. Implement filtering, search, and reports in SQL.
- [x] Change command/request types, OpenAPI, frontend calls, conflict handling, uploads, imports, and tests together. Delete the old revision contract rather than maintaining compatibility.
- [x] Keep import/export behavior, security exclusions, and attachment handling. Transfer is a product capability, not a legacy database conversion mechanism.
- [x] Add operation idempotency where retrying creates or external submissions could duplicate work. Scope keys appropriately and record results atomically.

Done when every existing capability uses relational operations and targeted queries, independent writes do not conflict, and stale edits and revoked permissions are handled correctly.

## 4. PostgreSQL job queue

Replace `src/store/outbox.rs` with a PostgreSQL-specific queue while retaining enqueueing in the business transaction. Start with email and webhook delivery.

### Storage and claiming

- [x] Store job ID, kind, payload version, JSONB payload, queue, state, `run_at`, attempts, maximum attempts, claim token, lease expiry, timestamps, deduplication key, and bounded last error.
- [x] Define pending, running, succeeded, failed, and cancelled states. Index due pending jobs and expired running leases.
- [x] Enqueue through the operation's SQL transaction. Rollback must remove both business changes and queued work.
- [x] Claim due jobs in a short transaction with `FOR UPDATE SKIP LOCKED`. Assign a fresh claim token, lease, and incremented attempt count; commit before doing external I/O.
- [x] Recover expired leases safely. Require the current claim token for complete, retry, renew, and cancellation coordination so stale workers cannot overwrite a newer claim.
- [x] Use database time for due checks and leases. Claim only as many jobs as there are free execution slots.

### Execution and failures

- [x] Add bounded execution concurrency with separate email and webhook limits. Budget database connections for HTTP and workers.
- [x] Keep explicit per-kind timeouts. Start delivery with the existing 45-second timeout and 120-second lease. Add renewal only for job kinds that need longer execution.
- [x] Retry transient failures with capped exponential backoff and jitter. Fail malformed payloads and permanent errors visibly.
- [x] Enforce maximum attempts, including repeated lease expiry after crashes. Do not retry indefinitely.
- [x] Define missing SMTP behavior explicitly, such as pausing email delivery until configured.
- [x] Add restricted CLI commands for status, failed-job inspection, retry, and cancellation. Keep payloads and secrets out of routine logs.
- [x] Version job payloads for future upgrades and bound payload/error sizes. Clean up completed history using a documented retention setting.

### Wakeups and guarantees

- [x] Use transactionally emitted PostgreSQL `NOTIFY` and a dedicated `LISTEN` connection to wake workers across instances. Notifications carry no sensitive payload.
- [x] Retain indexed polling for correctness and scan after listener reconnection. Start with a configurable maximum five-second idle poll interval.
- [x] Document at-least-once delivery. Preserve webhook idempotency keys and stable email Message-IDs, without claiming SMTP deduplicates messages.
- [x] For database-only jobs, commit effects and completion together under claim ownership. Enforce notification deduplication with unique constraints.
- [x] Stop claiming on shutdown, drain for a bounded period, and let abandoned leases expire. An interrupted external request may already have succeeded.
- [x] Keep HTTP and workers together initially, with a worker-only run mode available from the same binary if needed.

Done when multiple workers claim safely, restarts recover abandoned work, permanent failures are inspectable, and rolled-back operations enqueue nothing.

## 5. Reminders and periodic work

- [x] Replace workspace ticks with scheduled reminder jobs. Remove `next_tick_at` and full-workspace reminder scans.
- [x] Track a reminder generation per issue. Deadline and status changes supersede old jobs and schedule the current generation in the same transaction.
- [x] Deduplicate reminders by issue, generation, recipient, and kind so rescheduling can legitimately produce a new reminder.
- [x] At execution, recheck generation, deadline, status, membership, and preferences. Commit inbox changes and job completion atomically.
- [x] Preserve the existing reminder window and define behavior for late jobs. Use UTC instants; introduce timezone rules only if calendar recurrence is added.
- [x] Expire invitations through indexed queries and transactional updates.
- [x] Run bounded session/reset-token cleanup through a unique periodic job or advisory-lock-protected sweep. Authentication still rejects expired credentials immediately without waiting for cleanup.
- [x] Coalesce missed cleanup runs and skip reminders that are no longer relevant.

Done when reminders survive restart and rescheduling, stale jobs produce no inbox entries, and multiple workers do not duplicate maintenance effects.

## 6. Verification and cleanup

- [x] Make PostgreSQL mandatory in `tests/api.rs`, `scripts/check.sh`, and CI. Remove optional PostgreSQL coverage and SQLite test loops.
- [x] Isolate tests with disposable databases or schemas visible to the application's pooled connections. Keep pure domain unit tests.
- [x] Update `scripts/smoke.py` for PostgreSQL, real HTTP, restart, and worker recovery checks.
- [x] Test clean database creation, migrations, fixture loading, and database reset.
- [x] Test independent issue edits, stale versions, membership revocation, issue numbering, tenant isolation, bulk rollback, and inbound webhook deduplication.
- [x] Test competing workers, expired leases, stale tokens, retries, permanent failure, maximum attempts, cancellation, listener loss, and shutdown.
- [x] Test deadline/status changes while reminders are running. Check atomic notification deduplication and duplicate external-delivery behavior.
- [x] Verify frontend create/edit, conflict recovery, lists, uploads, bulk actions, inbox, and transfer against the changed contracts.
- [x] Check query plans and representative large-workspace behavior. Track pool pressure, lock waits, queue depth, oldest overdue-job age, failures, and execution duration.
- [x] Delete snapshot storage, the old migration runner, portable outbox claims, old scheduler code, and obsolete workspace revision paths.
- [x] Update README, architecture and verification docs, and product-context references. Document fresh setup, reset, worker operation, and failed-job recovery.

Done when checks pass against PostgreSQL, the frontend works with the new contracts, and normal operations have no SQLite or workspace-snapshot dependency.

## Suggested implementation batches

1. PostgreSQL configuration, local services, migrations, and mandatory test infrastructure.
2. Relational schema and fixtures.
3. Queue module, delivery workers, and multi-worker tests.
4. Auth/membership and issue operations, including the new frontend contracts.
5. Remaining planning, discussion, reporting, transfer, and integration operations, split by capability.
6. Reminders, maintenance, end-to-end checks, and removal of obsolete code.

The queue can proceed after its schema lands. The largest task is moving all product operations away from snapshots, not swapping the SQLx driver.

## Completion checklist

- [x] PostgreSQL is the only runtime and integration-test database.
- [x] Normal reads and writes use relational records, not whole-workspace snapshots.
- [x] Entity versions, authorization, and bulk transactions preserve correct behavior.
- [x] Business changes and jobs commit together.
- [x] Workers recover across restarts and expose failures with bounded execution and retries.
- [x] Reminders handle rescheduling without stale or duplicate inbox entries.
- [x] Backend, frontend, tests, and documentation agree on the new model.
