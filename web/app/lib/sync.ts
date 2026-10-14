import { queryOptions } from "@tanstack/react-query";
import { api } from "./api";
import { keys } from "./query-client";
import type { Key } from "./i18n";
import type {
  Id,
  Issue,
  Stage,
  StageKind,
  SyncConnection,
  SyncConnectionInput,
  SyncProvider,
  SyncProviderKind,
  SyncStatus,
} from "./types";

const base = (ws: Id) => `/api/workspaces/${ws}/sync`;
const connections = (ws: Id) => `${base(ws)}/connections`;

export const syncApi = {
  providers: (ws: Id) => api<SyncProvider[]>(`${base(ws)}/providers`),
  list: (ws: Id) => api<{ connections: SyncConnection[] }>(connections(ws)),
  create: (ws: Id, body: SyncConnectionInput) =>
    api<SyncConnection>(connections(ws), { method: "POST", body }),
  update: (ws: Id, id: Id, body: Partial<SyncConnectionInput>) =>
    api<SyncConnection>(`${connections(ws)}/${id}`, { method: "PATCH", body }),
  remove: (ws: Id, id: Id) => api<null>(`${connections(ws)}/${id}`, { method: "DELETE" }),
  refresh: (ws: Id, id: Id) =>
    api<{ queued: boolean }>(`${connections(ws)}/${id}/refresh`, { method: "POST" }),
  sync: (ws: Id, id: Id) =>
    api<{ queued: boolean }>(`${connections(ws)}/${id}/sync`, { method: "POST" }),
};

export const syncKey = (ws: Id) => [...keys.all(ws), "sync"] as const;

// This endpoint reads Blackwall's cache. Only explicit actions enqueue remote work.
export const syncQuery = (ws: Id) =>
  queryOptions({
    queryKey: syncKey(ws),
    queryFn: () => syncApi.list(ws),
    refetchInterval: 5_000,
  });

export const syncProvidersQuery = (ws: Id) =>
  queryOptions({
    queryKey: [...syncKey(ws), "providers"] as const,
    queryFn: () => syncApi.providers(ws),
    staleTime: Infinity,
  });

/**
 * Provider text the UI needs. The server descriptor says what a provider supports; this only names it.
 * A new provider adds one entry here.
 */
export const syncProviders: Record<
  SyncProviderKind,
  { name: string; url: Key; urlHint: Key; token: Key; tokenHint: Key }
> = {
  openproject: {
    name: "OpenProject",
    url: "sync.openproject.url",
    urlHint: "sync.openproject.urlHint",
    token: "sync.openproject.token",
    tokenHint: "sync.openproject.tokenHint",
  },
};

/** Display name for a provider kind, including kinds this build does not know yet. */
export function syncProviderName(kind: string) {
  return Object.hasOwn(syncProviders, kind) ? syncProviders[kind as SyncProviderKind].name : kind;
}

/** The last outbound push failure, if the server reported one. */
export function syncPushError(issue: Pick<Issue, "sync">) {
  const error = issue.sync?.push_error;
  return typeof error === "string" && error.trim() ? error.trim() : null;
}

export function syncIssueUrl(issue: Pick<Issue, "sync">) {
  const value = issue.sync?.url;
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

export function automaticSyncStage(status: SyncStatus, stages: Stage[]) {
  const ordered = [...stages].sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
  return (
    ordered.find((stage) => stage.name.toLowerCase() === status.name.toLowerCase()) ??
    ordered.find((stage) => stage.kind === (status.is_closed ? "done" : "backlog")) ??
    ordered[0]
  );
}

export function migratedSyncStageKind(status: SyncStatus): StageKind {
  if (status.is_closed) return "done";
  return ["new", "open", "backlog"].includes(status.name.trim().toLowerCase())
    ? "backlog"
    : "active";
}
