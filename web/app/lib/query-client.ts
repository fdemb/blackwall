import {
  infiniteQueryOptions,
  QueryClient,
  queryOptions,
  type InfiniteData,
} from "@tanstack/react-query";
import { ApiError, collectPages, filterQuery, workspaces } from "./api";
import type { Id, Issue, IssueFilter, PageResult, WorkspaceResources } from "./types";

/**
 * The change feed keeps cached records current, so cached data stays fresh for a while and
 * revisiting a page shows it at once. Lists still refetch in the background when they go stale.
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

/** Workspace collections that are small enough to load whole and keep for the session. */
export const COLLECTIONS = [
  "teams",
  "labels",
  "projects",
  "milestones",
  "sprints",
  "views",
  "invitations",
  "alert_preferences",
  "integrations",
] as const satisfies (keyof WorkspaceResources)[];
export type CollectionKind = (typeof COLLECTIONS)[number];

/** Collections read a page at a time, usually scoped to one issue. */
export type PagedKind = "comments" | "time_entries" | "activity" | "notifications";
export type PageParams = { issue_id?: Id; entity_id?: Id };

export const keys = {
  all: (ws: Id) => ["ws", ws] as const,
  workspace: (ws: Id) => ["ws", ws, "workspace"] as const,
  members: (ws: Id) => ["ws", ws, "members"] as const,
  report: (ws: Id) => ["ws", ws, "report"] as const,
  collection: (ws: Id, kind: CollectionKind) => ["ws", ws, "collection", kind] as const,
  issues: (ws: Id) => ["ws", ws, "issues"] as const,
  issueLists: (ws: Id) => ["ws", ws, "issues", "list"] as const,
  issueList: (ws: Id, filter: IssueFilter) => ["ws", ws, "issues", "list", filter] as const,
  issue: (ws: Id, id: Id) => ["ws", ws, "issues", "detail", id] as const,
  pages: (ws: Id, kind: PagedKind) => ["ws", ws, "pages", kind] as const,
  page: (ws: Id, kind: PagedKind, params: PageParams) => ["ws", ws, "pages", kind, params] as const,
};

/** Drops empty values and orders keys, so equal filters share one cache entry. */
export function normalizeFilter(filter: IssueFilter): IssueFilter {
  return Object.fromEntries(
    [...new URLSearchParams(filterQuery(filter))].sort(([a], [b]) => a.localeCompare(b)),
  );
}

export const workspaceQuery = (ws: Id) =>
  queryOptions({ queryKey: keys.workspace(ws), queryFn: () => workspaces.get(ws) });

export const membersQuery = (ws: Id) =>
  queryOptions({ queryKey: keys.members(ws), queryFn: () => workspaces.members(ws) });

export const reportQuery = (ws: Id) =>
  queryOptions({ queryKey: keys.report(ws), queryFn: () => workspaces.report(ws) });

export const collectionQuery = <K extends CollectionKind>(ws: Id, kind: K) =>
  queryOptions({
    queryKey: keys.collection(ws, kind),
    queryFn: () =>
      collectPages<WorkspaceResources[K]>((offset) => workspaces.resource(ws, kind, { offset })),
  });

const nextOffset = <T>(last: PageResult<T>) =>
  last.has_more && last.next_offset !== null ? last.next_offset : undefined;

export const issueListQuery = (ws: Id, filter: IssueFilter) =>
  infiniteQueryOptions({
    queryKey: keys.issueList(ws, normalizeFilter(filter)),
    queryFn: ({ pageParam }) => workspaces.issues(ws, filter, pageParam),
    initialPageParam: 0,
    getNextPageParam: nextOffset,
  });

export const issueQuery = (ws: Id, id: Id) =>
  queryOptions({ queryKey: keys.issue(ws, id), queryFn: () => workspaces.issue(ws, id) });

export const pageQuery = <K extends PagedKind>(ws: Id, kind: K, params: PageParams = {}) =>
  infiniteQueryOptions({
    queryKey: keys.page(ws, kind, params),
    queryFn: ({ pageParam }) =>
      workspaces.resource(ws, kind, { ...params, offset: pageParam }) as Promise<
        PageResult<WorkspaceResources[K]>
      >,
    initialPageParam: 0,
    getNextPageParam: nextOffset,
  });

/** Everything the workspace shell reads before it renders. */
export function preloadWorkspace(client: QueryClient, ws: Id) {
  return Promise.all([
    client.ensureQueryData(workspaceQuery(ws)),
    client.ensureQueryData(membersQuery(ws)),
    client.ensureQueryData(reportQuery(ws)),
    ...COLLECTIONS.map((kind) => client.ensureQueryData(collectionQuery(ws, kind))),
  ]);
}

/** The newest copy of an issue anywhere in the cache, so a page can show it before its own fetch. */
export function findCachedIssue(client: QueryClient, ws: Id, id: Id): Issue | undefined {
  let found: Issue | undefined;
  const consider = (issue: Issue) => {
    if (issue.id === id && (!found || issue.version > found.version)) found = issue;
  };
  for (const [key, data] of client.getQueriesData<Issue | InfiniteData<PageResult<Issue>>>({
    queryKey: keys.issues(ws),
  })) {
    if (!data) continue;
    if (key[3] === "detail") consider(data as Issue);
    else
      for (const page of (data as InfiniteData<PageResult<Issue>>).pages)
        page.items.forEach(consider);
  }
  return found;
}
