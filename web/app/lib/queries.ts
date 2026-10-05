import { useMemo } from "react";
import {
  caseWhen,
  eq,
  ilike,
  inArray,
  isNull,
  lte,
  not,
  or,
  useLiveQuery,
  type InitialQueryBuilder,
} from "@tanstack/react-db";
import type { WorkspaceDb } from "./db";
import { useWorkspace } from "./workspace";
import type { Id, Issue, IssueFilter, Team } from "./types";

export interface ListState<T> {
  items: T[];
  /** True until the rows first arrive. */
  loading: boolean;
  error: string;
  /** Collections hold every row, so there is never a next page. Kept for list chrome. */
  hasMore: boolean;
  loadMore: () => void;
  retry: () => void;
}
export type PaginationState = Omit<ListState<unknown>, "items">;

function listState<T>(
  live: { data: T[] | undefined; isLoading: boolean; isError: boolean },
  retry: () => unknown,
  enabled = true,
): ListState<T> {
  return {
    items: live.data ?? [],
    loading: enabled && live.isLoading,
    error: live.isError ? "Unable to load data" : "",
    hasMore: false,
    loadMore: () => undefined,
    retry: () => void retry(),
  };
}

const LIKE_ESCAPE_RE = /[\\%_]/g;
const escapeLike = (text: string) => text.replace(LIKE_ESCAPE_RE, (c) => `\\${c}`);
const ISSUE_NUMBER_RE = /^(?:#|bw-)?(\d+)$/i;

/** Stages whose issues still need work, so `open` stays a plain membership test. */
export function openStageIds(teams: Team[]) {
  return teams.flatMap((t) =>
    t.stages.filter((s) => s.kind !== "done" && s.kind !== "cancelled").map((s) => s.id),
  );
}

/**
 * The live-query form of the API's issue filter, over the local issue collection.
 * Search matches title and description, or the issue number.
 */
export function issueQuery(
  q: InitialQueryBuilder,
  issues: WorkspaceDb["issues"],
  f: IssueFilter,
  openStages: Id[],
) {
  let query = q
    .from({ i: issues })
    .where(({ i }) =>
      f.trash
        ? not(isNull(i.deleted_at))
        : f.archived
          ? not(isNull(i.archived_at))
          : isNull(i.deleted_at),
    );
  // Archived rows hide by default; trash shows deleted whatever the archive flag says.
  if (!f.trash && !f.archived) query = query.where(({ i }) => isNull(i.archived_at));
  const equal = {
    assignee: f.assignee,
    team_id: f.team_id,
    stage_id: f.stage_id,
    priority: f.priority,
    sprint_id: f.sprint_id,
    project_id: f.project_id,
    parent_id: f.parent_id,
  } as const;
  for (const [field, value] of Object.entries(equal) as [keyof typeof equal, string | undefined][])
    if (value) query = query.where(({ i }) => eq(i[field], value));
  if (f.unassigned) query = query.where(({ i }) => isNull(i.assignee));
  if (f.no_sprint) query = query.where(({ i }) => isNull(i.sprint_id));
  if (f.label_id) {
    const label = f.label_id;
    query = query.where(({ i }) => inArray(label, i.labels));
  }
  if (f.dependency_id) {
    const dependency = f.dependency_id;
    query = query.where(({ i }) => inArray(dependency, i.dependencies));
  }
  if (f.ids !== undefined) {
    const ids = f.ids.split(",").filter(Boolean);
    query = query.where(({ i }) => inArray(i.id, ids));
  }
  if (f.open) query = query.where(({ i }) => inArray(i.stage_id, openStages));
  if (f.due_before) {
    const due = new Date(f.due_before).toISOString();
    query = query.where(({ i }) => lte(i.deadline, due));
  }
  const search = f.search?.trim();
  if (search) {
    const pattern = `%${escapeLike(search)}%`;
    const number = ISSUE_NUMBER_RE.exec(search)?.[1];
    query = query.where(({ i }) =>
      number
        ? or(ilike(i.title, pattern), ilike(i.description, pattern), eq(i.number, Number(number)))
        : or(ilike(i.title, pattern), ilike(i.description, pattern)),
    );
  }
  switch (f.sort ?? "position") {
    case "deadline":
      return query
        .orderBy(({ i }) => i.deadline, { direction: "asc", nulls: "last" })
        .orderBy(({ i }) => i.position);
    case "updated":
      return query.orderBy(({ i }) => i.updated_at, "desc");
    case "priority":
      return query
        .orderBy(
          ({ i }) =>
            caseWhen(
              eq(i.priority, "urgent"),
              4,
              eq(i.priority, "high"),
              3,
              eq(i.priority, "normal"),
              2,
              eq(i.priority, "low"),
              1,
              0,
            ),
          "desc",
        )
        .orderBy(({ i }) => i.position);
    default:
      return query.orderBy(({ i }) => i.position).orderBy(({ i }) => i.number);
  }
}

export function useIssues(filter: IssueFilter = {}, enabled = true): ListState<Issue> {
  const { db, ws, me } = useWorkspace();
  const resolved = filter.assignee === "me" ? { ...filter, assignee: me } : filter;
  const open = useMemo(() => openStageIds(ws.teams), [ws.teams]);
  const live = useLiveQuery({
    query: (q) => (enabled ? issueQuery(q, db.issues, resolved, open) : undefined),
  });
  return listState(
    live as { data: Issue[] | undefined; isLoading: boolean; isError: boolean },
    () => db.issues.utils.refetch(),
    enabled,
  );
}

/** The member's notifications, newest first. */
export function useNotifications(unreadOnly = false) {
  const { db } = useWorkspace();
  const live = useLiveQuery({
    query: (q) => {
      const all = q.from({ n: db.notifications });
      return (unreadOnly ? all.where(({ n }) => isNull(n.read_at)) : all).orderBy(
        ({ n }) => n.created_at,
        "desc",
      );
    },
  });
  return listState(live, () => db.notifications.utils.refetch());
}

/** An issue's comments, oldest first. Loading them loads only that issue's. */
export function useComments(issueId: Id) {
  const { db } = useWorkspace();
  const live = useLiveQuery({
    query: (q) =>
      q
        .from({ c: db.comments })
        .where(({ c }) => eq(c.issue_id, issueId))
        .orderBy(({ c }) => c.created_at),
  });
  return listState(live, () => db.comments.utils.refetch());
}

/** Time entries, newest first: one issue's, or the whole workspace's. */
export function useTimeEntries(issueId?: Id) {
  const { db } = useWorkspace();
  const live = useLiveQuery({
    query: (q) => {
      const from = q.from({ e: db.time_entries });
      return (issueId ? from.where(({ e }) => eq(e.issue_id, issueId)) : from).orderBy(
        ({ e }) => e.logged_at,
        "desc",
      );
    },
  });
  return listState(live, () => db.time_entries.utils.refetch());
}

/** History of one record, newest first. */
export function useActivity(entityId: Id) {
  const { db } = useWorkspace();
  const live = useLiveQuery({
    query: (q) =>
      q
        .from({ a: db.activity })
        .where(({ a }) => eq(a.entity_id, entityId))
        .orderBy(({ a }) => a.at, "desc"),
  });
  return listState(live, () => db.activity.utils.refetch());
}

/** An issue with its relatives, from the local issue collection. */
export function useIssueDetail(issueId: Id) {
  const { db } = useWorkspace();
  const live = useLiveQuery({
    query: (q) =>
      q
        .from({ i: db.issues })
        .where(({ i }) => eq(i.id, issueId))
        .findOne(),
  });
  const issue = live.data as Issue | undefined;
  const related = issue
    ? [...new Set([issue.parent_id, ...issue.dependencies])].filter((id): id is Id => id !== null)
    : [];
  const children = useIssues({ parent_id: issueId });
  const dependents = useIssues({ dependency_id: issueId });
  const references = useIssues({ ids: related.join(",") }, related.length > 0);
  const lookup = useMemo(
    () => new Map(references.items.map((i) => [i.id, i] as const)),
    [references.items],
  );
  return {
    issue,
    loading: live.isLoading,
    error: live.isError ? "Unable to load issue" : "",
    // Trash is in the collection too, so a missing row means the issue doesn't exist.
    missing: live.isReady && !issue,
    retry: () => void db.issues.utils.refetch(),
    children: children.items,
    dependents: dependents.items,
    parent: issue?.parent_id ? lookup.get(issue.parent_id) : undefined,
    blockers: issue?.dependencies.flatMap((id) => lookup.get(id) ?? []) ?? [],
  };
}
export type IssueDetail = ReturnType<typeof useIssueDetail>;
