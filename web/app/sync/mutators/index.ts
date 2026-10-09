import type { Command, Id } from "../../lib/types";
import type { DeepReadonly, PendingMutation, ReplayFn, Tx } from "../store";
import { SyncStore } from "../store";
import type { ArgsOf, Mutator } from "./common";
import { MutationError } from "./errors";
import {
  addSourceLink,
  archiveIssue,
  bulkIssues,
  createIssue,
  deleteIssue,
  followIssue,
  moveIssue,
  removeAttachment,
  restoreIssue,
  unarchiveIssue,
  updateIssue,
} from "./issues";

export type { Mutator, MutatorContext } from "./common";
export { MutationError } from "./errors";

/** Every command name with a mutator, for the registry annotation below. */
const NAMES = [
  "create_issue",
  "update_issue",
  "move_issue",
  "bulk_issues",
  "delete_issue",
  "restore_issue",
  "archive_issue",
  "unarchive_issue",
  "follow",
  "add_source_link",
  "remove_attachment",
] as const satisfies readonly Command["type"][];

export type MutatorName = (typeof NAMES)[number];

/** Command name to mutator. Args types must match the `Command` union member. */
export const MUTATORS: { [T in MutatorName]: Mutator<ArgsOf<T>> } = {
  create_issue: createIssue,
  update_issue: updateIssue,
  move_issue: moveIssue,
  bulk_issues: bulkIssues,
  delete_issue: deleteIssue,
  restore_issue: restoreIssue,
  archive_issue: archiveIssue,
  unarchive_issue: unarchiveIssue,
  follow: followIssue,
  add_source_link: addSourceLink,
  remove_attachment: removeAttachment,
};

/**
 * Commands with no mutator by design: secrets or bulk server work that goes
 * through push only when the outbox is empty, plus attachment uploads, which
 * use the REST upload endpoint. Their effects arrive through the next pull.
 */
export const ONLINE_ONLY = [
  "invite",
  "resend_invitation",
  "create_integration",
  "set_role",
  "remove_member",
  "import_issues",
  "add_attachment",
  "attach_comment_file",
] as const;

export type OnlineOnly = (typeof ONLINE_ONLY)[number];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Strips every `null`-valued key from objects in `args`, recursively through
 * nested objects but not inside arrays. Serde treats `null` and absent the
 * same for every `Option` field, so this matches the server for every command.
 * A `null` inside an array is preserved.
 */
export function stripNulls<T>(value: T): T {
  if (Array.isArray(value)) return value;
  if (!isPlainObject(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item === null) continue;
    out[key] = isPlainObject(item) ? stripNulls(item) : item;
  }
  return out as T;
}

/** Dispatches a pending mutation to its mutator with time from the mutation. */
export function createReplay(actor: Id): ReplayFn {
  const table = MUTATORS as unknown as Record<string, Mutator<unknown>>;
  return (tx: Tx, mutation: DeepReadonly<PendingMutation>) => {
    if (!Object.prototype.hasOwnProperty.call(table, mutation.name)) {
      throw new MutationError(400, `unknown command ${mutation.name}`);
    }
    const mutator = table[mutation.name] as Mutator<unknown>;
    mutator(tx, stripNulls(mutation.args), { actor, at: mutation.at, mode: "replay" });
  };
}

/**
 * Runs a mutation once in admit mode against the current view, without writing
 * anything. A throw rejects the edit before it enters the outbox and is shown
 * to the user; replay errors are diagnostics and never reach the user.
 */
export function admit(
  store: SyncStore,
  actor: Id,
  mutation: Pick<DeepReadonly<PendingMutation>, "name" | "args" | "at">,
): void {
  const table = MUTATORS as unknown as Record<string, Mutator<unknown>>;
  if (!Object.prototype.hasOwnProperty.call(table, mutation.name)) {
    throw new MutationError(400, `unknown command ${mutation.name}`);
  }
  const mutator = table[mutation.name] as Mutator<unknown>;
  const args = stripNulls(mutation.args);
  store.dryRun((tx) => {
    mutator(tx, args, { actor, at: mutation.at, mode: "admit" });
  });
}
