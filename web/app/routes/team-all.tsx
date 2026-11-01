import { Workbench } from "~/components/app/workbench";
import { whereIs } from "~/lib/filters";
import { useTeamContext } from "./team";

/** Every issue of the team in any stage, grouped by stage. Archived and trashed ones have their own pages. */
export default function TeamAll() {
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
