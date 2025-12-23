import type { Issue } from "@/db/schema";
import { action } from "@/lib/form.utils";
import { deleteIssue } from "@/server/issues/issues.api";
import { useQueryClient } from "@tanstack/solid-query";
import { useNavigate } from "@tanstack/solid-router";
import EllipsisIcon from "lucide-solid/icons/ellipsis";
import TrashIcon from "lucide-solid/icons/trash-2";
import { createSignal } from "solid-js";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";

type IssueMenuProps = {
  issue: Issue;
  workspaceSlug: string;
  teamKey: string;
};

export function IssueMenu(props: IssueMenuProps) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [deleteDialogOpen, setDeleteDialogOpen] = createSignal(false);

  const handleDelete = async () => {
    await action(
      deleteIssue({
        data: {
          workspaceSlug: props.workspaceSlug,
          issueKey: props.issue.key,
        },
      }),
    );

    queryClient.invalidateQueries({
      queryKey: ["issue", "issues"],
    });

    navigate({
      to: "/$workspace/team/$teamKey/issues",
      params: {
        workspace: props.workspaceSlug,
        teamKey: props.teamKey,
      },
    });
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger as={Button} variant="ghost" size="iconXs">
          <EllipsisIcon class="size-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem
            variant="destructive"
            onSelect={() => setDeleteDialogOpen(true)}
          >
            <TrashIcon class="size-4" />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <AlertDialog open={deleteDialogOpen()} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogMedia class="bg-destructive/50">
              <TrashIcon class="size-4" />
            </AlertDialogMedia>
            <AlertDialogTitle>Delete issue?</AlertDialogTitle>
            <AlertDialogDescription>
              This action cannot be undone. This will permanently delete the
              issue {props.issue.key}.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel size="xs">Cancel</AlertDialogCancel>
            <AlertDialogAction
              size="xs"
              variant="destructive"
              action={handleDelete}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
