import { Outlet, redirect } from "react-router";
import { AuthPreview } from "~/components/app/auth-preview";
import { Logo } from "~/components/app/logo";
import { LanguageToggle } from "~/components/app/preferences";
import { currentProfile } from "~/lib/auth-guard";
import { useI18n } from "~/lib/i18n";

export async function clientLoader() {
  if (await currentProfile()) throw redirect("/");
  return null;
}

export default function AuthLayout() {
  const { t } = useI18n();
  return (
    <div className="flex min-h-dvh lg:h-dvh">
      <div className="flex min-w-0 flex-1 flex-col gap-10 px-6 py-6 sm:px-12 sm:py-8 lg:w-[640px] lg:flex-none lg:overflow-y-auto">
        <header className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <Logo size={28} />
            <span className="text-lg font-semibold tracking-tight">Blackwall</span>
          </div>
          <LanguageToggle />
        </header>
        <main className="mx-auto flex w-full max-w-[360px] flex-1 flex-col justify-center">
          <Outlet />
        </main>
        <p className="text-balance text-center text-sm text-muted-foreground">
          {t("auth.inviteHint")}
        </p>
      </div>
      <aside aria-hidden className="hidden min-w-0 flex-1 py-3 pr-3 lg:flex">
        <div className="relative flex min-w-0 flex-1 flex-col justify-between gap-12 overflow-hidden rounded-2xl border border-primary/15 bg-linear-160 from-accent to-primary/15 pl-14 pt-14 dark:from-primary/15 dark:to-background">
          <div className="pointer-events-none absolute -right-40 -top-48 size-[560px] rounded-full bg-primary/20 blur-3xl" />
          <div className="relative flex max-w-[440px] flex-col gap-3">
            <p className="text-balance text-4xl font-semibold tracking-tight text-accent-foreground">
              {t("auth.pitchTitle")}
            </p>
            <p className="text-pretty text-[14px] leading-[22px] text-accent-foreground/75">
              {t("auth.pitchBody")}
            </p>
          </div>
          <AuthPreview />
        </div>
      </aside>
    </div>
  );
}
