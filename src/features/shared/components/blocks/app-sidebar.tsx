import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from "@/features/shared/components/ui/sidebar";
import { useWorkspaceData } from "@/features/shared/context/workspace-context";
import { type LinkProps } from "@tanstack/solid-router";
import AlertCircleIcon from "lucide-solid/icons/alert-circle";
import ChevronRightIcon from "lucide-solid/icons/chevron-right";
import CircleDashedIcon from "lucide-solid/icons/circle-dashed";
import KanbanIcon from "lucide-solid/icons/kanban-square";
import type { Component, ComponentProps } from "solid-js";
import { For, onMount, Show } from "solid-js";
import { createStore } from "solid-js/store";
import { Dynamic } from "solid-js/web";
import { TeamAvatar } from "../custom-ui/avatar";
import { FastLink } from "../custom-ui/fast-link";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "../ui/collapsible";
import { CreateDialog } from "./create-dialog";
import { GlobalSearchDialog } from "./global-search-dialog";
import { LogoNoBg } from "./logos";
import { UserMenu } from "./user-menu";
import { WorkspacePicker } from "./workspace-picker";

type LinkNavItem = {
  title: string;
  type: "link";
  linkProps: LinkProps;
  icon?: Component;
};

type CollapsibleNavItem = {
  id: string; // for remembering the open state
  title: string;
  type: "collapsible";
  icon?: Component;
  children: LinkNavItem[];
};

type NavItem = LinkNavItem | CollapsibleNavItem;

type NavGroup = {
  title?: string;
  children: NavItem[];
};

function createNavItems() {
  const workspaceData = useWorkspaceData();
  const teams = () => workspaceData().teamsData.map((team) => team.team);

  return () =>
    [
      {
        children: [
          {
            title: "Dashboard",
            type: "link",
            icon: undefined,
            linkProps: {
              to: "/$workspace",
              params: {
                workspace: workspaceData().workspace.slug,
              },
            },
          },
        ],
      },
      {
        children: teams().map((team) => ({
          id: `team-${team.key}`,
          title: team.name,
          type: "collapsible",
          icon: () => <TeamAvatar team={team} size="5" />,
          children: [
            {
              title: "Board",
              type: "link",
              linkProps: {
                to: "/$workspace/team/$teamKey/issues/board",
                params: {
                  workspace: workspaceData().workspace.slug,
                  teamKey: team.key,
                },
              },
              icon: KanbanIcon,
            },
            {
              title: "Backlog",
              type: "link",
              linkProps: {
                to: "/$workspace/team/$teamKey/issues/backlog",
                params: {
                  workspace: workspaceData().workspace.slug,
                  teamKey: team.key,
                },
              },
              icon: CircleDashedIcon,
            },
            {
              title: "Issues",
              type: "link",
              linkProps: {
                to: "/$workspace/team/$teamKey/issues",
                params: {
                  workspace: workspaceData().workspace.slug,
                  teamKey: team.key,
                },
                activeOptions: {
                  exact: true,
                },
              },
              icon: AlertCircleIcon,
            },
          ],
        })),
      },
    ] as const satisfies NavGroup[];
}

function useLocalStorageCollapsibleState() {
  const [store, internal_setStore] = createStore<Record<string, boolean>>({});

  onMount(() => {
    const state = localStorage.getItem("sidebar:collapsible-open-state");
    if (state) {
      internal_setStore(JSON.parse(state));
    }
  });

  const setStore = (key: string, value: boolean) => {
    internal_setStore(key, value);

    localStorage.setItem(
      "sidebar:collapsible-open-state",
      JSON.stringify(store),
    );
  };

  return [store, setStore] as const;
}

export function AppSidebar(props: ComponentProps<typeof Sidebar>) {
  const workspaceData = useWorkspaceData();
  const teams = () => workspaceData().teamsData.map((team) => team.team);
  const groups = createNavItems();
  const [collapsibleStateStore, setCollapsibleStateStore] =
    useLocalStorageCollapsibleState();

  return (
    <Sidebar {...props} variant="sidebar">
      <SidebarHeader>
        <div class="flex items-center gap-1 text-lg leading-none font-medium p-1">
          <LogoNoBg class="size-6 shrink-0 mr-1 text-primary" />
          <span>/</span>
          <WorkspacePicker />
        </div>

        <div class="flex flex-row gap-2">
          <CreateDialog
            workspaceSlug={workspaceData().workspace.slug}
            teams={teams()}
          />

          <GlobalSearchDialog workspaceSlug={workspaceData().workspace.slug} />
        </div>
      </SidebarHeader>

      <SidebarContent>
        <For each={groups()}>
          {(group) => (
            <SidebarGroup>
              <SidebarGroupContent>
                <SidebarMenu>
                  <For each={group.children}>
                    {(item) => (
                      <SidebarMenuItem>
                        <Show when={item.type === "link" ? item : false}>
                          {(item) => (
                            <SidebarMenuButton
                              as={FastLink}
                              {...item().linkProps}
                              activeOptions={{
                                exact: true,
                              }}
                            >
                              <Show when={item().icon}>
                                <Dynamic component={item().icon} />
                              </Show>
                              {item().title}
                            </SidebarMenuButton>
                          )}
                        </Show>

                        <Show when={item.type === "collapsible" ? item : false}>
                          {(item) => (
                            <>
                              <Collapsible
                                class="group/collapsible"
                                open={collapsibleStateStore[item().id]}
                                onOpenChange={(open) =>
                                  setCollapsibleStateStore(item().id, open)
                                }
                              >
                                <CollapsibleTrigger as={SidebarMenuButton}>
                                  <Show when={item().icon}>
                                    <Dynamic component={item().icon} />
                                  </Show>
                                  {item().title}
                                  <ChevronRightIcon class="ml-auto transition-transform duration-200 group-data-expanded/collapsible:rotate-90 size-6" />
                                </CollapsibleTrigger>
                                <CollapsibleContent>
                                  <SidebarMenuSub>
                                    <For each={item().children}>
                                      {(child) => (
                                        <SidebarMenuSubItem>
                                          <SidebarMenuSubButton
                                            as={FastLink}
                                            {...child.linkProps}
                                          >
                                            <Show when={child.icon}>
                                              <Dynamic component={child.icon} />
                                            </Show>
                                            {child.title}
                                          </SidebarMenuSubButton>
                                        </SidebarMenuSubItem>
                                      )}
                                    </For>
                                  </SidebarMenuSub>
                                </CollapsibleContent>
                              </Collapsible>
                            </>
                          )}
                        </Show>
                      </SidebarMenuItem>
                    )}
                  </For>
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          )}
        </For>
      </SidebarContent>

      <SidebarFooter>
        <UserMenu />
      </SidebarFooter>
    </Sidebar>
  );
}
