import { db, dbSchema } from "@/db";
import type { User } from "@/db/schema";
import { AppError } from "@/features/shared/errors";
import { eq } from "drizzle-orm";
import { auth } from "../better-auth";

export const AuthQueries = {
  getSession: async (sessionHeaders: Headers) => {
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
  },

  getUser: async (userId: string): Promise<User> => {
    const foundUser = await db.query.user.findFirst({
      where: eq(dbSchema.user.id, userId),
    });

    if (!foundUser) {
      throw new AppError("NOT_FOUND", "User not found.");
    }

    return foundUser;
  },

  getPreferredTheme: async (user: User | undefined) => {
    return user?.preferredTheme || "system";
  },
};
