import { logOut } from "@/features/auth/actions";
import { useSessionData } from "@/features/shared/context/session-context";
import { useWorkspaceData } from "@/features/shared/context/workspace-context";
import { useNavigate } from "@tanstack/solid-router";
import { useServerFn } from "@tanstack/solid-start";
import SelectorIcon from "lucide-solid/icons/chevrons-up-down";
import LogOutIcon from "lucide-solid/icons/log-out";
import SettingsIcon from "lucide-solid/icons/settings";
import { UserAvatar } from "../custom-ui/avatar";
import { FastLink } from "../custom-ui/fast-link";
import { Button } from "../ui/button";
import { DropdownMenu } from "../ui/dropdown-menu";

export function UserMenu() {
  const session = useSessionData();
  const workspaceData = useWorkspaceData();
  const handleLogOut = useServerFn(logOut);
  const navigate = useNavigate();

  async function onLogOut() {
    await handleLogOut();
    throw navigate({
      to: "/signin",
    });
  }

  return (
    <DropdownMenu gutter={2}>
      <DropdownMenu.Trigger
        as={Button}
        class="flex !items-center font-normal justify-start text-left !p-2 h-auto"
        variant="ghost"
      >
        <div class="flex flex-row gap-2 items-center w-full">
          <UserAvatar user={session().user} />
          <div class="flex flex-col">
            <span class="text-base">{session().user.name}</span>
            <span class="text-xs text-muted-foreground">
              {session().user.email}
            </span>
          </div>
          <SelectorIcon class="size-4 ml-auto" />
        </div>
      </DropdownMenu.Trigger>
      <DropdownMenu.Content class="min-w-[12rem]">
        <DropdownMenu.Item
          as={FastLink}
          to="/$workspace/settings/general"
          params={{ workspace: workspaceData().workspace.slug }}
        >
          <SettingsIcon />
          Settings
        </DropdownMenu.Item>
        <DropdownMenu.Separator />
        <DropdownMenu.Item variant="destructive" onClick={onLogOut}>
          <LogOutIcon />
          Log out
        </DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu>
  );
}
