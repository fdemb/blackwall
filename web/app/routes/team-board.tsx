import { IssueBoard } from "~/components/app/issue-board";
import { useTeamContext } from "./team";

/** Every issue on the team. A sprint's issues have their own board under Sprints. */
export default function TeamBoard() {
  const { team, state, heading, tabs } = useTeamContext();
  return <IssueBoard team={team} state={state} title={team.name} heading={heading} nav={tabs} />;
}
