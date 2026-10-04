import { useEffect, useRef, useState } from "react";
import { ApiError, collectPages, filterQuery, workspaces } from "./api";
import { useWorkspace } from "./workspace";
import type { Id, Issue, IssueFilter, PageResult, WorkspaceResources } from "./types";

export function mergeRecords<T extends { id: Id }>(before: T[], incoming: T[]): T[] {
  const records = new Map(before.map((record) => [record.id, record]));
  for (const record of incoming) records.set(record.id, record);
  return [...records.values()];
}

export function usePages<T>(
  key: string,
  read: (offset: number) => Promise<PageResult<T>>,
  enabled = true,
) {
  const { syncGeneration } = useWorkspace();
  const readRef = useRef(read);
  readRef.current = read;
  const [pageCount, setPageCount] = useState(1);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{
    key: string;
    items: T[];
    loading: boolean;
    error: string;
    hasMore: boolean;
  }>({
    key,
    items: [],
    loading: enabled,
    error: "",
    hasMore: false,
  });
  useEffect(() => {
    setPageCount(1);
  }, [key]);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    setState((state) => ({
      key,
      items: state.key === key ? state.items : [],
      loading: true,
      error: "",
      hasMore: state.key === key && state.hasMore,
    }));
    void (async () => {
      const items: T[] = [];
      let offset = 0;
      let hasMore = false;
      for (let page = 0; page < pageCount; page++) {
        const result = await readRef.current(offset);
        items.push(...result.items);
        hasMore = result.has_more;
        if (!hasMore) break;
        if (result.next_offset === null || result.next_offset <= offset)
          throw new Error("Invalid pagination offset");
        offset = result.next_offset;
      }
      if (live) setState({ key, items, loading: false, error: "", hasMore });
    })().catch((error: unknown) => {
      if (live)
        setState((state) => ({
          ...state,
          loading: false,
          error: error instanceof Error ? error.message : "Unable to load data",
        }));
    });
    return () => {
      live = false;
    };
  }, [key, pageCount, syncGeneration, attempt, enabled]);
  const current =
    state.key === key
      ? state
      : { ...state, items: [], loading: enabled, error: "", hasMore: false };
  return {
    ...current,
    loadMore: () => setPageCount((n) => n + 1),
    retry: () => setAttempt((n) => n + 1),
  };
}
export type PaginationState = Pick<
  ReturnType<typeof usePages>,
  "loading" | "error" | "hasMore" | "loadMore" | "retry"
>;

export function useIssues(filter: IssueFilter = {}, enabled = true) {
  const { ws, cache, me } = useWorkspace();
  const resolved = { ...filter, ...(filter.assignee === "me" ? { assignee: me } : {}) };
  const key = `${ws.id}/issues?${filterQuery(resolved)}`;
  const query = usePages(key, (offset) => workspaces.issues(ws.id, resolved, offset), enabled);
  useEffect(() => {
    if (!query.loading && !query.error && enabled)
      cache((ws) => ({ issues: mergeRecords(ws.issues, query.items) }));
  }, [query.items, query.loading, query.error, cache, enabled]);
  // Use the cache for optimistic edits while the active query refreshes.
  return {
    ...query,
    items: query.items.map(
      (issue) =>
        ws.issues.find((cached) => cached.id === issue.id && cached.version >= issue.version) ??
        issue,
    ),
  };
}

export function useResource<K extends keyof WorkspaceResources>(
  resource: K,
  params: Record<string, string | number> = {},
) {
  const { ws } = useWorkspace();
  const key = `${ws.id}/${resource}?${new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]))}`;
  return usePages(key, (offset) => workspaces.resource(ws.id, resource, { ...params, offset }));
}

export function useIssueDetail(issueId: string) {
  const { ws, cache, syncGeneration } = useWorkspace();
  const [state, setState] = useState<{
    id: string;
    loading: boolean;
    error: string;
    missing: boolean;
  }>({ id: issueId, loading: true, error: "", missing: false });
  const [attempt, setAttempt] = useState(0);
  const comments = useResource("comments", { issue_id: issueId });
  const time = useResource("time_entries", { issue_id: issueId });
  const activity = useResource("activity", { entity_id: issueId });
  useEffect(() => {
    if (!comments.loading && !comments.error)
      cache((ws) => ({
        comments: [...ws.comments.filter((c) => c.issue_id !== issueId), ...comments.items],
      }));
  }, [comments.items, comments.loading, comments.error, issueId, cache]);
  useEffect(() => {
    if (!time.loading && !time.error)
      cache((ws) => ({
        time_entries: [
          ...ws.time_entries.filter((entry) => entry.issue_id !== issueId),
          ...time.items,
        ],
      }));
  }, [time.items, time.loading, time.error, issueId, cache]);
  useEffect(() => {
    if (!activity.loading && !activity.error)
      cache((ws) => ({
        activity: [...ws.activity.filter((a) => a.entity_id !== issueId), ...activity.items],
      }));
  }, [activity.items, activity.loading, activity.error, issueId, cache]);
  useEffect(() => {
    let live = true;
    setState({ id: issueId, loading: true, error: "", missing: false });
    void (async () => {
      const issue = await workspaces.issue(ws.id, issueId);
      const ids = [issue.parent_id, ...issue.dependencies].filter((id): id is Id => id !== null);
      const [children, dependents, references] = await Promise.all([
        collectPages((offset) => workspaces.issues(ws.id, { parent_id: issueId }, offset)),
        collectPages((offset) => workspaces.issues(ws.id, { dependency_id: issueId }, offset)),
        ids.length
          ? collectPages((offset) => workspaces.issues(ws.id, { ids: ids.join(",") }, offset))
          : Promise.resolve<Issue[]>([]),
      ]);
      if (!live) return;
      cache((ws) => ({
        issues: mergeRecords(
          ws.issues.filter(
            (cached) =>
              cached.id !== issueId &&
              cached.parent_id !== issueId &&
              !cached.dependencies.includes(issueId),
          ),
          [issue, ...children, ...dependents, ...references],
        ),
      }));
      setState({ id: issueId, loading: false, error: "", missing: false });
    })().catch((error: unknown) => {
      if (live)
        setState({
          id: issueId,
          loading: false,
          error: error instanceof Error ? error.message : "Unable to load issue",
          missing: error instanceof ApiError && error.status === 404,
        });
    });
    return () => {
      live = false;
    };
  }, [ws.id, issueId, syncGeneration, attempt, cache]);
  return {
    ...state,
    loading: state.id !== issueId || state.loading,
    comments,
    time,
    activity,
    retry: () => setAttempt((n) => n + 1),
  };
}
