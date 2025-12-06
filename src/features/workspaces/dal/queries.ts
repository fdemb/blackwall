import { db, dbSchema } from "@/db";
import type { User } from "@/db/schema";
import { AppError } from "@/features/shared/errors";
import { and, eq } from "drizzle-orm";

export const WorkspaceQueries = {
  getForUser: async (input: { user: User; slug: string }) => {
    const [workspace] = await db
      .select()
      .from(dbSchema.workspace)
      .innerJoin(
        dbSchema.workspaceUser,
        eq(dbSchema.workspace.id, dbSchema.workspaceUser.workspaceId),
      )
      .where(
        and(
          eq(dbSchema.workspace.slug, input.slug),
          eq(dbSchema.workspaceUser.userId, input.user.id),
        ),
      )
      .limit(1);

    if (!workspace?.workspace) {
      throw new AppError("NOT_FOUND", "Workspace not found.");
    }

    return workspace.workspace;
  },

  getForUserById: async (input: { user: User; workspaceId: string }) => {
    const [workspace] = await db
      .select()
      .from(dbSchema.workspace)
      .innerJoin(
        dbSchema.workspaceUser,
        eq(dbSchema.workspace.id, dbSchema.workspaceUser.workspaceId),
      )
      .where(
        and(
          eq(dbSchema.workspace.id, input.workspaceId),
          eq(dbSchema.workspaceUser.userId, input.user.id),
        ),
      )
      .limit(1);

    if (!workspace?.workspace) {
      throw new AppError("NOT_FOUND", "Workspace not found.");
    }

    return workspace.workspace;
  },

  getBySlug: async (slug: string) => {
    const [workspace] = await db
      .select()
      .from(dbSchema.workspace)
      .where(eq(dbSchema.workspace.slug, slug))
      .limit(1);

    if (!workspace) {
      throw new AppError("NOT_FOUND", "Workspace not found.");
    }

    return workspace;
  },

  getFirstForUser: async (user: User) => {
    const [workspace] = await db
      .select()
      .from(dbSchema.workspace)
      .innerJoin(
        dbSchema.workspaceUser,
        eq(dbSchema.workspace.id, dbSchema.workspaceUser.workspaceId),
      )
      .where(eq(dbSchema.workspaceUser.userId, user.id))
      .limit(1);

    return workspace?.workspace;
  },

  getPreferredForUser: async (user: User) => {
    if (!user.lastWorkspaceId) {
      return await WorkspaceQueries.getFirstForUser(user);
    }

    const [lastWorkspace] = await db
      .select()
      .from(dbSchema.workspace)
      .where(eq(dbSchema.workspace.id, user.lastWorkspaceId));

    if (!lastWorkspace) {
      return await WorkspaceQueries.getFirstForUser(user);
    }

    return lastWorkspace;
  },

  listForUser: async (user: User) => {
    const workspaces = await db
      .select()
      .from(dbSchema.workspace)
      .innerJoin(
        dbSchema.workspaceUser,
        eq(dbSchema.workspace.id, dbSchema.workspaceUser.workspaceId),
      )
      .where(eq(dbSchema.workspaceUser.userId, user.id));

    return workspaces.map((w) => w.workspace);
  },

  fetchInvitationByToken: async (token: string) => {
    const [invitation] = await db
      .select()
      .from(dbSchema.workspaceInvitation)
      .where(eq(dbSchema.workspaceInvitation.token, token))
      .limit(1);

    if (!invitation) {
      throw new AppError("NOT_FOUND", "Invitation not found.");
    }

    return invitation;
  },
};
