import { getPreferredTheme } from "@/features/auth/actions";
import { Toaster } from "@/features/shared/components/custom-ui/toast";
import { KeybindProvider } from "@/features/shared/context/keybind.context";
import "@fontsource-variable/outfit";
import {
  HeadContent,
  Outlet,
  Scripts,
  createRootRouteWithContext,
} from "@tanstack/solid-router";
import { TanStackRouterDevtools } from "@tanstack/solid-router-devtools";
import { HydrationScript, Suspense } from "solid-js/web";
import styleCss from "../styles/globals.css?url";

export const Route = createRootRouteWithContext()({
  loader: async () => {
    return {
      theme: await getPreferredTheme(),
    };
  },
  head: ({ loaderData }) => ({
    meta: [{ title: "Blackwall" }],
    links: [
      { rel: "stylesheet", href: styleCss },
      { rel: "preconnect", href: "https://rsms.me/" },
      { rel: "stylesheet", href: "https://rsms.me/inter/inter.css" },
    ],
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

        window._setTheme("${loaderData?.theme || "system"}");
        `,
      },
    ],
  }),
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
