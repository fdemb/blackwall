import { Workbench } from "~/components/app/workbench";
import { useTeamContext } from "./team";

export default function TeamList() {
  const { team, state, heading, tabs, sprintLink } = useTeamContext();
  return (
    <Workbench
      state={state}
      title={team.name}
      heading={heading}
      nav={tabs}
      base={{ team_id: team.id }}
      hide={["team_id"]}
      actions={sprintLink}
    />
  );
}
