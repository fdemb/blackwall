import { safeGet, safeSet } from "./storage";
import type { Sprint } from "./types";

/** The tab last used on a team's issues and on a sprint, so links reopen it instead of the default. */
const TEAM_KEY = "bw-team-view:v1";
const SPRINT_KEY = "bw-sprint-view:v1";

const TEAM_VIEWS = ["list", "board", "backlog"] as const;
const SPRINT_VIEWS = ["board", "list", "plan"] as const;
export type TeamView = (typeof TEAM_VIEWS)[number];
export type SprintView = (typeof SPRINT_VIEWS)[number];

function read<T extends string>(key: string, views: readonly T[], fallback: T): T {
  const value = safeGet("local", key);
  return views.includes(value as T) ? (value as T) : fallback;
}

export const rememberTeamView = (view: string) => {
  if (TEAM_VIEWS.includes(view as TeamView)) safeSet("local", TEAM_KEY, view);
};

export const rememberSprintView = (view: string) => {
  if (SPRINT_VIEWS.includes(view as SprintView)) safeSet("local", SPRINT_KEY, view);
};

/** The team's issues, on the tab last used. List is the index route. */
export function teamPath(wsId: string, teamId: string) {
  const view = read(TEAM_KEY, TEAM_VIEWS, "list");
  const base = `/${wsId}/team/${teamId}`;
  return view === "list" ? base : `${base}/${view}`;
}

/** The sprint, on the tab last used. Board is the index route; a finished sprint has no plan. */
export function sprintPath(wsId: string, sprint: Pick<Sprint, "id" | "team_id" | "state">) {
  let view = read(SPRINT_KEY, SPRINT_VIEWS, "board");
  if (view === "plan" && sprint.state !== "planned" && sprint.state !== "active") view = "board";
  const base = `/${wsId}/team/${sprint.team_id}/sprints/${sprint.id}`;
  return view === "board" ? base : `${base}/${view}`;
}
