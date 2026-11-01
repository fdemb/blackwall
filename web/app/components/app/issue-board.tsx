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

/** Issues in the expanded columns among `stageIds`, and a count for each collapsed one. */
function useColumns(scoped: IssueFilter, stageIds: Id[], folded: ReadonlySet<Id>) {
  const shown = stageIds.filter((id) => !folded.has(id));
  const hidden = stageIds.filter((id) => folded.has(id));
  const query = useIssues(addClause(scoped, clause("stage_id", "is", shown)), shown.length > 0);
  const counts = useStageCounts(
    addClause(scoped, clause("stage_id", "is", hidden)),
    hidden.length > 0,
  );
  return { query, counts };
}

/**
 * The board's issues. Collapsed columns show only a count, so their issues stay out of the
 * board. Stage clauses go on after the scope is merged, so a stage filter of the person's own
 * still applies. A sprint board's backlog column holds the team's backlog, since backlog issues
 * have no sprint.
 */
function useBoardIssues(
  teamId: Id,
  stages: readonly Stage[],
  own: IssueFilter,
  sprintId: Id | undefined,
) {
  const { me } = useWorkspace();
  const { isCollapsed, setCollapsed } = useCollapsedColumns(me, teamId);
  const folded = new Set(stages.filter(isCollapsed).map((s) => s.id));
  const team: IssueFilter = { where: [whereIs("team_id", teamId)], sort: "position" };
  const sprint = sprintId ? addClause(team, whereIs("sprint_id", sprintId)) : team;
  const backlog = sprintId ? stages.filter((s) => s.kind === "backlog") : [];
  const main = useColumns(
    effectiveFilter(own, sprint),
    stages.filter((s) => !backlog.includes(s)).map((s) => s.id),
    folded,
  );
  const extra = useColumns(
    effectiveFilter(own, team),
    backlog.map((s) => s.id),
    folded,
  );
  const issues = useMemo(
    () => [...main.query.items, ...extra.query.items],
    [main.query.items, extra.query.items],
  );
  const counts = { ...main.counts, ...extra.counts };
  const hidden = Object.values(counts).reduce((sum, n) => sum + n, 0);
  return { base: sprint, query: main.query, issues, counts, hidden, isCollapsed, setCollapsed };
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
  const { ws, run, create, canWrite } = useWorkspace();
  const { filter, setFilter } = state;
  // A finished sprint takes no more work, so its board leaves the team's backlog out.
  const finished = ws.sprints.some(
    (s) => s.id === scope.sprint_id && (s.state === "completed" || s.state === "archived"),
  );
  const stages = team.stages
    .filter((s) => !finished || s.kind !== "backlog")
    .sort((a, b) => a.position - b.position);
  // The sprint is the page's scope, never the person's filter, so a list filter can't narrow it.
  const own = withoutFields(filter, ["sprint_id"]);
  const narrowed = isNarrowed(own, ["team_id"]);
  const { base, query, issues, counts, hidden, isCollapsed, setCollapsed } = useBoardIssues(
    team.id,
    stages,
    own,
    scope.sprint_id,
  );
  // Only asked when filters hide everything, to tell "no match" from "no issues yet".
  const unfiltered = useIssues(
    base,
    narrowed && !query.loading && issues.length === 0 && hidden === 0,
  );
  const defaults = { team_id: team.id, sprint_id: scope.sprint_id };
  const backlog = new Set(stages.filter((s) => s.kind === "backlog").map((s) => s.id));

  const onDrop = (stageId: Id) => (ids: Id[], beforeId: Id | null, source: Id | null) => {
    const moves = ids.filter((id) => id !== beforeId);
    if (!moves.length) return;
    // `move_issue` only changes the stage. Backlog work dragged into the sprint joins it as well,
    // or it would land in its new stage with no sprint and drop off the board.
    const pulled = source !== null && backlog.has(source) && !backlog.has(stageId);
    const join = pulled ? scope.sprint_id : undefined;
    void Promise.all(
      moves.map((id) =>
        run({ type: "move_issue", id, stage_id: stageId, before_id: beforeId })
          .then(() =>
            join ? run({ type: "update_issue", id, patch: { sprint_id: join } }) : undefined,
          )
          .catch(() => {}),
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
              count={isCollapsed(s) ? (counts[s.id] ?? 0) : undefined}
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
