import { Outlet, redirect } from "react-router";
import { Logo } from "~/components/app/logo";
import { LanguageToggle } from "~/components/app/preferences";
import { currentProfile } from "~/lib/auth-guard";

export async function clientLoader() {
  if (await currentProfile()) throw redirect("/");
  return null;
}

export default function AuthLayout() {
  return (
    <div className="relative grid min-h-dvh place-items-center overflow-hidden px-4 py-10">
      <div aria-hidden className="pointer-events-none absolute -top-40 left-1/2 size-[640px] -translate-x-1/2 rounded-full bg-primary/15 blur-3xl" />
      <div className="absolute right-4 top-4"><LanguageToggle /></div>
      <main className="relative w-full max-w-[360px]">
        <div className="mb-8 flex items-center gap-2.5">
          <Logo size={30} />
          <span className="text-lg font-semibold tracking-tight">Blackwall</span>
        </div>
        <Outlet />
      </main>
    </div>
  );
}
