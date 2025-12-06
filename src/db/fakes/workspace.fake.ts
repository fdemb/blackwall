import { WorkspaceMutations } from "@/features/workspaces/dal/mutations";
import { faker } from "@faker-js/faker";
import { NewWorkspace, Workspace } from "../schema";

export function workspaceFake(): NewWorkspace {
  const name = faker.company.name();
  const slug = name.toLowerCase().replace(/ /g, "-");

  return {
    displayName: name,
    slug: slug,
  };
}

export async function workspaceFactory(count = 1): Promise<Workspace[]> {
  const workspaces: Workspace[] = [];
  for (let i = 0; i < count; i++) {
    workspaces.push(await WorkspaceMutations.create(workspaceFake()));
  }
  return workspaces;
}
