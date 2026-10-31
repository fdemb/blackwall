# Sync engine

Blackwall's frontend keeps a local replica of each open workspace and syncs it with the server. This document specifies that engine and the server protocol it talks to. It is the source of truth for the rewrite.

## Status

The sync layer is rewritten. The engine, the server protocol and the UI port are done, and the frontend typechecks. The previous frontend data layer was deleted on purpose. Don't reconstruct it, and don't look for it in history. Its idea of "optimistic updates" was a per-command patch rolled back on failure, and it read server records through a query cache. This design replaces both.

All five phases are done. Session cleanup, online-only gating, and schema recovery are wired into the engine and the UI. `web/app/lib/workspace-engine.ts` supplies browser locks and channels when both APIs exist. One leader per user/workspace replica owns sync network work, and followers receive its changes and connection status. Each tab sends its own online-only REST commands. Without either browser API, each tab runs as a lone leader.

Leaving a workspace retires its engine until the shared outbox drains, then closes it and releases leadership. Returning before close reclaims the engine. Logout and a different user's sign-in delete replicas. A session end only stops the engines. A newer IndexedDB layout stops older tabs and asks them to reload while preserving their readable view. Database deletion still ends workspace access.

Tests cover app lifecycle across tabs, shared-database engine coordination, schema upgrades and deletion, real-server prediction contracts, and convergence in both independent-replica and tab modes. No implementation work remains from these phases.

## Fixed decisions

These were decided before the rewrite. Don't revisit them while implementing.

1. The server is the authority. Each client holds a replica plus an outbox of pending mutations, and rebases the outbox on top of every server update.
2. Concurrent edits resolve last-writer-wins per field. Sync mutations carry no version preconditions.
3. A replica lives for one user on one browser. Logout, or a different user's login, deletes it. An expired session does not: the same user's next sign-in continues from the same replica.
4. The UI doesn't change. Markup, styling, copy and interaction stay as they are. Code that fetches or reads data changes to call the engine.
5. No off-the-shelf sync or local-database libraries. That rules out TanStack DB, Replicache, Zero, ElectricSQL, PowerSync, RxDB, Dexie and similar. Raw IndexedDB is fine, and so is a thin promise wrapper such as `idb`. TanStack Query stays for server reads outside the replica, such as reports and issue tracker settings.
6. The app isn't deployed. Change server contracts freely, without compatibility shims.

## Vocabulary

- **Replica.** One workspace's local data for one user on one browser. It has its own IndexedDB database.
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

The `record_change` trigger no longer marks a changed issue's parent or dependents just to refresh counts. Stage kind changes mark the team, without marking issues or their neighbors. `mark_issue_neighbors` is gone. REST issue endpoints and command responses keep the counts, but count changes alone do not add parent or dependent records to command responses.

### Visibility

A pull renders each changed record as the actor sees it now. `null` means deleted or no longer visible, and the client deletes it from base either way. The existing `changes.user_id` column limits private rows to their owner. `push_visibility` in `src/store/reads.rs` holds the read rules.

Some visibility changes don't produce a change row for every record they affect. When the actor gains admin, invitations and integrations become visible. When the pull window contains a change to the actor's own role, the server answers `reset: true` and the client bootstraps again.

## Protocol

All endpoints live under `/internal-api/workspaces/{id}/sync/` and use the existing authentication and CSRF rules. Each request names its `client_id`. The server rejects a `client_id` that belongs to another user or workspace.

Each request also names the user its replica belongs to, as the `user_id` query parameter, on push too. The server compares it with the authenticated user before it reads or writes any sync row and answers 401 `{"error": "account changed"}` when they differ. A browser replica outlives the cookie, so another account may sign in while an engine of the first one still runs, and this stops that engine from sending the first user's queued edits as the second user, or receiving the second user's data. A request authenticated by the session cookie must send `user_id` (400 without it). A bearer-token request has no replica and may omit it. A malformed `user_id` is 400. `POST /internal-api/workspaces/{id}/commands` takes the same parameter under the same rules and checks it before the command runs, so an online command from the first user's screen can't run as the second user either.

### Clients

New table `sync_clients(client_id uuid primary key, workspace_id, user_id, last_mutation_id bigint, updated_at)`. The client creates its `client_id` when it creates a replica. The server inserts the row on first use. A `client_id` registered to another user or workspace is rejected with 400.

Rows are never pruned. A replica outlives its session, so a client that comes back after any number of days still needs its `last_mutation_id`: without the row, the server would run a mutation it already processed a second time. A row is a few dozen bytes. Deleting the workspace or the user deletes the row and its rejections (`ON DELETE CASCADE`). The server's number only grows, so a client that reads a lower acknowledged id than its replica holds stops pushing and reports a protocol error. Push enforces the same rule on the server (see Push), so a request can't run before a read has noticed the loss.

### Cursor

The cursor is an epoch and a PostgreSQL snapshot in its text form, `epoch@xmin:xmax:xip`, with an optional fourth snapshot part, `epoch@xmin:xmax:xip:txid.row`. `epoch` is 32 hex digits. Clients treat the whole string as opaque. The snapshot part is what the rest of this section describes. A cursor `C` promises that every transaction visible in `C` is reflected in base: every txid below `C.xmax` except those listed in `C.xip`. A pull returns the change rows of transactions visible in its own snapshot but not in `C`, which is `txid >= C.xmax` or `txid` in `C.xip`. A long-running transaction elsewhere in the cluster only stays in the cursor's `xip` list; it never holds the cursor back.

The fourth part names one transaction in that window that the client holds only in part: every change row of `txid` with an id at or below `row` is reflected, the rest is not. It lets a transaction larger than one page span several pages. Its invariants:

- `txid` is in the snapshot's window, so the snapshot alone would deliver the transaction again. It is `txid >= xmax` or listed in `xip`, and below the pull's own `xmax`. `row` is at least 1.
- A transaction's change rows all become visible at its commit and are never added to afterwards, so `row` splits the same set of rows on every later pull.
- A cursor names at most one partial transaction. Every `more: true` page strictly grows what the cursor promises.
- Delivering a record twice is harmless, because a pull renders each record as of its own snapshot. A cursor may always promise less than what the client holds, and never more.
- A partial transaction that retention pruned is caught by the horizon check. The cursor's `xmin` is at or below `txid`, and pruning raises the horizon past the newest txid it deleted.

#### Epoch

A snapshot only means something in the database history that produced it. Two events break that, and the epoch covers both:

- A `pg_dump` restore into a new cluster restarts txids low. An old cursor's `xmax` is above the new snapshot's, and the restored `changes` rows and `change_horizon` hold txids from the old cluster.
- After an asynchronous failover the new primary can hand out txids that a client's cursor already counts as delivered, so those changes would never be sent.

`sync_history` holds one row, `(epoch uuid, cluster text)`. Every cursor carries `epoch`. A pull answers `reset: true`, never 400, for a well-formed cursor whose epoch is not the current one, and for one the database can't honor: an `xmax` above the pull snapshot's, a partial transaction at or above the snapshot's `xmax`, or an `xmin` below the horizon. A cursor without an epoch is from before epochs existed. It resets once, because nothing proves which history issued it, and the client's `SCHEMA` bump already forces a bootstrap. Cursors that no server could have issued are still 400, with or without an epoch.

The epoch is stored, but a stored value alone can't notice a restore, since the restore copies it. `cluster` is what notices. It is the value of the SQL function `sync_identity()` at the last rotation, the cluster's `system_identifier` from `pg_control_system()` and the timeline of the current WAL position, from the first eight characters of `pg_walfile_name(pg_current_wal_lsn())`:

- A `pg_dump` restore creates a new cluster, so the system identifier changes.
- A promoted standby starts a new timeline, and so does a point-in-time restore. The WAL position gives the timeline immediately. `pg_control_checkpoint()` would report the old one until the post-promotion checkpoint finishes, which leaves a window where old cursors still match.

The pull's snapshot query compares `cluster` with `sync_identity()` and reads `epoch` in the same statement. The server also compares at startup and before each retention prune. On a mismatch, `adopt_sync_history` rotates the epoch to a new random uuid, stores the current `sync_identity()`, deletes every change row and sets `change_horizon` to 0, in one transaction. The `UPDATE` serializes concurrent callers on the row, so one rotates and the rest find it done. Bootstrap answers 503 once when it finds a mismatch after rotating, and the client retries. Deleting the rows is what stops `change_horizon` from resetting every pull after a restore, and what stops stale rows with unreachable txids from poisoning windows. Rows of a failed-over history are valid, but every cursor has already been invalidated, so one uniform rule is simpler than telling the cases apart.

`sync_identity()` needs `EXECUTE` on `pg_control_system`, `pg_current_wal_lsn` and `pg_walfile_name`. PostgreSQL 17 grants all three to `PUBLIC`: they have no `proacl` in `pg_proc.dat` and no `REVOKE` in `system_functions.sql`, so a plain application role and the `postgres:17` service in CI can call them. Managed services may differ, and the migration creates the function and calls it, so a role without access fails loudly at deploy. `pg_walfile_name` raises an error during recovery, so pulls fail on a hot standby, which can't take writes anyway.

Not covered: a restore that keeps the cluster and timeline, such as a file-level snapshot of a stopped primary rolled back in place. Its txid counter goes back and the epoch stays. Cursors above the restored counter reset through the `xmax` rule. Cursors below it can miss changes. To force every client to bootstrap after such a restore, run `UPDATE sync_history SET epoch = gen_random_uuid()` and, if the restore left stale rows, `DELETE FROM changes; UPDATE change_horizon SET txid = 0`.

Keep the `changes` table, its triggers and `change_horizon`. They are correct and the pull endpoint reads them. `mark_change` inserts one row per call with no uniqueness check, so a transaction may hold several rows for one record. Pull dedupes by `(entity, id)` per page. A check on write would need a unique index, and building one on a table every write touches either blocks writes or must run concurrently at startup, which can deadlock two processes that start together. A record marked both privately and workspace-wide in one transaction, such as a view created private and then shared, keeps both rows. Change rows older than `JOBS_CHANGES_RETENTION_DAYS` (default 30, the session lifetime) are pruned.

### Bootstrap

`GET sync/bootstrap?client_id=<uuid>` streams the whole always-loaded data set from one `REPEATABLE READ READ ONLY` transaction. The response is `application/x-ndjson`, compressed with gzip when the request's `Accept-Encoding` accepts gzip, and plain otherwise.

```
{"cursor":"6f1c0b8e2d9a4c7fa3e51b2d8c04a9f7@812:812:","last_mutation_id":0,"schema":8}
{"entity":"teams","record":{...}}
{"entity":"issues","record":{...}}
...
{"end":true,"records":42}
```

The server writes each record as the JSON text PostgreSQL produced, without decoding it, so key order and spacing follow PostgreSQL's `jsonb` output. Clients parse the lines and never depend on either.

The header, client mutation id and every record come from the same snapshot. `schema` is the server constant `SYNC_SCHEMA`, currently 8; bump it whenever a sync record shape changes. Version 5 renamed the issue's `openproject` link to `tracker` and added `tracker` to comments. Version 7 added `former_keys` to teams. Version 8 cut integrations' `webhook_url` down to scheme and host. Record lines use pull's shapes and visibility rules, including trashed and archived issues. An integration's `webhook_url` is its scheme and host only, such as `https://hooks.slack.com`, and `secret` is empty. Slack and Discord put their secret in the URL path, and the replica lands in IndexedDB. Admins read the full URL from `GET /internal-api/workspaces/{id}/integrations`, which the integrations screen doesn't need, since it only displays the host. Comments and activity are excluded.

The trailer counts only record lines. A failure ends the body without a trailer. The client discards any bootstrap without a trailer, and writes a completed bootstrap into a fresh base with its cursor in one IndexedDB transaction. A page reload in the middle leaves no partial replica.

A user runs at most one bootstrap at a time, across all their replicas and workspaces. A second one is refused at once with 503, `Retry-After: 5` and a JSON error. Concurrent bootstraps are also capped at a quarter of the pool's connections, at least one. A bootstrap takes its permit before its connection and holds both until its stream ends. When no permit is free within 5 seconds the server answers 503 the same way, before streaming starts. Each send waits at most 10 seconds for the reader, so a stalled reader can hold a permit and its `REPEATABLE READ` snapshot for 10 seconds, not minutes; the whole bootstrap waits at most 5 minutes. Either deadline drops the transaction and ends the body without a trailer. The client treats a 503 like any transient failure and retries with backoff.

Request errors: a non-member receives 403. A missing or malformed `client_id`, or one registered to another user or workspace, receives 400. A `user_id` of another account is 401.

### Pull

`GET sync/pull?client_id=&cursor=` runs in one `REPEATABLE READ READ ONLY` transaction. The response is compressed with gzip when the request's `Accept-Encoding` accepts it, and plain otherwise. A response under 32 bytes is never compressed.

The transaction opens with one query that checks membership, reads the client's row, takes the snapshot and reads the epoch and whether the stored cluster still matches `sync_identity()`, so the epoch is always the one in force in that snapshot. Bootstrap opens the same way. The page then costs one query for the role check, one that renders every entity kind in the page, and the scan. `scan_window` reads batches of 2,000 rows. It runs one query per batch, first over the cursor's in-flight txids when it lists any, then over the range above `xmax`, until the page holds 20,000 rows or a batch comes back short.

```json
{
  "cursor": "845:847:845",
  "more": false,
  "reset": false,
  "last_mutation_id": 17,
  "changes": [{ "entity": "issues", "id": "…", "record": { } }]
}
```

- `reset` is true when the cursor's `xmin` predates `change_horizon`, when the cursor's epoch isn't the current one or the cursor reaches past the pull's snapshot (see Epoch), or when the window holds the actor's own role change. The client bootstraps again. A transaction that alone holds more than the page limit spans pages and never resets. A role change is marked by a `roles` change row private to that member. Role markers never appear in rendered records. Profile updates and team joins return normal `members` and `teams` changes.
- The cursor is the text form described under Cursor; clients treat it as opaque. The window is the change rows with `txid >= C.xmax` or `txid` in `C.xip`, as visible in the pull's own snapshot, minus the rows of the cursor's partial transaction that the client already holds.
- Pages hold up to 1,000 distinct `(entity, id)` pairs and accept at most 20,000 raw change rows, read in `(txid, id)` order in batches of about 2,000 rows. Repeated rows of one record count toward the row cap and once toward the pair limit. A transaction after the first that would pass either limit waits whole for the next page, and keeps whatever the request already held of it. When the first transaction on a page alone would pass either limit, the page ends inside it, after the last change row it accepted, so every page advances by at least one row and reads about 20,000 rows however large the transaction is. Its cursor names that transaction and row as the partial part. The next page skips the rows up to `row`, which are one contiguous run, and a batch that ends inside the run resumes after it instead of reading it again. If a page has to cut a new transaction while the request's partial transaction lies further on, the request's is dropped and delivered again later. A complete page returns the pull snapshot as its cursor; an early page returns a cursor that promises exactly what was delivered, with `more: true`.
- A record changed several times in one transaction has several change rows. It counts once toward the page limit and renders once per page, however many rows it has. If a cut falls between two change rows of one record, or two transactions change the same record on different pages, the record is rendered on both pages. Both renderings read the pull snapshot of their own page, so the second is current and the repeat only costs bandwidth.
- The role check reads the whole window on every page, including the rows of a partial transaction. A role marker in a transaction is found on the first page, before any of that transaction is delivered, so a partial transaction never hides one.
- `last_mutation_id` is the client's `sync_clients.last_mutation_id`, or 0 when the client has no row yet. It is set only on a final page (`more: false`, `reset: false`). It is `null` on intermediate pages, on resets, and on the cursorless response, which must not acknowledge the outbox; bootstrap returns its own value from its own snapshot. Intermediate pages leave the outbox alone, so the client doesn't drop a mutation before all of its effects have arrived. This holds when one mutation's transaction spans several pages: the page that finishes it is the first one that can be final, because a final page means the window held nothing more.
- Omit `cursor` for a starting cursor. The server returns `{cursor: snapshot, more: false, reset: false, last_mutation_id: null, changes: []}`; bootstrap is the normal source of a first cursor.
- Request errors: the actor not being a member is 403. A `client_id` registered to another user or workspace is 400, as is a missing or unparsable `client_id`. A `cursor` that is not one a server could have issued is 400. An optional prefix `epoch@` names the epoch as 32 hex digits. The snapshot part has three or four `:`-separated parts, `xmin <= xmax`, every xip entry in `[xmin, xmax)`, xip sorted and unique, `xmin` the smallest xip or equal to `xmax` when empty, at most 10,000 xip entries. A fourth part must be `txid.row` in digits, with `txid` at or above `xmax` or listed in `xip`, and `row` at least 1. A well-formed cursor from another history is a reset, not a 400.
- The client applies each page and its cursor in one IndexedDB transaction, then rebases.
- Comment and activity changes for scopes the client hasn't loaded are dropped.

### Push

`POST sync/push`

```json
{
  "client_id": "…",
  "mutations": [
    { "id": 18, "name": "update_issue", "args": { "id": "…", "patch": { "title": "New" } }, "at": "2026-10-08T12:00:00Z" }
  ],
  "acknowledged": 17
}
```

- `acknowledged` is the highest mutation id the client has seen acknowledged by a final pull or a bootstrap and persisted. It defaults to 0 and a negative value is 400.
- `name` plus `args` form a `Command` as `{"type": name, ...args}`. `at` must parse as RFC 3339; the server doesn't otherwise use it.
- A request holds 1 to 100 mutations. Ids are positive and strictly increasing within the batch; gaps are fine.
- The whole request fails with nothing processed when the actor isn't a member (403), the `client_id` belongs to another user or workspace (400), the batch shape is wrong (400), or the client's state was lost (409 `{"error": "client state lost"}`).

The server handles the mutations in order. For each one, it runs one transaction that:

1. Opens the operation the same way the REST command path does, and locks the `sync_clients` row (inserting it on first use).
2. Refuses the batch when the locked row's `last_mutation_id` is lower than the request's `acknowledged`, which includes a missing row when `acknowledged > 0`. The transaction rolls back, so a row it just inserted disappears and nothing is applied. The client already holds an acknowledgement the server no longer remembers, for example after a database restore, and running its mutations again would apply them twice. The check sits in the push transaction rather than in a client-side gate because a push can start before any read has run: a reconnect, a leadership change and an unblock all start one.
3. Skips applying the mutation when `id <= last_mutation_id`, because it was already processed. If `sync_rejections` holds its outcome, returns `rejected` with the original `{status, message}`. Otherwise returns `duplicate`, which means applied unless the rejection was pruned (see the client policy below). Ids must increase but may have gaps.
4. Runs the command through the same store code the REST command endpoint uses, without version preconditions and without an idempotency key, inside a savepoint. `add_attachment` and `attach_comment_file` are rejected; uploads go through the REST upload endpoint. So are the online-only commands listed under "Online-only operations", with 400 and "use the commands endpoint".
5. On a rejectable error, rolls back the command's writes to the savepoint, which also makes the transaction usable again, and records `rejected` with the `{status, message}` the REST endpoint returns for that error. Inserts that outcome into `sync_rejections` and deletes all but the client's 1,000 most recent rejections in the same transaction.
6. Sets `last_mutation_id = id` and commits, so rejected mutations still advance the id.

`sync_rejections(client_id uuid, mutation_id bigint, status smallint, message text)` has a primary key on `(client_id, mutation_id)`. All columns are non-null. Its foreign key to `sync_clients(client_id)` cascades deletes, so deleting a client, which happens only with its workspace or user, also removes its rejections.

The server treats `last_mutation_id` as a high-water mark, so a client must never let a later mutation reach the server before an earlier one. Only the leader pushes. It sends the outbox from its oldest entry, in id order, one request at a time, and retries a failed request with the same mutations before sending anything newer. Push carries only outbox mutations. Online-only commands use the REST command endpoint after the issuing tab sees its replica's outbox drain.

- A failure that a retry can't fix rejects the mutation. That covers business errors, which are `BadRequest`, `NotFound`, `Conflict` and `Forbidden` from the command, malformed `name`/`args`, and database errors with SQLSTATE class `22` (data exception) or `23` (integrity constraint). It also covers server defects, such as an internal error or any other database error. A defect is rejected with 500 and the generic message `internal server error`, and the server logs it at error level. Without this rule, one mutation that always fails would block every later edit of its client.
- A failure that a retry can fix stops the batch and returns 503 with the results committed so far. These are connection and I/O errors, a pool timeout or a closed pool, `ServiceUnavailable`, and SQLSTATE class `08` (connection exception), `40001` (serialization failure), `40P01` (deadlock), `55P03` (lock timeout), `57014` (statement timeout or cancellation), `57P01` to `57P03` (shutdown and startup states) and class `53` (insufficient resources). Losing membership mid-batch stops it with 403 instead. The client retries the same batch with backoff. Because the server dedupes by id, retries are safe.

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

#### Push failures on the client

The client never lets one mutation freeze the outbox or silently drop a user's edit. A mutation leaves the outbox only on a definitive answer: the server's `applied`, `duplicate` or `rejected`, or a 413 on that mutation alone.

| Failure | Next step |
|---|---|
| Fetch failure, offline, timeout | Retry the same batch with backoff, without limit. |
| 5xx, or a 503 with partial results | Retry the same batch with backoff, without limit. After 3 failures in a row the engine reports `stalled`. Results in a partial response settle their mutations, which resets the count. |
| 413 on a batch of several mutations | Halve the batch. |
| 413 on a single mutation | Read through the normal read lane to a final page (`more: false`), or until a reset's bootstrap completes, then check the acknowledgement. If the server already processed the id, settle it as `"unknown"` and drop it from the outbox. Otherwise set it aside as "too large to save". |
| 403 | Refresh CSRF and check access with a read. If access is gone, stop the engine and keep the replica (see Session lifetime). Otherwise retry once, then block. |
| 401 | Stop network work and wait for the session check (see Session lifetime). |
| 401 `account changed` | Stop the engine and keep the replica. Nothing retries. |
| 409 `client state lost` | Block pushing and report a protocol error. The edits stay in the outbox. The server holds a lower acknowledged id than this replica, so pushing would run an applied mutation again. |
| Any other 4xx, or a 2xx that isn't the expected JSON | A protocol error. Retry the same batch with backoff, and block pushing after 6 in a row (see below). |

A 5xx says nothing about the mutation: the server answers 503 only for a transient failure and records deterministic failures as `rejected` with status 500. So no number of 5xx answers or timeouts discards an edit. Retry delays grow to 30 seconds, and a `Retry-After` header lengthens them. `stalled` in the engine status turns the offline banner into "The server isn't saving your changes yet" and the save status into "Can't send". It clears on the next push that gets an answer.

Setting a mutation aside after a lone 413 builds a local rejection from it, writes that rejection and removes the outbox row in one transaction, and removes its effect from the view. It reaches the same kept-rejections list as a server rejection, with its text and status 413, and the receipt resolves with it. The request never reached a command, so no retry can change the answer. The client never pushes it again. Later mutations still push, and the server's `last_mutation_id` then passes the skipped id without ever applying it. Other tabs reload from the database when the leader sets one aside.

A `duplicate` result is applied only when the server's `last_mutation_id` is less than 1,000 ahead of that id, because the server keeps a client's 1,000 newest rejections and a pruned rejection also reads back as `duplicate`. Rejections are never pruned by age, so this is the only way one is lost. A confirmation push for an older id settles its receipt as `"unknown"`, not `"applied"`.

The client never writes push results into base. It pulls after every push.

### Poke

`GET sync/events?client_id=<uuid>` is a server-sent event stream. Each poke is `event: poke`. The server sends one poke immediately on connect, so the client pulls whatever it missed while disconnected, and one poke whenever a transaction touching the workspace commits.

A poke's data is `{"txid": 812, "epoch": "6f1c0b8e2d9a4c7fa3e51b2d8c04a9f7"}` when it stands for commits, or `{}` when it does not. `txid` is the transaction that committed, or the highest of several whose pokes coalesced. `epoch` is the epoch of the history that transaction belongs to, in the 32 hex digit form cursors start with. `{}` is a wildcard: the connect poke, the poke after a listener reconnect, a stream that lagged, any window that coalesced a wildcard with other pokes, and any window that coalesced commits from two epochs. A client that ignores the data pulls on every poke, which is always correct.

A client may skip the pull when the poke names a transaction that its cursor already covers. A txid only means something inside the history that issued it, so the poke's epoch has to equal the cursor's epoch. Because `txid` is only the highest of a coalesced window, a lower transaction in the same window may still sit in the cursor's `xip` list. So skip only when the epoch matches, the cursor's `xip` is empty and `txid < xmax`. In every other case, a poke without an epoch included, and for `{}`, pull.

The server knows the epoch without a query per poke. The `PokeHub` holds it, and only the listener task sets it. Each time the listener connects, it runs `adopt_sync_history`, reads the epoch on its own connection, where the stored cluster must equal `sync_identity()`, and publishes it before it sends `LISTEN`. The epoch is withdrawn whenever the connection drops, and while it is withdrawn, commit pokes are wildcards. A rotation elsewhere in the process, from pull, bootstrap or pruning, withdraws it before the change rows go and does not publish the new one. Pokes stay wildcards until the listener reconnects, so a slow adoption can never put back an epoch a rotation replaced. A failover or restore replaces the database under the connection, which drops it, so the new history's txids are never stamped with the old epoch. Each notification is stamped when the listener relays it, under the lock a withdrawal takes.

- `mark_change` calls `pg_notify('blackwall_changes', workspace_id::text || ':' || txid::text)` when called with a non-null workspace and id, where `txid` is the transaction's id, the same value the transaction's `changes.txid` rows carry. PostgreSQL collapses identical notifications within a transaction, so one transaction sends one notification per workspace, and drops them on rollback.
- One `PgListener` per server process listens on `blackwall_changes` and fans notifications out to that workspace's open streams. Each workspace has its own broadcast channel, created when its first stream connects and removed when its last stream leaves, so a burst or a slow reader in one workspace never pokes another workspace's streams. `src/store/queue.rs` already uses `PgListener` for jobs. A channel carries pokes with their txid and epoch, and a stream whose channel lagged treats the gap as a wildcard. The payload is `workspace_id:txid`; a bare workspace id, which an older `mark_change` sends, pokes that workspace as a wildcard. The listener task owns its reconnect loop: it opens a dedicated connection outside the request pool so it never takes a pool slot, checks the database's history and publishes the epoch, sends `LISTEN blackwall_changes`, then pokes every workspace's channel, because notifications may have been lost. A nil or unparsable payload does the same. It does this after every successful `LISTEN`, including the first. It then receives notifications and pokes the named workspace; on any error or disconnect it logs, drops the listener, waits with capped exponential backoff starting at the configured reconnect delay and capped around 30 s, and starts the loop again.
- Pokes coalesce to at most one per 250 ms per stream, with a trailing poke when notifications arrive inside the window. The trailing poke carries the highest txid of the window and its epoch, or neither when any poke in it had none or the window held two epochs. When the reader still holds an unread poke, the next one merges into the pending trailing poke instead of being dropped, so no txid is lost. Keep-alive comments go every 15 seconds. Each stream ends after 30 minutes; clients reconnect, which re-runs authentication and the membership check. A poke pending when the stream ends is dropped; the client's reconnect gets an initial poke, which covers it.
- On an event, the leader pulls. Coalesce events that arrive while a pull is running into one follow-up pull.
- Polling remains the fallback. Pull every 30 seconds while the stream is down, and also on window focus and on the browser's `online` event.

### Scopes

`GET sync/scope?client_id=<uuid>&entity=comments&issue_id=<uuid>` returns all comments for one issue. `entity=activity&entity_id=<uuid>` returns all activity for one entity. Each request runs in one `REPEATABLE READ READ ONLY` transaction with pull's record shapes and visibility rules. There is no pagination.

```json
{"records": [{"id": "…", "issue_id": "…", "body": "…"}]}
```

The response is compressed under the same `Accept-Encoding` rule as pull.

Request errors: a non-member receives 403. A missing or malformed `client_id`, or one registered to another user or workspace, receives 400. An unknown or missing `entity`, or a missing or malformed scope id, also receives 400. An empty scope returns `{"records": []}`.

The client records the scope as loaded in the same IndexedDB transaction as its records, and from then on applies pull changes for it.

### Serial reads

The leader runs bootstrap, pull and scope requests one at a time through one queue. Each read then sees a snapshot at least as new as the previous one, so a slower response can't overwrite newer data. This replaces any need for per-record version comparison in base.

## Server changes

1. **Client ids on creates.** Every create command takes an `id` chosen by the client: `create_team`, `create_stage`, `create_label`, `create_project`, `create_milestone`, `create_sprint`, `create_issue` through `IssueInput`, `add_comment`, `log_time`, `save_view` and `create_integration`. `create_team` also takes `default_stage_ids`, chosen by the client for its default stages in server order. A collision is a business error. The client can create an issue and a sub-issue offline before the server has seen either.
2. **Optional preconditions.** `expected_versions` becomes optional on the REST command, upload and import endpoints. Absent means last-writer-wins. REST clients that send versions keep getting 409 on a stale version. Sync never sends them.
3. **Field-level writes.** An `update_issue` patch writes only the fields it names. Two clients editing different fields of the same issue both win. Bulk edits follow the same rule.
4. **Issue numbers** count up per team. The server gives a new issue its team's highest number plus one, locking the team row so concurrent creates serialize. Numbers of issues purged from the trash count too, so a purged key is never reused. The client predicts the same rule from its replica, which holds every issue including trash and archive, so a locally created issue has a key such as `ENG-42` right away. When another client took that number first, or the number belonged to a purged issue, the pull brings the server's number and the replay renumbers the remaining pending issues. A predicted key is only shown, never put in a URL: links name an unconfirmed issue by its id, and keys in URLs resolve only among confirmed numbers. Once the server confirms an issue, its page replaces the id URL with the key.
5. **Endpoints.** Add bootstrap, pull, push, scope and events as specified above. Remove `GET /changes`.
6. **Sessions.** Add a random, non-secret `public_id` to sessions and return it from `GET /internal-api/me` as `session_id`. It must never authenticate anything. The client uses it only to recognise replicas created before replicas were named by user.
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
- A pending mutation may carry `local`: data captured at admission, stored with the mutation and never sent. Replay uses it where re-deriving would change the command's meaning, such as the notifications "mark all read" applied to.
- Idempotent in effect: set values, never toggle or increment. Running a mutation twice locally must give the same view as running it once.
- Check what the client can know: the actor's role and references to records that exist. Issues synced with an issue tracker are edited like any other. A failed check throws before the mutation enters the outbox, and the UI shows the error right away.
- Predict only what the client can compute. Server-only values such as sprint numbers, notifications, activity rows and positions for `move_issue` with no `before_id` either take placeholders or are left for the server. The pull corrects them.
- Commands with server-generated secrets or bulk server work don't get mutators. See online-only operations below.

> A mutator runs in one of two modes. **Admit** runs once when the user issues the command, against the current view; a failure there rejects the edit before it reaches the outbox and is shown to the user. **Replay** runs on every rebase; a command whose effect is already in place, because the server applied it before acknowledging it, is a no-op there. Replay errors are diagnostics and are never shown to the user; the user learns about a server rejection from the push result. Before either mode, the engine normalizes command arguments the way the server deserializes them: an absent field gets the server's default, and `null` is dropped except where the server gives it a meaning of its own, such as a team's `archive_after_days`.

#### Protocol errors on the client

A protocol error is an answer the client can't act on: a 4xx it doesn't know, a 200 that isn't the expected JSON (a proxy or captive-portal page), or a record it can't parse. A page that was only briefly wrong shouldn't need a click, so the client retries with the usual backoff, capped at 30 seconds, and blocks that request kind after 6 failures in a row. Any success resets the count. A blocked kind shows in the existing sync banner, and the user's retry clears it. A 401 is not a protocol error. It stops network work for the session check (see Session lifetime). Three cases skip the retries:

- A pull that still fails after 6 attempts is re-bootstrapped once, since a cursor the client holds may be the problem. If the pulls after that still fail 6 times, it blocks.
- A push 403 that survived a CSRF refresh blocks at once.
- A push 409 `client state lost` blocks at once. The server holds a lower acknowledged id than this replica, and a retry gets the same refusal.

One record the client can't parse is skipped instead of failing its page. The rest of the bootstrap, pull page or scope loads. The client logs the entity and id with `console.error` and lists them in `status.skipped`. A skipped pull change leaves the earlier version of that record in place, and the cursor moves past it, so the skipped version is never offered again. The engine therefore keeps a resync obligation in the replica meta, with the skipped list, and fetches the record again with a bootstrap:

- A page with a skipped record applies its valid records, its cursor and its acknowledgement, like any other page. If the skipped record is one the user just edited, the acknowledged edit leaves the outbox and the record shows its previous version until the scheduled bootstrap replaces it, about 30 seconds later. That happens only when the server sends a malformed record, and if the record stays malformed the bootstrap drops it anyway.
- The leader bootstraps after about 30 seconds, then waits twice as long after each failed attempt, up to 30 minutes. A failed attempt goes back on this schedule and doesn't enter the short retry loop. The obligation and the skipped list survive a reload, so a new leader pays it. The delay starts again on a reload, when the browser comes back online, and on a retry from the user, which also runs it at once.
- A bootstrap acknowledges as usual and clears the obligation, even if it skipped the record again, since the server's record is then malformed. The list stays in the meta and in `status.skipped` for diagnosis. A bootstrap that skips nothing clears the list.
- A scope that loaded with a skipped record is loaded again on the same schedule, in memory only.

A later pull that brings a valid version, or a deletion, also ends that record's report. Records that point at a skipped record, such as issues of a skipped team, still load and read the missing target as absent. The workspace row can't be skipped, because nothing renders without it.

#### Clocks

Retry times use a monotonic clock, never the wall clock, so a clock change on the device can't stall or hurry a push. The wall clock stays on `at` of each mutation. An HTTP-date `Retry-After` is converted to a duration once, against the wall clock, and capped at 5 minutes.

A mutation acknowledged by a pull without a known push result is pushed once more to learn its outcome; the server answers from its record without applying it again. The engine retains the payload in memory while its caller waits, and sends confirmations in id order through the normal push lane, after any batch already in flight. The caller's `settled` promise resolves only after a push result arrives. Closing the engine rejects waiting callers. A reloaded engine has no waiting callers for earlier mutations and does not recover their outcomes.

### Persistence

IndexedDB database `blackwall:{user_id}:{workspace_id}` with object stores:

- `meta`: `schema`, `user_id`, `client_id`, `cursor`, `last_mutation_id`, `next_mutation_id`, `access_lost` once the server denied access, and `skipped` and `resync` while records are skipped (see protocol errors).
- One store per entity, keyed like the table above.
- `outbox`, keyed by mutation id.
- `scopes`, the loaded comment and activity scopes.

Opening a replica loads every store into memory, replays the outbox, and renders. The leader then pulls. A replica opened from disk shows data before the network answers.

`SCHEMA` is a constant in the engine. Bump it whenever a record shape, an index or a store changes. On a mismatch, keep the outbox and the meta ids (client id, acknowledged and next mutation ids), drop everything else, and bootstrap again. An IndexedDB layout upgrade preserves the same data and resets base in the newer tab. Commands are the server's contract and don't depend on the client's layout, so the newer engine pushes the surviving outbox as usual.

The upgrade closes older tabs' database connections with `versionchange.newVersion` set to the newer version. Those engines emit `outdated`, stop network work, release leadership, and reject edits with a reload message. Their in-memory view stays readable, and the existing toast asks the user to reload. Deleting the database sets `newVersion` to null and still emits `accessLost`.

A bootstrap also drops loaded comment and activity scopes; the engine reloads the ones on screen.

When the engine opens a replica that was never bootstrapped, it asks the browser for persistent storage with `navigator.storage.persist()`, without waiting for the answer.

#### A full disk

A write that fails with `QuotaExceededError`, on a request or as a transaction abort, leaves the database as it was and surfaces as a distinct error. The client doesn't download the workspace again for it. It keeps what it downloaded in memory and keeps pulling, and the sync banner says the device is out of space. While the database is behind memory, incremental writes (pull pages and scope loads) are skipped, because applying them would leave the database ahead of what it holds. A new edit is refused with a message that says why, because the outbox lives in the database and an edit that can't be stored can't be sent after a reload. Edits already stored still push. The leader writes a full snapshot of memory every 5 minutes, after an edit shows space is back, on the user's retry, and on focus at most once a minute. The first snapshot that fits clears the state.

Other tabs only see what the database holds. While it is behind memory the leader sends them no pull pages or scope loads, so they may be behind and show the same banner. The snapshot carries the cursor, records, scopes and any resync obligation, and once it is written the leader sends `reset`, so they reload from the recovered database. A tab opened while the disk is full shows what was persisted. When the leader closes, the next one treats the database as authoritative and pulls from its persisted cursor.

An unloaded comment or activity scope reports offline, not loading, while the browser is offline, and the UI says it loads when the connection returns.

### Session lifetime

- A replica belongs to one user on one browser. Its name carries the user's id from `GET /internal-api/me`, so the same user's next session opens the same replica with the same `client_id`, outbox and mutation ids. Nothing is copied between replicas.
- After `GET /internal-api/me`, delete every `blackwall:*` database that another user's id names, whatever it holds. Privacy wins over keeping their edits. The user's own replicas stay.
- Every step that deletes replicas or publishes the session (accepting a session, a 401 cleanup and logout) runs inside one exclusive lock, `blackwall-session`, taken through the same `navigator.locks` adapter the engine uses. Without Web Locks, transitions in a tab queue behind each other and other tabs can't be reached. Accepting a session asks the server who the cookie belongs to inside the lock and acts only on that answer. It never uses a `/me` reply fetched earlier, because another tab may have signed in, or logged out, while that reply was in flight. A 401 forgets the session and deletes nothing. Any other failure changes nothing. Logout asks the server to end the session inside its own transition, so a later acceptance reads a cookie that is already gone. Every request made inside the lock (`/me` and the logout request) gives up after 15 seconds, body included, so a stalled server can't hold every tab. A timed-out `/me` counts as the server being unavailable and changes no session or replica state. `api()` checks the request's signal before it stores anything from a response, so a late answer from a fetch that ignored the abort can't replace a newer CSRF token. The engine's transport does the same, and the engine's own CSRF refresh (`/me` after a 403) runs under the engine's network signal, which closing the engine or a 401 aborts. A refresh that answers after the engine closed and a newer sign-in stored its token leaves that token in place. A timed-out logout has already deleted the replicas and still leaves for sign-in. An engine's 401 asks `/me` again inside the lock before it ends anything: when the cookie belongs to another session, which another tab may have accepted, only this tab's engines close and the remembered session stays. A sign-in forgets the remembered session when it names another user, in the tab's memory and in storage, so a failing `/me` right after it can't fall back to the previous user. A stored session of the new user, which another tab may have written, stays.
- A 401 on a sync request doesn't end anything by itself, because a proxy can answer 401 too. The engine stops its network work and tells the other tabs to stop theirs. Every engine keeps its replica open and its view on screen, takes edits into the outbox, and emits `unauthorized`. It also aborts its online commands' requests in flight and holds every online command, new or aborted, until the check answers. A valid session resends them with the same keys. An ended session, or a cookie of another session, closes the engine and fails them with a 401. Once the engine reports itself blocked after repeated 401s, an online command fails with a 401 at once. Each tab then runs the 401 check above. When the session ended, the tab closes its engines and returns to login. When the cookie belongs to another session, only that tab's engines close. When the session is still this tab's, the engine resumes network work after a backoff and the outbox drains. After 3 such 401s in a row with no pull or push answered in between, the engine stops retrying and reports itself blocked until the user retries. Every replica stays on disk, base and outbox included. When the same user signs in again, the engine opens the same replica and its push lane sends the outbox with the old ids. The server answers anything it already processed with `duplicate` or `rejected`, so nothing applies twice.
- A 403 on a read, or a JSON `{"error"}` 404 on a workspace request, means access to the workspace is gone. The engine stops, closes its handle and leaves the workspace in the UI as it is. The replica stays as it is, outbox included, and nothing is converted or cleared, except that the meta records `access_lost`. If access returns, the outbox pushes as usual and the server's answers decide each edit. If it never returns, the data stays until logout or another user's sign-in. Any other 404, such as a proxy's, is a protocol error and deletes nothing.
- A replica with `access_lost` set doesn't show its cached base as ready when it is opened again: the phase stays `loading` until a pull, bootstrap or scope read succeeds, and that success clears the marker. Another 403 ends the engine the same way as before.
- Every sync request and online command names the replica's user, so a cookie that changed accounts since the replica opened gets 401 `account changed`. That engine ends for good, closing its handle and clearing its view, so a still-running engine of the previous user neither pushes its edits as the new user nor receives the new user's data. The new user's sign-in then deletes the previous user's replicas.
- Logout deletes every replica on the browser before calling the server. If any replica holds an outbox, unconfirmed mutations or kept rejections, the existing confirm dialog asks first, because they will be lost.
- Automatic cleanup never deletes a replica it can't read, for instance one a newer version of the app wrote. It logs the failure to the console and leaves the replica. Only another user's sign-in or an explicit logout deletes it. A delete that fails is logged too.
- Before replicas were named by user, a name carried the session id and the meta had no user. The engine never opens such a replica. A sign-in deletes one that is readable and holds no outbox, unconfirmed mutations or kept rejections. One that holds any of them stays on disk untouched, its edits unsent, and the sign-in logs a warning. Logout (which asks first, counting it) and the sign-in of a different user than the browser's last one delete it. The browser remembers that last user across an expired session, until logout. An unreadable replica of unknown ownership goes only with a different user's sign-in.
- Invitation tokens and integration secrets never reach IndexedDB.

### Tabs

- Each tab keeps its own in-memory store, loaded from the shared database.
- The app injects an adapter for `navigator.locks.request` and a `BroadcastChannel` factory when both browser APIs exist. If either is unavailable, each tab runs as a lone leader.
- `navigator.locks.request("blackwall-sync:{user_id}:{workspace_id}")` elects the leader. Only the leader holds the event stream, pulls, loads scopes and pushes. When the leader stops or closes, the lock passes to another tab.
- Unmounting a workspace retires its engine. It keeps syncing until the shared outbox drains, then closes. Returning before close reclaims it. A retired follower does not hold the leader's lock.
- Followers mirror the leader's connection status. They report offline when their browser is offline or the leader reports offline. A leader reconnecting its event stream is still online. The existing offline banner and online-only controls read that status.
- A tab allocates mutation ids inside an IndexedDB read-write transaction on `meta.next_mutation_id`. IndexedDB serializes those transactions, so two tabs never reuse an id.
- Every write to the shared database is broadcast on a `BroadcastChannel` with the changed records or mutations. Other tabs apply the broadcast instead of re-reading the database.

### Online-only operations

Some commands aren't queued offline: `invite`, `resend_invitation`, `create_integration` because of its secret, `update_workspace` because slugs are unique across the server, `set_role`, `remove_member`, `transfer_ownership`, `delete_team` because the replica can't see issue tracker mappings into the team, `import_issues`, file uploads, import, export, workspace creation, and issue tracker settings.

- `invite`, `resend_invitation`, `create_integration`, `update_workspace`, `set_role`, `remove_member`, `transfer_ownership`, `delete_team`, and `import_issues` use `POST /internal-api/workspaces/{id}/commands` with a per-call `idempotency_key`. Each request names the replica's user as `user_id`, and the server refuses another account's with 401 `account changed` before the command runs. The tab that issued the command sends it after its replica's outbox drains, and never while its engine waits for the session check after a 401 (see Session lifetime). If a protocol error keeps the outbox from draining, the command fails and asks for a reload instead of waiting. Transient failures retry the same key and command body with backoff. These commands never allocate mutation ids or enter the outbox. Push carries only outbox mutations.
- Their effects arrive through the next pull. The REST command pokes the leader's event stream even when a follower sends it.
- Uploads, export, workspace creation, and issue tracker settings use their own REST endpoints.
- The UI disables them while offline.
- An upload targets an issue or comment that must already be confirmed. It waits until no outbox mutation creates its target.

### Reads outside the replica

- Reports stay a server read through TanStack Query. Refetch after a pull that touched issues or time entries, debounced. Offline, show the last result.
- `inbox_unread` and issue counts come from the replica.
- Issue search, people search and the command palette search the replica: title, description, issue number and key for issues. Local search splits text into runs of letters, marks and digits, so it can differ from the server's full-text search on punctuation-heavy text such as URLs and file paths.
- Issue tracker connection settings stay a TanStack Query read. The wizard waits until stages it created through the outbox are confirmed before saving mappings that name them.

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
- Pages cut at txid boundaries, and inside a transaction once it passes the pair or row limit. A transaction larger than the page limit, including one of many repeats of one record, spans pages with no reset, a partial cursor and `last_mutation_id` null until the final page, and the pages together hold exactly the records it changed. Partial cursors are validated, resume correctly when the transaction is listed in `xip`, and reset once retention prunes the transaction.
- A record changed many times in one transaction is rendered once per page, and the pages together deliver exactly the distinct changed records. `mark_change` keeps a private and a workspace-wide mark of one record.
- A flood or lag in one workspace doesn't poke another workspace's stream.
- `reset` on an expired cursor and on a change to the actor's membership.
- A cursor from another epoch, one without an epoch, and one past the pull's snapshot reset. Malformed cursors are still 400. A changed `sync_history.cluster` rotates the epoch, deletes the change rows, resets the old cursor once, and leaves new cursors working.
- A second concurrent bootstrap from one user is 503 with `Retry-After` while the first streams, and another user is unaffected.
- Bootstrap and pull records carry no webhook secret.
- Push skips processed ids, accepts gaps, and advances `last_mutation_id` past rejected mutations atomically with their effects.
- Two clients editing different fields of one issue both keep their edits.
- Visibility: private views, admin-only entities, notifications, and a member losing access.
- A commit produces a poke on the workspace's event stream. The poke carries the committing txid and the current epoch, coalesced pokes carry the highest txid, and a wildcard or a second epoch in a window makes the whole poke a wildcard. The poke after a listener reconnect carries neither. After a history change the next txid poke carries the new epoch or is a wildcard, never the old epoch.
- Pull and scope responses are gzip-encoded when the request accepts gzip and plain otherwise. The event stream stays uncompressed and delivers a poke promptly.
- Bootstrap lines keep their shape and content, with every entity covered, and match what pull renders for the same records.

### Engine, in Node

- Each mutator against fixture state.
- **Convergence.** Two or three engines run against an in-memory fake server that implements this protocol and applies commands with the same mutators plus server-only effects such as notifications and activity. Random mutations, random latency, dropped and duplicated responses, and killed and reloaded clients mid-push. Once traffic stops, every replica's view must equal the server's state. Run it with fixed seeds in CI and print the seed on failure.
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
