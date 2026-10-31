import { randomUUID } from "node:crypto";
import { inject } from "vite-plus/test";
import type { Command, Role } from "../../lib/types";
import { createEngine, SCHEMA } from "../engine";
import type { EngineSignal, SyncEngine } from "../engine";
import { MemoryReplicaStorage } from "../persistence/memory";
import type { Scope } from "../persistence/types";
import { createTransport, ProtocolError } from "../transport";
import { sql } from "./setup";

declare module "vite-plus/test" {
  export interface ProvidedContext {
    syncContract: { baseUrl: string; databaseUrl: string };
  }
}

export const enabled = process.env.SYNC_CONTRACT === "1" && Boolean(process.env.TEST_POSTGRES_URL);
export const suiteName = enabled
  ? "real Rust server"
  : "real Rust server (skipped: set SYNC_CONTRACT=1 and TEST_POSTGRES_URL)";
export const password = "contract-password-123";

export function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("expected JSON object");
  return Object.fromEntries(Object.entries(value));
}
export function textField(value: unknown, key: string): string {
  const field = object(value)[key];
  if (typeof field !== "string") throw new Error(`expected string ${key}`);
  return field;
}
export interface User {
  id: string;
  email: string;
  token: string;
  csrf: string;
}
function session(value: unknown): User {
  const profile = object(value).profile;
  return {
    id: textField(profile, "id"),
    email: textField(profile, "email"),
    token: textField(value, "token"),
    csrf: textField(value, "csrf_token"),
  };
}

export async function request(path: string, user?: User, body?: unknown): Promise<unknown> {
  const { baseUrl } = inject("syncContract");
  const response = await fetch(`${baseUrl}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      ...(user ? { Authorization: `Bearer ${user.token}` } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  const value: unknown = response.status === 204 ? null : await response.json();
  if (!response.ok) throw new Error(`${response.status}: ${JSON.stringify(value)}`);
  return value;
}
export async function register(name: string): Promise<User> {
  const email = `${randomUUID()}@example.test`;
  const registered = object(
    await request("/internal-api/auth/register", undefined, {
      display_name: name,
      email,
      password,
    }),
  );
  if (registered.verification_sent !== true) return session(registered);
  const token = await sql(
    inject("syncContract").databaseUrl,
    `SELECT payload->>'token' FROM jobs WHERE payload->>'to'='${email}' AND payload ? 'verification_hash'`,
  );
  await request("/internal-api/auth/verify", undefined, { token });
  return session(await request("/internal-api/auth/login", undefined, { email, password }));
}
export async function login(user: User): Promise<User> {
  return session(
    await request("/internal-api/auth/login", undefined, { email: user.email, password }),
  );
}
export async function workspace(owner: User): Promise<string> {
  return textField(
    object(
      await request("/internal-api/workspaces", owner, {
        name: "Sync contract",
        slug: `sync-${crypto.randomUUID()}`,
      }),
    ).workspace,
    "id",
  );
}
export async function command(ws: string, user: User, value: Command): Promise<string | null> {
  const result = object(
    await request(`/internal-api/workspaces/${ws}/commands`, user, { command: value }),
  ).result;
  const id = object(result).id;
  if (id === null || typeof id === "string") return id;
  throw new Error("invalid command result id");
}
export async function addMember(ws: string, owner: User, user: User, role: Role): Promise<void> {
  const result = object(
    object(
      await request(`/internal-api/workspaces/${ws}/commands`, owner, {
        command: { type: "invite", email: user.email, role, token_hash: "server-generated" },
      }),
    ).result,
  );
  if (typeof result.id !== "string" || !/^[\da-f-]{36}$/.test(result.id))
    throw new Error("invalid invitation id");
  const token = textField(object(result.invitation), "token");
  await request(`/internal-api/workspaces/${ws}/invitations/accept`, user, { token });
}

export class Connection {
  online = true;
  dropNextPush = false;
  droppedPushes = 0;
  csrf: string;
  private cookie: string;
  private readonly listeners = new Set<(signal: EngineSignal) => void>();
  constructor(
    private readonly user: User,
    private readonly cookies = false,
  ) {
    this.csrf = user.csrf;
    this.cookie = `blackwall_session=${user.token}`;
  }
  getOnline = () => this.online;
  subscribe = (listener: (signal: EngineSignal) => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  send(signal: EngineSignal) {
    if (signal === "online" || signal === "offline") this.online = signal === "online";
    for (const listener of this.listeners) listener(signal);
  }
  fetch: typeof fetch = async (input, init) => {
    if (!this.online) throw new TypeError("contract client offline");
    const headers = new Headers(init?.headers);
    if (this.cookies) {
      headers.set("Cookie", this.cookie);
      if (init?.method && init.method !== "GET") headers.set("X-CSRF-Token", this.csrf);
    } else headers.set("Authorization", `Bearer ${this.user.token}`);
    const push = String(input).includes("/sync/push");
    const drop = push && this.dropNextPush;
    if (drop) this.dropNextPush = false;
    const response = await fetch(input, { ...init, headers });
    for (const cookie of response.headers.getSetCookie()) this.cookie = cookie.split(";")[0];
    this.csrf = response.headers.get("X-CSRF-Token") ?? this.csrf;
    if (drop) {
      await response.arrayBuffer();
      this.droppedPushes += 1;
      throw new TypeError("response lost after server commit");
    }
    return response;
  };
}

export function client(
  ws: string,
  user: User,
  options: {
    storage?: MemoryReplicaStorage;
    connection?: Connection;
    cookies?: boolean;
    randomId?: () => string;
  } = {},
) {
  const storage = options.storage ?? new MemoryReplicaStorage();
  const connection = options.connection ?? new Connection(user, options.cookies);
  const engine = createEngine({
    actor: user.id,
    workspaceId: ws,
    schema: SCHEMA,
    storage,
    transport: createTransport({
      baseUrl: inject("syncContract").baseUrl,
      fetch: connection.fetch,
      userId: user.id,
    }),
    randomId: options.randomId ?? randomUUID,
    clock: {
      now: () => new Date().toISOString(),
      monotonic: () => performance.now(),
      schedule: (ms, run) => {
        const timer = setTimeout(run, ms);
        return () => clearTimeout(timer);
      },
    },
    signals: connection,
  });
  return { engine, storage, connection, user, ws };
}
export type Client = ReturnType<typeof client>;

export async function waitFor(
  check: () => boolean | Promise<boolean>,
  label: string,
  timeout = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
export async function ready(engine: SyncEngine): Promise<void> {
  await engine.start();
  await waitFor(() => engine.status.get().phase === "ready", "bootstrap ready");
}
export async function settle(engine: SyncEngine): Promise<void> {
  await waitFor(async () => {
    await engine.pull();
    return engine.store.pending().length === 0;
  }, "empty outbox");
  await engine.pull();
  const error = engine.status.get().lastError;
  if (error instanceof ProtocolError) throw error;
}
export async function hold(c: Client, scope: Scope): Promise<() => void> {
  const release = c.engine.useScope(scope);
  await waitFor(async () => {
    const disk = await c.storage.open({
      userId: c.user.id,
      workspaceId: c.ws,
      schema: SCHEMA,
    });
    try {
      return (await disk.load()).scopes.some(
        (item) => JSON.stringify(item) === JSON.stringify(scope),
      );
    } finally {
      disk.close();
    }
  }, "scope persisted");
  return release;
}
