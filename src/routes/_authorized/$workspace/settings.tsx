import { SettingsSidebar } from "@/features/shared/components/blocks/settings-sidebar";
import {
  SidebarInset,
  SidebarProvider,
} from "@/features/shared/components/ui/sidebar";
import { createFileRoute, Outlet } from "@tanstack/solid-router";

export const Route = createFileRoute("/_authorized/$workspace/settings")({
  component: RouteComponent,
});

function RouteComponent() {
  return (
    <SidebarProvider>
      <SettingsSidebar />
      <SidebarInset class="p-4">
        <Outlet />
      </SidebarInset>
    </SidebarProvider>
  );
}
