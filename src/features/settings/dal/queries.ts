import { db, dbSchema } from "@/db";
import type { User } from "@/db/schema";
import { AppError } from "@/features/shared/errors";
import { eq } from "drizzle-orm";

async function getUserById(userId: string): Promise<User> {
  const user = await db.query.user.findFirst({
    where: eq(dbSchema.user.id, userId),
  });

  if (!user) {
    throw new AppError("NOT_FOUND", "User not found.");
  }

  return user;
}

export const SettingsQueries = {
  getUserById,
};
