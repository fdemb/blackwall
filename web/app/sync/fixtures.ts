import type { Team } from "../lib/types";
import type { SyncIssue } from "./records";
import type { DeepReadonly, PendingMutation, Tx } from "./store";

export const NOW = "2026-10-08T12:00:00.000Z";

export function makeTeam(id = "team-1"): Team {
  return {
    id,
    version: 1,
    name: "Team",
    key: "TEAM",
    members: [],
    stages: [
      { id: "stage-todo", version: 1, name: "Todo", kind: "active", position: 0 },
      { id: "stage-done", version: 1, name: "Done", kind: "done", position: 1 },
    ],
    archive_after_days: 30,
    icon: "users",
    color: "violet",
  };
}

export function makeIssue(id: string, overrides: Partial<SyncIssue> = {}): SyncIssue {
  return {
    id,
    version: 1,
    number: 1,
    title: `Issue ${id}`,
    description: "",
    team_id: "team-1",
    stage_id: "stage-todo",
    assignee: null,
    created_by: null,
    priority: "normal",
    labels: [],
    estimate: null,
    deadline: null,
    project_id: null,
    milestone_id: null,
    sprint_id: null,
    parent_id: null,
    dependencies: [],
    position: 0,
    followers: [],
    attachments: [],
    source_links: [],
    deleted_at: null,
    archived_at: null,
    done_at: null,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

/** Hand-written replay for tests: a rename, an append proving read-your-writes, a delete, a thrower. */
export function testReplay(tx: Tx, mutation: DeepReadonly<PendingMutation>): void {
  const args = mutation.args as { id: string; title: string; suffix: string };
  if (mutation.name === "set_title") {
    const issue = tx.get("issues", args.id);
    if (issue === undefined) throw new Error(`missing issue ${args.id}`);
    tx.put("issues", { ...issue, title: args.title, updated_at: mutation.at });
  } else if (mutation.name === "append_title") {
    const issue = tx.get("issues", args.id);
    if (issue === undefined) throw new Error(`missing issue ${args.id}`);
    tx.put("issues", { ...issue, title: `${issue.title}${args.suffix}`, updated_at: mutation.at });
  } else if (mutation.name === "delete_issue") {
    tx.delete("issues", args.id);
  } else if (mutation.name === "boom") {
    throw new Error("boom");
  } else {
    throw new Error(`unknown mutation ${mutation.name}`);
  }
}
