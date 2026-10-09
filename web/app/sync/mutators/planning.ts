import type { Stage, StageKind, Team } from "../../lib/types";
import type { DeepReadonly, Tx } from "../store";
import type { ArgsOf, Mutator } from "./common";
import {
  NIL_UUID,
  checkArchiveDays,
  checkText,
  checkTimestamp,
  checkWorkflow,
  dedupeSortUuids,
  requireAdmin,
  requireMember,
  requireRecord,
  requireRole,
  requireTimestamp,
  stageKindOf,
  utf8Length,
} from "./common";
import { MutationError } from "./errors";

/** Mutable working copy: the store freezes records, so every write builds a new object. */
function copyTeam(team: DeepReadonly<Team>): Team {
  return {
    ...team,
    members: [...team.members],
    stages: team.stages.map((stage) => ({ ...stage })),
  };
}

/** Stage order as the server reads it (`ORDER BY position, id`). */
function sortStages(stages: Stage[]): Stage[] {
  return [...stages].sort(
    (a, b) => a.position - b.position || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

/** Adds the team to the member's `team_ids`, as the pull renders it. */
function joinTeam(tx: Tx, user: string, teamId: string): void {
  const member = tx.get("members", user);
  if (member === undefined || member.team_ids.includes(teamId)) return;
  tx.put("members", { ...member, team_ids: dedupeSortUuids([...member.team_ids, teamId]) });
}

/**
 * Default stages for a new team, in server order. Names, kinds and positions
 * mirror `default_stages` in `src/domain.rs`; ids come from the command's
 * `default_stage_ids`, which the engine generates before admission.
 */
const DEFAULT_STAGES: readonly { name: string; kind: StageKind; position: number }[] = [
  { name: "Backlog", kind: "backlog", position: 0 },
  { name: "Todo", kind: "planned", position: 1 },
  { name: "In progress", kind: "active", position: 2 },
  { name: "Done", kind: "done", position: 3 },
];

export const createTeam: Mutator<ArgsOf<"create_team">> = (tx, args, ctx) => {
  requireAdmin(requireRole(tx, ctx.actor, "create_team", args));
  // Order mirrors `planning::CreateTeam`: name, members, stage ids, then the
  // client id. Capacity is left to the server, as for the issue mutators.
  checkText(args.name, 200);
  const members = dedupeSortUuids(args.members);
  for (const user of members) requireMember(tx, user);
  const stageIds = args.default_stage_ids ?? null;
  if (stageIds === null) throw new MutationError(400, "default_stage_ids is required");
  if (stageIds.length !== DEFAULT_STAGES.length) {
    throw new MutationError(400, "default_stage_ids must contain exactly 4 ids");
  }
  const seen = new Set<string>();
  for (const stage of stageIds) {
    if (stage === NIL_UUID) throw new MutationError(400, "id must not be nil");
    if (seen.has(stage)) throw new MutationError(409, "id already exists");
    seen.add(stage);
  }
  const id = args.id ?? null;
  if (id === null) throw new MutationError(400, "id is required");
  if (id === NIL_UUID) throw new MutationError(400, "id must not be nil");
  if (seen.has(id)) throw new MutationError(409, "id already exists");
  // Creates are upserts. Pulled stages and archive settings survive replay,
  // including changes made after the server created this team.
  const previous = tx.get("teams", id);
  tx.put("teams", {
    id,
    version: previous?.version ?? 1,
    name: args.name,
    members,
    stages: previous
      ? previous.stages.map((stage) => ({ ...stage }))
      : DEFAULT_STAGES.map((stage, position) => {
          const stageId = stageIds[position];
          if (stageId === undefined)
            throw new MutationError(400, "default_stage_ids must contain exactly 4 ids");
          return {
            id: stageId,
            version: 1,
            name: stage.name,
            kind: stage.kind,
            position: stage.position,
          };
        }),
    // The server inserts `archive_after_days = 30` for a new team.
    archive_after_days: previous ? previous.archive_after_days : 30,
  });
  for (const user of members) joinTeam(tx, user, id);
};

export const setTeamMembers: Mutator<ArgsOf<"set_team_members">> = (tx, args, ctx) => {
  requireAdmin(requireRole(tx, ctx.actor, "set_team_members", args));
  // Order mirrors `planning::SetTeamMembers`: members, then the team lookup.
  const members = dedupeSortUuids(args.members);
  for (const user of members) requireMember(tx, user);
  const team = requireRecord(tx, "teams", args.id);
  const wanted = new Set(members);
  for (const user of new Set([...team.members, ...members])) {
    const member = tx.get("members", user);
    if (member === undefined) continue;
    const has = member.team_ids.includes(args.id);
    if (has === wanted.has(user)) continue;
    tx.put("members", {
      ...member,
      team_ids: wanted.has(user)
        ? dedupeSortUuids([...member.team_ids, args.id])
        : member.team_ids.filter((teamId) => teamId !== args.id),
    });
  }
  const next = copyTeam(team);
  next.members = members;
  tx.put("teams", next);
};

export const setTeamArchive: Mutator<ArgsOf<"set_team_archive">> = (tx, args, ctx) => {
  requireAdmin(requireRole(tx, ctx.actor, "set_team_archive", args));
  checkArchiveDays(args.archive_after_days);
  const team = requireRecord(tx, "teams", args.id);
  const next = copyTeam(team);
  next.archive_after_days = args.archive_after_days ?? null;
  tx.put("teams", next);
};

export const createStage: Mutator<ArgsOf<"create_stage">> = (tx, args, ctx) => {
  requireAdmin(requireRole(tx, ctx.actor, "create_stage", args));
  // Order mirrors `planning::CreateStage`: name, team, then the client id.
  checkText(args.name, 200);
  const team = requireRecord(tx, "teams", args.team_id);
  const id = args.id ?? null;
  if (id === null) throw new MutationError(400, "id is required");
  if (id === NIL_UUID) throw new MutationError(400, "id must not be nil");
  const next = copyTeam(team);
  const existing = next.stages.findIndex((stage) => stage.id === id);
  const record: Stage = {
    id,
    version: 1,
    name: args.name,
    kind: args.kind,
    position: args.position,
  };
  if (existing === -1) next.stages.push(record);
  else next.stages[existing] = { ...record, version: next.stages[existing]?.version ?? 1 };
  next.stages = sortStages(next.stages);
  tx.put("teams", next);
};

/**
 * Done-entry clock for a kind change (`planning::UpdateStage`): entering done
 * stamps every unstamped, unarchived issue in the stage; leaving done clears
 * every unarchived one. Archived rows are untouched either way, and deleted
 * rows move with the rest because the server's `UPDATE` filters only on
 * `archived_at`. Workflow candidates are collected separately.
 */
function restampStage(tx: Tx, stageId: string, previous: string, next: string, at: string): void {
  if (next === "done") {
    for (const issue of tx.byIndex("issues", "stage_id", stageId)) {
      if (issue.archived_at !== null || issue.done_at !== null) continue;
      tx.put("issues", { ...issue, done_at: at, updated_at: at });
    }
  } else if (previous === "done") {
    for (const issue of tx.byIndex("issues", "stage_id", stageId)) {
      if (issue.archived_at !== null) continue;
      tx.put("issues", { ...issue, done_at: null, updated_at: at });
    }
  }
}

export const updateStage: Mutator<ArgsOf<"update_stage">> = (tx, args, ctx) => {
  requireAdmin(requireRole(tx, ctx.actor, "update_stage", args));
  checkText(args.name, 200);
  const team = requireRecord(tx, "teams", args.team_id);
  const stage = team.stages.find((stage) => stage.id === args.id);
  if (stage === undefined) throw new MutationError(404, "not found");
  const previous = stage.kind;
  const next = copyTeam(team);
  next.stages = sortStages(
    next.stages.map((candidate) =>
      candidate.id === args.id
        ? { ...candidate, name: args.name, kind: args.kind, position: args.position }
        : candidate,
    ),
  );
  tx.put("teams", next);
  if (previous === args.kind) return;
  // The server validates the touched stage before restamping the Done-entry
  // clock, independent of the restamp writes, which cannot change the outcome.
  checkWorkflow(tx, [args.id]);
  restampStage(tx, args.id, previous, args.kind, ctx.at);
};

export const deleteStage: Mutator<ArgsOf<"delete_stage">> = (tx, args, ctx) => {
  requireAdmin(requireRole(tx, ctx.actor, "delete_stage", args));
  if (args.id === args.replacement) {
    throw new MutationError(400, "invalid replacement stage");
  }
  const team = requireRecord(tx, "teams", args.team_id);
  const kinds = new Map(team.stages.map((stage) => [stage.id, stage.kind] as const));
  const previous = kinds.get(args.id);
  const next = kinds.get(args.replacement);
  // A replay over a base that already dropped the stage is a no-op, as for
  // deleted issues; admission against that view fails as on the server.
  if (previous === undefined) {
    if (ctx.mode === "replay") return;
    throw new MutationError(400, "invalid replacement stage");
  }
  if (next === undefined) throw new MutationError(400, "invalid replacement stage");
  const affected: string[] = [];
  for (const issue of tx.byIndex("issues", "stage_id", args.id)) {
    tx.put("issues", { ...issue, stage_id: args.replacement, updated_at: ctx.at });
    affected.push(issue.id);
  }
  const nextTeam = copyTeam(team);
  nextTeam.stages = nextTeam.stages.filter((stage) => stage.id !== args.id);
  tx.put("teams", nextTeam);
  // The server validates the touched stage and the moved issues before
  // restamping the Done-entry clock, independent of the restamp writes.
  checkWorkflow(tx, [args.id, ...affected]);
  restampStage(tx, args.replacement, previous, next, ctx.at);
};

export const createLabel: Mutator<ArgsOf<"create_label">> = (tx, args, ctx) => {
  requireRole(tx, ctx.actor, "create_label", args);
  // Order mirrors `validate_label`: name, then color.
  checkText(args.name, 100);
  if (utf8Length(args.color) > 40) throw new MutationError(400, "invalid color");
  const id = args.id ?? null;
  if (id === null) throw new MutationError(400, "id is required");
  if (id === NIL_UUID) throw new MutationError(400, "id must not be nil");
  const previous = tx.get("labels", id);
  tx.put("labels", { id, version: previous?.version ?? 1, name: args.name, color: args.color });
};

export const updateLabel: Mutator<ArgsOf<"update_label">> = (tx, args, ctx) => {
  requireRole(tx, ctx.actor, "update_label", args);
  checkText(args.name, 100);
  if (utf8Length(args.color) > 40) throw new MutationError(400, "invalid color");
  const label = requireRecord(tx, "labels", args.id);
  tx.put("labels", { ...label, name: args.name, color: args.color });
};

export const createProject: Mutator<ArgsOf<"create_project">> = (tx, args, ctx) => {
  requireRole(tx, ctx.actor, "create_project", args);
  // Order mirrors `planning::CreateProject`: name, description, teams, id.
  checkText(args.name, 200);
  if (utf8Length(args.description) > 100_000) {
    throw new MutationError(400, "project description too long");
  }
  const teamIds = dedupeSortUuids(args.team_ids);
  for (const team of teamIds) requireRecord(tx, "teams", team);
  const id = args.id ?? null;
  if (id === null) throw new MutationError(400, "id is required");
  if (id === NIL_UUID) throw new MutationError(400, "id must not be nil");
  const previous = tx.get("projects", id);
  tx.put("projects", {
    id,
    version: previous?.version ?? 1,
    name: args.name,
    description: args.description,
    team_ids: teamIds,
  });
};

export const updateProject: Mutator<ArgsOf<"update_project">> = (tx, args, ctx) => {
  requireRole(tx, ctx.actor, "update_project", args);
  checkText(args.name, 200);
  if (utf8Length(args.description) > 100_000) {
    throw new MutationError(400, "project description too long");
  }
  const teamIds = dedupeSortUuids(args.team_ids);
  for (const team of teamIds) requireRecord(tx, "teams", team);
  const project = requireRecord(tx, "projects", args.id);
  // The server counts every issue row, without a deleted filter.
  for (const issue of tx.byIndex("issues", "project_id", args.id)) {
    if (!teamIds.includes(issue.team_id)) {
      throw new MutationError(409, "project teams still contain issues");
    }
  }
  tx.put("projects", {
    ...project,
    name: args.name,
    description: args.description,
    team_ids: teamIds,
  });
};

export const createMilestone: Mutator<ArgsOf<"create_milestone">> = (tx, args, ctx) => {
  requireRole(tx, ctx.actor, "create_milestone", args);
  // Order mirrors `planning::CreateMilestone`: name, deadline, project, id.
  checkText(args.name, 200);
  checkTimestamp(args.deadline);
  requireRecord(tx, "projects", args.project_id);
  const id = args.id ?? null;
  if (id === null) throw new MutationError(400, "id is required");
  if (id === NIL_UUID) throw new MutationError(400, "id must not be nil");
  const previous = tx.get("milestones", id);
  tx.put("milestones", {
    id,
    version: previous?.version ?? 1,
    project_id: args.project_id,
    name: args.name,
    deadline: args.deadline ?? null,
  });
};

export const updateMilestone: Mutator<ArgsOf<"update_milestone">> = (tx, args, ctx) => {
  requireRole(tx, ctx.actor, "update_milestone", args);
  checkText(args.name, 200);
  checkTimestamp(args.deadline);
  const milestone = requireRecord(tx, "milestones", args.id);
  tx.put("milestones", { ...milestone, name: args.name, deadline: args.deadline ?? null });
};

/** `validate_sprint` mirror (`src/store/planning.rs`), in the server's order. */
function checkSprint(
  name: string,
  goal: string,
  startsAt: string | null | undefined,
  endsAt: string | null | undefined,
): { starts: string; ends: string } {
  checkText(name, 200);
  const starts = requireTimestamp(startsAt);
  const ends = requireTimestamp(endsAt);
  if (ends <= starts) throw new MutationError(400, "sprint end must follow start");
  if (utf8Length(goal) > 100_000) throw new MutationError(400, "sprint goal too long");
  return { starts, ends };
}

export const createSprint: Mutator<ArgsOf<"create_sprint">> = (tx, args, ctx) => {
  requireRole(tx, ctx.actor, "create_sprint", args);
  const { starts, ends } = checkSprint(args.name, args.goal, args.starts_at, args.ends_at);
  requireRecord(tx, "teams", args.team_id);
  const id = args.id ?? null;
  if (id === null) throw new MutationError(400, "id is required");
  if (id === NIL_UUID) throw new MutationError(400, "id must not be nil");
  const previous = tx.get("sprints", id);
  tx.put("sprints", {
    id,
    version: previous?.version ?? 1,
    team_id: args.team_id,
    name: args.name,
    goal: args.goal,
    starts_at: starts,
    ends_at: ends,
    // A created sprint is planned with no outcome, as the server inserts it.
    // Storing the normalized timestamps matches what the pull renders.
    state: "planned",
    outcome: null,
  });
};

export const updateSprint: Mutator<ArgsOf<"update_sprint">> = (tx, args, ctx) => {
  requireRole(tx, ctx.actor, "update_sprint", args);
  const { starts, ends } = checkSprint(args.name, args.goal, args.starts_at, args.ends_at);
  if (args.state === "completed" || args.state === "archived") {
    throw new MutationError(400, "use completion or archive command");
  }
  const sprint = requireRecord(tx, "sprints", args.id);
  if (sprint.state === "completed" || sprint.state === "archived") {
    throw new MutationError(409, "sprint already completed");
  }
  tx.put("sprints", {
    ...sprint,
    name: args.name,
    goal: args.goal,
    starts_at: starts,
    ends_at: ends,
    state: args.state,
  });
};

export const completeSprint: Mutator<ArgsOf<"complete_sprint">> = (tx, args, ctx) => {
  requireRole(tx, ctx.actor, "complete_sprint", args);
  // Order mirrors `planning::complete_sprint`: the sprint, its archived
  // check, the completed no-op, then the carryover validation.
  const sprint = requireRecord(tx, "sprints", args.id);
  if (sprint.state === "archived") throw new MutationError(409, "sprint archived");
  if (sprint.state === "completed") return;
  const carryover = args.carryover_sprint_id ?? null;
  if (carryover !== null) {
    const target = tx.get("sprints", carryover);
    if (target === undefined) throw new MutationError(404, "not found");
    if (
      carryover === args.id ||
      target.team_id !== sprint.team_id ||
      target.state === "completed" ||
      target.state === "archived"
    ) {
      throw new MutationError(400, "invalid carryover sprint");
    }
  }
  // Deleted issues are neither counted nor carried over; terminal kinds come
  // from the issue's own team, as the server's join does.
  let completed = 0;
  let effort = 0;
  const rows = tx
    .byIndex("issues", "sprint_id", args.id)
    .filter((issue) => issue.deleted_at === null);
  for (const issue of rows) {
    effort += issue.estimate ?? 0;
    const kind = stageKindOf(tx, issue.team_id, issue.stage_id);
    if (kind === "done" || kind === "cancelled") completed += 1;
  }
  for (const issue of rows) {
    const kind = stageKindOf(tx, issue.team_id, issue.stage_id);
    if (kind === "done" || kind === "cancelled") continue;
    tx.put("issues", { ...issue, sprint_id: carryover, updated_at: ctx.at });
  }
  tx.put("sprints", {
    ...sprint,
    state: "completed",
    outcome: { total: rows.length, completed, effort },
  });
};

export const archiveSprint: Mutator<ArgsOf<"archive_sprint">> = (tx, args, ctx) => {
  requireRole(tx, ctx.actor, "archive_sprint", args);
  const sprint = requireRecord(tx, "sprints", args.id);
  if (sprint.state !== "completed" && sprint.state !== "archived") {
    throw new MutationError(400, "complete sprint before archiving");
  }
  if (sprint.state === "archived") return;
  tx.put("sprints", { ...sprint, state: "archived" });
};
