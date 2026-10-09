import { useEngine, useScope, useSyncStatus, useView } from "../sync/react";
import { withCounts, type CountedIssue } from "../sync/derived";
import type { SyncStore } from "../sync/store";
import { shallowEqual } from "../sync/selection";
import type { IssueFilter } from "./types";
import { filterIssues } from "./issue-filter";
import { byAtDesc, byCreatedAsc, byCreatedDesc, byLoggedDesc } from "./order";

export interface PaginationState {
  loading: boolean;
  error: string | null;
  hasMore: boolean;
  retry: () => Promise<void>;
  loadMore: () => Promise<void>;
}
export interface ListState<T> extends PaginationState {
  items: T[];
}

const counts = new WeakMap<SyncStore, Map<string, CountedIssue>>();
export function countedIssue(store: SyncStore, id: string): CountedIssue | undefined {
  const issue = store.get("issues", id);
  if (!issue) {
    counts.get(store)?.delete(id);
    return undefined;
  }
  let cache = counts.get(store);
  if (!cache) {
    cache = new Map();
    counts.set(store, cache);
  }
  const next = withCounts(store, issue);
  const previous = cache.get(id);
  if (previous && shallowEqual(previous, next)) return previous;
  cache.set(id, next);
  return next;
}

// A scope list loads on its own schedule, so its loading state comes from the scope, not the bootstrap.
function scopeState<T>(
  list: ListState<T>,
  scope: { loading: boolean; error: Error | null },
): ListState<T> {
  return { ...list, loading: scope.loading, error: scope.error?.message ?? null };
}

function useListState<T>(items: T[], error: string | null = null): ListState<T> {
  const engine = useEngine();
  const status = useSyncStatus();
  const retry = () => engine.pull();
  return {
    items,
    loading: status.phase !== "ready",
    error,
    hasMore: false,
    retry,
    loadMore: retry,
  };
}

export function useIssues(filter: IssueFilter = {}, enabled = true): ListState<CountedIssue> {
  const selection = useView(
    (store) => {
      try {
        const items = enabled
          ? filterIssues(store, filter).flatMap((issue) => countedIssue(store, issue.id) ?? [])
          : [];
        return items;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    },
    ["issues", "teams"],
    [JSON.stringify(filter), enabled],
  );
  return useListState(
    typeof selection === "string" ? [] : selection,
    typeof selection === "string" ? selection : null,
  );
}

export function useNotifications(unreadOnly = false) {
  const items = useView(
    (store) =>
      store
        .all("notifications")
        .filter((notification) => !unreadOnly || notification.read_at === null)
        .sort(byCreatedDesc),
    ["notifications"],
    [unreadOnly],
  );
  return useListState(items);
}

export function useComments(issueId: string) {
  const scope = useScope({ entity: "comments", issueId });
  const items = useView(
    (store) => [...store.byIndex("comments", "issue_id", issueId)].sort(byCreatedAsc),
    ["comments"],
    [issueId],
  );
  return scopeState(useListState(items), scope);
}

export function useTimeEntries(issueId?: string) {
  const items = useView(
    (store) =>
      [
        ...(issueId
          ? store.byIndex("time_entries", "issue_id", issueId)
          : store.all("time_entries")),
      ].sort(byLoggedDesc),
    ["time_entries"],
    [issueId],
  );
  return useListState(items);
}

export function useActivity(entityId: string) {
  const scope = useScope({ entity: "activity", entityId });
  const items = useView(
    (store) => [...store.byIndex("activity", "entity_id", entityId)].sort(byAtDesc),
    ["activity"],
    [entityId],
  );
  return scopeState(useListState(items), scope);
}

export interface IssueDetail extends Omit<PaginationState, "hasMore" | "loadMore"> {
  issue: CountedIssue | undefined;
  parent: CountedIssue | undefined;
  children: CountedIssue[];
  dependents: CountedIssue[];
  blockers: CountedIssue[];
  missing: boolean;
}
export function useIssueDetail(issueId: string): IssueDetail {
  const issue = useView((store) => countedIssue(store, issueId), ["issues", "teams"], [issueId]);
  const parent = useView(
    (store) => {
      const parentId = store.get("issues", issueId)?.parent_id;
      return parentId ? countedIssue(store, parentId) : undefined;
    },
    ["issues", "teams"],
    [issueId],
  );
  const children = useView(
    (store) =>
      store
        .byIndex("issues", "parent_id", issueId)
        .flatMap((row) => countedIssue(store, row.id) ?? []),
    ["issues", "teams"],
    [issueId],
  );
  const dependents = useView(
    (store) =>
      store
        .byIndex("issues", "dependency", issueId)
        .flatMap((row) => countedIssue(store, row.id) ?? []),
    ["issues", "teams"],
    [issueId],
  );
  const blockers = useView(
    (store) =>
      store.get("issues", issueId)?.dependencies.flatMap((id) => countedIssue(store, id) ?? []) ??
      [],
    ["issues", "teams"],
    [issueId],
  );
  const state = useListState([]);
  return {
    issue,
    parent,
    children,
    dependents,
    blockers,
    loading: state.loading,
    error: state.error,
    retry: state.retry,
    missing: !state.loading && !issue,
  };
}
