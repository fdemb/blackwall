import type { Command, Id } from "../../lib/types";
import type { DeepReadonly, PendingMutation, ReplayFn, Tx } from "../store";
import { SyncStore } from "../store";
import type { ArgsOf, Mutator } from "./common";
import { MutationError } from "./errors";
import { normalizeArgs } from "./normalize";
import { cancelInvitation, deleteIntegration, updateIntegration } from "./admin";
import {
  addComment,
  deleteComment,
  deleteTime,
  editComment,
  logTime,
  updateTime,
} from "./discussion";
import {
  archiveSprint,
  completeSprint,
  createLabel,
  createMilestone,
  createProject,
  createSprint,
  createStage,
  createTeam,
  deleteStage,
  setTeamArchive,
  setTeamMembers,
  updateLabel,
  updateMilestone,
  updateProject,
  updateSprint,
  updateStage,
} from "./planning";
import {
  configureAlerts,
  markAllNotificationsRead,
  markNotificationRead,
  markNotificationUnread,
} from "./personal";
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
import { deleteView, saveView, updateView } from "./views";

export type { Mutator, MutatorContext } from "./common";
export { MutationError } from "./errors";
export { normalizeArgs };

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
  "create_team",
  "set_team_members",
  "set_team_archive",
  "create_stage",
  "update_stage",
  "delete_stage",
  "create_label",
  "update_label",
  "create_project",
  "update_project",
  "create_milestone",
  "update_milestone",
  "create_sprint",
  "update_sprint",
  "complete_sprint",
  "archive_sprint",
  "add_comment",
  "edit_comment",
  "delete_comment",
  "log_time",
  "update_time",
  "delete_time",
  "save_view",
  "update_view",
  "delete_view",
  "cancel_invitation",
  "mark_notification_read",
  "mark_notification_unread",
  "mark_all_notifications_read",
  "configure_alerts",
  "update_integration",
  "delete_integration",
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
  create_team: createTeam,
  set_team_members: setTeamMembers,
  set_team_archive: setTeamArchive,
  create_stage: createStage,
  update_stage: updateStage,
  delete_stage: deleteStage,
  create_label: createLabel,
  update_label: updateLabel,
  create_project: createProject,
  update_project: updateProject,
  create_milestone: createMilestone,
  update_milestone: updateMilestone,
  create_sprint: createSprint,
  update_sprint: updateSprint,
  complete_sprint: completeSprint,
  archive_sprint: archiveSprint,
  add_comment: addComment,
  edit_comment: editComment,
  delete_comment: deleteComment,
  log_time: logTime,
  update_time: updateTime,
  delete_time: deleteTime,
  save_view: saveView,
  update_view: updateView,
  delete_view: deleteView,
  cancel_invitation: cancelInvitation,
  mark_notification_read: markNotificationRead,
  mark_notification_unread: markNotificationUnread,
  mark_all_notifications_read: markAllNotificationsRead,
  configure_alerts: configureAlerts,
  update_integration: updateIntegration,
  delete_integration: deleteIntegration,
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

/** Client-chosen ids and names of a command that creates records. Other commands have no entry. */
interface CreateInfo<A> {
  /** Every id the client picked for the records the command creates, including child records. */
  creates: (args: DeepReadonly<A>) => string[];
  /** The title or name the user typed, so a rejected create can say what was lost. */
  label?: (args: DeepReadonly<A>) => string | null;
}

const present = (...ids: (Id | undefined)[]): string[] =>
  ids.filter((id): id is Id => id !== undefined);

/** Online creates are listed too, because the engine fills their ids as well. */
const CREATE_INFO: { [T in Command["type"]]?: CreateInfo<ArgsOf<T>> } = {
  create_issue: { creates: (a) => present(a.input.id), label: (a) => a.input.title },
  create_team: {
    creates: (a) => present(a.id, ...(a.default_stage_ids ?? [])),
    label: (a) => a.name,
  },
  create_stage: { creates: (a) => present(a.id), label: (a) => a.name },
  create_label: { creates: (a) => present(a.id), label: (a) => a.name },
  create_project: { creates: (a) => present(a.id), label: (a) => a.name },
  create_milestone: { creates: (a) => present(a.id), label: (a) => a.name },
  create_sprint: { creates: (a) => present(a.id), label: (a) => a.name },
  add_comment: { creates: (a) => present(a.id) },
  log_time: { creates: (a) => present(a.id) },
  save_view: { creates: (a) => present(a.id), label: (a) => a.name },
  create_integration: { creates: (a) => present(a.id), label: (a) => a.name },
};

const createTable = CREATE_INFO as unknown as Record<string, CreateInfo<unknown> | undefined>;
function createInfo(name: string): CreateInfo<unknown> | undefined {
  return Object.prototype.hasOwnProperty.call(createTable, name) ? createTable[name] : undefined;
}

/** Whether the engine picks a client id for this command's record. */
export function createsRecord(name: string): boolean {
  return createInfo(name) !== undefined;
}

/** A command as the outbox or a rejection holds it. */
type Named = { name: string; args: unknown } | null;

/** The ids a command's records were given, so a REST write can wait until the server knows them. */
export function createdIds(command: Named): string[] {
  if (!command || typeof command.args !== "object" || command.args === null) return [];
  return createInfo(command.name)?.creates(command.args) ?? [];
}

/** The title or name a create was typed with, or null for other commands. */
export function createdLabel(command: Named): string | null {
  if (!command || typeof command.args !== "object" || command.args === null) return null;
  return createInfo(command.name)?.label?.(command.args) ?? null;
}

/** Dispatches a pending mutation to its mutator with time from the mutation. */
export function createReplay(actor: Id): ReplayFn {
  const table = MUTATORS as unknown as Record<string, Mutator<unknown>>;
  return (tx: Tx, mutation: DeepReadonly<PendingMutation>) => {
    if (!Object.prototype.hasOwnProperty.call(table, mutation.name)) {
      throw new MutationError(400, `unknown command ${mutation.name}`);
    }
    const mutator = table[mutation.name] as Mutator<unknown>;
    mutator(tx, normalizeArgs(mutation.name, mutation.args), {
      actor,
      at: mutation.at,
      mode: "replay",
      local: mutation.local,
    });
  };
}

/** What admission validated: the normalized args to send, and client-only data to store. */
export interface AdmitResult {
  args: unknown;
  local?: unknown;
}

/**
 * Runs a mutation once in admit mode against the current view, without writing
 * anything. A throw rejects the edit before it enters the outbox and is shown
 * to the user; replay errors are diagnostics and never reach the user. The
 * returned args are normalized the way the server deserializes them; `local`
 * is client-only data for the pending mutation and is never sent.
 */
export function admit(
  store: SyncStore,
  actor: Id,
  mutation: Pick<DeepReadonly<PendingMutation>, "name" | "args" | "at">,
): AdmitResult {
  const table = MUTATORS as unknown as Record<string, Mutator<unknown>>;
  if (!Object.prototype.hasOwnProperty.call(table, mutation.name)) {
    throw new MutationError(400, `unknown command ${mutation.name}`);
  }
  const mutator = table[mutation.name] as Mutator<unknown>;
  const args = normalizeArgs(mutation.name, mutation.args);
  const local = store.dryRun((tx) => {
    return mutator(tx, args, { actor, at: mutation.at, mode: "admit" });
  });
  return local === undefined ? { args } : { args, local };
}
