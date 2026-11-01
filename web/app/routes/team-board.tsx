import { Link } from "react-router";
import { ArrowUpRight, IterationCw } from "lucide-react";
import { buttonVariants } from "~/components/ui/button";
import { IssueBoard } from "~/components/app/issue-board";
import { EmptyState, Page, PageHeader } from "~/components/app/page";
import { sprintLabel } from "~/lib/format";
import { useI18n } from "~/lib/i18n";
import { sprintPath } from "~/lib/last-view";
import { useWorkspace } from "~/lib/workspace";
import { useTeamContext } from "./team";

/** Every issue on the team. A team that uses sprints sees its active sprint here instead. */
export default function TeamBoard() {
  const { t } = useI18n();
  const { ws } = useWorkspace();
  const { team, state, heading, tabs } = useTeamContext();
  if (!team.sprints)
    return <IssueBoard team={team} state={state} title={team.name} heading={heading} nav={tabs} />;
  const active = ws.sprints.find((s) => s.team_id === team.id && s.state === "active");
  if (!active)
    return (
      <Page>
        <PageHeader title={team.name} heading={heading} nav={tabs} />
        <EmptyState
          icon={<IterationCw />}
          title={t("board.noActiveSprint")}
          description={t("board.noActiveSprintSub")}
          action={
            <Link
              to={`/${ws.slug}/team/${team.key}/sprints`}
              className={buttonVariants({ variant: "secondary", size: "md" })}
            >
              {t("team.sprints")}
            </Link>
          }
        />
      </Page>
    );
  return (
    <IssueBoard
      team={team}
      state={state}
      scope={{ sprint_id: active.id }}
      title={team.name}
      heading={heading}
      nav={tabs}
      actions={
        <Link
          to={sprintPath(ws.slug, team.key, active)}
          className={buttonVariants({ variant: "ghost", size: "sm" })}
        >
          {sprintLabel(active)}
          <ArrowUpRight aria-hidden className="size-3.5" />
        </Link>
      }
    />
  );
}
