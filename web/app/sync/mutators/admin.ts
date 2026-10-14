import type { ArgsOf, Mutator } from "./common";
import { requireAdmin, requireRecord, requireRole } from "./common";
import { MutationError } from "./errors";

export const cancelInvitation: Mutator<ArgsOf<"cancel_invitation">> = (tx, args, ctx) => {
  requireAdmin(requireRole(tx, ctx.actor, "cancel_invitation", args));
  // Order mirrors `discussion::CancelInvitation`: the lookup, then the
  // accepted check. Cancelling a cancelled or expired invitation succeeds on
  // the server, so setting the same values is naturally a no-op in replay.
  const invitation = requireRecord(tx, "invitations", args.id);
  if (invitation.state === "accepted") {
    throw new MutationError(409, "invitation already accepted");
  }
  tx.put("invitations", { ...invitation, state: "cancelled", token_hash: "" });
};

export const updateIntegration: Mutator<ArgsOf<"update_integration">> = (tx, args, ctx) => {
  requireAdmin(requireRole(tx, ctx.actor, "update_integration", args));
  const integration = requireRecord(tx, "integrations", args.id);
  tx.put("integrations", { ...integration, enabled: args.enabled });
};

export const deleteIntegration: Mutator<ArgsOf<"delete_integration">> = (tx, args, ctx) => {
  requireAdmin(requireRole(tx, ctx.actor, "delete_integration", args));
  // A replay over a base that already dropped the integration is a no-op, as
  // for deleted views; admission against that view fails as on the server.
  if (tx.get("integrations", args.id) === undefined) {
    if (ctx.mode === "replay") return;
    throw new MutationError(404, "not found");
  }
  tx.delete("integrations", args.id);
};
