import { db, dbSchema } from "@/db";
import type { User } from "@/db/schema";
import queue from "@/lib/queueing";
import { buildChangeEvent } from "./change-events";
import { getIssueByKey } from "./issues";

async function createComment(input: {
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

export { createComment };
