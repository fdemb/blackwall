import { useState } from "react";
import { Link, NavLink, useLocation, useNavigate, useOutletContext } from "react-router";
import { Disclosure, DisclosurePanel, Heading } from "react-aria-components";
import {
  BarChart3,
  Check,
  ChevronDown,
  ChevronRight,
  FolderKanban,
  Inbox,
  LogOut,
  Plus,
  Search,
  Settings,
  SquarePen,
  Trash2,
  Archive,
  UserRound,
  Users,
  Layers,
  Eye,
  UserCog,
  Building2,
} from "lucide-react";
import { Avatar } from "~/components/ui/avatar";
import { Button } from "~/components/ui/button";
import { Kbd } from "~/components/ui/tooltip";
import { Menu, MenuItem, MenuPopover, MenuSeparator, MenuTrigger } from "~/components/ui/menu";
import { LAST_WS } from "~/lib/auth-guard";
import { useI18n } from "~/lib/i18n";
import { useSession } from "~/lib/session";
import { useWorkspace } from "~/lib/workspace";
import { cn } from "~/lib/utils";
import type { WorkspaceSummary } from "~/lib/types";
import { Logo } from "./logo";
import { ThemeToggle } from "./preferences";

export const linkClass = ({ isActive }: { isActive: boolean }) =>
  cn(
    "flex h-7 items-center gap-2 rounded-md px-2 text-[13px] font-medium text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 [&_svg]:size-4 [&_svg]:shrink-0",
    isActive && "bg-accent text-accent-foreground hover:bg-accent",
  );

export function Sidebar({
  onSearch,
  onNavigate,
}: {
  onSearch: () => void;
  onNavigate?: () => void;
}) {
  const { t } = useI18n();
  const nav = useNavigate();
  const { ws, unread, create, canWrite } = useWorkspace();
  const { profile, logout } = useSession();
  const { workspaces } = useOutletContext<{ workspaces: WorkspaceSummary[] }>();
  const base = `/${ws.id}`;
  const myTeams = ws.teams.filter((tm) => tm.members.includes(profile.id));
  const otherTeams = ws.teams.filter((tm) => !tm.members.includes(profile.id));

  return (
    // Delegation only closes the drawer on navigation: links stay semantic NavLink/Link elements,
    // and this handler never prevents or reroutes them.
    <nav
      aria-label={t("nav.main")}
      onClick={(e) => (e.target as HTMLElement).closest("a") && onNavigate?.()}
      className="flex h-full w-60 shrink-0 flex-col bg-sidebar"
    >
      <div className="flex items-center gap-1 p-2">
        <MenuTrigger>
          <Button
            variant="ghost"
            className="h-8 min-w-0 flex-1 justify-start gap-2 px-1.5 text-sm font-semibold"
          >
            <Logo size={20} />
            <span className="truncate">{ws.name}</span>
            <ChevronDown aria-hidden className="ml-auto size-3.5 text-muted-foreground" />
          </Button>
          <MenuPopover placement="bottom start" className="w-60">
            <Menu
              onAction={(k) => {
                if (k === "new") void nav("/welcome");
                else if (k === "signout") void logout();
                else if (k === "account") void nav(`${base}/settings/profile`);
                else if (k === "settings") void nav(`${base}/settings/general`);
                else if (String(k).startsWith("ws:")) {
                  const id = String(k).slice(3);
                  localStorage.setItem(LAST_WS, id);
                  void nav(`/${id}/my-issues`);
                }
              }}
            >
              <MenuItem id="hdr" isDisabled textValue={profile.email}>
                <span className="truncate text-xs text-muted-foreground">{profile.email}</span>
              </MenuItem>
              <MenuSeparator />
              {workspaces.map((w) => (
                <MenuItem key={w.id} id={`ws:${w.id}`} textValue={w.name}>
                  <Building2 aria-hidden />
                  <span className="flex-1 truncate">{w.name}</span>
                  {w.id === ws.id && <Check aria-hidden className="!text-primary" />}
                </MenuItem>
              ))}
              <MenuItem id="new">
                <Plus aria-hidden />
                {t("workspace.newOrJoin")}
              </MenuItem>
              <MenuSeparator />
              <MenuItem id="settings">
                <Settings aria-hidden />
                {t("nav.settings")}
              </MenuItem>
              <MenuItem id="account">
                <UserCog aria-hidden />
                {t("nav.account")}
              </MenuItem>
              <MenuItem id="signout">
                <LogOut aria-hidden />
                {t("nav.signOut")}
              </MenuItem>
            </Menu>
          </MenuPopover>
        </MenuTrigger>
        <Button variant="ghost" size="icon-lg" aria-label={t("search.title")} onPress={onSearch}>
          <Search aria-hidden />
        </Button>
        {canWrite && (
          <Button
            variant="subtle"
            size="icon-lg"
            aria-label={t("issue.new")}
            onPress={() => create.show()}
          >
            <SquarePen aria-hidden />
          </Button>
        )}
      </div>

      <div className="flex-1 space-y-4 overflow-y-auto px-2 pb-2 pt-1">
        <div className="space-y-0.5">
          <NavLink to={`${base}/inbox`} className={linkClass}>
            <Inbox aria-hidden />
            {t("nav.inbox")}
            {unread > 0 && (
              <span className="ml-auto rounded-full bg-primary-solid px-1.5 text-[11px] font-semibold tabular-nums text-primary-foreground">
                {unread}
              </span>
            )}
          </NavLink>
          <NavLink to={`${base}/my-issues`} className={linkClass}>
            <UserRound aria-hidden />
            {t("nav.myIssues")}
          </NavLink>
        </div>

        <Section title={t("nav.workspace")}>
          <NavLink to={`${base}/issues`} end className={linkClass}>
            <Layers aria-hidden />
            {t("nav.allIssues")}
          </NavLink>
          <NavLink to={`${base}/projects`} className={linkClass}>
            <FolderKanban aria-hidden />
            {t("nav.projects")}
          </NavLink>
          <NavLink to={`${base}/people`} className={linkClass}>
            <Users aria-hidden />
            {t("nav.people")}
          </NavLink>
          <NavLink to={`${base}/reports`} className={linkClass}>
            <BarChart3 aria-hidden />
            {t("nav.reports")}
          </NavLink>
        </Section>

        <Section title={t("nav.teams")}>
          {[...myTeams, ...otherTeams].map((tm) => (
            <TeamLinks key={tm.id} id={tm.id} name={tm.name} base={base} />
          ))}
          {ws.teams.length === 0 && (
            <Link
              to={`${base}/settings/teams`}
              className="block px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
            >
              {t("team.createFirst")}
            </Link>
          )}
        </Section>

        {ws.views.length > 0 && (
          <Section title={t("nav.views")}>
            {ws.views.map((v) => (
              <NavLink key={v.id} to={`${base}/views/${v.id}`} className={linkClass}>
                <Eye aria-hidden />
                <span className="truncate">{v.name}</span>
              </NavLink>
            ))}
          </Section>
        )}
      </div>

      <div className="flex items-center gap-0.5 border-t border-border p-2">
        <NavLink
          to={`${base}/settings/profile`}
          className={(s) => cn(linkClass(s), "min-w-0 flex-1")}
        >
          <Avatar name={profile.display_name} src={profile.avatar_url} size={18} />
          <span className="truncate">{profile.display_name}</span>
        </NavLink>
        <NavLink
          to={`${base}/archive`}
          aria-label={t("nav.archive")}
          className={(s) => cn(linkClass(s), "size-7 justify-center px-0")}
        >
          <Archive aria-hidden />
        </NavLink>
        <NavLink
          to={`${base}/trash`}
          aria-label={t("nav.trash")}
          className={(s) => cn(linkClass(s), "size-7 justify-center px-0")}
        >
          <Trash2 aria-hidden />
        </NavLink>
        <NavLink
          to={`${base}/settings/general`}
          aria-label={t("nav.settings")}
          className={(s) => cn(linkClass(s), "size-7 justify-center px-0")}
        >
          <Settings aria-hidden />
        </NavLink>
        <ThemeToggle />
      </div>
    </nav>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(true);
  return (
    <Disclosure isExpanded={open} onExpandedChange={setOpen}>
      <Heading>
        <Button
          slot="trigger"
          variant="ghost"
          className="mb-0.5 h-6 w-full justify-start gap-1 px-2 text-xs font-medium text-muted-foreground"
        >
          {title}
          <ChevronRight
            aria-hidden
            className={cn("size-3 transition-transform", open && "rotate-90")}
          />
        </Button>
      </Heading>
      <DisclosurePanel>
        <div className="space-y-0.5">{children}</div>
      </DisclosurePanel>
    </Disclosure>
  );
}

function TeamLinks({ id, name, base }: { id: string; name: string; base: string }) {
  const { t } = useI18n();
  const { pathname } = useLocation();
  const { ws } = useWorkspace();
  // null follows the route (open while you're inside the team). Once clicked, the choice sticks.
  const [open, setOpen] = useState<boolean | null>(null);
  const inTeam = pathname.startsWith(`${base}/team/${id}`);
  const isOpen = open ?? inTeam;
  const sprints = `${base}/team/${id}/sprints`;
  const onSprints = pathname.startsWith(sprints);
  const active = ws.sprints.find((s) => s.team_id === id && s.state === "active");
  const onActive = !!active && pathname === `${sprints}/${active.id}`;
  return (
    <div>
      <button
        type="button"
        aria-expanded={isOpen}
        onClick={() => setOpen(!isOpen)}
        className="flex h-7 w-full items-center gap-2 rounded-md px-2 text-[13px] font-medium text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60"
      >
        <span className="grid size-4 place-items-center rounded bg-accent text-[10px] font-bold text-accent-foreground">
          {name[0]?.toUpperCase()}
        </span>
        <span className="truncate">{name}</span>
        <ChevronRight
          aria-hidden
          className={cn("ml-auto size-3 transition-transform", isOpen && "rotate-90")}
        />
      </button>
      {isOpen && (
        <div className="ml-4 mt-0.5 space-y-0.5 border-l border-border pl-2">
          <Link to={`${base}/team/${id}`} className={linkClass({ isActive: inTeam && !onSprints })}>
            {t("team.issues")}
          </Link>
          <Link to={sprints} className={linkClass({ isActive: onSprints && !onActive })}>
            {t("team.sprints")}
          </Link>
          {active && (
            <Link
              to={`${sprints}/${active.id}`}
              aria-current={onActive ? "page" : undefined}
              className={linkClass({ isActive: onActive })}
            >
              <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-primary" />
              <span className="truncate">{active.name}</span>
            </Link>
          )}
        </div>
      )}
    </div>
  );
}
export { Kbd };
