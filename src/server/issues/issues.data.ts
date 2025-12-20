import { db, dbSchema } from "@/db";
import type {
  Issue,
  IssuePriority,
  IssueStatus,
  NewIssue,
  Team,
  User,
} from "@/db/schema";
import { getUserById } from "@/server/auth/data";
import { AppError } from "@/server/shared/errors";
import { getTeamForUser, listTeamUsers } from "@/server/team/data";
import { getWorkspaceForUser } from "@/server/workspace/data";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { buildChangeEvent, buildIssueUpdatedEvent } from "./change-events";
import { getNextSequenceNumber, getNextSequenceNumbers } from "./key-sequences";

export type CreateIssueInput = Pick<
  NewIssue,
  "summary" | "description" | "status" | "assignedToId"
>;

export async function listIssues(input: {
  user: User;
  workspaceSlug: string;
  statusFilters?: IssueStatus[];
}) {
  const workspace = await getWorkspaceForUser({
    user: input.user,
    slug: input.workspaceSlug,
  });

  const where = [
    eq(dbSchema.issue.workspaceId, workspace.id),
    isNull(dbSchema.issue.deletedAt),
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

export async function listIssuesInTeam(input: {
  user: User;
  workspaceSlug: string;
  teamKey: string;
  statusFilters?: IssueStatus[];
}) {
  const workspace = await getWorkspaceForUser({
    user: input.user,
    slug: input.workspaceSlug,
  });

  const team = await getTeamForUser({
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
    isNull(dbSchema.issue.deletedAt),
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

export async function getIssueByKey(input: {
  user: User;
  workspaceSlug: string;
  issueKey: string;
}) {
  const workspace = await getWorkspaceForUser({
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
      isNull(dbSchema.issue.deletedAt),
    ),
    with: {
      assignedTo: true,
      team: true,
      comments: {
        where: (table) => isNull(table.deletedAt),
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

  const team = await getTeamForUser({
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

export async function createIssue(input: {
  user: User;
  workspaceSlug: string;
  teamKey: string;
  issue: CreateIssueInput;
}) {
  const team = await getTeamForUser({
    user: input.user,
    workspaceSlug: input.workspaceSlug,
    teamKey: input.teamKey,
  });

  if (!team) {
    throw new AppError("NOT_FOUND", "Team not found.");
  }

  if (input.issue.assignedToId) {
    const assignee = await getUserById(input.issue.assignedToId);
    const teamUsers = await listTeamUsers(input);

    if (!assignee || !teamUsers.some((user) => user.id === assignee.id)) {
      throw new AppError("NOT_FOUND", "Assignee not found.");
    }
  }

  const result = await db.transaction(async (tx) => {
    const keyNumber = await getNextSequenceNumber({
      workspaceId: team.workspaceId,
      teamId: team.id,
      tx,
    });

    const [issue] = await tx
      .insert(dbSchema.issue)
      .values({
        ...input.issue,
        createdById: input.user.id,
        assignedToId: input.issue.assignedToId ?? undefined,
        keyNumber,
        key: `${team.key}-${keyNumber}`,
        teamId: team.id,
        workspaceId: team.workspaceId,
      })
      .returning();

    await tx.insert(dbSchema.issueChangeEvent).values(
      buildChangeEvent(
        {
          issueId: issue.id,
          workspaceId: team.workspaceId,
          actorId: input.user.id,
        },
        "issue_created",
      ),
    );

    return issue;
  });

  if (!result) {
    throw new AppError("INTERNAL_SERVER_ERROR", "Issue couldn't be created.");
  }

  return result;
}

export async function createManyIssues(input: {
  user: User;
  workspaceSlug: string;
  teamKey: string;
  input: CreateIssueInput[];
}) {
  const team = await getTeamForUser({
    user: input.user,
    workspaceSlug: input.workspaceSlug,
    teamKey: input.teamKey,
  });

  if (!team) {
    throw new AppError("NOT_FOUND", "Team not found.");
  }

  const results = await db.transaction(async (tx) => {
    const keyNumbers = await getNextSequenceNumbers({
      workspaceId: team.workspaceId,
      teamId: team.id,
      count: input.input.length,
      tx,
    });

    const issuesToInsert: Array<NewIssue> = [];
    for (let i = 0; i < input.input.length; i++) {
      issuesToInsert.push({
        ...(input.input[i] as CreateIssueInput),
        createdById: input.user.id,
        keyNumber: keyNumbers[i],
        key: `${team.key}-${keyNumbers[i]}`,
        teamId: team.id,
        workspaceId: team.workspaceId,
      });
    }

    const issues = await tx
      .insert(dbSchema.issue)
      .values(issuesToInsert)
      .returning();

    await tx.insert(dbSchema.issueChangeEvent).values(
      issues.map((issue) =>
        buildChangeEvent(
          {
            issueId: issue.id,
            workspaceId: team.workspaceId,
            actorId: input.user.id,
          },
          "issue_created",
        ),
      ),
    );

    return issues;
  });

  return results;
}

export async function changeIssueStatus(input: {
  user: User;
  workspaceSlug: string;
  issueKey: string;
  newStatus: IssueStatus;
}) {
  const issueResult = await getIssueByKey({
    user: input.user,
    workspaceSlug: input.workspaceSlug,
    issueKey: input.issueKey,
  });

  if (!issueResult) {
    throw new AppError("NOT_FOUND", "Issue not found.");
  }

  const { issue: originalIssue } = issueResult;

  if (originalIssue.status === input.newStatus) {
    return originalIssue;
  }

  const result = await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(dbSchema.issue)
      .set({ status: input.newStatus })
      .where(eq(dbSchema.issue.id, originalIssue.id))
      .returning();

    const event = buildIssueUpdatedEvent(
      {
        issueId: originalIssue.id,
        workspaceId: originalIssue.workspaceId,
        actorId: input.user.id,
      },
      { status: input.newStatus },
      originalIssue,
    );

    if (event) {
      await tx.insert(dbSchema.issueChangeEvent).values(event);
    }

    return updated;
  });

  if (!result) {
    throw new AppError(
      "INTERNAL_SERVER_ERROR",
      "Issue status couldn't be updated.",
    );
  }

  return result;
}

export async function changeIssuePriority(input: {
  user: User;
  workspaceSlug: string;
  issueKey: string;
  newPriority: IssuePriority;
}) {
  const issueResult = await getIssueByKey({
    user: input.user,
    workspaceSlug: input.workspaceSlug,
    issueKey: input.issueKey,
  });

  if (!issueResult) {
    throw new AppError("NOT_FOUND", "Issue not found.");
  }

  const { issue: originalIssue } = issueResult;

  if (originalIssue.priority === input.newPriority) {
    return originalIssue;
  }

  const result = await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(dbSchema.issue)
      .set({ priority: input.newPriority })
      .where(eq(dbSchema.issue.id, originalIssue.id))
      .returning();

    const event = buildIssueUpdatedEvent(
      {
        issueId: originalIssue.id,
        workspaceId: originalIssue.workspaceId,
        actorId: input.user.id,
      },
      { priority: input.newPriority },
      originalIssue,
    );

    if (event) {
      await tx.insert(dbSchema.issueChangeEvent).values(event);
    }

    return updated;
  });

  if (!result) {
    throw new AppError(
      "INTERNAL_SERVER_ERROR",
      "Issue priority couldn't be updated.",
    );
  }

  return result;
}

export async function assignIssue(input: {
  user: User;
  workspaceSlug: string;
  issueKey: string;
  toUserId: string | null;
}) {
  const issueResult = await getIssueByKey({
    user: input.user,
    workspaceSlug: input.workspaceSlug,
    issueKey: input.issueKey,
  });

  if (!issueResult) {
    throw new AppError("NOT_FOUND", "Issue not found.");
  }

  const { issue: originalIssue } = issueResult;
  const newAssigneeId = input.toUserId
    ? ((await getUserById(input.toUserId))?.id ?? null)
    : null;

  if (originalIssue.assignedToId === newAssigneeId) {
    return originalIssue;
  }

  const result = await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(dbSchema.issue)
      .set({ assignedToId: newAssigneeId })
      .where(eq(dbSchema.issue.id, originalIssue.id))
      .returning();

    const event = buildIssueUpdatedEvent(
      {
        issueId: originalIssue.id,
        workspaceId: originalIssue.workspaceId,
        actorId: input.user.id,
      },
      { assignedToId: newAssigneeId },
      originalIssue,
    );

    if (event) {
      await tx.insert(dbSchema.issueChangeEvent).values(event);
    }

    return updated;
  });

  if (!result) {
    throw new AppError("INTERNAL_SERVER_ERROR", "Couldn't update the issue.");
  }

  return result;
}

export async function updateIssueDescription(input: {
  user: User;
  workspaceSlug: string;
  issueKey: string;
  description: any;
}) {
  const { issue: originalIssue } = await getIssueByKey({
    user: input.user,
    workspaceSlug: input.workspaceSlug,
    issueKey: input.issueKey,
  });

  if (!originalIssue) {
    throw new AppError("NOT_FOUND", "Issue not found.");
  }

  await db.transaction(async (tx) => {
    await tx
      .update(dbSchema.issue)
      .set({ description: input.description })
      .where(eq(dbSchema.issue.id, originalIssue.id));

    const event = buildIssueUpdatedEvent(
      {
        issueId: originalIssue.id,
        workspaceId: originalIssue.workspaceId,
        actorId: input.user.id,
      },
      { description: input.description },
      originalIssue,
    );

    if (event) {
      await tx.insert(dbSchema.issueChangeEvent).values(event);
    }
  });
}

export async function updateIssueSummary(input: {
  user: User;
  workspaceSlug: string;
  issueKey: string;
  summary: string;
}) {
  const { issue: originalIssue } = await getIssueByKey({
    user: input.user,
    workspaceSlug: input.workspaceSlug,
    issueKey: input.issueKey,
  });

  if (!originalIssue) {
    throw new AppError("NOT_FOUND", "Issue not found.");
  }

  if (originalIssue.summary === input.summary) {
    return;
  }

  await db.transaction(async (tx) => {
    await tx
      .update(dbSchema.issue)
      .set({ summary: input.summary })
      .where(eq(dbSchema.issue.id, originalIssue.id));

    const event = buildIssueUpdatedEvent(
      {
        issueId: originalIssue.id,
        workspaceId: originalIssue.workspaceId,
        actorId: input.user.id,
      },
      { summary: input.summary },
      originalIssue,
    );

    if (event) {
      await tx.insert(dbSchema.issueChangeEvent).values(event);
    }
  });
}

export async function bulkChangeIssueTeamKeys(input: {
  user: User;
  workspaceSlug: string;
  team: Team;
}) {
  const data = await db
    .select()
    .from(dbSchema.issue)
    .innerJoin(dbSchema.team, eq(dbSchema.issue.teamId, dbSchema.team.id))
    .innerJoin(
      dbSchema.workspace,
      eq(dbSchema.issue.workspaceId, dbSchema.workspace.id),
    )
    .where(
      and(
        eq(dbSchema.workspace.slug, input.workspaceSlug),
        eq(dbSchema.team.id, input.team.id),
      ),
    );

  const issuesToUpdate: Array<Issue> = [];

  for (const item of data) {
    const oldTeamKey = item.issue.key.split("-")[0];
    issuesToUpdate.push({
      ...item.issue,
      key: item.issue.key.replace(oldTeamKey, input.team.key),
    });
  }

  // bulk update
  await db
    .insert(dbSchema.issue)
    .values(issuesToUpdate)
    .onConflictDoUpdate({
      target: dbSchema.issue.id,
      set: {
        key: sql`excluded.key`,
      },
    });
}

export async function softDeleteIssue(input: {
  user: User;
  workspaceSlug: string;
  issueKey: string;
}) {
  const { issue } = await getIssueByKey({
    user: input.user,
    workspaceSlug: input.workspaceSlug,
    issueKey: input.issueKey,
  });

  if (!issue) {
    throw new AppError("NOT_FOUND", "Issue not found.");
  }

  await db
    .update(dbSchema.issue)
    .set({ deletedAt: new Date() })
    .where(eq(dbSchema.issue.id, issue.id));
}
