import { queryOptions } from "@tanstack/react-query";
import { api } from "./api";
import { keys } from "./query-client";
import type { Id, Issue, OpenProjectConnection, OpenProjectConnectionInput } from "./types";

const base = (ws: Id) => `/api/workspaces/${ws}/openproject/connections`;

export const openproject = {
  list: (ws: Id) => api<{ connections: OpenProjectConnection[] }>(base(ws)),
  create: (ws: Id, body: OpenProjectConnectionInput) =>
    api<OpenProjectConnection>(base(ws), { method: "POST", body }),
  update: (ws: Id, id: Id, body: Partial<OpenProjectConnectionInput>) =>
    api<OpenProjectConnection>(`${base(ws)}/${id}`, { method: "PATCH", body }),
  remove: (ws: Id, id: Id) => api<null>(`${base(ws)}/${id}`, { method: "DELETE" }),
  refresh: (ws: Id, id: Id) =>
    api<{ queued: boolean }>(`${base(ws)}/${id}/refresh`, { method: "POST" }),
  sync: (ws: Id, id: Id) => api<{ queued: boolean }>(`${base(ws)}/${id}/sync`, { method: "POST" }),
};

export const openprojectKey = (ws: Id) => [...keys.all(ws), "openproject"] as const;

// This endpoint reads Blackwall's cache. Only explicit actions enqueue remote work.
export const openprojectQuery = (ws: Id) =>
  queryOptions({
    queryKey: openprojectKey(ws),
    queryFn: () => openproject.list(ws),
    refetchInterval: 5_000,
  });

export function isImportedIssue(issue: Pick<Issue, "openproject">) {
  return issue.openproject != null;
}

export function openprojectIssueUrl(issue: Pick<Issue, "openproject">) {
  const value = issue.openproject?.url;
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}
