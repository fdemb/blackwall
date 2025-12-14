import { db, dbSchema } from "@/db";
import type { User } from "@/db/schema";
import { createColorFromString } from "@/features/shared/colors";
import { AppError } from "@/features/shared/errors";
import { and, count, eq } from "drizzle-orm";
import { WorkspaceQueries } from "../../workspaces/dal/queries";
import { buildChangeEvent } from "../change-events";
import { IssueQueries } from "./issue-queries";
import { LabelQueries } from "./label-queries";

async function create(input: {
  user: User;
  workspaceSlug: string;
  name: string;
}) {
  const workspace = await WorkspaceQueries.getBySlug(input.workspaceSlug);

  const existingLabel = await db.query.label.findFirst({
    where: and(
      eq(dbSchema.label.workspaceId, workspace.id),
      eq(dbSchema.label.name, input.name),
    ),
  });

  if (existingLabel) {
    throw new AppError("BAD_REQUEST", "Label with this name already exists.");
  }

  const [label] = await db
    .insert(dbSchema.label)
    .values({
      name: input.name,
      workspaceId: workspace.id,
      colorKey: createColorFromString(input.name),
    })
    .returning();

  if (!label) {
    throw new AppError("INTERNAL_SERVER_ERROR", "Label couldn't be created.");
  }

  return label;
}

async function addToIssue(input: {
  user: User;
  workspaceSlug: string;
  issueKey: string;
  labelId: string;
}) {
  const { issue } = await IssueQueries.getByKey({
    user: input.user,
    workspaceSlug: input.workspaceSlug,
    issueKey: input.issueKey,
  });

  const [labelCount] = await db
    .select({
      count: count(),
    })
    .from(dbSchema.labelOnIssue)
    .where(eq(dbSchema.labelOnIssue.issueId, issue.id));

  if (!labelCount || labelCount.count >= 100) {
    throw new AppError(
      "BAD_REQUEST",
      "The issue has a maximum amount of labels.",
    );
  }
  const label = await LabelQueries.getById({
    user: input.user,
    workspaceSlug: input.workspaceSlug,
    labelId: input.labelId,
  });

  await db.transaction(async (tx) => {
    await tx.insert(dbSchema.labelOnIssue).values({
      issueId: issue.id,
      labelId: label.id,
    });

    await tx.insert(dbSchema.issueChangeEvent).values(
      buildChangeEvent(
        {
          issueId: issue.id,
          workspaceId: issue.workspaceId,
          actorId: input.user.id,
        },
        "label_added",
        label.id,
      ),
    );
  });
}

async function removeFromIssue(input: {
  user: User;
  workspaceSlug: string;
  issueKey: string;
  labelId: string;
}) {
  const { issue } = await IssueQueries.getByKey({
    user: input.user,
    workspaceSlug: input.workspaceSlug,
    issueKey: input.issueKey,
  });

  await db.transaction(async (tx) => {
    await tx
      .delete(dbSchema.labelOnIssue)
      .where(
        and(
          eq(dbSchema.labelOnIssue.issueId, issue.id),
          eq(dbSchema.labelOnIssue.labelId, input.labelId),
        ),
      );

    await tx.insert(dbSchema.issueChangeEvent).values(
      buildChangeEvent(
        {
          issueId: issue.id,
          workspaceId: issue.workspaceId,
          actorId: input.user.id,
        },
        "label_removed",
        input.labelId,
      ),
    );
  });
}

export const LabelMutations = {
  create,
  addToIssue,
  removeFromIssue,
};
