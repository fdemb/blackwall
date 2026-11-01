import { useMemo } from "react";
import { Plus } from "lucide-react";
import { Button } from "~/components/ui/button";
import { useI18n } from "~/lib/i18n";
import { useCollapsedColumns } from "~/lib/board-columns";
import { useIssues, useStageCounts } from "~/lib/queries";
import { useWorkspace } from "~/lib/workspace";
import type { Id, Issue, IssueFilter, Stage, Team } from "~/lib/types";
import {
  addClause,
  clause,
  effectiveFilter,
  isNarrowed,
  whereIs,
  withoutFields,
} from "~/lib/filters";
import { DndColumn } from "./board";
import { FilterBar } from "./filter-bar";
import { StageIcon } from "./icons";
import { EmptyState, Page, PageHeader } from "./page";
import { QueryStatus } from "./query-status";
import type { QueueState } from "./workbench";

/**
 * The issues of the board's expanded columns, and a count for each collapsed one. Collapsed
 * columns show only a count, so their issues stay out of the board. The stage clause goes on
 * after the scope is merged, so a stage filter of the person's own still applies.
 */
function useBoardIssues(teamId: Id, stages: readonly Stage[], scoped: IssueFilter) {
  const { me } = useWorkspace();
  const { isCollapsed, setCollapsed } = useCollapsedColumns(me, teamId);
  const collapsed = stages.filter(isCollapsed).map((s) => s.id);
  const within = (op: "is" | "is_not") => addClause(scoped, clause("stage_id", op, collapsed));
  const query = useIssues(collapsed.length ? within("is_not") : scoped);
  const hiddenCounts = useStageCounts(within("is"), collapsed.length > 0);
  const hidden = Object.values(hiddenCounts).reduce((sum, n) => sum + n, 0);
  return { query, hiddenCounts, hidden, isCollapsed, setCollapsed };
}

/**
 * A team's stages as columns, with the filter bar above. `scope` is what the page fixes, such as
 * the sprint; the person's filters can't widen it.
 */
export function IssueBoard({
  team,
  state,
  scope = {},
  title,
  heading,
  nav,
  actions,
}: {
  team: Team;
  state: QueueState;
  scope?: { sprint_id?: Id };
  title: string;
  heading: React.ReactNode;
  nav?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  const { t } = useI18n();
  const { run, create, canWrite } = useWorkspace();
  const { filter, setFilter } = state;
  // Backlog issues have no sprint, so a sprint board has no backlog column.
  const stages = team.stages
    .filter((s) => !scope.sprint_id || s.kind !== "backlog")
    .sort((a, b) => a.position - b.position);
  // The sprint is the page's scope, never the person's filter, so a list filter can't narrow it.
  const base: IssueFilter = {
    where: [
      whereIs("team_id", team.id),
      ...(scope.sprint_id ? [whereIs("sprint_id", scope.sprint_id)] : []),
    ],
    sort: "position",
  };
  const own = withoutFields(filter, ["sprint_id"]);
  const narrowed = isNarrowed(own, ["team_id"]);
  const { query, hiddenCounts, hidden, isCollapsed, setCollapsed } = useBoardIssues(
    team.id,
    stages,
    effectiveFilter(own, base),
  );
  const issues = query.items;
  // Only asked when filters hide everything, to tell "no match" from "no issues yet".
  const unfiltered = useIssues(
    base,
    narrowed && !query.loading && issues.length === 0 && hidden === 0,
  );
  const defaults = { team_id: team.id, sprint_id: scope.sprint_id };

  const onDrop = (stageId: Id) => (ids: Id[], beforeId: Id | null) => {
    const moves = ids.filter((id) => id !== beforeId);
    if (!moves.length) return;
    void Promise.all(
      moves.map((id) =>
        run({ type: "move_issue", id, stage_id: stageId, before_id: beforeId }).catch(() => {}),
      ),
    );
  };
  // One pass over the issues instead of a filter per column.
  const byStage = useMemo(() => {
    const groups = new Map<Id, Issue[]>();
    for (const issue of issues) {
      const list = groups.get(issue.stage_id);
      if (list) list.push(issue);
      else groups.set(issue.stage_id, [issue]);
    }
    return groups;
  }, [issues]);

  return (
    <Page>
      <PageHeader
        title={title}
        heading={heading}
        nav={nav}
        actions={
          <>
            {actions}
            {canWrite && (
              <Button variant="primary" size="sm" onPress={() => create.show(defaults)}>
                <Plus aria-hidden />
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
          scope={base}
          saveable={false}
          sortable={false}
        />
      </PageHeader>
      <QueryStatus query={query} />
      {issues.length === 0 && hidden === 0 && narrowed && unfiltered.items.length > 0 ? (
        <EmptyState
          title={t("empty.noMatch")}
          description={t("empty.noMatchSub")}
          action={<Button onPress={() => setFilter({})}>{t("filter.clear")}</Button>}
        />
      ) : (
        <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto p-3">
          {stages.map((s) => (
            <DndColumn
              key={s.id}
              id={s.id}
              title={s.name}
              icon={<StageIcon kind={s.kind} />}
              issues={byStage.get(s.id) ?? []}
              count={isCollapsed(s) ? (hiddenCounts[s.id] ?? 0) : undefined}
              collapsed={isCollapsed(s)}
              onCollapsedChange={(c) => setCollapsed(s.id, c)}
              onDrop={onDrop(s.id)}
              onCreate={() => create.show({ ...defaults, stage_id: s.id })}
            />
          ))}
        </div>
      )}
    </Page>
  );
}
