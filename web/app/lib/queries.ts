import { useEffect, useRef } from "react";
import { useEngine, useScope, useSyncStatus, useView } from "../sync/react";
import { withCounts, type CountedIssue } from "../sync/derived";
import { teamNumber, type SyncStore } from "../sync/store";
import { parseIssueKey } from "./identifiers";
import { teamByKey } from "./teams";
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

/**
 * The issue a URL names: an id, or a key such as `ENG-42` in any case. Keys resolve only among
 * numbers the server confirmed, never against a local prediction.
 */
export function resolveIssue(store: SyncStore, ref: string): string | undefined {
  const key = parseIssueKey(ref);
  if (!key) return store.get("issues", ref)?.id;
  const team = teamByKey(store.all("teams"), key.team);
  if (!team) return undefined;
  const found = store.baseByIndex("issues", "team_number", teamNumber(team.id, key.number));
  const current = found.find((issue) => issue.team_id === team.id && issue.number === key.number);
  return (current ?? found[0])?.id;
}

export function useIssueRef(ref: string): string | undefined {
  return useView((store) => resolveIssue(store, ref), ["issues", "teams"], [ref]);
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

/** `limit` keeps the first matches before counting them. */
export function useIssues(
  filter: IssueFilter = {},
  enabled = true,
  limit?: number,
): ListState<CountedIssue> {
  const selection = useView(
    (store) => {
      try {
        if (!enabled) return [];
        return filterIssues(store, filter, limit).flatMap(
          (issue) => countedIssue(store, issue.id) ?? [],
        );
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    },
    ["issues", "teams"],
    [JSON.stringify(filter), enabled, limit],
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
  // A comment only the outbox holds, such as one the user just posted.
  const overlayOnly = useView(
    (store) =>
      store
        .byIndex("comments", "issue_id", issueId)
        .some((comment) => !store.baseGet("comments", comment.id)),
    ["comments"],
    [issueId],
  );
  return { ...scopeState(useListState(items), scope), overlayOnly };
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

// Long enough that sweeping the pointer, or arrowing focus, across a list doesn't queue a scope load
// per row.
const INTENT_MS = 100;

/** Row props that start loading an issue's comments and activity once the user moves to open it. */
export function useIssueIntent(issueId: string) {
  const engine = useEngine();
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const load = () => {
    clearTimeout(timer.current);
    engine.useScope({ entity: "comments", issueId })();
    engine.useScope({ entity: "activity", entityId: issueId })();
  };
  const schedule = () => {
    clearTimeout(timer.current);
    timer.current = setTimeout(load, INTENT_MS);
  };
  const cancel = () => clearTimeout(timer.current);
  return {
    onHoverStart: schedule,
    onHoverEnd: cancel,
    onPressStart: load,
    // Grid rows take no focus handlers, so keyboard focus is read off the row element.
    ref: (row: EventTarget | null) => {
      if (!row) return;
      row.addEventListener("focus", schedule);
      row.addEventListener("blur", cancel);
      return () => {
        row.removeEventListener("focus", schedule);
        row.removeEventListener("blur", cancel);
      };
    },
  };
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
