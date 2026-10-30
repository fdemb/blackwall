# Operations

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

Outgoing integration requests carry a typed event with the changed record (see [webhooks](api.md#webhooks)), with `X-Blackwall-Event`, `Idempotency-Key`, `Blackwall-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256>` and the older `X-Blackwall-Signature: sha256=<hex HMAC-SHA256>`. Incoming source links use `POST /api/workspaces/{id}/integrations/{integration}/webhook`, signed over the exact request body:

```json
{
  "delivery_id": "a unique UUID",
  "issue_id": "the issue UUID",
  "url": "https://git.example.com/team/repo/pull/42",
  "title": "Certificate rotation"
}
```

Generic signed webhooks and source links are included. Issue tracker connections keep selected teams in step with OpenProject in both directions: background polling imports work packages and comments, and local edits and comments are sent back in the background. Synced issues stay fully editable, and each field's import and send directions are configurable. See [Issue trackers](trackers.md) for setup, merge rules, and operational limits. Provider-specific OAuth and automatic repository synchronization are not included.

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

Use HTTPS, set `COOKIE_SECURE=true`, configure mail, and back up PostgreSQL before deployment. [Backend design](architecture.md) describes transaction boundaries and concurrency.
