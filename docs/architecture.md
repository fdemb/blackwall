# Backend design

Blackwall uses PostgreSQL-only storage through SQLx. Identity records use native UUIDs, JSONB profiles, and UTC timestamps. Sessions and reset credentials store token hashes. Auth hashes passwords with Argon2 and requires CSRF headers for cookie mutations.

## Transactions and versions

Commands run feature operations that own their transactions. Operations authorize the actor, validate references, lock affected records, check entity versions, write changes, and enqueue jobs before commit. Unrelated issues have independent versions. Bulk edits require every affected version and commit together.

Mutations take a shared authorization advisory lock and hold a shared lock on the actor's membership through commit. Revocation takes both locks exclusively. An operation that acquired the locks first can finish; operations after revocation cannot use stale membership.

A separate graph advisory lock is shared for ordinary issue writes and exclusive for planning, deletion, and relationship mutations, preventing stage/issue lock inversion. Multi-entity operations lock affected rows in deterministic order. Workspace creation and commands record actor-scoped idempotency results in their business transactions.

The API returns workspace summaries and paginated feature collections. Issue lists retain the full record shape by default for offline synchronization. An opt-in `projection=summary` omits descriptions and detail-only relations. Ungrouped `sort=updated` lists support filter-scoped `after` cursors alongside existing offset pagination. Lists select page IDs before rendering related data. Full-text, substring, and issue-number search use separate indexable branches; short substring queries retain their full search reach. It does not return or persist whole-workspace snapshots. Issues, planning, discussion, memberships, and personal state occupy relational tables. Composite foreign keys reject references across workspaces. Attachment bytes use `bytea`. JSONB holds flexible filters, profiles, job payloads, and historical fields.

The frontend keeps workspace data in TanStack DB collections backed by TanStack Query (`web/app/lib/db.ts`). Opening a workspace takes a change-feed cursor, then loads metadata collections, members, notifications, and every issue, trash and archive included. Issue lists, search, and filters are live queries over the local issue collection (`web/app/lib/queries.ts`). Comments, time entries, and activity load per issue: their live queries push the issue id down to the API. Commands run as TanStack Query mutations in one per-workspace scope, so they reach the server in order. Commands with a predictable local effect apply it through `createOptimisticAction`, and a refused write rolls it back (`web/app/lib/commands.ts`). Command responses and the change feed, polled every five seconds as a query, write changed records into the collections (`web/app/lib/sync.ts`). Loading every issue suits workspaces up to roughly ten thousand issues; beyond that the issue collection should switch to on-demand loading.

## Modules

- `auth` owns credentials, hashed sessions, recovery tokens, profiles, and account preferences.
- `domain` defines commands, DTOs, permissions, and pure business rules. Its `issues` module groups issue records, source identities, inputs, patches, and filters.
- `store` owns PostgreSQL feature transactions, queries, version checks, and migrations. Its ownership policy authorizes commands before dispatch and generates frontend capabilities. Imported-field guards report the `blackwall_issue_ownership` constraint identifier; administrative stage migration grants only a specific workspace and stage replacement.
- `http` authenticates requests and exposes JSON contracts and OpenAPI.
- `jobs` claims persisted work, handles delivery and maintenance, and coordinates shutdown.
- `openproject` owns connection settings, cached discovery, project-to-team mappings, and one-way background imports. Transport reuses a pooled HTTP client and fetches one bounded page without holding a database connection. The scan module normalizes the response and advances a tagged checkpoint with a fixed incremental window. Discovery publishes complete resources from separately stored pages. Reconciliation performs page-scoped lookups and calls shared store persistence only for changed issues, with batched numbering and cached effect metadata. Periodic full scans and unsupported-filter fallback preserve eventual reconciliation. Imported issues and their checkpoint commit together with claim and configuration-generation fencing.
- `web` serves the frontend build with CSP hashes for inline bootstrap scripts.

## Recovery and delivery

Password-reset requests create the hashed credential and email job in one transaction. Password recovery consumes one valid reset token, updates the password, and invalidates sessions and remaining reset tokens atomically. Password changes compare the previous password hash before updating to reject competing changes.

The PostgreSQL queue uses due times, claim tokens, bounded attempts, and leases. Workers commit claims before external I/O. Completion checks claim ownership, so expired workers cannot overwrite a newer claim. `LISTEN` and `NOTIFY` wake other instances, while polling remains the correctness mechanism after missed notifications.

External delivery is at least once. Webhooks carry stable idempotency keys, and email keeps the same Message-ID across attempts. SMTP does not promise to suppress duplicates. Database-only reminder effects and job completion commit together.

SQLx migrations in `migrations/` define the clean schema. The application requires a PostgreSQL URL and applies migrations when it connects. Runtime queries bind native database types. Workspace metadata queries use checked SQLx macros and committed `.sqlx` metadata, with offline compilation enabled in `.cargo/config.toml`. PostgreSQL integration tests validate dynamic feature queries.

Maintenance logs pool size and idle connections, lock waiters, queue depth, oldest overdue age, and failed-job counts. Job attempts log execution duration without payloads or credentials. OpenProject page logs split HTTP, normalization, pool acquisition, connection/workspace locking, and reconciliation time. See [backend performance](performance.md) for read contracts, benchmarks, and deployment considerations.

Issues in a Done stage (cancelled excluded) auto-archive past their team's `archive_after_days` deadline via a periodic sweep that also backfills the Done-entry clock; a NULL deadline means never. Mirrored OpenProject issues follow the same rule, with the sync starting the clock on entering Done and clearing both the clock and the archive when a package reopens. Archived issues stay out of default listings, reports, and counts but remain readable by id, restorable, and read-only until unarchived. Manual archive and unarchive commands, including bulk variants, enforce the same Done-only rule.
