import { session } from "@/features/auth/actions";
import { AuthShell } from "@/features/shared/components/blocks/auth";
import { createFileRoute, Outlet, redirect } from "@tanstack/solid-router";

export const Route = createFileRoute("/_auth")({
  component: RouteComponent,
  beforeLoad: async () => {
    const data = await session();

    if (data) {
      throw redirect({
        to: "/",
      });
    }
  },
});

function RouteComponent() {
  return (
    <AuthShell>
      <Outlet />
    </AuthShell>
  );
}
