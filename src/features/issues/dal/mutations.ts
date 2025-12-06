import { db, dbSchema } from "@/db";
import type { IssuePriority, IssueStatus, NewIssue, User } from "@/db/schema";
import { createColorFromString } from "@/features/shared/colors";
import { AppError } from "@/features/shared/errors";
import type { JSONContent } from "@tiptap/core";
import { and, count, eq } from "drizzle-orm";
import { AuthQueries } from "../../auth/dal/queries";
import { TeamQueries } from "../../teams/dal/queries";
import { WorkspaceQueries } from "../../workspaces/dal/queries";
import { buildChangeEvent, buildIssueUpdatedEvent } from "../change-events";
import { getNextSequenceNumber, getNextSequenceNumbers } from "./key-sequences";
import { IssueQueries, LabelQueries } from "./queries";

export type CreateIssueInput = {
  summary: string;
  description?: JSONContent | null;
  status: IssueStatus;
};

export const IssueMutations = {
  create: async (input: {
    user: User;
    workspaceSlug: string;
    teamKey: string;
    input: CreateIssueInput;
  }) => {
    const team = await TeamQueries.getForUser({
      user: input.user,
      workspaceSlug: input.workspaceSlug,
      teamKey: input.teamKey,
    });

    if (!team) {
      throw new AppError("NOT_FOUND", "Team not found.");
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
          ...input.input,
          createdById: input.user.id,
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
  },

  createMany: async (input: {
    user: User;
    workspaceSlug: string;
    teamKey: string;
    input: CreateIssueInput[];
  }) => {
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
  },

  changeStatus: async (input: {
    user: User;
    workspaceSlug: string;
    issueKey: string;
    newStatus: IssueStatus;
  }) => {
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
  },

  changePriority: async (input: {
    user: User;
    workspaceSlug: string;
    issueKey: string;
    newPriority: IssuePriority;
  }) => {
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
  },

  assign: async (input: {
    user: User;
    workspaceSlug: string;
    issueKey: string;
    toUserId: string | null;
  }) => {
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
  },

  updateDescription: async (input: {
    user: User;
    workspaceSlug: string;
    issueKey: string;
    description: JSONContent;
  }) => {
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
  },

  updateSummary: async (input: {
    user: User;
    workspaceSlug: string;
    issueKey: string;
    summary: string;
  }) => {
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
  },
};

export const IssueCommentMutations = {
  createComment: async (input: {
    user: User;
    workspaceSlug: string;
    issueKey: string;
    content: JSONContent;
  }) => {
    const { issue } = await IssueQueries.getByKey({
      user: input.user,
      workspaceSlug: input.workspaceSlug,
      issueKey: input.issueKey,
    });

    return await db.transaction(async (tx) => {
      const [comment] = await tx
        .insert(dbSchema.issueComment)
        .values({
          issueId: issue.id,
          authorId: input.user.id,
          content: input.content,
        })
        .returning();

      await tx.insert(dbSchema.issueChangeEvent).values(
        buildChangeEvent(
          {
            issueId: issue.id,
            workspaceId: issue.workspaceId,
            actorId: input.user.id,
          },
          "comment_added",
          comment.id,
        ),
      );

      return comment;
    });
  },
};

export const LabelMutations = {
  createLabel: async (input: {
    user: User;
    workspaceSlug: string;
    name: string;
  }) => {
    const workspace = await WorkspaceQueries.getBySlug(input.workspaceSlug);

    const existingLabel = await db.query.label.findFirst({
      where: and(
        eq(dbSchema.label.workspaceId, workspace.id),
        eq(dbSchema.label.name, input.name),
      ),
    });

    if (existingLabel) {
      throw new AppError("BAD_REQUEST", "Label with this name already exists.");
    }

    const [label] = await db
      .insert(dbSchema.label)
      .values({
        name: input.name,
        workspaceId: workspace.id,
        colorKey: createColorFromString(input.name),
      })
      .returning();

    if (!label) {
      throw new AppError("INTERNAL_SERVER_ERROR", "Label couldn't be created.");
    }

    return label;
  },

  addLabelToIssue: async (input: {
    user: User;
    workspaceSlug: string;
    issueKey: string;
    labelId: string;
  }) => {
    const { issue } = await IssueQueries.getByKey({
      user: input.user,
      workspaceSlug: input.workspaceSlug,
      issueKey: input.issueKey,
    });

    const [labelCount] = await db
      .select({
        count: count(),
      })
      .from(dbSchema.labelOnIssue)
      .where(eq(dbSchema.labelOnIssue.issueId, issue.id));

    if (!labelCount || labelCount.count >= 100) {
      throw new AppError(
        "BAD_REQUEST",
        "The issue has a maximum amount of labels.",
      );
    }
    const label = await LabelQueries.getLabelById({
      user: input.user,
      workspaceSlug: input.workspaceSlug,
      labelId: input.labelId,
    });

    await db.transaction(async (tx) => {
      await tx.insert(dbSchema.labelOnIssue).values({
        issueId: issue.id,
        labelId: label.id,
      });

      await tx.insert(dbSchema.issueChangeEvent).values(
        buildChangeEvent(
          {
            issueId: issue.id,
            workspaceId: issue.workspaceId,
            actorId: input.user.id,
          },
          "label_added",
          label.id,
        ),
      );
    });
  },

  removeLabelFromIssue: async (input: {
    user: User;
    workspaceSlug: string;
    issueKey: string;
    labelId: string;
  }) => {
    const { issue } = await IssueQueries.getByKey({
      user: input.user,
      workspaceSlug: input.workspaceSlug,
      issueKey: input.issueKey,
    });

    await db.transaction(async (tx) => {
      await tx
        .delete(dbSchema.labelOnIssue)
        .where(
          and(
            eq(dbSchema.labelOnIssue.issueId, issue.id),
            eq(dbSchema.labelOnIssue.labelId, input.labelId),
          ),
        );

      await tx.insert(dbSchema.issueChangeEvent).values(
        buildChangeEvent(
          {
            issueId: issue.id,
            workspaceId: issue.workspaceId,
            actorId: input.user.id,
          },
          "label_removed",
          input.labelId,
        ),
      );
    });
  },
};

export const IssueAttachmentMutations = {
  createAttachment: async (input: {
    user: User;
    workspaceSlug: string;
    issueKey: string;
    savedFilePath: string;
    uploadedData: Blob;
    originalFileName: string;
  }) => {
    const { issue } = await IssueQueries.getByKey({
      user: input.user,
      workspaceSlug: input.workspaceSlug,
      issueKey: input.issueKey,
    });

    return await db.transaction(async (tx) => {
      const [attachment] = await tx
        .insert(dbSchema.issueAttachment)
        .values({
          issueId: issue.id,
          createdById: input.user.id,
          filePath: input.savedFilePath,
          originalFileName: input.originalFileName,
        })
        .returning();

      await tx.insert(dbSchema.issueChangeEvent).values(
        buildChangeEvent(
          {
            issueId: issue.id,
            workspaceId: issue.workspaceId,
            actorId: input.user.id,
          },
          "attachment_added",
          attachment.id,
        ),
      );

      return attachment;
    });
  },

  deleteAttachment: async (input: {
    user: User;
    workspaceSlug: string;
    issueKey: string;
    filePath: string;
  }) => {
    const { issue } = await IssueQueries.getByKey({
      user: input.user,
      workspaceSlug: input.workspaceSlug,
      issueKey: input.issueKey,
    });

    const attachment = await db.query.issueAttachment.findFirst({
      where: and(
        eq(dbSchema.issueAttachment.issueId, issue.id),
        eq(dbSchema.issueAttachment.filePath, input.filePath),
      ),
    });

    if (!attachment) {
      throw new AppError("NOT_FOUND", "Attachment not found.");
    }

    await db.transaction(async (tx) => {
      await tx.insert(dbSchema.issueChangeEvent).values(
        buildChangeEvent(
          {
            issueId: issue.id,
            workspaceId: issue.workspaceId,
            actorId: input.user.id,
          },
          "attachment_removed",
          attachment.id,
        ),
      );

      await tx
        .delete(dbSchema.issueAttachment)
        .where(eq(dbSchema.issueAttachment.id, attachment.id));
    });
  },
};
