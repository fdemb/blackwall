import { session } from "@/features/auth/actions";
import { SessionContext } from "@/features/shared/context/session-context";
import { createFileRoute, Outlet, redirect } from "@tanstack/solid-router";

export const Route = createFileRoute("/_authorized")({
  component: RouteComponent,
  beforeLoad: async () => {
    const data = await session();

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
