# Sync engine core

In-memory replica: base (server state) plus an overlay of replayed outbox mutations. No React, DOM, IndexedDB or fetch here.

## Files

- `records.ts`: entities, sync record shapes, keys, timestamp normalization, pull changes.
- `store.ts`: `SyncStore` (base, overlay replay, incremental indexes, subscriptions).
- `derived.ts`: issue counts over the store view, using the server's definitions.
- `fixtures.ts`: test factories and a hand-written replay. Tests only.

## Later tasks

- 2b mutators: one `(tx, args, ctx)` function per command, plugged in as the replay function.
- 2c persistence: loads base plus outbox via `replaceBase`/`setPending`, saves via `baseAll`/`pending` (`baseGet` for keyed reads).
- 2d fake server: in-memory protocol peer for convergence tests.
- 2e transport and orchestration: pull/push/scope calls through `applyBase`/`batch`/`setPending`.
- 2f convergence tests: random traffic across engines must equal server state.
- React bindings: `useSyncExternalStore` over `subscribe`/`version`/`get`, status over `pendingVersion`.

## Invariants

- Base is written only by `replaceBase` and `applyBase`. Push results never touch base. `replaceBase(records, entities)` fully replaces each listed entity, so an empty bootstrap scope clears stale rows; unlisted entities are untouched. The orchestrator passes `BOOTSTRAP_ENTITIES` (every always-loaded entity except `comments` and `activity`).
- Deep immutability: every record entering the store is normalized, deep-cloned and deep-frozen, and `setPending` deep-clones and freezes each mutation including `args`. Reads return frozen `DeepReadonly` objects; mutators build new objects. `pending()` and the replay mutation are `DeepReadonly`; `withCounts` returns a `CountedIssue` whose `number` stays `number | null`.
- The overlay is rebuilt from scratch on every rebase; the view is base with the overlay on top. Each mutation replays with a per-mutation journal, so a throw restores that mutation's touches and records a frozen `ReplayError` (`{name, message, status?, code?}`) without leaking partial writes. Error changes compare structurally per mutation id.
- Identity preservation: candidates diff by structural `deepEqual`, and an unchanged value keeps the old view object wherever it lives (overlay or base), so an equal server record under pending work emits nothing and keeps versions stable.
- Lazy snapshots: `all` and `byIndex` return cached arrays that rebase invalidates but never rebuilds; the next read rebuilds. Base indexes serve `Tx.byIndex` from the bucket plus an overlay scan, never a base-table scan. Every whole-table iteration goes through `scanBase`, which counts visited rows in `debug.baseScans`.
- Iterative re-entrancy: writes during a rebase or notification set a flag instead of recursing; the store loops until quiet, capped at 100 passes per outermost call, after which it throws `sync store: rebase feedback loop`. `batch` nests and still rebases when its callback throws.
- Notifications: one `StoreEvent` per rebase with view `entities`/`keys` plus `pendingChanged`/`errorsChanged`. No event when nothing observable changed. `version(entity)` tracks view changes; `pendingVersion()` tracks pending/error changes.
