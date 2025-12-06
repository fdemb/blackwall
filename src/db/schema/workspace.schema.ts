import { randomUUIDv7 } from "bun";
import { relations } from "drizzle-orm";
import {
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { user } from "./auth.schema";
import { issue } from "./issue.schema";

export const workspace = sqliteTable(
  "workspace",
  {
    id: text()
      .primaryKey()
      .$defaultFn(() => randomUUIDv7()),
    slug: text().notNull(),
    displayName: text().notNull(),
    logoUrl: text(),
  },
  (table) => [uniqueIndex("workspace_slug_unique").on(table.slug)],
);

export const workspaceUser = sqliteTable(
  "workspace_user",
  {
    workspaceId: text()
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    userId: text()
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    joinedAt: integer({ mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    primaryKey({
      columns: [table.workspaceId, table.userId],
    }),
  ],
);

export const workspaceInvitation = sqliteTable("workspace_invitation", {
  id: text()
    .primaryKey()
    .$defaultFn(() => randomUUIDv7()),
  workspaceId: text()
    .notNull()
    .references(() => workspace.id),
  createdById: text()
    .notNull()
    .references(() => user.id),
  token: text().notNull().unique(),
  expiresAt: integer({ mode: "timestamp_ms" }),
});

// Relations
export const workspaceRelations = relations(workspace, ({ many }) => ({
  workspaceUsers: many(workspaceUser),
  issues: many(issue),
}));

export const workspaceUserRelations = relations(workspaceUser, ({ one }) => ({
  workspace: one(workspace, {
    fields: [workspaceUser.workspaceId],
    references: [workspace.id],
  }),
  user: one(user, {
    fields: [workspaceUser.userId],
    references: [user.id],
  }),
}));

// Types
export type Workspace = typeof workspace.$inferSelect;
export type NewWorkspace = typeof workspace.$inferInsert;
