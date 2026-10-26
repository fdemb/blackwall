import { byPosition } from "./order";
import { teamByKey } from "./teams";
import type { Id, Stage, Team } from "./types";

export interface StageView {
  stage: Stage;
  /** Issues in the stage that are neither archived nor trashed. */
  issues: number;
}

/** What the Teams settings list and a team's detail page show for one team. */
export interface TeamView {
  team: Team;
  stages: StageView[];
  openIssues: number;
}

type IssueRow = { stage_id: Id; deleted_at: string | null; archived_at: string | null };

/** Live issues per stage id. Stages without issues are absent. */
export function stageIssueCounts(issues: Iterable<IssueRow>): Record<Id, number> {
  const counts: Record<Id, number> = {};
  for (const issue of issues) {
    if (issue.deleted_at !== null || issue.archived_at !== null) continue;
    counts[issue.stage_id] = (counts[issue.stage_id] ?? 0) + 1;
  }
  return counts;
}

export function teamView(team: Team, counts: Readonly<Record<Id, number>>): TeamView {
  const stages = [...team.stages]
    .sort(byPosition)
    .map((stage) => ({ stage, issues: counts[stage.id] ?? 0 }));
  const openIssues = stages
    .filter(({ stage }) => stage.kind !== "done" && stage.kind !== "cancelled")
    .reduce((sum, { issues }) => sum + issues, 0);
  return { team, stages, openIssues };
}

/**
 * The team a `/settings/teams/:key` URL names. Old keys and any letter case resolve, so the page
 * can replace the URL with the team's current key.
 */
export function teamForKeyParam(teams: readonly Team[], param: string): Team | undefined {
  return teamByKey(teams, param.toUpperCase());
}

/**
 * Positions after moving `moved` next to `target`, numbered in board order from the lowest current
 * position so a single move renumbers only the stages it passes. Only stages whose position changes
 * are returned, so each one is a single `update_stage`.
 */
export function reorderStages(
  stages: readonly Stage[],
  moved: Id,
  target: Id,
  side: "before" | "after",
): { stage: Stage; position: number }[] {
  const order = [...stages].sort(byPosition);
  const from = order.findIndex((stage) => stage.id === moved);
  if (from < 0 || moved === target) return [];
  const [stage] = order.splice(from, 1);
  const to = order.findIndex((s) => s.id === target);
  if (to < 0) return [];
  const first = Math.min(stage.position, ...order.map((s) => s.position));
  order.splice(side === "before" ? to : to + 1, 0, stage);
  return order
    .map((s, index) => ({ stage: s, position: first + index }))
    .filter(({ stage: s, position }) => s.position !== position);
}

/** Auto-archive choices in days. `null` never archives. */
const ARCHIVE_DAYS = [7, 14, 30, 60, 90, 180, 365] as const;

/** The choices for a team, with its current custom value in order among the presets. */
export function archiveChoices(current: number | null): (number | null)[] {
  const days = new Set<number>(ARCHIVE_DAYS);
  if (current !== null) days.add(current);
  return [...[...days].sort((a, b) => a - b), null];
}
