import { SessionContext } from "@/context/session-context";
import { session } from "@/server/auth/api";
import { queryOptions } from "@tanstack/solid-query";
import { createFileRoute, Outlet, redirect } from "@tanstack/solid-router";

const sessionQueryOptions = queryOptions({
  queryKey: ["session"],
  queryFn: () => {
    return session();
  },
  staleTime: Infinity,
});

export const Route = createFileRoute("/_authorized")({
  component: RouteComponent,
  beforeLoad: async ({ context }) => {
    const data = await context.queryClient.ensureQueryData(sessionQueryOptions);

    if (!data) {
      throw redirect({
        to: "/signin",
      });
    }

    return {
      user: data.user,
      session: data.session,
    };
  },
});

function RouteComponent() {
  const ctx = Route.useRouteContext();

  return (
    <SessionContext.Provider value={ctx}>
      <Outlet />
    </SessionContext.Provider>
  );
}
