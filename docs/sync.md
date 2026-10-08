# Sync engine

Blackwall's frontend keeps a local replica of each open workspace and syncs it with the server. This document specifies that engine and the server protocol it talks to. It is the source of truth for the rewrite.

## Status

The sync layer is being reimplemented from scratch. The previous frontend data layer was deleted on purpose. Don't reconstruct it, and don't look for it in history. Its idea of "optimistic updates" was a per-command patch rolled back on failure, and it read server records through a query cache. This design replaces both.

The frontend doesn't typecheck right now. Every UI file that read data through the deleted layer has broken imports. Each of those errors marks a call site to port to the new engine.

## Fixed decisions

These were decided before the rewrite. Don't revisit them while implementing.

1. The server is the authority. Each client holds a replica plus an outbox of pending mutations, and rebases the outbox on top of every server update.
2. Concurrent edits resolve last-writer-wins per field. Sync mutations carry no version preconditions.
3. A replica lives for one login session. Logout, an expired session, or a session from a different login deletes it.
4. The UI doesn't change. Markup, styling, copy and interaction stay as they are. Code that fetches or reads data changes to call the engine.
5. No off-the-shelf sync or local-database libraries. That rules out TanStack DB, Replicache, Zero, ElectricSQL, PowerSync, RxDB, Dexie and similar. Raw IndexedDB is fine, and so is a thin promise wrapper such as `idb`. TanStack Query stays for server reads outside the replica, such as reports and OpenProject settings.
6. The app isn't deployed. Change server contracts freely, without compatibility shims.

## Vocabulary

- **Replica.** One workspace's local data for one login session. It has its own IndexedDB database.
- **Base.** Server state as of the replica's cursor. Only bootstrap, pull and scope loads write to it.
- **Outbox.** Mutations the server hasn't processed yet, in order.
- **View.** What the UI reads: base with the outbox replayed on top.
- **Mutation.** `{id, name, args, at}`. `name` and `args` are a server `Command`. `id` increases per client. `at` is the client timestamp the mutator uses as "now".
- **Mutator.** The client function that predicts a mutation's effect on the view.
- **Cursor.** An opaque string from the server. Everything committed before it is reflected in base.
- **Client.** One replica as the server sees it, identified by `client_id`.
- **Leader.** The one tab per replica that talks to the network.
- **Scope.** A subset of an entity that loads on demand, such as one issue's comments.

## Model

```
view = replay(base, outbox)
```

- Base changes only when a server read lands: bootstrap, a pull page, or a scope load. Push responses never write to base.
- A mutation leaves the outbox only when a pull reports `last_mutation_id >= mutation.id`. The pull that reports it also contains the records that mutation changed, from the same database snapshot.
- After every base change, the client replays the remaining outbox over the new base and notifies subscribers of every record whose view value changed.
- A wrong prediction is harmless. The server runs the command again on its own, and the next pull replaces the prediction. The only visible effect is a brief flicker.
- A mutation the server rejects is still processed. `last_mutation_id` passes it, it leaves the outbox, and the user sees the server's error.

## Data

### Entities

| Entity | Key | Loaded | Visible to |
|---|---|---|---|
| `workspace` | `id` | always | members |
| `members` | user id | always | members |
| `teams` | `id`, stages nested | always | members |
| `labels` | `id` | always | members |
| `projects` | `id` | always | members |
| `milestones` | `id` | always | members |
| `sprints` | `id` | always | members |
| `views` | `id` | always | owner, or everyone when shared |
| `alert_preferences` | `user_id` | always | that user |
| `notifications` | `id` | always | the recipient |
| `invitations` | `id` | always | owners and admins |
| `integrations` | `id` | always | owners and admins |
| `issues` | `id`, including trash and archive | always | members |
| `time_entries` | `id` | always | members |
| `comments` | `id` | per issue | members |
| `activity` | `id` | per entity | members |

Time entries load eagerly because reports and person pages sum them across the workspace. Comments and activity load when a screen asks for an issue's discussion or history.

### Record shapes

Records keep the shapes the REST list endpoints return, with one change: issues drop `blocked_count`, `subtask_total` and `subtask_completed`. The client derives them from the local graph with the server's definitions:

- `blocked_count` counts the issue's dependencies that aren't deleted and whose stage kind isn't `done` or `cancelled`.
- `subtask_total` counts children with the issue as `parent_id` that aren't deleted.
- `subtask_completed` counts those children whose stage kind is `done` or `cancelled`.

The server stores timestamps with offsets. Normalize every timestamp to UTC ISO strings when records enter base, so string comparison sorts them correctly.

Removing the counts also removes the reason the `record_change` trigger marks a changed issue's parent and dependents. Drop that fan-out, and `mark_issue_neighbors`, once nothing reads the counts from sync records. The REST issue endpoints may keep the counts.

### Visibility

A pull renders each changed record as the actor sees it now. `null` means deleted or no longer visible, and the client deletes it from base either way. The existing `changes.user_id` column limits private rows to their owner. `push_visibility` in `src/store/reads.rs` holds the read rules.

Some visibility changes don't produce a change row for every record they affect. When the actor gains admin, invitations and integrations become visible. When the pull window contains a change to the actor's own membership row, the server answers `reset: true` and the client bootstraps again.

## Protocol

All endpoints live under `/api/workspaces/{id}/sync/` and use the existing authentication and CSRF rules. Each request names its `client_id`. The server rejects a `client_id` that belongs to another user or workspace.

### Clients

New table `sync_clients(client_id uuid primary key, workspace_id, user_id, last_mutation_id bigint, updated_at)`. The client creates its `client_id` when it creates a replica. The server inserts the row on first use. A `client_id` registered to another user or workspace is rejected with 400.

Prune rows untouched for longer than the session lifetime, currently 30 days. A pruned client can't still have a live replica, because its session expired first.

### Cursor

The cursor is the snapshot `xmin` already used by `Store::changes` in `src/store/changes.rs`. Every transaction still in flight has a txid at or above it. A cursor `C` promises that every transaction with txid below `C` is reflected. Changes can repeat across responses, and the client applies records as current state, so repeats are harmless.

Keep the `changes` table, its triggers and `change_horizon`. They are correct and the pull endpoint reads them. Replace the `/changes` HTTP endpoint with pull.

### Bootstrap

`GET sync/bootstrap?client_id=` streams the whole always-loaded data set from one `REPEATABLE READ READ ONLY` transaction, as gzip-compressed NDJSON.

```
{"cursor":"812","last_mutation_id":0,"schema":3}
{"entity":"teams","record":{...}}
{"entity":"issues","record":{...}}
...
```

The first line comes from the same snapshot as every record. The client writes everything into a fresh base in one IndexedDB transaction with the cursor. A page reload in the middle of a bootstrap leaves no partial replica.

### Pull

`GET sync/pull?client_id=&cursor=` runs in one `REPEATABLE READ READ ONLY` transaction.

```json
{
  "cursor": "845",
  "more": false,
  "reset": false,
  "last_mutation_id": 17,
  "changes": [{ "entity": "issues", "id": "…", "record": { } }]
}
```

- `reset` is true when the cursor predates `change_horizon`, when the actor's own membership changed in the window, or when the page can't advance the cursor. A single transaction with more changed records than the page limit is the usual cause of the last case. The client bootstraps again.
- Pages hold up to 1,000 distinct `(entity, id)` pairs. Cut pages only at txid boundaries, and never return a cursor above the snapshot's `xmin`.
- `last_mutation_id` is set only when `more` is false. Intermediate pages leave the outbox alone, so the client doesn't drop a mutation before all of its effects have arrived.
- The client applies each page and its cursor in one IndexedDB transaction, then rebases.
- Comment and activity changes for scopes the client hasn't loaded are dropped.

### Push

`POST sync/push`

```json
{
  "client_id": "…",
  "mutations": [
    { "id": 18, "name": "update_issue", "args": { "id": "…", "patch": { "title": "New" } }, "at": "2026-10-08T12:00:00Z" }
  ]
}
```

- `name` plus `args` form a `Command` as `{"type": name, ...args}`. `at` must parse as RFC 3339; the server doesn't otherwise use it.
- A request holds 1 to 100 mutations. Ids are positive and strictly increasing within the batch; gaps are fine.
- The whole request fails with nothing processed when the actor isn't a member (403), the `client_id` belongs to another user or workspace (400), or the batch shape is wrong (400).

The server handles the mutations in order. For each one, it runs one transaction that:

1. Opens the operation the same way the REST command path does, and locks the `sync_clients` row (inserting it on first use).
2. Skips the mutation as `duplicate` when `id <= last_mutation_id`, because it was already processed. Ids must increase but may have gaps.
3. Runs the command through the same store code the REST command endpoint uses, without version preconditions and without an idempotency key, inside a savepoint. `add_attachment` and `attach_comment_file` are rejected; uploads go through the REST upload endpoint.
4. On a business error, rolls back the command's writes to a savepoint and records `rejected` with the `{status, message}` the REST endpoint returns for that error.
5. Sets `last_mutation_id = id` and commits, so rejected mutations still advance the id.

- Business errors are `BadRequest`, `NotFound`, `Conflict` and `Forbidden` from the command, malformed `name`/`args`, and database errors with SQLSTATE class `22` (data exception) or `23` (integrity constraint, including the ownership conflict the REST mapper turns into 409).
- A transient failure, such as a lost database connection, stops the batch and returns 503 with the results committed so far. Losing membership mid-batch stops it with 403 instead. The client retries the same batch with backoff. Because the server dedupes by id, retries are safe.

```json
{
  "last_mutation_id": 18,
  "results": [
    { "id": 18, "status": "applied" },
    { "id": 19, "status": "rejected", "error": { "status": 404, "message": "not found" } }
  ]
}
```

Per-mutation `status` is `applied`, `duplicate` or `rejected`. The 503 response uses the same shape for the mutations handled before the failure.

The client never writes push results into base. It pulls after every push.

### Poke

`GET sync/events?client_id=` is a server-sent event stream. It sends an event, with no data the client needs, whenever a transaction touching the workspace commits.

- `mark_change` calls `pg_notify('blackwall_changes', workspace_id::text)`. PostgreSQL collapses identical notifications within a transaction.
- One `PgListener` per server process fans notifications out to that workspace's open streams. `src/store/queue.rs` already uses `PgListener` for jobs.
- On an event, the leader pulls. Coalesce events that arrive while a pull is running into one follow-up pull.
- Polling remains the fallback. Pull every 30 seconds while the stream is down, and also on window focus and on the browser's `online` event.

### Scopes

`GET sync/scope?client_id=&entity=comments&issue_id=` returns the scope's records. `entity=activity` takes `entity_id`. The client records the scope as loaded in the same IndexedDB transaction as its records, and from then on applies pull changes for it.

### Serial reads

The leader runs bootstrap, pull and scope requests one at a time through one queue. Each read then sees a snapshot at least as new as the previous one, so a slower response can't overwrite newer data. This replaces any need for per-record version comparison in base.

## Server changes

1. **Client ids on creates.** Every create command takes an `id` chosen by the client: `create_team`, `create_stage`, `create_label`, `create_project`, `create_milestone`, `create_sprint`, `create_issue` through `IssueInput`, `add_comment`, `log_time`, `save_view` and `create_integration`. A collision is a business error. The client can create an issue and a sub-issue offline before the server has seen either.
2. **Optional preconditions.** `expected_versions` becomes optional on the REST command, upload and import endpoints. Absent means last-writer-wins. REST clients that send versions keep getting 409 on a stale version. Sync never sends them.
3. **Field-level writes.** An `update_issue` patch writes only the fields it names. Two clients editing different fields of the same issue both win. Bulk edits follow the same rule.
4. **Issue numbers** stay server-assigned. A locally created issue has no number until the pull that confirms it.
5. **Endpoints.** Add bootstrap, pull, push, scope and events as specified above. Remove `GET /changes`.
6. **Sessions.** Add a random, non-secret `public_id` to sessions and return it from `GET /api/me` as `session_id`. It names the replica. It must never authenticate anything.
7. **Docs.** Update the API section of `README.md` and `docs/architecture.md` as endpoints change.

## Client architecture

All engine code lives in `web/app/sync/`. The core doesn't import React. React bindings sit in their own module on top.

### Store

- One in-memory table per entity, holding immutable records. A record keeps its object identity until it changes, so React can skip unchanged rows.
- The view is base plus an overlay of records the outbox replay touched. A replay writes into a fresh overlay, reading through it to base, and then diffs against the previous overlay. Replaying a short outbox never copies a whole table.
- Indexes are maintained on write, not built per query: issues by team, stage, parent, sprint, project, milestone and assignee; reverse dependencies; comments and time entries by issue; activity by entity. Derived issue counts come from these indexes.
- Writes emit change sets per table and key. Subscribers listen per table or per record.

### Mutators

One mutator per command in the `Command` union in `web/app/lib/types.ts`, with the same name and arguments.

- Signature: `(tx, args, ctx) => void`. `tx` reads and writes the view through the overlay. `ctx` holds the actor, their role and the mutation's `at`.
- Deterministic. Read the time from `at`, never from `Date.now()`. Generate ids before the mutation is created and pass them in `args`, never inside the mutator. Replays must produce the same result.
- Idempotent in effect: set values, never toggle or increment. Running a mutation twice locally must give the same view as running it once.
- Check what the client can know: the actor's role, the ownership policy in `web/app/lib/ownership.ts` for OpenProject-imported issues, and references to records that exist. A failed check throws before the mutation enters the outbox, and the UI shows the error right away.
- Predict only what the client can compute. Server-only values such as issue numbers, notifications, activity rows and positions for `move_issue` with no `before_id` either take placeholders or are left for the server. The pull corrects them.
- Commands with server-generated secrets or bulk server work don't get mutators. See online-only operations below.

### Persistence

IndexedDB database `blackwall:{session_id}:{workspace_id}` with object stores:

- `meta`: `schema`, `client_id`, `cursor`, `last_mutation_id`, `next_mutation_id`.
- One store per entity, keyed like the table above.
- `outbox`, keyed by mutation id.
- `scopes`, the loaded comment and activity scopes.

Opening a replica loads every store into memory, replays the outbox, and renders. The leader then pulls. A replica opened from disk shows data before the network answers.

`SCHEMA` is a constant in the engine. Bump it whenever a record shape, an index or a store changes. On a mismatch, push the old outbox if online, then delete the database and bootstrap. Offline, keep the old replica read-only until the push succeeds.

### Session lifetime

- After `GET /api/me`, delete every `blackwall:*` database whose `session_id` isn't the current one.
- Logout deletes the current session's databases before calling the server. If the outbox isn't empty, the existing confirm dialog asks first, because pending edits will be lost.
- A 401 on any sync request deletes the session's databases and returns to login.
- A 403 or 404 on a workspace deletes that replica and leaves the workspace.
- Invitation tokens and integration secrets never reach IndexedDB.

### Tabs

- Each tab keeps its own in-memory store, loaded from the shared database.
- `navigator.locks.request("blackwall-sync:{replica}")` elects the leader. Only the leader holds the event stream, pulls, loads scopes and pushes. When the leader tab closes, the lock passes to another tab.
- A tab allocates mutation ids inside an IndexedDB read-write transaction on `meta.next_mutation_id`. IndexedDB serializes those transactions, so two tabs never reuse an id.
- Every write to the shared database is broadcast on a `BroadcastChannel` with the changed records or mutations. Other tabs apply the broadcast instead of re-reading the database.

### Online-only operations

Some commands aren't queued offline: `invite`, `resend_invitation`, `create_integration` because of its secret, `set_role`, `remove_member`, `import_issues`, file uploads, import, export, workspace creation, and OpenProject settings.

- They wait until the outbox is empty, then go to the server directly. Commands go through push with a freshly allocated id and are never written to the outbox store. Uploads and imports use their REST endpoints.
- Their effects arrive through the next pull.
- The UI disables them while offline.
- An upload targets an issue or comment that must already be confirmed. It waits until no outbox mutation creates its target.

### Reads outside the replica

- Reports stay a server read through TanStack Query. Refetch after a pull that touched issues or time entries, debounced. Offline, show the last result.
- `inbox_unread` and issue counts come from the replica.
- Issue search, people search and the command palette search the replica: title, description and issue number for issues.
- OpenProject connection settings stay a TanStack Query read.

### React bindings

- `useSyncExternalStore` over the store. A query hook takes a function of the view and the tables it reads, reruns when those tables change, and returns the previous result when the new one is shallowly equal.
- A record hook subscribes to one key.
- A status hook exposes pending mutation count, connection state, last error and bootstrap progress. The offline banner and save status read it.
- Mutation calls return once the mutation is in the outbox. A caller that needs the server's verdict, such as a form showing an error beside its fields, can wait for that mutation's outcome.
- UI state that isn't synced data, such as the create-issue dialog, doesn't belong in the engine.

## Porting the UI

`vp run typecheck` lists every broken call site. For each screen:

1. Read the markup to see which data it shows and which actions it runs.
2. Replace the data access with engine hooks and mutations.
3. Leave markup, styling and copy unchanged.

Shape the hooks so call sites change little, but design them from this document, not from the names in the broken imports. `routes/workspace.tsx` opens the replica in its loader, bootstrapping when there is none. The archive and trash screens read the replica instead of paging through REST.

## Tests

### Server, against PostgreSQL

- Pull returns records and `last_mutation_id` from one snapshot. A mutation committed during a pull is either fully reflected, with its id reported, or entirely absent.
- Pages cut at txid boundaries. A transaction larger than the page limit yields `reset`.
- `reset` on an expired cursor and on a change to the actor's membership.
- Push skips processed ids, accepts gaps, and advances `last_mutation_id` past rejected mutations atomically with their effects.
- Two clients editing different fields of one issue both keep their edits.
- Visibility: private views, admin-only entities, notifications, and a member losing access.
- A commit produces a poke on the workspace's event stream.

### Engine, in Node

- Each mutator against fixture state.
- **Convergence.** Two or three engines run against an in-memory fake server that implements this protocol and applies commands with the same mutators plus server-only effects such as issue numbers. Random mutations, random latency, dropped and duplicated responses, and killed and reloaded clients mid-push. Once traffic stops, every replica's view must equal the server's state. Run it with fixed seeds in CI and print the seed on failure.
- Rebase: a pull arriving during a pending mutation keeps the local edit visible until the server reports it.
- Persistence: reloading at any step resumes without losing or duplicating a mutation. Use an in-memory implementation of the persistence interface, or `fake-indexeddb`.
- Tabs: two engines sharing one database and a channel allocate distinct ids, and only one pulls.

### Contract

For every command with a mutator, run it on the real server and compare the predicted view with the pulled records, field by field, ignoring server-only fields. This catches mutators drifting from server behavior.

## Phases

Each phase ends with its tests passing.

1. **Server protocol.** Client ids, optional preconditions, field-level writes, the `sync_clients` table, bootstrap, pull, push, scope, events, and `session_id`.
2. **Engine core.** Store, overlay replay, indexes, mutators, persistence and transport, with no React. Convergence tests pass.
3. **Bindings and the workspace shell.** Open a replica, render the sidebar and issue lists, and run issue mutations.
4. **Every screen.** Port the remaining call sites until `vp check` and `vp test` pass.
5. **Tabs, sessions and offline hardening.** Leader election, broadcast, session cleanup, online-only gating, and schema migration.
