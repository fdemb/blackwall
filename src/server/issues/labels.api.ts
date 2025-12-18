import { authMiddleware } from "@/server/auth/middleware/auth.middleware";
import { createServerFn } from "@tanstack/solid-start";
import * as z from "zod";
import * as labels from "./labels.data";

export const getIssueLabels = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .inputValidator(
    z.object({
      workspaceSlug: z.string(),
      issueKey: z.string(),
    }),
  )
  .handler(async ({ data, context }) => {
    return await labels.getLabelsForIssue({
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
    return await labels.addLabelToIssue({
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
    return await labels.removeLabelFromIssue({
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
    return await labels.createLabel({
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
    return await labels.getAllLabelsForWorkspace({
      user: context.user!,
      workspaceSlug: data.workspaceSlug,
    });
  });

