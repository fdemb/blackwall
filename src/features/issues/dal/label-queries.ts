import { db, dbSchema } from "@/db";
import type { User } from "@/db/schema";
import { AppError } from "@/features/shared/errors";
import { and, eq } from "drizzle-orm";
import { WorkspaceQueries } from "../../workspaces/dal/queries";
import { IssueQueries } from "./issue-queries";

async function getForIssue(input: {
  user: User;
  workspaceSlug: string;
  issueKey: string;
}) {
  const { issue } = await IssueQueries.getByKey({
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

async function getById(input: {
  user: User;
  workspaceSlug: string;
  labelId: string;
}) {
  const workspace = await WorkspaceQueries.getForUser({
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

async function getAllForWorkspace(input: {
  user: User;
  workspaceSlug: string;
}) {
  const workspace = await WorkspaceQueries.getForUser({
    user: input.user,
    slug: input.workspaceSlug,
  });

  return db.query.label.findMany({
    where: eq(dbSchema.label.workspaceId, workspace.id),
  });
}

export const LabelQueries = {
  getForIssue,
  getById,
  getAllForWorkspace,
};
