import { issueInsertSchema, issueStatusValues } from "@/db/schema";
import { authMiddleware } from "@/server/auth/middleware/auth.middleware";
import { AppError } from "@/server/shared/errors";
import { createServerFn } from "@tanstack/solid-start";
import * as z from "zod";
import * as issues from "./issues.data";

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
      return await issues.listIssuesInTeam({
        user: context.user,
        workspaceSlug: data.workspaceSlug,
        teamKey: data.teamKey,
        statusFilters: data.statusFilters,
      });
    }

    return await issues.listIssues({
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
    return await issues.changeIssueStatus({
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
    return await issues.changeIssuePriority({
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
    return await issues.assignIssue({
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
    const result = await issues.getIssueByKey({
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
    return await issues.createIssue({
      user: context.user,
      workspaceSlug: data.workspaceSlug,
      teamKey: data.teamKey,
      issue: data.issue,
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
    return await issues.updateIssueDescription({
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
    return await issues.updateIssueSummary({
      user: context.user,
      workspaceSlug: data.workspaceSlug,
      issueKey: data.issueKey,
      summary: data.summary,
    });
  });

export const deleteIssue = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .inputValidator(
    z.object({
      workspaceSlug: z.string(),
      issueKey: z.string(),
    }),
  )
  .handler(async ({ data, context }) => {
    await issues.softDeleteIssue({
      user: context.user,
      workspaceSlug: data.workspaceSlug,
      issueKey: data.issueKey,
    });

    return { message: "Issue deleted" };
  });
