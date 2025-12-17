import { db, dbSchema } from "@/db";
import type { User, Workspace } from "@/db/schema";
import { AppError } from "@/features/shared/errors";
import { add } from "date-fns";
import { eq } from "drizzle-orm";
import { randomBytes } from "node:crypto";

async function create(input: {
  workspace: Workspace;
  user: User;
  email: string;
}) {
  const [invitation] = await db
    .insert(dbSchema.workspaceInvitation)
    .values({
      workspaceId: input.workspace.id,
      createdById: input.user.id,
      token: generateInviteCode(),
      email: input.email,
      expiresAt: add(new Date(), {
        days: 7,
      }),
    })
    .returning();

  if (!invitation) {
    throw new AppError(
      "INTERNAL_SERVER_ERROR",
      "Invitation couldn't be created",
    );
  }
  return invitation;
}

async function deleteInvitation(invitationId: string) {
  await db
    .delete(dbSchema.workspaceInvitation)
    .where(eq(dbSchema.workspaceInvitation.id, invitationId));
}

export const InvitationMutations = {
  create,
  deleteInvitation,
};

function generateInviteCode(length: number = 8): string {
  return randomBytes(length).toString("base64url").slice(0, length);
}
