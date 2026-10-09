import type { AlertKind, Profile } from "../../lib/types";
import { object } from "./commands";
import { Tables } from "./tables";

interface ServerEffects {
  tx: Tables;
  before: Tables;
  nextIssueNumber: number;
  actor: string;
  name: string;
  args: Record<string, unknown>;
  id: string | null;
  now: () => string;
  generateId: () => string;
  users: ReadonlyMap<string, Profile>;
}

/** Audit corrections to client predictions here against Operation and persistence. */
export function applyServerOnlyEffects(context: ServerEffects): number {
  const { tx, actor, name, args, id } = context;
  let nextNumber = context.nextIssueNumber;
  if (name === "update_view" && id && !tx.get("views", id)) {
    const view = context.before.get("views", id);
    if (view && typeof args.name === "string" && object(args.filter))
      tx.put("views", { ...view, name: args.name, shared: false, filter: args.filter });
  }
  if (name === "move_issue" && id && typeof args.before_id === "string") {
    const issue = tx.get("issues", id);
    const neighbor = tx.get("issues", args.before_id);
    if (issue && neighbor) {
      const peers = tx
        .byIndex("issues", "stage_id", issue.stage_id)
        .filter(
          (peer) => peer.id !== id && peer.team_id === issue.team_id && peer.deleted_at === null,
        );
      const preceding = peers.filter(
        (peer) =>
          peer.position < neighbor.position ||
          (peer.position === neighbor.position && peer.id < neighbor.id),
      );
      const lower = preceding.length
        ? Math.max(...preceding.map((peer) => peer.position))
        : neighbor.position - 2048;
      if (neighbor.position - lower <= 1) {
        const ordered = [...peers].sort(
          (a, b) => a.position - b.position || (a.id < b.id ? -1 : 1),
        );
        for (const [rank, peer] of ordered.entries()) {
          tx.put("issues", { ...peer, position: rank * 1024 });
          if (peer.id === neighbor.id) tx.put("issues", { ...issue, position: rank * 1024 - 512 });
        }
      }
    }
  }
  if (
    ["follow", "add_source_link"].includes(name) &&
    typeof args.issue_id === "string" &&
    !tx.touched.has(`issues:${args.issue_id}`)
  ) {
    const issue = tx.get("issues", args.issue_id);
    if (issue) tx.put("issues", issue);
  }
  if (name === "set_team_members" && id) {
    const old = context.before.get("teams", id);
    const team = tx.get("teams", id);
    for (const user of new Set([...(old?.members ?? []), ...(team?.members ?? [])])) {
      const member = tx.get("members", user);
      if (member) tx.put("members", member);
    }
  }
  for (const { entity, id: key } of [...tx.touched.values()]) {
    const row = tx.get(entity, key);
    const before = context.before.get(entity, key);
    if (!row) continue;
    if ("version" in row) {
      // Child-table triggers render their parent without touching its version.
      const childChanged =
        (entity === "members" && ["create_team", "set_team_members"].includes(name)) ||
        (entity === "teams" && ["create_stage", "update_stage", "delete_stage"].includes(name)) ||
        (entity === "issues" && name === "update_stage");
      const version = before && "version" in before ? before.version + (childChanged ? 0 : 1) : 1;
      tx.put(entity, { ...row, version });
    }
    if (entity === "issues") {
      const issue = tx.get("issues", key);
      if (!issue) continue;
      const created = !context.before.get("issues", key);
      tx.put("issues", {
        ...issue,
        number: issue.number ?? nextNumber++,
        ...(created
          ? {
              created_at: context.now(),
              followers: [...new Set([...issue.followers, actor])].sort(),
            }
          : {}),
        updated_at:
          (name === "move_issue" && key !== id) ||
          ["follow", "add_source_link", "remove_attachment"].includes(name)
            ? issue.updated_at
            : context.now(),
      });
      if (created) {
        const workspace = tx.all("workspace")[0];
        if (workspace) tx.put("workspace", workspace); // next_issue_number UPDATE triggers workspace change without a version bump.
      }
      const oldIssue = context.before.get("issues", key);
      if (
        (name === "create_issue" || name === "update_issue" || name === "bulk_issues") &&
        issue.assignee &&
        issue.assignee !== actor &&
        issue.assignee !== oldIssue?.assignee
      )
        notify(context, tx, issue.assignee, issue.id, "assignment", issue.title);
      if (name === "update_issue" || (name === "bulk_issues" && object(args.action)))
        for (const follower of issue.followers)
          if (follower !== actor) notify(context, tx, follower, issue.id, "change", issue.title);
    }
    if (entity === "teams") {
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
                  JSON.stringify({ ...stage, version: previous.version }) !==
                    JSON.stringify(previous))
                  ? previous.version + 1
                  : (previous?.version ?? 1),
            };
          }),
        });
    }
  }
  if (name === "move_issue" && !args.before_id && id) {
    const issue = tx.get("issues", id);
    if (issue) {
      const positions = tx
        .byIndex("issues", "stage_id", issue.stage_id)
        .filter((i) => i.id !== id && i.team_id === issue.team_id && i.deleted_at === null)
        .map((i) => i.position);
      tx.put("issues", { ...issue, position: Math.max(-1024, ...positions) + 1024 });
    }
  }
  if (name === "add_comment" && id) {
    const comment = tx.get("comments", id);
    const issue = comment ? tx.get("issues", comment.issue_id) : undefined;
    if (comment && issue) {
      for (const follower of issue.followers)
        if (follower !== actor)
          notify(context, tx, follower, issue.id, "reply", comment.body, `reply:${id}:${follower}`);
      for (const mention of comment.mentions)
        if (mention !== actor)
          notify(
            context,
            tx,
            mention,
            issue.id,
            "mention",
            comment.body,
            `mention:${id}:${mention}`,
          );
    }
  }
  const terminal = (tables: Tables, stageId: string): boolean =>
    tables
      .all("teams")
      .some((team) =>
        team.stages.some(
          (stage) => stage.id === stageId && (stage.kind === "done" || stage.kind === "cancelled"),
        ),
      );
  const sendsCompletion =
    ["create_issue", "update_issue", "move_issue", "update_stage"].includes(name) ||
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
  const fieldNames = [
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
  const fields: string[] = [];
  if (name === "update_issue" || (name === "bulk_issues" && object(args.action))) {
    for (const { entity, id: key } of tx.touched.values()) {
      if (entity !== "issues") continue;
      const before = context.before.get("issues", key);
      const after = tx.get("issues", key);
      if (!before || !after) continue;
      for (const field of fieldNames)
        if (JSON.stringify(before[field]) !== JSON.stringify(after[field]))
          fields.push(field.replace(/_id$/, ""));
    }
  }
  tx.put("activity", {
    id: context.generateId(),
    actor,
    action: name,
    entity_id: id,
    at: context.now(),
    fields: [...new Set(fields)],
  });
  return nextNumber;
}

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
  const global =
    kind === "assignment"
      ? profile?.alerts.assignments
      : kind === "change"
        ? profile?.alerts.changes
        : kind === "deadline"
          ? profile?.alerts.deadlines
          : profile?.alerts.replies;
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
