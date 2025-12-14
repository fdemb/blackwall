import { db, dbSchema } from "@/db";
import type { User } from "@/db/schema";
import { AppError } from "@/features/shared/errors";
import { and, count, eq, notInArray } from "drizzle-orm";
import { WorkspaceQueries } from "../../workspaces/dal/queries";

async function getForUser(input: {
  user: User;
  workspaceSlug: string;
  teamKey: string;
}) {
  const workspace = await WorkspaceQueries.getBySlug(input.workspaceSlug);

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
    return undefined;
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
    return undefined;
  }

  return team;
}

async function listForUser(input: { user: User; workspaceId: string }) {
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

async function listUsers(input: {
  user: User;
  workspaceSlug: string;
  teamKey: string;
}) {
  const workspace = await WorkspaceQueries.getBySlug(input.workspaceSlug);

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

/**
 * Used for routes that need to get a full team data, like the team settings page.
 * @param input Data required to get a full team
 * @returns The full team data
 */
async function getFullTeam(input: {
  user: User;
  workspaceSlug: string;
  teamKey: string;
}) {
  const team = await getForUser(input);
  return team;
}

async function listWorkspaceUsers(input: {
  user: User;
  workspaceSlug: string;
  teamKey: string;
}) {
  const workspace = await WorkspaceQueries.getBySlug(input.workspaceSlug);

  const team = await getForUser({
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

  // Get all team member IDs
  const teamMembers = await db
    .select({ userId: dbSchema.userTeam.userId })
    .from(dbSchema.userTeam)
    .where(eq(dbSchema.userTeam.teamId, team.id));

  const teamMemberIds = teamMembers.map((m) => m.userId);

  // Get all workspace users, excluding team members
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

export const TeamQueries = {
  getForUser,
  listForUser,
  listUsers,
  getFullTeam,
  listWorkspaceUsers,
};
