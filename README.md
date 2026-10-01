# Blackwall

A Rust work-management API with a React Router frontend (React Aria Components, Tailwind), SQLite or PostgreSQL, and durable background jobs.

## Run locally

Install stable Rust and Node 20+. Build the frontend once, then run the server. If `cargo` is not on your shell path after installation, first run `source "$HOME/.cargo/env"`.

```sh
(cd web && pnpm install && pnpm run build)
cargo run
```

The server reads the build from `web/build/client`. Set `WEB_DIR` to serve it from elsewhere. For frontend work, run `cargo run` and `pnpm run dev` inside `web/`; Vite proxies `/api` to port 3000 and serves the app on port 5173. Frontend checks run through Vite+ (`vp check` for format and lint, backed by oxfmt and oxlint).

Open `http://127.0.0.1:3000`, register an account, and create a workspace. Create a team under Planning before adding issues. SQLite creates `blackwall.db` in the working directory.

For PostgreSQL, create an empty database and run:

```sh
DATABASE_URL=postgres://blackwall:password@localhost/blackwall cargo run
```

Startup applies the same portable schema to either engine. Configuration comes from environment variables; `.env.example` documents the options. The application does not automatically read `.env` files.

## API

`GET /api/schema.json` exposes OpenAPI generated from Rust request, command, and response types. Authenticated requests use `Authorization: Bearer <session token>`. The browser uses an HttpOnly, SameSite=Strict cookie. Cookie mutations require the CSRF token returned at login or in the `X-CSRF-Token` header from `GET /api/me`.

The work API uses explicit commands. Each request includes the current workspace revision:

```json
{
  "revision": 0,
  "command": {
    "type": "create_team",
    "name": "Infrastructure",
    "members": []
  }
}
```

Send that request to `POST /api/workspaces/{id}/commands`. Read `GET /api/workspaces/{id}` to obtain the revision. HTTP 409 means another change committed first; reload before retrying.

The API implements workspace membership and invitations, custom team workflows, labels, issue relations, projects, milestones, sprint carryover, saved views, comments and mentions, attachment uploads, inbox preferences, time corrections, reports, search, bulk actions, trash, activity, JSON transfer, signed webhooks, and account recovery.

## Background delivery

The worker runs every 30 seconds. It adds due-date reminders to the inbox, expires invitations and sessions, and claims persisted email and webhook jobs. Delivery retries use backoff and leases. Unconfigured email jobs remain queued with a recorded error.

Set `EMAIL_WEBHOOK_URL` to your trusted mail adapter. It receives JSON containing `to`, `subject`, and a recovery or invitation `token`; invitation mail also includes `workspace_id`. `EMAIL_WEBHOOK_TOKEN` adds bearer authentication. The adapter must build and deliver the message and deduplicate `Idempotency-Key` values. There is no bundled SMTP provider.

For local development, set `DEV_MAIL_DIR=./dev-mail`. Jobs write JSON files with mode 0600 rather than sending mail. Keep that directory private. Copy the workspace ID and token into the join form, or the reset token into the recovery form. Cancelled, expired, accepted, or superseded invitations do not deliver queued messages.

Integrations send activity events to configured public HTTPS endpoints. Outgoing requests include `Idempotency-Key` and `X-Blackwall-Signature: sha256=<hex HMAC-SHA256>`. Incoming source-control links use `POST /api/workspaces/{id}/integrations/{integration}/webhook`, signed over the exact request body with the integration secret:

```json
{
  "delivery_id": "a unique UUID",
  "issue_id": "the issue UUID",
  "url": "https://git.example.com/team/repo/pull/42",
  "title": "Certificate rotation"
}
```

Generic signed webhooks and source links are included. Provider-specific OAuth and automatic GitHub or GitLab synchronization are not included.

## Verification

```sh
./scripts/check.sh
TEST_POSTGRES_URL=postgres://user:password@localhost/blackwall_test cargo test
```

The same API workflow suite runs on in-memory SQLite and, when configured, PostgreSQL. It creates test users and workspaces in the selected database, so use a dedicated test database. Checks cover permission isolation, stale writes, revocation, atomic bulk changes, issue relations, sprint carryover, comments, time totals, uploads, CSRF, password recovery, and durable job retries. No browser verification is required.

For a real HTTP and restart check, run `cargo build && python3 scripts/smoke.py`.

## Current limits

The initial persistence strategy stores typed workspace snapshots with revision checks. Writes serialize the whole workspace, and queries scan it. Limits include 5,000 issues, a 16 MiB workspace document, 1,000 issues per issue-only import, 5,000 issues per full transfer, 500 issues per bulk request, and 5 MiB per upload. Attachments are stored separately in the database. This keeps database switching straightforward for small teams; larger workspaces need normalized issue storage and indexed queries.

JSON transfer remaps workspace entity IDs and preserves work relationships, comments, time entries, trash, and planning history. Full transfer imports require owner or admin access. Imported comments and time entries from unknown people use the importing user as author. The import summary lists these identity replacements. Attachments require a separate database backup because transfer omits file bytes. Credentials, integration secrets, invitations, and inbox contents never enter exports. Unknown source people cannot become members through an import.

Roles are owner, admin, member, and viewer. Viewers read the whole workspace and manage their personal views, follows, and inbox. Teams do not have separate visibility rules. The API accepts Markdown and sanitizes rendered HTML. English/Polish localization currently covers frontend labels; domain validation messages remain English.

For deployment, use HTTPS, set `COOKIE_SECURE=true`, configure email delivery, and back up the database. [Backend design](docs/architecture.md) records the persistence decision and its concurrency limits.
