# Internal API

Integrations, scripts and AI agents use the public API at `/api/v1` and the MCP server at `/mcp`, authenticated with personal access tokens. See [public API](api.md); `GET /api/v1/openapi.json` describes it.

This page covers `/internal-api`, the web app's own API, which can change without notice. `GET /internal-api/schema.json` exposes OpenAPI generated from Rust types. Its clients use `Authorization: Bearer <session token>`. The browser uses an HttpOnly, SameSite=Strict cookie. Cookie mutations require `X-CSRF-Token`, returned at login and by `GET /internal-api/me`.

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

