import type { InferDbType } from "@/db/utils";
import { changeStatus, list } from "@/features/issues/issue-actions";
import { CreateDialogContent } from "@/features/shared/components/blocks/create-dialog";
import { PageHeader } from "@/features/shared/components/blocks/page-header";
import {
  TeamAvatar,
  UserAvatar,
} from "@/features/shared/components/custom-ui/avatar";
import { Badge } from "@/features/shared/components/custom-ui/badge";
import { Button } from "@/features/shared/components/ui/button";
import { Dialog, DialogTrigger } from "@/features/shared/components/ui/dialog";
import { issueMappings } from "@/lib/mappings";
import { queryOptions, useQuery, useQueryClient } from "@tanstack/solid-query";
import { createFileRoute, Link } from "@tanstack/solid-router";
import { useServerFn } from "@tanstack/solid-start";
import ChevronRight from "lucide-solid/icons/chevron-right";
import CircleIcon from "lucide-solid/icons/circle";
import CircleCheckIcon from "lucide-solid/icons/circle-check";
import CircleDotDashedIcon from "lucide-solid/icons/circle-dot-dashed";
import PlusIcon from "lucide-solid/icons/plus";
import { createMemo, For, Index, Show, type Component } from "solid-js";
import { Dynamic } from "solid-js/web";

type IssueForBoard = InferDbType<
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

export const boardQueryOptions = (workspaceSlug: string, teamKey: string) =>
  queryOptions({
    queryKey: ["issues", "board", workspaceSlug, teamKey],
    queryFn: () =>
      list({
        data: {
          workspaceSlug,
          teamKey,
          statusFilters: ["to_do", "in_progress", "done"],
        },
      }),
  });

export const Route = createFileRoute(
  "/_authorized/$workspace/_main/team/$teamKey/issues/board",
)({
  component: IndexComponent,
  loader: async ({ params, context }) =>
    context.queryClient.ensureQueryData(
      boardQueryOptions(params.workspace, params.teamKey),
    ),
});

function IndexComponent() {
  const params = Route.useParams();
  const ctx = Route.useRouteContext();
  const query = useQuery(() =>
    boardQueryOptions(params().workspace, params().teamKey),
  );
  const data = createMemo(() =>
    Object.groupBy(query.data ?? [], (issue) => issue.status),
  );

  return (
    <>
      <PageHeader>
        <div class="flex flex-row items-center">
          <div class="flex flex-row items-center gap-1">
            <TeamAvatar team={ctx().team} size="5" />

            {ctx().team.name}
          </div>
          <ChevronRight class="size-4 mx-2 shrink-0" />
          <div>Board</div>
        </div>
      </PageHeader>

      <div class="p-4">
        <div class="flex flex-row gap-4 min-h-96 w-full">
          <BoardList
            statusName="To do"
            statusId="to_do"
            issues={data().to_do ?? []}
            statusIcon={CircleIcon}
          />
          <BoardList
            statusName="In progress"
            statusId="in_progress"
            issues={data().in_progress ?? []}
            statusIcon={CircleDotDashedIcon}
          />
          <BoardList
            statusName="Done"
            statusId="done"
            issues={data().done ?? []}
            statusIcon={CircleCheckIcon}
          />
        </div>
      </div>
    </>
  );
}

type BoardListProps = {
  statusName: string;
  statusId: IssueForBoard["status"];
  statusIcon?: Component<{
    class?: string;
  }>;
  issues: Array<IssueForBoard>;
};

function BoardList(props: BoardListProps) {
  const handleChangeStatus = useServerFn(changeStatus);
  const mappedStatus = () => issueMappings.status[props.statusId];
  const params = Route.useParams();
  const queryClient = useQueryClient();

  function onDrop(e: DragEvent) {
    e.preventDefault();

    const issueKey = e.dataTransfer?.getData("text/plain");
    if (!issueKey) {
      return;
    }

    const isPresentInColumn = props.issues.some((i) => i.key === issueKey);
    if (isPresentInColumn) return;

    handleChangeStatus({
      data: {
        issueKey,
        workspaceSlug: params().workspace,
        issueStatus: props.statusId,
      },
    }).then(() => {
      queryClient.invalidateQueries({
        queryKey: ["issues", "board"],
      });
    });
  }

  const onDragOver = (e: DragEvent) => {
    e.preventDefault();
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = "move";
    }
  };

  return (
    <div class="flex flex-col w-full max-w-80 group">
      <div
        class={`pb-2 text-sm flex flex-row items-center ${mappedStatus().textClass}`}
      >
        <Dynamic class="size-4 mr-1" component={props.statusIcon} />
        <p>{props.statusName}</p>
        <Badge size="sm" class="ml-2">
          {props.issues.length}
        </Badge>

        <Dialog>
          <DialogTrigger
            as={Button}
            variant="secondary"
            class="size-5! p-0! items-center! justify-center! ml-auto hidden group-hover:flex"
          >
            <PlusIcon class="size-4 shrink-0" />
          </DialogTrigger>
          <CreateDialogContent
            status={props.statusId}
            teamKey={params().teamKey}
          />
        </Dialog>
      </div>
      <div
        class="bg-surface rounded-lg p-2 ring-1 ring-border ring-inset dark:ring-white/10 h-full grow flex flex-col gap-2.5"
        onDrop={onDrop}
        onDragOver={onDragOver}
      >
        <Show
          when={props.issues.length > 0}
          fallback={
            <span class="p-6 text-center text-muted-foreground">No issues</span>
          }
        >
          <For each={props.issues}>
            {(issue) => <BoardItem issue={issue} />}
          </For>
        </Show>
        <span role="none" class="h-20" />
      </div>
    </div>
  );
}

type BoardItemProps = {
  issue: IssueForBoard;
};

function BoardItem(props: BoardItemProps) {
  let ref!: HTMLAnchorElement;

  const params = Route.useParams();

  function onDragStart(e: DragEvent) {
    e.dataTransfer?.setData("text/plain", props.issue.key);
    const element = e.currentTarget as HTMLElement;
    element.classList.add("opacity-50");
  }

  function onDragEnd(e: DragEvent) {
    const element = e.currentTarget as HTMLElement;
    element.classList.remove("opacity-50");
  }

  const labels = () =>
    props.issue.labelsOnIssue.map((labelOnIssue) => labelOnIssue.label);

  return (
    <Link
      class="p-4 ring-1 ring-border rounded-md shadow-sm bg-card"
      draggable="true"
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      to="/$workspace/issue/$key"
      params={{ workspace: params().workspace, key: props.issue.key }}
      ref={ref}
    >
      <div class="w-full flex flex-col">
        <div class="pb-2">
          <p class="font-medium text-lg">{props.issue.summary}</p>
        </div>

        <Show when={labels().length}>
          <div class="flex flex-wrap gap-2 items-center pb-2">
            <Index each={labels()}>
              {(label) => (
                <Badge color={label().colorKey} size="sm">
                  {label().name}
                </Badge>
              )}
            </Index>
          </div>
        </Show>

        <div class="flex flex-row gap-2 items-center justify-end w-full grow pt-2">
          <p class="font-normal text-muted-foreground">{props.issue.key}</p>
          <Show when={props.issue.assignedTo}>
            <UserAvatar user={props.issue.assignedTo} size="sm" />
          </Show>
        </div>
      </div>
    </Link>
  );
}
