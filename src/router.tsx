import { QueryClient } from "@tanstack/solid-query";
import {
  createRouter as createTanstackRouter,
  ErrorComponentProps,
} from "@tanstack/solid-router";
import { setupRouterSsrQueryIntegration } from "@tanstack/solid-router-ssr-query";
import BugIcon from "lucide-solid/icons/bug";
import { onMount } from "solid-js";
import { routeTree } from "./routeTree.gen";

export function createRouter() {
  const queryClient = new QueryClient();
  //   {
  //   defaultOptions: {
  //     queries: {
  //       experimental_prefetchInRender: true,
  //     },
  //   },
  // }

  const router = createTanstackRouter({
    routeTree,
    context: {
      queryClient,
    },
    scrollRestoration: true,
    defaultPreload: "intent",
    defaultPreloadStaleTime: 0,
    defaultErrorComponent: ErrorComponent,
  });

  setupRouterSsrQueryIntegration({
    router,
    queryClient,
  });

  return router;
}

function ErrorComponent(props: ErrorComponentProps) {
  onMount(() => {
    console.error(props.error);
  });

  return (
    <div class="flex flex-col min-h-screen items-center justify-center gap-2 bg-background">
      <div class="bg-background max-w-lg border border-destructive shadow-sm min-w-96">
        <div class="p-4 border-b w-full text-center flex flex-col items-center gap-1 text-destructive">
          <BugIcon class="size-6" />
          <h1 class="text-xl font-semibold">Application Error</h1>
        </div>
        <div class="p-4 text-center text-sm min-h-24 flex items-center justify-center whitespace-wrap bg-surface">
          <code>{props.error.message}</code>
        </div>
        <div class="p-4 border-t text-xs text-center text-muted-foreground">
          Check console for details.
        </div>
      </div>
    </div>
  );
}

// Create a new router instance
export const getRouter = () => {
  const router = createRouter();
  return router;
};
