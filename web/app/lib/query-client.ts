import { QueryClient, queryOptions } from "@tanstack/react-query";
import { ApiError, workspaces } from "./api";
import type { Id } from "./types";

/**
 * Shared by TanStack Query and every TanStack DB collection. The change feed keeps collections
 * current, so cached data stays fresh for a while and isn't refetched on focus.
 */
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
  workspace: (ws: Id) => ["ws", ws, "workspace"] as const,
  report: (ws: Id) => ["ws", ws, "report"] as const,
  changes: (ws: Id) => ["ws", ws, "changes"] as const,
  /** Backing queries of the workspace's TanStack DB collections. */
  db: (ws: Id, entity: string) => ["ws", ws, "db", entity] as const,
  commands: (ws: Id) => ["ws", ws, "command"] as const,
};

export const workspaceQuery = (ws: Id) =>
  queryOptions({ queryKey: keys.workspace(ws), queryFn: () => workspaces.get(ws) });

export const reportQuery = (ws: Id) =>
  queryOptions({ queryKey: keys.report(ws), queryFn: () => workspaces.report(ws) });

/** Refetches everything the workspace shows, except the change feed driving the refresh. */
export function refreshWorkspace(client: QueryClient, ws: Id) {
  return client.invalidateQueries({
    queryKey: keys.all(ws),
    predicate: (query) => query.queryKey[2] !== "changes",
  });
}
