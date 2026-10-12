import type { ArgsOf, Mutator } from "./common";
import { checkText, requireAuthorOrAdmin, requireRole, reserveClientId } from "./common";
import { MutationError } from "./errors";
import { ApiError } from "../../lib/api";
import { compileFilter } from "../../lib/issue-filter";
import type { IssueFilter } from "../../lib/types";

/** `IssueFilter::validate`: the clause checks of src/domain/filter.rs with its messages. */
function checkFilter(filter: IssueFilter): void {
  try {
    compileFilter(filter.where);
  } catch (error) {
    if (error instanceof ApiError) throw new MutationError(error.status, error.message);
    throw error;
  }
}

export const saveView: Mutator<ArgsOf<"save_view">> = (tx, args, ctx) => {
  requireRole(tx, ctx.actor, "save_view", args);
  // Order mirrors `discussion::SaveView`: name, filter, id. The filter is
  // already canonical (`normalizeArgs`): defaults filled, as the server stores it.
  checkText(args.name, 200);
  checkFilter(args.filter);
  const id = reserveClientId(tx, args.id, ctx);
  // Replay over a base that already holds the id keeps its version.
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
  // would, with the same 403. The filter is already canonical (`normalizeArgs`).
  checkText(args.name, 200);
  checkFilter(args.filter);
  const view = tx.get("views", args.id);
  // A replay over a base that already dropped the view is a no-op, as for
  // deleted views; admission against that view fails as on the server.
  if (view === undefined) {
    if (ctx.mode === "replay") return;
    throw new MutationError(404, "not found");
  }
  requireAuthorOrAdmin(tx, ctx.actor, view.owner);
  // Unsharing another owner's view hides it from the actor (the server's
  // visibility rule in `src/store/reads.rs:push_visibility`); predict the
  // deletion the pull will render instead of an invisible record.
  if (args.shared === false && view.owner !== ctx.actor) {
    tx.delete("views", args.id);
    return;
  }
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
