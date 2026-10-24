import type { Command, Id, Role, StageKind } from "../../lib/types";
import type { Entity, RecordOf, SyncIssue } from "../records";
import { ENTITIES, parseTimestamp } from "../records";
import type { DeepReadonly, Tx } from "../store";
import { MutationError } from "./errors";
import { isTeamColor, isTeamIcon } from "../../lib/teams";

/** The actor running the mutation and the client timestamp to use as "now". */
export interface MutatorContext {
  actor: Id;
  at: string;
  /** Admit runs once when the user issues the command; replay runs on every rebase. */
  mode: "admit" | "replay";
  /**
   * The pending mutation's client-only data. Undefined in admit mode, where
   * the mutator returns it instead; the stored value in replay mode.
   */
  local?: unknown;
}

/**
 * One command's predicted effect on the view. Must be deterministic and
 * idempotent. May return client-only data for the pending mutation, captured
 * at admission and read back from `ctx.local` on replay.
 */
export type Mutator<A> = (tx: Tx, args: DeepReadonly<A>, ctx: MutatorContext) => unknown;

/** The command's arguments: the `Command` union member without its `type` tag. */
export type ArgsOf<T extends Command["type"]> = Omit<Extract<Command, { type: T }>, "type">;

/** Nil ids are rejected by the server's client-id check (`domain::client_id`). */
export const NIL_UUID = "00000000-0000-0000-0000-000000000000";

/**
 * The actor's role, from the members table. A missing member means the actor
 * lost membership, which the server reports as 403 (`Store::begin_operation`).
 * Viewers may only run personal commands (`Operation::run_command`); the
 * personal set is shared so every command reuses it as-is.
 */
export function requireRole(tx: Tx, actor: Id, name: string, args: unknown): Role {
  const member = tx.get("members", actor);
  if (member === undefined) throw new MutationError(403, "permission denied");
  if (member.role === "viewer" && !isPersonal(name, args, actor)) {
    throw new MutationError(403, "permission denied");
  }
  return member.role;
}

function isPersonal(name: string, args: unknown, actor: Id): boolean {
  switch (name) {
    case "mark_notification_read":
    case "mark_notification_unread":
    case "mark_all_notifications_read":
    case "configure_alerts":
    case "delete_view":
      return true;
    case "follow": {
      const user = (args as { user_id?: Id | null }).user_id;
      return user == null || user === actor;
    }
    case "save_view":
    case "update_view":
      return (args as { shared?: boolean }).shared === false;
    default:
      return false;
  }
}

/** Rejects unless the actor is an owner or admin (`Operation::admin`). */
export function requireAdmin(role: Role): void {
  if (role !== "owner" && role !== "admin") {
    throw new MutationError(403, "permission denied");
  }
}

/**
 * Rejects unless the actor authored the record or is an owner or admin
 * (`Operation::author_or_admin`). Membership was already checked by
 * `requireRole`, so a missing member here also means 403.
 */
export function requireAuthorOrAdmin(tx: Tx, actor: Id, author: Id): void {
  if (author === actor) return;
  const member = tx.get("members", actor);
  if (member === undefined || (member.role !== "owner" && member.role !== "admin")) {
    throw new MutationError(403, "permission denied");
  }
}

/** A workspace member must exist (`Operation::member`). */
export function requireMember(tx: Tx, user: Id): void {
  if (tx.get("members", user) === undefined) {
    throw new MutationError(403, "permission denied");
  }
}

/** Any record by id, or the 404 the server's `touch` reports when missing. */
export function requireRecord<E extends Entity>(
  tx: Tx,
  entity: E,
  id: string,
): DeepReadonly<RecordOf[E]> {
  const record = tx.get(entity, id);
  if (record === undefined) throw new MutationError(404, "not found");
  return record;
}

/**
 * `domain::validate_archive_days`: null means never, otherwise an integer of
 * 1 to 3650 days.
 */
/** Mirrors `validate_team_appearance` in `src/domain.rs`. */
export function checkTeamAppearance(icon: unknown, color: unknown): void {
  if (!isTeamIcon(icon)) throw new MutationError(400, "unknown team icon");
  if (!isTeamColor(color)) throw new MutationError(400, "unknown team color");
}

export function checkArchiveDays(value: number | null | undefined): void {
  if (value === null || value === undefined) return;
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 3650) {
    throw new MutationError(400, "archive_after_days must be between 1 and 3650 days or null");
  }
}

/**
 * A client-writable timestamp the server requires (sprint bounds, time
 * entries). Optional timestamps use `checkTimestamp` directly; absent here
 * means the server would reject the command while parsing it.
 */
export function requireTimestamp(value: string | null | undefined): string {
  if (value === null || value === undefined) {
    throw new MutationError(400, "timestamp year must be between 1 and 9999");
  }
  checkTimestamp(value);
  return parseTimestamp(value);
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

/**
 * Rust `char::is_whitespace` set (Unicode `White_Space`): U+0009-000D, U+0020,
 * U+0085, U+00A0, U+1680, U+2000-200A, U+2028, U+2029, U+202F, U+205F, U+3000.
 * JS `trim` additionally strips U+FEFF and misses U+0085, so a BOM-only title
 * is rejected locally but accepted by the server (`domain::text` uses Rust
 * `trim` and byte length). Every text helper here uses this trim and UTF-8
 * byte lengths (`TextEncoder`), matching Rust `value.len()`.
 */
const RUST_TRIM_CHARS = new Set([
  "\u0009",
  "\u000a",
  "\u000b",
  "\u000c",
  "\u000d",
  "\u0020",
  "\u0085",
  "\u00a0",
  "\u1680",
  "\u2000",
  "\u2001",
  "\u2002",
  "\u2003",
  "\u2004",
  "\u2005",
  "\u2006",
  "\u2007",
  "\u2008",
  "\u2009",
  "\u200a",
  "\u2028",
  "\u2029",
  "\u202f",
  "\u205f",
  "\u3000",
]);

export function rustTrim(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && RUST_TRIM_CHARS.has(value[start] as string)) start += 1;
  while (end > start && RUST_TRIM_CHARS.has(value[end - 1] as string)) end -= 1;
  return value.slice(start, end);
}

export function utf8Length(value: string): number {
  return new TextEncoder().encode(value).length;
}

/** Dedupe and sort by PostgreSQL `uuid` byte order (equivalent to lowercase hex string order). */
export function dedupeSortUuids(ids: readonly string[]): string[] {
  return [...new Set(ids)].sort();
}

/** `domain::text`: blank or over-long values are a 400 with this message. */
export function checkText(value: string, max: number): void {
  if (rustTrim(value) === "" || utf8Length(value) > max) {
    throw new MutationError(400, `text must contain 1 to ${max} bytes`);
  }
}

/**
 * `domain::optional_timestamp`: client timestamps must land in years 1-9999,
 * which is what the replica can ingest. Unparseable input fails the same
 * check; the server rejects it while parsing the command instead. Uses the
 * shared RFC 3339 parser so anything accepted here can be stored.
 */
export function checkTimestamp(value: string | null | undefined): void {
  if (value === null || value === undefined) return;
  let normalized: string;
  try {
    normalized = parseTimestamp(value, true);
  } catch (error) {
    if (error instanceof Error && error.message === "premature end of input") {
      throw new MutationError(400, error.message);
    }
    throw new MutationError(400, "timestamp year must be between 1 and 9999");
  }
  const year = Number(/^([+-]?\d+)-/.exec(normalized)?.[1]);
  if (!Number.isInteger(year) || year < 1 || year > 9999) {
    throw new MutationError(400, "timestamp year must be between 1 and 9999");
  }
}

/** `Operation::issues` source-link validation: http(s) URLs up to 4096 bytes. */
export function checkSourceUrl(url: string): void {
  let protocol = "";
  try {
    protocol = new URL(url).protocol;
  } catch {
    throw new MutationError(400, "invalid URL");
  }
  if ((protocol !== "http:" && protocol !== "https:") || utf8Length(url) > 4096) {
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
 * create, update, move and restore share it. `before` is the stored issue,
 * null when creating; its sprint is the one the issue may keep, and staying
 * in a finished sprint is allowed only from a done/cancelled stage. Unknown
 * stage kinds are skipped: the server cannot see them, and the replica
 * always loads every team.
 */
export function validateIssue(
  tx: Tx,
  issue: DeepReadonly<SyncIssue>,
  before: DeepReadonly<SyncIssue> | null,
): void {
  checkText(issue.title, 500);
  checkTimestamp(issue.deadline);
  if (utf8Length(issue.description) > 100_000) {
    throw new MutationError(400, "description too long");
  }

  const kind = stageKindOf(tx, issue.team_id, issue.stage_id);
  if (kind === undefined) throw new MutationError(400, "stage belongs to another team");

  checkIssueReferences(tx, issue);
  checkIssueSprint(tx, issue, kind, before?.sprint_id ?? null);
  checkIssueDependencies(tx, issue, kind, before);
  checkIssueParent(tx, issue);
}

function isFinished(kind: StageKind | undefined): boolean {
  return kind === "done" || kind === "cancelled";
}

function checkIssueReferences(tx: Tx, issue: DeepReadonly<SyncIssue>): void {
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
}

function checkIssueSprint(
  tx: Tx,
  issue: DeepReadonly<SyncIssue>,
  kind: StageKind,
  retainedSprint: string | null,
): void {
  if (issue.sprint_id === null) return;
  const sprint = tx.get("sprints", issue.sprint_id);
  if (sprint === undefined) throw new MutationError(404, "not found");
  const finished = sprint.state === "completed" || sprint.state === "archived";
  const mayStay = retainedSprint === issue.sprint_id && isFinished(kind);
  if (sprint.team_id !== issue.team_id || (finished && !mayStay)) {
    throw new MutationError(400, "sprint is unavailable for this team");
  }
}

/**
 * Dependencies gate entering an active or done stage, and new dependencies of
 * a started issue. Ones that reopen later leave the issue blocked, not invalid.
 */
function checkIssueDependencies(
  tx: Tx,
  issue: DeepReadonly<SyncIssue>,
  kind: StageKind,
  before: DeepReadonly<SyncIssue> | null,
): void {
  const started = issue.deleted_at === null && (kind === "active" || kind === "done");
  const entered = before === null || before.stage_id !== issue.stage_id;
  for (const dep of new Set(issue.dependencies)) {
    const added = before === null || !before.dependencies.includes(dep);
    const other = tx.get("issues", dep);
    if (added) {
      if (other === undefined) throw new MutationError(404, "not found");
      if (dep === issue.id || other.deleted_at !== null) {
        throw new MutationError(400, "invalid dependency");
      }
    }
    if (started && (added || entered) && other !== undefined && other.deleted_at === null) {
      const depKind = stageKindOf(tx, other.team_id, other.stage_id);
      if (depKind !== undefined && !isFinished(depKind)) {
        throw new MutationError(409, "issue has unfinished dependencies");
      }
    }
    if (added && reachable(tx, dep, issue.id)) {
      throw new MutationError(400, "dependency cycle");
    }
  }
}

function checkIssueParent(tx: Tx, issue: DeepReadonly<SyncIssue>): void {
  if (issue.parent_id === null) return;
  const parent = tx.get("issues", issue.parent_id);
  if (parent === undefined || parent.deleted_at !== null) {
    throw new MutationError(404, "not found");
  }
  if (issue.parent_id === issue.id || hasAncestor(tx, issue.parent_id, issue.id)) {
    throw new MutationError(400, "parent cycle");
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

/** A client-chosen id must be present and not nil (`domain::client_id`). */
export function requireClientId(id: string | null | undefined): string {
  if (id === null || id === undefined) throw new MutationError(400, "id is required");
  if (id === NIL_UUID) throw new MutationError(400, "id must not be nil");
  return id;
}

/** `requireClientId` plus the collision check at the server's reservation point. */
export function reserveClientId(
  tx: Tx,
  id: string | null | undefined,
  ctx: MutatorContext,
): string {
  const checked = requireClientId(id);
  checkCreateId(tx, checked, ctx);
  return checked;
}

/** Reject visible collisions at the server's id reservation point. Replay remains an upsert. */
export function checkCreateId(tx: Tx, id: string, ctx: MutatorContext): void {
  if (ctx.mode === "replay") return;
  const exists =
    ENTITIES.some((entity) => tx.get(entity, id) !== undefined) ||
    tx.all("teams").some((team) => team.stages.some((stage) => stage.id === id)) ||
    tx.all("issues").some((issue) => issue.attachments.some((file) => file.id === id)) ||
    tx.all("comments").some((comment) => comment.attachments.some((file) => file.id === id));
  if (exists) throw new MutationError(409, "id already exists");
}

/** Workspace counts include trashed and archived records, as SQL capacity does. */
export function checkCapacity(
  tx: Tx,
  entity: Entity,
  maximum: number,
  ctx: MutatorContext,
  id?: string,
): void {
  if (ctx.mode === "replay" && id !== undefined && tx.get(entity, id) !== undefined) return;
  if (tx.all(entity).length >= maximum) throw new MutationError(400, "workspace capacity reached");
}
