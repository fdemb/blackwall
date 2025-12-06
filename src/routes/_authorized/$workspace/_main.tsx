import { AppSidebar } from "@/features/shared/components/blocks/app-sidebar";
import {
  SidebarInset,
  SidebarProvider,
} from "@/features/shared/components/ui/sidebar";
import { createFileRoute, Outlet } from "@tanstack/solid-router";

export const Route = createFileRoute("/_authorized/$workspace/_main")({
  component: RouteComponent,
});

function RouteComponent() {
  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset>
        <div class="flex flex-col h-full w-full grow">
          <Outlet />
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}
