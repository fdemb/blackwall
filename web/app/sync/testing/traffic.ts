import type { Command } from "../../lib/types";
import type { SyncStore } from "../store";
import { simulationId } from "./seeded";

export function convergenceCommand({
  store,
  actor,
  team,
  owner,
  text,
  at,
  random,
}: {
  store: SyncStore;
  actor: string;
  team: string;
  owner: string;
  text: string;
  at: string;
  random: () => number;
}): Command {
  const integer = (max: number) => Math.floor(random() * max);
  const pick = <T>(items: readonly T[]): T => {
    if (!items.length) throw new Error("cannot pick from an empty set");
    return items[integer(items.length)];
  };
  const issues = store.all("issues").filter((row) => row.deleted_at === null);
  const target = issues.length ? pick(issues) : undefined;
  const role = store.get("members", actor)?.role;
  const markAllRead: Command = {
    type: "mark_all_notifications_read",
    notifications: store
      .all("notifications")
      .filter((row) => row.user_id === actor && row.read_at === null)
      .map(({ id, created_at }) => ({ id, created_at })),
  };
  if (integer(16) === 0)
    return { type: "update_issue", id: simulationId(999999), patch: { title: text } };
  if (role === "viewer")
    return pick([
      { type: "save_view", name: text, shared: false, filter: {} },
      {
        type: "configure_alerts",
        assignment: true,
        reply: false,
        change: true,
        mention: true,
        deadline: false,
      },
      markAllRead,
    ] satisfies Command[]);
  if (!target) return { type: "create_issue", input: { team_id: team, title: text } };
  const stage = pick(store.get("teams", target.team_id)?.stages ?? []);
  const others = issues.filter((row) => row.id !== target.id);
  const comments = store.all("comments").filter((row) => row.author === actor);
  const choices: Command[] = [
    { type: "create_issue", input: { team_id: team, title: text, parent_id: target.id } },
    {
      type: "update_issue",
      id: target.id,
      patch: { title: text, priority: pick(["low", "normal", "high", "urgent"]) },
    },
    {
      type: "update_issue",
      id: target.id,
      patch: { dependencies: others.length ? [pick(others).id] : [] },
    },
    { type: "move_issue", id: target.id, stage_id: stage.id, before_id: null },
    { type: "archive_issue", id: target.id },
    { type: "unarchive_issue", id: target.id },
    { type: "delete_issue", id: target.id },
    { type: "follow", issue_id: target.id, following: integer(2) === 0 },
    {
      type: "add_source_link",
      issue_id: target.id,
      url: `https://example.test/${text.split(" ")[0]}`,
      title: text,
    },
    {
      type: "add_comment",
      issue_id: target.id,
      body: text,
      mentions: [owner],
      attachments: [],
    },
    {
      type: "log_time",
      issue_id: target.id,
      minutes: 1 + integer(60),
      note: text,
      logged_at: at,
    },
    { type: "create_label", name: text, color: "#ff0000" },
    { type: "save_view", name: text, shared: integer(2) === 0, filter: {} },
    markAllRead,
    {
      type: "configure_alerts",
      assignment: false,
      reply: true,
      change: true,
      mention: true,
      deadline: true,
    },
  ];
  const deleted = store.all("issues").filter((row) => row.deleted_at !== null);
  if (deleted.length) choices.push({ type: "restore_issue", id: pick(deleted).id });
  if (comments.length) {
    const comment = pick(comments);
    choices.push(
      { type: "edit_comment", id: comment.id, body: text, mentions: [] },
      { type: "delete_comment", id: comment.id },
    );
  }
  if (role === "owner" || role === "admin")
    choices.push(
      { type: "create_project", name: text, description: text, team_ids: [team] },
      { type: "set_team_archive", id: team, archive_after_days: integer(40) },
    );
  return pick(choices);
}
