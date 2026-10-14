import type { ArgsOf, Mutator } from "./common";
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
  // Marking an already-read notification is a replay no-op, so rebasing over
  // the server's confirmation never regresses the timestamp.
  if (ctx.mode === "replay" && notification.read_at !== null) return;
  tx.put("notifications", { ...notification, read_at: ctx.at });
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
  // Admission fixes the set of unread ids. Replay must never expand it to
  // notifications created after the server applied this command.
  const targets =
    ctx.mode === "replay"
      ? admittedIds(ctx.local).map((id) => tx.get("notifications", id))
      : tx.all("notifications");
  type Target = (typeof targets)[number];
  const isUnread = (notification: Target): notification is NonNullable<Target> =>
    notification !== undefined &&
    notification.user_id === ctx.actor &&
    notification.read_at === null;
  const ids: string[] = [];
  for (const notification of targets.filter(isUnread)) {
    tx.put("notifications", { ...notification, read_at: ctx.at });
    ids.push(notification.id);
  }
  return ctx.mode === "replay" ? undefined : { ids };
};

/** The unread ids captured at admission, from the pending mutation's local data. */
function admittedIds(local: unknown): string[] {
  if (
    typeof local !== "object" ||
    local === null ||
    !("ids" in local) ||
    !Array.isArray(local.ids)
  ) {
    throw new MutationError(400, "mark all read requires local.ids");
  }
  return local.ids.filter((id): id is string => typeof id === "string");
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
  });
};
