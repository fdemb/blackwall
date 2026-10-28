import { safeGet, safeSet } from "./storage";
import type {
  ApiToken,
  SessionInfo,
  ImportSummary,
  Usage,
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

export type AuthOptions = {
  registration: "open" | "invite";
  /** Whether unverified accounts must verify their email address before signing in. */
  email_verification: boolean;
};

/** A pending invitation to the registering address. */
export type Invitation = { workspace_id: string; token: string };

type SignedIn = { csrf_token: string; profile: Profile };

export const auth = {
  me: () => api<Profile & { session_id: string }>("/internal-api/me"),
  /** Accounts with two-factor sign-in get a pending token for `loginTotp` instead of a session. */
  login: (email: string, password: string) =>
    api<SignedIn | { pending_token: string }>("/internal-api/auth/login", {
      method: "POST",
      body: { email, password },
    }),
  /** `code` is a six-digit authenticator code or a recovery code. */
  loginTotp: (pending_token: string, code: string) =>
    api<SignedIn>("/internal-api/auth/login/totp", {
      method: "POST",
      body: { pending_token, code },
    }),
  options: () => api<AuthOptions>("/internal-api/auth/options"),
  register: (email: string, password: string, display_name: string, invitation?: Invitation) =>
    api<{ csrf_token: string; profile: Profile } | { verification_sent: true }>(
      "/internal-api/auth/register",
      { method: "POST", body: { email, password, display_name, invitation } },
    ),
  verify: (token: string) =>
    api<null>("/internal-api/auth/verify", { method: "POST", body: { token } }),
  logout: () => api<null>("/internal-api/auth/logout", { method: "POST" }),
  requestReset: (email: string) =>
    api<null>("/internal-api/auth/reset-request", { method: "POST", body: { email } }),
  reset: (token: string, password: string) =>
    api<null>("/internal-api/auth/reset", { method: "POST", body: { token, password } }),
  changePassword: (current_password: string, new_password: string) =>
    api<null>("/internal-api/auth/password", {
      method: "POST",
      body: { current_password, new_password },
    }),
  editProfile: (profile: Omit<Profile, "id" | "email">) =>
    api<Profile>("/internal-api/me", { method: "PATCH", body: profile }),
};

export const totp = {
  status: () => api<{ enabled: boolean; recovery_codes_left: number }>("/internal-api/auth/totp"),
  setup: () =>
    api<{ secret: string; uri: string; qr_svg: string }>("/internal-api/auth/totp/setup", {
      method: "POST",
    }),
  enable: (password: string, code: string) =>
    api<{ codes: string[] }>("/internal-api/auth/totp/enable", {
      method: "POST",
      body: { password, code },
    }),
  disable: (password: string, code: string) =>
    api<null>("/internal-api/auth/totp/disable", { method: "POST", body: { password, code } }),
  regenerateCodes: (password: string, code: string) =>
    api<{ codes: string[] }>("/internal-api/auth/totp/recovery-codes", {
      method: "POST",
      body: { password, code },
    }),
};

export const sessions = {
  list: () => api<SessionInfo[]>("/internal-api/me/sessions"),
  revoke: (id: string) => api<null>(`/internal-api/me/sessions/${id}`, { method: "DELETE" }),
  revokeOthers: () =>
    api<{ revoked: number }>("/internal-api/me/sessions/revoke-others", { method: "POST" }),
};

export const tokens = {
  list: () => api<ApiToken[]>("/internal-api/me/tokens"),
  create: (body: {
    name: string;
    access: ApiToken["access"];
    workspace_ids?: string[];
    expires_in_days?: number;
  }) => api<ApiToken & { secret: string }>("/internal-api/me/tokens", { method: "POST", body }),
  revoke: (id: string) => api<null>(`/internal-api/me/tokens/${id}`, { method: "DELETE" }),
};

export const workspaces = {
  list: () => api<WorkspaceSummary[]>("/internal-api/workspaces"),
  create: (name: string, slug: string, idempotency_key: string = crypto.randomUUID()) =>
    api<{ workspace: WorkspaceSummary }>("/internal-api/workspaces", {
      method: "POST",
      body: { name, slug, idempotency_key },
    }),
  report: (id: string) => api<Report>(`/internal-api/workspaces/${id}/report`),
  usage: (id: string) => api<Usage[]>(`/internal-api/workspaces/${id}/usage`),
  accept: (id: string, token: string) =>
    api<{ workspace: WorkspaceSummary }>(`/internal-api/workspaces/${id}/invitations/accept`, {
      method: "POST",
      body: { token },
    }),
  export: (id: string) => api<unknown>(`/internal-api/workspaces/${id}/export`),
  import: (
    id: string,
    body: { issues?: unknown[]; transfer?: unknown },
    idempotency_key: string = crypto.randomUUID(),
  ) =>
    api<{ versions: EntityVersions; summary: ImportSummary | null }>(
      `/internal-api/workspaces/${id}/import`,
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
    return api<CommandResult>(`/internal-api/workspaces/${id}/issues/${issueId}/attachments`, {
      method: "POST",
      body: form,
    });
  },
};

export function markdown(text: string) {
  return api<{ html: string }>("/internal-api/markdown", { method: "POST", body: { text } }).then(
    (r) => r.html,
  );
}
