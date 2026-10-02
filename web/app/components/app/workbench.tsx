import { useMemo, useState } from "react";
import { Plus } from "lucide-react";
import { Button } from "~/components/ui/button";
import { applyFilter } from "~/lib/filters";
import { useT } from "~/lib/i18n";
import { useWorkspace } from "~/lib/workspace";
import type { IssueFilter } from "~/lib/types";
import { FilterBar } from "./filter-bar";
import { IssueList, type GroupBy } from "./issue-list";
import { EmptyState, Page, PageHeader, Scroll } from "./page";

/** Filter and grouping state for a queue. Hoist it above a layout switch to keep it across tabs. */
export function useQueueState(initial: IssueFilter = {}) {
  const { group_by, ...rest } = initial;
  const [filter, setFilter] = useState<IssueFilter>(rest);
  const [groupBy, setGroupBy] = useState<GroupBy>(group_by ?? "stage");
  return { filter, setFilter, groupBy, setGroupBy };
}
export type QueueState = ReturnType<typeof useQueueState>;

/** Filterable, groupable issue list shared by My issues, All issues and saved views. */
export function Workbench({
  title,
  icon,
  subtitle,
  base = {},
  initial = {},
  hide = [],
  actions,
  headerExtra,
  empty,
  saveable = true,
  extraFilter,
  state,
}: {
  title: React.ReactNode;
  icon?: React.ReactNode;
  subtitle?: React.ReactNode;
  base?: IssueFilter;
  initial?: IssueFilter;
  hide?: (keyof IssueFilter)[];
  actions?: React.ReactNode;
  headerExtra?: React.ReactNode;
  empty?: React.ReactNode;
  saveable?: boolean;
  extraFilter?: (i: import("~/lib/types").Issue) => boolean;
  /** Supplied by a parent that needs to read or keep the filters. Otherwise the list keeps its own. */
  state?: QueueState;
}) {
  const t = useT();
  const { ws, create, canWrite } = useWorkspace();
  const own = useQueueState(initial);
  const { filter, setFilter, groupBy, setGroupBy } = state ?? own;
  const issues = useMemo(() => {
    const list = applyFilter(ws, { ...filter, ...base });
    return extraFilter ? list.filter(extraFilter) : list;
  }, [ws, filter, base, extraFilter]);
  const filtered = Object.keys(filter).some(
    (k) => k !== "sort" && !hide.includes(k as keyof IssueFilter) && filter[k as keyof IssueFilter],
  );
  // A new issue starts in the context the list is scoped to: the team, project or assignee on screen.
  const scope = { ...filter, ...base };
  const createDefaults = () =>
    create.show({
      team_id: scope.team_id,
      project_id: scope.project_id,
      sprint_id: scope.sprint_id,
      assignee: scope.assignee,
    });
  return (
    <Page>
      <PageHeader
        title={title}
        icon={icon}
        subtitle={subtitle ?? t("count.issues", { n: issues.length })}
        actions={
          <>
            {actions}
            {canWrite && (
              <Button variant="primary" size="sm" onPress={createDefaults}>
                <Plus />
                {t("issue.new")}
              </Button>
            )}
          </>
        }
      >
        {headerExtra}
        <FilterBar
          filter={filter}
          onChange={setFilter}
          hide={hide}
          groupBy={groupBy}
          onGroupBy={setGroupBy}
          saveable={saveable}
          scope={base}
        />
      </PageHeader>
      <Scroll>
        <IssueList
          issues={issues}
          groupBy={groupBy}
          showTeam
          emptyState={
            empty && !filtered ? (
              empty
            ) : (
              <EmptyState
                title={filtered ? t("empty.noMatch") : t("empty.issues")}
                description={
                  filtered
                    ? t("empty.noMatchSub")
                    : canWrite
                      ? t("empty.issuesSub")
                      : t("empty.issuesViewerSub")
                }
                action={
                  filtered ? (
                    <Button onPress={() => setFilter({})}>{t("filter.clear")}</Button>
                  ) : canWrite ? (
                    <Button variant="primary" onPress={createDefaults}>
                      <Plus />
                      {t("issue.new")}
                    </Button>
                  ) : undefined
                }
              />
            )
          }
        />
      </Scroll>
    </Page>
  );
}
