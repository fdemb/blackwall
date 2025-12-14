import { getPreferredTheme } from "@/features/auth/actions";
import { Toaster } from "@/features/shared/components/custom-ui/toast";
import { KeybindProvider } from "@/features/shared/context/keybind.context";
import { QueryClient } from "@tanstack/solid-query";
import { SolidQueryDevtools } from "@tanstack/solid-query-devtools";
import {
  HeadContent,
  Outlet,
  Scripts,
  createRootRouteWithContext,
} from "@tanstack/solid-router";
import { TanStackRouterDevtools } from "@tanstack/solid-router-devtools";
import { HydrationScript, Suspense } from "solid-js/web";
import styleCss from "../styles/globals.css?url";

export const Route = createRootRouteWithContext<{
  queryClient: QueryClient;
}>()({
  loader: async () => {
    const initialTheme = await getPreferredTheme();

    return {
      initialTheme,
    };
  },
  staleTime: Infinity,
  head: async ({ loaderData }) => {
    return {
      meta: [{ title: "Blackwall" }],
      links: [{ rel: "stylesheet", href: styleCss }],
      scripts: [
        {
          children: `
         if (! (window._setTheme)) {
          window._setTheme = (themeId) => {
            const elem = document.documentElement;
            elem.removeAttribute("data-theme");
            elem.removeAttribute("data-theme-system");

            if (themeId === "system") {
              const systemTheme = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
              elem.setAttribute("data-theme", systemTheme);
              elem.setAttribute("data-theme-system", "true");
            } else {
              elem.setAttribute("data-theme", themeId);
            }
          }
         }

          window._setTheme("${loaderData?.initialTheme ?? "system"}");
        `,
        },
      ],
    };
  },
  shellComponent: RootComponent,
});

function RootComponent() {
  return (
    <html>
      <head>
        <HydrationScript />
        <HeadContent />
      </head>
      <body>
        <Suspense>
          <KeybindProvider>
            <Outlet />
            <Toaster />
          </KeybindProvider>

          <TanStackRouterDevtools />
          <SolidQueryDevtools />
        </Suspense>
        <Scripts />
      </body>
    </html>
  );
}

declare global {
  interface Window {
    _setTheme: (themeId: string) => void;
  }
}
