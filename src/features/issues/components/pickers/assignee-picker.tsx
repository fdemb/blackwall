import type { User } from "@/db/schema";
import type { InferDbType } from "@/db/utils";
import { assign } from "@/features/issues/issue-actions";
import { UserAvatar } from "@/features/shared/components/custom-ui/avatar";
import { PickerPopover } from "@/features/shared/components/custom-ui/picker-popover";
import { Button } from "@/features/shared/components/ui/button";
import { Popover } from "@kobalte/core/popover";
import { useQueryClient } from "@tanstack/solid-query";
import { useServerFn } from "@tanstack/solid-start";
import ChevronsUpDownIcon from "lucide-solid/icons/chevrons-up-down";
import { createMemo, createSignal } from "solid-js";

type AssignedUser = InferDbType<"issue", { assignedTo: true }>["assignedTo"];

export function AssigneePickerPopover(props: {
  assignableUsers: User[];
  assignedToId: string | null;
  assignedTo: AssignedUser;
  issueKey: string;
  workspaceSlug: string;
  teamKey: string;
  loading?: boolean;
}) {
  const queryClient = useQueryClient();
  const handleAssign = useServerFn(assign);
  const [open, setOpen] = createSignal(false);

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

  // const [assignableUsers] = createResource(
  //   () => open() === true,
  //   async () => {
  //     const users = await listUsers({
  //       data: {
  //         workspaceSlug: props.workspaceSlug,
  //         teamKey: props.teamKey,
  //       },
  //     });

  //     if (!users) {
  //       return;
  //     }

  //     return users.map(
  //       (user) =>
  //         ({
  //           id: user.id,
  //           label: user.name,
  //           icon: () => <UserAvatar user={user} size="xs" />,
  //         }) satisfies PickerOption,
  //     );
  //   },
  // );

  // const assignableUsersWithNull = () => [
  //   {
  //     id: null,
  //     label: "Unassigned",
  //     icon: () => <UserAvatar user={null} size="xs" />,
  //   },
  //   ...(assignableUsers() ?? []),
  // ];

  const handleChange = async (id: string | null) => {
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
        class="flex flex-row gap-2 items-center text-base px-2!"
        as={Button}
        variant="outline"
        scaleEffect={false}
      >
        <UserAvatar user={props.assignedTo} size="xs" />
        {props.assignedTo?.name ?? "No one"}
        <ChevronsUpDownIcon class="size-4" />
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
