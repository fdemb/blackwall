import type {
  Command, Issue, IssueFilter, MemberProfile, Profile, Report, WorkspaceSummary, Workspace,
} from "./types";

export interface SearchResult { issues: Issue[]; people: MemberProfile[] }

export class ApiError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

let csrf = typeof sessionStorage === "undefined" ? "" : (sessionStorage.getItem("bw-csrf") ?? "");
export function setCsrf(token: string) {
  csrf = token;
  sessionStorage.setItem("bw-csrf", token);
}

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const method = init.method ?? "GET";
  const headers: Record<string, string> = {};
  const isForm = init.body instanceof FormData;
  if (method !== "GET") headers["X-CSRF-Token"] = csrf;
  if (init.body !== undefined && !isForm) headers["Content-Type"] = "application/json";
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    headers,
    body: init.body === undefined ? undefined : isForm ? (init.body as FormData) : JSON.stringify(init.body),
  });
  const token = response.headers.get("X-CSRF-Token");
  if (token) setCsrf(token);
  const text = response.status === 204 ? "" : await response.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!response.ok) {
    const body = data as { error?: string } | null;
    throw new ApiError(body?.error ?? response.statusText, response.status);
  }
  return data as T;
}


export const auth = {
  me: () => api<Profile>("/api/me"),
  login: (email: string, password: string) =>
    api<{ csrf_token: string; profile: Profile }>("/api/auth/login", { method: "POST", body: { email, password } }),
  register: (email: string, password: string, display_name: string) =>
    api<{ csrf_token: string; profile: Profile }>("/api/auth/register", {
      method: "POST",
      body: { email, password, display_name },
    }),
  logout: () => api<null>("/api/auth/logout", { method: "POST" }),
  requestReset: (email: string) => api<null>("/api/auth/reset-request", { method: "POST", body: { email } }),
  reset: (token: string, password: string) => api<null>("/api/auth/reset", { method: "POST", body: { token, password } }),
  changePassword: (current_password: string, new_password: string) =>
    api<null>("/api/auth/password", { method: "POST", body: { current_password, new_password } }),
  editProfile: (profile: Omit<Profile, "id" | "email">) => api<Profile>("/api/me", { method: "PATCH", body: profile }),
};

export const workspaces = {
  list: () => api<WorkspaceSummary[]>("/api/workspaces"),
  create: (name: string) =>
    api<{ revision: number; workspace: Workspace }>("/api/workspaces", { method: "POST", body: { name } }),
  get: (id: string) => api<{ revision: number; workspace: Workspace }>(`/api/workspaces/${id}`),
  members: (id: string) => api<MemberProfile[]>(`/api/workspaces/${id}/members`),
  command: (id: string, revision: number, command: Command) =>
    api<{ revision: number; result: { id: string | null } }>(`/api/workspaces/${id}/commands`, {
      method: "POST",
      body: { revision, command },
    }),
  search: (id: string, q: string) => api<SearchResult>(`/api/workspaces/${id}/search?q=${encodeURIComponent(q)}`),
  report: (id: string) => api<Report>(`/api/workspaces/${id}/report`),
  accept: (id: string, token: string) =>
    api<{ revision: number; workspace: Workspace }>(`/api/workspaces/${id}/invitations/accept`, {
      method: "POST",
      body: { token },
    }),
  export: (id: string) => api<unknown>(`/api/workspaces/${id}/export`),
  import: (id: string, revision: number, body: { issues?: unknown[]; transfer?: unknown }) =>
    api<{ revision: number; summary: unknown }>(`/api/workspaces/${id}/import`, {
      method: "POST",
      body: { revision, ...body },
    }),
  upload: (id: string, issueId: string, revision: number, file: File, commentId?: string) => {
    const form = new FormData();
    form.append("revision", String(revision));
    if (commentId) form.append("comment_id", commentId);
    form.append("file", file);
    return api<{ revision: number }>(`/api/workspaces/${id}/issues/${issueId}/attachments`, {
      method: "POST",
      body: form,
    });
  },
};

export function markdown(text: string) {
  return api<{ html: string }>("/api/markdown", { method: "POST", body: { text } }).then((r) => r.html);
}

export function filterQuery(filter: IssueFilter) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(filter)) if (v !== undefined && v !== "" && v !== false) params.set(k, String(v));
  return params.toString();
}
