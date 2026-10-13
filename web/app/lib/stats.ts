import { useView } from "../sync/react";
import type { DeepReadonly, SyncStore } from "../sync/store";
import type { SyncIssue } from "../sync/records";
import type { Id, ProjectStats } from "./types";

// Counts the server report also computes, derived from the replica so ordinary pages never fetch it.
// Each follows the report query's definition. Stage kinds come from teams, so selectors watch both.

type IssueRow = DeepReadonly<SyncIssue>;
export interface Progress {
  total: number;
  completed: number;
}

const live = (issue: IssueRow) => issue.deleted_at === null && issue.archived_at === null;

function isDone(store: SyncStore, issue: IssueRow): boolean {
  const kind = store.stageKind(issue.stage_id);
  return kind === "done" || kind === "cancelled";
}

function progressOf(store: SyncStore, issues: Iterable<IssueRow>): Progress {
  const progress = { total: 0, completed: 0 };
  for (const issue of issues) {
    progress.total += 1;
    if (isDone(store, issue)) progress.completed += 1;
  }
  return progress;
}

function groupProgress(
  store: SyncStore,
  issues: readonly IssueRow[],
  key: (issue: IssueRow) => Id | null,
) {
  const groups = new Map<Id, IssueRow[]>();
  for (const issue of issues) {
    const id = key(issue);
    if (id === null) continue;
    const group = groups.get(id);
    if (group) group.push(issue);
    else groups.set(id, [issue]);
  }
  return [...groups].map(([id, rows]) => ({ id, ...progressOf(store, rows) }));
}

/** Issues that are neither deleted nor archived. */
export function issueCount(store: SyncStore): number {
  return store.all("issues").filter(live).length;
}

/** Live issues per label id. Labels without issues are absent. */
export function labelCounts(store: SyncStore): Record<Id, number> {
  const counts: Record<Id, number> = {};
  for (const issue of store.all("issues")) {
    if (!live(issue)) continue;
    for (const label of issue.labels) counts[label] = (counts[label] ?? 0) + 1;
  }
  return counts;
}

/** A finished sprint keeps its frozen outcome; otherwise its issues that aren't deleted, archived included. */
export function sprintProgress(store: SyncStore, sprintId: Id): Progress {
  const outcome = store.get("sprints", sprintId)?.outcome;
  if (outcome) return { total: outcome.total, completed: outcome.completed };
  const issues = store.byIndex("issues", "sprint_id", sprintId);
  return progressOf(
    store,
    issues.filter((issue) => issue.deleted_at === null),
  );
}

export function projectStats(store: SyncStore, projectId: Id): ProjectStats {
  const issues = store.byIndex("issues", "project_id", projectId).filter(live);
  const updated = issues.reduce<string | null>(
    (latest, issue) => (latest !== null && latest > issue.updated_at ? latest : issue.updated_at),
    null,
  );
  return {
    id: projectId,
    ...progressOf(store, issues),
    updated_at: updated,
    teams: groupProgress(store, issues, (issue) => issue.team_id),
    milestones: groupProgress(store, issues, (issue) => issue.milestone_id),
  };
}

export function useIssueCount(): number {
  return useView(issueCount, ["issues"], []);
}

export function useLabelCounts(): Record<Id, number> {
  return useView(labelCounts, ["issues"], []);
}

/** Progress per sprint id, for every sprint in the workspace. */
export function useSprintProgress(): ReadonlyMap<Id, Progress> {
  return useView(
    (store) => new Map(store.all("sprints").map((s) => [s.id, sprintProgress(store, s.id)])),
    ["sprints", "issues", "teams"],
    [],
  );
}

/** Stats per project id, for every project in the workspace. */
export function useProjectStats(): ReadonlyMap<Id, ProjectStats> {
  return useView(
    (store) => new Map(store.all("projects").map((p) => [p.id, projectStats(store, p.id)])),
    ["projects", "issues", "teams"],
    [],
  );
}
