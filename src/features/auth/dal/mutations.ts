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

export const AuthMutations = {
  createUserDependencies: async (input: {
    user: User;
    workspace: {
      displayName: string;
      slug: string;
    };
  }) => {
    const workspace = await WorkspaceMutations.createAndAddUser({
      input: input.workspace,
      userId: input.user.id,
    });
    const team = await TeamMutations.createBasedOnWorkspace(workspace);
    await TeamMutations.addUser({ user: input.user, team });

    return { team, workspace };
  },

  signUpEmail: async (input: SignUpEmailInput) => {
    const { response: result, headers } = await auth.api.signUpEmail({
      body: input.account,
      returnHeaders: true,
    });

    const drizzleUser = await AuthQueries.getUser(result.user.id);
    const { team, workspace } = await AuthMutations.createUserDependencies({
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
  },

  signInEmail: async (input: { email: string; password: string }) => {
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
  },

  signOut: async (requestHeaders: Headers) => {
    const result = await auth.api.signOut({
      headers: requestHeaders,
    });
    return result;
  },

  updatePreferredTheme: async (theme: string, userId: string) => {
    await db
      .update(dbSchema.user)
      .set({ preferredTheme: theme })
      .where(eq(dbSchema.user.id, userId));
  },
};
