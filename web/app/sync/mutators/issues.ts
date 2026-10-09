import type { Id, IssuePatch } from "../../lib/types";
import type { SyncIssue } from "../records";
import type { DeepReadonly, Tx } from "../store";
import type { ArgsOf, Mutator, MutatorContext } from "./common";
import {
  checkImportedForSave,
  checkOwnership,
  checkSourceUrl,
  checkText,
  checkWorkflow,
  dedupeSortUuids,
  NIL_UUID,
  requireIssue,
  requireLiveIssue,
  requireRole,
  stageKindOf,
  update,
  validateIssue,
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
  let lower: number | null = null;
  for (const peer of others) {
    if (peer.id === beforeId) continue;
    if (
      peer.position < neighbor.position ||
      (peer.position === neighbor.position && peer.id < beforeId)
    ) {
      lower = lower === null ? peer.position : Math.max(lower, peer.position);
    }
  }
  const low = lower ?? neighbor.position - 2048;
  const gap = neighbor.position - low;
  return gap <= 1 ? neighbor.position - 1 : low + Math.floor(gap / 2);
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
  const id = input.id ?? null;
  if (id === null) throw new MutationError(400, "id is required");
  if (id === NIL_UUID) throw new MutationError(400, "id must not be nil");
  checkOwnership(tx, { type: "create_issue", input });
  const stageId = resolveStage(tx, input.team_id, input.stage_id);
  const previous = tx.get("issues", id);
  const next: SyncIssue = {
    openproject: null,
    id,
    version: previous?.version ?? 1,
    number: previous?.number ?? null,
    title: input.title,
    description: input.description ?? "",
    team_id: input.team_id,
    stage_id: stageId,
    assignee: input.assignee ?? null,
    created_by: ctx.actor,
    priority: input.priority ?? "none",
    labels: input.labels ? dedupeSortUuids(input.labels) : [],
    estimate: input.estimate ?? null,
    deadline: input.deadline ?? null,
    project_id: input.project_id ?? null,
    milestone_id: input.milestone_id ?? null,
    sprint_id: input.sprint_id ?? null,
    parent_id: input.parent_id ?? null,
    dependencies: input.dependencies ? dedupeSortUuids(input.dependencies) : [],
    position: 0,
    followers: [ctx.actor],
    attachments: [],
    source_links: [],
    deleted_at: null,
    archived_at: null,
    // The server stamps done_at when creating into a done stage; the issue
    // number stays null until the pull confirms the create.
    done_at: doneAt(tx, input.team_id, stageId, null, ctx.at),
    created_at: previous?.created_at ?? ctx.at,
    updated_at: ctx.at,
  };
  next.position = createPosition(tx, next.team_id, next.stage_id, id);
  // A replay over a base that already holds this id keeps the stored number,
  // version and timestamps; `createPosition` excludes the id itself so the
  // second run lands on the same position.
  if (previous !== undefined) {
    next.number = previous.number;
    next.version = previous.version;
    next.created_at = previous.created_at;
  }
  validateIssue(tx, next, null);
  tx.put("issues", next);
  checkWorkflow(tx, [id]);
};

/** Shared by `update_issue` and the bulk update action. */
function patchIssue(
  tx: Tx,
  id: string,
  patch: DeepReadonly<IssuePatch>,
  ctx: MutatorContext,
): void {
  const current = requireLiveIssue(tx, id);
  if (current.archived_at !== null) throw new MutationError(409, "issue is archived");
  const next = copyIssue(current);
  if (patch.title !== undefined) next.title = patch.title;
  if (patch.description !== undefined) next.description = patch.description;
  if (patch.stage_id !== undefined) next.stage_id = patch.stage_id;
  next.assignee = patch.clear_assignee ? null : (patch.assignee ?? current.assignee);
  if (patch.priority !== undefined) next.priority = patch.priority;
  if (patch.labels !== undefined) next.labels = dedupeSortUuids(patch.labels);
  next.estimate = patch.clear_estimate ? null : (patch.estimate ?? current.estimate);
  next.deadline = patch.clear_deadline ? null : (patch.deadline ?? current.deadline);
  // clear_project also clears the milestone, unless the patch names one.
  next.project_id = patch.clear_project ? null : (patch.project_id ?? current.project_id);
  next.milestone_id = patch.clear_project ? null : current.milestone_id;
  if (patch.clear_milestone) next.milestone_id = null;
  else if (patch.milestone_id !== undefined) next.milestone_id = patch.milestone_id;
  next.sprint_id = patch.clear_sprint ? null : (patch.sprint_id ?? current.sprint_id);
  next.parent_id = patch.clear_parent ? null : (patch.parent_id ?? current.parent_id);
  if (patch.dependencies !== undefined) next.dependencies = dedupeSortUuids(patch.dependencies);
  validateIssue(tx, next, current.sprint_id);
  if (next.stage_id !== current.stage_id) {
    next.done_at = doneAt(tx, next.team_id, next.stage_id, current.done_at, ctx.at);
  }
  next.updated_at = ctx.at;
  tx.put("issues", next);
}

export const updateIssue: Mutator<ArgsOf<"update_issue">> = (tx, args, ctx) => {
  requireRole(tx, ctx.actor, "update_issue", args);
  checkOwnership(tx, { type: "update_issue", id: args.id, patch: args.patch });
  patchIssue(tx, args.id, args.patch, ctx);
  checkWorkflow(tx, [args.id]);
};

export const moveIssue: Mutator<ArgsOf<"move_issue">> = (tx, args, ctx) => {
  requireRole(tx, ctx.actor, "move_issue", args);
  checkOwnership(tx, {
    type: "move_issue",
    id: args.id,
    stage_id: args.stage_id,
    before_id: args.before_id,
  });
  const current = requireLiveIssue(tx, args.id);
  if (current.archived_at !== null) throw new MutationError(409, "issue is archived");
  const team = tx.get("teams", current.team_id);
  if (team === undefined || team.stages.every((stage) => stage.id !== args.stage_id)) {
    throw new MutationError(400, "stage belongs to another team");
  }
  const next = copyIssue(current);
  next.stage_id = args.stage_id;
  validateIssue(tx, next, current.sprint_id);
  next.position = orderPosition(tx, current, args.stage_id, args.before_id ?? null);
  if (next.stage_id !== current.stage_id) {
    next.done_at = doneAt(tx, next.team_id, next.stage_id, current.done_at, ctx.at);
  }
  next.updated_at = ctx.at;
  tx.put("issues", next);
  checkWorkflow(tx, [args.id]);
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
  checkOwnership(tx, { type: "delete_issue", id: args.id });
  deleteIssueById(tx, args.id, ctx);
  checkWorkflow(tx, [args.id]);
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
  validateIssue(tx, next, current.sprint_id);
  next.updated_at = ctx.at;
  tx.put("issues", next);
}

export const restoreIssue: Mutator<ArgsOf<"restore_issue">> = (tx, args, ctx) => {
  requireRole(tx, ctx.actor, "restore_issue", args);
  checkOwnership(tx, { type: "restore_issue", id: args.id });
  restoreIssueById(tx, args.id, ctx);
  checkWorkflow(tx, [args.id]);
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
  checkImportedForSave(current);
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
  checkWorkflow(tx, [args.id]);
};

/** Shared by `unarchive_issue` and the bulk unarchive action. Unarchiving restarts the done clock. */
function unarchiveIssueById(tx: Tx, id: string, ctx: MutatorContext): void {
  const current = requireIssue(tx, id);
  if (current.deleted_at !== null) throw new MutationError(404, "not found");
  if (current.archived_at === null) {
    if (ctx.mode === "replay") return;
    throw new MutationError(400, "issue is not archived");
  }
  checkImportedForSave(current);
  const next = copyIssue(current);
  next.archived_at = null;
  next.done_at = doneAt(tx, next.team_id, next.stage_id, null, ctx.at);
  next.updated_at = ctx.at;
  tx.put("issues", next);
}

export const unarchiveIssue: Mutator<ArgsOf<"unarchive_issue">> = (tx, args, ctx) => {
  requireRole(tx, ctx.actor, "unarchive_issue", args);
  unarchiveIssueById(tx, args.id, ctx);
  checkWorkflow(tx, [args.id]);
};

export const bulkIssues: Mutator<ArgsOf<"bulk_issues">> = (tx, args, ctx) => {
  requireRole(tx, ctx.actor, "bulk_issues", args);
  checkOwnership(tx, { type: "bulk_issues", ids: args.ids, action: args.action });
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
  checkWorkflow(tx, sorted);
};

export const followIssue: Mutator<ArgsOf<"follow">> = (tx, args, ctx) => {
  requireRole(tx, ctx.actor, "follow", args);
  const current = requireLiveIssue(tx, args.issue_id);
  const following = current.followers.includes(ctx.actor);
  if (following === args.following) return;
  update(tx, "issues", args.issue_id, (issue) => {
    const next = copyIssue(issue);
    next.followers = args.following
      ? dedupeSortUuids([...issue.followers, ctx.actor])
      : dedupeSortUuids(issue.followers.filter((follower: Id) => follower !== ctx.actor));
    return next;
  });
  checkWorkflow(tx, [args.issue_id]);
};

export const addSourceLink: Mutator<ArgsOf<"add_source_link">> = (tx, args, ctx) => {
  requireRole(tx, ctx.actor, "add_source_link", args);
  checkOwnership(tx, {
    type: "add_source_link",
    issue_id: args.issue_id,
    url: args.url,
    title: args.title,
  });
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
  checkWorkflow(tx, [args.issue_id]);
};

export const removeAttachment: Mutator<ArgsOf<"remove_attachment">> = (tx, args, ctx) => {
  requireRole(tx, ctx.actor, "remove_attachment", args);
  checkOwnership(tx, {
    type: "remove_attachment",
    issue_id: args.issue_id,
    attachment_id: args.attachment_id,
  });
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
  checkWorkflow(tx, [args.issue_id]);
};
