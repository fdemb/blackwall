import { db, dbSchema } from "@/db";
import type { Team, User, Workspace } from "@/db/schema";
import { AppError } from "@/features/shared/errors";
import { eq } from "drizzle-orm";
import { initializeSequence } from "../../issues/dal/key-sequences";
import { WorkspaceQueries } from "../../workspaces/dal/queries";
import { TeamQueries } from "./queries";

export type CreateTeamInput = {
  name: string;
  key: string;
  workspaceSlug: string;
};

export const TeamMutations = {
  create: async (input: CreateTeamInput) => {
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
  },

  createBasedOnWorkspace: async (workspace: Workspace) => {
    return TeamMutations.create({
      workspaceSlug: workspace.slug,
      key: workspace.displayName.slice(0, 3).toUpperCase(),
      name: workspace.displayName,
    });
  },

  addUser: async (input: { user: User; team: Team }) => {
    await db.insert(dbSchema.userTeam).values({
      teamId: input.team.id,
      userId: input.user.id,
    });
  },

  update: async (input: {
    user: User;
    workspaceSlug: string;
    teamKey: string;
    team: { name?: string; key?: string };
  }) => {
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
  },
};
