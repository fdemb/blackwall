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
import { Button } from "@/components/ui/button";
import { Card, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { IssueEditingProvider } from "@/context/issue-editing.context";
import { useWorkspaceData } from "@/context/workspace-context";
import type { User } from "@/db/schema";
import type { InferDbType } from "@/db/utils";
import {
  get,
  updateDescription,
  updateSummary,
} from "@/server/issues/issues.api";
import { getIssueLabels } from "@/server/issues/labels.api";
import { getAssignableUsersQueryOptions } from "@/server/issues/query-options";
import { queryOptions, useMutation, useQuery } from "@tanstack/solid-query";
import { createFileRoute, notFound } from "@tanstack/solid-router";
import { useServerFn } from "@tanstack/solid-start";
import type { JSONContent } from "@tiptap/core";
import PanelRightIcon from "lucide-solid/icons/panel-right";
import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { tinykeys } from "tinykeys";

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
  const [summary, setSummary] = createSignal<string | null>(null);
  const [description, setDescription] = createSignal<JSONContent | null>(null);
  const updateDescriptionFn = useServerFn(updateDescription);
  const updateSummaryFn = useServerFn(updateSummary);

  const saveMutation = useMutation(() => ({
    mutationFn: async () => {
      if (description()) {
        await updateDescriptionFn({
          data: {
            workspaceSlug: workspaceData().workspace.slug,
            issueKey: props.issue.key,
            description: description()!,
          },
        });
      }

      if (summary()) {
        await updateSummaryFn({
          data: {
            workspaceSlug: workspaceData().workspace.slug,
            issueKey: props.issue.key,
            summary: summary()!,
          },
        });
      }
    },
    onSuccess: () => {
      setDescription(null);
      setSummary(null);
    },
  }));

  onMount(() => {
    const unsubscribe = tinykeys(window, {
      "$mod+s": (e) => {
        e.preventDefault();
        saveMutation.mutate();
      },
    });

    onCleanup(unsubscribe);
  });

  return (
    <IssueEditingProvider
      onSummaryChange={setSummary}
      onDescriptionChange={setDescription}
    >
      <div class="flex flex-col flex-1 relative">
        <ScrollArea>
          <main class="flex-1 px-6 sm:px-12 pb-8 pt-16 flex flex-col max-w-[980px] mx-auto">
            <h2
              class="text-xl sm:text-2xl font-medium outline-none"
              contenteditable
              onInput={(e) => {
                setSummary(e.currentTarget.innerText);
              }}
            >
              {props.issue.summary}
            </h2>

            <IssueDescription issue={props.issue} />

            <Separator class="my-8" />

            <IssueActivityLog
              issue={props.issue}
              workspaceSlug={workspaceData().workspace.slug}
              assignableUsers={props.assignableUsers}
            />
          </main>
        </ScrollArea>

        <Show when={description() !== null || summary() !== null}>
          <Card class="absolute bottom-4 left-4 right-4 flex flex-row justify-between py-0 h-16 items-center px-4">
            <CardTitle class="leading-normal">Unsaved changes</CardTitle>
            <div>
              <Button
                disabled={saveMutation.isPending}
                onClick={() => saveMutation.mutate()}
              >
                Save
              </Button>
            </div>
          </Card>
        </Show>
      </div>
    </IssueEditingProvider>
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
        <div class="flex flex-col h-screen w-full">
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
