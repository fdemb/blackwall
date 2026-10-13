import {
  Navigate,
  Outlet,
  useLocation,
  useNavigate,
  useOutletContext,
  useParams,
} from "react-router";
import { KanbanSquare, List, ListTodo } from "lucide-react";
import { Tab, TabList, Tabs } from "~/components/ui/tabs";
import { useQueueState, type QueueState } from "~/components/app/workbench";
import { TeamCrumb } from "~/components/app/page";
import { useI18n } from "~/lib/i18n";
import { useDocumentTitle } from "~/lib/title";
import { useWorkspace } from "~/lib/workspace";
import type { Team as TeamT } from "~/lib/types";

interface TeamContext {
  team: TeamT;
  state: QueueState;
  heading: React.ReactNode;
  /** The issue views. Sprints sit beside them in the sidebar, not in these tabs. */
  tabs: React.ReactNode;
}

export function useTeamContext() {
  return useOutletContext<TeamContext>();
}

export default function Team() {
  const { teamId } = useParams();
  // Filters live in the layout, so every team view shares them. A new team starts clean.
  return <TeamLayout key={teamId} />;
}

function TeamLayout() {
  const { t } = useI18n();
  const { teamId, ws: wsId } = useParams();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const { ws, team } = useWorkspace();
  const state = useQueueState();
  const tm = team(teamId!);
  useDocumentTitle(tm?.name ?? null);
  if (!tm) return <Navigate to={`/${wsId}/my-issues`} replace />;
  const base = `/${ws.id}/team/${tm.id}`;
  const section = pathname.slice(base.length).split("/")[1] || "list";
  const tabs = (
    <Tabs
      selectedKey={section}
      onSelectionChange={(k) => navigate(k === "list" ? base : `${base}/${String(k)}`)}
    >
      <TabList aria-label={tm.name}>
        <Tab id="list" size="compact">
          <List />
          {t("team.active")}
        </Tab>
        <Tab id="board" size="compact">
          <KanbanSquare />
          {t("team.board")}
        </Tab>
        <Tab id="backlog" size="compact">
          <ListTodo />
          {t("team.backlog")}
        </Tab>
      </TabList>
    </Tabs>
  );
  const heading = (
    <h1 className="mr-2">
      <TeamCrumb team={tm} wsId={ws.id} />
    </h1>
  );
  return <Outlet context={{ team: tm, state, heading, tabs } satisfies TeamContext} />;
}
