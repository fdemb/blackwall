import { useState } from "react";
import { Link, Navigate, useParams, useSearchParams } from "react-router";
import { CalendarRange, KanbanSquare, List, ListTodo, Plus } from "lucide-react";
import { Button } from "~/components/ui/button";
import { Tab, TabList, Tabs } from "~/components/ui/tabs";
import { NullableSelect } from "~/components/app/pickers";
import { DndColumn } from "~/components/app/board";
import { StageIcon } from "~/components/app/icons";
import { FilterBar } from "~/components/app/filter-bar";
import { IssueList } from "~/components/app/issue-list";
import { Workbench, useQueueState, type QueueState } from "~/components/app/workbench";
import { EmptyState, Page, PageHeader, Scroll } from "~/components/app/page";
import { useT } from "~/lib/i18n";
import { useIssues } from "~/lib/queries";
import { QueryStatus } from "~/components/app/query-status";
import { useWorkspace } from "~/lib/workspace";
import type { Id } from "~/lib/types";

type Layout = "list" | "board" | "backlog";

/** A sprint id, `"none"` for issues outside every sprint, or `"all"`. */
type SprintScope = Id;

export default function Team() {
  const { teamId } = useParams();
  // Filters live above the layout switch, so list, board and backlog share them. A new team starts clean.
  return <TeamPage key={teamId} />;
}

function TeamPage() {
  const t = useT();
  const { teamId, ws: wsId } = useParams();
  const [params, setParams] = useSearchParams();
  const { ws, team } = useWorkspace();
  const state = useQueueState();
  const activeSprint = ws.sprints.find((s) => s.team_id === teamId && s.state === "active");
  const [sprint, setSprint] = useState<SprintScope>(activeSprint ? activeSprint.id : "all");
  const tm = team(teamId!);
  if (!tm) return <Navigate to={`/${wsId}/my-issues`} replace />;
  const layout = (params.get("layout") as Layout) || "list";
  const tabs = (
    <Tabs
      selectedKey={layout}
      onSelectionChange={(k) => setParams({ layout: String(k) }, { replace: true })}
      className="px-4 pb-2"
    >
      <TabList aria-label={tm.name}>
        <Tab id="list">
          <List />
          {t("team.issues")}
        </Tab>
        <Tab id="board">
          <KanbanSquare />
          {t("team.board")}
        </Tab>
        <Tab id="backlog">
          <ListTodo />
          {t("team.backlog")}
        </Tab>
      </TabList>
    </Tabs>
  );
  const sprintLink = (
    <Link
      to={`/${ws.id}/team/${tm.id}/sprints`}
      className="inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[13px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
    >
      <CalendarRange className="size-4" />
      {t("team.sprints")}
    </Link>
  );
  if (layout === "board")
    return (
      <BoardView
        teamId={tm.id}
        name={tm.name}
        tabs={tabs}
        sprintLink={sprintLink}
        state={state}
        sprint={sprint}
        setSprint={setSprint}
      />
    );
  if (layout === "backlog")
    return (
      <BacklogView
        teamId={tm.id}
        name={tm.name}
        tabs={tabs}
        sprintLink={sprintLink}
        state={state}
      />
    );
  return (
    <Workbench
      state={state}
      title={tm.name}
      base={{ team_id: tm.id }}
      hide={["team_id"]}
      actions={sprintLink}
      headerExtra={tabs}
    />
  );
}

function BoardView({
  teamId,
  name,
  tabs,
  sprintLink,
  state,
  sprint,
  setSprint,
}: {
  teamId: Id;
  name: string;
  tabs: React.ReactNode;
  sprintLink: React.ReactNode;
  state: QueueState;
  sprint: SprintScope;
  setSprint: (s: SprintScope) => void;
}) {
  const t = useT();
  const { ws, team, run, create } = useWorkspace();
  const tm = team(teamId)!;
  const { filter, setFilter } = state;
  const sprints = ws.sprints.filter((s) => s.team_id === teamId && s.state !== "archived");
  const stages = [...tm.stages].sort((a, b) => a.position - b.position);
  const narrowed =
    Object.keys(filter).some(
      (k) =>
        k !== "sort" && k !== "sprint_id" && k !== "team_id" && filter[k as keyof typeof filter],
    ) || sprint !== "all";
  const query = useIssues({
    ...filter,
    team_id: teamId,
    sort: "position",
    sprint_id: sprint && sprint !== "all" && sprint !== "none" ? sprint : undefined,
    no_sprint: sprint === "none",
  });
  const issues = query.items;
  // Only asked when filters hide everything, to tell "no match" from "no issues yet".
  const unfiltered = useIssues(
    { team_id: teamId },
    narrowed && !query.loading && issues.length === 0,
  );
  const teamHasIssues = unfiltered.items.length > 0;

  const onDrop = (stageId: Id) => (ids: Id[], beforeId: Id | null) => {
    if (!ids.length) return;
    void (async () => {
      const before = beforeId;
      for (const id of ids) {
        if (id === before) continue;
        await run({ type: "move_issue", id, stage_id: stageId, before_id: before }).catch(() => {});
      }
    })();
  };

  return (
    <Page>
      <PageHeader title={name} actions={sprintLink}>
        {tabs}
        <div className="flex flex-wrap items-center gap-2 pr-4">
          <div className="flex-1">
            <FilterBar
              filter={filter}
              onChange={setFilter}
              hide={["team_id", "sprint_id"]}
              saveable={false}
            />
          </div>
          <div className="w-44 pb-2">
            <NullableSelect
              aria-label={t("field.sprint")}
              noneLabel={t("board.allSprints")}
              value={sprint === "all" ? null : sprint}
              onChange={(v) => setSprint(v ?? "all")}
              options={[
                { id: "none", label: t("board.noSprint") },
                ...sprints.map((s) => ({ id: s.id, label: s.name })),
              ]}
            />
          </div>
        </div>
      </PageHeader>
      <QueryStatus query={query} />
      {issues.length === 0 && narrowed && teamHasIssues ? (
        <EmptyState
          title={t("empty.noMatch")}
          description={t("empty.noMatchSub")}
          action={
            <Button
              onPress={() => {
                setFilter({});
                setSprint("all");
              }}
            >
              {t("filter.clear")}
            </Button>
          }
        />
      ) : (
        <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto p-3">
          {stages.map((s) => {
            const list = issues.filter((i) => i.stage_id === s.id);
            return (
              <DndColumn
                key={s.id}
                id={s.id}
                title={s.name}
                icon={<StageIcon kind={s.kind} />}
                issues={list}
                onDrop={onDrop(s.id)}
                onCreate={() =>
                  create.show({
                    team_id: teamId,
                    stage_id: s.id,
                    sprint_id:
                      typeof sprint === "string" && sprint !== "all" && sprint !== "none"
                        ? sprint
                        : undefined,
                  })
                }
              />
            );
          })}
        </div>
      )}
    </Page>
  );
}

function BacklogView({
  teamId,
  name,
  tabs,
  sprintLink,
  state,
}: {
  teamId: Id;
  name: string;
  tabs: React.ReactNode;
  sprintLink: React.ReactNode;
  state: QueueState;
}) {
  const t = useT();
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
        title={name}
        subtitle={t("team.backlogSub")}
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
        {tabs}
        <FilterBar
          filter={filter}
          onChange={setFilter}
          hide={["team_id", "sprint_id"]}
          saveable={false}
        />
      </PageHeader>
      <QueryStatus query={query} />
      <Scroll>
        <IssueList
          issues={issues}
          groupBy="none"
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
      </Scroll>
    </Page>
  );
}
