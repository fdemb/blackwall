import { db, dbSchema } from "@/db";
import type { User } from "@/db/schema";
import { AppError } from "@/server/shared/errors";
import { and, eq, isNull } from "drizzle-orm";
import { buildChangeEvent } from "./change-events";
import { getIssueByKey } from "./issues.data";

export async function createOrphanAttachment(input: {
  user: User;
  filePath: string;
  mimeType: string;
  originalFileName: string;
}) {
  const [attachment] = await db
    .insert(dbSchema.issueAttachment)
    .values({
      issueId: null,
      createdById: input.user.id,
      filePath: input.filePath,
      mimeType: input.mimeType,
      originalFileName: input.originalFileName,
    })
    .returning();

  return attachment;
}

export async function associateAttachmentsWithIssue(input: {
  user: User;
  issueId: string;
  workspaceId: string;
  attachmentIds: string[];
}) {
  if (input.attachmentIds.length === 0) return;

  await db.transaction(async (tx) => {
    for (const attachmentId of input.attachmentIds) {
      const [updated] = await tx
        .update(dbSchema.issueAttachment)
        .set({ issueId: input.issueId })
        .where(
          and(
            eq(dbSchema.issueAttachment.id, attachmentId),
            eq(dbSchema.issueAttachment.createdById, input.user.id),
            isNull(dbSchema.issueAttachment.issueId),
          ),
        )
        .returning();

      if (updated) {
        await tx.insert(dbSchema.issueChangeEvent).values(
          buildChangeEvent(
            {
              issueId: input.issueId,
              workspaceId: input.workspaceId,
              actorId: input.user.id,
            },
            "attachment_added",
            attachmentId,
          ),
        );
      }
    }
  });
}

export async function createAttachment(input: {
  user: User;
  workspaceSlug: string;
  issueKey: string;
  filePath: string;
  mimeType: string;
  originalFileName: string;
}) {
  const { issue } = await getIssueByKey({
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
        filePath: input.filePath,
        mimeType: input.mimeType,
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

export async function getAttachmentById(input: {
  user: User;
  workspaceSlug: string;
  issueKey: string;
  attachmentId: string;
}) {
  const { issue } = await getIssueByKey({
    user: input.user,
    workspaceSlug: input.workspaceSlug,
    issueKey: input.issueKey,
  });

  return await db.query.issueAttachment.findFirst({
    where: and(
      eq(dbSchema.issueAttachment.issueId, issue.id),
      eq(dbSchema.issueAttachment.id, input.attachmentId),
    ),
  });
}

/**
 * Get attachment for serving - checks user can access via issue or owns orphan
 */
export async function getAttachmentForServing(input: {
  user: User;
  attachmentId: string;
}) {
  const attachment = await db.query.issueAttachment.findFirst({
    where: eq(dbSchema.issueAttachment.id, input.attachmentId),
    with: {
      issue: {
        with: {
          workspace: {
            with: {
              workspaceUsers: true,
            },
          },
        },
      },
    },
  });

  if (!attachment) {
    return null;
  }

  // Orphan attachment - only owner can access
  if (!attachment.issue) {
    if (attachment.createdById !== input.user.id) {
      return null;
    }
    return attachment;
  }

  // Check user is member of workspace
  const isMember = attachment.issue.workspace.workspaceUsers.some(
    (wu) => wu.userId === input.user.id,
  );

  if (!isMember) {
    return null;
  }

  return attachment;
}

export async function deleteAttachment(input: {
  user: User;
  workspaceSlug: string;
  issueKey: string;
  filePath: string;
}) {
  const { issue } = await getIssueByKey({
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
