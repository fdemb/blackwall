import { db, dbSchema } from "@/db";
import type { User } from "@/db/schema";
import { TeamQueries } from "@/features/teams/dal/queries";
import { and, eq, inArray, like, or, sql } from "drizzle-orm";

const search = async (input: {
  searchTerm: string;
  workspaceId: string;
  user: User;
}) => {
  const allUserTeams = await TeamQueries.listForUser({
    user: input.user,
    workspaceId: input.workspaceId,
  });

  const searchLower = input.searchTerm.toLowerCase();
  const searchPattern = `%${searchLower}%`;

  const foundIssues = (
    await db.query.issue.findMany({
      where: and(
        eq(dbSchema.issue.workspaceId, input.workspaceId),
        inArray(
          dbSchema.issue.teamId,
          allUserTeams.map((team) => team.id),
        ),
        input.searchTerm.length > 0
          ? or(
              like(sql`LOWER(${dbSchema.issue.summary})`, searchPattern),
              like(sql`LOWER(${dbSchema.issue.description})`, searchPattern),
            )
          : undefined,
      ),
      limit: 50,
    })
  ).map((issue) => ({
    ...issue,
    type: "issue" as const,
  }));

  const foundUsersWithPivots = await db
    .select()
    .from(dbSchema.user)
    .leftJoin(
      dbSchema.workspaceUser,
      eq(dbSchema.user.id, dbSchema.workspaceUser.userId),
    )
    .where(
      and(
        eq(dbSchema.workspaceUser.workspaceId, input.workspaceId),
        like(sql`LOWER(${dbSchema.user.name})`, searchPattern),
      ),
    )
    .limit(50);

  const foundUsers = foundUsersWithPivots.map((up) => ({
    ...up.user,
    type: "user" as const,
  }));

  return {
    issues: foundIssues,
    users: foundUsers,
  };
};

export const GlobalSearchQueries = {
  search,
};
