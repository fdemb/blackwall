import { useWorkspaceData } from "@/features/shared/context/workspace-context";
import { listUserWorkspaces } from "@/features/workspaces/actions";
import { Popover } from "@kobalte/core/popover";
import { useQuery } from "@tanstack/solid-query";
import { useNavigate } from "@tanstack/solid-router";
import { useServerFn } from "@tanstack/solid-start";
import SelectorIcon from "lucide-solid/icons/chevrons-up-down";
import { createSignal } from "solid-js";
import { PickerPopover } from "../custom-ui/picker-popover";
import { Button } from "../ui/button";

export function WorkspacePicker() {
  const listUserWorkspacesFn = useServerFn(listUserWorkspaces);
  const navigate = useNavigate();
  const [open, setOpen] = createSignal(false);
  const { workspace } = useWorkspaceData();
  const workspacesQuery = useQuery(() => ({
    queryKey: ["workspaces"],
    queryFn: () => {
      return listUserWorkspacesFn();
    },
  }));

  const pickerOptions = () => {
    const workspaces = workspacesQuery.data?.map((workspace) => ({
      id: workspace.id,
      label: workspace.displayName,
    }));

    return [
      ...(workspaces ?? []),
      {
        id: "create-workspace",
        label: "Create Workspace",
      },
    ];
  };

  function handleChange(id: string) {
    if (id === "create-workspace") {
      navigate({ to: "/create-workspace" });
    }
    const workspace = workspacesQuery.data?.find((option) => option.id === id);
    if (!workspace) return;

    navigate({
      to: "/$workspace",
      params: { workspace: workspace.slug },
    });
  }

  return (
    <Popover placement="bottom" gutter={8} open={open()} onOpenChange={setOpen}>
      <Popover.Trigger
        as={Button}
        variant="ghost"
        class="h-auto !px-1 !py-1 items-center"
      >
        <span class="truncate font-medium">{workspace.displayName}</span>
        <SelectorIcon class="size-3.5 ml-1 shrink-0" />
      </Popover.Trigger>

      <PickerPopover
        options={pickerOptions()}
        value={workspace.id}
        onChange={handleChange}
        // loading={workspacesQuery.isLoading}
        emptyText="No workspaces found."
      />
    </Popover>
  );
}
