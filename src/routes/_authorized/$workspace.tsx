import { WorkspaceDataContext } from "@/features/shared/context/workspace-context";
import { getWorkspaceAndGlobalData } from "@/features/workspaces/actions";
import { queryOptions, useQuery } from "@tanstack/solid-query";
import { createFileRoute, Outlet, redirect } from "@tanstack/solid-router";
import { Show } from "solid-js";

const getWorkspaceAndGlobalDataQueryOptions = (workspaceSlug: string) =>
  queryOptions({
    queryKey: ["workspace", "data", workspaceSlug],
    queryFn: () => getWorkspaceAndGlobalData({ data: workspaceSlug }),
  });

export const Route = createFileRoute("/_authorized/$workspace")({
  component: RouteComponent,
  beforeLoad: async ({ params, context }) => {
    try {
      return await context.queryClient.ensureQueryData(
        getWorkspaceAndGlobalDataQueryOptions(params.workspace),
      );
    } catch (error) {
      throw redirect({
        to: "/",
      });
    }
  },
});

function RouteComponent() {
  const params = Route.useParams();
  const workspaceQuery = useQuery(() =>
    getWorkspaceAndGlobalDataQueryOptions(params().workspace),
  );

  const workspaceData = () => workspaceQuery.data;

  return (
    <Show when={workspaceData()}>
      {(data) => (
        <WorkspaceDataContext.Provider value={data()}>
          <Outlet />
        </WorkspaceDataContext.Provider>
      )}
    </Show>
  );
}
