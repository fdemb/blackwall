import type { User } from "@/db/schema";
import { assign } from "@/features/issues/issue-actions";
import { UserAvatar } from "@/features/shared/components/custom-ui/avatar";
import { PickerPopover } from "@/features/shared/components/custom-ui/picker-popover";
import { Button } from "@/features/shared/components/ui/button";
import { cn } from "@/lib/utils";
import { Popover } from "@kobalte/core/popover";
import { useQueryClient } from "@tanstack/solid-query";
import { useServerFn } from "@tanstack/solid-start";
import ChevronsUpDownIcon from "lucide-solid/icons/chevrons-up-down";
import { createMemo, createSignal, Show } from "solid-js";

type AssigneePickerPopoverProps =
  | {
      assignableUsers: User[];
      assignedToId: string | null;
      workspaceSlug: string;
      teamKey: string;
      loading?: boolean;
      small?: boolean;
      issueKey: string;
      controlled?: false;
    }
  | {
      assignableUsers: User[];
      assignedToId: string | null;
      workspaceSlug: string;
      teamKey: string;
      loading?: boolean;
      small?: boolean;
      issueKey?: never;
      handleChange?: (id: string | null) => void;
      controlled: true;
    };

export function AssigneePickerPopover(props: AssigneePickerPopoverProps) {
  const queryClient = useQueryClient();
  const handleAssign = useServerFn(assign);
  const [open, setOpen] = createSignal(false);
  const assignedTo = () =>
    props.assignableUsers.find((user) => user.id === props.assignedToId);

  const assignableUsersOptions = createMemo(() => {
    const options = props.assignableUsers.map((user) => ({
      id: user.id,
      label: user.name,
      icon: () => <UserAvatar user={user} size="xs" />,
    }));

    return [
      {
        id: null,
        label: "Unassigned",
        icon: () => <UserAvatar user={null} size="xs" />,
      },
      ...options,
    ];
  });

  const handleChange = async (id: string | null) => {
    if (props.controlled) {
      props.handleChange?.(id);
      return;
    }

    await handleAssign({
      data: {
        workspaceSlug: props.workspaceSlug,
        issueKey: props.issueKey,
        assignToId: id,
      },
    });
    queryClient.invalidateQueries({
      queryKey: ["issue", "get", props.workspaceSlug, props.issueKey],
    });
  };

  return (
    <Popover
      open={open()}
      onOpenChange={setOpen}
      placement="bottom-start"
      gutter={8}
    >
      <Popover.Trigger
        class={cn({
          "flex flex-row gap-2 items-center text-base px-2!": !props.small,
          "pl-1! !pr-2 py-1! h-auto!": props.small,
        })}
        as={Button}
        variant="outline"
        size={props.small ? "sm" : "lg"}
        scaleEffect={false}
      >
        <UserAvatar user={assignedTo()} size={props.small ? "5" : "xs"} />
        {assignedTo()?.name ?? "No one"}
        <Show when={!props.small}>
          <ChevronsUpDownIcon class="size-4" />
        </Show>
      </Popover.Trigger>

      <PickerPopover
        value={props.assignedToId}
        onChange={handleChange}
        options={assignableUsersOptions()}
        loading={props.loading}
      />
    </Popover>
  );
}
