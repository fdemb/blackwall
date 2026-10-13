import { useEffect, useState } from "react";
import { Outlet, useLocation, useOutletContext } from "react-router";
import { Menu as MenuIcon } from "lucide-react";
import { ModalOverlay, Modal, Dialog as RACDialog } from "react-aria-components";
import { Button } from "~/components/ui/button";
import { OfflineBanner } from "~/components/app/offline-banner";
import { RejectedBanner } from "~/components/app/rejected-banner";
import { Sidebar } from "~/components/app/sidebar";
import { rememberAppPath } from "~/lib/settings-nav";
import { useI18n } from "~/lib/i18n";
import { useWorkspace } from "~/lib/workspace";
import type { WorkspaceOutlet } from "./workspace";

/** The everyday app: workspace sidebar on the left, one page on the right. */
export default function AppShell() {
  const { t } = useI18n();
  const ctx = useOutletContext<WorkspaceOutlet>();
  const { ws } = useWorkspace();
  const { pathname, search } = useLocation();
  const [drawer, setDrawer] = useState(false);

  // Settings sends you back to the page you came from.
  useEffect(() => rememberAppPath(ws.slug, pathname + search), [ws.slug, pathname, search]);

  return (
    <div className="flex h-dvh overflow-hidden">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:m-2 focus:rounded-md focus:bg-card focus:px-3 focus:py-1.5"
      >
        {t("nav.skip")}
      </a>
      <div className="hidden border-r border-border md:block">
        <Sidebar onSearch={ctx.openPalette} />
      </div>
      <ModalOverlay
        isOpen={drawer}
        onOpenChange={setDrawer}
        isDismissable
        className="fixed inset-0 z-40 bg-black/40 md:hidden"
      >
        <Modal className="h-full w-60 bg-sidebar shadow-xl entering:animate-in entering:slide-in-from-left exiting:animate-out exiting:slide-out-to-left">
          <RACDialog aria-label={t("nav.main")} className="h-full outline-none">
            <Sidebar
              onSearch={() => {
                setDrawer(false);
                ctx.openPalette();
              }}
              onNavigate={() => setDrawer(false)}
            />
          </RACDialog>
        </Modal>
      </ModalOverlay>
      <main id="main" className="flex min-w-0 flex-1 flex-col bg-background">
        <div className="flex h-11 items-center border-b border-border px-2 md:hidden">
          <Button
            variant="ghost"
            size="icon-lg"
            aria-label={t("nav.main")}
            onPress={() => setDrawer(true)}
          >
            <MenuIcon />
          </Button>
          <span className="ml-1 truncate  font-semibold">{ws.name}</span>
        </div>
        <OfflineBanner />
        <RejectedBanner />
        <Outlet context={ctx} />
      </main>
    </div>
  );
}
