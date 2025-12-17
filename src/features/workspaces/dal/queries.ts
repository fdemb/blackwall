import { db, dbSchema } from "@/db";
import type { User, Workspace } from "@/db/schema";
import { AppError } from "@/features/shared/errors";
import { and, eq } from "drizzle-orm";

async function getForUser(input: { user: User; slug: string }) {
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
}

async function getForUserById(input: { user: User; workspaceId: string }) {
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
}

async function getBySlug(slug: string) {
  const [workspace] = await db
    .select()
    .from(dbSchema.workspace)
    .where(eq(dbSchema.workspace.slug, slug))
    .limit(1);

  if (!workspace) {
    throw new AppError("NOT_FOUND", "Workspace not found.");
  }

  return workspace;
}

async function getFirstForUser(user: User) {
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
}

async function getPreferredForUser(user: User) {
  if (!user.lastWorkspaceId) {
    return await getFirstForUser(user);
  }

  const [lastWorkspace] = await db
    .select()
    .from(dbSchema.workspace)
    .where(eq(dbSchema.workspace.id, user.lastWorkspaceId));

  if (!lastWorkspace) {
    return await getFirstForUser(user);
  }

  return lastWorkspace;
}

async function listForUser(user: User) {
  const workspaces = await db
    .select()
    .from(dbSchema.workspace)
    .innerJoin(
      dbSchema.workspaceUser,
      eq(dbSchema.workspace.id, dbSchema.workspaceUser.workspaceId),
    )
    .where(eq(dbSchema.workspaceUser.userId, user.id));

  return workspaces.map((w) => w.workspace);
}

async function listUsers(input: { workspace: Workspace }) {
  const workspaceUsers = await db
    .select()
    .from(dbSchema.workspaceUser)
    .leftJoin(
      dbSchema.user,
      eq(dbSchema.workspaceUser.userId, dbSchema.user.id),
    )
    .where(eq(dbSchema.workspaceUser.workspaceId, input.workspace.id));

  return workspaceUsers.filter((wu) => wu.user !== null).map((wu) => wu.user!);
}

export const WorkspaceQueries = {
  getForUser,
  getForUserById,
  getBySlug,
  getFirstForUser,
  getPreferredForUser,
  listForUser,
  listUsers,
};
