import { commandOwnershipTargets, issueCapabilities } from "../../lib/ownership";
import type { Command, Id, Role, StageKind } from "../../lib/types";
import type { Entity, RecordOf, SyncIssue } from "../records";
import type { DeepReadonly, Tx } from "../store";
import { MutationError } from "./errors";

/** The actor running the mutation and the client timestamp to use as "now". */
export interface MutatorContext {
  actor: Id;
  at: string;
}

/** One command's predicted effect on the view. Must be deterministic and idempotent. */
export type Mutator<A> = (tx: Tx, args: DeepReadonly<A>, ctx: MutatorContext) => void;

/** The command's arguments: the `Command` union member without its `type` tag. */
export type ArgsOf<T extends Command["type"]> = Omit<Extract<Command, { type: T }>, "type">;

/** Nil ids are rejected by the server's client-id check (`domain::client_id`). */
export const NIL_UUID = "00000000-0000-0000-0000-000000000000";

/** Server message for ownership failures (`src/store/ownership.rs`). */
export const OWNERSHIP_MESSAGE = "OpenProject imported issues are read-only";

/**
 * The actor's role, from the members table. A missing member means the actor
 * lost membership, which the server reports as 403 (`Store::begin_operation`).
 * Viewers may only run personal commands (`Operation::run_command`); `follow`
 * is the only personal command with a mutator in this task, but the rule is
 * shared so later commands reuse it as-is.
 */
export function requireRole(tx: Tx, actor: Id, name: string, args: unknown): Role {
  const member = tx.get("members", actor);
  if (member === undefined) throw new MutationError(403, "permission denied");
  if (member.role === "viewer" && !isPersonal(name, args)) {
    throw new MutationError(403, "permission denied");
  }
  return member.role;
}

function isPersonal(name: string, args: unknown): boolean {
  switch (name) {
    case "mark_notification_read":
    case "mark_notification_unread":
    case "mark_all_notifications_read":
    case "configure_alerts":
    case "delete_view":
    case "follow":
      return true;
    case "save_view":
    case "update_view":
      return (args as { shared?: boolean }).shared === false;
    default:
      return false;
  }
}

const CAPABILITY: Partial<Record<Command["type"], string>> = {
  create_issue: "relation",
  update_issue: "edit",
  move_issue: "move",
  bulk_issues: "edit",
  delete_issue: "delete",
  restore_issue: "restore",
  add_source_link: "source_links",
  remove_attachment: "remove_attachment",
};

/**
 * Rejects commands touching OpenProject-imported issues without the needed
 * capability. Targets and capabilities come from the same generated policy
 * the server enforces (`ownership-policy.generated.json`); missing targets
 * are skipped here and reported by reference validation instead, as on the
 * server. Archive commands have no policy rule, so they are unchecked here.
 */
export function checkOwnership(tx: Tx, command: DeepReadonly<Command>): void {
  const capability = CAPABILITY[command.type];
  if (capability === undefined) return;
  for (const id of commandOwnershipTargets(command as unknown as Command)) {
    const issue = tx.get("issues", id);
    if (issue === undefined) continue;
    const allowed = (issueCapabilities(issue) as Record<string, boolean>)[capability];
    if (!allowed) throw new MutationError(409, OWNERSHIP_MESSAGE);
  }
}

/** The issue or a 404, mirroring `reads::issue_on` without deleted rows. */
export function requireIssue(tx: Tx, id: string): DeepReadonly<SyncIssue> {
  const issue = tx.get("issues", id);
  if (issue === undefined) throw new MutationError(404, "not found");
  return issue;
}

/** Deleted rows read as missing, mirroring `reads::issue_on`. */
export function requireLiveIssue(tx: Tx, id: string): DeepReadonly<SyncIssue> {
  const issue = requireIssue(tx, id);
  if (issue.deleted_at !== null) throw new MutationError(404, "not found");
  return issue;
}

/** Rebuilds a frozen record. Reads stay frozen; mutators put new objects. */
export function update<E extends Entity>(
  tx: Tx,
  entity: E,
  key: string,
  fn: (record: DeepReadonly<RecordOf[E]>) => RecordOf[E],
): void {
  const current = tx.get(entity, key);
  if (current === undefined) throw new MutationError(404, "not found");
  tx.put(entity, fn(current) as DeepReadonly<RecordOf[E]>);
}

/** `domain::text`: blank or over-long values are a 400 with this message. */
export function checkText(value: string, max: number): void {
  if (value.trim() === "" || new TextEncoder().encode(value).length > max) {
    throw new MutationError(400, `text must contain 1 to ${max} bytes`);
  }
}

/**
 * `domain::optional_timestamp`: client timestamps must land in years 1-9999,
 * which is what the replica can ingest. Unparseable input fails the same
 * check; the server rejects it while parsing the command instead.
 */
export function checkTimestamp(value: string | null | undefined): void {
  if (value === null || value === undefined) return;
  const time = new Date(value).getTime();
  const year = Number.isNaN(time) ? NaN : new Date(time).getUTCFullYear();
  if (Number.isNaN(year) || year < 1 || year > 9999) {
    throw new MutationError(400, "timestamp year must be between 1 and 9999");
  }
}

/** `Operation::issues` source-link validation: http(s) URLs up to 4096 chars. */
export function checkSourceUrl(url: string): void {
  let protocol = "";
  try {
    protocol = new URL(url).protocol;
  } catch {
    throw new MutationError(400, "invalid URL");
  }
  if ((protocol !== "http:" && protocol !== "https:") || url.length > 4096) {
    throw new MutationError(400, "invalid URL");
  }
}

/** Stage kind from the issue's own team, via point reads only. */
export function stageKindOf(tx: Tx, teamId: string, stageId: string): StageKind | undefined {
  return tx.get("teams", teamId)?.stages.find((stage) => stage.id === stageId)?.kind;
}

/**
 * Full `validate_issue_sql` mirror (`src/store/issues.rs`), in the server's
 * order so the first failure matches. Runs against the candidate issue, so
 * create, update, move and restore share it. `retainedSprint` is the issue's
 * sprint before the command; staying in a finished sprint is allowed only
 * from a done/cancelled stage. Unknown stage kinds are skipped: the server
 * cannot see them, and the replica always loads every team.
 *
 * The cross-issue workflow check (`validate_workflow`, which rejects moves
 * that strand dependents) is left to the server: it needs the whole
 * transaction graph, and the pull corrects a wrong prediction.
 */
export function validateIssue(
  tx: Tx,
  issue: DeepReadonly<SyncIssue>,
  retainedSprint: string | null,
): void {
  checkText(issue.title, 500);
  checkTimestamp(issue.deadline);
  if (issue.description.length > 100_000) {
    throw new MutationError(400, "description too long");
  }

  const kind = stageKindOf(tx, issue.team_id, issue.stage_id);
  if (kind === undefined) throw new MutationError(400, "stage belongs to another team");

  if (issue.assignee !== null && tx.get("members", issue.assignee) === undefined) {
    throw new MutationError(403, "permission denied");
  }

  for (const label of issue.labels) {
    if (tx.get("labels", label) === undefined) throw new MutationError(400, "unknown label");
  }

  if (issue.project_id !== null) {
    const project = tx.get("projects", issue.project_id);
    if (project === undefined || !project.team_ids.includes(issue.team_id)) {
      throw new MutationError(400, "project does not include team");
    }
  }

  if (issue.milestone_id !== null) {
    const milestone = tx.get("milestones", issue.milestone_id);
    if (milestone === undefined) throw new MutationError(404, "not found");
    if (milestone.project_id !== issue.project_id) {
      throw new MutationError(400, "milestone belongs to another project");
    }
  }

  if (issue.sprint_id !== null) {
    const sprint = tx.get("sprints", issue.sprint_id);
    if (sprint === undefined) throw new MutationError(404, "not found");
    const retained = retainedSprint !== null && retainedSprint === issue.sprint_id;
    if (
      sprint.team_id !== issue.team_id ||
      ((sprint.state === "completed" || sprint.state === "archived") &&
        !(retained && (kind === "done" || kind === "cancelled")))
    ) {
      throw new MutationError(400, "sprint is unavailable for this team");
    }
  }

  const seen = new Set<string>();
  for (const dep of issue.dependencies) {
    if (seen.has(dep)) continue;
    seen.add(dep);
    const other = tx.get("issues", dep);
    if (other === undefined) throw new MutationError(404, "not found");
    // Usually shadowed by the ownership check, which runs before validation
    // and rejects imported targets first; kept to match the server's order.
    if (other.openproject != null) {
      throw new MutationError(409, "OpenProject issues cannot be dependencies");
    }
    if (dep === issue.id || other.deleted_at !== null) {
      throw new MutationError(400, "invalid dependency");
    }
    if (issue.deleted_at === null && (kind === "active" || kind === "done")) {
      const depKind = stageKindOf(tx, other.team_id, other.stage_id);
      if (depKind !== undefined && depKind !== "done" && depKind !== "cancelled") {
        throw new MutationError(409, "issue has unfinished dependencies");
      }
    }
    if (reachable(tx, dep, issue.id)) throw new MutationError(400, "dependency cycle");
  }

  if (issue.parent_id !== null) {
    const parent = tx.get("issues", issue.parent_id);
    if (parent === undefined || parent.deleted_at !== null || parent.openproject != null) {
      throw new MutationError(404, "not found");
    }
    if (issue.parent_id === issue.id || hasAncestor(tx, issue.parent_id, issue.id)) {
      throw new MutationError(400, "parent cycle");
    }
  }
}

/** True when `target` is reachable from `from` through dependencies. */
function reachable(tx: Tx, from: string, target: string): boolean {
  const visited = new Set<string>();
  const stack = [from];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    if (current === target) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    for (const dep of tx.get("issues", current)?.dependencies ?? []) stack.push(dep);
  }
  return false;
}

/** True when `id` appears in the parent chain above `parentId`. */
function hasAncestor(tx: Tx, parentId: string, id: string): boolean {
  const visited = new Set<string>();
  let current: string | null = parentId;
  while (current !== null) {
    if (current === id) return true;
    if (visited.has(current)) return false;
    visited.add(current);
    current = tx.get("issues", current)?.parent_id ?? null;
  }
  return false;
}
