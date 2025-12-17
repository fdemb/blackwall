import type { Label, User } from "@/db/schema";
import type { InferDbType } from "@/db/utils";
import {
  Sidebar,
  SidebarContent,
} from "@/components/ui/sidebar";
import type { JSX } from "solid-js";
import {
  AssigneePickerPopover,
  IssueLabelsPicker,
  PriorityPickerPopover,
  StatusPickerPopover,
} from "./pickers";

type IssueForSidebar = InferDbType<"issue", { assignedTo: true }>;

function IssueSidebarItem(props: {
  children: JSX.Element;
  label: string;
  orientation: "row" | "col";
}) {
  return (
    <div
      class="flex w-full p-4 border-b"
      classList={{
        "flex-row items-center justify-between gap-4":
          props.orientation === "row",
        "flex-col gap-3": props.orientation === "col",
      }}
    >
      <p class="font-medium text-muted-foreground uppercase text-xs tracking-wide">
        {props.label}
      </p>
      <div>{props.children}</div>
    </div>
  );
}

export function IssueSidebar(props: {
  issue: IssueForSidebar;
  labels: Label[];
  assignableUsers: User[];
  workspaceSlug: string;
  teamKey: string;
}) {
  return (
    <Sidebar side="right" class="mt-10">
      <SidebarContent class="p-0">
        <IssueSidebarItem label="Status" orientation="col">
          <StatusPickerPopover
            status={props.issue.status}
            issueKey={props.issue.key}
            workspaceSlug={props.workspaceSlug}
          />
        </IssueSidebarItem>

        <IssueSidebarItem label="Priority" orientation="col">
          <PriorityPickerPopover
            priority={props.issue.priority}
            issueKey={props.issue.key}
            workspaceSlug={props.workspaceSlug}
          />
        </IssueSidebarItem>

        <IssueSidebarItem label="Assigned to" orientation="col">
          <AssigneePickerPopover
            assignedToId={props.issue.assignedToId}
            issueKey={props.issue.key}
            workspaceSlug={props.workspaceSlug}
            teamKey={props.teamKey}
            assignableUsers={props.assignableUsers}
          />
        </IssueSidebarItem>

        <IssueSidebarItem label="Labels" orientation="col">
          <IssueLabelsPicker labels={props.labels} issueKey={props.issue.key} />
        </IssueSidebarItem>
      </SidebarContent>
    </Sidebar>
  );
}
