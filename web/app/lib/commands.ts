import { MutationObserver, type QueryClient } from "@tanstack/react-query";
import { createOptimisticAction } from "@tanstack/react-db";
import { ApiError, workspaces } from "./api";
import type { WorkspaceDb } from "./db";
import { commandEntityIds, expectedVersions } from "./entity-versions";
import { keys } from "./query-client";
import { applyChanges } from "./sync";
import type { Command, CommandResult, EntityVersions, Id, Issue, IssuePatch } from "./types";

const now = () => new Date().toISOString();

/** Applies an issue patch the way the server will, minus derived fields. */
export function patchIssue(issue: Issue, p: IssuePatch) {
  if (p.title !== undefined) issue.title = p.title;
  if (p.description !== undefined) issue.description = p.description;
  if (p.stage_id !== undefined) issue.stage_id = p.stage_id;
  if (p.priority !== undefined) issue.priority = p.priority;
  if (p.labels !== undefined) issue.labels = p.labels;
  if (p.dependencies !== undefined) issue.dependencies = p.dependencies;
  if (p.assignee !== undefined) issue.assignee = p.assignee;
  if (p.clear_assignee) issue.assignee = null;
  if (p.estimate !== undefined) issue.estimate = p.estimate;
  if (p.clear_estimate) issue.estimate = null;
  if (p.deadline !== undefined) issue.deadline = new Date(p.deadline).toISOString();
  if (p.clear_deadline) issue.deadline = null;
  if (p.project_id !== undefined) issue.project_id = p.project_id;
  if (p.clear_project) issue.project_id = issue.milestone_id = null;
  if (p.milestone_id !== undefined) issue.milestone_id = p.milestone_id;
  if (p.clear_milestone) issue.milestone_id = null;
  if (p.sprint_id !== undefined) issue.sprint_id = p.sprint_id;
  if (p.clear_sprint) issue.sprint_id = null;
  if (p.parent_id !== undefined) issue.parent_id = p.parent_id;
  if (p.clear_parent) issue.parent_id = null;
  issue.updated_at = now();
}

/** Where a moved issue lands: just before `before`, or after the stage's last issue. */
function movedPosition(db: WorkspaceDb, id: Id, stageId: Id, beforeId: Id | null) {
  const before = beforeId ? db.issues.get(beforeId) : undefined;
  if (before) return before.position - 0.5;
  const positions = db.issues.toArray
    .filter((i) => i.stage_id === stageId && i.id !== id)
    .map((i) => i.position);
  return Math.max(0, ...positions) + 1;
}

/**
 * The local effect of a command, applied before the server answers and rolled back if it
 * fails. Commands whose result only the server knows, such as creates, have none.
 */
export function optimisticEffect(
  db: WorkspaceDb,
  command: Command,
  me: Id,
): (() => void) | undefined {
  const issues = (ids: Id[], edit: (issue: Issue) => void) => {
    const present = ids.filter((id) => db.issues.has(id));
    if (present.length === 0) return undefined;
    return () =>
      void db.issues.update(present, (drafts) => {
        for (const draft of drafts) edit(draft);
      });
  };
  // Records this client never loaded have no local copy to change.
  const when = (collection: { has: (id: Id) => boolean }, id: Id, apply: () => unknown) =>
    collection.has(id) ? () => void apply() : undefined;
  const remove = (collection: { has: (id: Id) => boolean; delete: (id: Id) => unknown }, id: Id) =>
    when(collection, id, () => collection.delete(id));

  switch (command.type) {
    case "update_issue":
      return issues([command.id], (i) => patchIssue(i, command.patch));
    case "bulk_issues": {
      const action = command.action;
      return issues(command.ids, (i) => {
        if (action === "delete") i.deleted_at = now();
        else if (action === "restore") i.deleted_at = null;
        else if (action === "archive") i.archived_at = now();
        else if (action === "unarchive") i.archived_at = null;
        else patchIssue(i, action.update);
      });
    }
    case "move_issue": {
      const position = movedPosition(db, command.id, command.stage_id, command.before_id);
      return issues([command.id], (i) => {
        i.stage_id = command.stage_id;
        i.position = position;
      });
    }
    case "delete_issue":
      return issues([command.id], (i) => {
        i.deleted_at = now();
      });
    case "restore_issue":
      return issues([command.id], (i) => {
        i.deleted_at = null;
      });
    case "archive_issue":
      return issues([command.id], (i) => {
        i.archived_at = now();
      });
    case "unarchive_issue":
      return issues([command.id], (i) => {
        i.archived_at = null;
      });
    case "follow":
      return issues([command.issue_id], (i) => {
        i.followers = command.following
          ? [...new Set([...i.followers, me])]
          : i.followers.filter((f) => f !== me);
      });
    case "update_label":
      return when(db.labels, command.id, () =>
        db.labels.update(command.id, (l) => {
          l.name = command.name;
          l.color = command.color;
        }),
      );
    case "update_project":
      return when(db.projects, command.id, () =>
        db.projects.update(command.id, (p) => {
          p.name = command.name;
          p.description = command.description;
          p.team_ids = command.team_ids;
        }),
      );
    case "update_milestone":
      return when(db.milestones, command.id, () =>
        db.milestones.update(command.id, (m) => {
          m.name = command.name;
          m.deadline = command.deadline;
        }),
      );
    case "update_sprint":
      return when(db.sprints, command.id, () =>
        db.sprints.update(command.id, (s) => {
          s.name = command.name;
          s.goal = command.goal;
          s.starts_at = command.starts_at;
          s.ends_at = command.ends_at;
          s.state = command.state;
        }),
      );
    case "archive_sprint":
      return when(db.sprints, command.id, () =>
        db.sprints.update(command.id, (s) => {
          s.state = "archived";
        }),
      );
    case "set_team_members":
      return when(db.teams, command.id, () =>
        db.teams.update(command.id, (t) => {
          t.members = command.members;
        }),
      );
    case "set_team_archive":
      return when(db.teams, command.id, () =>
        db.teams.update(command.id, (t) => {
          t.archive_after_days = command.archive_after_days;
        }),
      );
    case "update_stage":
      return when(db.teams, command.team_id, () =>
        db.teams.update(command.team_id, (t) => {
          t.stages = t.stages
            .map((s) =>
              s.id === command.id
                ? { ...s, name: command.name, kind: command.kind, position: command.position }
                : s,
            )
            .sort((a, b) => a.position - b.position);
        }),
      );
    case "update_view":
      return when(db.views, command.id, () =>
        db.views.update(command.id, (v) => {
          v.name = command.name;
          v.shared = command.shared;
          v.filter = command.filter;
        }),
      );
    case "delete_view":
      return remove(db.views, command.id);
    case "cancel_invitation":
      return when(db.invitations, command.id, () =>
        db.invitations.update(command.id, (i) => {
          i.state = "cancelled";
        }),
      );
    case "update_integration":
      return when(db.integrations, command.id, () =>
        db.integrations.update(command.id, (i) => {
          i.enabled = command.enabled;
        }),
      );
    case "delete_integration":
      return remove(db.integrations, command.id);
    case "mark_notification_read":
      return when(db.notifications, command.id, () =>
        db.notifications.update(command.id, (n) => {
          n.read_at ??= now();
        }),
      );
    case "mark_notification_unread":
      return when(db.notifications, command.id, () =>
        db.notifications.update(command.id, (n) => {
          n.read_at = null;
        }),
      );
    case "mark_all_notifications_read": {
      const unread = db.notifications.toArray.filter((n) => !n.read_at).map((n) => n.id);
      if (unread.length === 0) return undefined;
      return () =>
        void db.notifications.update(unread, (drafts) => {
          for (const n of drafts) n.read_at = now();
        });
    }
    case "configure_alerts":
      return when(db.alert_preferences, me, () =>
        db.alert_preferences.update(me, (p) => {
          p.assignment = command.assignment;
          p.reply = command.reply;
          p.change = command.change;
          p.mention = command.mention;
          p.deadline = command.deadline;
        }),
      );
    case "edit_comment":
      return when(db.comments, command.id, () =>
        db.comments.update(command.id, (c) => {
          c.body = command.body;
          c.mentions = command.mentions;
          c.edited_at = now();
        }),
      );
    case "delete_comment":
      return remove(db.comments, command.id);
    case "update_time":
      return when(db.time_entries, command.id, () =>
        db.time_entries.update(command.id, (e) => {
          e.minutes = command.minutes;
          e.note = command.note;
          e.logged_at = command.logged_at;
        }),
      );
    case "delete_time":
      return remove(db.time_entries, command.id);
    case "set_role":
      return when(db.members, command.user_id, () =>
        db.members.update(command.user_id, (m) => {
          m.role = command.role;
        }),
      );
    case "remove_member":
      return remove(db.members, command.user_id);
    default:
      return undefined;
  }
}

function collect(value: unknown, into: EntityVersions, key: "id" | "user_id" = "id") {
  if (Array.isArray(value)) for (const item of value) collect(item, into, key);
  else if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const id = record[key];
    if (typeof id === "string" && typeof record.version === "number")
      into[id] = Math.max(into[id] ?? 0, record.version);
    // Stages live inside their team.
    for (const nested of Object.values(record)) collect(nested, into, key);
  }
}

/**
 * Confirmed versions, read from the collections' backing queries. A row with a pending local
 * edit shows that edit's snapshot, version included, so the collection view can lag behind.
 * Memberships and alert preferences are keyed by user, so they have their own maps.
 */
function confirmedVersions(client: QueryClient, ws: Id) {
  const records: EntityVersions = {};
  const memberships: EntityVersions = {};
  const preferences: EntityVersions = {};
  for (const [key, data] of client.getQueriesData({ queryKey: [...keys.all(ws), "db"] })) {
    if (key[3] === "members") collect(data, memberships);
    else if (key[3] === "alert_preferences") collect(data, preferences, "user_id");
    else collect(data, records);
  }
  return { records, memberships, preferences };
}

/** Versions of every record a command touches, including issues the server will move with it. */
export function versionsFor(
  client: QueryClient,
  db: WorkspaceDb,
  command: Command,
  me: Id,
): EntityVersions {
  const confirmed = confirmedVersions(client, db.id);
  if (command.type === "set_role" || command.type === "remove_member")
    return expectedVersions([command.user_id], confirmed.memberships);
  if (command.type === "configure_alerts") return expectedVersions([me], confirmed.preferences);
  let ids = commandEntityIds(command, me);
  const issues = db.issues.toArray;
  if (command.type === "complete_sprint")
    ids = [...ids, ...issues.filter((i) => i.sprint_id === command.id).map((i) => i.id)];
  if (command.type === "delete_stage")
    ids = [...ids, ...issues.filter((i) => i.stage_id === command.id).map((i) => i.id)];
  if (command.type === "mark_all_notifications_read")
    ids = db.notifications.toArray.filter((n) => !n.read_at).map((n) => n.id);
  return expectedVersions(ids, confirmed.records);
}

type Send = { send: () => Promise<CommandResult> };

/**
 * Runs writes as TanStack Query mutations. One scope per workspace sends them one at a time,
 * in order, so each computes its versions after the previous write's results have landed.
 */
export function createCommandRunner(client: QueryClient, db: WorkspaceDb, me: Id) {
  const mutate = (send: () => Promise<CommandResult>) =>
    new MutationObserver<CommandResult, Error, Send>(client, {
      mutationKey: keys.commands(db.id),
      scope: { id: `commands:${db.id}` },
      mutationFn: ({ send }) => send(),
      onSuccess: (res) => applyChanges(client, db, res.changes),
    }).mutate({ send });

  // A command retried after a lost response reuses its key, so the server applies it once.
  const operations = new Map<string, { key: string; versions?: EntityVersions }>();

  /** Sends a command, with its optimistic effect applied until the server answers. */
  function command(command: Command, expected?: EntityVersions): Promise<CommandResult> {
    const identity = JSON.stringify(command);
    const operation = operations.get(identity) ?? { key: crypto.randomUUID() };
    operations.set(identity, operation);
    const send = () =>
      mutate(() => {
        operation.versions ??= { ...versionsFor(client, db, command, me), ...expected };
        return workspaces.command(db.id, operation.versions, command, operation.key);
      }).then(
        (res) => {
          operations.delete(identity);
          return res;
        },
        (error: unknown) => {
          // A rejected request can't succeed with the same key; a lost response can.
          if (error instanceof ApiError && error.status < 500) operations.delete(identity);
          throw error;
        },
      );

    const effect = optimisticEffect(db, command, me);
    // A transaction with no local changes would complete without running its mutationFn.
    if (!effect) return send();
    let result: CommandResult | undefined;
    const tx = createOptimisticAction<void>({
      onMutate: effect,
      mutationFn: async () => {
        result = await send();
      },
    })();
    return tx.when("settled").then(() => result!);
  }

  const uploads = new WeakMap<File, Map<Id, { key: string; versions?: EntityVersions }>>();

  /** Uploads a file to an issue or comment, in the same queue as commands. */
  function upload(issueId: Id, file: File, commentId?: Id) {
    const target = commentId ?? issueId;
    const keyed = uploads.get(file) ?? new Map<Id, { key: string; versions?: EntityVersions }>();
    uploads.set(file, keyed);
    const operation = keyed.get(target) ?? { key: crypto.randomUUID() };
    keyed.set(target, operation);
    return mutate(async () => {
      const known = confirmedVersions(client, db.id).records;
      known[target] ??= (await workspaces.issue(db.id, issueId)).version;
      operation.versions ??= expectedVersions([target], known);
      return workspaces.upload(db.id, issueId, operation.versions, file, commentId, operation.key);
    }).then(
      (res) => {
        keyed.delete(target);
        return res;
      },
      (error: unknown) => {
        if (error instanceof ApiError && error.status < 500) keyed.delete(target);
        throw error;
      },
    );
  }

  return { command, upload };
}
