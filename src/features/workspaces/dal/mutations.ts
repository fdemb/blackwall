import { db, dbSchema } from "@/db";
import type { User } from "@/db/schema";
import { AppError } from "@/features/shared/errors";
import { add } from "date-fns";
import { and, eq } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { WorkspaceQueries } from "./queries";

type CreateWorkspaceInput = {
  slug: string;
  displayName: string;
};

function generateInviteCode(length: number = 8): string {
  return randomBytes(length).toString("base64url").slice(0, length);
}

export const WorkspaceMutations = {
  create: async (input: CreateWorkspaceInput) => {
    const [result] = await db
      .insert(dbSchema.workspace)
      .values({
        displayName: input.displayName,
        slug: input.slug,
      })
      .returning();

    if (!result) {
      throw new AppError(
        "INTERNAL_SERVER_ERROR",
        "Workspace couldn't be created",
      );
    }

    return result;
  },

  createAndAddUser: async (input: {
    input: CreateWorkspaceInput;
    userId: string;
  }) => {
    const workspace = await WorkspaceMutations.create({
      displayName: input.input.displayName,
      slug: input.input.slug,
    });
    await db.insert(dbSchema.workspaceUser).values({
      userId: input.userId,
      workspaceId: workspace.id,
    });
    await db
      .update(dbSchema.user)
      .set({ lastWorkspaceId: workspace.id })
      .where(eq(dbSchema.user.id, input.userId));
    return workspace;
  },

  addUser: async (input: { workspaceSlug: string; userId: string }) => {
    // Find workspace by slug to get its ID
    const [workspace] = await db
      .select()
      .from(dbSchema.workspace)
      .where(eq(dbSchema.workspace.slug, input.workspaceSlug))
      .limit(1);

    if (!workspace) {
      throw new AppError("NOT_FOUND", "Workspace not found");
    }

    const [existing] = await db
      .select()
      .from(dbSchema.workspaceUser)
      .where(
        and(
          eq(dbSchema.workspaceUser.userId, input.userId),
          eq(dbSchema.workspaceUser.workspaceId, workspace.id),
        ),
      );
    if (existing) {
      return existing;
    }
    const [result] = await db
      .insert(dbSchema.workspaceUser)
      .values({
        userId: input.userId,
        workspaceId: workspace.id,
      })
      .returning();

    if (!result) {
      throw new AppError(
        "INTERNAL_SERVER_ERROR",
        "User couldn't be added to workspace",
      );
    }
    return result;
  },
  saveLastForUser: async (input: { user: User; workspaceId: string }) => {
    await db
      .update(dbSchema.user)
      .set({ lastWorkspaceId: input.workspaceId })
      .where(eq(dbSchema.user.id, input.user.id));
  },
  createInvitation: async (input: { workspaceId: string; user: User }) => {
    // checks for access to the workspace
    const _ = await WorkspaceQueries.getForUserById(input);

    const [invitation] = await db
      .insert(dbSchema.workspaceInvitation)
      .values({
        workspaceId: input.workspaceId,
        createdById: input.user.id,
        token: generateInviteCode(),
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

    const invitationUrl = `${process.env.APP_URL}/invite/${invitation.token}`;

    return {
      invitation,
      invitationUrl,
    };
  },
};
