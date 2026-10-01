import { useEffect, useState } from "react";
import { Outlet, redirect, useNavigate } from "react-router";
import { Menu as MenuIcon, WifiOff } from "lucide-react";
import { Button } from "~/components/ui/button";
import { CommandPalette } from "~/components/app/command-palette";
import { CreateIssueDialog } from "~/components/app/create-issue";
import { Dialog } from "~/components/ui/dialog";
import { Kbd } from "~/components/ui/tooltip";
import { Sidebar } from "~/components/app/sidebar";
import { ModalOverlay, Modal, Dialog as RACDialog } from "react-aria-components";
import { ApiError, workspaces } from "~/lib/api";
import { LAST_WS } from "~/lib/auth-guard";
import { WorkspaceProvider, useWorkspace } from "~/lib/workspace";
import { useT, type Key } from "~/lib/i18n";
import { useShortcutsEnabled } from "~/lib/shortcuts";
import type { Route } from "./+types/workspace";

export async function clientLoader({ params }: Route.ClientLoaderArgs) {
  try {
    const [w, members] = await Promise.all([workspaces.get(params.ws), workspaces.members(params.ws)]);
    localStorage.setItem(LAST_WS, params.ws);
    return { revision: w.revision, workspace: w.workspace, members };
  } catch (e) {
    if (e instanceof ApiError && (e.status === 404 || e.status === 403)) {
      localStorage.removeItem(LAST_WS);
      throw redirect("/");
    }
    throw e;
  }
}

export function shouldRevalidate({ currentParams, nextParams, currentUrl, nextUrl }: { currentParams: Record<string, string | undefined>; nextParams: Record<string, string | undefined>; currentUrl: URL; nextUrl: URL }) {
  return currentParams.ws !== nextParams.ws || currentUrl.href === nextUrl.href;
}

export default function WorkspaceLayout({ loaderData }: Route.ComponentProps) {
  return (
    <WorkspaceProvider initial={loaderData}>
      <Shell />
    </WorkspaceProvider>
  );
}

const SHORTCUTS: [string[], Key][] = [
  [["Ctrl/Cmd", "K"], "help.palette"], [["C"], "help.newIssue"], [["/"], "help.search"],
  [["G", "I"], "help.goInbox"], [["G", "M"], "help.goMine"], [["G", "A"], "help.goAll"], [["G", "P"], "help.goProjects"], [["G", "R"], "help.goReports"],
  [["Ctrl/Cmd", "Enter"], "help.send"],
];

function Shell() {
  const t = useT();
  const nav = useNavigate();
  const { ws, create, canWrite, offline, retrySync } = useWorkspace();
  const [shortcuts] = useShortcutsEnabled();
  const [palette, setPalette] = useState(false);
  const [help, setHelp] = useState(false);
  const [drawer, setDrawer] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      const typing = el.closest("input, textarea, select, [contenteditable=true], [role=dialog]");
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPalette((o) => !o);
      } else if (shortcuts && !typing && !e.metaKey && !e.ctrlKey && !e.altKey) {
        if (e.key === "c" && canWrite) { e.preventDefault(); create.show(); }
        if (e.key === "/") { e.preventDefault(); setPalette(true); }
        if (e.key === "g") {
          const once = (ev: KeyboardEvent) => {
            const map: Record<string, string> = { i: "inbox", m: "my-issues", a: "issues", p: "projects", r: "reports" };
            if (map[ev.key]) nav(`/${ws.id}/${map[ev.key]}`);
            window.removeEventListener("keydown", once);
          };
          window.addEventListener("keydown", once);
          setTimeout(() => window.removeEventListener("keydown", once), 1200);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [canWrite, create, nav, ws.id, shortcuts]);

  return (
    <div className="flex h-dvh overflow-hidden">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:m-2 focus:rounded-md focus:bg-card focus:px-3 focus:py-1.5">{t("nav.skip")}</a>
      <div className="hidden border-r border-border md:block"><Sidebar onSearch={() => setPalette(true)} /></div>
      <ModalOverlay isOpen={drawer} onOpenChange={setDrawer} isDismissable className="fixed inset-0 z-40 bg-black/40 md:hidden">
        <Modal className="h-full w-60 bg-sidebar shadow-xl entering:animate-in entering:slide-in-from-left exiting:animate-out exiting:slide-out-to-left">
          <RACDialog aria-label={t("nav.main")} className="h-full outline-none"><Sidebar onSearch={() => { setDrawer(false); setPalette(true); }} onNavigate={() => setDrawer(false)} /></RACDialog>
        </Modal>
      </ModalOverlay>
      <main id="main" className="flex min-w-0 flex-1 flex-col bg-background">
        <div className="flex h-11 items-center border-b border-border px-2 md:hidden">
          <Button variant="ghost" size="icon-lg" aria-label={t("nav.main")} onPress={() => setDrawer(true)}><MenuIcon /></Button>
          <span className="ml-1 truncate text-sm font-semibold">{ws.name}</span>
        </div>
        {offline && (
          <div role="status" className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-warning/40 bg-warning/15 px-4 py-1.5 text-xs">
            <WifiOff className="size-3.5 shrink-0" />
            <span className="flex-1">{t("error.offline")}</span>
            <Button size="sm" variant="ghost" onPress={retrySync}>{t("error.offlineRetry")}</Button>
          </div>
        )}
        <Outlet />
      </main>
      <CommandPalette open={palette} onOpenChange={setPalette} onHelp={() => setHelp(true)} />
      <CreateIssueDialog />
      <Dialog title={t("help.shortcuts")} description={t("help.shortcutsSub")} size="sm" isOpen={help} onOpenChange={setHelp}>
        <dl className="space-y-1.5 text-[13px]">
          {SHORTCUTS.map(([keys, label]) => (
            <div key={label} className="flex items-center justify-between gap-4">
              <dt>{t(label)}</dt>
              <dd className="flex items-center gap-1">{keys.map((k, i) => <span key={i} className="flex items-center gap-1">{i > 0 && <span className="text-xs text-muted-foreground">{t("help.then")}</span>}<Kbd>{k}</Kbd></span>)}</dd>
            </div>
          ))}
        </dl>
      </Dialog>
    </div>
  );
}
