import type { AlertKind, Profile } from "../../lib/types";
import { object } from "./commands";
import { Tables } from "./tables";

interface ServerEffects {
  tx: Tables;
  before: Tables;
  actor: string;
  name: string;
  args: Record<string, unknown>;
  id: string | null;
  now: () => string;
  generateId: () => string;
  users: ReadonlyMap<string, Profile>;
}

/** Audit corrections to client predictions here against Operation and persistence. */
export function applyServerOnlyEffects(context: ServerEffects): void {
  correctPredictions(context);
  stampRecords(context);
  finishCommand(context);
  recordCompletions(context);
  recordActivity(context);
}

function correctPredictions(context: ServerEffects): void {
  restorePrivateViewUpdate(context);
  rebalanceMoveTarget(context);
  touchFollowedIssue(context);
  touchTeamMembers(context);
}

/** Restores a view `update_view` hid from the actor, with the update applied and sharing off. */
function restorePrivateViewUpdate({ tx, before, name, args, id }: ServerEffects): void {
  if (name !== "update_view" || !id || tx.get("views", id)) return;
  const view = before.get("views", id);
  if (view && typeof args.name === "string" && object(args.filter))
    tx.put("views", { ...view, name: args.name, shared: false, filter: args.filter });
}

/** `move_issue` before a neighbor with no gap rebalances the whole stage, as the server does. */
function rebalanceMoveTarget({ tx, name, args, id }: ServerEffects): void {
  if (name !== "move_issue" || !id || typeof args.before_id !== "string") return;
  const issue = tx.get("issues", id);
  const neighbor = tx.get("issues", args.before_id);
  if (!issue || !neighbor) return;
  const peers = tx
    .byIndex("issues", "stage_id", issue.stage_id)
    .filter((peer) => peer.id !== id && peer.team_id === issue.team_id && peer.deleted_at === null);
  const preceding = peers.filter(
    (peer) =>
      peer.position < neighbor.position ||
      (peer.position === neighbor.position && peer.id < neighbor.id),
  );
  const lower = preceding.length
    ? Math.max(...preceding.map((peer) => peer.position))
    : neighbor.position - 2048;
  if (neighbor.position - lower > 1) return;
  const ordered = [...peers].sort((a, b) => a.position - b.position || (a.id < b.id ? -1 : 1));
  for (const [rank, peer] of ordered.entries()) {
    tx.put("issues", { ...peer, position: rank * 1024 });
    if (peer.id === neighbor.id) tx.put("issues", { ...issue, position: rank * 1024 - 512 });
  }
}

/** Follows and source links change child tables, which re-render the issue. */
function touchFollowedIssue({ tx, name, args }: ServerEffects): void {
  if (!["follow", "add_source_link"].includes(name) || typeof args.issue_id !== "string") return;
  if (tx.touched.has(`issues:${args.issue_id}`)) return;
  const issue = tx.get("issues", args.issue_id);
  if (issue) tx.put("issues", issue);
}

/** Team membership changes re-render every member who joined or left. */
function touchTeamMembers({ tx, before, name, id }: ServerEffects): void {
  if (name !== "set_team_members" || !id) return;
  const old = before.get("teams", id);
  const team = tx.get("teams", id);
  for (const user of new Set([...(old?.members ?? []), ...(team?.members ?? [])])) {
    const member = tx.get("members", user);
    if (member) tx.put("members", member);
  }
}

function stampRecords(context: ServerEffects): void {
  const { tx, name } = context;
  for (const { entity, id: key } of [...tx.touched.values()]) {
    const row = tx.get(entity, key);
    const before = context.before.get(entity, key);
    if (!row) continue;
    if ("version" in row) {
      // Child-table triggers render their parent without touching its version.
      const childChanged =
        (entity === "members" && ["create_team", "set_team_members"].includes(name)) ||
        (entity === "teams" && ["create_stage", "update_stage", "delete_stage"].includes(name)) ||
        (entity === "issues" && ["update_stage", "add_comment"].includes(name));
      const version = before && "version" in before ? before.version + (childChanged ? 0 : 1) : 1;
      tx.put(entity, { ...row, version });
    }
    if (entity === "issues") stampIssue(context, key);
    if (entity === "teams") stampTeam(context, key);
  }
}

// The create mutator numbers issues by the server's rule, against the server's own rows.
function stampIssue(context: ServerEffects, key: string): void {
  const { tx, actor, name, args, id } = context;
  const issue = tx.get("issues", key);
  if (!issue) return;
  const created = !context.before.get("issues", key);
  tx.put("issues", {
    ...issue,
    ...(created
      ? {
          created_at: context.now(),
          followers: [...new Set([...issue.followers, actor])].sort(),
        }
      : {}),
    updated_at:
      (name === "move_issue" && key !== id) ||
      ["follow", "add_source_link", "remove_attachment", "add_comment"].includes(name)
        ? issue.updated_at
        : context.now(),
  });
  const oldIssue = context.before.get("issues", key);
  if (
    (name === "create_issue" || name === "update_issue" || name === "bulk_issues") &&
    issue.assignee &&
    issue.assignee !== actor &&
    issue.assignee !== oldIssue?.assignee
  )
    notify(context, tx, issue.assignee, issue.id, "assignment", issue.title);
  if (name === "update_issue" || (name === "bulk_issues" && object(args.action)))
    for (const follower of oldIssue?.followers ?? issue.followers)
      if (follower !== actor) notify(context, tx, follower, issue.id, "change", issue.title);
}

function stampTeam(context: ServerEffects, key: string): void {
  const { tx, name, args } = context;
  const team = tx.get("teams", key);
  const old = context.before.get("teams", key);
  if (team)
    tx.put("teams", {
      ...team,
      stages: team.stages.map((stage) => {
        const previous = old?.stages.find((s) => s.id === stage.id);
        return {
          ...stage,
          version:
            previous &&
            ((name === "update_stage" && stage.id === args.id) ||
              JSON.stringify({ ...stage, version: previous.version }) !== JSON.stringify(previous))
              ? previous.version + 1
              : (previous?.version ?? 1),
        };
      }),
    });
}

function finishCommand(context: ServerEffects): void {
  placeMovedIssueLast(context);
  notifyCommentReaders(context);
}

/** `move_issue` without `before_id` lands one slot past the stage's last issue. */
function placeMovedIssueLast({ tx, name, args, id }: ServerEffects): void {
  if (name !== "move_issue" || args.before_id || !id) return;
  const issue = tx.get("issues", id);
  if (!issue) return;
  const positions = tx
    .byIndex("issues", "stage_id", issue.stage_id)
    .filter((i) => i.id !== id && i.team_id === issue.team_id && i.deleted_at === null)
    .map((i) => i.position);
  tx.put("issues", { ...issue, position: Math.max(-1024, ...positions) + 1024 });
}

function notifyCommentReaders(context: ServerEffects): void {
  const { tx, actor, name, id } = context;
  if (name !== "add_comment" || !id) return;
  const comment = tx.get("comments", id);
  const issue = comment ? tx.get("issues", comment.issue_id) : undefined;
  if (!comment || !issue) return;
  const readers = context.before.get("issues", issue.id)?.followers ?? issue.followers;
  for (const follower of readers)
    if (follower !== actor)
      notify(context, tx, follower, issue.id, "reply", comment.body, `reply:${id}:${follower}`);
  for (const mention of comment.mentions)
    if (mention !== actor)
      notify(context, tx, mention, issue.id, "mention", comment.body, `mention:${id}:${mention}`);
}

function recordCompletions(context: ServerEffects): void {
  const { tx, actor, name, args } = context;
  const terminal = (tables: Tables, stageId: string): boolean =>
    tables
      .all("teams")
      .some((team) =>
        team.stages.some(
          (stage) => stage.id === stageId && (stage.kind === "done" || stage.kind === "cancelled"),
        ),
      );
  const sendsCompletion =
    ["create_issue", "update_issue", "move_issue", "update_stage", "delete_stage"].includes(name) ||
    (name === "bulk_issues" && object(args.action));
  if (sendsCompletion) {
    const candidates =
      name === "update_stage"
        ? tx.all("issues").filter((issue) => issue.stage_id === args.id)
        : [...tx.touched.values()]
            .filter((pair) => pair.entity === "issues")
            .flatMap((pair) => {
              const issue = tx.get("issues", pair.id);
              return issue ? [issue] : [];
            });
    for (const issue of candidates) {
      const before = context.before.get("issues", issue.id);
      if (
        issue.deleted_at === null &&
        terminal(tx, issue.stage_id) &&
        (!before || before.deleted_at !== null || !terminal(context.before, before.stage_id))
      )
        tx.put("activity", {
          id: context.generateId(),
          actor,
          action: "issue_completed",
          entity_id: issue.id,
          at: context.now(),
          fields: [],
        });
    }
  }
}

const ACTIVITY_FIELDS = [
  "title",
  "description",
  "stage_id",
  "assignee",
  "priority",
  "labels",
  "estimate",
  "deadline",
  "project_id",
  "milestone_id",
  "sprint_id",
  "parent_id",
  "dependencies",
] as const;

function recordActivity(context: ServerEffects): void {
  const { tx, actor, name, args, id } = context;
  const fields: string[] = [];
  if (
    name === "move_issue" &&
    id &&
    context.before.get("issues", id)?.stage_id !== tx.get("issues", id)?.stage_id
  )
    fields.push("stage");
  if (["archive_issue", "unarchive_issue"].includes(name)) fields.push("archived");
  if (name === "update_issue" || (name === "bulk_issues" && object(args.action)))
    fields.push(...changedIssueFields(context));
  tx.put("activity", {
    id: context.generateId(),
    actor,
    action: name,
    entity_id: id,
    at: context.now(),
    fields: [...new Set(fields)],
  });
}

/** Activity field names for every touched issue, `_id` suffixes dropped. */
function changedIssueFields({ tx, before }: ServerEffects): string[] {
  const fields: string[] = [];
  for (const { entity, id: key } of tx.touched.values()) {
    if (entity !== "issues") continue;
    const old = before.get("issues", key);
    const current = tx.get("issues", key);
    if (!old || !current) continue;
    for (const field of ACTIVITY_FIELDS)
      if (JSON.stringify(old[field]) !== JSON.stringify(current[field]))
        fields.push(field.replace(/_id$/, ""));
  }
  return fields;
}

/** The profile switch that silences each alert kind; mentions follow replies. */
const GLOBAL_ALERT = {
  assignment: "assignments",
  change: "changes",
  deadline: "deadlines",
  reply: "replies",
  mention: "replies",
} as const;

function notify(
  context: ServerEffects,
  tx: Tables,
  user: string,
  issue: string,
  kind: AlertKind,
  message: string,
  key?: string,
): void {
  const profile = context.users.get(user);
  const global = profile?.alerts[GLOBAL_ALERT[kind]];
  if (
    !tx.get("members", user) ||
    tx.get("alert_preferences", user)?.[kind] === false ||
    global === false
  )
    return;
  const id = context.generateId();
  const dedup_key = key ?? `${kind}:${issue}:${user}:${id}`;
  if (tx.all("notifications").some((notification) => notification.dedup_key === dedup_key)) return;
  tx.put("notifications", {
    id,
    version: 1,
    user_id: user,
    issue_id: issue,
    kind,
    message,
    read_at: null,
    created_at: context.now(),
    dedup_key,
  });
}
