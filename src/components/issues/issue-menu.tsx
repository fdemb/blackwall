import type { Issue } from "@/db/schema";
import EllipsisIcon from "lucide-solid/icons/ellipsis";
import { Button } from "../ui/button";
import { DropdownMenu, DropdownMenuTrigger } from "../ui/dropdown-menu";

type IssueMenuProps = {
  issue: Issue;
  workspaceSlug: string;
  teamKey: string;
};

export function IssueMenu(props: IssueMenuProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger as={Button} variant="ghost" size="iconXs">
        <EllipsisIcon class="size-4" />
      </DropdownMenuTrigger>
    </DropdownMenu>
  );
}
