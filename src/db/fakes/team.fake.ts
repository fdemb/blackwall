import { CreateTeamInput, TeamMutations } from "@/features/teams/dal/mutations";
import { faker } from "@faker-js/faker";
import { Team } from "../schema";

export function teamFake(workspaceSlug: string): CreateTeamInput {
  return {
    key: faker.string.alphanumeric(5).toUpperCase(),
    name: faker.company.name(),
    workspaceSlug: workspaceSlug,
  };
}

export async function teamFactory(
  workspaceSlug: string,
  count = 1,
): Promise<Team[]> {
  const teams: Team[] = [];
  for (let i = 0; i < count; i++) {
    teams.push(await TeamMutations.create(teamFake(workspaceSlug)));
  }
  return teams;
}
