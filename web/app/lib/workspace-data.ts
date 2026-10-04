import { collectPages, workspaces } from "./api";
import type { MemberProfile, Report, Workspace } from "./types";

export interface WorkspaceData {
  workspace: Workspace;
  members: MemberProfile[];
  report: Report;
}

export async function loadWorkspaceData(id: string): Promise<WorkspaceData> {
  const all = <K extends Parameters<typeof workspaces.resource>[1]>(resource: K) =>
    collectPages((offset) => workspaces.resource(id, resource, { offset }));
  const [
    metadata,
    members,
    teams,
    labels,
    projects,
    milestones,
    sprints,
    views,
    invitations,
    alert_preferences,
    integrations,
    report,
  ] = await Promise.all([
    workspaces.get(id),
    workspaces.members(id),
    all("teams"),
    all("labels"),
    all("projects"),
    all("milestones"),
    all("sprints"),
    all("views"),
    all("invitations"),
    all("alert_preferences"),
    all("integrations"),
    workspaces.report(id),
  ]);
  return {
    members,
    report,
    workspace: {
      id: metadata.workspace.id,
      name: metadata.workspace.name,
      members: members.map((member) => ({
        user_id: member.id,
        role: member.role,
        version: member.version,
      })),
      teams,
      labels,
      projects,
      milestones,
      sprints,
      views,
      invitations,
      alert_preferences,
      integrations,
      notifications: [],
      issues: [],
      comments: [],
      time_entries: [],
      activity: [],
    },
  };
}
