import { useState } from "react";
import { Plus } from "lucide-react";
import { Button } from "~/components/ui/button";
import { useIssues } from "~/lib/queries";
import { QueryStatus } from "./query-status";
import { useI18n } from "~/lib/i18n";
import { useWorkspace } from "~/lib/workspace";
import type { IssueFilter } from "~/lib/types";
import { FilterBar } from "./filter-bar";
import { IssueList, type GroupBy } from "./issue-list";
import { EmptyState, Page, PageHeader } from "./page";

/**
 * Filter and grouping state for a queue. Hoist it above a layout switch to keep it across tabs.
 *
 * This state is intentionally local, not in the URL: queues are transient working views (the saved,
 * shareable form lives in views). Pass the returned object as `state` to share or preserve it.
 */
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
  heading,
  nav,
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
  heading?: React.ReactNode;
  nav?: React.ReactNode;
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
  const { create } = useWorkspace();
  const own = useQueueState(initial);
  const { filter, setFilter, groupBy, setGroupBy } = state ?? own;
  const query = useIssues({ ...filter, ...base });
  const issues = extraFilter ? query.items.filter(extraFilter) : query.items;
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
      <WorkbenchHeader
        title={title}
        icon={icon}
        subtitle={subtitle}
        heading={heading}
        nav={nav}
        actions={actions}
        headerExtra={headerExtra}
        issueCount={issues.length}
        filter={filter}
        setFilter={setFilter}
        hide={hide}
        groupBy={groupBy}
        setGroupBy={setGroupBy}
        saveable={saveable}
        base={base}
        onNew={createDefaults}
      />
      <div className="flex min-h-0 flex-1 flex-col">
        {query.loading || query.error ? <QueryStatus query={query} /> : null}
        {(!query.loading || query.items.length > 0) && !query.error && (
          <WorkbenchList
            issues={issues}
            groupBy={groupBy}
            filtered={filtered}
            empty={empty}
            onClearFilter={() => setFilter({})}
            onNew={createDefaults}
          />
        )}
        {!query.loading && !query.error && <QueryStatus query={query} />}
      </div>
    </Page>
  );
}

/** Header composed of title row plus filter bar. Split so the list below stays a separate piece. */
function WorkbenchHeader({
  title,
  icon,
  subtitle,
  heading,
  nav,
  actions,
  headerExtra,
  issueCount,
  filter,
  setFilter,
  hide,
  groupBy,
  setGroupBy,
  saveable,
  base,
  onNew,
}: {
  title: React.ReactNode;
  icon?: React.ReactNode;
  subtitle?: React.ReactNode;
  heading?: React.ReactNode;
  nav?: React.ReactNode;
  actions?: React.ReactNode;
  headerExtra?: React.ReactNode;
  issueCount: number;
  filter: IssueFilter;
  setFilter: (f: IssueFilter) => void;
  hide: (keyof IssueFilter)[];
  groupBy: GroupBy;
  setGroupBy: (g: GroupBy) => void;
  saveable: boolean;
  base: IssueFilter;
  onNew: () => void;
}) {
  const { t } = useI18n();
  const { canWrite } = useWorkspace();
  return (
    <PageHeader
      title={title}
      icon={icon}
      subtitle={subtitle ?? t("count.issues", { n: issueCount })}
      heading={heading}
      nav={nav}
      actions={
        <>
          {actions}
          {canWrite && (
            <Button variant="primary" size="sm" onPress={onNew}>
              <Plus aria-hidden />
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
  );
}

/** The issue list with its empty state. Separated from the header so each composes on its own. */
function WorkbenchList({
  issues,
  groupBy,
  filtered,
  empty,
  onClearFilter,
  onNew,
}: {
  issues: import("~/lib/types").Issue[];
  groupBy: GroupBy;
  filtered: boolean;
  empty?: React.ReactNode;
  onClearFilter: () => void;
  onNew: () => void;
}) {
  const { t } = useI18n();
  const { canWrite } = useWorkspace();
  return (
    <IssueList
      issues={issues}
      groupBy={groupBy}
      showTeam
      fill
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
                <Button onPress={onClearFilter}>{t("filter.clear")}</Button>
              ) : canWrite ? (
                <Button variant="primary" onPress={onNew}>
                  <Plus aria-hidden />
                  {t("issue.new")}
                </Button>
              ) : undefined
            }
          />
        )
      }
    />
  );
}
