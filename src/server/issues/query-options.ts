import { listUsers } from "@/server/team/api";
import { queryOptions } from "@tanstack/solid-query";

export const getAssignableUsersQueryOptions = (
  workspaceSlug: string,
  teamKey: string,
) =>
  queryOptions({
    queryKey: ["issue", "assignableUsers", workspaceSlug, teamKey],
    queryFn: async () => {
      return await listUsers({
        data: {
          workspaceSlug,
          teamKey,
        },
      });
    },
  });
