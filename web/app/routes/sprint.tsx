import {
  Navigate,
  Outlet,
  useLocation,
  useNavigate,
  useOutletContext,
  useParams,
} from "react-router";
import { KanbanSquare, List, ListChecks } from "lucide-react";
import { Badge } from "~/components/ui/badge";
import { Tab, TabList, Tabs } from "~/components/ui/tabs";
import { PageCrumb, TeamCrumb } from "~/components/app/page";
import { SprintActions } from "~/components/app/sprint-actions";
import type { QueueState } from "~/components/app/workbench";
import { shortDate } from "~/lib/format";
import { useI18n } from "~/lib/i18n";
import { useWorkspace } from "~/lib/workspace";
import type { Sprint as SprintT, Team } from "~/lib/types";
import { useTeamContext } from "./team";

interface SprintContext {
  team: Team;
  state: QueueState;
  sprint: SprintT;
  heading: React.ReactNode;
  /** Board, List and Plan. A finished sprint can't be planned, so it has no Plan tab. */
  tabs: React.ReactNode;
  /** Dates, progress, and what the sprint's state allows next: edit, start, complete or archive. */
  actions: React.ReactNode;
}

export function useSprintContext() {
  return useOutletContext<SprintContext>();
}

export function isOpenSprint(sprint: SprintT) {
  return sprint.state === "planned" || sprint.state === "active";
}

export default function Sprint() {
  const { t, lang } = useI18n();
  const { sprintId } = useParams();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const { ws, report } = useWorkspace();
  const { team, state } = useTeamContext();
  const sprint = ws.sprints.find((s) => s.id === sprintId && s.team_id === team.id);
  const sprints = `/${ws.id}/team/${team.id}/sprints`;
  if (!sprint) return <Navigate to={sprints} replace />;
  const base = `${sprints}/${sprint.id}`;
  const stats = report.sprints.find((s) => s.id === sprint.id);
  const heading = (
    <h1 className="mr-2 flex min-w-0 items-center gap-2 ">
      <TeamCrumb team={team} wsId={ws.id} />
      <span aria-hidden="true" className="text-muted-foreground/50">
        /
      </span>
      <PageCrumb to={sprints}>{t("team.sprints")}</PageCrumb>
      <span aria-hidden="true" className="text-muted-foreground/50">
        /
      </span>
      <span className="truncate font-medium">{sprint.name}</span>
      <Badge tone={sprint.state === "active" ? "primary" : "neutral"}>
        {t(`sprint.state.${sprint.state}`)}
      </Badge>
    </h1>
  );
  const section = pathname.slice(base.length).split("/")[1] || "board";
  const tabs = (
    <Tabs
      selectedKey={section}
      onSelectionChange={(k) => navigate(k === "board" ? base : `${base}/${String(k)}`)}
    >
      <TabList aria-label={sprint.name}>
        <Tab id="board" size="compact">
          <KanbanSquare />
          {t("team.board")}
        </Tab>
        <Tab id="list" size="compact">
          <List />
          {t("sprint.list")}
        </Tab>
        {isOpenSprint(sprint) && (
          <Tab id="plan" size="compact">
            <ListChecks />
            {t("sprint.plan")}
          </Tab>
        )}
      </TabList>
    </Tabs>
  );
  const actions = (
    <>
      <span className="mr-1 hidden text-muted-foreground tabular-nums md:inline">
        {shortDate(sprint.starts_at, lang)} – {shortDate(sprint.ends_at, lang)}
        {stats && ` · ${t("sprint.progress", { done: stats.completed, total: stats.total })}`}
      </span>
      <SprintActions sprint={sprint} />
    </>
  );
  return (
    <Outlet context={{ team, state, sprint, heading, tabs, actions } satisfies SprintContext} />
  );
}
