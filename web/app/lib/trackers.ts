import { queryOptions } from "@tanstack/react-query";
import { api } from "./api";
import { keys } from "./query-client";
import type { Key } from "./i18n";
import type {
  Id,
  Issue,
  Stage,
  StageKind,
  TrackerConnection,
  TrackerConnectionInput,
  TrackerProvider,
  TrackerProviderKind,
  TrackerStatus,
} from "./types";

const base = (ws: Id) => `/api/workspaces/${ws}/trackers`;
const connections = (ws: Id) => `${base(ws)}/connections`;

export const trackerApi = {
  providers: (ws: Id) => api<TrackerProvider[]>(`${base(ws)}/providers`),
  list: (ws: Id) => api<{ connections: TrackerConnection[] }>(connections(ws)),
  create: (ws: Id, body: TrackerConnectionInput) =>
    api<TrackerConnection>(connections(ws), { method: "POST", body }),
  update: (ws: Id, id: Id, body: Partial<TrackerConnectionInput>) =>
    api<TrackerConnection>(`${connections(ws)}/${id}`, { method: "PATCH", body }),
  remove: (ws: Id, id: Id) => api<null>(`${connections(ws)}/${id}`, { method: "DELETE" }),
  refresh: (ws: Id, id: Id) =>
    api<{ queued: boolean }>(`${connections(ws)}/${id}/refresh`, { method: "POST" }),
  sync: (ws: Id, id: Id) =>
    api<{ queued: boolean }>(`${connections(ws)}/${id}/sync`, { method: "POST" }),
};

export const trackerKey = (ws: Id) => [...keys.all(ws), "trackers"] as const;

// This endpoint reads Blackwall's cache. Only explicit actions enqueue remote work.
export const trackerQuery = (ws: Id) =>
  queryOptions({
    queryKey: trackerKey(ws),
    queryFn: () => trackerApi.list(ws),
    refetchInterval: 5_000,
  });

export const trackerProvidersQuery = (ws: Id) =>
  queryOptions({
    queryKey: [...trackerKey(ws), "providers"] as const,
    queryFn: () => trackerApi.providers(ws),
    staleTime: Infinity,
  });

/**
 * Provider text the UI needs. The server descriptor says what a provider supports; this only names it.
 * A new provider adds one entry here.
 */
export const trackerProviders: Record<
  TrackerProviderKind,
  { name: string; url: Key; urlHint: Key; token: Key; tokenHint: Key }
> = {
  openproject: {
    name: "OpenProject",
    url: "tracker.openproject.url",
    urlHint: "tracker.openproject.urlHint",
    token: "tracker.openproject.token",
    tokenHint: "tracker.openproject.tokenHint",
  },
};

/** Display name for a provider kind, including kinds this build does not know yet. */
export function trackerProviderName(kind: string) {
  return Object.hasOwn(trackerProviders, kind)
    ? trackerProviders[kind as TrackerProviderKind].name
    : kind;
}

/** The last outbound push failure, if the server reported one. */
export function trackerPushError(issue: Pick<Issue, "tracker">) {
  const error = issue.tracker?.push_error;
  return typeof error === "string" && error.trim() ? error.trim() : null;
}

export function trackerIssueUrl(issue: Pick<Issue, "tracker">) {
  const value = issue.tracker?.url;
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

export function automaticTrackerStage(status: TrackerStatus, stages: Stage[]) {
  const ordered = [...stages].sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
  return (
    ordered.find((stage) => stage.name.toLowerCase() === status.name.toLowerCase()) ??
    ordered.find((stage) => stage.kind === (status.is_closed ? "done" : "backlog")) ??
    ordered[0]
  );
}

export function migratedTrackerStageKind(status: TrackerStatus): StageKind {
  if (status.is_closed) return "done";
  return ["new", "open", "backlog"].includes(status.name.trim().toLowerCase())
    ? "backlog"
    : "active";
}
