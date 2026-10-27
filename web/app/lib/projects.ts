import type { Key } from "./i18n";
import type { IsoDate, Milestone, ProjectHealth, ProjectStatus } from "./types";

type StatusTone = "neutral" | "primary" | "success" | "outline";

export const PROJECT_STATUS: Record<
  ProjectStatus,
  { label: Key; closed: boolean; tone: StatusTone }
> = {
  planned: { label: "projectStatus.planned", closed: false, tone: "neutral" },
  in_progress: { label: "projectStatus.in_progress", closed: false, tone: "primary" },
  completed: { label: "projectStatus.completed", closed: true, tone: "success" },
  cancelled: { label: "projectStatus.cancelled", closed: true, tone: "outline" },
};
export const PROJECT_STATUSES: ProjectStatus[] = [
  "planned",
  "in_progress",
  "completed",
  "cancelled",
];

export const PROJECT_HEALTH: Record<ProjectHealth, { label: Key; dot: string }> = {
  on_track: { label: "projectHealth.on_track", dot: "bg-success" },
  at_risk: { label: "projectHealth.at_risk", dot: "bg-warning" },
  off_track: { label: "projectHealth.off_track", dot: "bg-destructive" },
};
export const PROJECT_HEALTHS: ProjectHealth[] = ["on_track", "at_risk", "off_track"];

export function isProjectStatus(value: unknown): value is ProjectStatus {
  return typeof value === "string" && Object.hasOwn(PROJECT_STATUS, value);
}

export function isProjectHealth(value: unknown): value is ProjectHealth {
  return typeof value === "string" && Object.hasOwn(PROJECT_HEALTH, value);
}

export type ProjectScope = "open" | "closed" | "all";

export function inScope(status: ProjectStatus, scope: ProjectScope): boolean {
  return scope === "all" || PROJECT_STATUS[status].closed === (scope === "closed");
}

/** Local noon on a "YYYY-MM-DD" date, so formatting and date pickers keep the day in every zone. */
export function planDateTime(date: IsoDate): string {
  return new Date(`${date}T12:00:00`).toISOString();
}

export function localDay(iso: string): IsoDate {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** A project's milestones by deadline, those without one last. Ties keep the given order. */
export function projectMilestones<M extends Milestone>(
  milestones: readonly M[],
  projectId: string,
): M[] {
  return milestones
    .filter((m) => m.project_id === projectId)
    .sort((a, b) => (a.deadline ?? "9").localeCompare(b.deadline ?? "9"));
}

/**
 * Issues split by milestone, in the order `milestones` gives, then those without a milestone.
 * Milestones without issues drop out.
 */
export function milestoneGroups<I extends { milestone_id: string | null }>(
  issues: readonly I[],
  milestones: readonly Milestone[],
): { milestone: Milestone | null; items: I[] }[] {
  const items = new Map<string | null, I[]>();
  for (const issue of issues) {
    const key = issue.milestone_id ?? null;
    const list = items.get(key);
    if (list) list.push(issue);
    else items.set(key, [issue]);
  }
  return [...milestones, null].flatMap((milestone) => {
    const list = items.get(milestone?.id ?? null);
    return list ? [{ milestone, items: list }] : [];
  });
}
