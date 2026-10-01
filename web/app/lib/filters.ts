import type { Issue, IssueFilter, Workspace } from "./types";
import { PRIORITY_RANK } from "./format";

export function applyFilter(ws: Workspace, filter: IssueFilter, me?: string): Issue[] {
  const q = filter.search?.toLowerCase().trim();
  let list = ws.issues.filter((i) => Boolean(i.deleted_at) === Boolean(filter.trash));
  list = list.filter(
    (i) =>
      (!filter.assignee || i.assignee === (filter.assignee === "me" ? me : filter.assignee)) &&
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
