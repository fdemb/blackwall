import { Workbench } from "~/components/app/workbench";
import { clause, whereIs } from "~/lib/filters";
import { useTeamContext } from "./team";

/** The team's issues outside the backlog. */
export default function TeamList() {
  const { team, state, heading, tabs } = useTeamContext();
  return (
    <Workbench
      state={state}
      title={team.name}
      heading={heading}
      nav={tabs}
      base={{ where: [whereIs("team_id", team.id), clause("stage_kind", "is_not", ["backlog"])] }}
      hide={["team_id", "stage_kind"]}
    />
  );
}
