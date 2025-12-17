import { db, dbSchema } from "@/db";
import type { User } from "@/db/schema";
import { auth } from "@/server/auth/better-auth";
import { AppError } from "@/server/shared/errors";
import { eq } from "drizzle-orm";
import { addUserToTeam, createTeamBasedOnWorkspace } from "../team/data";
import { createWorkspaceAndAddUser } from "../workspace/data";

export type SignUpEmailInput = {
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

// Query functions

export async function getAuthSession(sessionHeaders: Headers) {
  const session = await auth.api.getSession({
    headers: sessionHeaders,
  });

  if (!session) {
    return null;
  }

  const drizzleUser = await db.query.user.findFirst({
    where: eq(dbSchema.user.id, session.user.id),
  });

  if (!drizzleUser) {
    throw new AppError("NOT_FOUND", "User not found.");
  }

  return {
    ...session,
    drizzleUser,
  };
}

export async function getUserById(userId: string): Promise<User> {
  const foundUser = await db.query.user.findFirst({
    where: eq(dbSchema.user.id, userId),
  });

  if (!foundUser) {
    throw new AppError("NOT_FOUND", "User not found.");
  }

  return foundUser;
}

export async function getPreferredTheme(user: User | undefined) {
  return user?.preferredTheme || "system";
}

// Mutation functions

export async function createUserDependencies(input: {
  user: User;
  workspace: {
    displayName: string;
    slug: string;
  };
}) {
  const workspace = await createWorkspaceAndAddUser({
    input: input.workspace,
    userId: input.user.id,
  });
  const team = await createTeamBasedOnWorkspace(workspace);
  await addUserToTeam({ user: input.user, team });

  return { team, workspace };
}

export async function signUpEmail(input: SignUpEmailInput) {
  const { response: result, headers } = await auth.api.signUpEmail({
    body: input.account,
    returnHeaders: true,
  });

  const drizzleUser = await getUserById(result.user.id);
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

export async function signInEmail(input: { email: string; password: string }) {
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

export async function signOut(requestHeaders: Headers) {
  const result = await auth.api.signOut({
    headers: requestHeaders,
  });
  return result;
}

export async function updatePreferredTheme(
  theme: "system" | "light" | "dark",
  userId: string,
) {
  await db
    .update(dbSchema.user)
    .set({ preferredTheme: theme })
    .where(eq(dbSchema.user.id, userId));
}
