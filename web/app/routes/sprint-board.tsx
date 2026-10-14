import { IssueBoard } from "~/components/app/issue-board";
import { useSprintContext } from "./sprint";

export default function SprintBoard() {
  const { team, state, sprint, heading, tabs, actions } = useSprintContext();
  return (
    <IssueBoard
      team={team}
      state={state}
      scope={{ sprint_id: sprint.id }}
      title={sprint.name}
      heading={heading}
      nav={tabs}
      actions={actions}
    />
  );
}
