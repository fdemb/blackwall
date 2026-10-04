import type { Id, Issue, IssueFilter, IssueGroup, Stage, Workspace } from "./types";

/** Stage lookup for one workspace. Built once per workspace object, so per-row scans stay O(1). */
const stageIndexCache = new WeakMap<Workspace, Map<Id, Stage>>();

export function stageIndexOf(ws: Workspace): Map<Id, Stage> {
  const hit = stageIndexCache.get(ws);
  if (hit) return hit;
  const index = new Map<Id, Stage>();
  for (const t of ws.teams) for (const s of t.stages) index.set(s.id, s);
  stageIndexCache.set(ws, index);
  return index;
}

export function isDone(ws: Workspace, issue: Issue) {
  const s = stageIndexOf(ws).get(issue.stage_id);
  return s ? s.kind === "done" || s.kind === "cancelled" : false;
}

export function stageOf(ws: Workspace, issue: Issue) {
  return stageIndexOf(ws).get(issue.stage_id);
}

/** What a queue really shows: the person's filters plus the scope the page adds (team, assignee). */
export function effectiveFilter(
  filter: IssueFilter,
  scope: IssueFilter = {},
  groupBy?: IssueGroup,
): IssueFilter {
  const merged: IssueFilter = { ...filter, ...scope, trash: false };
  if (merged.assignee) delete merged.unassigned;
  if (groupBy) merged.group_by = groupBy;
  return merged;
}

const normalized = (f: IssueFilter) =>
  JSON.stringify(
    Object.entries({ ...f, sort: f.sort ?? "position", group_by: f.group_by ?? "stage" })
      // The server sends unset filters as null, the UI leaves them out. Treat both as unset.
      .filter(([, v]) => v !== undefined && v !== null && v !== "" && v !== false)
      .sort(([a], [b]) => a.localeCompare(b)),
  );
export const sameFilter = (a: IssueFilter, b: IssueFilter) => normalized(a) === normalized(b);

/** End of the local day that is `days` from today, so "due today" includes deadlines later today. */
export function endOfDay(days: number) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  d.setHours(23, 59, 59, 999);
  return d.toISOString();
}
