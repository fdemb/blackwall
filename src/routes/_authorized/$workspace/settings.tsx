import { SettingsSidebar } from "@/components/blocks/settings-sidebar";
import {
  SidebarInset,
  SidebarProvider,
} from "@/components/ui/sidebar";
import { createFileRoute, Outlet } from "@tanstack/solid-router";

export const Route = createFileRoute("/_authorized/$workspace/settings")({
  component: RouteComponent,
});

function RouteComponent() {
  return (
    <SidebarProvider>
      <SettingsSidebar />
      <SidebarInset>
        <Outlet />
      </SidebarInset>
    </SidebarProvider>
  );
}
