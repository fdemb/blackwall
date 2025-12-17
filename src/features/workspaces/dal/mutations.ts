import { db, dbSchema } from "@/db";
import type { User } from "@/db/schema";
import { AppError } from "@/features/shared/errors";
import { and, eq } from "drizzle-orm";

type CreateWorkspaceInput = {
  slug: string;
  displayName: string;
};

async function create(input: CreateWorkspaceInput) {
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

async function createAndAddUser(input: {
  input: CreateWorkspaceInput;
  userId: string;
}) {
  const workspace = await create({
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

async function addUser(input: { workspaceSlug: string; userId: string }) {
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

async function saveLastForUser(input: { user: User; workspaceId: string }) {
  await db
    .update(dbSchema.user)
    .set({ lastWorkspaceId: input.workspaceId })
    .where(eq(dbSchema.user.id, input.user.id));
}

async function updateDisplayName(input: {
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

export const WorkspaceMutations = {
  create,
  createAndAddUser,
  addUser,
  saveLastForUser,
  updateDisplayName,
};
