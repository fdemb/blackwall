// Labels are strings that can be attached to issues within a given workspace.
import { randomUUIDv7 } from "bun";
import { relations } from "drizzle-orm";
import { primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { lifecycleTimestamps } from "../utils";
import { colorKey } from "./color.enum.schema";
import { issue } from "./issue.schema";
import { workspace } from "./workspace.schema";

// Label table
export const label = sqliteTable("label", {
  id: text()
    .primaryKey()
    .$defaultFn(() => randomUUIDv7()),
  name: text().notNull(),
  colorKey: colorKey().notNull(),
  workspaceId: text()
    .notNull()
    .references(() => workspace.id),
  ...lifecycleTimestamps,
});

// Label on issue junction table
export const labelOnIssue = sqliteTable(
  "label_on_issue",
  {
    labelId: text()
      .notNull()
      .references(() => label.id),
    issueId: text()
      .notNull()
      .references(() => issue.id),
  },
  (table) => [
    primaryKey({
      columns: [table.labelId, table.issueId],
    }),
  ],
);

// Relations
export const labelRelations = relations(label, ({ many }) => ({
  labelsOnIssues: many(labelOnIssue),
}));

export const labelOnIssueRelations = relations(labelOnIssue, ({ one }) => ({
  issue: one(issue, {
    fields: [labelOnIssue.issueId],
    references: [issue.id],
  }),
  label: one(label, {
    fields: [labelOnIssue.labelId],
    references: [label.id],
  }),
}));

// Types
export type Label = typeof label.$inferSelect;
export type NewLabel = typeof label.$inferInsert;
export type LabelOnIssue = typeof labelOnIssue.$inferSelect;
export type NewLabelOnIssue = typeof labelOnIssue.$inferInsert;
