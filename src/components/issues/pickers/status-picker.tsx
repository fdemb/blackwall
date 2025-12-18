import { PickerPopover } from "@/components/custom-ui/picker-popover";
import type { IssueStatus } from "@/db/schema";
import { issueMappings, mappingToOptionArray } from "@/lib/mappings";
import { changeStatus } from "@/server/issues/issues.api";
import { Popover } from "@kobalte/core/popover";
import { useQueryClient } from "@tanstack/solid-query";
import { useServerFn } from "@tanstack/solid-start";
import { IssueStatusBadge } from "../issue-badges";

type StatusPickerPopoverProps =
  | {
      status: IssueStatus;
      controlled: true;
      onChange: (status: IssueStatus) => void;
      issueKey?: never;
      workspaceSlug?: never;
    }
  | {
      status: IssueStatus;
      controlled?: false;
      issueKey: string;
      workspaceSlug: string;
      onChange?: never;
    };

export function StatusPickerPopover(props: StatusPickerPopoverProps) {
  const queryClient = useQueryClient();
  const handleChangeStatus = useServerFn(changeStatus);

  const handleChange = async (status: IssueStatus) => {
    if (props.controlled && props.onChange) {
      props.onChange(status);
      return;
    }

    if (!props.controlled && props.issueKey && props.workspaceSlug) {
      await handleChangeStatus({
        data: {
          workspaceSlug: props.workspaceSlug,
          issueKey: props.issueKey,
          issueStatus: status,
        },
      });
      queryClient.invalidateQueries({
        queryKey: ["issue", "get", props.workspaceSlug, props.issueKey],
      });
    }
  };

  return (
    <Popover placement="bottom-start" gutter={8}>
      <Popover.Trigger class="rounded-full [&>span]:hover:from-accent [&>span]:hover:to-accent [&>span]:hover:transition-colors">
        <IssueStatusBadge status={props.status} />
      </Popover.Trigger>

      <PickerPopover
        value={props.status}
        onChange={handleChange}
        options={mappingToOptionArray(issueMappings.status)}
      />
    </Popover>
  );
}
