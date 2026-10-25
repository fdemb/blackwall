import { useEffect } from "react";
import { Outlet, redirect } from "react-router";
import { landing, signInFor } from "~/lib/auth-guard";
import { SessionProvider } from "~/lib/session";
import { applyTheme } from "~/lib/theme";
import { useI18n } from "~/lib/i18n";
import type { Route } from "./+types/authed";

export async function clientLoader({ request }: Route.ClientLoaderArgs) {
  try {
    return await landing();
  } catch (error) {
    if (error instanceof Response && error.headers.get("Location") === "/login")
      throw redirect(signInFor(request.url));
    throw error;
  }
}

export function shouldRevalidate({ currentUrl, nextUrl }: { currentUrl: URL; nextUrl: URL }) {
  return currentUrl.href === nextUrl.href;
}

export default function Authed({ loaderData }: Route.ComponentProps) {
  const { setLang } = useI18n();
  useEffect(() => {
    setLang(loaderData.profile.language);
    applyTheme(loaderData.profile.theme);
  }, [loaderData.profile.language, loaderData.profile.theme, setLang]);
  return (
    <SessionProvider initial={loaderData.profile}>
      <Outlet context={{ workspaces: loaderData.list }} />
    </SessionProvider>
  );
}
