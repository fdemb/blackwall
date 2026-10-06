# Blackwall

A Rust work-management API with a React Router frontend, PostgreSQL, and durable background jobs.

## Run locally

Install stable Rust, Node 22+, pnpm, and Docker. Start PostgreSQL 17 and Mailpit, then build the frontend and run the server.

```sh
docker compose up -d --wait
cp .env.example .env
(cd web && pnpm install --frozen-lockfile && pnpm run build)
cargo run
```

`cargo run` starts HTTP only. Run `cargo run -- worker` in a second terminal for email, webhooks, reminders and OpenProject sync.

The server requires a PostgreSQL `DATABASE_URL` and applies SQLx migrations at startup. `DATABASE_MAX_CONNECTIONS` defaults to 16 and `DATABASE_ACQUIRE_TIMEOUT_SECONDS` to 10. `.env.example` uses `postgres://blackwall:blackwall@127.0.0.1:5432/blackwall`. The Compose services bind to loopback, and PostgreSQL keeps local data in the `postgres-data` volume. Set `POSTGRES_PORT` to change the host port and update your database URLs to match.

Open `http://127.0.0.1:3000`, register an account, and create a workspace. Create a team before adding issues.

The server serves `web/build/client`. Set `WEB_DIR` to use another build. For frontend development, run `cargo run` and `pnpm run dev` inside `web/`. Vite proxies `/api` to port 3000 and serves the app on port 5173.

Apply migrations without starting HTTP or workers:

```sh
DATABASE_URL=postgres://blackwall:blackwall@127.0.0.1:5432/blackwall ./scripts/database.sh migrate
```

Stop the app before running `./scripts/database.sh reset`. Reset deletes and recreates only the local Compose `blackwall` database, then applies migrations. Load a deterministic workspace after reset:

```sh
cargo run -- fixtures empty
# Or load the feature-rich fixture into a fresh database.
cargo run -- fixtures rich
```

Fixtures use `fixture-password-123`. The empty fixture account is `empty@example.com`; the rich fixture accounts are `owner@example.com` and `member@example.com`. Load each fixture once per fresh database.

There is no converter for old development databases.

Checked SQL compiles offline using the committed `.sqlx` metadata. After changing a checked query, regenerate its metadata against a migrated PostgreSQL database:

```sh
SQLX_OFFLINE=false SQLX_OFFLINE_DIR=.sqlx DATABASE_URL=postgres://blackwall:blackwall@127.0.0.1:5432/blackwall cargo check --all-targets
```

## API

`GET /api/schema.json` exposes OpenAPI generated from Rust types. API clients use `Authorization: Bearer <session token>`. The browser uses an HttpOnly, SameSite=Strict cookie. Cookie mutations require `X-CSRF-Token`, returned at login and by `GET /api/me`.

Workspace creation accepts an optional `idempotency_key`, scoped to the authenticated user. The frontend keeps this key across an ambiguous creation failure.

Commands carry versions for the entities they edit. Creates usually use an empty map. For example:

```json
{
  "expected_versions": {},
  "idempotency_key": "create-infrastructure-team",
  "command": {
    "type": "create_team",
    "name": "Infrastructure",
    "members": []
  }
}
```

Send commands to `POST /api/workspaces/{id}/commands`. Responses contain `result`, a UUID-to-version `versions` map, and `changes`: every record the command changed that the caller can see, including side effects such as a parent's subtask counts, a dependent's blocker count, or a member's team list. Each change is `{entity,id,record}`, where `record` has the shape its list endpoint returns and `null` means deleted or no longer visible. A replayed idempotent command reports those records as they are now. Issue edits require the issue's current version. Bulk edits require every affected issue's version. HTTP 409 means a stale version or conflicting idempotency key; fetch the affected entities before retrying. Idempotency keys are optional strings scoped to the workspace and actor. Reusing a key with the same request returns the recorded result.

`GET /api/workspaces/{id}` returns workspace metadata. Read work through `/issues`, `/issues/{issue}`, `/teams`, `/projects`, and the other feature collections. Collections return `{items,has_more,next_offset}` with `limit` and `offset`. The default limit is 100 and the maximum is 200. `/members` returns an array. Comments and time entries accept `issue_id`; activity accepts `entity_id`.

`GET /api/workspaces/{id}/changes?since=<cursor>` returns `{cursor,reset,changes}` for records changed by anyone since the cursor, in the same format. Request it without `since` before loading records, then poll with the returned cursor. Changes can repeat, so apply them by version. When `reset` is true, either the cursor predates the retained history (`JOBS_RETENTION_DAYS`) or more than 1,000 records changed. Reload everything and continue from the returned cursor. Database triggers record changes from every write path, including imports, jobs, and invitation acceptance.

Uploads send `expected_versions` as multipart JSON alongside the file. Imports send `expected_versions` and `issues` or `transfer`. A create-only import accepts `{}`.

The API includes membership and invitations, workflows, labels, issue relations, projects, milestones, sprint carryover, saved views, comments, uploads, inbox preferences, time corrections, reports, search, bulk actions, trash, activity, JSON transfer, signed webhooks, and account recovery.

## Background delivery

`blackwall serve` runs HTTP only. `blackwall worker` runs jobs only. Run both processes in production. Workers claim PostgreSQL jobs with leases and bounded attempts. Database changes and their jobs commit together. Workers use separate limits for email, webhook, and database jobs. `.env.example` documents concurrency, idle polling, shutdown drain time, and history retention. The idle poll interval is at most five seconds. Failed jobs expire after `JOBS_FAILED_RETENTION_DAYS`.

A missing or stuck worker shows up as a growing `oldest_overdue_seconds`. It is reported by `blackwall queue status` and by the worker periodic "database and queue pressure" log line. Alert on it.

The worker drains in-flight jobs for up to `JOBS_DRAIN_SECONDS` (default 50s, max 120s). Set the process manager stop timeout above that. For example, set Kubernetes `terminationGracePeriodSeconds` above the drain timeout. Its default is 30s. Otherwise the process is killed mid-drain and its leases expire after 120s before another worker retries them.

Queue administration requires shell and database access:

```sh
cargo run -- queue status
cargo run -- queue failed 50
cargo run -- queue retry <job-uuid>
cargo run -- queue cancel <job-uuid>
```

Delivery is at least once. A crash after an external service accepts a request can cause another delivery.

Set `SMTP_URL`, such as `smtps://user:password@smtp.example.com` or `smtp://smtp.example.com:587?tls=required`, and `SMTP_FROM`. Percent-encode URL credentials. Email uses a stable Message-ID derived from the job. SMTP servers do not guarantee deduplication. Invalidated invitation and password-reset grants suppress queued mail. Without SMTP or a development spool, workers leave email jobs pending without consuming attempts.

For local mail, set `SMTP_URL=smtp://127.0.0.1:1025` and read Mailpit at `http://127.0.0.1:8025`. Alternatively, set `DEV_MAIL_DIR=./dev-mail` to write private JSON files with mode 0600. The spool takes precedence over SMTP. Keep the directory private.

Outgoing integration requests use `Idempotency-Key` and `X-Blackwall-Signature: sha256=<hex HMAC-SHA256>`. Incoming source links use `POST /api/workspaces/{id}/integrations/{integration}/webhook`, signed over the exact request body:

```json
{
  "delivery_id": "a unique UUID",
  "issue_id": "the issue UUID",
  "url": "https://git.example.com/team/repo/pull/42",
  "title": "Certificate rotation"
}
```

Generic signed webhooks and source links are included. OpenProject connections import basic work-package fields into selected teams through five-minute background polling. Imported issues are read-only, and settings uses asynchronously discovered project choices. See [OpenProject sync](docs/openproject.md) for setup, field ownership, and operational limits. Provider-specific OAuth and automatic repository synchronization are not included.

## Verify

Integration tests require PostgreSQL and a role with `CREATEDB`. Each test creates a disposable database visible to all application pool connections.

```sh
export DATABASE_URL=postgres://blackwall:blackwall@127.0.0.1:5432/blackwall
export TEST_POSTGRES_URL="$DATABASE_URL"
./scripts/check.sh
cargo build --locked
python3 scripts/smoke.py
```

`check.sh` runs formatting, Clippy, Rust tests, and frontend checks. The smoke script runs real HTTP, applies migrations twice, restarts the server, and exercises expired job lease recovery. It requires `psql` or the local Compose PostgreSQL service. No browser verification is required. See [verification](docs/verification.md) for coverage and limits.

## Current limits

Roles are owner, admin, member, and viewer. Viewers read the workspace and manage personal views, follows, and their inbox. Teams do not have separate visibility rules. Markdown output is sanitized. English and Polish localization covers frontend labels; domain validation messages remain English.

JSON transfer remaps entity IDs and preserves work relationships, comments, time entries, trash, and planning history. Unknown comment and time authors become the importing user. Credentials, integration secrets, invitations, and inbox contents stay out of exports. Transfer omits attachment bytes, so use a database backup to preserve uploads.

Use HTTPS, set `COOKIE_SECURE=true`, configure mail, and back up PostgreSQL before deployment. [Backend design](docs/architecture.md) describes transaction boundaries and concurrency.
