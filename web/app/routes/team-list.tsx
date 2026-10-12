import { Workbench } from "~/components/app/workbench";
import { whereIs } from "~/lib/filters";
import { useTeamContext } from "./team";

export default function TeamList() {
  const { team, state, heading, tabs } = useTeamContext();
  return (
    <Workbench
      state={state}
      title={team.name}
      heading={heading}
      nav={tabs}
      base={{ where: [whereIs("team_id", team.id)] }}
      hide={["team_id"]}
    />
  );
}
