# Sync engine core

Replica: base (server state) plus an overlay of replayed outbox mutations. The store and mutators run in memory; persistence stores raw server records and pending mutations. The core has no React or network dependencies.

## Files

- `records.ts`: entities, sync record shapes, keys, timestamp normalization, pull changes.
- `store.ts`: `SyncStore` (base, overlay replay, incremental indexes, subscriptions).
- `derived.ts`: issue counts over the store view, using the server's definitions.
- `fixtures.ts`: test factories and a hand-written replay. Tests only.
- `mutators/index.ts`: command registry, admission, replay, and online-only command names.
- `mutators/`: argument normalization, validation, and command implementations grouped by domain.
- `persistence/types.ts`: replica metadata, loaded scopes, and the `Replica` and `ReplicaStorage` contracts.
- `persistence/shared.ts`: replica names, initial metadata, record keys, and scope filtering.
- `persistence/memory.ts`: `MemoryReplicaStorage`, retaining replicas across opens for tests and the fake server.
- `persistence/idb.ts`: `IndexedDBReplicaStorage`, using raw IndexedDB with one `blackwall:{sessionId}:{workspaceId}` database per replica.
- `persistence/persistence.test.ts`: shared contracts for both backends and IndexedDB lifecycle checks.
- `testing/fake-server.ts`: fetch-compatible protocol server, workspace state, authentication, control API, transaction log, and one-shot faults.
- `testing/tables.ts`: workspace tables and a scanning `Tx`, forked for each command and committed only on success.
- `testing/effects.ts`: `applyServerOnlyEffects`, correcting client predictions with server ids, numbers, versions, timestamps, positions, notifications, and activity.
- `testing/commands.ts`: HTTP command argument and UUID validation before mutator admission.
- `testing/clock.ts`: explicit clock and timers for delays, sessions, and event streams.
- `testing/events.ts`: SSE initial and trailing pokes, coalescing, keepalives, cancellation, and lifetime.
- `testing/fake-server.test.ts`: protocol contracts based on the Rust sync integration tests.

## Later tasks

- 2e transport and orchestration: pull/push/scope calls through `applyBase`/`batch`/`setPending`.
- 2f convergence tests: random traffic across engines must equal server state.
- React bindings: `useSyncExternalStore` over `subscribe`/`version`/`get`, status over `pendingVersion`.

## Invariants

- Persistence writes are atomic per method. Bootstrap stores replacement tables and metadata, clears all loaded scope markers and the `comments` and `activity` stores, and acknowledges the outbox in one transaction. The engine reloads the scopes on screen. Pull stores records, cursor, and any outbox acknowledgement together, checking loaded scopes in the same transaction. Both pull and bootstrap keep `lastMutationId` at the maximum of its stored and received values and drop outbox entries up to that maximum. A pull with a null acknowledgement leaves the outbox alone. Scope reads replace that scope's records and store its loaded marker together.
- Mutation admission stores the mutation, including `local`, and increments `nextMutationId` together. `allocateMutationIdIfOutboxEmpty()` checks the outbox and allocates an online-only id in one transaction over `meta` and `outbox`. It returns `null` without consuming an id if any mutation is pending. The leader retries after draining the outbox and sends commands in id order. Memory builds a cloned state and swaps it only on success. IndexedDB resolves writes only after transaction completion. Persistence keeps timestamps and other wire fields unchanged. The store normalizes them on load.
- IndexedDB's `IDB_VERSION` tracks the store layout separately from `meta.schema`. A layout upgrade preserves the `meta` and `outbox` stores and their contents, recreates entity stores and `scopes`, and resets `cursor` to null in the upgrade transaction. Changes to the meta or outbox format require an explicit migration. On a client schema mismatch, the orchestrator calls `resetBase()` to clear all entity stores and scopes and reset the cursor in one transaction. Both resets adopt the schema supplied at open, set `serverSchema` to zero, and keep `clientId`, `lastMutationId`, `nextMutationId`, and the outbox. The engine bootstraps again, then pushes the surviving commands as usual.
- Fresh replicas have `serverSchema: 0` until bootstrap. The storage constructor accepts an IndexedDB factory, a layout version, and `onClose({sessionId, workspaceId, reason})` for external closure. Upgrades and deletion close connections with `reason: "versionchange"`. Unexpected termination uses `"terminated"`. Blocked opens and deletes reject. A blocked open aborts its eventual upgrade. IndexedDB cannot cancel a blocked deletion, which proceeds when the blocker closes. Explicit `close()` does not call `onClose`.
- Base is written only by `replaceBase` and `applyBase`. Push results never touch base. `replaceBase(records, entities)` fully replaces each listed entity; unlisted entities are untouched. Persistence receives `BOOTSTRAP_ENTITIES`, the always-loaded entities in the server snapshot. For `SyncStore.replaceBase`, the orchestrator passes `BOOTSTRAP_REPLACED_ENTITIES`, which adds `comments` and `activity`, with both scoped tables omitted or empty in the records. This clears stale scoped rows in memory as well as on disk.
- Deep immutability: every record entering the store is normalized, deep-cloned and deep-frozen, and `setPending` deep-clones and freezes each mutation including `args`. Reads return frozen `DeepReadonly` objects; mutators build new objects. `pending()` and the replay mutation are `DeepReadonly`; `withCounts` returns a `CountedIssue` whose `number` stays `number | null`.
- The overlay is rebuilt from scratch on every rebase; the view is base with the overlay on top. Each mutation replays with a per-mutation journal, so a throw restores that mutation's touches and records a frozen `ReplayError` (`{name, message, status?, code?}`) without leaking partial writes. Error changes compare structurally per mutation id.
- Identity preservation: candidates diff by structural `deepEqual`, and an unchanged value keeps the old view object wherever it lives (overlay or base), so an equal server record under pending work emits nothing and keeps versions stable.
- Lazy snapshots: `all` and `byIndex` return cached arrays that rebase invalidates but never rebuilds; the next read rebuilds. Base indexes serve `Tx.byIndex` from the bucket plus an overlay scan, never a base-table scan. Every whole-table iteration goes through `scanBase`, which counts visited rows in `debug.baseScans`.
- Iterative re-entrancy: writes during a rebase or notification set a flag instead of recursing; the store loops until quiet, capped at 100 passes per outermost call, after which it throws `sync store: rebase feedback loop`. `batch` nests and still rebases when its callback throws.
- Notifications: one `StoreEvent` per rebase with view `entities`/`keys` plus `pendingChanged`/`errorsChanged`. No event when nothing observable changed. `version(entity)` tracks view changes; `pendingVersion()` tracks pending/error changes.

## Fake server

`createFakeServer(options)` exposes a bound `fetch(input, init)` for `/api/me` and the workspace sync routes. It accepts relative paths, absolute URLs, and `Request` objects. Requests authenticate with `Authorization: Bearer <token>`. Reads check existing client ownership without registering a client, matching Rust's read-only transactions. The first processed push mutation registers the client.

The control API returns detached records:

- `addUser(profile?)` and `addWorkspace(workspace?)` return records, assigning omitted ids.
- `addMember(workspaceId, user, role)` adds a user by profile or user id. Its default role is `member`.
- `login(user)` returns a token with a fresh public `session_id`. `logout(token)` revokes it. Sessions expire after 30 days unless `sessionLifetimeMs` overrides that duration.
- `setRole(workspaceId, userId, role)` and `removeMember(workspaceId, userId)` commit external membership changes. These fixture controls bypass actor permissions. Commands through `run` and push enforce admin permissions and retain an owner.
- `run(actor, command, workspaceId?)` executes a command outside any client and returns `{result: {id}, changes}`. The actor is a profile or user id. Push uses the same command path in admit mode, with server time.
- `seed(entity, records, workspaceId?)` commits fixture rows in one transaction, including notifications, invitations, and integrations that tests need to supply directly.
- `records(entity, actorId?, workspaceId?)` and `record(entity, id, actorId?, workspaceId?)` render authoritative state for the actor. Omitted actors use the workspace's first owner. Invisible or missing individual records return `null`. Omitted workspace ids require exactly one workspace.
- `clientState(clientId)` returns `{last_mutation_id}`, defaulting to zero. `pruneClients()` removes clients idle for more than 30 days.
- `now()` returns the server timestamp. `advance(milliseconds)` runs due timers in order. `close()` ends all event streams.

`options` accepts `at`, `pageSize`, `horizon`, `sessionLifetimeMs`, and `events: {coalesceMs, keepaliveMs, lifetimeMs}`. Defaults match the server protocol: 1,000 pairs per pull page, 250 ms between pokes, 15 s between keepalives, and a 30-minute stream lifetime. The initial clock is `2026-10-09T12:00:00Z`. Time advances only through `advance`; waiting on a delayed request does not advance it.

`inject(fault)` queues a one-shot fault. Each matching request consumes at most one fault of each kind. Different kinds can combine on one request. `route` limits a fault to that endpoint; omitted routes match the next request of any kind.

- `{kind: "delay", route?, milliseconds}` delays handling. A `[min, max]` range selects an inclusive integer duration using `options.random`, a seeded function returning values in `[0, 1)`. The default selects the minimum. Other requests can finish before a delayed request, which observes state when its delay ends. Requests otherwise execute serially.
- `{kind: "drop_response", route?}` completes handling, discards the response, and rejects fetch with a network `TypeError`. A committed push remains applied.
- `{kind: "duplicate_push"}` executes the same push twice and returns the first result. The high-water mark deduplicates the second execution.
- `{kind: "unavailable", route: "push" | "pull" | "bootstrap", after?}` returns 503. Push stops after `after` committed results, defaulting to zero, and includes those results and the high-water mark. Pull and bootstrap return a JSON error and `Retry-After: 5`.
- `{kind: "truncate_bootstrap", afterRecords?}` ends the NDJSON stream after that many record lines, defaulting to zero, with a header and no trailer.
- `{kind: "close_events", afterMs}` ends the next event stream early, measured from connection time.
- `{kind: "reset_pull"}` makes the next pull return a reset with no acknowledgement or changes.
- `advanceHorizon(txid?)` prunes older transactions and resets cursors whose `xmin` predates the new horizon. The default is the current snapshot's `xmax`.

`set_role` and `remove_member` are implemented online-only commands. `invite`, `resend_invitation`, `create_integration`, and `import_issues` reject with 400, `not supported by the fake`. `add_attachment` and `attach_comment_file` reject with the real server's 400, `use the attachment upload endpoint`.

The fake emits plain NDJSON without gzip and serial snapshots with no in-flight transactions. It validates and reads valid cursors with `xip` entries but does not create in-flight transactions. It does not model database capacity limits, worker jobs, webhook delivery, pool limits, or automatic slow-bootstrap timeouts; explicit faults cover transport failures and incomplete snapshots. Generated ids are deterministic UUIDs and timestamps use the explicit clock. These choices keep client protocol tests reproducible; Rust integration tests cover database and worker behavior.

The fake reuses the client mutators, so it cannot detect bugs shared by client prediction and server simulation. Contract tests against Rust must cover those predictions. Create mutators currently upsert an existing id even in admit mode; the fake reserves ids first and rejects server collisions. An admin unsharing another user's view predicts local deletion; the fake retains the authoritative private view for its owner.
