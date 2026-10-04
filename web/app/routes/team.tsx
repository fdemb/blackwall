import { useState } from "react";
import {
  Link,
  Navigate,
  Outlet,
  useLocation,
  useNavigate,
  useOutletContext,
  useParams,
} from "react-router";
import { CalendarRange, KanbanSquare, List, ListTodo } from "lucide-react";
import { Tab, TabList, Tabs } from "~/components/ui/tabs";
import { useQueueState, type QueueState } from "~/components/app/workbench";
import { TeamCrumb } from "~/components/app/page";
import { useT } from "~/lib/i18n";
import { useDocumentTitle } from "~/lib/title";
import { useWorkspace } from "~/lib/workspace";
import type { Id, Team as TeamT } from "~/lib/types";

/** A sprint id, `"none"` for issues outside every sprint, or `"all"`. */
export type SprintScope = Id;

interface TeamContext {
  team: TeamT;
  state: QueueState;
  sprint: SprintScope;
  setSprint: (s: SprintScope) => void;
  heading: React.ReactNode;
  tabs: React.ReactNode;
  sprintLink: React.ReactNode;
}

export function useTeamContext() {
  return useOutletContext<TeamContext>();
}

export default function Team() {
  const { teamId } = useParams();
  // Filters live in the layout, so list, board and backlog share them. A new team starts clean.
  return <TeamLayout key={teamId} />;
}

function TeamLayout() {
  const t = useT();
  const { teamId, ws: wsId } = useParams();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const { ws, team } = useWorkspace();
  const state = useQueueState();
  const activeSprint = ws.sprints.find((s) => s.team_id === teamId && s.state === "active");
  const [sprint, setSprint] = useState<SprintScope>(activeSprint ? activeSprint.id : "all");
  const tm = team(teamId!);
  useDocumentTitle(tm?.name ?? null);
  if (!tm) return <Navigate to={`/${wsId}/my-issues`} replace />;
  const base = `/${ws.id}/team/${tm.id}`;
  const layout = pathname.endsWith("/board")
    ? "board"
    : pathname.endsWith("/backlog")
      ? "backlog"
      : "list";
  const tab = "h-6 gap-1 px-2 text-xs pointer-coarse:h-8 [&_svg]:size-3";
  const tabs = (
    <Tabs
      selectedKey={layout}
      onSelectionChange={(k) => navigate(k === "list" ? base : `${base}/${String(k)}`)}
    >
      <TabList aria-label={tm.name}>
        <Tab id="list" className={tab}>
          <List />
          {t("team.list")}
        </Tab>
        <Tab id="board" className={tab}>
          <KanbanSquare />
          {t("team.board")}
        </Tab>
        <Tab id="backlog" className={tab}>
          <ListTodo />
          {t("team.backlog")}
        </Tab>
      </TabList>
    </Tabs>
  );
  const sprintLink = (
    <Link
      to={`${base}/sprints`}
      className="inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[13px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
    >
      <CalendarRange className="size-4" />
      {t("team.sprints")}
    </Link>
  );
  const heading = (
    <h1 className="mr-2">
      <TeamCrumb team={tm} wsId={ws.id} />
    </h1>
  );
  return (
    <Outlet
      context={
        {
          team: tm,
          state,
          sprint,
          setSprint,
          heading,
          tabs,
          sprintLink,
        } satisfies TeamContext
      }
    />
  );
}
