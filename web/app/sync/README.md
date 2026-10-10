# Sync engine core

Replica: base (server state) plus an overlay of replayed outbox mutations. The store and mutators run in memory; persistence stores prepared server records and pending mutations. The engine connects them through an injected transport, clock, ids, and signals. The core has no React dependency and reads no browser state.

## Files

- `records.ts`: entities, sync record shapes, keys, timestamp normalization, pull changes.
- `store.ts`: `SyncStore` (base, overlay replay, incremental indexes, subscriptions), shared record ingestion, and immutable copies.
- `derived.ts`: issue counts over the store view, using the server's definitions.
- `engine.ts`: `createEngine`, `SyncEngine`, and the client `SCHEMA`; lifecycle, serial reads, admission, ordered pushes, outcomes, events, polling, scopes, session cleanup, and tab roles.
- `engine-types.ts`: injected clock and signal contracts, dependencies, tab lock and channel contracts, status snapshots, engine events, rejection details, and mutation receipts.
- `engine-scheduling.ts`: serial queues, abort-aware waits, and deterministic capped backoff with jitter.
- `tabs.ts`: messages between engines that share one replica: appends, pulls, resets, status, results, and requests with replies.
- `engine.test.ts`: deterministic fake-server scenarios, including reload and schema recovery with both memory and IndexedDB persistence.
- `tabs.test.ts`: two and three engines sharing one IndexedDB database, lock, and channel: leader-only network work, follower edits, handover, and cross-tab requests.
- `convergence.test.ts`: fixed CI seeds, optional soak runs, tab-mode seeds, action coverage, and trace determinism.
- `testing/seeded.ts` and `testing/traffic.ts`: seeded randomness, ids, and command generation shared by fake and real-server convergence.
- `contract/`: isolated Rust-server fixtures, prediction contracts for every registered mutator, and real-server convergence.
- `testing/convergence.ts`: seeded traffic across two or three cookie-authenticated engines with separate memory and IndexedDB replicas. With `tabs`, the clients are tabs of one browser that share a database, lock, and channel, and the leader tab closes at random.
- `testing/tabs.ts`: in-memory stand-ins for `navigator.locks` and `BroadcastChannel`, with ordered asynchronous delivery and controls to hold or drop messages.
- `fixtures.ts`: test factories and a hand-written replay. Tests only.
- `mutators/index.ts`: command registry, admission, replay, and online-only command names.
- `mutators/`: argument normalization, validation, and command implementations grouped by domain.
- `persistence/types.ts`: replica metadata, loaded scopes, and the `Replica` and `ReplicaStorage` contracts.
- `persistence/shared.ts`: replica names, initial metadata, record keys, and scope filtering.
- `persistence/memory.ts`: `MemoryReplicaStorage`, retaining replicas across opens for tests and the fake server.
- `persistence/idb.ts`: `IndexedDBReplicaStorage`, using raw IndexedDB with one `blackwall:{sessionId}:{workspaceId}` database per replica.
- `persistence/persistence.test.ts`: shared contracts for both backends and IndexedDB lifecycle checks.
- `transport.ts`: injected-fetch HTTP transport, response validation, streaming bootstrap and SSE pokes, shared-session CSRF headers and updates, batch result validation, and typed errors. Each method makes one request; no retries or replica writes.
- `transport.test.ts`: transport contracts against the fake server and byte-level stream and malformed-response cases.
- `testing/fake-server.ts`: fetch-compatible protocol server, workspace state, authentication, control API, transaction log, and one-shot faults.
- `testing/tables.ts`: workspace tables and a scanning `Tx`, forked for each command and committed only on success.
- `testing/effects.ts`: `applyServerOnlyEffects`, correcting client predictions with server ids, numbers, versions, timestamps, positions, notifications, and activity.
- `testing/commands.ts`: HTTP command argument and UUID validation before mutator admission.
- `testing/push-json.ts`: Axum-style JSON extraction for push envelopes, including content types, error paths, and UTF-8 line/column positions.
- `testing/clock.ts`: explicit clock and timers for delays, sessions, and event streams.
- `testing/events.ts`: SSE initial and trailing pokes, coalescing, keepalives, cancellation, and lifetime.
- `testing/fake-server.test.ts`: protocol contracts based on the Rust sync integration tests.

## Later tasks

- React bindings: `useSyncExternalStore` over `subscribe`/`version`/`get`, status over `pendingVersion`.
- App wiring: pass `locks` and `channel` from `web/app/lib/workspace-engine.ts`.

## Engine lifecycle and API

`createEngine(deps)` constructs one session/workspace replica. `deps` contains `storage`, `transport`, `sessionId`, `workspaceId`, `actor`, `schema`, `randomId`, `clock`, and `signals`. Optional `locks` (the shape of `navigator.locks.request`) and `channel` (a factory for `BroadcastChannel`, named by the session and workspace) coordinate tabs; without them, the engine is always the leader. `clock.now()` returns an ISO timestamp. `clock.schedule(milliseconds, callback)` returns a cancellation function, equivalent to paired `setTimeout`/`clearTimeout` methods. The fake server exposes `now` and `schedule` from its own clock, so `server.advance(ms)` drives network delays, retries, and polling together. Jitter uses a seed derived from the session/workspace identity and never consumes `randomId`.

`signals.getOnline()` supplies the initial connectivity state. `signals.subscribe(listener)` returns an unsubscribe function; its events are `online`, `offline`, `focus`, and `visible`. The application maps visibility changes to `visible` when the page becomes visible. Signals update status after open, including while stopped, but network work requires a running engine.

- `open(): Promise<void>` loads disk state and immediately exposes `store`. A client schema mismatch resets base and scopes while keeping the outbox and mutation ids. It performs no network requests. Repeated opens share one promise.
- `start(): Promise<void>` opens if needed and begins network work. It resolves after starting the workers; use the status subscription to observe bootstrap completion. Reads and pushes run independently, including at startup. Calling `stop()` during open cancels that start.
- `stop(): void` aborts requests and timer waits, rejects pending online calls and receipt `settled` promises, and preserves the replica and any captured push batch. A later `start()` retries that exact batch before newer mutations. Unallocated online jobs are discarded after rejection. Offline signals pause workers until an online signal arrives and preserve callers' promises.
- `close(): Promise<void>` stops, drains persistence/store commits, unsubscribes signals, and closes the replica. It preserves the stored outbox. Outstanding online calls and receipt `settled` promises reject with a closed error. A closed or wiped engine cannot reopen.
- `pull(): Promise<void>` requests synchronization while started and online. Concurrent calls coalesce into the running pull and one follow-up. Stopped/offline calls perform no network work. Request errors appear through status and engine events.
- `mutate(name, args): Promise<MutationReceipt>` normalizes and admits a command, allocates missing create ids, stores it, and updates the optimistic view before returning. Issue ids live in `args.input.id`; other creates use `args.id`. Teams get ids for all default stages. The receipt contains the created record `id`, or null for an edit, the numeric `mutationId`, and `settled`. Settlement resolves to `"applied"` or `{id, status, message}` from the server. An acknowledgement with no push result in this engine also settles as applied. Receipts belong to the engine that admitted them; reloading restores mutations, not promises held by the old caller.
- `runOnline(name, args): Promise<MutationResult>` requires online status and waits for its replica's outbox to drain. The issuing tab sends `POST /api/workspaces/{id}/commands` with a per-call `idempotency_key`, without allocating a mutation id, persistence, or prediction. Transient failures retry the same frozen command body and key with backoff. Success keeps the caller's `{ id: 0, status: "applied" }` result shape; zero is not a sync mutation id. Business errors reject with `MutationError`. A leader requests a pull, and a follower relies on the server poke to its leader. Attachment uploads are excluded. A stopped engine can queue an online call, which waits for start or rejects on another stop or close.
- `useScope(scope): () => void` holds a comment or activity scope and returns an idempotent release function. The first hold loads it while started; further holds share the load. Releasing the last holder keeps its records loaded. Bootstrap discards loaded scopes and queues reloads for those still held. These loads finish independently of the bootstrap pull promise. `scopeStatus(scope)` returns `loading`, `loaded`, or `error`; `error` means a protocol error blocked the scope, and `scopeError(scope)` returns that error. `subscribeScopes(listener)` fires when a scope loads, bootstrap clears scopes, or a scope fails.
- `status.get()` returns a stable, frozen `EngineStatus`; `status.subscribe(listener)` returns an unsubscribe function. Snapshots contain `phase`, `role`, `connected`, `online`, `pending`, `lastError`, and `rejected`. `role` is `leader` or `follower`; a follower's `connected` and `online` come from the leader's status messages. Phases are `loading`, `bootstrapping`, and `ready`; `connected` means the event stream is open. Errors and rejections remain available after recovery.
- `subscribe(listener)` emits `rejected`, `error`, `unauthorized`, `accessLost`, and `closed` events and returns an unsubscribe function. `isClosed()` reports whether `close()` has started. Rejection events contain the same frozen details as `status.rejected`.

With `locks`, the engine holds the replica's lock from `start()` until `stop()` or `close()`. A tab that doesn't hold it is a follower: it keeps its store current from channel messages. Only the leader pulls, pushes, and loads scopes; a follower's scope requests go to the leader and are re-sent until answered. Every tab sends its own online-only REST commands. Push carries only outbox mutations. React bindings remain a separate task.

## Run convergence tests

From `web/`, run the fixed seeds with the sync suite:

```sh
vp test run app/sync
```

For a local soak, run seeds 1 through 500:

```sh
SYNC_FUZZ_SEEDS=500 vp test run app/sync/convergence.test.ts
```

To reproduce a failure, use the seed printed in its trace:

```sh
SYNC_FUZZ_SEED=179 vp test run app/sync/convergence.test.ts
```

`SYNC_FUZZ_STEPS` overrides the 90-action budget. Tab mode runs the same traffic with the clients as tabs of one browser, sharing a database, lock, and channel. Its `close-leader` action closes the leader tab, so the lock passes on. The default run covers six tab seeds; `SYNC_FUZZ_SEEDS` and `SYNC_FUZZ_SEED` cover the same seeds as the single-tab runs. The first 12 actions combine sustained pokes, delayed pulls, queued mutations, held scopes, and scope retry backoff. Random actions then mix issue and planning commands, comments, time, views, personal settings, concurrent server edits, online commands, scope holds, faults, clock advances, offline signals, stop/start, and reload. Persistence gates expose admission and disk/store boundaries.

Healing removes faults, restores connectivity, starts stopped clients, and reloads engines with blocked protocol lanes. Each run has a 200-second simulated recovery bound and a bounded host-IO drain. Quiescence requires an empty outbox, finished reads and writes, connected events, completed online calls, and persisted markers for every held scope.

The oracle compares whole eager records and held scopes with the server's actor-specific records, computes issue counts independently, and reopens persistence to compare every loaded table. Server observers check mutation order, identical retry batches and mutation content, receipts against original server results, and created-record existence. A final seeded auth failure checks 401/403 classification with unreadable error bodies on bootstrap, pull, push, scope, events, and CSRF refresh. Cleanup must preserve other replicas. The determinism test hashes actions, server push payloads, and outcomes across two runs.

The fake and clients use separate seeded generators; client UUID allocation is deterministic in the test runner. Each simulated tab has its own cookie and CSRF jar. The fetch adapter isolates the REST client's shared token singleton so one simulated tab cannot overwrite another tab's token.

Seed 179 currently exposes an outcome-contract question. A server-rejected command whose response is lost can later settle as `"applied"` after acknowledgement or a duplicate retry. That follows the documented fallback below, but fails the acceptance property that every applied receipt proves a server effect. The soak keeps this assertion strict. The minimized scenario is `cannot recover a rejection status from an acknowledgement and duplicate retry` in `engine.test.ts`.

## Run real-server contract tests

Install `psql`, Rust, and the web dependencies. Start PostgreSQL 17 from the repository root:

```sh
docker compose up -d postgres
export TEST_POSTGRES_URL=postgres://blackwall:blackwall@127.0.0.1:5432/blackwall
cd web
SYNC_CONTRACT=1 vp test run app/sync/contract
```

The database role needs `CREATEDB`. Both environment variables are required. Without them, the contract suites are skipped and their names explain how to enable them. Ordinary `vp test run` needs no server or database.

Global setup runs `cargo build --locked` once, creates a UUID-named database, and starts `target/debug/blackwall serve` on a free loopback port. The server applies migrations at startup. Setup uses an empty temporary `WEB_DIR`, waits for `/health`, and shares the server address with the test workers. Teardown terminates the process, forcibly drops only that test database, and removes the temporary directory, including after setup or test failures.

User registration, login, workspace creation, invitations, invitation acceptance, and uploads use REST. The membership fixture reads the invitation token from its queued email with `psql`; it writes no database state. Tests use bearer authentication, with a separate cookie and CSRF case.

Prediction tests stop the engine before mutation, capture its full view, restart it, and compare with confirmed records after the outbox empties. `contract/compare.ts` lists every exclusion and its reason: versions, newly allocated issue numbers, server-clock timestamp values, new notifications, and activity. Timestamp presence and nullness still compare. Existing notifications and all client-supplied dates compare, including saved-view dates stored as JSON.

Real-server convergence runs seeds 1, 42, and 1337 with 45 random actions each. It shares command generation with the fake-server runner. Three users exercise roles, scopes, offline edits, response loss after commit, stop/start, and reload with pending work. A role downgrade forces a server rejection of an admitted offline edit. After healing, each engine and its persisted records must match a fresh bootstrap and loaded scopes for that user, with empty memory and disk outboxes. The server receives no injected faults.

To run more seeds or reproduce a failure:

```sh
SYNC_CONTRACT=1 SYNC_FUZZ_SEEDS=100 vp test run app/sync/contract/convergence.real.test.ts
SYNC_CONTRACT=1 SYNC_FUZZ_SEED=42 SYNC_FUZZ_STEPS=200 vp test run app/sync/contract/convergence.real.test.ts
```

The action sequence is seeded; real network timing remains concurrent. Failures print the seed and action trace. `scripts/check.sh` enables the contract suite in CI after the ordinary web tests.

## Engine invariants

- Bootstrap, every pull page, and scope loads share one serial read queue. Each attempt finishes its atomic persistence write and store batch before the next read begins. Follow-up pulls, including additional pages, go behind reads already waiting; concurrent pokes request at most one follow-up. Retry backoff runs outside the queue, so failed scopes cannot block core reads. Reads queued for an aborted network generation cannot commit. Reset uses the same queue, so earlier scope/pull snapshots cannot land after it.
- Every bootstrap, pull page, and scope response passes through the store's record ingestion before persistence. The resulting normalized, detached, frozen records feed both persistence and the store. A malformed record raises `ProtocolError` before any record, cursor, scope marker, or acknowledgement from that response is written. Bootstrap also verifies the entire stream and trailer before writing; an incomplete line or missing trailer is retryable truncation.
- Transport reads CSRF from the REST client's shared token getter on every non-GET request and captures returned `X-CSRF-Token` headers, including `/api/me`. Failed error bodies retain their HTTP error classification and `Retry-After`, with a fallback message.
- A second serial queue owns mutation admission, persistence writes, and their store updates. Each admission reads the latest view, appends once, and merges into the current sorted pending list. An acknowledgement cannot overwrite a concurrent append. Existing persistence methods handle server acknowledgements atomically with records and cursor; the engine applies the matching base changes and pending removal in one store batch.
- Only bootstrap/pull acknowledgements remove mutations during normal synchronization. Push results settle callers and report rejections but never write base or remove outbox entries. An active batch defers acknowledgement-only settlement until its push result, preserving a rejection even when an SSE-triggered pull acknowledges first.
- Push sends at most 100 mutations in increasing id order, with one request in flight in its own lane. It starts independently of reads and waits only for acknowledgements before moving to newer work. Successful responses must cover the entire submitted batch in order; partial responses must cover an ordered prefix. Missing, repeated, reordered, or foreign results are protocol failures that reject pending online callers. Partial responses and transient failures retain the exact batch, including any already processed prefix, across retries and stop/start. Online-only allocation shares the commit queue and the push worker; a failed outbox-empty check waits and retries without consuming an id.
- Bootstrap, pull, scope, push, and event requests retry with deterministic jitter, capped at 30 seconds. A server `Retry-After` can extend that delay, including event reconnects; seconds and HTTP dates are supported, and dates use the injected clock. Protocol errors block that request kind and emit an error. A bootstrap protocol error also blocks further pulls until a new engine opens; a scope protocol error does not block core sync. Offline and stop cancel all retry waits. Polling runs every 30 seconds while events are disconnected, and online/focus/visibility signals request a pull.
- Unloaded comment/activity scopes reject incoming pull records. Deletions check the previous base record, so optimistic overlays cannot hide the scope needed for filtering. Scope replacement deletes only that scope's base records and rebases pending mutations on the replacement.
- A 401 stops all work, closes this replica, lists storage, and deletes only replicas whose `sessionId` matches. A 403 from a read, or a workspace 404, deletes only this replica. A push 403 first refreshes CSRF through `/api/me`, then checks workspace access with a queued pull. Only that read's 403 or 404 proves access loss. If access remains, the engine retries the exact push once; another push 403 is a protocol error and preserves the replica and outbox. Both wipes clear the view/outbox, set phase to loading, and emit the navigation event after deletion. Other sessions and workspaces remain intact. Before a wipe, the leader posts `unauthorized` or `accessLost` to its tabs. A follower that receives one, or whose database closes under it (`versionchange`, `terminated`), stops, closes its handle, clears its view, and emits the same event. A leader whose database closes does the same and tells the other tabs.

- Tabs: a leader's network work only starts after the lock is granted and the replica reloads from the database. A follower applies `pulled` and `reset` messages only after the leader persisted them, so its base never runs ahead of the database. `appended` messages come after the sender's database write, and the push lane reads only the outbox from the database before each batch, so a lost message only delays a push until the next one.
- Tabs: a push result settles the receipt of the tab that created the mutation. The leader reports a rejection itself only for mutations no other tab appended while it listened, since their creator may be gone. A payload acknowledged before its result is kept for a confirmation push, so the creator's receipt still settles.
- Tabs: follower requests are answered by the leader and re-sent every second until answered, and a repeated request joins the first run. A scope request is answered once the leader's load has persisted and broadcast, or has failed; a failure marks the follower's scope as `error`. A leader that already holds a scope answers the follower's request with no message, and the follower reads that scope's records from the database with `loadScope`, so no reset is sent. After a leader change, followers ask again for scopes they hold but haven't loaded.

## Invariants

- Persistence writes are atomic per method. Bootstrap stores replacement tables and metadata, clears all loaded scope markers and the `comments` and `activity` stores, and acknowledges the outbox in one transaction. The engine reloads the scopes on screen. Pull stores records, cursor, and any outbox acknowledgement together, checking loaded scopes in the same transaction. Both pull and bootstrap keep `lastMutationId` at the maximum of its stored and received values and drop outbox entries up to that maximum. A pull with a null acknowledgement leaves the outbox alone. Scope reads replace that scope's records and store its loaded marker together. `loadScope` returns the marker and that scope's records from one read-only transaction.
- Mutation admission stores the mutation, including `local`, and increments `nextMutationId` together. The leader sends outbox mutations in id order. Online-only REST commands wait for `loadOutbox()` to return an empty outbox. Memory builds a cloned state and swaps it only on success. IndexedDB resolves writes only after transaction completion. Persistence writes the supplied records without changing fields. Engine writes supply prepared, normalized records; the store also normalizes records on load.
- IndexedDB's `IDB_VERSION` tracks the store layout separately from `meta.schema`. A layout upgrade preserves the `meta` and `outbox` stores and their contents, recreates entity stores and `scopes`, and resets `cursor` to null in the upgrade transaction. Changes to the meta or outbox format require an explicit migration. On a client schema mismatch, the orchestrator calls `resetBase()` to clear all entity stores and scopes and reset the cursor in one transaction. Both resets adopt the schema supplied at open, set `serverSchema` to zero, and keep `clientId`, `lastMutationId`, `nextMutationId`, and the outbox. The engine bootstraps again, then pushes the surviving commands as usual.
- Fresh replicas have `serverSchema: 0` until bootstrap. The storage constructor accepts an IndexedDB factory, a layout version, and `onClose({sessionId, workspaceId, reason})` for external closure. `open({sessionId, workspaceId, schema, onClose})` also takes a per-handle `onClose(reason)`, which the engine uses to end its session when its database closes. Upgrades and deletion close connections with `reason: "versionchange"`. Unexpected termination uses `"terminated"`. Blocked opens and deletes reject. A blocked open aborts its eventual upgrade. IndexedDB cannot cancel a blocked deletion, which proceeds when the blocker closes. Explicit `close()` does not call `onClose`.
- Base is written only by `replaceBase` and `applyBase`. Push results never touch base. `replaceBase(records, entities)` fully replaces each listed entity; unlisted entities are untouched. Persistence receives `BOOTSTRAP_ENTITIES`, the always-loaded entities in the server snapshot. For `SyncStore.replaceBase`, the orchestrator passes `BOOTSTRAP_REPLACED_ENTITIES`, which adds `comments` and `activity`, with both scoped tables omitted or empty in the records. This clears stale scoped rows in memory as well as on disk.
- Deep immutability: every record entering the store is normalized, deep-cloned and deep-frozen, and `setPending` deep-clones and freezes each mutation including `args`. Reads return frozen `DeepReadonly` objects; mutators build new objects. `pending()` and the replay mutation are `DeepReadonly`; `withCounts` returns a `CountedIssue` whose `number` stays `number | null`.
- The overlay is rebuilt from scratch on every rebase; the view is base with the overlay on top. Each mutation replays with a per-mutation journal, so a throw restores that mutation's touches and records a frozen `ReplayError` (`{name, message, status?, code?}`) without leaking partial writes. Error changes compare structurally per mutation id.
- Identity preservation: candidates diff by structural `deepEqual`, and an unchanged value keeps the old view object wherever it lives (overlay or base), so an equal server record under pending work emits nothing and keeps versions stable.
- Lazy snapshots: `all` and `byIndex` return cached arrays that rebase invalidates but never rebuilds; the next read rebuilds. Base indexes serve `Tx.byIndex` from the bucket plus an overlay scan, never a base-table scan. Every whole-table iteration goes through `scanBase`, which counts visited rows in `debug.baseScans`.
- Iterative re-entrancy: writes during a rebase or notification set a flag instead of recursing; the store loops until quiet, capped at 100 passes per outermost call, after which it throws `sync store: rebase feedback loop`. `batch` nests and still rebases when its callback throws.
- Notifications: one `StoreEvent` per rebase with view `entities`/`keys` plus `pendingChanged`/`errorsChanged`. No event when nothing observable changed. `version(entity)` tracks view changes; `pendingVersion()` tracks pending/error changes.

## Fake server

`createFakeServer(options)` exposes a bound `fetch(input, init)` for `/api/me` and the workspace sync routes. It accepts relative paths, absolute URLs, and `Request` objects. Requests authenticate with `Authorization: Bearer <token>` or the `blackwall_session=<token>` cookie. Cookie pushes require the session's matching `X-CSRF-Token`; bearer pushes are exempt. `/api/me` returns the current CSRF token in its response header. Engine fixtures use cookie authentication. Reads check existing client ownership without registering a client, matching Rust's read-only transactions. The first processed push mutation registers the client.

The control API returns detached records:

- `addUser(profile?)` and `addWorkspace(workspace?)` return records, assigning omitted ids.
- `addMember(workspaceId, user, role)` adds a user by profile or user id. Its default role is `member`.
- `csrfToken(token)` returns the session's token; `rotateCsrf(token, csrf?)` replaces it with a supplied or generated token.
- `login(user)` returns a token with a fresh public `session_id`. `logout(token)` revokes it. Sessions expire after 30 days unless `sessionLifetimeMs` overrides that duration.
- `setRole(workspaceId, userId, role)` and `removeMember(workspaceId, userId)` commit external membership changes. These fixture controls bypass actor permissions. Commands through `run` and push enforce admin permissions and retain an owner.
- `run(actor, command, workspaceId?)` executes a command outside any client and returns `{result: {id}, changes}`. The actor is a profile or user id. Push uses the same command path in admit mode, with server time.
- `seed(entity, records, workspaceId?)` commits fixture rows in one transaction, including notifications, invitations, and integrations that tests need to supply directly.
- `uploadAttachment(actor, issueId, attachment, workspaceId?)` adds an uploaded attachment and records its uploader privately. Comments can claim only attachments uploaded by their actor. Seeding an attachment inside a record does not establish uploader ownership.
- `seedSourceLink(id, issueId, {url, title}, workspaceId?)` supplies a hidden source-link UUID. The fake sorts links by these UUIDs and omits them from sync records. Generated source-link UUIDs can reorder inserts.
- `records(entity, actorId?, workspaceId?)` and `record(entity, id, actorId?, workspaceId?)` render authoritative state for the actor. Omitted actors use the workspace's first owner. Invisible or missing individual records return `null`. Omitted workspace ids require exactly one workspace.
- `clientState(clientId)` returns `{last_mutation_id}`, defaulting to zero. `pruneClients()` removes clients idle for more than 30 days.
- `now()` returns the server timestamp. `advance(milliseconds)` runs due timers in order. `close()` ends all event streams.

`options` accepts `at`, `pageSize`, `horizon`, `sessionLifetimeMs`, and `events: {coalesceMs, keepaliveMs, lifetimeMs}`. Defaults match the server protocol: 1,000 pairs per pull page, 250 ms between pokes, 15 s between keepalives, and a 30-minute stream lifetime. The initial clock is `2026-10-09T12:00:00Z`. Time advances only through `advance`; waiting on a delayed request does not advance it.

`schedule(milliseconds, callback)` exposes this clock to the engine and returns a cancellation function. It does not advance time.

`inject(fault)` queues a one-shot fault. Each matching request consumes at most one fault of each kind. Different kinds can combine on one request. `route` limits a fault to that endpoint; omitted routes match the next request of any kind.

- `{kind: "delay", route?, milliseconds}` delays handling. A `[min, max]` range selects an inclusive integer duration using `options.random`, a seeded function returning values in `[0, 1)`. The default selects the minimum. Other requests can finish before a delayed request, which observes state when its delay ends. Requests otherwise execute serially.
- `{kind: "response_delay", route?: "pull" | "bootstrap" | "scope" | "push", milliseconds}` captures the snapshot or commits the push before delaying delivery. Pull, scope, and push fetches resolve after the delay; bootstrap headers resolve immediately and its frozen body waits. Later reads can return newer snapshots first. The delay runs outside the handling queue and supports abort and the same seeded duration ranges as `delay`. An omitted route matches the next read or push.
- `{kind: "drop_response", route?}` completes handling, discards the response, and rejects fetch with a network `TypeError`. A committed push remains applied.
- `{kind: "duplicate_push"}` executes the same push twice and returns the first result. The high-water mark deduplicates the second execution.
- `{kind: "unavailable", route: "push" | "pull" | "bootstrap" | "scope" | "events", after?}` returns 503. Push stops after `after` committed results, defaulting to zero, and includes those results and the high-water mark. Pull, bootstrap, scope, and events return a JSON error and `Retry-After: 5`.
- `{kind: "truncate_bootstrap", afterRecords?}` ends the NDJSON stream after that many record lines, defaulting to zero, with a header and no trailer.
- `{kind: "cut_bootstrap", byte}` cuts the encoded snapshot at an arbitrary byte offset, including inside a record or UTF-8 character.
- `{kind: "close_events", afterMs}` ends the next event stream early, measured from connection time.
- `{kind: "reset_pull"}` makes the next pull return a reset with no acknowledgement or changes.
- `advanceHorizon(txid?)` prunes older transactions and resets cursors whose `xmin` predates the new horizon. The default is the current snapshot's `xmax`.

`clearFaults()` removes unconsumed faults. Optional `onFault(route, fault)`, `onPush({clientId, mutations, previous})`, and `onResult(clientId, result)` observers receive detached inputs for convergence assertions. Push observation happens after authentication and envelope validation. Result observation includes original rejections and duplicate retries.

`set_role` and `remove_member` are implemented online-only commands. `invite`, `resend_invitation`, `create_integration`, and `import_issues` reject with 400, `not supported by the fake`. `add_attachment` and `attach_comment_file` reject with the real server's 400, `use the attachment upload endpoint`.

The fake emits plain NDJSON without gzip and serial snapshots with no in-flight transactions. It validates and reads valid cursors with `xip` entries but does not create in-flight transactions. It enforces workspace capacities for supported creates, including comments and private views the client cannot count completely. It does not model worker jobs, webhook delivery, pool limits, or automatic slow-bootstrap timeouts; explicit faults cover transport failures and incomplete snapshots. Generated ids are deterministic UUIDs and timestamps use the explicit clock. These choices keep client protocol tests reproducible; Rust integration tests cover database and worker behavior.

Push JSON extraction returns 415 for a missing or non-JSON content type, 400 for JSON syntax errors, and 422 for invalid envelope types or timestamps. These failures leave client high-water marks unchanged. Command argument and business errors reject individual mutations with the server status and message.

The fake reuses the client mutators, so it cannot detect bugs shared by client prediction and server simulation. Contract tests against Rust must cover those predictions. Create mutators reject visible id collisions during admission and keep upserts during replay. The fake also checks hidden ids and collisions across workspaces. Argument schemas validate unsigned integer ranges and require command timestamps to carry a Chrono-compatible timezone. Stage positions are signed `i64`, so negative positions remain valid. Mutators enforce capacities for complete replica tables and the 100-stage team limit. The fake handles workspace counts for comments and private views. An admin unsharing another user's view predicts local deletion; the fake retains the authoritative private view for its owner.
