import { useEffect, useRef, useState } from "react";
import { Outlet, redirect, useNavigate, useOutletContext } from "react-router";
import { CommandPalette } from "~/components/app/command-palette";
import { CreateIssueDialog } from "~/components/app/create-issue";
import { Dialog } from "~/components/ui/dialog";
import { Kbd } from "~/components/ui/tooltip";
import { ApiError } from "~/lib/api";
import { preloadWorkspace } from "~/lib/db";
import { queryClient } from "~/lib/query-client";
import { startChangeFeed } from "~/lib/sync";
import { clearLastWs, writeLastWs } from "~/lib/auth-guard";
import { WorkspaceProvider, useWorkspace } from "~/lib/workspace";
import { useI18n, type Key } from "~/lib/i18n";
import { useShortcutsEnabled } from "~/lib/shortcuts";
import type { WorkspaceSummary } from "~/lib/types";
import type { Route } from "./+types/workspace";

export async function clientLoader({ params }: Route.ClientLoaderArgs) {
  try {
    // The cursor comes first, so changes made while the records load still reach the client.
    await startChangeFeed(params.ws);
    await preloadWorkspace(queryClient, params.ws);
    writeLastWs(params.ws);
    return { id: params.ws };
  } catch (e) {
    if (e instanceof ApiError && (e.status === 404 || e.status === 403)) {
      clearLastWs();
      throw redirect("/");
    }
    throw e;
  }
}

export function shouldRevalidate({
  currentParams,
  nextParams,
  currentUrl,
  nextUrl,
}: {
  currentParams: Record<string, string | undefined>;
  nextParams: Record<string, string | undefined>;
  currentUrl: URL;
  nextUrl: URL;
}) {
  return currentParams.ws !== nextParams.ws || currentUrl.href === nextUrl.href;
}

export default function WorkspaceLayout({ loaderData }: Route.ComponentProps) {
  return (
    <WorkspaceProvider key={loaderData.id} id={loaderData.id}>
      <Workspace />
    </WorkspaceProvider>
  );
}

/** What the app shell and the settings screen read from `useOutletContext`. */
export interface WorkspaceOutlet {
  workspaces: WorkspaceSummary[];
  openPalette: () => void;
}

const SHORTCUTS: [string[], Key][] = [
  [["Ctrl/Cmd", "K"], "help.palette"],
  [["C"], "help.newIssue"],
  [["/"], "help.search"],
  [["G", "I"], "help.goInbox"],
  [["G", "M"], "help.goMine"],
  [["G", "A"], "help.goAll"],
  [["G", "P"], "help.goProjects"],
  [["G", "R"], "help.goReports"],
  [["Ctrl/Cmd", "Enter"], "help.send"],
];

/** Keyboard shortcuts and the overlays that work everywhere in a workspace, including settings. */
function Workspace() {
  const { t } = useI18n();
  const nav = useNavigate();
  const { workspaces } = useOutletContext<{ workspaces: WorkspaceSummary[] }>();
  const { ws, create, canWrite } = useWorkspace();
  const [shortcuts] = useShortcutsEnabled();
  const [palette, setPalette] = useState(false);
  const [help, setHelp] = useState(false);
  // The keydown handler reads through a ref so the single window listener never re-registers.
  const keyState = useRef({ canWrite, shortcuts, wsId: ws.id, show: create.show, nav });
  useEffect(() => {
    keyState.current = { canWrite, shortcuts, wsId: ws.id, show: create.show, nav };
  });
  const gTimer = useRef(0);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      const typing = el.closest("input, textarea, select, [contenteditable=true], [role=dialog]");
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPalette((o) => !o);
        return;
      }
      const { canWrite: writable, shortcuts: enabled, wsId, show, nav: go } = keyState.current;
      if (!enabled || typing || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "c" && writable) {
        e.preventDefault();
        show();
      } else if (e.key === "/") {
        e.preventDefault();
        setPalette(true);
      } else if (e.key === "g") {
        const once = (ev: KeyboardEvent) => {
          const map: Record<string, string> = {
            i: "inbox",
            m: "my-issues",
            a: "issues",
            p: "projects",
            r: "reports",
          };
          if (map[ev.key]) void go(`/${wsId}/${map[ev.key]}`);
          window.removeEventListener("keydown", once);
          window.clearTimeout(gTimer.current);
        };
        window.addEventListener("keydown", once);
        window.clearTimeout(gTimer.current);
        gTimer.current = window.setTimeout(() => window.removeEventListener("keydown", once), 1200);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.clearTimeout(gTimer.current);
    };
  }, []);

  return (
    <>
      <Outlet
        context={{ workspaces, openPalette: () => setPalette(true) } satisfies WorkspaceOutlet}
      />
      <CommandPalette open={palette} onOpenChange={setPalette} onHelp={() => setHelp(true)} />
      <CreateIssueDialog />
      <Dialog
        title={t("help.shortcuts")}
        description={t("help.shortcutsSub")}
        size="sm"
        isOpen={help}
        onOpenChange={setHelp}
      >
        <dl className="space-y-1.5 text-[13px]">
          {SHORTCUTS.map(([keys, label]) => (
            <div key={label} className="flex items-center justify-between gap-4">
              <dt>{t(label)}</dt>
              <dd className="flex items-center gap-1">
                {keys.map((k, i) => (
                  <span key={i} className="flex items-center gap-1">
                    {i > 0 && (
                      <span className="text-xs text-muted-foreground">{t("help.then")}</span>
                    )}
                    <Kbd>{k}</Kbd>
                  </span>
                ))}
              </dd>
            </div>
          ))}
        </dl>
      </Dialog>
    </>
  );
}
