import { db, dbSchema } from "@/db";
import type { User, Workspace } from "@/db/schema";
import { AppError } from "@/server/shared/errors";
import { and, eq } from "drizzle-orm";

export type CreateWorkspaceInput = {
  slug: string;
  displayName: string;
};

// Query functions

export async function getWorkspaceForUser(input: { user: User; slug: string }) {
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

export async function getWorkspaceForUserById(input: {
  user: User;
  workspaceId: string;
}) {
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

export async function getWorkspaceBySlug(slug: string) {
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

export async function getFirstWorkspaceForUser(user: User) {
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

export async function getPreferredWorkspaceForUser(user: User) {
  if (!user.lastWorkspaceId) {
    return await getFirstWorkspaceForUser(user);
  }

  const [lastWorkspace] = await db
    .select()
    .from(dbSchema.workspace)
    .where(eq(dbSchema.workspace.id, user.lastWorkspaceId));

  if (!lastWorkspace) {
    return await getFirstWorkspaceForUser(user);
  }

  return lastWorkspace;
}

export async function listWorkspacesForUser(user: User) {
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

export async function listWorkspaceUsers(input: { workspace: Workspace }) {
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

// Mutation functions

export async function createWorkspace(input: CreateWorkspaceInput) {
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
}

export async function createWorkspaceAndAddUser(input: {
  input: CreateWorkspaceInput;
  userId: string;
}) {
  const workspace = await createWorkspace({
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
}

export async function addUserToWorkspace(input: {
  workspaceSlug: string;
  userId: string;
}) {
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
}

export async function saveLastWorkspaceForUser(input: {
  user: User;
  workspaceId: string;
}) {
  await db
    .update(dbSchema.user)
    .set({ lastWorkspaceId: input.workspaceId })
    .where(eq(dbSchema.user.id, input.user.id));
}

export async function updateWorkspaceDisplayName(input: {
  workspaceId: string;
  displayName: string;
}) {
  const [result] = await db
    .update(dbSchema.workspace)
    .set({ displayName: input.displayName })
    .where(eq(dbSchema.workspace.id, input.workspaceId))
    .returning();

  if (!result) {
    throw new AppError(
      "INTERNAL_SERVER_ERROR",
      "Workspace name couldn't be updated",
    );
  }

  return result;
}
