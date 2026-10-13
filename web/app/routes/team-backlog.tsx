import { ListTodo, Plus } from "lucide-react";
import { Button } from "~/components/ui/button";
import { FilterBar } from "~/components/app/filter-bar";
import { IssueList } from "~/components/app/issue-list";
import { EmptyState, Page, PageHeader } from "~/components/app/page";
import { QueryStatus } from "~/components/app/query-status";
import { useI18n } from "~/lib/i18n";
import { useIssues } from "~/lib/queries";
import { backlogStageId } from "~/lib/teams";
import { useWorkspace } from "~/lib/workspace";
import { effectiveFilter, isNarrowed, whereIs } from "~/lib/filters";
import type { IssueFilter } from "~/lib/types";
import { useTeamContext } from "./team";

export default function TeamBacklog() {
  const { t } = useI18n();
  const { team, state, heading, tabs } = useTeamContext();
  const teamId = team.id;
  const { create, canWrite } = useWorkspace();
  const { filter, setFilter } = state;
  // Issues in a backlog stage. Those never belong to a sprint.
  const base: IssueFilter = {
    where: [whereIs("team_id", teamId), whereIs("stage_kind", "backlog")],
    sort: filter.sort ?? "priority",
  };
  const narrowed = isNarrowed(filter, ["team_id", "sprint_id", "stage_kind"]);
  const query = useIssues(effectiveFilter(filter, base));
  const issues = query.items;

  return (
    <Page>
      <PageHeader
        title={team.name}
        heading={heading}
        nav={tabs}
        actions={
          canWrite && (
            <Button
              variant="primary"
              size="sm"
              onPress={() =>
                create.show({ team_id: teamId, stage_id: backlogStageId(team.stages) })
              }
            >
              <Plus aria-hidden />
              {t("issue.new")}
            </Button>
          )
        }
      >
        <FilterBar
          filter={filter}
          onChange={setFilter}
          hide={["team_id", "sprint_id", "stage_kind"]}
          scope={base}
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
