import type { Issue, IssueFilter, IssueGroup, Workspace } from "./types";

export function isDone(ws: Workspace, issue: Issue) {
  for (const t of ws.teams) {
    const s = t.stages.find((s) => s.id === issue.stage_id);
    if (s) return s.kind === "done" || s.kind === "cancelled";
  }
  return false;
}

export function stageOf(ws: Workspace, issue: Issue) {
  for (const t of ws.teams) {
    const s = t.stages.find((s) => s.id === issue.stage_id);
    if (s) return s;
  }
  return undefined;
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
