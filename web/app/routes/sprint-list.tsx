import { Workbench } from "~/components/app/workbench";
import { whereIs } from "~/lib/filters";
import { useSprintContext } from "./sprint";

/** Every issue in the sprint, done or not, as a filterable list. */
export default function SprintList() {
  const { team, state, sprint, heading, tabs, actions } = useSprintContext();
  return (
    <Workbench
      state={state}
      title={sprint.name}
      heading={heading}
      nav={tabs}
      actions={actions}
      base={{ where: [whereIs("team_id", team.id), whereIs("sprint_id", sprint.id)] }}
      hide={["team_id", "sprint_id"]}
      saveable={false}
    />
  );
}
