import type { JSONContent } from "@tiptap/core";
import { randomUUIDv7 } from "bun";
import { relations } from "drizzle-orm";
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-zod";
import { lifecycleTimestamps } from "../utils";
import { user } from "./auth.schema";
import { labelOnIssue } from "./label.schema";
import { team } from "./team.schema";
import { workspace } from "./workspace.schema";

// Issue status and priority types
export const issueStatusValues = [
  "backlog",
  "to_do",
  "in_progress",
  "done",
] as const;
export type IssueStatus = (typeof issueStatusValues)[number];

export const issuePriorityValues = ["low", "medium", "high", "urgent"] as const;
export type IssuePriority = (typeof issuePriorityValues)[number];

// Change event types - granular for UI display and reporting
export const issueChangeEventTypeValues = [
  // Issue lifecycle
  "issue_created",
  "issue_updated",
  "issue_deleted",

  // Issue field changes
  "summary_changed",
  "description_changed",
  "status_changed",
  "priority_changed",
  "assignee_changed",

  // Related entities
  "label_added",
  "label_removed",
  "comment_added",
  "comment_updated",
  "comment_deleted",
  "attachment_added",
  "attachment_removed",
] as const;
export type IssueChangeEventType = (typeof issueChangeEventTypeValues)[number];

// Typed field changes for issue updates
export type IssueFieldChanges = {
  [K in keyof Issue]?: {
    from: Issue[K] | null;
    to: Issue[K] | null;
  };
};

// Issue sequence table
export const issueSequence = sqliteTable(
  "issue_sequence",
  {
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id),
    teamId: text("team_id")
      .notNull()
      .references(() => team.id),
    currentSequence: integer("current_sequence").notNull().default(0),
  },
  (table) => [
    primaryKey({
      columns: [table.workspaceId, table.teamId],
    }),
  ],
);

// Issue table
export const issue = sqliteTable(
  "issue",
  {
    id: text()
      .primaryKey()
      .$defaultFn(() => randomUUIDv7()),
    key: text().notNull(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id),
    teamId: text("team_id")
      .notNull()
      .references(() => team.id),
    createdById: text("created_by_id")
      .notNull()
      .references(() => user.id),
    assignedToId: text("assigned_to_id").references(() => user.id),
    keyNumber: integer("key_number").notNull(),
    summary: text().notNull(),
    status: text({ enum: issueStatusValues }).notNull().default("to_do"),
    description: text({ mode: "json" }).notNull().$type<JSONContent>(),
    order: integer().default(0).notNull(),
    priority: text({ enum: issuePriorityValues }).notNull().default("medium"),
    ...lifecycleTimestamps,
  },
  (table) => [
    uniqueIndex("issue_key_workspace_id_unique").on(
      table.key,
      table.workspaceId,
    ),
  ],
);

export const issueChangeEvent = sqliteTable(
  "issue_change_event",
  {
    id: text()
      .primaryKey()
      .$defaultFn(() => randomUUIDv7()),
    issueId: text("issue_id")
      .notNull()
      .references(() => issue.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id),
    actorId: text("actor_id")
      .notNull()
      .references(() => user.id),

    eventType: text("event_type", { enum: issueChangeEventTypeValues })
      .notNull()
      .default("issue_updated"),

    // For issue field changes (status, priority, assignee, etc.)
    changes: text({ mode: "json" }).$type<IssueFieldChanges>(),

    // For related entity events (labels, comments, attachments)
    relatedEntityId: text("related_entity_id"),

    createdAt: integer({ mode: "timestamp_ms" })
      .notNull()
      .$default(() => new Date()),
  },
  (table) => [
    // Primary query: activity feed for an issue
    index("issue_change_event_issue_id_idx").on(table.issueId),
    // Workspace-wide activity feed, ordered by time
    index("issue_change_event_workspace_created_idx").on(
      table.workspaceId,
      table.createdAt,
    ),
    // Filter by event type (e.g., "all status changes")
    index("issue_change_event_type_idx").on(table.eventType),
    // Actor activity (what did user X do?)
    index("issue_change_event_actor_id_idx").on(table.actorId),
  ],
);

// Issue comment table
export const issueComment = sqliteTable("issue_comment", {
  id: text()
    .primaryKey()
    .$defaultFn(() => randomUUIDv7()),
  issueId: text("issue_id")
    .notNull()
    .references(() => issue.id),
  authorId: text("author_id")
    .notNull()
    .references(() => user.id),
  content: text({ mode: "json" }).$type<JSONContent>(),
  ...lifecycleTimestamps,
});

export const issueAttachment = sqliteTable("issue_attachment", {
  id: text()
    .primaryKey()
    .$defaultFn(() => randomUUIDv7()),
  issueId: text().references(() => issue.id, { onDelete: "cascade" }),
  createdById: text()
    .notNull()
    .references(() => user.id),
  filePath: text().notNull(),
  mimeType: text().notNull(),
  originalFileName: text().notNull(),
  ...lifecycleTimestamps,
});

// Relations
export const issueRelations = relations(issue, ({ many, one }) => ({
  team: one(team, {
    fields: [issue.teamId],
    references: [team.id],
  }),
  workspace: one(workspace, {
    fields: [issue.workspaceId],
    references: [workspace.id],
  }),
  assignedTo: one(user, {
    fields: [issue.assignedToId],
    references: [user.id],
  }),
  labelsOnIssue: many(labelOnIssue),
  comments: many(issueComment),
  changeEvents: many(issueChangeEvent),
}));

export const issueCommentRelations = relations(issueComment, ({ one }) => ({
  issue: one(issue, {
    fields: [issueComment.issueId],
    references: [issue.id],
  }),
  author: one(user, {
    fields: [issueComment.authorId],
    references: [user.id],
  }),
}));

export const issueChangeEventRelations = relations(
  issueChangeEvent,
  ({ one }) => ({
    issue: one(issue, {
      fields: [issueChangeEvent.issueId],
      references: [issue.id],
    }),
    actor: one(user, {
      fields: [issueChangeEvent.actorId],
      references: [user.id],
    }),
    workspace: one(workspace, {
      fields: [issueChangeEvent.workspaceId],
      references: [workspace.id],
    }),
  }),
);

export const issueAttachmentRelations = relations(
  issueAttachment,
  ({ one }) => ({
    issue: one(issue, {
      fields: [issueAttachment.issueId],
      references: [issue.id],
    }),
    createdBy: one(user, {
      fields: [issueAttachment.createdById],
      references: [user.id],
    }),
  }),
);

// Types
export type IssueSequence = typeof issueSequence.$inferSelect;
export type NewIssueSequence = typeof issueSequence.$inferInsert;
export type Issue = typeof issue.$inferSelect;
export type NewIssue = typeof issue.$inferInsert;
export type IssueChangeEvent = typeof issueChangeEvent.$inferSelect;
export type NewIssueChangeEvent = typeof issueChangeEvent.$inferInsert;
export type IssueComment = typeof issueComment.$inferSelect;
export type NewIssueComment = typeof issueComment.$inferInsert;
export type IssueAttachment = typeof issueAttachment.$inferSelect;
export type NewIssueAttachment = typeof issueAttachment.$inferInsert;

// Schemas
export const issueSelectSchema = createSelectSchema(issue);
export const issueInsertSchema = createInsertSchema(issue);
export const issueUpdateSchema = createUpdateSchema(issue);
