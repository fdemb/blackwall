import { randomUUID } from "node:crypto";
import type { Command } from "../../lib/types";
import type { MutatorName } from "../mutators";
import { command, request, object, textField } from "./environment";
import type { User } from "./environment";

export const DATE = "2026-10-10T12:00:00.000Z";
export const END = "2026-10-24T12:00:00.000Z";

export async function fixture(ws: string, owner: User, member: User) {
  const ids = {
    team: randomUUID(),
    stages: Array.from({ length: 4 }, () => randomUUID()),
    label: randomUUID(),
    project: randomUUID(),
    milestone: randomUUID(),
    sprint: randomUUID(),
    carryover: randomUUID(),
    issue: randomUUID(),
    peer: randomUUID(),
    done: randomUUID(),
    comment: randomUUID(),
    time: randomUUID(),
    view: randomUUID(),
    integration: randomUUID(),
  };
  const commands: Command[] = [
    {
      type: "create_team",
      id: ids.team,
      name: "Team 🦊",
      key: "TEA",
      members: [owner.id, member.id],
      default_stage_ids: ids.stages,
    },
    { type: "create_label", id: ids.label, name: "Label 🦊", color: "#aabbcc" },
    {
      type: "create_project",
      id: ids.project,
      name: "Project",
      description: "Description",
      team_ids: [ids.team],
    },
    {
      type: "create_milestone",
      id: ids.milestone,
      name: "Milestone",
      project_id: ids.project,
      deadline: DATE,
    },
    {
      type: "create_sprint",
      id: ids.sprint,
      team_id: ids.team,
      name: "Sprint",
      goal: "Ship",
      starts_at: DATE,
      ends_at: END,
    },
    {
      type: "create_sprint",
      id: ids.carryover,
      team_id: ids.team,
      name: "Next",
      goal: "Carry",
      starts_at: END,
      ends_at: "2026-11-07T12:00:00.000Z",
    },
    {
      type: "create_issue",
      input: {
        id: ids.issue,
        team_id: ids.team,
        title: "Parent",
        project_id: ids.project,
        milestone_id: ids.milestone,
        sprint_id: ids.sprint,
        estimate: 3,
      },
    },
    {
      type: "create_issue",
      input: {
        id: ids.peer,
        team_id: ids.team,
        title: "Child",
        parent_id: ids.issue,
        labels: [ids.label],
        sprint_id: ids.sprint,
        estimate: 2,
      },
    },
    {
      type: "create_issue",
      input: {
        id: ids.done,
        team_id: ids.team,
        title: "Done",
        stage_id: ids.stages[3],
        sprint_id: ids.sprint,
        estimate: 5,
      },
    },
    {
      type: "add_comment",
      id: ids.comment,
      issue_id: ids.issue,
      body: "Original",
      mentions: [member.id],
      attachments: [],
    },
    {
      type: "log_time",
      id: ids.time,
      issue_id: ids.issue,
      minutes: 30,
      note: "Original",
      logged_at: DATE,
    },
    {
      type: "save_view",
      id: ids.view,
      name: "Original",
      shared: true,
      filter: { where: [{ field: "team_id", op: "is", values: [ids.team] }] },
    },
    {
      type: "create_integration",
      id: ids.integration,
      name: "Webhook",
      webhook_url: "https://example.test/hook",
      secret: "contract-secret",
    },
  ];
  for (const value of commands) await command(ws, owner, value);
  await command(ws, member, {
    type: "add_comment",
    issue_id: ids.issue,
    body: "Notify owner",
    mentions: [owner.id],
    attachments: [],
  });
  const invitation = await command(ws, owner, {
    type: "invite",
    email: `${randomUUID()}@example.test`,
    role: "member",
    token_hash: "server-generated",
  });
  if (!invitation) throw new Error("missing invitation");
  const page = object(await request(`/internal-api/workspaces/${ws}/notifications`, owner));
  if (!Array.isArray(page.items) || !page.items.length)
    throw new Error("missing notification fixture");
  const notification = {
    id: textField(page.items[0], "id"),
    created_at: textField(page.items[0], "created_at"),
  };
  const upload = async () => {
    const form = new FormData();
    form.append("file", new Blob(["contract upload"], { type: "text/plain" }), "contract.txt");
    const { inject } = await import("vite-plus/test");
    const response = await fetch(
      `${inject("syncContract").baseUrl}/internal-api/workspaces/${ws}/issues/${ids.issue}/attachments`,
      { method: "POST", headers: { Authorization: `Bearer ${owner.token}` }, body: form },
    );
    if (!response.ok) throw new Error(`upload failed ${response.status}: ${await response.text()}`);
    const result: unknown = await response.json();
    const changes = object(result).changes;
    if (!Array.isArray(changes)) throw new Error("missing upload changes");
    const issueChange = changes.find((change) => object(change).entity === "issues");
    const attachments = object(object(issueChange).record).attachments;
    if (!Array.isArray(attachments) || attachments.length !== 1)
      throw new Error("missing uploaded attachment");
    return textField(attachments[0], "id");
  };
  return { ...ids, invitation, notification, owner, member, ws, upload };
}
export type Fixture = Awaited<ReturnType<typeof fixture>>;
export type Scenario = {
  prepare?: (f: Fixture) => Promise<void>;
  command: (f: Fixture) => Command | Promise<Command>;
};

export const scenarios = {
  create_issue: {
    command: (f) => ({
      type: "create_issue",
      input: {
        team_id: f.team,
        title: "New 🦊",
        description: "Details",
        labels: [f.label, f.label],
        parent_id: f.issue,
        dependencies: [f.done],
        assignee: f.member.id,
        project_id: f.project,
        milestone_id: f.milestone,
        sprint_id: f.sprint,
        estimate: 8,
        deadline: "2026-10-12T14:00:00+02:00",
      },
    }),
  },
  update_issue: {
    command: (f) => ({
      type: "update_issue",
      id: f.peer,
      patch: {
        title: "Changed",
        description: `cc [@Member](mention:${f.member.id})`,
        priority: "urgent",
        clear_parent: true,
        dependencies: [f.issue],
        assignee: f.member.id,
        labels: [],
      },
    }),
  },
  move_issue: {
    // Sprint issues start in Todo; moving one to Backlog also takes it out of the sprint.
    command: (f) => ({ type: "move_issue", id: f.peer, stage_id: f.stages[0], before_id: null }),
  },
  bulk_issues: {
    command: (f) => ({
      type: "bulk_issues",
      ids: [f.issue, f.peer, f.issue],
      action: {
        update: { description: `Bulk \`[@Member](mention:${f.member.id})\``, priority: "high" },
      },
    }),
  },
  delete_issue: { command: (f) => ({ type: "delete_issue", id: f.peer }) },
  restore_issue: {
    prepare: async (f) => {
      await command(f.ws, f.owner, { type: "delete_issue", id: f.peer });
    },
    command: (f) => ({ type: "restore_issue", id: f.peer }),
  },
  archive_issue: { command: (f) => ({ type: "archive_issue", id: f.done }) },
  unarchive_issue: {
    prepare: async (f) => {
      await command(f.ws, f.owner, { type: "archive_issue", id: f.done });
    },
    command: (f) => ({ type: "unarchive_issue", id: f.done }),
  },
  follow: {
    command: (f) => ({ type: "follow", issue_id: f.issue, following: false, user_id: f.member.id }),
  },
  add_source_link: {
    command: (f) => ({
      type: "add_source_link",
      issue_id: f.issue,
      title: "Design",
      url: "https://example.test/design",
    }),
  },
  remove_attachment: {
    command: async (f) => ({
      type: "remove_attachment",
      issue_id: f.issue,
      attachment_id: await f.upload(),
    }),
  },
  create_team: {
    command: (f) => ({
      type: "create_team",
      name: "New team",
      key: "NEW",
      members: [f.member.id, f.owner.id, f.member.id],
      default_stage_ids: [],
    }),
  },
  set_team_members: {
    command: (f) => ({ type: "set_team_members", id: f.team, members: [f.member.id] }),
  },
  set_team_archive: {
    command: (f) => ({ type: "set_team_archive", id: f.team, archive_after_days: null }),
  },
  set_team_appearance: {
    command: (f) => ({ type: "set_team_appearance", id: f.team, icon: "rocket", color: "teal" }),
  },
  update_team: {
    command: (f) => ({ type: "update_team", id: f.team, name: "Platform", key: "PLAT" }),
  },
  create_stage: {
    command: (f) => ({
      type: "create_stage",
      team_id: f.team,
      name: "Review",
      kind: "active",
      position: 2,
    }),
  },
  update_stage: {
    command: (f) => ({
      type: "update_stage",
      team_id: f.team,
      id: f.stages[1],
      name: "Delivered",
      kind: "done",
      position: 6,
    }),
  },
  delete_stage: {
    command: (f) => ({
      type: "delete_stage",
      team_id: f.team,
      id: f.stages[1],
      replacement: f.stages[0],
    }),
  },
  create_label: {
    command: () => ({ type: "create_label", name: "New label 🦊", color: "#123456" }),
  },
  update_label: {
    command: (f) => ({ type: "update_label", id: f.label, name: "Renamed", color: "blue" }),
  },
  delete_label: { command: (f) => ({ type: "delete_label", id: f.label }) },
  create_project: {
    command: (f) => ({
      type: "create_project",
      name: "New project",
      description: "Markdown **bold**",
      team_ids: [f.team, f.team],
    }),
  },
  update_project: {
    command: (f) => ({
      type: "update_project",
      id: f.project,
      name: "Renamed",
      description: "Changed",
      team_ids: [f.team],
    }),
  },
  delete_project: { command: (f) => ({ type: "delete_project", id: f.project }) },
  set_project_plan: {
    command: (f) => ({
      type: "set_project_plan",
      id: f.project,
      lead_id: f.member.id,
      status: "in_progress",
      health: "at_risk",
      start_date: "2026-11-02",
      target_date: "2026-12-18",
    }),
  },
  create_milestone: {
    command: (f) => ({
      type: "create_milestone",
      project_id: f.project,
      name: "New milestone",
      deadline: "2026-10-12T14:00:00+02:00",
    }),
  },
  update_milestone: {
    command: (f) => ({
      type: "update_milestone",
      id: f.milestone,
      name: "Renamed",
      deadline: null,
    }),
  },
  delete_milestone: { command: (f) => ({ type: "delete_milestone", id: f.milestone }) },
  create_sprint: {
    command: (f) => ({
      type: "create_sprint",
      team_id: f.team,
      name: "New sprint",
      goal: "Goal 🦊",
      starts_at: DATE,
      ends_at: END,
    }),
  },
  update_sprint: {
    command: (f) => ({
      type: "update_sprint",
      id: f.sprint,
      name: "Running",
      goal: "Changed",
      starts_at: DATE,
      ends_at: END,
      state: "active",
    }),
  },
  complete_sprint: {
    command: (f) => ({ type: "complete_sprint", id: f.sprint, carryover_sprint_id: f.carryover }),
  },
  archive_sprint: {
    prepare: async (f) => {
      await command(f.ws, f.owner, {
        type: "complete_sprint",
        id: f.sprint,
        carryover_sprint_id: f.carryover,
      });
    },
    command: (f) => ({ type: "archive_sprint", id: f.sprint }),
  },
  add_comment: {
    command: async (f) => {
      const id = await f.upload();
      return {
        type: "add_comment",
        issue_id: f.issue,
        body: "Reply 🦊",
        mentions: [f.member.id, f.member.id],
        attachments: [{ id, name: "ignored", content_type: "text/plain", size: 1 }],
      };
    },
  },
  edit_comment: {
    command: (f) => ({ type: "edit_comment", id: f.comment, body: "Edited 🦊", mentions: [] }),
  },
  delete_comment: { command: (f) => ({ type: "delete_comment", id: f.comment }) },
  log_time: {
    command: (f) => ({
      type: "log_time",
      issue_id: f.issue,
      minutes: 75,
      note: "Investigation 🦊",
      logged_at: "2026-10-12T14:00:00+02:00",
    }),
  },
  update_time: {
    command: (f) => ({
      type: "update_time",
      id: f.time,
      minutes: 45,
      note: "Corrected",
      logged_at: DATE,
    }),
  },
  delete_time: { command: (f) => ({ type: "delete_time", id: f.time }) },
  save_view: {
    command: (f) => ({
      type: "save_view",
      name: "Private",
      shared: false,
      filter: {
        where: [
          { field: "team_id", op: "is", values: [f.team] },
          { field: "labels", op: "is", values: [f.label, null] },
          { field: "deadline", op: "lte", values: ["+7d"] },
          { field: "created_at", op: "gte", values: [DATE] },
        ],
      },
    }),
  },
  update_view: {
    command: (f) => ({
      type: "update_view",
      id: f.view,
      name: "Private now",
      shared: false,
      filter: {
        where: [{ field: "priority", op: "gte", values: ["high"] }],
        archived: true,
      },
    }),
  },
  delete_view: { command: (f) => ({ type: "delete_view", id: f.view }) },
  cancel_invitation: { command: (f) => ({ type: "cancel_invitation", id: f.invitation }) },
  mark_notification_read: {
    command: (f) => ({ type: "mark_notification_read", ...f.notification }),
  },
  mark_notification_unread: {
    prepare: async (f) => {
      await command(f.ws, f.owner, { type: "mark_notification_read", ...f.notification });
    },
    command: (f) => ({ type: "mark_notification_unread", id: f.notification.id }),
  },
  mark_all_notifications_read: {
    command: (f) => ({ type: "mark_all_notifications_read", notifications: [f.notification] }),
  },
  configure_alerts: {
    command: () => ({
      type: "configure_alerts",
      assignment: false,
      reply: true,
      change: false,
      mention: true,
      deadline: false,
      email_assignment: false,
      email_reply: true,
      email_change: true,
      email_mention: false,
      email_deadline: true,
    }),
  },
  update_integration: {
    command: (f) => ({ type: "update_integration", id: f.integration, enabled: false }),
  },
  delete_integration: { command: (f) => ({ type: "delete_integration", id: f.integration }) },
} satisfies Record<MutatorName, Scenario>;

export function scenario(name: MutatorName): Scenario {
  return scenarios[name];
}

export function teamMove({ blocked = false } = {}): Scenario {
  const team = randomUUID();
  return {
    prepare: async (f) => {
      if (blocked) {
        await command(f.ws, f.owner, {
          type: "update_issue",
          id: f.issue,
          patch: { stage_id: f.stages[2], dependencies: [f.done] },
        });
        await command(f.ws, f.owner, {
          type: "move_issue",
          id: f.done,
          stage_id: f.stages[1],
          before_id: null,
        });
      }
      await command(f.ws, f.owner, {
        type: "create_team",
        id: team,
        name: "Other",
        key: "OTH",
        members: [f.owner.id],
      });
      await command(f.ws, f.owner, {
        type: "create_issue",
        input: { team_id: team, title: "Already there" },
      });
    },
    command: (f) => ({ type: "update_issue", id: f.issue, patch: { team_id: team } }),
  };
}

/** Each issue keeps the labels the bulk edit doesn't name. */
export function bulkLabels(): Scenario {
  const [kept, added] = [randomUUID(), randomUUID()];
  return {
    prepare: async (f) => {
      for (const [id, name] of [
        [kept, "Kept"],
        [added, "Added"],
      ])
        await command(f.ws, f.owner, { type: "create_label", id, name, color: "#aabbcc" });
      await command(f.ws, f.owner, {
        type: "update_issue",
        id: f.issue,
        patch: { labels: [kept] },
      });
    },
    command: (f) => ({
      type: "bulk_issues",
      ids: [f.issue, f.peer],
      action: { update: { labels: { add: [added], remove: [f.label] } } },
    }),
  };
}
