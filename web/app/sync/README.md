# Sync engine core

In-memory replica: base (server state) plus an overlay of replayed outbox mutations. No React, DOM, IndexedDB or fetch here.

## Files

- `records.ts`: entities, sync record shapes, keys, timestamp normalization, pull changes.
- `store.ts`: `SyncStore` (base, overlay replay, incremental indexes, subscriptions).
- `derived.ts`: issue counts over the store view, using the server's definitions.
- `fixtures.ts`: test factories and a hand-written replay. Tests only.

## Later tasks

- 2b mutators: one `(tx, args, ctx)` function per command, plugged in as the replay function.
- 2c persistence: loads base plus outbox via `replaceBase`/`setPending`, saves via `baseAll`/`pending`.
- 2d fake server: in-memory protocol peer for convergence tests.
- 2e transport and orchestration: pull/push/scope calls through `applyBase`/`batch`/`setPending`.
- 2f convergence tests: random traffic across engines must equal server state.
- React bindings: `useSyncExternalStore` over `subscribe`/`version`/`get`.

## Invariants

- Base is written only by `replaceBase` and `applyBase`. Push results never touch base.
- The overlay is rebuilt from scratch on every rebase; the view is base with the overlay on top.
- Derived structures (indexes, stage lookup, `all` arrays) update only from the changed-key set, never by rescanning tables on a rebase.
- Records keep object identity until their content changes; subscribers fire once per rebase that changed something.
