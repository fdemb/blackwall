import { faker } from "@faker-js/faker";
import { db, dbSchema } from "..";
import type { NewUser, User } from "../schema";

export function userFake(): NewUser {
  return {
    name: faker.person.fullName(),
    email: faker.internet.email(),
    createdAt: faker.date.recent(),
    updatedAt: faker.date.recent(),
  };
}

export async function userFactory(count = 1): Promise<User[]> {
  const usersToInsert = Array.from({ length: count }, () => userFake());
  const users = await db
    .insert(dbSchema.user)
    .values(usersToInsert)
    .returning();
  return users;
}
