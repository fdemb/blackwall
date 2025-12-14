import { db, dbSchema } from "@/db";
import type { User } from "@/db/schema";
import { AppError } from "@/features/shared/errors";
import { eq } from "drizzle-orm";
import { auth } from "../better-auth";

async function getSession(sessionHeaders: Headers) {
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

async function getUser(userId: string): Promise<User> {
  const foundUser = await db.query.user.findFirst({
    where: eq(dbSchema.user.id, userId),
  });

  if (!foundUser) {
    throw new AppError("NOT_FOUND", "User not found.");
  }

  return foundUser;
}

async function getPreferredTheme(user: User | undefined) {
  return user?.preferredTheme || "system";
}

export const AuthQueries = {
  getSession,
  getUser,
  getPreferredTheme,
};
