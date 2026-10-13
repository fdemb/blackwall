import { useEffect } from "react";
import { Link, NavLink, Outlet, useLocation, useNavigate, useOutletContext } from "react-router";
import {
  ArrowLeft,
  ArrowUpDown,
  Bell,
  Building2,
  KeySquare,
  ChevronsUpDown,
  KeyRound,
  Plug,
  SlidersHorizontal,
  Tag,
  UserRound,
  Users,
  UsersRound,
  type LucideIcon,
} from "lucide-react";
import { Button } from "~/components/ui/button";
import {
  Header,
  Menu,
  MenuItem,
  MenuPopover,
  MenuSection,
  MenuTrigger,
} from "~/components/ui/menu";
import { Kbd } from "~/components/ui/tooltip";
import { OfflineBanner } from "~/components/app/offline-banner";
import { linkClass } from "~/components/app/sidebar";
import { lastAppPath } from "~/lib/settings-nav";
import { useI18n, type Key } from "~/lib/i18n";
import { useWorkspace } from "~/lib/workspace";
import type { WorkspaceOutlet } from "./workspace";

interface Item {
  path: string;
  label: Key;
  icon: LucideIcon;
}
interface Group {
  id: string;
  label: string;
  items: Item[];
}

/** Account and workspace settings in one full-screen place, bound to the current workspace. */
export default function SettingsLayout() {
  const { t } = useI18n();
  const nav = useNavigate();
  const ctx = useOutletContext<WorkspaceOutlet>();
  const { ws, canAdmin } = useWorkspace();
  const { pathname } = useLocation();
  const base = `/${ws.id}/settings`;
  const back = lastAppPath(ws.id);

  const groups: Group[] = [
    {
      id: "workspace",
      label: ws.name,
      items: [
        { path: "general", label: "settings.general", icon: Building2 },
        { path: "members", label: "settings.members", icon: Users },
        { path: "teams", label: "settings.teams", icon: UsersRound },
        { path: "labels", label: "settings.labels", icon: Tag },
        ...(canAdmin
          ? [{ path: "integrations", label: "settings.integrations", icon: Plug } as const]
          : []),
        { path: "data", label: "settings.data", icon: ArrowUpDown },
      ],
    },
    {
      id: "account",
      label: t("nav.account"),
      items: [
        { path: "profile", label: "account.profile", icon: UserRound },
        { path: "preferences", label: "account.preferences", icon: SlidersHorizontal },
        { path: "notifications", label: "account.alerts", icon: Bell },
        { path: "security", label: "account.security", icon: KeyRound },
        { path: "tokens", label: "account.tokens", icon: KeySquare },
      ],
    },
  ];
  const current = groups
    .flatMap((g) => g.items)
    .find((i) => pathname.startsWith(`${base}/${i.path}`));

  // Esc leaves settings, unless it's closing something or you're typing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      const el = e.target as HTMLElement;
      if (
        el.closest(
          "input, textarea, select, [contenteditable=true], [role=dialog], [role=menu], [role=listbox]",
        )
      )
        return;
      void nav(back);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [nav, back]);

  return (
    <div className="flex h-dvh overflow-hidden">
      <a
        href="#settings-main"
        className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:m-2 focus:rounded-md focus:bg-card focus:px-3 focus:py-1.5"
      >
        {t("nav.skip")}
      </a>
      <nav
        aria-label={t("nav.settings")}
        className="hidden w-60 shrink-0 flex-col border-r border-border bg-sidebar md:flex"
      >
        <div className="p-2">
          <Link
            to={back}
            className="flex h-8 items-center gap-2 rounded-md px-2  font-medium text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60"
          >
            <ArrowLeft className="size-4 shrink-0" />
            <span className="flex-1 truncate">{t("settings.back")}</span>
            <Kbd>Esc</Kbd>
          </Link>
        </div>
        <div className="flex-1 space-y-5 overflow-y-auto px-2 pb-4 pt-3">
          {groups.map((g) => (
            <div key={g.id} role="group" aria-labelledby={`settings-${g.id}`}>
              <h2
                id={`settings-${g.id}`}
                className="mb-1 truncate px-2  font-medium text-muted-foreground"
              >
                {g.label}
              </h2>
              <ul className="space-y-0.5">
                {g.items.map((i) => (
                  <li key={i.path}>
                    <NavLink to={`${base}/${i.path}`} className={linkClass}>
                      <i.icon />
                      <span className="truncate">{t(i.label)}</span>
                    </NavLink>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </nav>

      <main id="settings-main" className="flex min-w-0 flex-1 flex-col bg-background">
        <div className="flex h-11 shrink-0 items-center gap-1 border-b border-border px-2 md:hidden">
          <Button
            variant="ghost"
            size="icon-lg"
            aria-label={t("settings.back")}
            onPress={() => void nav(back)}
          >
            <ArrowLeft />
          </Button>
          <MenuTrigger>
            <Button
              variant="ghost"
              aria-label={t("settings.sections")}
              className="h-8 min-w-0 gap-1.5 px-2  font-semibold"
            >
              {current && <current.icon className="text-muted-foreground" />}
              <span className="truncate">{current ? t(current.label) : t("nav.settings")}</span>
              <ChevronsUpDown className="size-3.5 text-muted-foreground" />
            </Button>
            <MenuPopover placement="bottom start" className="w-60">
              <Menu
                aria-label={t("settings.sections")}
                selectionMode="single"
                selectedKeys={current ? [current.path] : []}
              >
                {groups.map((g) => (
                  <MenuSection key={g.id}>
                    <Header className="truncate px-2 pb-1 pt-2  font-medium text-muted-foreground">
                      {g.label}
                    </Header>
                    {g.items.map((i) => (
                      <MenuItem key={i.path} id={i.path} href={`${base}/${i.path}`}>
                        <i.icon />
                        {t(i.label)}
                      </MenuItem>
                    ))}
                  </MenuSection>
                ))}
              </Menu>
            </MenuPopover>
          </MenuTrigger>
        </div>
        <OfflineBanner />
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-3xl px-4 pb-16 pt-6 sm:px-6 md:pt-10">
            <Outlet context={ctx} />
          </div>
        </div>
      </main>
    </div>
  );
}
