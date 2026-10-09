import type { Command, Id } from "../../lib/types";
import type { DeepReadonly, PendingMutation, ReplayFn, Tx } from "../store";
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

/** Dispatches a pending mutation to its mutator with time from the mutation. */
export function createReplay(actor: Id): ReplayFn {
  const table = MUTATORS as unknown as Record<string, Mutator<unknown>>;
  return (tx: Tx, mutation: DeepReadonly<PendingMutation>) => {
    const mutator = table[mutation.name];
    if (mutator === undefined) throw new MutationError(400, `unknown command ${mutation.name}`);
    mutator(tx, mutation.args, { actor, at: mutation.at });
  };
}
