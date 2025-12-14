import { db, dbSchema } from "@/db";
import type {
  Issue,
  IssuePriority,
  IssueStatus,
  NewIssue,
  Team,
  User,
} from "@/db/schema";
import { AppError } from "@/features/shared/errors";
import { and, eq, sql } from "drizzle-orm";
import { AuthQueries } from "../../auth/dal/queries";
import { TeamQueries } from "../../teams/dal/queries";
import { buildChangeEvent, buildIssueUpdatedEvent } from "../change-events";
import { IssueQueries } from "./issue-queries";
import { getNextSequenceNumber, getNextSequenceNumbers } from "./key-sequences";

export type CreateIssueInput = Pick<
  NewIssue,
  "summary" | "description" | "status" | "assignedToId"
>;

async function create(input: {
  user: User;
  workspaceSlug: string;
  teamKey: string;
  issue: CreateIssueInput;
}) {
  const team = await TeamQueries.getForUser({
    user: input.user,
    workspaceSlug: input.workspaceSlug,
    teamKey: input.teamKey,
  });

  if (!team) {
    throw new AppError("NOT_FOUND", "Team not found.");
  }

  if (input.issue.assignedToId) {
    const assignee = await AuthQueries.getUser(input.issue.assignedToId);
    const teamUsers = await TeamQueries.listUsers(input);

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

async function createMany(input: {
  user: User;
  workspaceSlug: string;
  teamKey: string;
  input: CreateIssueInput[];
}) {
  const team = await TeamQueries.getForUser({
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

async function changeStatus(input: {
  user: User;
  workspaceSlug: string;
  issueKey: string;
  newStatus: IssueStatus;
}) {
  const issueResult = await IssueQueries.getByKey({
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

async function changePriority(input: {
  user: User;
  workspaceSlug: string;
  issueKey: string;
  newPriority: IssuePriority;
}) {
  const issueResult = await IssueQueries.getByKey({
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

async function assign(input: {
  user: User;
  workspaceSlug: string;
  issueKey: string;
  toUserId: string | null;
}) {
  const issueResult = await IssueQueries.getByKey({
    user: input.user,
    workspaceSlug: input.workspaceSlug,
    issueKey: input.issueKey,
  });

  if (!issueResult) {
    throw new AppError("NOT_FOUND", "Issue not found.");
  }

  const { issue: originalIssue } = issueResult;
  const newAssigneeId = input.toUserId
    ? ((await AuthQueries.getUser(input.toUserId))?.id ?? null)
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

async function updateDescription(input: {
  user: User;
  workspaceSlug: string;
  issueKey: string;
  description: any;
}) {
  const { issue: originalIssue } = await IssueQueries.getByKey({
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

async function updateSummary(input: {
  user: User;
  workspaceSlug: string;
  issueKey: string;
  summary: string;
}) {
  const { issue: originalIssue } = await IssueQueries.getByKey({
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

async function bulkChangeTeamKeys(input: {
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

export const IssueMutations = {
  create,
  createMany,
  changeStatus,
  changePriority,
  assign,
  updateDescription,
  updateSummary,
  bulkChangeTeamKeys,
};
