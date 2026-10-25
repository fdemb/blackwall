import type { Key } from "./i18n";
import type { IsoDate, ProjectHealth, ProjectStatus } from "./types";

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
