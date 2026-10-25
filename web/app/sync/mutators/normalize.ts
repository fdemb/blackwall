import type { Command } from "../../lib/types";
import { parseTimestamp } from "../records";
import { MutationError } from "./errors";

type Field = (
  | { kind: "required" }
  | { kind: "option"; stored?: boolean; timestamp?: boolean; items?: Fields }
  | { kind: "default"; value: unknown; nullable?: boolean; items?: Fields }
  | { kind: "object"; fields: Fields }
  | { kind: "array"; items: Fields }
  | { kind: "bulk" }
) & { integer?: "u32" | "u64" | "i64"; commandTimestamp?: boolean };
type Fields = Readonly<Record<string, Field>>;

const required: Field = { kind: "required" };
const unsignedOption: Field = { kind: "option", integer: "u32" };
const timestampOption: Field = { kind: "option", commandTimestamp: true };
const timestampRequired: Field = { kind: "required", commandTimestamp: true };
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
  estimate: unsignedOption,
  deadline: timestampOption,
  project_id: option,
  milestone_id: option,
  sprint_id: option,
  parent_id: option,
  dependencies: defaulted([]),
};
const ISSUE_PATCH: Fields = {
  title: option,
  description: option,
  team_id: option,
  stage_id: option,
  assignee: option,
  clear_assignee: defaulted(false),
  priority: option,
  labels: option,
  estimate: unsignedOption,
  clear_estimate: defaulted(false),
  deadline: timestampOption,
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
const SEEN_NOTIFICATION: Fields = { id: required, created_at: timestampRequired };
const FILTER_CLAUSE: Fields = { field: required, op: required, values: required };
const ISSUE_FILTER: Fields = {
  where: { kind: "default", value: [], items: FILTER_CLAUSE },
  ids: storedOption,
  search: storedOption,
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
  size: { kind: "required", integer: "u64" },
};
const id: Fields = { id: required };

// Complete command schema from src/domain/commands.rs. Required fields are
// listed too, so unknown keys are ignored at every object boundary, as Serde
// does. default_stage_ids is Option<Vec<Uuid>> with the default None.
const COMMAND_FIELDS: Record<Command["type"] | "add_attachment" | "attach_comment_file", Fields> = {
  create_team: {
    id: option,
    name: required,
    key: required,
    members: defaulted([]),
    default_stage_ids: option,
  },
  set_team_members: { id: required, members: required },
  set_team_archive: {
    id: required,
    archive_after_days: { kind: "default", value: 30, nullable: true, integer: "u32" },
  },
  set_team_appearance: { id: required, icon: required, color: required },
  create_stage: {
    id: option,
    team_id: required,
    name: required,
    kind: required,
    position: { kind: "required", integer: "i64" },
  },
  update_stage: {
    id: required,
    team_id: required,
    name: required,
    kind: required,
    position: { kind: "required", integer: "i64" },
  },
  delete_stage: { id: required, team_id: required, replacement: required },
  create_label: { id: option, name: required, color: required },
  update_label: { id: required, name: required, color: required },
  delete_label: { id: required },
  create_project: { id: option, name: required, description: defaulted(""), team_ids: required },
  update_project: { id: required, name: required, description: required, team_ids: required },
  delete_project: { id: required },
  set_project_plan: {
    id: required,
    lead_id: option,
    status: required,
    health: option,
    start_date: option,
    target_date: option,
  },
  create_milestone: { id: option, project_id: required, name: required, deadline: timestampOption },
  update_milestone: { id: required, name: required, deadline: timestampOption },
  delete_milestone: { id: required },
  create_sprint: {
    id: option,
    team_id: required,
    name: required,
    goal: required,
    starts_at: timestampRequired,
    ends_at: timestampRequired,
  },
  update_sprint: {
    id: required,
    name: required,
    goal: required,
    starts_at: timestampRequired,
    ends_at: timestampRequired,
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
  follow: { issue_id: required, following: required, user_id: option },
  log_time: {
    id: option,
    issue_id: required,
    minutes: { kind: "required", integer: "u32" },
    note: defaulted(""),
    logged_at: timestampRequired,
  },
  update_time: {
    id: required,
    minutes: { kind: "required", integer: "u32" },
    note: required,
    logged_at: timestampRequired,
  },
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
  update_workspace: { name: required, slug: required },
  set_role: { user_id: required, role: required },
  remove_member: { user_id: required },
  transfer_ownership: { user_id: required },
  mark_notification_read: { id: required, created_at: timestampOption },
  mark_notification_unread: id,
  mark_all_notifications_read: { notifications: { kind: "option", items: SEEN_NOTIFICATION } },
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
    const item = Object.prototype.hasOwnProperty.call(value, key) ? value[key] : undefined;
    validateField(item, field, key);
    const normalized = normalizeField(item, field);
    if (normalized !== undefined) result[key] = normalized;
  }
  return result;
}

function validateField(item: unknown, field: Field, key: string): void {
  if (item === null && field.kind !== "option" && !(field.kind === "default" && field.nullable)) {
    throw new MutationError(400, `invalid command arguments: ${key} cannot be null`);
  }
  if (item === null || item === undefined) return;
  if (field.integer) checkInteger(item, field.integer);
  if (!field.commandTimestamp) return;
  try {
    parseTimestamp(item, true);
  } catch (error) {
    if (error instanceof Error && error.message === "premature end of input") {
      throw new MutationError(400, error.message);
    }
    // Domain checks report the server timestamp range error.
  }
}

function normalizeField(item: unknown, field: Field): unknown {
  switch (field.kind) {
    case "option":
      return normalizeOption(item, field);
    case "default": {
      // A nullable default keeps null instead of replacing it with the default.
      const value = item === undefined ? structuredClone(field.value) : item;
      return field.items ? normalizeArray(value, field.items) : value;
    }
    case "object":
      return normalizeObject(item, field.fields);
    case "array":
      return normalizeArray(item, field.items);
    case "bulk":
      return isObject(item) && "update" in item
        ? normalizeObject(item, { update: { kind: "object", fields: ISSUE_PATCH } })
        : item;
    case "required":
      return item;
  }
}

function normalizeOption(item: unknown, field: Extract<Field, { kind: "option" }>): unknown {
  if (item === null || item === undefined) return field.stored ? null : undefined;
  if (field.items) return normalizeArray(item, field.items);
  if (!field.timestamp || typeof item !== "string") return item;
  try {
    return parseTimestamp(item, true, "chrono");
  } catch {
    // The mutator reports invalid timestamps through its usual check.
    return item;
  }
}

function normalizeArray(value: unknown, fields: Fields): unknown {
  return Array.isArray(value) ? value.map((entry) => normalizeObject(entry, fields)) : value;
}

/** Apply Serde's absence/null rules before admission and every replay. */
export function normalizeArgs(name: string, args: unknown): unknown {
  const fields = commands.get(name);
  return fields === undefined ? args : normalizeObject(args, fields);
}

/** Inclusive lower and exclusive upper bounds; `2 ** 64 - 1` is not representable. */
const INTEGER_RANGE = {
  u32: [0, 2 ** 32],
  u64: [0, 2 ** 64],
  i64: [-(2 ** 63), 2 ** 63],
} as const;

/** Serde integer errors, shared by command admission and the fake. */
function checkInteger(value: unknown, type: "u32" | "u64" | "i64"): void {
  if (typeof value === "number" && Number.isInteger(value)) {
    const [min, end] = INTEGER_RANGE[type];
    if (value >= min && value < end) return;
    throw new MutationError(400, `invalid value: integer \`${value}\`, expected ${type}`);
  }
  throw new MutationError(400, `invalid type: ${serdeType(value)}, expected ${type}`);
}

/** How Serde names a non-integer JSON value in type errors. */
function serdeType(value: unknown): string {
  if (typeof value === "number") return `floating point \`${value}\``;
  if (typeof value === "string") return `string ${JSON.stringify(value)}`;
  if (typeof value === "boolean") return `boolean \`${value}\``;
  return Array.isArray(value) ? "sequence" : "map";
}
