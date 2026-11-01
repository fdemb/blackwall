import { useId, useMemo, useState } from "react";
import { Form } from "react-aria-components";
import { Navigate } from "react-router";
import { ListTodo, Minus, Plus, X } from "lucide-react";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/field";
import { FilterBar } from "~/components/app/filter-bar";
import { StageIcon } from "~/components/app/icons";
import type { HiddenFilter } from "~/components/app/filter-bar";
import { IssueList } from "~/components/app/issue-list";
import { EmptyState, Page, PageHeader } from "~/components/app/page";
import { QueryStatus } from "~/components/app/query-status";
import { useQueueState } from "~/components/app/workbench";
import { bulkIssueCommands } from "~/lib/bulk-issues";
import { OPEN, addClause, effectiveFilter, isNarrowed, whereIs } from "~/lib/filters";
import { useI18n } from "~/lib/i18n";
import { useIssues } from "~/lib/queries";
import { sprintStageId } from "~/lib/teams";
import { useWorkspace } from "~/lib/workspace";
import type { Id, IssueFilter, IssuePatch, Sprint, Team } from "~/lib/types";
import { isOpenSprint, useSprintContext } from "./sprint";

/** Unplanned work on the left, the sprint on the right. */
export default function SprintPlan() {
  const { team, sprint, heading, tabs, actions } = useSprintContext();
  const { ws } = useWorkspace();
  if (!isOpenSprint(sprint))
    return <Navigate to={`/${ws.slug}/team/${team.key}/sprints/${sprint.id}`} replace />;
  return (
    <Page>
      <PageHeader title={sprint.name} heading={heading} nav={tabs} actions={actions} />
      <div className="flex min-h-0 flex-1 flex-col divide-y divide-border md:flex-row md:divide-x md:divide-y-0">
        <Candidates team={team} sprint={sprint} />
        <Scope team={team} sprint={sprint} />
      </div>
    </Page>
  );
}

const CANDIDATE_SCOPE: HiddenFilter[] = ["team_id", "sprint_id", "stage_kind"];

/**
 * Open issues of the team that no sprint holds: Ready work outside backlog stages first, then the
 * backlog. Both sit in one list, so selection and dragging span them.
 */
function Candidates({ team, sprint }: { team: Team; sprint: Sprint }) {
  const { t } = useI18n();
  const { filter, setFilter } = useQueueState();
  const update = useBulkUpdate();
  const base: IssueFilter = {
    where: [whereIs("team_id", team.id), whereIs("sprint_id", null), OPEN],
    sort: filter.sort ?? "priority",
  };
  const scoped = effectiveFilter(filter, base);
  const query = useIssues(addClause(scoped, whereIs("stage_kind", "planned", "active")));
  const backlog = useIssues(addClause(scoped, whereIs("stage_kind", "backlog")));
  const narrowed = isNarrowed(filter, CANDIDATE_SCOPE);
  const issues = useMemo(() => [...query.items, ...backlog.items], [query.items, backlog.items]);
  const sections = useMemo(
    () =>
      [
        { id: "ready", title: t("sprint.ready"), items: query.items },
        {
          id: "backlog",
          title: t("team.backlog"),
          icon: <StageIcon kind="backlog" />,
          items: backlog.items,
        },
      ].filter((section) => section.items.length > 0),
    [query.items, backlog.items, t],
  );
  return (
    <Pane title={t("sprint.unplanned")} count={issues.length}>
      <FilterBar
        filter={filter}
        onChange={setFilter}
        hide={CANDIDATE_SCOPE}
        scope={base}
        saveable={false}
      />
      <QueryStatus query={query} />
      <IssueList
        issues={issues}
        sections={sections}
        fill
        emptyState={
          narrowed ? (
            <EmptyState
              title={t("empty.noMatch")}
              description={t("empty.noMatchSub")}
              action={<Button onPress={() => setFilter({})}>{t("filter.clear")}</Button>}
            />
          ) : (
            <EmptyState icon={<ListTodo />} title={t("sprint.unplannedEmpty")} />
          )
        }
        onDropIssues={(ids) => update(ids, { clear_sprint: true })}
        selectionBar={(ids, clear) => (
          <SelectionBar ids={ids} clear={clear}>
            <Button
              variant="primary"
              size="sm"
              onPress={() => update(ids, { sprint_id: sprint.id }, clear)}
            >
              <Plus aria-hidden />
              {t("sprint.add")}
            </Button>
          </SelectionBar>
        )}
      />
    </Pane>
  );
}

/** Everything in the sprint, done or not, with a row for adding new work at the end. */
function Scope({ team, sprint }: { team: Team; sprint: Sprint }) {
  const { t } = useI18n();
  const { canWrite } = useWorkspace();
  const update = useBulkUpdate();
  const query = useIssues({
    where: [whereIs("team_id", team.id), whereIs("sprint_id", sprint.id)],
    sort: "position",
  });
  const issues = query.items;
  const effort = issues.reduce((sum, issue) => sum + (issue.estimate ?? 0), 0);
  return (
    <Pane title={t("sprint.scope")} count={issues.length} aside={t("sprint.effort", { effort })}>
      <QueryStatus query={query} />
      <IssueList
        issues={issues}
        fill
        emptyState={
          <EmptyState title={t("sprint.scopeEmpty")} description={t("sprint.scopeEmptySub")} />
        }
        onDropIssues={(ids) => update(ids, { sprint_id: sprint.id })}
        selectionBar={(ids, clear) => (
          <SelectionBar ids={ids} clear={clear}>
            <Button size="sm" onPress={() => update(ids, { clear_sprint: true }, clear)}>
              <Minus aria-hidden />
              {t("sprint.remove")}
            </Button>
          </SelectionBar>
        )}
      />
      {canWrite && <QuickCreate team={team} sprint={sprint} />}
    </Pane>
  );
}

function Pane({
  title,
  count,
  aside,
  children,
}: {
  title: string;
  count: number;
  aside?: React.ReactNode;
  children: React.ReactNode;
}) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 px-4">
        <h2 id={id} className="font-medium">
          {title}
        </h2>
        <span className="tabular-nums text-muted-foreground">{count}</span>
        {aside && <span className="ml-auto tabular-nums text-muted-foreground">{aside}</span>}
      </div>
      {children}
    </section>
  );
}

/** Sits at the bottom of its pane, so each list keeps its own selection and action. */
function SelectionBar({
  ids,
  clear,
  children,
}: {
  ids: Id[];
  clear: () => void;
  children: React.ReactNode;
}) {
  const { t } = useI18n();
  if (ids.length === 0) return null;
  return (
    <div
      role="toolbar"
      aria-label={t("bulk.toolbar")}
      className="flex shrink-0 items-center gap-2 border-t border-border bg-popover px-3 py-2"
    >
      <span className="font-medium">{t("bulk.selected", { n: ids.length })}</span>
      <Button variant="ghost" size="icon" aria-label={t("action.clear")} onPress={clear}>
        <X aria-hidden />
      </Button>
      <div className="ml-auto">{children}</div>
    </div>
  );
}

function useBulkUpdate() {
  const { run } = useWorkspace();
  return (ids: Id[], patch: IssuePatch, clear?: () => void) => {
    for (const command of bulkIssueCommands(
      ids.map((id) => ({ id })),
      { update: patch },
    ))
      run(command).catch(() => {});
    clear?.();
  };
}

/** Enter creates the issue in the sprint and keeps the field ready for the next title. */
function QuickCreate({ team, sprint }: { team: Team; sprint: Sprint }) {
  const { t } = useI18n();
  const { run } = useWorkspace();
  const [title, setTitle] = useState("");
  return (
    <Form
      className="flex shrink-0 items-center gap-2 border-t border-border px-3 py-2"
      onSubmit={(e) => {
        e.preventDefault();
        const text = title.trim();
        if (!text) return;
        setTitle("");
        run({
          type: "create_issue",
          input: {
            team_id: team.id,
            title: text,
            stage_id: sprintStageId(team.stages) ?? null,
            sprint_id: sprint.id,
          },
        }).catch(() => setTitle((current) => current || text));
      }}
    >
      <Plus aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      <Input
        aria-label={t("sprint.newIssue")}
        placeholder={t("sprint.newIssue")}
        value={title}
        maxLength={500}
        onChange={(e) => setTitle(e.target.value)}
        className="flex-1"
      />
    </Form>
  );
}
