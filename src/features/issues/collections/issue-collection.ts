import { queryCollectionOptions } from "@tanstack/query-db-collection";
import { createCollection } from "@tanstack/solid-db";
import { useQueryClient } from "@tanstack/solid-query";
import { list } from "../issue-actions";

export const issueCollection = (workspaceSlug: string, teamKey?: string) =>
  createCollection(
    queryCollectionOptions({
      queryClient: useQueryClient(),
      queryKey: ["issues", workspaceSlug, teamKey],
      getKey: (issue) => issue.id,
      queryFn: async () => {
        const response = await list({
          data: {
            workspaceSlug,
            teamKey,
          },
        });

        return response;
      },
    }),
  );
