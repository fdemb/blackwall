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

`cargo run` starts HTTP only. Run `cargo run -- worker` in a second terminal for email, webhooks, reminders and issue trackers.

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

Run `./scripts/worktree.sh init` in a linked git worktree. It writes a `.env` with its own database and HTTP port, reuses the main checkout's Compose services and Rust build cache, builds the frontend, and applies migrations. `FIXTURE=rich` loads a fixture into a new database. In the worktree, `pnpm run dev` proxies to that port and `./scripts/database.sh reset` resets only that database. Run `./scripts/worktree.sh drop` before removing the worktree.

Checked SQL compiles offline using the committed `.sqlx` metadata. After changing a checked query, regenerate its metadata against a migrated PostgreSQL database:

```sh
SQLX_OFFLINE=false SQLX_OFFLINE_DIR=.sqlx DATABASE_URL=postgres://blackwall:blackwall@127.0.0.1:5432/blackwall cargo check --all-targets
```

## API

Integrations, scripts and AI agents use the public API at `/api/v1` and the MCP server at `/mcp`, authenticated with personal access tokens. See [public API](docs/api.md); `GET /api/v1/openapi.json` describes it.

The rest of this section covers `/internal-api`, the web app's own API, which can change without notice. `GET /internal-api/schema.json` exposes OpenAPI generated from Rust types. Its clients use `Authorization: Bearer <session token>`. The browser uses an HttpOnly, SameSite=Strict cookie. Cookie mutations require `X-CSRF-Token`, returned at login and by `GET /internal-api/me`.

Workspace creation takes a `slug`, the workspace's name in app URLs: lowercase letters, digits and single hyphens, at most 48 bytes, unique across the server. It accepts an optional `idempotency_key`, scoped to the authenticated user. The frontend keeps this key across an ambiguous creation failure.

Commands optionally carry versions for the entities they edit. Omit `expected_versions` for last-writer-wins. For example:

```json
{
  "expected_versions": {},
  "idempotency_key": "create-infrastructure-team",
  "command": {
    "type": "create_team",
    "name": "Infrastructure",
    "key": "INF",
    "members": []
  }
}
```

Send commands to `POST /internal-api/workspaces/{id}/commands`. Responses contain `result`, a UUID-to-version `versions` map, and `changes`: every record the command changed that the caller can see, including side effects such as a member's team list. Count changes alone do not return parents or dependents. Each change is `{entity,id,record}`, where `record` has the shape its list endpoint returns and `null` means deleted or no longer visible. A replayed idempotent command reports those records as they are now. Issue edits may include the issue's current version; bulk edits may include every affected issue's version. A sent version that is stale returns HTTP 409; fetch the affected entities before retrying. Idempotency keys are optional strings scoped to the workspace and actor. Reusing a key with the same request returns the recorded result.

Sync clients push ordered mutations to `POST /internal-api/workspaces/{id}/sync/push` with a client-chosen `client_id` UUID. Each entry is `{id, name, args, at}`; `name` plus `args` form a command run without version preconditions. A request holds 1 to 100 mutations with strictly increasing positive ids; gaps are fine and replays dedupe by id. Responses return `last_mutation_id` and per-mutation `applied`, `duplicate` or `rejected` outcomes; business errors reject one mutation while transient failures stop the batch with HTTP 503. `GET /internal-api/me` and the login/register responses include a non-secret `session_id` naming the replica; it never authenticates anything.

`GET /internal-api/workspaces/{id}` returns workspace metadata. Read work through `/issues`, `/issues/{issue}`, `/teams`, `/projects`, and the other feature collections. Collections return `{items,has_more,next_offset}` with `limit` and `offset`. The default limit is 100 and the maximum is 200. `/members` returns an array. Comments and time entries accept `issue_id`; activity accepts `entity_id`.

`GET /internal-api/workspaces/{id}/sync/pull?client_id=<uuid>&cursor=<cursor>` returns `{cursor,more,reset,last_mutation_id,changes}` with records in list shapes except issue counts, and `null` for deleted or invisible rows. The cursor is an opaque PostgreSQL snapshot in `xmin:xmax:xip` text form. Omit `cursor` for a starting cursor. Pages hold 1,000 distinct records cut at transaction boundaries after scanning at most about 20,000 change rows; `more` pages and resets report `last_mutation_id` null, and only a final page reports it. When `reset` is true, bootstrap again from the returned cursor. Database triggers record changes from every write path, including imports, jobs, and invitation acceptance.

`GET /internal-api/workspaces/{id}/sync/bootstrap?client_id=<uuid>` streams `application/x-ndjson` from one repeatable-read snapshot. The header carries `cursor`, `last_mutation_id` and `schema`; each record line is `{entity,record}`. The final `{end:true,records:<count>}` confirms completion; discard a stream without it. `Accept-Encoding: gzip` enables gzip. Bootstrap includes all always-loaded entities, including trashed and archived issues, with pull's visibility rules. Sync issues omit `blocked_count`, `subtask_total` and `subtask_completed`; REST reads and command responses keep them.

`GET /internal-api/workspaces/{id}/sync/scope?client_id=<uuid>&entity=comments&issue_id=<uuid>` returns `{records:[...]}` for one issue. `entity=activity&entity_id=<uuid>` loads one entity's history. Both read all scope records from one repeatable-read snapshot. Bootstrap and scope reject non-members with 403 and invalid or mismatched client ids with 400. Scope also rejects unknown entities and missing or malformed scope ids with 400.

`GET /internal-api/workspaces/{id}/sync/events?client_id=<uuid>` streams `text/event-stream` pokes. Each poke is `event: poke` with `data: {}`, sent once on connect and once per committing workspace transaction, coalesced to one per 250 ms with keep-alive comments every 15 seconds. Each stream ends after 30 minutes; clients reconnect. Non-members get 403 and invalid or mismatched client ids get 400.

Uploads may send `expected_versions` as multipart JSON alongside the file. Imports may send `expected_versions` with `issues` or `transfer`. Creates (`create_team`, `create_stage`, `create_label`, `create_project`, `create_milestone`, `create_sprint`, `create_issue` through `IssueInput`, `add_comment`, `log_time`, `save_view`, `create_integration`) accept an optional client-chosen `id`, so offline clients can reference records before the server confirms them. Reusing an existing id returns 409; the nil UUID returns 400.

The API includes membership and invitations, workflows, labels, issue relations, projects, milestones, sprint carryover, saved views, comments, uploads, inbox preferences, time corrections, reports, search, bulk actions, trash, activity, JSON transfer, signed webhooks, and account recovery.

## Background delivery

`blackwall serve` runs HTTP only. `blackwall worker` runs jobs only. Run both processes in production. Workers claim PostgreSQL jobs with leases and bounded attempts. Database changes and their jobs commit together. Workers use separate limits for email, webhook, database, and tracker jobs. `.env.example` documents concurrency, idle polling, shutdown drain time, and history retention. The idle poll interval is at most five seconds. Failed jobs expire after `JOBS_FAILED_RETENTION_DAYS`.

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

Set `SMTP_URL`, such as `smtps://user:password@smtp.example.com` or `smtp://smtp.example.com:587?tls=required`, and `SMTP_FROM`. Percent-encode URL credentials. Email uses a stable Message-ID derived from the job. SMTP servers do not guarantee deduplication. Invalidated invitation and password-reset grants suppress queued mail. Set `PUBLIC_URL` to the address people open Blackwall at, such as `https://blackwall.example.com`, so invitation and reset emails carry links. Without it, emails carry the raw tokens.

Without SMTP or a development spool, the server queues no email. Admins copy invitation links from the members page instead, and password reset requests answer that the server can't send email. The web server and the worker must read the same mail settings.

While mail works, people who register without an invitation verify their address through an emailed link before they can sign in. A sign-in attempt before then sends a new link, at most one every five minutes. Accounts that registered through an invitation, and accounts created before this check existed, count as verified. Without mail, nobody is asked to verify.

Set `REGISTRATION=invite` to close open sign-up. People then register through an invitation link, or by entering the workspace ID and invitation token on the registration page. Only the first account of a fresh install registers without one. The default, `REGISTRATION=open`, lets anyone register. Any other value stops the server at startup.

For local mail, set `SMTP_URL=smtp://127.0.0.1:1025` and read Mailpit at `http://127.0.0.1:8025`. Alternatively, set `DEV_MAIL_DIR=./dev-mail` to write private JSON files with mode 0600. `DEV_MAIL_DIR` and `SMTP_URL` are mutually exclusive. Keep the directory private.

Outgoing integration requests carry a minimal typed event (see [webhooks](docs/api.md#webhooks)) with `X-Blackwall-Event`, `Idempotency-Key` and `X-Blackwall-Signature: sha256=<hex HMAC-SHA256>`. Incoming source links use `POST /api/workspaces/{id}/integrations/{integration}/webhook`, signed over the exact request body:

```json
{
  "delivery_id": "a unique UUID",
  "issue_id": "the issue UUID",
  "url": "https://git.example.com/team/repo/pull/42",
  "title": "Certificate rotation"
}
```

Generic signed webhooks and source links are included. Issue tracker connections keep selected teams in step with OpenProject in both directions: background polling imports work packages and comments, and local edits and comments are sent back in the background. Synced issues stay fully editable, and each field's import and send directions are configurable. See [Issue trackers](docs/trackers.md) for setup, merge rules, and operational limits. Provider-specific OAuth and automatic repository synchronization are not included.

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

## Deploy

Every push to `main` deploys to `deploy-host`, an aarch64 Debian 13 host reachable only over Tailscale. After `check` passes, the `build` job cross-compiles the release binary and bundles it with the frontend. A self-hosted runner on the host then runs the `deploy` job. The runner only makes outbound connections to GitHub, so the host accepts no inbound traffic from the internet.

`deploy` passes the archive to `/usr/local/sbin/blackwall-deploy`, the one command the runner may run with sudo. The script unpacks the archive into `/opt/blackwall/releases/<sha>`, runs `blackwall migrate`, points `/opt/blackwall/current` at the release, and restarts `blackwall-web` and `blackwall-worker`. If `/health` or the worker is down after 30 seconds, it switches back to the previous release; migrations stay applied. It keeps the five newest releases.

PostgreSQL 17 runs natively, and the `blackwall` system user connects with peer authentication. The `svc:blackwall` Tailscale service publishes the app at `https://blackwall.example.com` inside the tailnet only. Service hosts must be tagged nodes; `deploy-host` has `tag:deploy`, and an admin approved it as the service's host. Configuration lives in `/etc/blackwall/blackwall.env`. Mail stays off until you set `SMTP_URL`, `SMTP_FROM` and `PUBLIC_URL` there.

`deploy/bootstrap.sh` sets up the host and can be rerun. Copy `deploy/` to the host and run it as root. Add `RUNNER_TOKEN` from `gh api -X POST repos/fdemb/blackwall-rust/actions/runners/registration-token --jq .token` to register the runner too. To redeploy a commit, rerun its `deploy` job in GitHub Actions. To roll back by hand, run `blackwall-deploy` with an older archive, or repoint `current` and restart both services.

## Workspace limits

Each workspace has a limit per kind of record. Trashed and archived records count. Set a variable to a positive integer or to `unlimited` to change a limit:

| Variable | Default |
| --- | --- |
| `WORKSPACE_LIMIT_ISSUES` | 50,000 |
| `WORKSPACE_LIMIT_COMMENTS` | 250,000 |
| `WORKSPACE_LIMIT_TIME_ENTRIES` | 250,000 |
| `WORKSPACE_LIMIT_TEAMS` | 500 |
| `WORKSPACE_LIMIT_PROJECTS` | 5,000 |
| `WORKSPACE_LIMIT_LABELS` | 1,000 |
| `WORKSPACE_LIMIT_MILESTONES` | 5,000 |
| `WORKSPACE_LIMIT_SPRINTS` | 2,000 |
| `WORKSPACE_LIMIT_SAVED_VIEWS` | 5,000 |
| `WORKSPACE_LIMIT_INVITATIONS` | 5,000 |
| `WORKSPACE_LIMIT_INTEGRATIONS` | 100 |

Set the same values for the server and the worker, because the worker applies them to tracker imports. On the deploy host, set them in `/etc/blackwall/blackwall.env`. Before it adds a record, the server counts the workspace's rows of that kind, so a very high limit slows writes in a very large workspace.

Activity history has no limit. Every change writes to it, so a cap would block all writes once reached. An import adds the activity in its file, and the 20 MiB request limit bounds that.

At a limit, the server refuses new records of that kind and names the limit in the error. Settings > Import & export shows each count against its limit and warns from 80%.

## Current limits

Roles are owner, admin, member, and viewer. Viewers read the workspace and manage personal views, follows, and their inbox. Teams do not have separate visibility rules. Markdown output is sanitized. English and Polish localization covers frontend labels; domain validation messages remain English.

JSON transfer remaps entity IDs and preserves work relationships, comments, time entries, trash, and planning history. Unknown comment and time authors become the importing user. Credentials, integration secrets, invitations, and inbox contents stay out of exports. Transfer omits attachment bytes, so use a database backup to preserve uploads.

Use HTTPS, set `COOKIE_SECURE=true`, configure mail, and back up PostgreSQL before deployment. [Backend design](docs/architecture.md) describes transaction boundaries and concurrency.
