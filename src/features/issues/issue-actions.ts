import { issueInsertSchema, issueStatusValues } from "@/db/schema";
import type { InferDbType } from "@/db/utils";
import { AppError } from "@/features/shared/errors";
import { createServerFn } from "@tanstack/solid-start";
import * as z from "zod";
import { authMiddleware } from "../auth/middleware/auth.middleware";
import { CommentMutations } from "./dal/comment-mutations";
import { IssueMutations } from "./dal/issue-mutations";
import { IssueQueries } from "./dal/issue-queries";
import { LabelMutations } from "./dal/label-mutations";
import { LabelQueries } from "./dal/label-queries";

type ListIssue = InferDbType<
  "issue",
  {
    labelsOnIssue: {
      with: {
        label: true;
      };
    };
    assignedTo: true;
  }
>;

export const list = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .inputValidator(
    z.object({
      workspaceSlug: z.string(),
      teamKey: z.string().optional(),
      statusFilters: z.array(z.enum(issueStatusValues)).optional(),
    }),
  )
  .handler(async ({ data, context }) => {
    if (data.teamKey) {
      return await IssueQueries.listInTeam({
        user: context.user,
        workspaceSlug: data.workspaceSlug,
        teamKey: data.teamKey,
        statusFilters: data.statusFilters,
      });
    }

    return await IssueQueries.list({
      user: context.user,
      workspaceSlug: data.workspaceSlug,
      statusFilters: data.statusFilters,
    });
  });

export const changeStatus = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .inputValidator(
    z.object({
      workspaceSlug: z.string(),
      issueKey: z.string(),
      issueStatus: issueInsertSchema.shape.status.nonoptional(),
    }),
  )
  .handler(async ({ data, context }) => {
    return await IssueMutations.changeStatus({
      user: context.user,
      workspaceSlug: data.workspaceSlug,
      issueKey: data.issueKey,
      newStatus: data.issueStatus,
    });
  });

export const changePriority = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .inputValidator(
    z.object({
      workspaceSlug: z.string(),
      issueKey: z.string(),
      issuePriority: issueInsertSchema.shape.priority.nonoptional(),
    }),
  )
  .handler(async ({ data, context }) => {
    return await IssueMutations.changePriority({
      user: context.user,
      workspaceSlug: data.workspaceSlug,
      issueKey: data.issueKey,
      newPriority: data.issuePriority,
    });
  });

export const assign = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .inputValidator(
    z.object({
      workspaceSlug: z.string(),
      issueKey: z.string(),
      assignToId: z.string().nullable(),
    }),
  )
  .handler(async ({ data, context }) => {
    return await IssueMutations.assign({
      user: context.user!,
      workspaceSlug: data.workspaceSlug,
      issueKey: data.issueKey,
      toUserId: data.assignToId,
    });
  });

export const get = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .inputValidator(
    z.object({
      workspaceSlug: z.string(),
      issueKey: z.string(),
    }),
  )
  .handler(async ({ data, context }) => {
    const result = await IssueQueries.getByKey({
      user: context.user!,
      workspaceSlug: data.workspaceSlug,
      issueKey: data.issueKey,
    });

    if (!result) {
      throw new AppError("NOT_FOUND", "Issue not found.");
    }

    return result;
  });

export const create = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .inputValidator(
    z.object({
      workspaceSlug: z.string(),
      teamKey: z.string(),
      issue: z.object({
        summary: issueInsertSchema.shape.summary,
        description: issueInsertSchema.shape.description,
        status: issueInsertSchema.shape.status.optional().default("backlog"),
        assignedToId: issueInsertSchema.shape.assignedToId.optional(),
      }),
    }),
  )
  .handler(async ({ data, context }) => {
    return await IssueMutations.create({
      user: context.user,
      workspaceSlug: data.workspaceSlug,
      teamKey: data.teamKey,
      issue: data.issue,
    });
  });

export const getIssueLabels = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .inputValidator(
    z.object({
      workspaceSlug: z.string(),
      issueKey: z.string(),
    }),
  )
  .handler(async ({ data, context }) => {
    return await LabelQueries.getForIssue({
      workspaceSlug: data.workspaceSlug,
      issueKey: data.issueKey,
      user: context.user!,
    });
  });

export const addLabelToIssue = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .inputValidator(
    z.object({
      workspaceSlug: z.string(),
      issueKey: z.string(),
      labelId: z.string(),
    }),
  )
  .handler(async ({ data, context }) => {
    return await LabelMutations.addToIssue({
      workspaceSlug: data.workspaceSlug,
      issueKey: data.issueKey,
      labelId: data.labelId,
      user: context.user!,
    });
  });

export const removeLabelFromIssue = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .inputValidator(
    z.object({
      workspaceSlug: z.string(),
      issueKey: z.string(),
      labelId: z.string(),
    }),
  )
  .handler(async ({ data, context }) => {
    return await LabelMutations.removeFromIssue({
      workspaceSlug: data.workspaceSlug,
      issueKey: data.issueKey,
      labelId: data.labelId,
      user: context.user!,
    });
  });

export const createLabel = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .inputValidator(
    z.object({
      workspaceSlug: z.string(),
      name: z.string(),
    }),
  )
  .handler(async ({ data, context }) => {
    return await LabelMutations.create({
      workspaceSlug: data.workspaceSlug,
      name: data.name,
      user: context.user!,
    });
  });

export const getAllLabels = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .inputValidator(
    z.object({
      workspaceSlug: z.string(),
    }),
  )
  .handler(async ({ data, context }) => {
    return await LabelQueries.getAllForWorkspace({
      workspaceSlug: data.workspaceSlug,
      user: context.user!,
    });
  });

export const updateDescription = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .inputValidator(
    z.object({
      workspaceSlug: z.string(),
      issueKey: z.string(),
      description: z.any(),
    }),
  )
  .handler(async ({ data, context }) => {
    return await IssueMutations.updateDescription({
      user: context.user,
      workspaceSlug: data.workspaceSlug,
      issueKey: data.issueKey,
      description: data.description,
    });
  });

export const updateSummary = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .inputValidator(
    z.object({
      workspaceSlug: z.string(),
      issueKey: z.string(),
      summary: z.string(),
    }),
  )
  .handler(async ({ data, context }) => {
    return await IssueMutations.updateSummary({
      user: context.user,
      workspaceSlug: data.workspaceSlug,
      issueKey: data.issueKey,
      summary: data.summary,
    });
  });

export const createComment = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .inputValidator(
    z.object({
      workspaceSlug: z.string(),
      issueKey: z.string(),
      content: z.any(), // TODO
    }),
  )
  .handler(async ({ data, context }) => {
    return await CommentMutations.create({
      user: context.user,
      workspaceSlug: data.workspaceSlug,
      issueKey: data.issueKey,
      content: data.content,
    });
  });

export const uploadAttachment = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .inputValidator((data) => {
    if (!(data instanceof FormData)) {
      throw new Error("Expected FormData");
    }

    return {
      file: data.get("file") as File,
    };
  })
  .handler(async ({ data, context }) => {
    console.log(data.file);
  });
