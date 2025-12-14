import { db, dbSchema } from "@/db";
import type { IssueStatus, User } from "@/db/schema";
import { AppError } from "@/features/shared/errors";
import { and, asc, eq, inArray } from "drizzle-orm";
import { TeamQueries } from "../../teams/dal/queries";
import { WorkspaceQueries } from "../../workspaces/dal/queries";

async function list(input: {
  user: User;
  workspaceSlug: string;
  statusFilters?: IssueStatus[];
}) {
  const workspace = await WorkspaceQueries.getForUser({
    user: input.user,
    slug: input.workspaceSlug,
  });

  const where = [eq(dbSchema.issue.workspaceId, workspace.id)];

  if (input.statusFilters) {
    where.push(inArray(dbSchema.issue.status, input.statusFilters));
  }

  return db.query.issue.findMany({
    where: and(...where),
    with: {
      assignedTo: true,
      labelsOnIssue: {
        with: {
          label: true,
        },
      },
    },
  });
}

async function listInTeam(input: {
  user: User;
  workspaceSlug: string;
  teamKey: string;
  statusFilters?: IssueStatus[];
}) {
  const workspace = await WorkspaceQueries.getForUser({
    user: input.user,
    slug: input.workspaceSlug,
  });

  const team = await TeamQueries.getForUser({
    user: input.user,
    workspaceSlug: input.workspaceSlug,
    teamKey: input.teamKey,
  });
  if (!team) {
    throw new AppError("NOT_FOUND", "Team not found.");
  }

  const where = [
    eq(dbSchema.issue.workspaceId, workspace.id),
    eq(dbSchema.issue.teamId, team.id),
  ];

  if (input.statusFilters) {
    where.push(inArray(dbSchema.issue.status, input.statusFilters));
  }

  return db.query.issue.findMany({
    where: and(...where),
    with: {
      assignedTo: true,
      labelsOnIssue: {
        with: {
          label: true,
        },
      },
    },
  });
}

async function getByKey(input: {
  user: User;
  workspaceSlug: string;
  issueKey: string;
}) {
  const workspace = await WorkspaceQueries.getForUser({
    user: input.user,
    slug: input.workspaceSlug,
  });
  if (!workspace) {
    throw new AppError("NOT_FOUND", "Workspace not found.");
  }

  const issue = await db.query.issue.findFirst({
    where: and(
      eq(dbSchema.issue.workspaceId, workspace.id),
      eq(dbSchema.issue.key, input.issueKey),
    ),
    with: {
      assignedTo: true,
      team: true,
      comments: {
        orderBy: (table) => [asc(table.id)], // uuidv7 is timestamp-based
        with: {
          author: true,
        },
      },
      changeEvents: {
        orderBy: (table) => [asc(table.createdAt)],
        with: {
          actor: true,
        },
      },
      labelsOnIssue: {
        with: {
          label: true,
        },
      },
    },
  });

  if (!issue) {
    throw new AppError("NOT_FOUND", "Issue not found.");
  }

  // Extract team key from issue key (format: TEAMKEY-123)
  const teamKey = input.issueKey.split("-")[0];
  if (!teamKey) {
    throw new AppError("INTERNAL_SERVER_ERROR", "Invalid issue key format.");
  }

  const team = await TeamQueries.getForUser({
    user: input.user,
    workspaceSlug: input.workspaceSlug,
    teamKey,
  });

  if (!team) {
    throw new AppError("NOT_FOUND", "Team not found.");
  }

  return {
    team,
    issue,
  };
}

export const IssueQueries = {
  list,
  listInTeam,
  getByKey,
};
