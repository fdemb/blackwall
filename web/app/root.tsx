import { useEffect } from "react";
import { Links, Meta, Outlet, Scripts, ScrollRestoration, isRouteErrorResponse, useHref, useNavigate } from "react-router";
import { RouterProvider } from "react-aria-components";
import "./app.css";
import { ToastProvider } from "~/components/ui/toast";
import { I18nProvider, initialLanguage } from "~/lib/i18n";
import { watchSystemTheme } from "~/lib/theme";
import type { Route } from "./+types/root";

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="color-scheme" content="light dark" />
        <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
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
    <div className="grid h-dvh place-items-center">
      <div className="size-8 animate-pulse rounded-lg bg-primary" />
    </div>
  );
}

export default function App() {
  const navigate = useNavigate();
  useEffect(() => watchSystemTheme(), []);
  return (
    <RouterProvider navigate={navigate} useHref={useHref}>
      <I18nProvider initial={initialLanguage()}>
        <ToastProvider>
          <Outlet />
        </ToastProvider>
      </I18nProvider>
    </RouterProvider>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  const message = isRouteErrorResponse(error) ? `${error.status} ${error.statusText}` : error instanceof Error ? error.message : "Unknown error";
  return (
    <div className="grid h-dvh place-items-center p-6 text-center">
      <div>
        <h1 className="text-lg font-semibold">Something went wrong</h1>
        <p className="mt-1 text-muted-foreground">{message}</p>
        <a href="/" className="mt-4 inline-block text-primary hover:underline">Back to Blackwall</a>
      </div>
    </div>
  );
}
