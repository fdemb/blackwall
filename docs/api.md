# Public API

`/api/v1` is the public REST API and `/mcp` is a Model Context Protocol server. Both are in beta: breaking changes are possible and will be announced. The web app uses `/internal-api`, which can change without notice.

Two paths stay under `/api` because they are already embedded in content and in other systems: attachment downloads (`GET /api/workspaces/{id}/attachments/{attachment}`, session-authenticated) and signed incoming source links (`POST /api/workspaces/{id}/integrations/{integration}/webhook`).

## Tokens

Create personal access tokens under Settings → API tokens, or with `POST /internal-api/me/tokens` from a session. A token is `bw_pat_` followed by 64 hex characters. Only its SHA-256 hash is stored, and the secret is shown once.

A token acts as its user and never exceeds the user's role. It narrows that role further in two ways:

- `access`: `read` allows only reads, and `write` also allows writes.
- `workspace_ids`: an optional allowlist. A token without one reaches every workspace the user belongs to.

Tokens may expire after 1 to 366 days or never expire. A user may hold at most 50. `last_used_at` is updated at most once a minute. Revoking a token takes effect on the next request. A password reset revokes every token of the account; a password change does not.

Send `Authorization: Bearer bw_pat_...`. Session tokens are rejected on `/api/v1`, and PATs are rejected on `/internal-api`.

## Conventions

- `GET /api/v1/openapi.json` describes every endpoint and needs no token.
- Lists return `{data, next_cursor}`. Pass `next_cursor` back as `cursor`. `limit` is 1 to 200 and defaults to 50. Issue lists sorted by `updated` page by keyset, which stays stable while issues change.
- Issues are addressed by UUID or by key, such as `ENG-42` (case-insensitive): the team's key, then the issue's number in that team. Responses include both `id` and `key`. Creating a team requires a `key` of 1 to 4 uppercase letters or digits, starting with a letter and unique in the workspace.
- Single records carry `ETag: "<version>"`. Send it back as `If-Match` on `PATCH`, `DELETE` or an issue transition. A stale version fails with 412 instead of overwriting a concurrent change. Writes without `If-Match` are last-writer-wins.
- `PATCH` is a merge patch. Omitted fields stay as they are. On issues, `null` clears `assignee`, `estimate`, `deadline`, `project_id`, `milestone_id`, `sprint_id` and `parent_id`. Unknown fields are rejected.
- Writes accept `Idempotency-Key`, which is scoped to the workspace and the user. Replaying a key with the same request returns the same record. Reusing it for a different request returns 409.
- Errors are `{error}` with the usual status codes. A request outside the token's scope returns 403 and names the reason.
- Browsers may call `/api/v1` from any origin (`Access-Control-Allow-Origin: *`). Preflights need no token, and credentials are never allowed, so cookies play no part. `ETag`, `Retry-After`, `WWW-Authenticate` and the rate-limit headers are readable from scripts. Prefer keeping tokens out of browser code that other people use.
- Each token gets `API_RATE_LIMIT_PER_MINUTE` requests per minute (default 600), counted by each server process. Responses report `X-RateLimit-Limit`, `X-RateLimit-Remaining` and `X-RateLimit-Reset`. Requests beyond the limit return 429 with `Retry-After`.

## Endpoints

All of these are under `/api/v1`:

| Resource | Endpoints |
| --- | --- |
| Identity | `GET /me`, `GET /workspaces`, `GET /workspaces/{workspace}` |
| Members | `GET /workspaces/{workspace}/members` |
| Teams | `GET`, `POST /workspaces/{workspace}/teams`; `GET .../teams/{team}` |
| Stages | `GET`, `POST .../teams/{team}/stages`; `GET`, `PATCH`, `DELETE .../stages/{stage}?replacement=<stage>` |
| Labels | `GET`, `POST .../labels`; `GET`, `PATCH .../labels/{label}` |
| Projects | `GET`, `POST .../projects`; `GET`, `PATCH .../projects/{project}` |
| Issues | `GET`, `POST .../issues`; `GET`, `PATCH`, `DELETE .../issues/{issue}`; `POST .../issues/{issue}/restore`, `/archive`, `/unarchive` |
| Comments | `GET`, `POST .../issues/{issue}/comments`; `GET`, `PATCH`, `DELETE .../comments/{comment}` |
| Attachments | `GET .../attachments/{attachment}` |
| Webhooks | `GET /webhook-events`; `GET`, `POST .../webhooks`; `GET`, `PATCH`, `DELETE .../webhooks/{webhook}` |

The issue list accepts `where` (the JSON clause array described in [filters](filters.md)), `search`, `archived`, `trash` and `sort`. `DELETE` on an issue moves it to the trash.

Every write runs the same `Command` the app runs, through the same transaction. Validation, roles, OpenProject ownership, activity, notifications and webhooks therefore behave exactly as they do in the app.

## Webhooks

Webhooks are the workspace's outgoing integrations, so the app's Integrations settings and the API manage the same records. Managing them requires an owner or administrator. `POST` generates a `whsec_` signing secret unless you supply one, and returns it once. `events` lists the subscribed types from `GET /api/v1/webhook-events`; an empty list subscribes to everything.

Each delivery is a signed POST with only the essentials:

```json
{
  "id": "activity uuid",
  "type": "issue.updated",
  "workspace_id": "uuid",
  "occurred_at": "2026-10-13T09:30:00Z",
  "actor_id": "uuid",
  "entity_type": "issue",
  "entity_id": "uuid",
  "fields": ["stage", "assignee"]
}
```

`fields` appears only on issue updates. Fetch the entity through the API for its current state. Headers are `X-Blackwall-Event`, `Idempotency-Key` (the same on every retry) and `X-Blackwall-Signature: sha256=<hex HMAC-SHA256 of the raw body>`. Delivery is at least once.

Personal, private and administrative actions never leave the workspace. These include notifications, alert settings, saved views, follows, invitations and integration changes. `issues.bulk_changed` and `issues.imported` carry no entity id, so list issues by `sort=updated` to see what changed.

## MCP

`/mcp` speaks the stateless Streamable HTTP transport: each POST carries one JSON-RPC message and gets one JSON reply. It accepts protocol versions `2025-11-25`, `2025-06-18` and `2025-03-26`, and there is no server-to-client stream (`GET` returns 405). It authenticates, scopes and rate-limits exactly like `/api/v1`.

As the transport requires against DNS rebinding, `/mcp` checks `Origin`. Requests without one (desktop, CLI and server clients) and same-origin requests pass. A browser client on another origin needs that origin listed in `MCP_ALLOWED_ORIGINS`, comma-separated, for example `https://inspector.example.com`; `*` admits any origin. Every other origin gets 403 and no CORS headers.

The tools are `list_workspaces`, `get_workspace_overview`, `search_issues`, `get_issue`, `create_issue`, `update_issue` and `add_comment`. Read-only tokens see only the first four. `workspace_id` may be omitted when the token reaches exactly one workspace. Tools accept issue keys such as `ENG-42` wherever they take an issue, including `parent_id`.

Example with Claude Code:

```sh
claude mcp add --transport http blackwall https://blackwall.example.com/mcp \
  --header "Authorization: Bearer bw_pat_..."
```
