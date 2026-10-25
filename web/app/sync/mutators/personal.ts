import type { RecordOf } from "../records";
import { parseTimestamp } from "../records";
import type { DeepReadonly, Tx } from "../store";
import type { ArgsOf, Mutator, MutatorContext } from "./common";
import { requireRole } from "./common";
import { MutationError } from "./errors";

export const markNotificationRead: Mutator<ArgsOf<"mark_notification_read">> = (tx, args, ctx) => {
  requireRole(tx, ctx.actor, "mark_notification_read", args);
  const notification = tx.get("notifications", args.id);
  if (notification === undefined || notification.user_id !== ctx.actor) {
    // A replay over a base that already dropped the notification is a no-op;
    // admission against that view fails as on the server.
    if (ctx.mode === "replay") return;
    throw new MutationError(404, "not found");
  }
  markSeenRead(tx, ctx, notification, args.created_at);
};

export const markNotificationUnread: Mutator<ArgsOf<"mark_notification_unread">> = (
  tx,
  args,
  ctx,
) => {
  requireRole(tx, ctx.actor, "mark_notification_unread", args);
  const notification = tx.get("notifications", args.id);
  if (notification === undefined || notification.user_id !== ctx.actor) {
    if (ctx.mode === "replay") return;
    throw new MutationError(404, "not found");
  }
  if (ctx.mode === "replay" && notification.read_at === null) return;
  tx.put("notifications", { ...notification, read_at: null });
};

export const markAllNotificationsRead: Mutator<ArgsOf<"mark_all_notifications_read">> = (
  tx,
  args,
  ctx,
) => {
  requireRole(tx, ctx.actor, "mark_all_notifications_read", args);
  if (args.notifications === undefined) {
    for (const notification of tx.all("notifications")) {
      if (notification.user_id === ctx.actor) markSeenRead(tx, ctx, notification, undefined);
    }
    return;
  }
  for (const seen of args.notifications) {
    const notification = tx.get("notifications", seen.id);
    if (notification?.user_id === ctx.actor) markSeenRead(tx, ctx, notification, seen.created_at);
  }
};

/**
 * Reads the notification only while it is unread and unchanged since the
 * reader saw it, as the server does. A change notification bumped after that
 * keeps its newer `created_at` and stays unread. Without a `created_at`, from
 * an older client, any unread notification is read.
 */
function markSeenRead(
  tx: Tx,
  ctx: MutatorContext,
  notification: DeepReadonly<RecordOf["notifications"]>,
  createdAt: string | undefined,
): void {
  if (notification.read_at !== null) return;
  if (createdAt !== undefined && notification.created_at !== parseTimestamp(createdAt)) return;
  tx.put("notifications", { ...notification, read_at: ctx.at });
}

export const configureAlerts: Mutator<ArgsOf<"configure_alerts">> = (tx, args, ctx) => {
  requireRole(tx, ctx.actor, "configure_alerts", args);
  // An upsert keyed by user, mirroring the server's `ON CONFLICT DO UPDATE`.
  const previous = tx.get("alert_preferences", ctx.actor);
  tx.put("alert_preferences", {
    user_id: ctx.actor,
    version: previous?.version ?? 1,
    assignment: args.assignment,
    reply: args.reply,
    change: args.change,
    mention: args.mention,
    deadline: args.deadline,
    email_assignment: args.email_assignment,
    email_reply: args.email_reply,
    email_change: args.email_change,
    email_mention: args.email_mention,
    email_deadline: args.email_deadline,
  });
};
