import { buttonVariants } from "@/features/shared/components/ui/button";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/features/shared/components/ui/sidebar";
import { TextField } from "@/features/shared/components/ui/text-field";
import { useWorkspaceData } from "@/features/shared/context/workspace-context";
import { Link } from "@tanstack/solid-router";
import ArrowLeftIcon from "lucide-solid/icons/arrow-left";
import SearchIcon from "lucide-solid/icons/search";
import type { ComponentProps } from "solid-js";
import { FastLink } from "../custom-ui/fast-link";

export function SettingsSidebar(props: ComponentProps<typeof Sidebar>) {
  const workspaceData = useWorkspaceData();

  return (
    <Sidebar {...props}>
      <SidebarHeader class="flex flex-col gap-2">
        <Link
          to="/"
          class={buttonVariants({
            variant: "ghost",
            size: "xs",
            class: "w-fit",
          })}
        >
          <ArrowLeftIcon class="size-4" />
          Back to {workspaceData().workspace.displayName}
        </Link>

        <TextField class="relative">
          <div class="absolute h-full pl-2 top-0 bottom-0 left-0 flex items-center justify-center">
            <SearchIcon class="size-4 text-muted-foreground" />
          </div>
          <TextField.Input placeholder="Search settings..." class="pl-7" />
        </TextField>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  as={FastLink}
                  to="/$workspace/settings/general"
                  params={{ workspace: workspaceData().workspace.slug }}
                >
                  General
                </SidebarMenuButton>
              </SidebarMenuItem>

              <SidebarMenuItem>
                <SidebarMenuButton
                  as={FastLink}
                  to="/$workspace/settings/profile"
                  params={{ workspace: workspaceData().workspace.slug }}
                >
                  Profile
                </SidebarMenuButton>
              </SidebarMenuItem>

              <SidebarMenuItem>
                <SidebarMenuButton
                  as={FastLink}
                  to="/$workspace/settings/teams"
                  params={{ workspace: workspaceData().workspace.slug }}
                >
                  Team management
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
    </Sidebar>
  );
}
