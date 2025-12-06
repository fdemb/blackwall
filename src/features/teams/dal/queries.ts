import { db, dbSchema } from "@/db";
import type { User } from "@/db/schema";
import { AppError } from "@/features/shared/errors";
import { and, eq } from "drizzle-orm";
import { WorkspaceQueries } from "../../workspaces/dal/queries";

export const TeamQueries = {
  getForUser: async (input: {
    user: User;
    workspaceSlug: string;
    teamKey: string;
  }) => {
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
  },
  listForUser: async (input: { user: User; workspaceId: string }) => {
    const userTeams = await db
      .select()
      .from(dbSchema.userTeam)
      .leftJoin(dbSchema.team, eq(dbSchema.userTeam.teamId, dbSchema.team.id))
      .where(
        and(
          eq(dbSchema.team.workspaceId, input.workspaceId),
          eq(dbSchema.userTeam.userId, input.user.id),
        ),
      );

    return userTeams.map((ut) => ut.team).filter((team) => team !== null);
  },
  listUsers: async (input: {
    user: User;
    workspaceSlug: string;
    teamKey: string;
  }) => {
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
  },
};
