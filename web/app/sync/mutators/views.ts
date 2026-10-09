import type { ArgsOf, Mutator } from "./common";
import { NIL_UUID, checkText, checkTimestamp, requireAuthorOrAdmin, requireRole } from "./common";
import { MutationError } from "./errors";

export const saveView: Mutator<ArgsOf<"save_view">> = (tx, args, ctx) => {
  requireRole(tx, ctx.actor, "save_view", args);
  // Order mirrors `discussion::SaveView`: name, filter timestamp, id.
  checkText(args.name, 200);
  checkTimestamp(args.filter.due_before);
  const id = args.id ?? null;
  if (id === null) throw new MutationError(400, "id is required");
  if (id === NIL_UUID) throw new MutationError(400, "id must not be nil");
  // Creates are upserts: a replay over a base that already holds the id
  // keeps its version, as for created issues.
  const previous = tx.get("views", id);
  tx.put("views", {
    id,
    version: previous?.version ?? 1,
    owner: ctx.actor,
    name: args.name,
    shared: args.shared,
    filter: { ...args.filter },
  });
};

export const updateView: Mutator<ArgsOf<"update_view">> = (tx, args, ctx) => {
  requireRole(tx, ctx.actor, "update_view", args);
  // Order mirrors `discussion::UpdateView`: validation, the owner lookup and
  // its author check. A viewer reaching this point only holds a private view:
  // `requireRole` already rejected sharing one, as the server's viewer rule
  // would, with the same 403.
  checkText(args.name, 200);
  checkTimestamp(args.filter.due_before);
  const view = tx.get("views", args.id);
  if (view === undefined) throw new MutationError(404, "not found");
  requireAuthorOrAdmin(tx, ctx.actor, view.owner);
  tx.put("views", {
    ...view,
    name: args.name,
    shared: args.shared,
    filter: { ...args.filter },
  });
};

export const deleteView: Mutator<ArgsOf<"delete_view">> = (tx, args, ctx) => {
  requireRole(tx, ctx.actor, "delete_view", args);
  const view = tx.get("views", args.id);
  // A replay over a base that already dropped the view is a no-op, as for
  // deleted comments; admission against that view fails as on the server.
  if (view === undefined) {
    if (ctx.mode === "replay") return;
    throw new MutationError(404, "not found");
  }
  requireAuthorOrAdmin(tx, ctx.actor, view.owner);
  tx.delete("views", args.id);
};
