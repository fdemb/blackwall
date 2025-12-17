import { db, dbSchema } from "@/db";
import type { User } from "@/db/schema";
import { createColorFromString } from "@/server/shared/colors";
import { AppError } from "@/server/shared/errors";
import {
  getWorkspaceBySlug,
  getWorkspaceForUser,
} from "@/server/workspace/data";
import { and, count, eq } from "drizzle-orm";
import { buildChangeEvent } from "./change-events";
import { getIssueByKey } from "./issues";

async function getLabelsForIssue(input: {
  user: User;
  workspaceSlug: string;
  issueKey: string;
}) {
  const { issue } = await getIssueByKey({
    user: input.user,
    workspaceSlug: input.workspaceSlug,
    issueKey: input.issueKey,
  });

  const labelOnIssues = await db.query.labelOnIssue.findMany({
    where: (table) => eq(table.issueId, issue.id),
    with: {
      label: true,
    },
  });

  return labelOnIssues.map((labelOnIssue) => labelOnIssue.label);
}

async function getLabelById(input: {
  user: User;
  workspaceSlug: string;
  labelId: string;
}) {
  const workspace = await getWorkspaceForUser({
    user: input.user,
    slug: input.workspaceSlug,
  });

  const label = await db.query.label.findFirst({
    where: and(
      eq(dbSchema.label.workspaceId, workspace.id),
      eq(dbSchema.label.id, input.labelId),
    ),
  });

  if (!label) {
    throw new AppError("NOT_FOUND", "Label not found.");
  }

  return label;
}

async function getAllLabelsForWorkspace(input: {
  user: User;
  workspaceSlug: string;
}) {
  const workspace = await getWorkspaceForUser({
    user: input.user,
    slug: input.workspaceSlug,
  });

  return db.query.label.findMany({
    where: eq(dbSchema.label.workspaceId, workspace.id),
  });
}

async function createLabel(input: {
  user: User;
  workspaceSlug: string;
  name: string;
}) {
  const workspace = await getWorkspaceBySlug(input.workspaceSlug);

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

async function addLabelToIssue(input: {
  user: User;
  workspaceSlug: string;
  issueKey: string;
  labelId: string;
}) {
  const { issue } = await getIssueByKey({
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
  const label = await getLabelById({
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

async function removeLabelFromIssue(input: {
  user: User;
  workspaceSlug: string;
  issueKey: string;
  labelId: string;
}) {
  const { issue } = await getIssueByKey({
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

export {
  addLabelToIssue,
  createLabel,
  getAllLabelsForWorkspace,
  getLabelById,
  getLabelsForIssue,
  removeLabelFromIssue,
};
