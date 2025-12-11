import { session } from "@/features/auth/actions";
import { AuthShell } from "@/features/shared/components/blocks/auth";
import { FastLink } from "@/features/shared/components/custom-ui/fast-link";
import { buttonVariants } from "@/features/shared/components/ui/button";
import { createFileRoute, Outlet } from "@tanstack/solid-router";
import ChevronLeftIcon from "lucide-solid/icons/chevron-left";
import { Show } from "solid-js";

export const Route = createFileRoute("/_either")({
  component: RouteComponent,
  beforeLoad: async () => {
    const data = await session();

    return {
      user: data?.user,
    };
  },
});

function RouteComponent() {
  const sessionData = Route.useRouteContext();

  return (
    <AuthShell>
      <Show when={sessionData()?.user}>
        {(user) => (
          <div class="absolute top-4 right-4 z-10 bg-background p-2 border">
            <p class="flex flex-row gap-1">
              Logged in as
              <strong class="font-semibold">{user().email}</strong>
            </p>
          </div>
        )}
      </Show>

      <div class="absolute top-4 left-4 z-10">
        <FastLink
          to="/"
          class={buttonVariants({ variant: "ghost", size: "sm" })}
        >
          <ChevronLeftIcon class="size-4" />
          Back
        </FastLink>
      </div>

      <Outlet />
    </AuthShell>
  );
}
