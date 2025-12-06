import { getTeam } from "@/features/teams/actions";
import { queryOptions } from "@tanstack/solid-query";
import { createFileRoute, notFound, Outlet } from "@tanstack/solid-router";

export const getTeamQueryOptions = (
  workspaceSlug: string,
  teamKey: string,
) =>
  queryOptions({
    queryKey: ["team", "get", workspaceSlug, teamKey],
    queryFn: () =>
      getTeam({
        data: {
          workspaceSlug,
          teamKey,
        },
      }),
  });

export const Route = createFileRoute("/_authorized/$workspace/_main/team/$teamKey")({
  component: RouteComponent,
  beforeLoad: async ({ params, context }) => {
    const team = await context.queryClient.ensureQueryData(
      getTeamQueryOptions(params.workspace, params.teamKey),
    );

    if (!team) {
      throw notFound();
    }

    return {
      team,
    };
  },
});

function RouteComponent() {
  return <Outlet />;
}
