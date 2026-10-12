import { MutationError, normalizeArgs } from "../mutators";

export function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function uuid(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    !/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(value)
  ) {
    throw new MutationError(400, `${field} must be a UUID`);
  }
  return value.toLowerCase();
}

const required = new Map<string, string[]>([
  ["create_team", ["name"]],
  ["set_team_members", ["id", "members"]],
  ["set_team_archive", ["id"]],
  ["create_stage", ["team_id", "name", "kind", "position"]],
  ["update_stage", ["id", "team_id", "name", "kind", "position"]],
  ["delete_stage", ["id", "team_id", "replacement"]],
  ["create_label", ["name", "color"]],
  ["update_label", ["id", "name", "color"]],
  ["create_project", ["name", "team_ids"]],
  ["update_project", ["id", "name", "description", "team_ids"]],
  ["create_milestone", ["project_id", "name"]],
  ["update_milestone", ["id", "name"]],
  ["create_sprint", ["team_id", "name", "goal", "starts_at", "ends_at"]],
  ["update_sprint", ["id", "name", "goal", "starts_at", "ends_at", "state"]],
  ["complete_sprint", ["id"]],
  ["archive_sprint", ["id"]],
  ["create_issue", ["input"]],
  ["update_issue", ["id", "patch"]],
  ["move_issue", ["id", "stage_id"]],
  ["bulk_issues", ["ids", "action"]],
  ["delete_issue", ["id"]],
  ["restore_issue", ["id"]],
  ["archive_issue", ["id"]],
  ["unarchive_issue", ["id"]],
  ["follow", ["issue_id", "following"]],
  ["add_source_link", ["issue_id", "url", "title"]],
  ["remove_attachment", ["issue_id", "attachment_id"]],
  ["add_comment", ["issue_id", "body"]],
  ["edit_comment", ["id", "body"]],
  ["delete_comment", ["id"]],
  ["log_time", ["issue_id", "minutes", "logged_at"]],
  ["update_time", ["id", "minutes", "note", "logged_at"]],
  ["delete_time", ["id"]],
  ["save_view", ["name", "shared", "filter"]],
  ["update_view", ["id", "name", "shared", "filter"]],
  ["delete_view", ["id"]],
  ["cancel_invitation", ["id"]],
  ["mark_notification_read", ["id"]],
  ["mark_notification_unread", ["id"]],
  ["configure_alerts", ["assignment", "reply", "change", "mention", "deadline"]],
  ["update_integration", ["id", "enabled"]],
  ["delete_integration", ["id"]],
  ["set_role", ["user_id", "role"]],
  ["remove_member", ["user_id"]],
]);
const strings = new Set([
  "title",
  "name",
  "description",
  "body",
  "color",
  "goal",
  "note",
  "url",
  "logged_at",
  "starts_at",
  "ends_at",
  "deadline",
  "search",
  "after",
]);
const booleans = new Set([
  "shared",
  "following",
  "enabled",
  "assignment",
  "reply",
  "change",
  "mention",
  "deadline",
  "open",
  "trash",
  "archived",
  "no_sprint",
  "unassigned",
]);
const arrays = new Set([
  "ids",
  "labels",
  "dependencies",
  "members",
  "mentions",
  "team_ids",
  "default_stage_ids",
]);
const enums = new Map<string, string[]>([
  ["priority", ["none", "low", "normal", "high", "urgent"]],
  ["kind", ["backlog", "planned", "active", "done", "cancelled"]],
  ["state", ["planned", "active", "completed", "archived"]],
  ["role", ["owner", "admin", "member", "viewer"]],
  ["sort", ["position", "deadline", "updated", "priority"]],
  ["group_by", ["stage", "priority", "assignee", "none"]],
  ["projection", ["full", "summary"]],
]);

/** Validate Serde types before invoking mutators, which assume typed command args. */
export function commandArgs(name: string, raw: unknown): Record<string, unknown> {
  const args = normalizeArgs(name, raw ?? {});
  if (!object(args)) throw new MutationError(400, "args must be an object");
  for (const key of required.get(name) ?? []) {
    if (!(key in args)) throw new MutationError(400, `missing field ${key}`);
  }
  if (name === "create_issue") {
    if (
      !object(args.input) ||
      typeof args.input.title !== "string" ||
      typeof args.input.team_id !== "string"
    ) {
      throw new MutationError(400, "input requires title and team_id");
    }
  }
  validate(args, name === "configure_alerts");
  return args;
}

const integers = new Set(["minutes", "estimate", "position", "archive_after_days"]);
const nested = new Set(["input", "patch", "filter"]);
const bulkActions = ["delete", "restore", "archive", "unarchive"];

function validate(args: Record<string, unknown>, alertPreferences = false): void {
  for (const [key, value] of Object.entries(args)) {
    if (value === null) continue;
    if (!checkField(args, key, value, alertPreferences))
      throw new MutationError(400, `invalid command arguments: ${key}`);
    if (object(value)) validate(value);
    if (key === "action" && typeof value === "string" && !bulkActions.includes(value))
      throw new MutationError(400, "invalid bulk action");
  }
}

/** Checks one field's Serde type, normalizing UUIDs in place. Unknown keys pass. */
function checkField(
  args: Record<string, unknown>,
  key: string,
  value: unknown,
  alertPreferences: boolean,
): boolean {
  const allowed = enums.get(key);
  if (allowed) return typeof value === "string" && allowed.includes(value);
  if (isUuidField(key)) {
    args[key] = uuid(value, key);
    return true;
  }
  if (arrays.has(key)) {
    if (!Array.isArray(value)) return false;
    args[key] = value.map((id) => uuid(id, key));
    return true;
  }
  // `deadline` is an alert switch in `configure_alerts` and a timestamp elsewhere.
  const issueDeadline = key === "deadline" && !alertPreferences && typeof value === "string";
  if (key.startsWith("clear_") || (booleans.has(key) && !issueDeadline))
    return typeof value === "boolean";
  if (strings.has(key)) return typeof value === "string";
  if (integers.has(key)) return typeof value === "number" && Number.isSafeInteger(value);
  if (nested.has(key)) return object(value);
  return true;
}

function isUuidField(key: string): boolean {
  return (
    key === "id" ||
    key.endsWith("_id") ||
    key === "assignee" ||
    key === "created_by" ||
    key === "replacement"
  );
}
