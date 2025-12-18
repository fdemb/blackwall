import { useSessionData } from "@/context/session-context";
import { useWorkspaceData } from "@/context/workspace-context";
import { logOut } from "@/server/auth/api";
import { useNavigate } from "@tanstack/solid-router";
import { useServerFn } from "@tanstack/solid-start";
import SelectorIcon from "lucide-solid/icons/chevrons-up-down";
import LogOutIcon from "lucide-solid/icons/log-out";
import SettingsIcon from "lucide-solid/icons/settings";
import { UserAvatar } from "../custom-ui/avatar";
import { FastLink } from "../custom-ui/fast-link";
import { Button } from "../ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";

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
      <DropdownMenuTrigger
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
      </DropdownMenuTrigger>
      <DropdownMenuContent class="min-w-[12rem]">
        <DropdownMenuItem
          as={FastLink}
          to="/$workspace/settings/general"
          params={{ workspace: workspaceData().workspace.slug }}
        >
          <SettingsIcon />
          Settings
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onClick={onLogOut}>
          <LogOutIcon />
          Log out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
