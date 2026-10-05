import { Navigate, useParams } from "react-router";
import { Badge } from "~/components/ui/badge";
import { IssueBoard } from "~/components/app/issue-board";
import { PageCrumb, TeamCrumb } from "~/components/app/page";
import { shortDate } from "~/lib/format";
import { useI18n } from "~/lib/i18n";
import { useWorkspace } from "~/lib/workspace";
import { useTeamContext } from "./team";

export default function SprintBoard() {
  const { t, lang } = useI18n();
  const { sprintId } = useParams();
  const { ws, report } = useWorkspace();
  const { team, state, tabs } = useTeamContext();
  const sprint = ws.sprints.find((s) => s.id === sprintId && s.team_id === team.id);
  const sprints = `/${ws.id}/team/${team.id}/sprints`;
  if (!sprint) return <Navigate to={sprints} replace />;
  const stats = report.sprints.find((s) => s.id === sprint.id);
  const heading = (
    <h1 className="mr-2 flex min-w-0 items-center gap-2 text-[13px]">
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
  return (
    <IssueBoard
      team={team}
      state={state}
      scope={{ sprint_id: sprint.id }}
      title={sprint.name}
      heading={heading}
      nav={tabs}
      actions={
        <span className="hidden text-xs text-muted-foreground tabular-nums md:inline">
          {shortDate(sprint.starts_at, lang)} – {shortDate(sprint.ends_at, lang)}
          {stats && ` · ${t("sprint.progress", { done: stats.completed, total: stats.total })}`}
        </span>
      }
    />
  );
}
