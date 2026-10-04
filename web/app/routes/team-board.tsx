import { useMemo } from "react";
import { Button } from "~/components/ui/button";
import { NullableSelect } from "~/components/app/pickers";
import { DndColumn } from "~/components/app/board";
import { StageIcon } from "~/components/app/icons";
import { FilterBar } from "~/components/app/filter-bar";
import { EmptyState, Page, PageHeader } from "~/components/app/page";
import { QueryStatus } from "~/components/app/query-status";
import { useT } from "~/lib/i18n";
import { useIssues } from "~/lib/queries";
import { useWorkspace } from "~/lib/workspace";
import type { Id } from "~/lib/types";
import { useTeamContext } from "./team";

export default function TeamBoard() {
  const t = useT();
  const { ws, run, create } = useWorkspace();
  const { team: tm, state, sprint, setSprint, heading, tabs, sprintLink } = useTeamContext();
  const teamId = tm.id;
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
    const groups = new Map<Id, typeof issues>();
    for (const issue of issues) {
      const list = groups.get(issue.stage_id);
      if (list) list.push(issue);
      else groups.set(issue.stage_id, [issue]);
    }
    return groups;
  }, [issues]);

  return (
    <Page>
      <PageHeader title={tm.name} heading={heading} nav={tabs} actions={sprintLink}>
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
            const list = byStage.get(s.id) ?? [];
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
