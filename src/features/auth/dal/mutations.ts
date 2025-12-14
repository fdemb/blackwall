import { db, dbSchema } from "@/db";
import { eq } from "drizzle-orm";
import type { User } from "../../../db/schema";
import { TeamMutations } from "../../teams/dal/mutations";
import { WorkspaceMutations } from "../../workspaces/dal/mutations";
import { auth } from "../better-auth";
import { AuthQueries } from "./queries";

type SignUpEmailInput = {
  account: {
    email: string;
    password: string;
    name: string;
  };
  workspace: {
    displayName: string;
    slug: string;
  };
};

async function createUserDependencies(input: {
  user: User;
  workspace: {
    displayName: string;
    slug: string;
  };
}) {
  const workspace = await WorkspaceMutations.createAndAddUser({
    input: input.workspace,
    userId: input.user.id,
  });
  const team = await TeamMutations.createBasedOnWorkspace(workspace);
  await TeamMutations.addUser({ user: input.user, team });

  return { team, workspace };
}

async function signUpEmail(input: SignUpEmailInput) {
  const { response: result, headers } = await auth.api.signUpEmail({
    body: input.account,
    returnHeaders: true,
  });

  const drizzleUser = await AuthQueries.getUser(result.user.id);
  const { team, workspace } = await createUserDependencies({
    user: drizzleUser,
    workspace: input.workspace,
  });

  return {
    user: result.user,
    token: result.token,
    drizzleUser,
    team,
    workspace,
    headers,
  };
}

async function signInEmail(input: { email: string; password: string }) {
  const { response: result, headers } = await auth.api.signInEmail({
    body: {
      email: input.email,
      password: input.password,
    },
    returnHeaders: true,
  });

  return {
    result,
    headers,
  };
}

async function signOut(requestHeaders: Headers) {
  const result = await auth.api.signOut({
    headers: requestHeaders,
  });
  return result;
}

async function updatePreferredTheme(
  theme: "system" | "light" | "dark",
  userId: string,
) {
  await db
    .update(dbSchema.user)
    .set({ preferredTheme: theme })
    .where(eq(dbSchema.user.id, userId));
}

export const AuthMutations = {
  createUserDependencies,
  signUpEmail,
  signInEmail,
  signOut,
  updatePreferredTheme,
};
