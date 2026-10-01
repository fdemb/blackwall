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
}) {
  const t = useT();
  const { ws, create, canWrite } = useWorkspace();
  const [filter, setFilter] = useState<IssueFilter>(initial);
  const [groupBy, setGroupBy] = useState<GroupBy>("stage");
  const issues = useMemo(() => {
    const list = applyFilter(ws, { ...filter, ...base });
    return extraFilter ? list.filter(extraFilter) : list;
  }, [ws, filter, base, extraFilter]);
  const filtered = Object.keys(filter).some((k) => k !== "sort" && filter[k as keyof IssueFilter]);
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
              <Button variant="primary" size="sm" onPress={() => create.show()}>
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
                description={filtered ? t("empty.noMatchSub") : t("empty.issuesSub")}
                action={
                  filtered ? (
                    <Button onPress={() => setFilter({})}>{t("filter.clear")}</Button>
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
