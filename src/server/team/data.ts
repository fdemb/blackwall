import { db, dbSchema } from "@/db";
import type { Team, User, Workspace } from "@/db/schema";
import { initializeSequence } from "@/server/issues/key-sequences";
import { AppError } from "@/server/shared/errors";
import { getWorkspaceBySlug } from "@/server/workspace/data";
import { and, count, eq, notInArray } from "drizzle-orm";

export type CreateTeamInput = {
  name: string;
  key: string;
  workspaceSlug: string;
};

// Query functions

export async function getTeamForUser(input: {
  user: User;
  workspaceSlug: string;
  teamKey: string;
}) {
  const workspace = await getWorkspaceBySlug(input.workspaceSlug);

  const [team] = await db
    .select()
    .from(dbSchema.team)
    .where(
      and(
        eq(dbSchema.team.workspaceId, workspace.id),
        eq(dbSchema.team.key, input.teamKey),
      ),
    );

  if (!team) {
    throw new AppError("NOT_FOUND", "Team not found.");
  }

  // Check if user is a member of this team
  const [result] = await db
    .select()
    .from(dbSchema.userTeam)
    .where(
      and(
        eq(dbSchema.userTeam.teamId, team.id),
        eq(dbSchema.userTeam.userId, input.user.id),
      ),
    );

  if (!result) {
    throw new AppError("NOT_FOUND", "Team not found.");
  }

  return team;
}

export async function listTeamsForUser(input: {
  user: User;
  workspaceId: string;
}) {
  const usersCount = db
    .select({
      teamId: dbSchema.userTeam.teamId,
      count: count().as("users_count"),
    })
    .from(dbSchema.userTeam)
    .groupBy(dbSchema.userTeam.teamId)
    .as("users_count_sq");

  const issuesCount = db
    .select({
      teamId: dbSchema.issue.teamId,
      count: count().as("issues_count"),
    })
    .from(dbSchema.issue)
    .groupBy(dbSchema.issue.teamId)
    .as("issues_count_sq");

  const results = await db
    .select()
    .from(dbSchema.userTeam)
    .leftJoin(dbSchema.team, eq(dbSchema.userTeam.teamId, dbSchema.team.id))
    .leftJoin(usersCount, eq(dbSchema.userTeam.teamId, usersCount.teamId))
    .leftJoin(issuesCount, eq(dbSchema.team.id, issuesCount.teamId))
    .where(
      and(
        eq(dbSchema.team.workspaceId, input.workspaceId),
        eq(dbSchema.userTeam.userId, input.user.id),
      ),
    );

  return results
    .filter((result) => result.team !== null)
    .map((result) => ({
      team: result.team!,
      usersCount: result.users_count_sq?.count ?? 0,
      issuesCount: result.issues_count_sq?.count ?? 0,
    }));
}

export async function listAllTeamsForUser(input: {
  user: User;
  workspaceId: string;
}) {
  return await db
    .select()
    .from(dbSchema.team)
    .where(eq(dbSchema.team.workspaceId, input.workspaceId));
}

export async function listTeamUsers(input: {
  user: User;
  workspaceSlug: string;
  teamKey: string;
}) {
  const workspace = await getWorkspaceBySlug(input.workspaceSlug);

  const result = await db.query.team.findFirst({
    where: (t, { eq, and }) =>
      and(eq(t.key, input.teamKey), eq(t.workspaceId, workspace.id)),
    with: {
      userTeams: {
        with: {
          user: true,
        },
      },
    },
  });

  const users = result?.userTeams.map((userTeam) => userTeam.user) ?? [];

  if (!users.find((u) => u.id === input.user.id)) {
    throw new AppError(
      "FORBIDDEN",
      "You don't have permission to access this resource.",
    );
  }

  return users;
}

export async function getFullTeam(input: {
  user: User;
  workspaceSlug: string;
  teamKey: string;
}) {
  const team = await getTeamForUser(input);
  return team;
}

export async function listRemainingTeamUsers(input: {
  user: User;
  workspaceSlug: string;
  teamKey: string;
}) {
  const workspace = await getWorkspaceBySlug(input.workspaceSlug);

  const team = await getTeamForUser({
    user: input.user,
    workspaceSlug: input.workspaceSlug,
    teamKey: input.teamKey,
  });

  if (!team) {
    throw new AppError(
      "FORBIDDEN",
      "You don't have permission to access this resource.",
    );
  }

  const teamMembers = await db
    .select({ userId: dbSchema.userTeam.userId })
    .from(dbSchema.userTeam)
    .where(eq(dbSchema.userTeam.teamId, team.id));

  const teamMemberIds = teamMembers.map((m) => m.userId);

  const workspaceUsers = await db
    .select()
    .from(dbSchema.user)
    .innerJoin(
      dbSchema.workspaceUser,
      eq(dbSchema.user.id, dbSchema.workspaceUser.userId),
    )
    .where(
      and(
        eq(dbSchema.workspaceUser.workspaceId, workspace.id),
        teamMemberIds.length > 0
          ? notInArray(dbSchema.user.id, teamMemberIds)
          : undefined,
      ),
    );

  return workspaceUsers.map((wu) => wu.user);
}

// Mutation functions

export async function createTeam(input: CreateTeamInput) {
  const workspace = await getWorkspaceBySlug(input.workspaceSlug);

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

export async function createTeamBasedOnWorkspace(workspace: Workspace) {
  return createTeam({
    workspaceSlug: workspace.slug,
    key: workspace.displayName.slice(0, 3).toUpperCase(),
    name: workspace.displayName,
  });
}

export async function addUserToTeam(input: { user: User; team: Team }) {
  await db.insert(dbSchema.userTeam).values({
    teamId: input.team.id,
    userId: input.user.id,
  });
}

export async function removeUserFromTeam(input: {
  user: User;
  workspaceSlug: string;
  teamKey: string;
  userId: string;
}) {
  const team = await getTeamForUser({
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

export async function updateTeam(input: {
  user: User;
  workspaceSlug: string;
  teamKey: string;
  team: { name?: string; key?: string };
}) {
  const team = await getTeamForUser({
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
