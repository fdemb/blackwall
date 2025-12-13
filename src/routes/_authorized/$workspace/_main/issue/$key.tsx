import type { User } from "@/db/schema";
import type { InferDbType } from "@/db/utils";
import { IssueActivityLog } from "@/features/issues/components/issue-activity-log";
import { IssueDescription } from "@/features/issues/components/issue-description";
import { IssueSidebar } from "@/features/issues/components/issue-sidebar";
import { IssueEditingProvider } from "@/features/issues/context/issue-editing.context";
import {
  get,
  getIssueLabels,
  updateDescription,
  updateSummary,
} from "@/features/issues/issue-actions";
import { getAssignableUsersQueryOptions } from "@/features/issues/query-options";
import { PageHeader } from "@/features/shared/components/blocks/page-header";
import { TeamAvatar } from "@/features/shared/components/custom-ui/avatar";
import {
  Breadcrumbs,
  BreadcrumbsItem,
} from "@/features/shared/components/custom-ui/breadcrumbs";
import { ScrollArea } from "@/features/shared/components/custom-ui/scroll-area";
import { Button } from "@/features/shared/components/ui/button";
import { Card, CardTitle } from "@/features/shared/components/ui/card";
import { Separator } from "@/features/shared/components/ui/separator";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/features/shared/components/ui/sidebar";
import { useWorkspaceData } from "@/features/shared/context/workspace-context";
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
      console.log("getIssueWithLabelsQueryOptions", workspaceSlug, issueKey);
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
  const initialData = Route.useLoaderData();

  const teamKey = () => initialData().issueData.team.key;
  const issueQuery = useQuery(() =>
    getIssueWithLabelsQueryOptions(params().workspace, params().key),
  );
  const assignableUsersQuery = useQuery(() =>
    getAssignableUsersQueryOptions(params().workspace, teamKey()),
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

            <div id="issue-sidebar-trigger" class="ml-auto"></div>
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
