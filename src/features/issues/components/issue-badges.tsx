import type { IssuePriority, IssueStatus } from "@/db/schema";
import { Badge } from "@/features/shared/components/custom-ui/badge";
import { Dot } from "@/features/shared/components/custom-ui/dot";
import { issueMappings } from "@/lib/mappings";
import { Dynamic } from "solid-js/web";

export function IssuePriorityBadge(props: { priority: IssuePriority }) {
  const priority = () => issueMappings.priority[props.priority];

  return (
    <Badge class={`${priority().textClass} gap-2`}>
      <Dot class={`${priority().textClass} bg-current`} />
      {priority().label}
    </Badge>
  );
}

type IssueStatusBadgeProps = {
  status: IssueStatus;
};
export function IssueStatusBadge(props: IssueStatusBadgeProps) {
  const status = () => issueMappings.status[props.status];

  return (
    <Badge class={status().textClass}>
      <Dynamic component={status().icon} class="size-4" />
      {status().label}
    </Badge>
  );
}
