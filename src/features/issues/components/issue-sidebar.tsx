import { Label, User } from "@/db/schema";
import { InferDbType } from "@/db/utils";
import type { JSX } from "solid-js";
import {
  AssigneePickerPopover,
  IssueLabelsPicker,
  PriorityPickerPopover,
  StatusPickerPopover,
} from "./pickers";

type IssueForSidebar = InferDbType<"issue", { assignedTo: true }>;

function SidebarItem(props: {
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
    <aside class="max-w-64 w-full border-l bg-surface">
      <div class="flex flex-col">
        <SidebarItem label="Status" orientation="col">
          <StatusPickerPopover
            status={props.issue.status}
            issueKey={props.issue.key}
            workspaceSlug={props.workspaceSlug}
          />
        </SidebarItem>

        <SidebarItem label="Priority" orientation="col">
          <PriorityPickerPopover
            priority={props.issue.priority}
            issueKey={props.issue.key}
            workspaceSlug={props.workspaceSlug}
          />
        </SidebarItem>

        <SidebarItem label="Assigned to" orientation="col">
          <AssigneePickerPopover
            assignedToId={props.issue.assignedToId}
            assignedTo={props.issue.assignedTo}
            issueKey={props.issue.key}
            workspaceSlug={props.workspaceSlug}
            teamKey={props.teamKey}
            assignableUsers={props.assignableUsers}
          />
        </SidebarItem>

        <SidebarItem label="Labels" orientation="col">
          <IssueLabelsPicker labels={props.labels} issueKey={props.issue.key} />
        </SidebarItem>
      </div>
    </aside>
  );
}
