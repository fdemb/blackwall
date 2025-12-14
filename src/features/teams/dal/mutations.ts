import { db, dbSchema } from "@/db";
import type { Team, User, Workspace } from "@/db/schema";
import { AppError } from "@/features/shared/errors";
import { and, eq } from "drizzle-orm";
import { initializeSequence } from "../../issues/dal/key-sequences";
import { WorkspaceQueries } from "../../workspaces/dal/queries";
import { TeamQueries } from "./queries";

export type CreateTeamInput = {
  name: string;
  key: string;
  workspaceSlug: string;
};

async function create(input: CreateTeamInput) {
  const workspace = await WorkspaceQueries.getBySlug(input.workspaceSlug);

  const [createdTeam] = await db
    .insert(dbSchema.team)
    .values({
      name: input.name,
      key: input.key,
      workspaceId: workspace.id,
    })
    .returning();

  if (!createdTeam) {
    throw new AppError(
      "INTERNAL_SERVER_ERROR",
      "The team couldn't be created.",
    );
  }

  // Initialize sequence for this workspace/team pair
  await initializeSequence({
    workspaceId: workspace.id,
    teamId: createdTeam.id,
  });

  return createdTeam;
}

async function createBasedOnWorkspace(workspace: Workspace) {
  return create({
    workspaceSlug: workspace.slug,
    key: workspace.displayName.slice(0, 3).toUpperCase(),
    name: workspace.displayName,
  });
}

async function addUser(input: { user: User; team: Team }) {
  await db.insert(dbSchema.userTeam).values({
    teamId: input.team.id,
    userId: input.user.id,
  });
}

async function removeUser(input: {
  user: User;
  workspaceSlug: string;
  teamKey: string;
  userId: string;
}) {
  const team = await TeamQueries.getForUser({
    user: input.user,
    workspaceSlug: input.workspaceSlug,
    teamKey: input.teamKey,
  });

  if (!team) {
    throw new AppError("NOT_FOUND", "Team not found.");
  }

  await db
    .delete(dbSchema.userTeam)
    .where(
      and(
        eq(dbSchema.userTeam.teamId, team.id),
        eq(dbSchema.userTeam.userId, input.userId),
      ),
    );
}

async function update(input: {
  user: User;
  workspaceSlug: string;
  teamKey: string;
  team: { name?: string; key?: string };
}) {
  const team = await TeamQueries.getForUser({
    user: input.user,
    workspaceSlug: input.workspaceSlug,
    teamKey: input.teamKey,
  });

  if (!team) {
    throw new AppError("NOT_FOUND", "Team not found.");
  }

  await db
    .update(dbSchema.team)
    .set({
      name: input.team.name,
      key: input.team.key,
    })
    .where(eq(dbSchema.team.id, team.id));
}

export const TeamMutations = {
  create,
  createBasedOnWorkspace,
  addUser,
  removeUser,
  update,
};
