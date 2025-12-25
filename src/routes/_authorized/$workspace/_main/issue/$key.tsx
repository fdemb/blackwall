import { PageHeader } from "@/components/blocks/page-header";
import { TeamAvatar } from "@/components/custom-ui/avatar";
import {
  Breadcrumbs,
  BreadcrumbsItem,
} from "@/components/custom-ui/breadcrumbs";
import { ScrollArea } from "@/components/custom-ui/scroll-area";
import { IssueActivityLog } from "@/components/issues/issue-activity-log";
import { IssueDescription } from "@/components/issues/issue-description";
import { IssueMenu } from "@/components/issues/issue-menu";
import { IssueSidebar } from "@/components/issues/issue-sidebar";
import { IssueSummary } from "@/components/issues/issue-summary";
import { Separator } from "@/components/ui/separator";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { useWorkspaceData } from "@/context/workspace-context";
import type { User } from "@/db/schema";
import type { InferDbType } from "@/db/utils";
import { get } from "@/server/issues/issues.api";
import { getIssueLabels } from "@/server/issues/labels.api";
import { getAssignableUsersQueryOptions } from "@/server/issues/query-options";
import { queryOptions, useQuery } from "@tanstack/solid-query";
import { createFileRoute, notFound } from "@tanstack/solid-router";
import PanelRightIcon from "lucide-solid/icons/panel-right";
import { Show } from "solid-js";
import { Portal } from "solid-js/web";

type IssueFromGet = InferDbType<
  "issue",
  {
    assignedTo: true;
    comments: {
      with: {
        author: true;
      };
    };
    labelsOnIssue: {
      with: {
        label: true;
      };
    };
    changeEvents: {
      with: {
        actor: true;
      };
    };
  }
>;

const getIssueWithLabelsQueryOptions = (
  workspaceSlug: string,
  issueKey: string,
) =>
  queryOptions({
    queryKey: ["issue", "get", workspaceSlug, issueKey],
    queryFn: async () => {
      const [issueData, labelsData] = await Promise.all([
        get({
          data: {
            workspaceSlug,
            issueKey,
          },
        }),
        getIssueLabels({
          data: {
            workspaceSlug,
            issueKey,
          },
        }),
      ]);

      return {
        issueData,
        labelsData: labelsData ?? [],
      };
    },
  });

export const Route = createFileRoute(
  "/_authorized/$workspace/_main/issue/$key",
)({
  component: RouteComponent,
  loader: async ({ params, context }) => {
    const data = await context.queryClient.ensureQueryData(
      getIssueWithLabelsQueryOptions(params.workspace, params.key),
    );

    if (!data.issueData) {
      throw notFound();
    }

    return data;
  },
});

function IssueMainView(props: {
  issue: IssueFromGet;
  assignableUsers: User[];
}) {
  const workspaceData = useWorkspaceData();

  return (
    <div class="flex flex-col flex-1 relative min-w-0">
      <ScrollArea>
        <main class="flex-1 min-w-0 px-6 sm:px-12 pb-8 pt-16 flex flex-col max-w-[980px] mx-auto">
          <IssueSummary issue={props.issue} />
          <IssueDescription issue={props.issue} />

          <Separator class="my-8" />

          <IssueActivityLog
            issue={props.issue}
            workspaceSlug={workspaceData().workspace.slug}
            assignableUsers={props.assignableUsers}
          />
        </main>
      </ScrollArea>
    </div>
  );
}

function RouteComponent() {
  const params = Route.useParams();
  const workspaceData = useWorkspaceData();

  const issueQuery = useQuery(() =>
    getIssueWithLabelsQueryOptions(params().workspace, params().key),
  );

  const assignableUsersQuery = useQuery(() =>
    getAssignableUsersQueryOptions(
      params().workspace,
      issueQuery.data!.issueData.team.key,
    ),
  );

  return (
    <Show when={issueQuery.data}>
      {(d) => (
        <div class="flex flex-col w-full">
          <PageHeader>
            <Breadcrumbs>
              <BreadcrumbsItem
                linkProps={{
                  to: "/$workspace/team/$teamKey/issues",
                  params: {
                    workspace: workspaceData().workspace.slug,
                    teamKey: d().issueData.team.key,
                  },
                }}
              >
                <div class="flex flex-row items-center gap-1">
                  <TeamAvatar team={d().issueData.team} size="5" />
                  {d().issueData.team.name}
                </div>
              </BreadcrumbsItem>
              <BreadcrumbsItem>{d().issueData.issue.key}</BreadcrumbsItem>
            </Breadcrumbs>

            <IssueMenu
              issue={d().issueData.issue}
              workspaceSlug={params().workspace}
              teamKey={d().issueData.team.key}
            />

            <div id="issue-sidebar-trigger" class="ml-auto" />
          </PageHeader>

          <div class="flex flex-row min-h-0 flex-1">
            <SidebarProvider>
              <SidebarInset>
                <IssueMainView
                  issue={d().issueData.issue}
                  assignableUsers={assignableUsersQuery.data ?? []}
                />
              </SidebarInset>

              <Portal mount={document.getElementById("issue-sidebar-trigger")!}>
                <SidebarTrigger class="ml-auto">
                  <PanelRightIcon class="size-4" />
                </SidebarTrigger>
              </Portal>

              <IssueSidebar
                issue={d().issueData.issue}
                workspaceSlug={params().workspace}
                teamKey={d().issueData.team.key}
                labels={d().labelsData}
                assignableUsers={assignableUsersQuery.data ?? []}
              />
            </SidebarProvider>
          </div>
        </div>
      )}
    </Show>
  );
}
