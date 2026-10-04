import { ListTodo, Plus } from "lucide-react";
import { Button } from "~/components/ui/button";
import { FilterBar } from "~/components/app/filter-bar";
import { IssueList } from "~/components/app/issue-list";
import { EmptyState, Page, PageHeader } from "~/components/app/page";
import { QueryStatus } from "~/components/app/query-status";
import { useT } from "~/lib/i18n";
import { useIssues } from "~/lib/queries";
import { useWorkspace } from "~/lib/workspace";
import { useTeamContext } from "./team";

export default function TeamBacklog() {
  const t = useT();
  const { team, state, heading, tabs, sprintLink } = useTeamContext();
  const teamId = team.id;
  const { create, canWrite } = useWorkspace();
  const { filter, setFilter } = state;
  const narrowed = Object.keys(filter).some(
    (k) => k !== "sort" && k !== "sprint_id" && k !== "team_id" && filter[k as keyof typeof filter],
  );
  const query = useIssues({
    ...filter,
    team_id: teamId,
    sprint_id: undefined,
    no_sprint: true,
    open: true,
    sort: filter.sort ?? "priority",
  });
  const issues = query.items;

  return (
    <Page>
      <PageHeader
        title={team.name}
        heading={heading}
        nav={tabs}
        actions={
          <>
            {sprintLink}
            {canWrite && (
              <Button variant="primary" size="sm" onPress={() => create.show({ team_id: teamId })}>
                <Plus />
                {t("issue.new")}
              </Button>
            )}
          </>
        }
      >
        <FilterBar
          filter={filter}
          onChange={setFilter}
          hide={["team_id", "sprint_id"]}
          saveable={false}
        />
      </PageHeader>
      <QueryStatus query={query} />
      <div className="flex min-h-0 flex-1 flex-col">
        <IssueList
          issues={issues}
          groupBy="none"
          fill
          emptyState={
            narrowed ? (
              <EmptyState
                title={t("empty.noMatch")}
                description={t("empty.noMatchSub")}
                action={<Button onPress={() => setFilter({})}>{t("filter.clear")}</Button>}
              />
            ) : (
              <EmptyState
                icon={<ListTodo />}
                title={t("backlog.emptyTitle")}
                description={t("backlog.emptySub")}
              />
            )
          }
        />
      </div>
    </Page>
  );
}
