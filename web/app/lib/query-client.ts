import { QueryClient, queryOptions } from "@tanstack/react-query";
import { ApiError, workspaces } from "./api";
import type { SyncStore } from "../sync/store";
import type { Id } from "./types";

/** Server reads that aren't part of the synced workspace data. */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5 * 60_000,
      gcTime: 15 * 60_000,
      refetchOnWindowFocus: false,
      // A 4xx will not fix itself on retry.
      retry: (count, error) => !(error instanceof ApiError && error.status < 500) && count < 2,
    },
  },
});

export const keys = {
  all: (ws: Id) => ["ws", ws] as const,
  report: (ws: Id) => ["ws", ws, "report"] as const,
};

export const reportQuery = (ws: Id) =>
  queryOptions({ queryKey: keys.report(ws), queryFn: () => workspaces.report(ws) });

/**
 * Marks the report stale after server-side issue or time changes. A local edit grows the outbox and
 * the server totals don't move until it is confirmed, which shrinks the outbox again.
 */
export function watchReportChanges(store: SyncStore, workspaceId: Id): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending = store.pending().length;
  const unsubscribe = store.subscribe((event) => {
    const before = pending;
    pending = store.pending().length;
    const touched = event.entities.has("issues") || event.entities.has("time_entries");
    if (pending > before || (pending === before && !touched)) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      void queryClient.invalidateQueries({ queryKey: keys.report(workspaceId) });
    }, 250);
  });
  return () => {
    clearTimeout(timer);
    unsubscribe();
  };
}
