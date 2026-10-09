import type { Command } from "../../lib/types";
import { parseTimestamp } from "../records";
import { MutationError } from "./errors";

type Field =
  | { kind: "required" }
  | { kind: "option"; stored?: boolean; timestamp?: boolean }
  | { kind: "default"; value: unknown; nullable?: boolean; items?: Fields }
  | { kind: "object"; fields: Fields }
  | { kind: "array"; items: Fields }
  | { kind: "bulk" };
type Fields = Readonly<Record<string, Field>>;

const required: Field = { kind: "required" };
const option: Field = { kind: "option" };
const storedOption: Field = { kind: "option", stored: true };
const defaulted = (value: unknown): Field => ({ kind: "default", value });

// Serde field rules from src/domain/issues.rs. A non-Option default applies
// only to an absent field: explicit null stays invalid, rather than becoming
// a valid default. Arrays keep their elements, including invalid nulls.
const ISSUE_INPUT: Fields = {
  id: option,
  title: required,
  description: defaulted(""),
  team_id: required,
  stage_id: option,
  assignee: option,
  priority: defaulted("none"),
  labels: defaulted([]),
  estimate: option,
  deadline: option,
  project_id: option,
  milestone_id: option,
  sprint_id: option,
  parent_id: option,
  dependencies: defaulted([]),
};
const ISSUE_PATCH: Fields = {
  title: option,
  description: option,
  stage_id: option,
  assignee: option,
  clear_assignee: defaulted(false),
  priority: option,
  labels: option,
  estimate: option,
  clear_estimate: defaulted(false),
  deadline: option,
  clear_deadline: defaulted(false),
  project_id: option,
  clear_project: defaulted(false),
  milestone_id: option,
  clear_milestone: defaulted(false),
  sprint_id: option,
  clear_sprint: defaulted(false),
  parent_id: option,
  clear_parent: defaulted(false),
  dependencies: option,
};
const ISSUE_FILTER: Fields = {
  parent_id: storedOption,
  dependency_id: storedOption,
  ids: storedOption,
  no_sprint: defaulted(false),
  open: defaulted(false),
  assignee: storedOption,
  created_by: storedOption,
  team_id: storedOption,
  stage_id: storedOption,
  priority: storedOption,
  label_id: storedOption,
  sprint_id: storedOption,
  project_id: storedOption,
  due_before: { kind: "option", stored: true, timestamp: true },
  search: storedOption,
  unassigned: defaulted(false),
  trash: defaulted(false),
  archived: defaulted(false),
  sort: defaulted("position"),
  group_by: storedOption,
  after: storedOption,
  projection: defaulted("full"),
};
const ATTACHMENT: Fields = {
  id: required,
  name: required,
  content_type: required,
  size: required,
};
const id: Fields = { id: required };

// Complete command schema from src/domain/commands.rs. Required fields are
// listed too, so unknown keys are ignored at every object boundary, as Serde
// does. default_stage_ids is Option<Vec<Uuid>> with the default None.
const COMMAND_FIELDS: Record<Command["type"] | "add_attachment" | "attach_comment_file", Fields> = {
  create_team: { id: option, name: required, members: defaulted([]), default_stage_ids: option },
  set_team_members: { id: required, members: required },
  set_team_archive: {
    id: required,
    archive_after_days: { kind: "default", value: 30, nullable: true },
  },
  create_stage: {
    id: option,
    team_id: required,
    name: required,
    kind: required,
    position: required,
  },
  update_stage: {
    id: required,
    team_id: required,
    name: required,
    kind: required,
    position: required,
  },
  delete_stage: { id: required, team_id: required, replacement: required },
  create_label: { id: option, name: required, color: required },
  update_label: { id: required, name: required, color: required },
  create_project: { id: option, name: required, description: defaulted(""), team_ids: required },
  update_project: { id: required, name: required, description: required, team_ids: required },
  create_milestone: { id: option, project_id: required, name: required, deadline: option },
  update_milestone: { id: required, name: required, deadline: option },
  create_sprint: {
    id: option,
    team_id: required,
    name: required,
    goal: required,
    starts_at: required,
    ends_at: required,
  },
  update_sprint: {
    id: required,
    name: required,
    goal: required,
    starts_at: required,
    ends_at: required,
    state: required,
  },
  complete_sprint: { id: required, carryover_sprint_id: option },
  archive_sprint: id,
  create_issue: { input: { kind: "object", fields: ISSUE_INPUT } },
  update_issue: { id: required, patch: { kind: "object", fields: ISSUE_PATCH } },
  move_issue: { id: required, stage_id: required, before_id: option },
  bulk_issues: { ids: required, action: { kind: "bulk" } },
  delete_issue: id,
  restore_issue: id,
  archive_issue: id,
  unarchive_issue: id,
  add_attachment: { issue_id: required, attachment: { kind: "object", fields: ATTACHMENT } },
  attach_comment_file: { comment_id: required, attachment: { kind: "object", fields: ATTACHMENT } },
  remove_attachment: { issue_id: required, attachment_id: required },
  add_comment: {
    id: option,
    issue_id: required,
    body: required,
    mentions: defaulted([]),
    attachments: { kind: "default", value: [], items: ATTACHMENT },
  },
  edit_comment: { id: required, body: required, mentions: defaulted([]) },
  delete_comment: id,
  follow: { issue_id: required, following: required },
  log_time: {
    id: option,
    issue_id: required,
    minutes: required,
    note: defaulted(""),
    logged_at: required,
  },
  update_time: { id: required, minutes: required, note: required, logged_at: required },
  delete_time: id,
  save_view: {
    id: option,
    name: required,
    shared: required,
    filter: { kind: "object", fields: ISSUE_FILTER },
  },
  update_view: {
    id: required,
    name: required,
    shared: required,
    filter: { kind: "object", fields: ISSUE_FILTER },
  },
  delete_view: id,
  invite: { email: required, role: required, token_hash: required },
  resend_invitation: { id: required, token_hash: required },
  cancel_invitation: id,
  set_role: { user_id: required, role: required },
  remove_member: { user_id: required },
  mark_notification_read: id,
  mark_notification_unread: id,
  mark_all_notifications_read: {},
  configure_alerts: {
    assignment: required,
    reply: required,
    change: required,
    mention: required,
    deadline: required,
  },
  create_integration: { id: option, name: required, webhook_url: required, secret: required },
  update_integration: { id: required, enabled: required },
  delete_integration: id,
  add_source_link: { issue_id: required, url: required, title: required },
  import_issues: { issues: { kind: "array", items: ISSUE_INPUT } },
};
const commands = new Map(Object.entries(COMMAND_FIELDS));

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeObject(value: unknown, fields: Fields): unknown {
  if (!isObject(value)) return value;
  const result: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(fields)) {
    let item = Object.prototype.hasOwnProperty.call(value, key) ? value[key] : undefined;
    if (item === null && field.kind !== "option" && !(field.kind === "default" && field.nullable)) {
      throw new MutationError(400, `invalid command arguments: ${key} cannot be null`);
    }
    if (field.kind === "option") {
      if (item === null || item === undefined) {
        if (field.stored) result[key] = null;
        continue;
      }
      if (field.timestamp && typeof item === "string") {
        try {
          item = parseTimestamp(item);
        } catch {
          // The mutator reports invalid timestamps through its usual check.
        }
      }
    } else if (field.kind === "default") {
      if (item === undefined) item = structuredClone(field.value);
      if (field.items && Array.isArray(item)) {
        const items = field.items;
        item = item.map((entry) => normalizeObject(entry, items));
      }
      // A nullable default keeps null instead of replacing it with the default.
    } else if (field.kind === "object") {
      item = normalizeObject(item, field.fields);
    } else if (field.kind === "array" && Array.isArray(item)) {
      item = item.map((entry) => normalizeObject(entry, field.items));
    } else if (field.kind === "bulk" && isObject(item) && "update" in item) {
      item = normalizeObject(item, { update: { kind: "object", fields: ISSUE_PATCH } });
    }
    if (item !== undefined) result[key] = item;
  }
  return result;
}

/** Apply Serde's absence/null rules before admission and every replay. */
export function normalizeArgs(name: string, args: unknown): unknown {
  const fields = commands.get(name);
  return fields === undefined ? args : normalizeObject(args, fields);
}
