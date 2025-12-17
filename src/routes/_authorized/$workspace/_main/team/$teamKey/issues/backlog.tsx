import { CreateDialog } from "@/components/blocks/create-dialog";
import { PageHeader } from "@/components/blocks/page-header";
import { TeamAvatar } from "@/components/custom-ui/avatar";
import { IssueList } from "@/components/issues/issue-list";
import { list } from "@/server/issues/api";
import { queryOptions, useQuery } from "@tanstack/solid-query";
import { createFileRoute, notFound } from "@tanstack/solid-router";
import ChevronRight from "lucide-solid/icons/chevron-right";
import { Show } from "solid-js";

const listIssuesQueryOptions = (workspaceSlug: string, teamKey: string) =>
  queryOptions({
    queryKey: ["issues", "list", "backlog", workspaceSlug, teamKey],
    queryFn: () =>
      list({
        data: {
          workspaceSlug,
          teamKey,
          statusFilters: ["backlog"],
        },
      }),
  });

export const Route = createFileRoute(
  "/_authorized/$workspace/_main/team/$teamKey/issues/backlog",
)({
  component: RouteComponent,
  loader: async ({ params, context }) => {
    const issues = await context.queryClient.ensureQueryData(
      listIssuesQueryOptions(params.workspace, params.teamKey),
    );

    if (!issues) {
      throw notFound();
    }

    return {
      issues,
    };
  },
});

function RouteComponent() {
  const params = Route.useParams();
  const ctx = Route.useRouteContext();
  const issuesQuery = useQuery(() =>
    listIssuesQueryOptions(params().workspace, params().teamKey),
  );

  const issues = () => issuesQuery.data ?? [];

  return (
    <>
      <PageHeader>
        <div class="flex flex-row items-center">
          <div class="flex flex-row items-center gap-1">
            <TeamAvatar team={ctx().team} size="5" />

            {ctx().team.name}
          </div>
          <ChevronRight class="size-4 mx-2 shrink-0" />
          <div>Backlog</div>
        </div>
      </PageHeader>

      <Show when={issues().length > 0} fallback={<IssueEmpty />}>
        <IssueList issues={issues()} workspaceSlug={params().workspace} />
      </Show>
    </>
  );
}

function IssueEmpty() {
  return (
    <div class="flex items-center justify-center h-full">
      <div class="p-6 flex flex-col gap-4">
        <p class="text-center text-muted-foreground font-medium">
          No issues found
        </p>
        <CreateDialog status="backlog" />
      </div>
    </div>
  );
}
