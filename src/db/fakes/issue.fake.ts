import {
  type CreateIssueInput,
  IssueMutations,
} from "@/features/issues/dal/mutations";
import { faker } from "@faker-js/faker";
import { db } from "..";
import type { Issue } from "../schema";

export function issueFake(): CreateIssueInput {
  return {
    summary: faker.lorem.sentence(),
    status: "to_do",
    description: {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: faker.lorem.sentence(),
            },
          ],
        },
      ],
    },
  };
}

export async function issueFactory(count = 1): Promise<Issue[]> {
  const user = await db.query.user.findFirst();
  const workspace = await db.query.workspace.findFirst();
  const team = await db.query.team.findFirst();

  if (!user || !workspace || !team) {
    throw new Error("User, workspace or team not found");
  }

  const issues: Issue[] = [];

  for (let i = 0; i < count; i++) {
    issues.push(
      await IssueMutations.create({
        issue: issueFake(),
        user,
        workspaceSlug: workspace.slug,
        teamKey: team.key,
      }),
    );
  }

  return issues;
}
