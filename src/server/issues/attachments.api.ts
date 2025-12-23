import { saveFile } from "@/lib/file-upload";
import { authMiddleware } from "@/server/auth/middleware/auth.middleware";
import { createServerFn } from "@tanstack/solid-start";
import * as z from "zod";
import { AppError } from "../shared/errors";
import {
  associateAttachmentsWithIssue,
  createAttachment,
  createOrphanAttachment,
  getAttachmentById as getAttachmentByIdData,
} from "./attachments.data";
import { getIssueByKey } from "./issues.data";

/**
 * Upload an attachment. If issueKey is provided, associates with that issue.
 * Otherwise creates an orphan attachment for later association.
 */
export const uploadAttachment = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .inputValidator((data) => {
    if (!(data instanceof FormData)) {
      throw new AppError("BAD_REQUEST", "Expected FormData");
    }

    const file = data.get("file");
    if (!(file instanceof File)) {
      throw new AppError("BAD_REQUEST", "Expected file");
    }

    const workspaceSlug = data.get("workspaceSlug");
    if (typeof workspaceSlug !== "string" || !workspaceSlug) {
      throw new AppError("BAD_REQUEST", "Expected workspaceSlug");
    }

    const issueKey = data.get("issueKey");

    return {
      file,
      workspaceSlug,
      issueKey: typeof issueKey === "string" && issueKey ? issueKey : null,
    };
  })
  .handler(async ({ data, context }) => {
    const { file, workspaceSlug, issueKey } = data;

    const originalFileName = file.name;
    const originalFileNameWithoutExtension = originalFileName
      .split(".")
      .slice(0, -1)
      .join(".");

    const filePath = await saveFile(file, {
      directory: `workspaces/${workspaceSlug}/issue-attachments`,
      name: originalFileNameWithoutExtension,
    });

    if (issueKey) {
      const attachment = await createAttachment({
        user: context.user,
        workspaceSlug,
        issueKey,
        filePath,
        mimeType: file.type,
        originalFileName,
      });
      return attachment;
    }

    const attachment = await createOrphanAttachment({
      user: context.user,
      filePath,
      mimeType: file.type,
      originalFileName,
    });

    return attachment;
  });

export const getAttachmentById = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .inputValidator(
    z.object({
      workspaceSlug: z.string(),
      issueKey: z.string(),
      attachmentId: z.string(),
    }),
  )
  .handler(async ({ data, context }) => {
    const attachment = await getAttachmentByIdData({
      user: context.user,
      workspaceSlug: data.workspaceSlug,
      issueKey: data.issueKey,
      attachmentId: data.attachmentId,
    });

    if (!attachment) {
      throw new AppError("NOT_FOUND", "Attachment not found.");
    }

    return attachment;
  });

export const associateAttachments = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .inputValidator(
    z.object({
      workspaceSlug: z.string(),
      issueKey: z.string(),
      attachmentIds: z.array(z.string()),
    }),
  )
  .handler(async ({ data, context }) => {
    const { issue } = await getIssueByKey({
      user: context.user,
      workspaceSlug: data.workspaceSlug,
      issueKey: data.issueKey,
    });

    await associateAttachmentsWithIssue({
      user: context.user,
      issueId: issue.id,
      workspaceId: issue.workspaceId,
      attachmentIds: data.attachmentIds,
    });

    return { success: true };
  });

export const getAttachmentForDownload = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .inputValidator(z.object({ attachmentId: z.string() }))
  .handler(async ({ data, context }) => {
    const { getAttachmentForServing } = await import("./attachments.data");

    const attachment = await getAttachmentForServing({
      user: context.user,
      attachmentId: data.attachmentId,
    });

    return attachment;
  });
