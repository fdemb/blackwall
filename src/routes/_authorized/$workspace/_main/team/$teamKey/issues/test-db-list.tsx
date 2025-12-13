import { issueCollection } from "@/features/issues/collections/issue-collection";
import { IssueList } from "@/features/issues/components/issue-list";
import { PageHeader } from "@/features/shared/components/blocks/page-header";
import { TeamAvatar } from "@/features/shared/components/custom-ui/avatar";
import { useLiveQuery } from "@tanstack/solid-db";
import { createFileRoute } from "@tanstack/solid-router";
import ChevronRight from "lucide-solid/icons/chevron-right";

export const Route = createFileRoute(
  "/_authorized/$workspace/_main/team/$teamKey/issues/test-db-list",
)({
  component: RouteComponent,
});

function RouteComponent() {
  const params = Route.useParams();
  const ctx = Route.useRouteContext();

  const collection = issueCollection(params().workspace, params().teamKey);
  const query = useLiveQuery((q) =>
    q.from({
      collection,
    }),
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
          <div>Issues (db)</div>
        </div>
      </PageHeader>

      <IssueList issues={query.data} workspaceSlug={params().workspace} />
    </>
  );
}
