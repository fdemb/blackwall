import { useMemo, useState } from "react";
import { Link, Navigate, useParams, useSearchParams } from "react-router";
import { CalendarRange, KanbanSquare, List, ListTodo, Plus } from "lucide-react";
import { Button } from "~/components/ui/button";
import { Tab, TabList, Tabs } from "~/components/ui/tabs";
import { NullableSelect } from "~/components/app/pickers";
import { DndColumn } from "~/components/app/board";
import { StageIcon } from "~/components/app/icons";
import { FilterBar } from "~/components/app/filter-bar";
import { IssueList } from "~/components/app/issue-list";
import { Workbench } from "~/components/app/workbench";
import { EmptyState, Page, PageHeader, Scroll } from "~/components/app/page";
import { applyFilter, isDone } from "~/lib/filters";
import { useT } from "~/lib/i18n";
import { useWorkspace } from "~/lib/workspace";
import type { Id, IssueFilter, Workspace } from "~/lib/types";

type Layout = "list" | "board" | "backlog";

export function moveOptimistic(ws: Workspace, ids: Id[], stageId: Id, beforeId: Id | null): Workspace {
  const before = beforeId ? ws.issues.find((i) => i.id === beforeId) : undefined;
  const inStage = ws.issues.filter((i) => i.stage_id === stageId && !ids.includes(i.id));
  const end = Math.max(0, ...inStage.map((i) => i.position)) + 1;
  return {
    ...ws,
    issues: ws.issues.map((i) => {
      const k = ids.indexOf(i.id);
      return k < 0 ? i : { ...i, stage_id: stageId, position: before ? before.position - 0.5 + k * 0.01 : end + k };
    }),
  };
}

export default function Team() {
  const t = useT();
  const { teamId, ws: wsId } = useParams();
  const [params, setParams] = useSearchParams();
  const { ws, team } = useWorkspace();
  const tm = team(teamId!);
  if (!tm) return <Navigate to={`/${wsId}/my-issues`} replace />;
  const layout = (params.get("layout") as Layout) || "list";
  const tabs = (
    <Tabs selectedKey={layout} onSelectionChange={(k) => setParams({ layout: String(k) }, { replace: true })} className="px-4 pb-2">
      <TabList aria-label={tm.name}>
        <Tab id="list"><List />{t("team.issues")}</Tab>
        <Tab id="board"><KanbanSquare />{t("team.board")}</Tab>
        <Tab id="backlog"><ListTodo />{t("team.backlog")}</Tab>
      </TabList>
    </Tabs>
  );
  const sprintLink = (
    <Link to={`/${ws.id}/team/${tm.id}/sprints`} className="inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[13px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground">
      <CalendarRange className="size-4" />{t("team.sprints")}
    </Link>
  );
  if (layout === "board") return <BoardView key={tm.id} teamId={tm.id} name={tm.name} tabs={tabs} sprintLink={sprintLink} />;
  if (layout === "backlog") return <BacklogView key={tm.id} teamId={tm.id} name={tm.name} tabs={tabs} sprintLink={sprintLink} />;
  return (
    <Workbench
      key={tm.id}
      title={tm.name}
      base={{ team_id: tm.id }}
      hide={["team_id"]}
      actions={sprintLink}
      headerExtra={tabs}
    />
  );
}

function BoardView({ teamId, name, tabs, sprintLink }: { teamId: Id; name: string; tabs: React.ReactNode; sprintLink: React.ReactNode }) {
  const t = useT();
  const { ws, team, run, create } = useWorkspace();
  const tm = team(teamId)!;
  const [filter, setFilter] = useState<IssueFilter>({});
  const activeSprint = ws.sprints.find((s) => s.team_id === teamId && s.state === "active");
  const [sprint, setSprint] = useState<Id | null | "all">(activeSprint ? activeSprint.id : "all");
  const sprints = ws.sprints.filter((s) => s.team_id === teamId && s.state !== "archived");
  const stages = [...tm.stages].sort((a, b) => a.position - b.position);
  const issues = useMemo(() => {
    let list = applyFilter(ws, { ...filter, team_id: teamId, sort: "position" });
    if (sprint === "none") list = list.filter((i) => !i.sprint_id);
    else if (sprint !== "all" && sprint) list = list.filter((i) => i.sprint_id === sprint);
    return list;
  }, [ws, filter, teamId, sprint]);

  const onDrop = (stageId: Id) => (ids: Id[], beforeId: Id | null) => {
    if (!ids.length) return;
    (async () => {
      let before = beforeId;
      for (const id of ids) {
        if (id === before) continue;
        await run({ type: "move_issue", id, stage_id: stageId, before_id: before }, id === ids[0] ? { optimistic: (w) => moveOptimistic(w, ids, stageId, beforeId) } : undefined).catch(() => {});
      }
    })();
  };

  return (
    <Page>
      <PageHeader title={name} actions={sprintLink}>
        {tabs}
        <div className="flex flex-wrap items-center gap-2 pr-4">
          <div className="flex-1"><FilterBar filter={filter} onChange={setFilter} hide={["team_id", "sprint_id"]} saveable={false} /></div>
          <div className="w-44 pb-2">
            <NullableSelect
              aria-label={t("field.sprint")}
              noneLabel={t("board.allSprints")}
              value={sprint === "all" ? null : sprint}
              onChange={(v) => setSprint(v ?? "all")}
              options={[{ id: "none", label: t("board.noSprint") }, ...sprints.map((s) => ({ id: s.id, label: s.name }))]}
            />
          </div>
        </div>
      </PageHeader>
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
              onCreate={() => create.show({ team_id: teamId, stage_id: s.id, sprint_id: typeof sprint === "string" && sprint !== "all" && sprint !== "none" ? sprint : undefined })}
            />
          );
        })}
      </div>
    </Page>
  );
}

function BacklogView({ teamId, name, tabs, sprintLink }: { teamId: Id; name: string; tabs: React.ReactNode; sprintLink: React.ReactNode }) {
  const t = useT();
  const { ws, create, canWrite } = useWorkspace();
  const [filter, setFilter] = useState<IssueFilter>({});
  const issues = useMemo(
    () => applyFilter(ws, { ...filter, team_id: teamId, sort: filter.sort ?? "priority" }).filter((i) => !i.sprint_id && !isDone(ws, i)),
    [ws, filter, teamId],
  );
  return (
    <Page>
      <PageHeader
        title={name}
        subtitle={t("team.backlogSub")}
        actions={<>{sprintLink}{canWrite && <Button variant="primary" size="sm" onPress={() => create.show({ team_id: teamId })}><Plus />{t("issue.new")}</Button>}</>}
      >
        {tabs}
        <FilterBar filter={filter} onChange={setFilter} hide={["team_id", "sprint_id"]} saveable={false} />
      </PageHeader>
      <Scroll>
        <IssueList issues={issues} groupBy="none" emptyState={<EmptyState icon={<ListTodo />} title={t("backlog.emptyTitle")} description={t("backlog.emptySub")} />} />
      </Scroll>
    </Page>
  );
}
