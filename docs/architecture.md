# Backend design

Clients register, create a workspace, then submit typed commands with the workspace revision. For example, `POST /api/workspaces/{id}/commands` carries `{"revision":0,"command":{"type":"create_team","name":"Infrastructure"}}`. Queries and commands authenticate through an opaque bearer token or an HttpOnly session cookie. Cookie mutations also require an `X-CSRF-Token` header.

## Modules

- `auth` owns Argon2 credentials, hashed sessions, recovery tokens, profiles, and account preferences.
- `domain` owns workspace permissions and work rules. `Workspace::apply` validates and executes a typed `Command`. HTTP cannot write arbitrary entity JSON.
- `store` owns portable SQL, migrations, workspace revision checks, membership indexes, attachment data, and the delivery outbox.
- `http` exposes typed JSON contracts and OpenAPI, scopes reads to current membership, and commits commands.
- `jobs` runs three workers: workspace ticks for deadline reminders and invitation expiry, outbox delivery, and a sweep of expired sessions and reset tokens. `Job` types the outbox payloads.
- `web` serves the compiled React Router app from `web/build/client` and hashes its inline bootstrap scripts into the page's CSP. The app calls the public API.

A command loads the current workspace, checks current membership, applies domain rules, then saves with a compare-and-swap revision update. A competing member removal also changes that revision, so stale authorization cannot commit. Bulk edits and sprint completion change one snapshot and commit together. Membership indexes update in the same transaction. A conflict returns HTTP 409; callers reload before retrying.

## Design comparison

Two independent candidates considered normalized relational tables and typed aggregate snapshots with query projections. The cross-review preferred relational persistence for mature reporting, but rejected snapshots plus manually maintained projections as unnecessary duplication for this first build. This implementation takes the aggregate command boundary and atomic edits, and the relational design's credential isolation, session hashing, durable outbox, and membership index.

Workspace snapshots simplify implementation across database engines but impose real limits. Every write serializes the workspace, unrelated editors compete on the same revision, and filters and reports scan workspace data. The initial backend targets small teams. Larger workspaces need normalized issue storage and indexed queries. The public command and query contracts can survive a later move to normalized issue tables. Imports and HTTP bodies are bounded.

Viewer access means workspace-wide read access. Viewers cannot modify work or administration. There are no private teams in this version.

SQLx selects SQLite or PostgreSQL from `DATABASE_URL`. Rust types with Serde serialization define persisted payloads and API requests. Utoipa derives JSON schemas from those types. SQLx checks SQL statements at runtime. Browser JavaScript is transport code, with server-side validation and an OpenAPI contract for future generated clients.

Background work is scheduled by due time, not by scanning. Each commit stores `next_tick_at`, the earliest time `Workspace::tick` has work: a pending invitation expiring, a deadline entering the 24-hour reminder window, or a reminder already due. The tick worker sleeps until the earliest `next_tick_at` and only loads due workspaces. The delivery worker sleeps until the next outbox `due_at` or expired lease. Commits wake both workers, so new jobs go out right away. Sleeps are capped at five minutes, because work scheduled by another instance cannot wake this one.

External delivery is at least once. Durable outbox IDs and leases prevent simultaneous workers from claiming the same attempt, while downstream tools must deduplicate retries. Deadlines recheck live issue state before generating inbox entries.
