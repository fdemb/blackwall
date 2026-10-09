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

## Later tasks

- 2d fake server: in-memory protocol peer for convergence tests.
- 2e transport and orchestration: pull/push/scope calls through `applyBase`/`batch`/`setPending`.
- 2f convergence tests: random traffic across engines must equal server state.
- React bindings: `useSyncExternalStore` over `subscribe`/`version`/`get`, status over `pendingVersion`.

## Invariants

- Persistence writes are atomic per method. Bootstrap stores replacement tables and metadata together without touching the outbox. Pull stores records, cursor, and any outbox acknowledgement together, checking loaded scopes in the same transaction. Scope reads replace that scope's records and store its loaded marker together. Mutation admission stores the mutation, including `local`, and increments `nextMutationId` together. Online-only allocation increments the id without an outbox entry. Memory builds a cloned state and swaps it only on success. IndexedDB resolves writes only after transaction completion. Persistence keeps timestamps and other wire fields unchanged. The store normalizes them on load.
- IndexedDB's `IDB_VERSION` tracks the store layout separately from `meta.schema`. A layout upgrade recreates all stores. A client schema mismatch leaves the existing replica readable so the orchestrator can flush the old outbox before wiping. Fresh replicas have `serverSchema: 0` until bootstrap. The storage constructor accepts an IndexedDB factory, a layout version, and `onClose({sessionId, workspaceId, reason})` for external closure. Upgrades and deletion close connections with `reason: "versionchange"`. Unexpected termination uses `"terminated"`. Blocked opens and deletes reject. A blocked open aborts its eventual upgrade. IndexedDB cannot cancel a blocked deletion, which proceeds when the blocker closes. Explicit `close()` does not call `onClose`.
- Base is written only by `replaceBase` and `applyBase`. Push results never touch base. `replaceBase(records, entities)` fully replaces each listed entity, so an empty bootstrap scope clears stale rows; unlisted entities are untouched. The orchestrator passes `BOOTSTRAP_ENTITIES` (every always-loaded entity except `comments` and `activity`).
- Deep immutability: every record entering the store is normalized, deep-cloned and deep-frozen, and `setPending` deep-clones and freezes each mutation including `args`. Reads return frozen `DeepReadonly` objects; mutators build new objects. `pending()` and the replay mutation are `DeepReadonly`; `withCounts` returns a `CountedIssue` whose `number` stays `number | null`.
- The overlay is rebuilt from scratch on every rebase; the view is base with the overlay on top. Each mutation replays with a per-mutation journal, so a throw restores that mutation's touches and records a frozen `ReplayError` (`{name, message, status?, code?}`) without leaking partial writes. Error changes compare structurally per mutation id.
- Identity preservation: candidates diff by structural `deepEqual`, and an unchanged value keeps the old view object wherever it lives (overlay or base), so an equal server record under pending work emits nothing and keeps versions stable.
- Lazy snapshots: `all` and `byIndex` return cached arrays that rebase invalidates but never rebuilds; the next read rebuilds. Base indexes serve `Tx.byIndex` from the bucket plus an overlay scan, never a base-table scan. Every whole-table iteration goes through `scanBase`, which counts visited rows in `debug.baseScans`.
- Iterative re-entrancy: writes during a rebase or notification set a flag instead of recursing; the store loops until quiet, capped at 100 passes per outermost call, after which it throws `sync store: rebase feedback loop`. `batch` nests and still rebases when its callback throws.
- Notifications: one `StoreEvent` per rebase with view `entities`/`keys` plus `pendingChanged`/`errorsChanged`. No event when nothing observable changed. `version(entity)` tracks view changes; `pendingVersion()` tracks pending/error changes.
