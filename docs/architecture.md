# Backend design

Clients register, create a workspace, then submit typed commands with the workspace revision. For example, `POST /api/workspaces/{id}/commands` carries `{"revision":0,"command":{"type":"create_team","name":"Infrastructure"}}`. Queries and commands authenticate through an opaque bearer token or an HttpOnly session cookie. Cookie mutations also require an `X-CSRF-Token` header.

## Modules

- `auth` owns Argon2 credentials, hashed sessions, recovery tokens, profiles, and account preferences.
- `domain` owns workspace permissions and work rules. `Workspace::apply` validates and executes a typed `Command`. HTTP cannot write arbitrary entity JSON.
- `store` owns portable SQL, migrations, workspace revision checks, membership indexes, attachment data, and the delivery outbox.
- `http` exposes typed JSON contracts and OpenAPI, scopes reads to current membership, and commits commands.
- `jobs` creates deadline reminders, expires invitations and tokens, and leases durable delivery work.
- `ui` renders an Askama shell; plain JavaScript calls the public API.

A command loads the current workspace, checks current membership, applies domain rules, then saves with a compare-and-swap revision update. A competing member removal also changes that revision, so stale authorization cannot commit. Bulk edits and sprint completion change one snapshot and commit together. Membership indexes update in the same transaction. A conflict returns HTTP 409; callers reload before retrying.

## Design comparison

Two independent candidates considered normalized relational tables and typed aggregate snapshots with query projections. The cross-review preferred relational persistence for mature reporting, but rejected snapshots plus manually maintained projections as unnecessary duplication for this first build. This implementation takes the aggregate command boundary and atomic edits, and the relational design's credential isolation, session hashing, durable outbox, and membership index.

Workspace snapshots simplify implementation across database engines but impose real limits. Every write serializes the workspace, unrelated editors compete on the same revision, and filters and reports scan workspace data. The initial backend targets small teams. Larger workspaces need normalized issue storage and indexed queries. The public command and query contracts can survive a later move to normalized issue tables. Imports and HTTP bodies are bounded.

Viewer access means workspace-wide read access. Viewers cannot modify work or administration. There are no private teams in this version.

SQLx selects SQLite or PostgreSQL from `DATABASE_URL`. Rust types with Serde serialization define persisted payloads and API requests. Utoipa derives JSON schemas from those types. SQLx checks SQL statements at runtime. Browser JavaScript is transport code, with server-side validation and an OpenAPI contract for future generated clients.

External delivery is at least once. Durable outbox IDs and leases prevent simultaneous workers from claiming the same attempt, while downstream tools must deduplicate retries. Deadlines recheck live issue state before generating inbox entries.
