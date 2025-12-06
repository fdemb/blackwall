import { randomUUIDv7 } from "bun";
import { relations } from "drizzle-orm";
import {
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { lifecycleTimestamps } from "../utils";
import { user } from "./auth.schema";
import { issue } from "./issue.schema";
import { workspace } from "./workspace.schema";

// Team table
export const team = sqliteTable(
  "team",
  {
    id: text()
      .primaryKey()
      .$defaultFn(() => randomUUIDv7()),
    name: text().notNull(),
    workspaceId: text()
      .notNull()
      .references(() => workspace.id),
    key: text().notNull(),
    avatar: text(),
    ...lifecycleTimestamps,
  },
  (table) => [
    uniqueIndex("team_workspace_id_key_unique").on(
      table.workspaceId,
      table.key,
    ),
  ],
);

// User team junction table
export const userTeam = sqliteTable(
  "user_on_team",
  {
    userId: text()
      .notNull()
      .references(() => user.id),
    teamId: text()
      .notNull()
      .references(() => team.id),
  },
  (table) => [
    primaryKey({
      columns: [table.userId, table.teamId],
    }),
  ],
);

// Relations
export const teamRelations = relations(team, ({ many }) => ({
  userTeams: many(userTeam),
  issues: many(issue),
}));

export const userTeamRelations = relations(userTeam, ({ one }) => ({
  user: one(user, {
    fields: [userTeam.userId],
    references: [user.id],
  }),
  team: one(team, {
    fields: [userTeam.teamId],
    references: [team.id],
  }),
}));

// Types
export type Team = typeof team.$inferSelect;
export type NewTeam = typeof team.$inferInsert;
