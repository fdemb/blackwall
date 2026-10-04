import {
  keepPreviousData,
  useInfiniteQuery,
  useQuery,
  useQueryClient,
  type InfiniteData,
  type UseInfiniteQueryResult,
} from "@tanstack/react-query";
import { ApiError } from "./api";
import {
  findCachedIssue,
  issueListQuery,
  issueQuery,
  pageQuery,
  type PagedKind,
  type PageParams,
} from "./query-client";
import { useWorkspace } from "./workspace";
import type { Id, Issue, IssueFilter, PageResult, WorkspaceResources } from "./types";

export interface ListState<T> {
  items: T[];
  /** True until the first page arrives, and while the next page loads. Background refreshes don't count. */
  loading: boolean;
  error: string;
  hasMore: boolean;
  loadMore: () => void;
  retry: () => void;
}
export type PaginationState = Omit<ListState<unknown>, "items">;

const message = (error: unknown, fallback: string) =>
  error instanceof Error && error.message ? error.message : fallback;

function listState<T>(
  query: UseInfiniteQueryResult<InfiniteData<PageResult<T>>>,
  enabled: boolean,
): ListState<T> {
  return {
    items: query.data?.pages.flatMap((page) => page.items) ?? [],
    loading:
      enabled &&
      (query.isPending ||
        query.isFetchingNextPage ||
        (query.isPlaceholderData && query.isFetching)),
    error: query.isError ? message(query.error, "Unable to load data") : "",
    hasMore: query.hasNextPage,
    loadMore: () => void query.fetchNextPage(),
    retry: () => void query.refetch(),
  };
}

export function useIssues(filter: IssueFilter = {}, enabled = true): ListState<Issue> {
  const { ws, me } = useWorkspace();
  const resolved = filter.assignee === "me" ? { ...filter, assignee: me } : filter;
  const query = useInfiniteQuery({
    ...issueListQuery(ws.id, resolved),
    enabled,
    // Changing a filter keeps the old rows on screen until the new ones arrive.
    placeholderData: keepPreviousData,
  });
  return listState(query, enabled);
}

export function useResource<K extends PagedKind>(
  kind: K,
  params: PageParams = {},
): ListState<WorkspaceResources[K]> {
  const { ws } = useWorkspace();
  return listState(useInfiniteQuery(pageQuery(ws.id, kind, params)), true);
}

/** An issue with everything its page shows: relatives, comments, time and history. */
export function useIssueDetail(issueId: Id) {
  const { ws } = useWorkspace();
  const client = useQueryClient();
  const query = useQuery({
    ...issueQuery(ws.id, issueId),
    // Opening an issue from a list shows the row's copy while the full record loads.
    placeholderData: () => findCachedIssue(client, ws.id, issueId),
  });
  const issue = query.data;
  const related = issue
    ? [...new Set([issue.parent_id, ...issue.dependencies])].filter((id): id is Id => id !== null)
    : [];
  const children = useIssues({ parent_id: issueId });
  const dependents = useIssues({ dependency_id: issueId });
  const references = useIssues({ ids: related.join(",") }, related.length > 0);
  const comments = useResource("comments", { issue_id: issueId });
  const time = useResource("time_entries", { issue_id: issueId });
  const activity = useResource("activity", { entity_id: issueId });
  const lookup = new Map(references.items.map((i) => [i.id, i]));
  return {
    issue,
    loading: query.isPending,
    error: query.isError ? message(query.error, "Unable to load issue") : "",
    missing: query.error instanceof ApiError && query.error.status === 404,
    retry: () => void query.refetch(),
    children: children.items,
    dependents: dependents.items,
    parent: issue?.parent_id ? lookup.get(issue.parent_id) : undefined,
    blockers: issue?.dependencies.flatMap((id) => lookup.get(id) ?? []) ?? [],
    comments,
    time,
    activity,
  };
}
export type IssueDetail = ReturnType<typeof useIssueDetail>;
