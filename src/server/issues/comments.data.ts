import { db, dbSchema } from "@/db";
import type { User } from "@/db/schema";
import queue from "@/lib/queueing";
import { and, eq } from "drizzle-orm";
import { AppError } from "../shared/errors";
import { buildChangeEvent } from "./change-events";
import { getIssueByKey } from "./issues.data";

export async function createComment(input: {
  user: User;
  workspaceSlug: string;
  issueKey: string;
  content: any;
}) {
  const { issue } = await getIssueByKey({
    user: input.user,
    workspaceSlug: input.workspaceSlug,
    issueKey: input.issueKey,
  });

  const comment = await db.transaction(async (tx) => {
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

  queue.add("general", {
    type: "issue-comment-created",
    data: {
      comment,
    },
  });

  return comment;
}

export async function softDeleteComment(input: {
  user: User;
  workspaceSlug: string;
  issueKey: string;
  commentId: string;
}) {
  const { issue } = await getIssueByKey({
    user: input.user,
    workspaceSlug: input.workspaceSlug,
    issueKey: input.issueKey,
  });

  const comment = await db.query.issueComment.findFirst({
    where: and(
      eq(dbSchema.issueComment.id, input.commentId),
      eq(dbSchema.issueComment.issueId, issue.id),
    ),
  });

  if (!comment) {
    throw new AppError("NOT_FOUND", "Comment not found.");
  }

  await db.transaction(async (tx) => {
    await tx
      .update(dbSchema.issueComment)
      .set({ deletedAt: new Date() })
      .where(eq(dbSchema.issueComment.id, comment.id));

    await tx.insert(dbSchema.issueChangeEvent).values(
      buildChangeEvent(
        {
          issueId: issue.id,
          workspaceId: issue.workspaceId,
          actorId: input.user.id,
        },
        "comment_deleted",
        comment.id,
      ),
    );
  });
}
