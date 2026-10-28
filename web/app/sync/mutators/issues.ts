import { newMentions } from "../../lib/mentions";
import { sprintStageId } from "../../lib/teams";
import type { Id, IssuePatch } from "../../lib/types";
import { parseTimestamp } from "../records";
import type { SyncIssue } from "../records";
import type { DeepReadonly, Tx } from "../store";
import type { ArgsOf, Mutator, MutatorContext } from "./common";
import {
  checkSourceUrl,
  checkText,
  dedupeSortUuids,
  requireIssue,
  requireLiveIssue,
  requireMember,
  requireRole,
  stageKindOf,
  update,
  validateIssue,
  reserveClientId,
} from "./common";
import { MutationError } from "./errors";

/** Mutable working copy: the store freezes records, so every write builds a new object. */
function copyIssue(issue: DeepReadonly<SyncIssue>): SyncIssue {
  return {
    ...issue,
    labels: [...issue.labels],
    dependencies: [...issue.dependencies],
    followers: [...issue.followers],
    attachments: [...issue.attachments],
    source_links: [...issue.source_links],
    former_keys: [...issue.former_keys],
  };
}

/** Default stage: first of the team by position, mirroring the SQL `ORDER BY position, id`. */
function resolveStage(tx: Tx, teamId: string, stageId: string | null | undefined): string {
  const team = tx.get("teams", teamId);
  if (stageId !== null && stageId !== undefined) {
    if (team === undefined || team.stages.every((stage) => stage.id !== stageId)) {
      throw new MutationError(400, "stage belongs to another team");
    }
    return stageId;
  }
  if (team === undefined) throw new MutationError(404, "not found");
  const first = [...team.stages].sort(
    (a, b) => a.position - b.position || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  )[0];
  if (first === undefined) throw new MutationError(404, "not found");
  return first.id;
}

/**
 * Backlog work has no sprint, mirroring `fit_sprint` in `src/store/issues.rs`. When the command
 * chose the stage, the issue leaves its sprint; otherwise it joined a sprint from the backlog and
 * moves to the team's sprint stage. A stage from another team is left for `validateIssue`.
 */
function fitSprint(tx: Tx, next: SyncIssue, enteredStage: boolean): void {
  if (next.sprint_id === null || stageKindOf(tx, next.team_id, next.stage_id) !== "backlog") return;
  if (enteredStage) {
    next.sprint_id = null;
    return;
  }
  const stageId = sprintStageId(tx.get("teams", next.team_id)?.stages ?? []);
  if (stageId === undefined) throw new MutationError(400, "team has no stage for sprint work");
  next.stage_id = stageId;
}

/**
 * Position for a new issue over the rows the client holds, mirroring
 * `persistence::create` (`COALESCE(max(position),-1024)+1024`). Excludes the
 * created id itself so a replay gives the same result.
 */
function createPosition(tx: Tx, teamId: string, stageId: string, excludeId: string): number {
  let max = -1024;
  for (const peer of tx.byIndex("issues", "stage_id", stageId)) {
    if (peer.id === excludeId || peer.team_id !== teamId || peer.deleted_at !== null) continue;
    max = Math.max(max, peer.position);
  }
  return max + 1024;
}

function nextNumber(tx: Tx, teamId: string, excludeId: string): number {
  let max = 0;
  for (const peer of tx.byIndex("issues", "team_id", teamId)) {
    if (peer.id !== excludeId) max = Math.max(max, peer.number);
  }
  for (const moved of tx.byIndex("issues", "former_team_id", teamId)) {
    for (const key of moved.former_keys)
      if (key.team_id === teamId) max = Math.max(max, key.number);
  }
  return max + 1;
}

/**
 * Position for `move_issue` over the rows the client holds. Without
 * `before_id` this matches the server exactly (`max + 1024`, `0` when empty).
 * With `before_id` it mirrors the midpoint between the neighbor and the
 * closest lower row (by `(position, id)` order, as the server's
 * `max(position) ... WHERE (position,id)<(neighbor)`); the synthetic
 * `neighbor - 2048` bound applies only when no real predecessor exists.
 * When the gap holds no integer the server rebalances the whole stage, which
 * the client cannot predict, so it slots just before the neighbor and lets
 * the pull correct the rest.
 */
function orderPosition(
  tx: Tx,
  current: DeepReadonly<SyncIssue>,
  stageId: string,
  beforeId: string | null,
): number {
  const peers = tx
    .byIndex("issues", "stage_id", stageId)
    .filter((issue) => issue.team_id === current.team_id && issue.deleted_at === null);
  const others = peers.filter((issue) => issue.id !== current.id);
  if (beforeId === null) {
    let max = -1024;
    for (const peer of others) max = Math.max(max, peer.position);
    return max + 1024;
  }
  const neighbor = requireNeighbor(tx, current, stageId, beforeId);
  let lower: number | null = null;
  for (const peer of others) {
    if (peer.id !== beforeId && sortsBefore(peer, neighbor)) {
      lower = lower === null ? peer.position : Math.max(lower, peer.position);
    }
  }
  const low = lower ?? neighbor.position - 2048;
  const gap = neighbor.position - low;
  return gap <= 1 ? neighbor.position - 1 : low + Math.floor(gap / 2);
}

function requireNeighbor(
  tx: Tx,
  current: DeepReadonly<SyncIssue>,
  stageId: string,
  beforeId: string,
): DeepReadonly<SyncIssue> {
  const neighbor = tx.get("issues", beforeId);
  if (neighbor === undefined || neighbor.deleted_at !== null) {
    throw new MutationError(404, "not found");
  }
  if (
    beforeId === current.id ||
    neighbor.team_id !== current.team_id ||
    neighbor.stage_id !== stageId
  ) {
    throw new MutationError(400, "invalid ordering neighbor");
  }
  return neighbor;
}

/** `(position, id)` order, as the server compares rows. */
function sortsBefore(a: DeepReadonly<SyncIssue>, b: DeepReadonly<SyncIssue>): boolean {
  return a.position < b.position || (a.position === b.position && a.id < b.id);
}

/** `done_at` follows the stage: set on entering done, cleared on leaving it. */
function doneAt(
  tx: Tx,
  teamId: string,
  stageId: string,
  previous: string | null,
  at: string,
): string | null {
  return stageKindOf(tx, teamId, stageId) === "done" ? (previous ?? at) : null;
}

export const createIssue: Mutator<ArgsOf<"create_issue">> = (tx, args, ctx) => {
  requireRole(tx, ctx.actor, "create_issue", args);
  const input = args.input;
  const id = reserveClientId(tx, input.id, ctx);
  const stageId = resolveStage(tx, input.team_id, input.stage_id);
  const next = issueFromInput(input, id, stageId, ctx);
  followMentions(tx, next, "");
  fitSprint(tx, next, input.stage_id !== null && input.stage_id !== undefined);
  // The server stamps done_at when creating into a done stage.
  next.done_at = doneAt(tx, input.team_id, next.stage_id, null, ctx.at);
  // A replay over a base that already holds this id keeps the stored number,
  // version and timestamps; `createPosition` excludes the id itself so the
  // second run lands on the same position.
  const previous = tx.get("issues", id);
  if (previous !== undefined) {
    next.number = previous.number;
    next.version = previous.version;
    next.created_at = previous.created_at;
  } else {
    next.number = nextNumber(tx, next.team_id, id);
  }
  next.position = createPosition(tx, next.team_id, next.stage_id, id);
  validateIssue(tx, next, null);
  tx.put("issues", next);
};

function issueFromInput(
  input: DeepReadonly<ArgsOf<"create_issue">["input"]>,
  id: string,
  stageId: string,
  ctx: MutatorContext,
): SyncIssue {
  return {
    tracker: null,
    id,
    version: 1,
    number: 0,
    title: input.title,
    description: input.description ?? "",
    team_id: input.team_id,
    stage_id: stageId,
    assignee: input.assignee ?? null,
    created_by: ctx.actor,
    priority: input.priority ?? "none",
    labels: dedupeSortUuids(input.labels ?? []),
    estimate: input.estimate ?? null,
    deadline: input.deadline ?? null,
    project_id: input.project_id ?? null,
    milestone_id: input.milestone_id ?? null,
    sprint_id: input.sprint_id ?? null,
    parent_id: input.parent_id ?? null,
    dependencies: dedupeSortUuids(input.dependencies ?? []),
    position: 0,
    followers: dedupeSortUuids([ctx.actor, ...(input.assignee ? [input.assignee] : [])]),
    attachments: [],
    source_links: [],
    former_keys: [],
    deleted_at: null,
    archived_at: null,
    done_at: null,
    created_at: ctx.at,
    updated_at: ctx.at,
  };
}

/** Shared by `update_issue` and the bulk update action. */
function patchIssue(
  tx: Tx,
  id: string,
  patch: DeepReadonly<IssuePatch>,
  ctx: MutatorContext,
): void {
  const current = requireLiveIssue(tx, id);
  if (current.archived_at !== null) throw new MutationError(409, "issue is archived");
  const next = patchedIssue(current, patch);
  if (patch.team_id !== undefined && patch.team_id !== current.team_id)
    enterTeam(tx, current, next, patch.team_id);
  fitSprint(tx, next, next.stage_id !== current.stage_id);
  if (unchanged(current, next)) return;
  validateIssue(tx, next, current);
  if (next.stage_id !== current.stage_id) {
    next.done_at = doneAt(tx, next.team_id, next.stage_id, current.done_at, ctx.at);
  }
  if (next.assignee !== current.assignee && next.assignee)
    next.followers = dedupeSortUuids([...next.followers, next.assignee]);
  followMentions(tx, next, current.description);
  next.updated_at = ctx.at;
  tx.put("issues", next);
}

function unchanged(current: DeepReadonly<SyncIssue>, next: SyncIssue): boolean {
  return (
    next.title === current.title &&
    next.description === current.description &&
    next.team_id === current.team_id &&
    next.stage_id === current.stage_id &&
    next.assignee === current.assignee &&
    next.priority === current.priority &&
    sameIds(next.labels, current.labels) &&
    next.estimate === current.estimate &&
    sameInstant(next.deadline, current.deadline) &&
    next.project_id === current.project_id &&
    next.milestone_id === current.milestone_id &&
    next.sprint_id === current.sprint_id &&
    next.parent_id === current.parent_id &&
    sameIds(next.dependencies, current.dependencies)
  );
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

/** Postgres keeps microseconds, so finer digits and other offsets name the same deadline. */
function sameInstant(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  try {
    return parseTimestamp(a) === parseTimestamp(b);
  } catch {
    return a === b;
  }
}

function followMentions(tx: Tx, next: SyncIssue, before: string): void {
  const mentioned = newMentions(next.description, before).filter((user) => tx.get("members", user));
  if (mentioned.length > 0) next.followers = dedupeSortUuids([...next.followers, ...mentioned]);
}

function enterTeam(
  tx: Tx,
  current: DeepReadonly<SyncIssue>,
  next: SyncIssue,
  teamId: string,
): void {
  if (current.tracker)
    throw new MutationError(400, "synced issues follow their tracker project's team");
  next.former_keys.push({ team_id: current.team_id, number: current.number });
  next.team_id = teamId;
  if (next.sprint_id === current.sprint_id) next.sprint_id = null;
  const team = tx.get("teams", next.team_id);
  if (team === undefined) throw new MutationError(404, "not found");
  next.number = nextNumber(tx, next.team_id, next.id);
  if (next.stage_id === current.stage_id) {
    const kind = stageKindOf(tx, current.team_id, current.stage_id);
    const stage = [...team.stages].sort(
      (a, b) =>
        Number(a.kind !== kind) - Number(b.kind !== kind) ||
        a.position - b.position ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    )[0];
    if (stage === undefined) throw new MutationError(404, "not found");
    next.stage_id = stage.id;
  }
  if (next.project_id !== null && next.project_id === current.project_id) {
    if (!tx.get("projects", next.project_id)?.team_ids.includes(next.team_id)) {
      next.project_id = null;
      next.milestone_id = null;
    }
  }
  next.position = createPosition(tx, next.team_id, next.stage_id, next.id);
}

function isLabelList(labels: DeepReadonly<IssuePatch["labels"]>): labels is readonly Id[] {
  return Array.isArray(labels);
}

function patchedIssue(
  current: DeepReadonly<SyncIssue>,
  patch: DeepReadonly<IssuePatch>,
): SyncIssue {
  const next = copyIssue(current);
  next.title = patch.title ?? current.title;
  next.description = patch.description ?? current.description;
  next.stage_id = patch.stage_id ?? current.stage_id;
  next.assignee = setOrClear(current.assignee, patch.assignee, patch.clear_assignee);
  next.priority = patch.priority ?? current.priority;
  if (isLabelList(patch.labels)) next.labels = dedupeSortUuids(patch.labels);
  else if (patch.labels !== undefined) {
    const { add = [], remove = [] } = patch.labels;
    const kept = [...next.labels, ...add].filter((id) => !remove.includes(id));
    next.labels = dedupeSortUuids(kept);
  }
  next.estimate = setOrClear(current.estimate, patch.estimate, patch.clear_estimate);
  next.deadline = setOrClear(current.deadline, patch.deadline, patch.clear_deadline);
  next.project_id = setOrClear(current.project_id, patch.project_id, patch.clear_project);
  // Leaving the project also leaves its milestone, unless the patch names one.
  const milestone = patch.clear_project ? null : current.milestone_id;
  next.milestone_id = setOrClear(milestone, patch.milestone_id, patch.clear_milestone);
  next.sprint_id = setOrClear(current.sprint_id, patch.sprint_id, patch.clear_sprint);
  next.parent_id = setOrClear(current.parent_id, patch.parent_id, patch.clear_parent);
  if (patch.dependencies !== undefined) next.dependencies = dedupeSortUuids(patch.dependencies);
  return next;
}

/** `clear` wins over a supplied value; an absent value keeps the current one. */
function setOrClear<T>(current: T | null, value: T | null | undefined, clear?: boolean): T | null {
  if (clear) return null;
  return value ?? current;
}

export const updateIssue: Mutator<ArgsOf<"update_issue">> = (tx, args, ctx) => {
  requireRole(tx, ctx.actor, "update_issue", args);
  patchIssue(tx, args.id, args.patch, ctx);
};

export const moveIssue: Mutator<ArgsOf<"move_issue">> = (tx, args, ctx) => {
  requireRole(tx, ctx.actor, "move_issue", args);
  const current = requireLiveIssue(tx, args.id);
  if (current.archived_at !== null) throw new MutationError(409, "issue is archived");
  const team = tx.get("teams", current.team_id);
  if (team === undefined || team.stages.every((stage) => stage.id !== args.stage_id)) {
    throw new MutationError(400, "stage belongs to another team");
  }
  const next = copyIssue(current);
  next.stage_id = args.stage_id;
  fitSprint(tx, next, true);
  validateIssue(tx, next, current);
  next.position = orderPosition(tx, current, args.stage_id, args.before_id ?? null);
  if (next.stage_id !== current.stage_id) {
    next.done_at = doneAt(tx, next.team_id, next.stage_id, current.done_at, ctx.at);
  }
  next.updated_at = ctx.at;
  tx.put("issues", next);
};

/** Shared by `delete_issue` and the bulk delete action. Archived issues can be deleted. */
function deleteIssueById(tx: Tx, id: string, ctx: MutatorContext): void {
  const current = requireIssue(tx, id);
  if (current.deleted_at !== null) {
    if (ctx.mode === "replay") return;
    throw new MutationError(404, "not found");
  }
  update(tx, "issues", id, (issue) => {
    const next = copyIssue(issue);
    next.deleted_at = ctx.at;
    next.updated_at = ctx.at;
    return next;
  });
}

export const deleteIssue: Mutator<ArgsOf<"delete_issue">> = (tx, args, ctx) => {
  requireRole(tx, ctx.actor, "delete_issue", args);
  deleteIssueById(tx, args.id, ctx);
};

/** Shared by `restore_issue` and the bulk restore action. Restoring revalidates references. */
function restoreIssueById(tx: Tx, id: string, ctx: MutatorContext): void {
  const current = requireIssue(tx, id);
  if (current.deleted_at === null) {
    if (ctx.mode === "replay") return;
    throw new MutationError(400, "issue is not deleted");
  }
  const next = copyIssue(current);
  next.deleted_at = null;
  validateIssue(tx, next, current);
  next.updated_at = ctx.at;
  tx.put("issues", next);
}

export const restoreIssue: Mutator<ArgsOf<"restore_issue">> = (tx, args, ctx) => {
  requireRole(tx, ctx.actor, "restore_issue", args);
  restoreIssueById(tx, args.id, ctx);
};

/** Shared by `archive_issue` and the bulk archive action. Only done-stage issues archive. */
function archiveIssueById(tx: Tx, id: string, ctx: MutatorContext): void {
  const current = requireIssue(tx, id);
  if (current.deleted_at !== null) throw new MutationError(404, "not found");
  if (current.archived_at !== null) {
    if (ctx.mode === "replay") return;
    throw new MutationError(400, "issue is already archived");
  }
  if (stageKindOf(tx, current.team_id, current.stage_id) !== "done") {
    throw new MutationError(400, "only issues in a Done stage can be archived");
  }
  update(tx, "issues", id, (issue) => {
    const next = copyIssue(issue);
    next.archived_at = ctx.at;
    next.updated_at = ctx.at;
    return next;
  });
}

export const archiveIssue: Mutator<ArgsOf<"archive_issue">> = (tx, args, ctx) => {
  requireRole(tx, ctx.actor, "archive_issue", args);
  archiveIssueById(tx, args.id, ctx);
};

/** Shared by `unarchive_issue` and the bulk unarchive action. Unarchiving restarts the done clock. */
function unarchiveIssueById(tx: Tx, id: string, ctx: MutatorContext): void {
  const current = requireIssue(tx, id);
  if (current.deleted_at !== null) throw new MutationError(404, "not found");
  if (current.archived_at === null) {
    if (ctx.mode === "replay") return;
    throw new MutationError(400, "issue is not archived");
  }
  const next = copyIssue(current);
  next.archived_at = null;
  next.done_at = doneAt(tx, next.team_id, next.stage_id, null, ctx.at);
  next.updated_at = ctx.at;
  tx.put("issues", next);
}

export const unarchiveIssue: Mutator<ArgsOf<"unarchive_issue">> = (tx, args, ctx) => {
  requireRole(tx, ctx.actor, "unarchive_issue", args);
  unarchiveIssueById(tx, args.id, ctx);
};

export const bulkIssues: Mutator<ArgsOf<"bulk_issues">> = (tx, args, ctx) => {
  requireRole(tx, ctx.actor, "bulk_issues", args);
  if (args.ids.length === 0 || args.ids.length > 500) {
    throw new MutationError(400, "select 1 to 500 issues");
  }
  // The server locks every row before applying anything, so a missing id
  // fails the whole batch without partial writes.
  for (const id of args.ids) requireIssue(tx, id);
  const sorted = [...new Set(args.ids)].sort();
  for (const id of sorted) {
    const action = args.action;
    if (typeof action === "string") {
      if (action === "delete") deleteIssueById(tx, id, ctx);
      else if (action === "restore") restoreIssueById(tx, id, ctx);
      else if (action === "archive") archiveIssueById(tx, id, ctx);
      else unarchiveIssueById(tx, id, ctx);
    } else {
      patchIssue(tx, id, action.update, ctx);
    }
  }
};

export const followIssue: Mutator<ArgsOf<"follow">> = (tx, args, ctx) => {
  requireRole(tx, ctx.actor, "follow", args);
  const user = args.user_id ?? ctx.actor;
  requireMember(tx, user);
  const current = requireLiveIssue(tx, args.issue_id);
  const following = current.followers.includes(user);
  if (following === args.following) return;
  update(tx, "issues", args.issue_id, (issue) => {
    const next = copyIssue(issue);
    next.followers = args.following
      ? dedupeSortUuids([...issue.followers, user])
      : dedupeSortUuids(issue.followers.filter((follower: Id) => follower !== user));
    return next;
  });
};

export const addSourceLink: Mutator<ArgsOf<"add_source_link">> = (tx, args, ctx) => {
  requireRole(tx, ctx.actor, "add_source_link", args);
  // The server validates title and URL before the issue lookup.
  checkText(args.title, 500);
  checkSourceUrl(args.url);
  const current = requireLiveIssue(tx, args.issue_id);
  if (current.archived_at !== null) throw new MutationError(409, "issue is archived");
  // The server inserts with ON CONFLICT DO NOTHING, so repeats are no-ops.
  if (current.source_links.some((link) => link.url === args.url && link.title === args.title)) {
    return;
  }
  update(tx, "issues", args.issue_id, (issue) => {
    const next = copyIssue(issue);
    next.source_links = [...issue.source_links, { url: args.url, title: args.title }];
    return next;
  });
};

export const removeAttachment: Mutator<ArgsOf<"remove_attachment">> = (tx, args, ctx) => {
  requireRole(tx, ctx.actor, "remove_attachment", args);
  // Order mirrors the server: archived is rejected before deleted is noticed.
  const current = requireIssue(tx, args.issue_id);
  if (current.archived_at !== null) throw new MutationError(409, "issue is archived");
  if (current.deleted_at !== null) throw new MutationError(404, "not found");
  if (!current.attachments.some((attachment) => attachment.id === args.attachment_id)) {
    if (ctx.mode === "replay") return;
    throw new MutationError(404, "not found");
  }
  update(tx, "issues", args.issue_id, (issue) => {
    const next = copyIssue(issue);
    next.attachments = issue.attachments.filter(
      (attachment) => attachment.id !== args.attachment_id,
    );
    return next;
  });
};
