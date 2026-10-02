import type { Issue, IssueFilter, IssueGroup, Workspace } from "./types";
import { PRIORITY_RANK } from "./format";

export function applyFilter(ws: Workspace, filter: IssueFilter, me?: string): Issue[] {
  const q = filter.search?.toLowerCase().trim();
  let list = ws.issues.filter((i) => Boolean(i.deleted_at) === Boolean(filter.trash));
  list = list.filter(
    (i) =>
      (!filter.assignee || i.assignee === (filter.assignee === "me" ? me : filter.assignee)) &&
      (!filter.unassigned || i.assignee === null) &&
      (!filter.team_id || i.team_id === filter.team_id) &&
      (!filter.stage_id || i.stage_id === filter.stage_id) &&
      (!filter.priority || i.priority === filter.priority) &&
      (!filter.label_id || i.labels.includes(filter.label_id)) &&
      (!filter.sprint_id || i.sprint_id === filter.sprint_id) &&
      (!filter.project_id || i.project_id === filter.project_id) &&
      (!filter.due_before ||
        (i.deadline !== null && new Date(i.deadline) <= new Date(filter.due_before))) &&
      (!q ||
        i.title.toLowerCase().includes(q) ||
        `bw-${i.number}`.includes(q) ||
        i.description.toLowerCase().includes(q)),
  );
  const sort = filter.sort ?? "position";
  const byTeamPos = (a: Issue, b: Issue) => a.position - b.position;
  list.sort((a, b) => {
    if (sort === "deadline") {
      if (!a.deadline && !b.deadline) return byTeamPos(a, b);
      if (!a.deadline) return 1;
      if (!b.deadline) return -1;
      return new Date(a.deadline).getTime() - new Date(b.deadline).getTime();
    }
    if (sort === "updated")
      return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
    if (sort === "priority")
      return PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority] || byTeamPos(a, b);
    return byTeamPos(a, b);
  });
  return list;
}

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
