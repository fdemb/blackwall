import { QueryClient, queryOptions } from "@tanstack/react-query";
import { ApiError, workspaces } from "./api";
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
