import { authMiddleware } from "@/server/auth/middleware/auth.middleware";
import { createServerFn } from "@tanstack/solid-start";
import * as z from "zod";
import * as comments from "./comments.data";

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
    return await comments.createComment({
      user: context.user,
      workspaceSlug: data.workspaceSlug,
      issueKey: data.issueKey,
      content: data.content,
    });
  });

export const deleteComment = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .inputValidator(
    z.object({
      workspaceSlug: z.string(),
      issueKey: z.string(),
      commentId: z.string(),
    }),
  )
  .handler(async ({ data, context }) => {
    await comments.softDeleteComment({
      user: context.user,
      workspaceSlug: data.workspaceSlug,
      issueKey: data.issueKey,
      commentId: data.commentId,
    });

    return { message: "Comment deleted" };
  });
