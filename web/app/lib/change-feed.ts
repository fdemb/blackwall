import { queryOptions, type QueryClient } from "@tanstack/react-query";
import { workspaces } from "./api";
import { ENTITIES, normalizeIssue, type Entity, type WorkspaceDb } from "./db";
import { keys, refreshWorkspace } from "./query-client";
import type { Change, Id, Issue, WorkspaceSummary } from "./types";

/** How often to ask for other people's changes while the tab is visible. */
export const POLL_MS = 5000;

type Versioned = { version?: number };
type Writable = {
  get: (key: Id) => Versioned | undefined;
  utils: {
    writeUpsert: (record: object) => unknown;
    writeDelete: (key: Id) => unknown;
  };
};

const isEntity = (entity: string): entity is Entity =>
  (ENTITIES as readonly string[]).includes(entity);

/**
 * Writes server records from a command response or the change feed into the collections.
 * A record older than the local copy is skipped, so a slow poll can't undo a newer write.
 */
export function applyChanges(client: QueryClient, db: WorkspaceDb, changes: Change[]) {
  if (changes.length === 0) return;
  for (const change of changes) {
    if (change.entity === "workspace") {
      if (change.record)
        client.setQueryData(keys.workspace(db.id), {
          workspace: change.record as WorkspaceSummary,
        });
      continue;
    }
    if (!isEntity(change.entity)) continue;
    const collection = db[change.entity] as unknown as Writable;
    let record = change.record as (Versioned & object) | null;
    if (record && change.entity === "issues") record = normalizeIssue(record as Issue);
    try {
      if (record) {
        const local = collection.get(change.id);
        if (
          local?.version !== undefined &&
          record.version !== undefined &&
          record.version < local.version
        )
          continue;
        void collection.utils.writeUpsert(record);
      } else {
        // Rows this client never loaded have nothing to delete.
        void Promise.resolve(collection.utils.writeDelete(change.id)).catch(() => undefined);
      }
    } catch {
      // A delete for a row that isn't synced here, or a collection that hasn't started.
    }
  }
  // Totals depend on almost everything, but only when something actually changed.
  void client.invalidateQueries({ queryKey: keys.report(db.id) });
}

/** Change-feed cursors by workspace, taken before the first load so nothing slips between. */
const cursors = new Map<Id, string>();

export async function startChangeFeed(ws: Id) {
  if (!cursors.has(ws)) cursors.set(ws, (await workspaces.changes(ws)).cursor);
}

/**
 * Polls for other people's changes as a query: it pauses in hidden tabs, catches up on focus
 * and reconnect, and its error state drives the offline notice.
 */
export const changeFeedQuery = (client: QueryClient, db: WorkspaceDb) =>
  queryOptions({
    queryKey: keys.changes(db.id),
    queryFn: async () => {
      const since = cursors.get(db.id);
      const feed = await workspaces.changes(db.id, since);
      cursors.set(db.id, feed.cursor);
      if (since === undefined || feed.reset) await refreshWorkspace(client, db.id);
      else applyChanges(client, db, feed.changes);
      return feed.cursor;
    },
    refetchInterval: POLL_MS,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    // Polling drives freshness; keep data stale-free between polls without refetching on focus.
    staleTime: POLL_MS,
    retry: false,
  });
