import {
  BasicIndex,
  createCollection,
  extractSimpleComparisons,
  type LoadSubsetOptions,
} from "@tanstack/react-db";
import { queryCollectionOptions } from "@tanstack/query-db-collection";
import type { QueryClient } from "@tanstack/react-query";
import { collectPages, workspaces } from "./api";
import { keys, reportQuery, workspaceQuery } from "./query-client";
import type {
  Activity,
  AlertPrefsWs,
  Comment,
  Id,
  Integration,
  Invitation,
  Issue,
  Label,
  MemberProfile,
  Milestone,
  Notification,
  Project,
  SavedView,
  Sprint,
  Team,
  TimeEntry,
} from "./types";

/**
 * Where collections read from. Tests swap in records; the app reads the HTTP API.
 * Scoped readers get the issue or entity a live query asked for, or nothing for all records.
 */
export interface Source {
  teams: () => Promise<Team[]>;
  labels: () => Promise<Label[]>;
  projects: () => Promise<Project[]>;
  milestones: () => Promise<Milestone[]>;
  sprints: () => Promise<Sprint[]>;
  views: () => Promise<SavedView[]>;
  invitations: () => Promise<Invitation[]>;
  alert_preferences: () => Promise<AlertPrefsWs[]>;
  integrations: () => Promise<Integration[]>;
  notifications: () => Promise<Notification[]>;
  members: () => Promise<MemberProfile[]>;
  issues: () => Promise<Issue[]>;
  comments: (issueId?: Id) => Promise<Comment[]>;
  time_entries: (issueId?: Id) => Promise<TimeEntry[]>;
  activity: (entityId?: Id) => Promise<Activity[]>;
}

export function httpSource(ws: Id): Source {
  const all = <K extends Parameters<typeof workspaces.resource>[1]>(
    kind: K,
    params: Record<string, string> = {},
  ) => collectPages((offset) => workspaces.resource(ws, kind, { ...params, offset }));
  const issues = (trash: boolean) =>
    collectPages((offset) => workspaces.issues(ws, { trash }, offset, 200));
  return {
    teams: () => all("teams"),
    labels: () => all("labels"),
    projects: () => all("projects"),
    milestones: () => all("milestones"),
    sprints: () => all("sprints"),
    views: () => all("views"),
    invitations: () => all("invitations"),
    alert_preferences: () => all("alert_preferences"),
    integrations: () => all("integrations"),
    notifications: () => all("notifications"),
    members: () => workspaces.members(ws),
    // Trash lives in the same collection, so restoring is just another update.
    issues: async () => (await Promise.all([issues(false), issues(true)])).flat(),
    comments: (id) => all("comments", id ? { issue_id: id } : {}),
    time_entries: (id) => all("time_entries", id ? { issue_id: id } : {}),
    activity: (id) => all("activity", id ? { entity_id: id } : {}),
  };
}

const ISSUE_DATES = ["deadline", "created_at", "updated_at", "deleted_at"] as const;

/**
 * Postgres formats timestamps with an offset. Live queries compare and sort them as text,
 * so every timestamp is stored in one UTC format.
 */
export function normalizeIssue(issue: Issue): Issue {
  const copy = { ...issue };
  for (const field of ISSUE_DATES) {
    const value = copy[field];
    if (value) (copy as Record<string, unknown>)[field] = new Date(value).toISOString();
  }
  return copy;
}

const byId = (record: { id: Id }) => record.id;

/** The id a scoped live query filters on, such as `eq(comment.issue_id, id)`. */
function scopeOf(options: LoadSubsetOptions | undefined, field: string): Id | undefined {
  const match = extractSimpleComparisons(options?.where).find(
    (c) => c.operator === "eq" && c.field.at(-1) === field,
  );
  return typeof match?.value === "string" ? match.value : undefined;
}

function createWorkspaceDb(ws: Id, client: QueryClient, source: Source) {
  const eager = <T extends object>(
    kind: string,
    read: () => Promise<T[]>,
    getKey: (record: T) => Id,
    indexed = false,
  ) =>
    createCollection(
      queryCollectionOptions({
        id: `${ws}:${kind}`,
        queryKey: keys.db(ws, kind),
        queryFn: read,
        queryClient: client,
        getKey,
        // Large collections index each field a live query filters on, the first time it does.
        ...(indexed ? { autoIndex: "eager" as const, defaultIndexType: BasicIndex } : {}),
      }),
    );
  // Discussion loads per issue, when a live query asks for it.
  const scoped = <T extends { id: Id }>(
    kind: string,
    field: string,
    read: (scope?: Id) => Promise<T[]>,
  ) =>
    createCollection(
      queryCollectionOptions({
        id: `${ws}:${kind}`,
        queryKey: keys.db(ws, kind),
        syncMode: "on-demand",
        queryFn: (ctx) =>
          read(scopeOf(ctx.meta?.loadSubsetOptions as LoadSubsetOptions | undefined, field)),
        queryClient: client,
        getKey: byId,
      }),
    );

  return {
    id: ws,
    teams: eager("teams", source.teams, byId),
    labels: eager("labels", source.labels, byId),
    projects: eager("projects", source.projects, byId),
    milestones: eager("milestones", source.milestones, byId),
    sprints: eager("sprints", source.sprints, byId),
    views: eager("views", source.views, byId),
    invitations: eager("invitations", source.invitations, byId),
    alert_preferences: eager("alert_preferences", source.alert_preferences, (p) => p.user_id),
    integrations: eager("integrations", source.integrations, byId),
    notifications: eager("notifications", source.notifications, byId),
    members: eager("members", source.members, byId),
    issues: eager("issues", async () => (await source.issues()).map(normalizeIssue), byId, true),
    comments: scoped("comments", "issue_id", source.comments),
    time_entries: scoped("time_entries", "issue_id", source.time_entries),
    activity: scoped("activity", "entity_id", source.activity),
  };
}

export type WorkspaceDb = ReturnType<typeof createWorkspaceDb>;
/** Change-feed entities that have a collection of their own. */
export type Entity = Exclude<keyof WorkspaceDb, "id">;
export const ENTITIES = [
  "teams",
  "labels",
  "projects",
  "milestones",
  "sprints",
  "views",
  "invitations",
  "alert_preferences",
  "integrations",
  "notifications",
  "members",
  "issues",
  "comments",
  "time_entries",
  "activity",
] as const satisfies Entity[];
const EAGER = ENTITIES.filter((e) => !["comments", "time_entries", "activity"].includes(e));

let current: { client: QueryClient; db: WorkspaceDb } | undefined;

/**
 * The open workspace's collections. Opening another workspace cleans up the previous one,
 * so only one workspace keeps syncing.
 */
export function workspaceDb(ws: Id, client: QueryClient, source: Source = httpSource(ws)) {
  if (current?.db.id === ws && current.client === client) return current.db;
  if (current) for (const entity of ENTITIES) void current.db[entity].cleanup();
  current = { client, db: createWorkspaceDb(ws, client, source) };
  return current.db;
}

/** Loads everything the workspace shell renders, before it renders. */
export async function preloadWorkspace(client: QueryClient, ws: Id) {
  const db = workspaceDb(ws, client);
  await Promise.all([
    client.ensureQueryData(workspaceQuery(ws)),
    client.ensureQueryData(reportQuery(ws)),
    ...EAGER.map((entity) => db[entity].preload()),
  ]);
  return db;
}
