import { InferDbType } from "@/db/utils";
import { Badge } from "@/features/shared/components/custom-ui/badge";
import { FastLink } from "@/features/shared/components/custom-ui/fast-link";
import { formatDateShort } from "@/lib/dates";
import { issueMappings } from "@/lib/mappings";
import { Index } from "solid-js";
import { Dynamic } from "solid-js/web";

type IssueForList = InferDbType<
  "issue",
  {
    assignedTo: true;
    labelsOnIssue: {
      with: {
        label: true;
      };
    };
  }
>;

export type IssueListProps = {
  issues: IssueForList[];
  workspaceSlug: string;
};

export function IssueList(props: IssueListProps) {
  return (
    <div class="flex flex-col">
      <Index each={props.issues}>
        {(issue) => (
          <IssueListItem issue={issue()} workspaceSlug={props.workspaceSlug} />
        )}
      </Index>
    </div>
  );
}

function IssueListItem(props: { issue: IssueForList; workspaceSlug: string }) {
  const priority = () => issueMappings.priority[props.issue.priority];
  const status = () => issueMappings.status[props.issue.status];

  return (
    <FastLink
      class="px-4 py-3 hover:bg-accent bg-background flex flex-row items-center justify-between"
      to="/$workspace/issue/$key"
      params={{ workspace: props.workspaceSlug, key: props.issue.key }}
    >
      <div class="flex flex-row items-center">
        <span class="px-1 py-0.5 text-xs bg-muted text-muted-foreground rounded-sm border mr-2">
          {props.issue.key}
        </span>
        {/* <Dot class={`${priority().textClass} bg-current`} /> */}
        <Dynamic
          component={status().icon}
          class={`${status().textClass} size-4`}
        />
        <span class="font-medium text-foreground ml-1">
          {props.issue.summary}
        </span>
      </div>

      <div class="flex flex-row items-center gap-2 text-right">
        <div class="flex flex-row items-center gap-1">
          <Index each={props.issue.labelsOnIssue}>
            {(label) => (
              <Badge size="sm" color={label().label.colorKey}>
                {label().label.name}
              </Badge>
            )}
          </Index>
        </div>

        <span class="text-muted-foreground text-sm w-[6ch]">
          {formatDateShort(props.issue.createdAt)}
        </span>
      </div>
    </FastLink>
  );
}
