import { issueInsertSchema, issueStatusValues } from "@/db/schema";
import { authMiddleware } from "@/server/auth/middleware/auth.middleware";
import { AppError } from "@/server/shared/errors";
import { createServerFn } from "@tanstack/solid-start";
import * as z from "zod";
import { createComment as createCommentData } from "./comments";
import {
  assignIssue,
  changeIssuePriority,
  changeIssueStatus,
  createIssue as createIssueData,
  getIssueByKey,
  listIssues,
  listIssuesInTeam,
  updateIssueDescription,
  updateIssueSummary,
} from "./issues";
import {
  addLabelToIssue as addLabelToIssueData,
  createLabel as createLabelData,
  getAllLabelsForWorkspace,
  getLabelsForIssue,
  removeLabelFromIssue as removeLabelFromIssueData,
} from "./labels";

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
      return await listIssuesInTeam({
        user: context.user,
        workspaceSlug: data.workspaceSlug,
        teamKey: data.teamKey,
        statusFilters: data.statusFilters,
      });
    }

    return await listIssues({
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
    return await changeIssueStatus({
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
    return await changeIssuePriority({
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
    return await assignIssue({
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
    const result = await getIssueByKey({
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
    return await createIssueData({
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
    return await getLabelsForIssue({
      user: context.user!,
      workspaceSlug: data.workspaceSlug,
      issueKey: data.issueKey,
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
    return await addLabelToIssueData({
      user: context.user!,
      workspaceSlug: data.workspaceSlug,
      issueKey: data.issueKey,
      labelId: data.labelId,
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
    return await removeLabelFromIssueData({
      user: context.user!,
      workspaceSlug: data.workspaceSlug,
      issueKey: data.issueKey,
      labelId: data.labelId,
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
    return await createLabelData({
      user: context.user!,
      workspaceSlug: data.workspaceSlug,
      name: data.name,
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
    return await getAllLabelsForWorkspace({
      user: context.user!,
      workspaceSlug: data.workspaceSlug,
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
    return await updateIssueDescription({
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
    return await updateIssueSummary({
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
    return await createCommentData({
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
