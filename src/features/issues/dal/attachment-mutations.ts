import { db, dbSchema } from "@/db";
import type { User } from "@/db/schema";
import { AppError } from "@/features/shared/errors";
import { and, eq } from "drizzle-orm";
import { buildChangeEvent } from "../change-events";
import { IssueQueries } from "./issue-queries";

async function create(input: {
  user: User;
  workspaceSlug: string;
  issueKey: string;
  savedFilePath: string;
  uploadedData: Blob;
  originalFileName: string;
}) {
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
}

async function delete_(input: {
  user: User;
  workspaceSlug: string;
  issueKey: string;
  filePath: string;
}) {
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
}

export const AttachmentMutations = {
  create,
  delete: delete_,
};
