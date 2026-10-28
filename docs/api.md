# Public API

`/api/v1` is the public REST API and `/mcp` is a Model Context Protocol server. Both are in beta: breaking changes are possible and will be announced. The web app uses `/internal-api`, which can change without notice.

Two paths stay under `/api` because they are already embedded in content and in other systems: attachment downloads (`GET /api/workspaces/{id}/attachments/{attachment}`, session-authenticated) and signed incoming source links (`POST /api/workspaces/{id}/integrations/{integration}/webhook`).

## Tokens

Create personal access tokens under Settings → API tokens, or with `POST /internal-api/me/tokens` from a session. A token is `bw_pat_` followed by 64 hex characters. Only its SHA-256 hash is stored, and the secret is shown once.

A token acts as its user and never exceeds the user's role. It narrows that role further in two ways:

- `access`: `read` allows only reads, `comment` also allows writing, editing and deleting comments, and `write` allows every write.
- `workspace_ids`: an optional allowlist. A token without one reaches every workspace the user belongs to.

Tokens may expire after 1 to 366 days or never expire. A user may hold at most 50. `last_used_at` is updated at most once a minute. Revoking a token takes effect on the next request. A password reset revokes every token of the account; a password change does not.

Send `Authorization: Bearer bw_pat_...`. Session tokens are rejected on `/api/v1`, and PATs are rejected on `/internal-api`.

## Attribution

Writes through a token are the token user's writes: roles, notifications and `actor_id` treat them that way. Each one also records the token as `via`: `{"kind": "api" | "mcp", "token_id": "...", "name": "Claude Code"}`, with the token's name at the time of the write. Comments carry it as `via`, activity entries as `via`, issues as `created_via`, and webhook deliveries as `via`. The app shows it as "Filip via Claude Code". Name each agent's token after the agent, so its changes can be found and reverted on their own.

## Conventions

- `GET /api/v1/openapi.json` describes every endpoint and needs no token.
- Lists return `{data, next_cursor}`. Pass `next_cursor` back as `cursor`. `limit` is 1 to 200 and defaults to 50. Issue lists also return `total`, the number of matches across every page. Issue lists sorted by `updated` page by keyset, which stays stable while issues change.
- Issues are addressed by UUID or by key, such as `ENG-42` (case-insensitive): the team's key, then the issue's number in that team. Responses include both `id` and `key`. Creating a team requires a `key` of 1 to 4 uppercase letters or digits, starting with a letter and unique in the workspace.
- `PATCH` on a team changes its `name` and `key`. Issue keys under the old key keep resolving, and the team lists it in `former_keys`. A former key stays reserved for its team, so no other team can take it and answer to old links. The team itself can take it back. A former key still names the team wherever a request takes a team. `DELETE` on a team removes it with its stages, sprints and memberships. Only owners and admins can do either. Deleting a team that still holds issues, trashed and archived ones included, or that an issue tracker imports into, fails with 409. Issues that moved out of a deleted team no longer resolve under its keys, and those keys become free.
- Single records carry `ETag: "<version>"`. Send it back as `If-Match` on `PATCH`, `DELETE` or an issue transition. A stale version fails with 412 instead of overwriting a concurrent change. Writes without `If-Match` are last-writer-wins.
- Issues name the records they point at: `team` is `{id, key, name}`, `stage` is `{id, name, kind}`, `assignee`, `created_by` and `followers` are `{id, display_name, email}`, `labels` are `{id, name, color}`, `project` and `milestone` are `{id, name}`, `sprint` is `{id, number, name, state}`, and `parent` and `dependencies` are `{id, key, title}`. Comments name their `author` and `mentions` the same way. Issues synced with an issue tracker carry `tracker`: `{provider, connection_id, remote_id, project_id, parent_remote_id, status_name, url, push_error}`; comments sent to or imported from one carry `tracker`: `{provider, connection_id, remote_id, author_name}`. Tracker connections are managed in the app only.
- Issue and comment writes take the same field names, and each accepts a UUID or a name: `team` by key or name, `stage` by name in the issue's team, `assignee` and `mentions` by email, display name or `me`, `labels`, `project` and `milestone` by name, `sprint` by name or number (`12` or `#12`), and `parent` and `dependencies` by key. Names match case-insensitively. A name that matches nothing returns 400 listing the names that exist; one that matches several returns 400 asking for the id.
- A description mentions someone with the link `[@Name](mention:<user id>)`. Each member a write newly mentions gets a mention alert and becomes a follower. The id picks the person, so the label can say anything. A comment mentions the members its body links this way plus everyone in its `mentions` list, so a client that writes links needs no list. Every listed person must be a member, or the write returns 403. A link to someone outside the workspace mentions no one. Editing a comment alerts only the people the edit adds. Editing a comment without `mentions` keeps the mentions it already has. Send `mentions: []` to have the server recompute them from the new body.
- `PATCH` is a merge patch. Omitted fields stay as they are. On issues, `null` clears `assignee`, `estimate`, `deadline`, `project`, `milestone`, `sprint` and `parent`. `labels` replaces the whole set, and `[]` removes every label; `add_labels` and `remove_labels` change only the labels they name, and a label in both is removed. A patch can't send `labels` with `add_labels` or `remove_labels`. Unknown fields are rejected.
- Projects carry `lead_id` (a member's user id), `status` (`planned`, `in_progress`, `completed` or `cancelled`), `health` (`on_track`, `at_risk` or `off_track`), and `start_date` and `target_date` as `YYYY-MM-DD`. `PATCH` sets them, and `null` clears `lead_id`, `health` and either date. The target date can't come before the start date. A completed or cancelled project counts as closed. Removing a member clears them as lead.
- Writes accept `Idempotency-Key`, which is scoped to the workspace and the user. Replaying a key with the same request returns the same record, as it is now, even if other writes changed it in between. The replay succeeds even when the request would fail if sent fresh, for example because a label it names was deleted. A webhook create replays with the webhook's original secret. Two requests are the same when they have the same method, the same path and query, the same body, and the same `If-Match` where the endpoint takes one. A JSON body is compared as parsed JSON: key order and whitespace don't matter, array order does, and `null` differs from an omitted field. Any other body is compared byte for byte. Reusing a key for a different request returns 409.
- Errors are `{error}` with the usual status codes. A request outside the token's scope returns 403 and names the reason.
- Browsers may call `/api/v1` from any origin (`Access-Control-Allow-Origin: *`). Preflights need no token, and credentials are never allowed, so cookies play no part. `ETag`, `Retry-After`, `WWW-Authenticate` and the rate-limit headers are readable from scripts. Prefer keeping tokens out of browser code that other people use.
- Each token gets `API_RATE_LIMIT_PER_MINUTE` requests per minute (default 600), counted by each server process. Responses report `X-RateLimit-Limit`, `X-RateLimit-Remaining` and `X-RateLimit-Reset`. Requests beyond the limit return 429 with `Retry-After`.

## Endpoints

All of these are under `/api/v1`:

| Resource | Endpoints |
| --- | --- |
| Identity | `GET /me`, `GET /workspaces`, `GET /workspaces/{workspace}` |
| Members | `GET /workspaces/{workspace}/members` |
| Teams | `GET`, `POST /workspaces/{workspace}/teams`; `GET`, `PATCH`, `DELETE .../teams/{team}` |
| Stages | `GET`, `POST .../teams/{team}/stages`; `GET`, `PATCH`, `DELETE .../stages/{stage}?replacement=<stage>` |
| Labels | `GET`, `POST .../labels`; `GET`, `PATCH`, `DELETE .../labels/{label}` |
| Projects | `GET`, `POST .../projects`; `GET`, `PATCH`, `DELETE .../projects/{project}` |
| Milestones | `GET .../milestones`; `GET`, `DELETE .../milestones/{milestone}` |
| Sprints | `GET .../sprints`; `GET .../sprints/{sprint}` |
| Issues | `GET`, `POST .../issues`; `GET`, `PATCH`, `DELETE .../issues/{issue}`; `POST .../issues/{issue}/restore`, `/archive`, `/unarchive`; `GET .../issues/{issue}/activity` |
| Comments | `GET`, `POST .../issues/{issue}/comments`; `GET`, `PATCH`, `DELETE .../comments/{comment}` |
| Attachments | `GET .../attachments/{attachment}` |
| Webhooks | `GET /webhook-events`; `GET`, `POST .../webhooks`; `GET`, `PATCH`, `DELETE .../webhooks/{webhook}` |

The issue list accepts `where` (the JSON clause array described in [filters](filters.md)), `search`, `archived`, `trash` and `sort`. Filter values may be names wherever writes take them, and `team`, `stage`, `label`, `project`, `milestone`, `sprint` and `parent` stand for `team_id`, `stage_id`, `labels`, `project_id`, `milestone_id`, `sprint_id` and `parent_id`. A stage or sprint name matches every team's stage or sprint of that name, and a milestone name every project's milestone of that name. `DELETE` on an issue moves it to the trash. Issues stay in the trash for 30 days and are then deleted for good.

`PATCH` with `team` moves an issue to another team under that team's next number. The old key keeps resolving everywhere an issue key is accepted, and the issue lists it in `former_keys`. Numbers are never handed out again. Without `stage` the issue lands in the team's first stage of the same kind. It leaves its sprint, and its project when the project doesn't include the team. Synced issues follow their tracker project and can't move.

`GET .../issues/{issue}/activity` is the issue's history, newest first. Each entry has `actor`, `via`, `action`, the `fields` an update changed and their `changes`, shaped as in webhooks.

Every write runs the same `Command` the app runs, through the same transaction. Validation, roles, activity, notifications, webhooks and issue tracker sends therefore behave exactly as they do in the app.

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
  "fields": ["stage", "assignee"],
  "changes": [
    { "field": "stage", "from": "stage uuid", "to": "stage uuid" },
    { "field": "assignee", "from": null, "to": "user uuid" }
  ],
  "via": { "kind": "mcp", "token_id": "uuid", "name": "Claude Code" }
}
```

`fields` appears only on issue updates, and `via` only on writes made through a token.

`changes` lists the old and new value of each field in `fields`, in the same order. It is absent for events recorded before it existed and for `issues.bulk_changed`. Each entry has `field`, `from` and `to`:

- `title`, `priority`, `estimate` and `deadline` hold the values.
- `team`, `stage`, `assignee`, `project`, `milestone`, `sprint` and `parent` hold ids, and `null` means none. A renamed record keeps its id, so look up the current name. A deleted one no longer resolves.
- `labels` holds the full id lists before and after.
- `description` and `dependencies` have only `field`.

Fetch the entity through the API for its current state. Headers are `X-Blackwall-Event`, `Idempotency-Key` (the same on every retry) and `X-Blackwall-Signature: sha256=<hex HMAC-SHA256 of the raw body>`. Delivery is at least once.

Personal, private and administrative actions never leave the workspace. These include notifications, alert settings, saved views, follows, invitations and integration changes. `issues.bulk_changed` and `issues.imported` carry no entity id, so list issues by `sort=updated` to see what changed.

## MCP

`/mcp` speaks the stateless Streamable HTTP transport: each POST carries one JSON-RPC message and gets one JSON reply. It accepts protocol versions `2025-11-25`, `2025-06-18` and `2025-03-26`, and there is no server-to-client stream (`GET` returns 405). It authenticates, scopes and rate-limits exactly like `/api/v1`.

As the transport requires against DNS rebinding, `/mcp` checks `Origin`. Requests without one (desktop, CLI and server clients) and same-origin requests pass. A browser client on another origin needs that origin listed in `MCP_ALLOWED_ORIGINS`, comma-separated, for example `https://inspector.example.com`; `*` admits any origin. Every other origin gets 403 and no CORS headers.

The tools:

| Access | Tools |
| --- | --- |
| `read` | `list_workspaces`, `get_workspace_overview`, `search_issues`, `get_issue`, `list_comments`, `get_issue_history`, `list_projects`, `list_sprints` |
| `comment` | the above, plus `add_comment`, `edit_comment`, `delete_comment` |
| `write` | all of the above, plus `create_issue`, `update_issue`, `delete_issue`, `restore_issue`, `archive_issue`, `unarchive_issue` |

`tools/list` shows only the tools the token may call. `delete_issue` and `delete_comment` are annotated as destructive, so clients can ask before running them. `workspace_id` may be omitted when the token reaches exactly one workspace.

Tools take the same names as the REST API, so an agent can write `{"issue": "ENG-42", "stage": "In progress", "assignee": "me"}` without looking anything up. Responses name every record. `search_issues` returns `total`, and compact issues with the first 200 characters of each description (`include_description` returns all of it). `get_issue` returns the first 20 comments and a cursor for `list_comments`. The `where` schema lists every filter field and its value format.

Example with Claude Code:

```sh
claude mcp add --transport http blackwall https://blackwall.example.com/mcp \
  --header "Authorization: Bearer bw_pat_..."
```
