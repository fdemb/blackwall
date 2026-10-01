import { NavLink, Outlet } from "react-router";
import { Page, PageHeader, Scroll } from "~/components/app/page";
import { useT } from "~/lib/i18n";
import { useWorkspace } from "~/lib/workspace";
import { cn } from "~/lib/utils";

export default function Settings() {
  const t = useT();
  const { ws } = useWorkspace();
  const tabs = [
    ["", t("settings.general"), true], ["members", t("settings.members"), false], ["teams", t("settings.teams"), false],
    ["labels", t("settings.labels"), false], ["integrations", t("settings.integrations"), false], ["data", t("settings.data"), false],
  ] as const;
  return (
    <Page>
      <PageHeader title={t("nav.settings")} subtitle={ws.name}>
        <nav aria-label={t("nav.settings")} className="flex gap-1 overflow-x-auto px-4 pb-2">
          {tabs.map(([to, label, end]) => (
            <NavLink key={to} to={`/${ws.id}/settings/${to}`} end={end} className={({ isActive }) => cn("rounded-md px-2.5 py-1 text-[13px] font-medium text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60", isActive && "bg-accent text-accent-foreground hover:bg-accent")}>{label}</NavLink>
          ))}
        </nav>
      </PageHeader>
      <Scroll><div className="mx-auto max-w-3xl space-y-5 p-6"><Outlet /></div></Scroll>
    </Page>
  );
}
