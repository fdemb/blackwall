import { Workbench } from "~/components/app/workbench";
import { whereIs } from "~/lib/filters";
import { useTeamContext } from "./team";

/** The team's open issues outside the backlog: those in planned and active stages. */
export default function TeamList() {
  const { team, state, heading, tabs } = useTeamContext();
  return (
    <Workbench
      state={state}
      title={team.name}
      heading={heading}
      nav={tabs}
      base={{
        where: [whereIs("team_id", team.id), whereIs("stage_kind", "planned", "active")],
      }}
      hide={["team_id", "stage_kind"]}
    />
  );
}
