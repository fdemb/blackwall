import { lazy, Suspense, useEffect } from "react";
import {
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  isRouteErrorResponse,
  useHref,
  useNavigate,
  Link,
} from "react-router";
import { RouterProvider } from "react-aria-components";
import { QueryClientProvider } from "@tanstack/react-query";
import "./app.css";
import { ToastProvider } from "~/components/ui/toast";
import { I18nProvider, initialLanguage, translate } from "~/lib/i18n";
import { queryClient } from "~/lib/query-client";
import { watchSystemTheme } from "~/lib/theme";
import type { Route } from "./+types/root";

/** Query cache inspector, only in development. Production builds drop the import entirely. */
const QueryDevtools = import.meta.env.DEV
  ? lazy(() =>
      import("@tanstack/react-query-devtools").then((m) => ({ default: m.ReactQueryDevtools })),
    )
  : () => null;

export function Layout({ children }: { children: React.ReactNode }) {
  // initialLanguage() mirrors public/theme.js, which already sets <html lang> before first paint.
  return (
    <html lang={initialLanguage()}>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="color-scheme" content="light dark" />
        <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
        {/* Intentionally render-blocking: applies the theme before first paint to avoid a flash. */}
        <script src="/theme.js" />
        <Meta />
        <Links />
      </head>
      <body>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export function meta() {
  return [{ title: "Blackwall" }];
}

export function HydrateFallback() {
  return (
    <div role="status" className="grid h-dvh place-items-center">
      <div className="size-8 animate-pulse rounded-lg bg-primary" />
    </div>
  );
}

export default function App() {
  const navigate = useNavigate();
  useEffect(() => watchSystemTheme(), []);
  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider navigate={navigate} useHref={useHref}>
        <I18nProvider initial={initialLanguage()}>
          <ToastProvider>
            <Outlet />
          </ToastProvider>
        </I18nProvider>
      </RouterProvider>
      <Suspense>
        <QueryDevtools buttonPosition="bottom-left" />
      </Suspense>
    </QueryClientProvider>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  // The error page replaces the app, including its i18n provider, so it reads the language directly.
  const lang = initialLanguage();
  const t = (key: Parameters<typeof translate>[1]) => translate(lang, key);
  const message = isRouteErrorResponse(error)
    ? `${error.status} ${error.statusText}`
    : error instanceof Error
      ? error.message
      : t("error.unknown");
  const action =
    "inline-flex h-9 items-center rounded-md px-3 text-[13px] font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring/60";
  return (
    <div role="alert" className="grid h-dvh place-items-center p-6 text-center">
      <div>
        <h1 className="text-lg font-semibold">{t("error.title")}</h1>
        <p className="mt-1 break-words text-muted-foreground">{message}</p>
        <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
          {/* Reloading retries the same page. Going home can land on the workspace that failed, so offer the picker too. */}
          <button
            type="button"
            onClick={() => location.reload()}
            className={`${action} bg-primary-solid text-primary-foreground hover:bg-primary-solid/90`}
          >
            {t("action.reload")}
          </button>
          <Link to="/welcome" className={`${action} border border-input hover:bg-muted`}>
            {t("error.switch")}
          </Link>
          <Link to="/" className={`${action} text-primary hover:underline`}>
            {t("error.home")}
          </Link>
        </div>
      </div>
    </div>
  );
}
