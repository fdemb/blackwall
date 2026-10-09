import { safeGet, safeSet } from "./storage";
import type {
  ImportSummary,
  Profile,
  Report,
  WorkspaceSummary,
  CommandResult,
  EntityVersions,
} from "./types";

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

const CSRF_KEY = "bw-csrf:v1";
let csrf = safeGet("session", CSRF_KEY) ?? "";
export function getCsrf(): string {
  return csrf;
}
export function setCsrf(token: string) {
  csrf = token;
  safeSet("session", CSRF_KEY, token);
}

export async function api<T>(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const method = init.method ?? "GET";
  const headers: Record<string, string> = {};
  const form = init.body instanceof FormData ? init.body : undefined;
  const isForm = form !== undefined;
  if (method !== "GET") headers["X-CSRF-Token"] = csrf;
  if (init.body !== undefined && !isForm) headers["Content-Type"] = "application/json";
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    headers,
    body: init.body === undefined ? undefined : isForm ? form : JSON.stringify(init.body),
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
    const message =
      data !== null && typeof data === "object" && "error" in data && typeof data.error === "string"
        ? data.error
        : response.statusText;
    throw new ApiError(message, response.status);
  }
  return data as T;
}

export const auth = {
  me: () => api<Profile & { session_id: string }>("/api/me"),
  login: (email: string, password: string) =>
    api<{ csrf_token: string; profile: Profile }>("/api/auth/login", {
      method: "POST",
      body: { email, password },
    }),
  register: (email: string, password: string, display_name: string) =>
    api<{ csrf_token: string; profile: Profile }>("/api/auth/register", {
      method: "POST",
      body: { email, password, display_name },
    }),
  logout: () => api<null>("/api/auth/logout", { method: "POST" }),
  requestReset: (email: string) =>
    api<null>("/api/auth/reset-request", { method: "POST", body: { email } }),
  reset: (token: string, password: string) =>
    api<null>("/api/auth/reset", { method: "POST", body: { token, password } }),
  changePassword: (current_password: string, new_password: string) =>
    api<null>("/api/auth/password", { method: "POST", body: { current_password, new_password } }),
  editProfile: (profile: Omit<Profile, "id" | "email">) =>
    api<Profile>("/api/me", { method: "PATCH", body: profile }),
};

export const workspaces = {
  list: () => api<WorkspaceSummary[]>("/api/workspaces"),
  create: (name: string, idempotency_key: string = crypto.randomUUID()) =>
    api<{ workspace: WorkspaceSummary }>("/api/workspaces", {
      method: "POST",
      body: { name, idempotency_key },
    }),
  report: (id: string) => api<Report>(`/api/workspaces/${id}/report`),
  accept: (id: string, token: string) =>
    api<{ workspace: WorkspaceSummary }>(`/api/workspaces/${id}/invitations/accept`, {
      method: "POST",
      body: { token },
    }),
  export: (id: string) => api<unknown>(`/api/workspaces/${id}/export`),
  import: (
    id: string,
    body: { issues?: unknown[]; transfer?: unknown },
    idempotency_key: string = crypto.randomUUID(),
  ) =>
    api<{ versions: EntityVersions; summary: ImportSummary | null }>(
      `/api/workspaces/${id}/import`,
      {
        method: "POST",
        body: { expected_versions: {}, idempotency_key, ...body },
      },
    ),
  upload: (
    id: string,
    issueId: string,
    expected_versions: EntityVersions | undefined,
    file: File,
    commentId?: string,
    idempotency_key: string = crypto.randomUUID(),
  ) => {
    const form = new FormData();
    if (expected_versions !== undefined)
      form.append("expected_versions", JSON.stringify(expected_versions));
    form.append("idempotency_key", idempotency_key);
    if (commentId) form.append("comment_id", commentId);
    form.append("file", file);
    return api<CommandResult>(`/api/workspaces/${id}/issues/${issueId}/attachments`, {
      method: "POST",
      body: form,
    });
  },
};

export function markdown(text: string) {
  return api<{ html: string }>("/api/markdown", { method: "POST", body: { text } }).then(
    (r) => r.html,
  );
}
