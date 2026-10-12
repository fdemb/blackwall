import type { DeepReadonly, Tx } from "../store";
import type { ArgsOf, Mutator } from "./common";
import {
  checkCreateId,
  checkCapacity,
  checkText,
  checkTimestamp,
  dedupeSortUuids,
  requireAuthorOrAdmin,
  requireMember,
  requireRole,
  requireTimestamp,
  utf8Length,
  reserveClientId,
  requireClientId,
} from "./common";
import { MutationError } from "./errors";
import type { Attachment, Comment } from "../../lib/types";
import type { SyncIssue } from "../records";

/** The issue must exist and be untrashed (`discussion::discussion_issue`). Archived issues may be discussed. */
function requireDiscussionIssue(tx: Tx, issueId: string): DeepReadonly<SyncIssue> {
  const issue = tx.get("issues", issueId);
  if (issue === undefined || issue.deleted_at !== null) {
    throw new MutationError(404, "not found");
  }
  return issue;
}

/** `discussion::validate_time`: minutes and note byte length share one message. */
function checkTime(minutes: number, note: string): void {
  if (
    !Number.isInteger(minutes) ||
    minutes <= 0 ||
    minutes > 24 * 60 ||
    utf8Length(note) > 10_000
  ) {
    throw new MutationError(400, "time entry must contain 1 to 1440 minutes");
  }
}

function requireComment(tx: Tx, id: string): DeepReadonly<Comment> {
  const comment = tx.get("comments", id);
  if (comment === undefined) throw new MutationError(404, "not found");
  return comment;
}

/**
 * Splits the issue's attachments into the ones the comment claims, sorted by
 * id, and the ones the issue keeps. `carried` are the comment's own
 * attachments on replay.
 */
function claimAttachments(
  onIssue: readonly DeepReadonly<Attachment>[],
  carried: readonly DeepReadonly<Attachment>[],
  claimed: readonly { id: string }[],
): { moved: Attachment[]; remaining: Attachment[] } {
  const remaining = new Map(onIssue.map((attachment) => [attachment.id, attachment]));
  const replayed = new Map(carried.map((attachment) => [attachment.id, attachment]));
  const seen = new Set<string>();
  const moved: Attachment[] = [];
  for (const { id } of claimed) {
    const stored = seen.has(id) ? undefined : (remaining.get(id) ?? replayed.get(id));
    if (stored === undefined) {
      throw new MutationError(400, "attachment must be uploaded to this issue first");
    }
    seen.add(id);
    remaining.delete(id);
    moved.push({ ...stored });
  }
  moved.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { moved, remaining: [...remaining.values()].map((attachment) => ({ ...attachment })) };
}

export const addComment: Mutator<ArgsOf<"add_comment">> = (tx, args, ctx) => {
  requireRole(tx, ctx.actor, "add_comment", args);
  // Order mirrors `discussion::AddComment`: the issue, the body, the
  // mentions, then the client id.
  const issue = requireDiscussionIssue(tx, args.issue_id);
  checkText(args.body, 100_000);
  const mentions = dedupeSortUuids(args.mentions);
  for (const user of mentions) requireMember(tx, user);
  const id = reserveClientId(tx, args.id, ctx);
  // The server moves the attachments from the issue to the comment, keeping
  // the stored upload metadata ordered by attachment id. An id that is not on
  // the issue fails as on the server. A replay over a base that already holds
  // the comment reads the metadata back from the comment itself, so running
  // twice gives the same view as running once.
  const previous = tx.get("comments", id);
  const { moved, remaining } = claimAttachments(
    issue.attachments,
    previous?.attachments ?? [],
    args.attachments,
  );
  if (moved.length > 0) {
    tx.put("issues", { ...issue, attachments: remaining });
  }
  // Replay over a base that already holds the id keeps its version and creation time.
  tx.put("comments", {
    id,
    version: previous?.version ?? 1,
    issue_id: args.issue_id,
    author: ctx.actor,
    body: args.body,
    mentions,
    attachments: moved,
    created_at: previous?.created_at ?? ctx.at,
    edited_at: null,
  });
};

export const editComment: Mutator<ArgsOf<"edit_comment">> = (tx, args, ctx) => {
  requireRole(tx, ctx.actor, "edit_comment", args);
  // Order mirrors `discussion::EditComment`: the body, the record and its
  // author check, then the mentions. The issue itself is unchecked, so
  // comments on trashed issues stay editable, as on the server.
  checkText(args.body, 100_000);
  const comment = requireComment(tx, args.id);
  requireAuthorOrAdmin(tx, ctx.actor, comment.author);
  const mentions = dedupeSortUuids(args.mentions);
  for (const user of mentions) requireMember(tx, user);
  tx.put("comments", { ...comment, body: args.body, mentions, edited_at: ctx.at });
};

export const deleteComment: Mutator<ArgsOf<"delete_comment">> = (tx, args, ctx) => {
  requireRole(tx, ctx.actor, "delete_comment", args);
  const comment = tx.get("comments", args.id);
  // A replay over a base that already dropped the comment is a no-op, as for
  // deleted issues; admission against that view fails as on the server.
  if (comment === undefined) {
    if (ctx.mode === "replay") return;
    throw new MutationError(404, "not found");
  }
  requireAuthorOrAdmin(tx, ctx.actor, comment.author);
  tx.delete("comments", args.id);
};

export const logTime: Mutator<ArgsOf<"log_time">> = (tx, args, ctx) => {
  requireRole(tx, ctx.actor, "log_time", args);
  // Order mirrors `discussion::LogTime`: the issue, the minutes and note,
  // the timestamp, then the client id.
  requireDiscussionIssue(tx, args.issue_id);
  checkTime(args.minutes, args.note);
  checkTimestamp(args.logged_at);
  const id = requireClientId(args.id);
  checkCapacity(tx, "time_entries", 20_000, ctx, id);
  checkCreateId(tx, id, ctx);
  const previous = tx.get("time_entries", id);
  tx.put("time_entries", {
    id,
    version: previous?.version ?? 1,
    issue_id: args.issue_id,
    user_id: ctx.actor,
    minutes: args.minutes,
    note: args.note,
    logged_at: args.logged_at,
  });
};

export const updateTime: Mutator<ArgsOf<"update_time">> = (tx, args, ctx) => {
  requireRole(tx, ctx.actor, "update_time", args);
  // Order mirrors `discussion::UpdateTime`: validation before the lookup.
  checkTime(args.minutes, args.note);
  requireTimestamp(args.logged_at);
  const entry = tx.get("time_entries", args.id);
  if (entry === undefined) throw new MutationError(404, "not found");
  requireAuthorOrAdmin(tx, ctx.actor, entry.user_id);
  tx.put("time_entries", {
    ...entry,
    minutes: args.minutes,
    note: args.note,
    logged_at: args.logged_at,
  });
};

export const deleteTime: Mutator<ArgsOf<"delete_time">> = (tx, args, ctx) => {
  requireRole(tx, ctx.actor, "delete_time", args);
  const entry = tx.get("time_entries", args.id);
  // A replay over a base that already dropped the entry is a no-op, as for
  // deleted comments; admission against that view fails as on the server.
  if (entry === undefined) {
    if (ctx.mode === "replay") return;
    throw new MutationError(404, "not found");
  }
  requireAuthorOrAdmin(tx, ctx.actor, entry.user_id);
  tx.delete("time_entries", args.id);
};
