import { db, dbSchema } from "@/db";
import { AppError } from "@/features/shared/errors";
import { eq } from "drizzle-orm";

async function fetchByToken(token: string) {
  const invitation = await db.query.workspaceInvitation.findFirst({
    where: eq(dbSchema.workspaceInvitation.token, token),
    with: {
      workspace: true,
    },
  });

  if (
    !invitation ||
    (invitation.expiresAt && invitation.expiresAt < new Date())
  ) {
    throw new AppError("NOT_FOUND", "Invitation not found.");
  }

  return invitation;
}

export const InvitationQueries = {
  fetchByToken,
};
