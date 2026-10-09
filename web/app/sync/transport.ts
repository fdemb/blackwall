import { setCsrf } from "../lib/api";
import type { Profile } from "../lib/types";
import type { Scope } from "./persistence/types";
import { ENTITIES } from "./records";
import type { Change, Entity } from "./records";
import type { PendingMutation } from "./store";

export interface TransportOptions {
  fetch: typeof fetch;
  /** Origin or path prefix before /api, with or without a trailing slash. */
  baseUrl?: string;
  headers?: () => HeadersInit;
  signal?: AbortSignal;
}

export interface StreamOptions {
  signal?: AbortSignal;
}

export interface BootstrapHeader {
  cursor: string;
  last_mutation_id: number;
  schema: number;
}

export interface BootstrapRecord {
  entity: Entity;
  record: object;
}

export interface BootstrapResponse {
  header: BootstrapHeader;
  /** Completion confirms the trailer. Early cancellation does not. */
  records: AsyncIterable<BootstrapRecord>;
}

export interface PullResponse {
  cursor: string;
  more: boolean;
  reset: boolean;
  last_mutation_id: number | null;
  changes: Change[];
}

export type Mutation = Pick<PendingMutation, "id" | "name" | "args" | "at">;

export type MutationResult =
  | { id: number; status: "applied" | "duplicate" }
  | { id: number; status: "rejected"; error: { status: number; message: string } };

export interface PushResponse {
  status: "ok" | "partial";
  lastMutationId: number;
  results: MutationResult[];
}

export interface ScopeResponse {
  records: object[];
}

export interface Poke {
  event: "poke";
  data: object;
}

export type SessionProfile = Profile & { session_id: string };

class TransportError extends Error {
  constructor(
    message: string,
    public readonly status: number | null = null,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class NetworkError extends TransportError {}
export class TruncatedError extends TransportError {}
export class UnauthorizedError extends TransportError {}
export class AccessError extends TransportError {}
export class ProtocolError extends TransportError {}
export class UnavailableError extends TransportError {
  constructor(
    message: string,
    status: number,
    public readonly retryAfter: number | null = null,
  ) {
    super(message, status);
  }
}

export type Transport = ReturnType<typeof createTransport>;

/** One request per call. Records remain in their raw server shape. */
export function createTransport(options: TransportOptions) {
  const baseUrl = (options.baseUrl ?? "").replace(/\/+$/, "");
  function signalFor(signal?: AbortSignal): AbortSignal | undefined {
    return options.signal && signal
      ? AbortSignal.any([options.signal, signal])
      : (signal ?? options.signal);
  }
  function path(ws: string, route: string, clientId: string, query: Record<string, string> = {}) {
    return `/api/workspaces/${encodeURIComponent(ws)}/sync/${route}?${new URLSearchParams({ client_id: clientId, ...query })}`;
  }
  async function request(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(options.headers?.());
    new Headers(init.headers).forEach((value, key) => headers.set(key, value));
    let response: Response;
    try {
      response = await options.fetch(`${baseUrl}${path}`, {
        ...init,
        credentials: "same-origin",
        headers,
        signal: init.signal ?? options.signal,
      });
    } catch (cause) {
      throw new NetworkError("Request failed", null, { cause });
    }
    const token = response.headers.get("X-CSRF-Token");
    if (token) setCsrf(token);
    return response;
  }
  async function checked(path: string, init?: RequestInit): Promise<Response> {
    const response = await request(path, init);
    if (!response.ok) await fail(response, path !== "/api/me");
    return response;
  }
  return {
    async bootstrap(
      ws: string,
      clientId: string,
      stream: StreamOptions = {},
    ): Promise<BootstrapResponse> {
      const signal = signalFor(stream.signal);
      const response = await checked(path(ws, "bootstrap", clientId), { signal });
      await contentType(response, "application/x-ndjson");
      const iterator = lines(response, signal, "bootstrap");
      try {
        const first = await iterator.next();
        if (first.done)
          throw new TruncatedError("Bootstrap ended without a header or trailer", response.status);
        const header = parseHeader(parseJson(first.value, response.status), response.status);
        return { header, records: bootstrapRecords(iterator, response.status) };
      } catch (error) {
        await iterator.return(undefined);
        throw error;
      }
    },
    async pull(ws: string, clientId: string, cursor: string | null): Promise<PullResponse> {
      const response = await checked(path(ws, "pull", clientId, cursor === null ? {} : { cursor }));
      return parsePull(await json(response), response.status);
    },
    async push(
      ws: string,
      clientId: string,
      mutations: readonly Mutation[],
    ): Promise<PushResponse> {
      const response = await request(path(ws, "push", clientId), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: clientId,
          mutations: mutations.map(({ id, name, args, at }) => ({ id, name, args, at })),
        }),
      });
      if (!response.ok && response.status !== 503) await fail(response, true);
      const text = await bodyText(response);
      let value: unknown;
      try {
        value = parseJson(text, response.status);
      } catch (error) {
        if (response.status === 503) throw httpError(response, text || response.statusText, true);
        throw error;
      }
      if (response.status === 503 && object(value) && typeof value.error === "string")
        throw httpError(response, value.error, true);
      return parsePush(value, response.status);
    },
    async scope(ws: string, clientId: string, scope: Scope): Promise<ScopeResponse> {
      const query: Record<string, string> =
        scope.entity === "comments"
          ? { entity: scope.entity, issue_id: scope.issueId }
          : { entity: scope.entity, entity_id: scope.entityId };
      const response = await checked(path(ws, "scope", clientId, query));
      const value = await json(response);
      if (!object(value) || !Array.isArray(value.records) || !value.records.every(object))
        throw new ProtocolError("Invalid scope response", response.status);
      return { records: value.records };
    },
    async events(
      ws: string,
      clientId: string,
      stream: StreamOptions = {},
    ): Promise<AsyncIterable<Poke>> {
      const signal = signalFor(stream.signal);
      let response: Response;
      try {
        response = await checked(path(ws, "events", clientId), {
          signal,
          headers: { Accept: "text/event-stream" },
        });
      } catch (error) {
        if (error instanceof NetworkError && signal?.aborted) return pokes(null, signal);
        throw error;
      }
      await contentType(response, "text/event-stream");
      return pokes(response, signal);
    },
    async me(): Promise<SessionProfile> {
      const response = await checked("/api/me");
      return parseProfile(await json(response), response.status);
    },
  };
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function integer(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function entity(value: unknown): value is Entity {
  return ENTITIES.some((name) => name === value);
}
function parseJson(text: string, status: number): unknown {
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw new ProtocolError("Invalid JSON response", status, { cause });
  }
}
async function bodyText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch (cause) {
    throw new NetworkError("Response body failed", response.status, { cause });
  }
}
async function json(response: Response): Promise<unknown> {
  return parseJson(await bodyText(response), response.status);
}
function httpError(response: Response, message: string, workspace: boolean): TransportError {
  const status = response.status;
  if (status === 401) return new UnauthorizedError(message, status);
  if (status === 403 || (status === 404 && workspace)) return new AccessError(message, status);
  if (status >= 500) {
    const retry = response.headers.get("Retry-After");
    const seconds = retry !== null && /^\d+$/.test(retry.trim()) ? Number(retry) : null;
    return new UnavailableError(
      message,
      status,
      seconds !== null && Number.isSafeInteger(seconds) ? seconds : null,
    );
  }
  return new ProtocolError(message, status);
}
async function fail(response: Response, workspace: boolean): Promise<never> {
  const text = await bodyText(response);
  let message = text || response.statusText;
  try {
    const value: unknown = JSON.parse(text);
    message = object(value) && typeof value.error === "string" ? value.error : response.statusText;
  } catch {
    // Axum's JSON extractor returns plain text for 400, 415 and 422.
  }
  throw httpError(response, message, workspace);
}
async function contentType(response: Response, expected: string): Promise<void> {
  if (response.headers.get("Content-Type")?.split(";", 1)[0].trim().toLowerCase() !== expected) {
    await response.body?.cancel().catch(() => undefined);
    throw new ProtocolError(`Expected ${expected}`, response.status);
  }
}
function parseHeader(value: unknown, status: number): BootstrapHeader {
  if (
    !object(value) ||
    typeof value.cursor !== "string" ||
    !integer(value.last_mutation_id) ||
    !integer(value.schema)
  )
    throw new ProtocolError("Invalid bootstrap header", status);
  return { cursor: value.cursor, last_mutation_id: value.last_mutation_id, schema: value.schema };
}
function parsePull(value: unknown, status: number): PullResponse {
  if (
    !object(value) ||
    typeof value.cursor !== "string" ||
    typeof value.more !== "boolean" ||
    typeof value.reset !== "boolean" ||
    (value.last_mutation_id !== null && !integer(value.last_mutation_id)) ||
    !Array.isArray(value.changes)
  )
    throw new ProtocolError("Invalid pull response", status);
  const changes = value.changes.map((change: unknown): Change => {
    if (
      !object(change) ||
      !entity(change.entity) ||
      typeof change.id !== "string" ||
      (change.record !== null && !object(change.record))
    )
      throw new ProtocolError("Invalid pull change", status);
    return { entity: change.entity, id: change.id, record: change.record };
  });
  if ((value.more || value.reset) && value.last_mutation_id !== null)
    throw new ProtocolError("Non-final pull acknowledged mutations", status);
  return {
    cursor: value.cursor,
    more: value.more,
    reset: value.reset,
    last_mutation_id: value.last_mutation_id,
    changes,
  };
}
function parsePush(value: unknown, status: number): PushResponse {
  if (!object(value) || !integer(value.last_mutation_id) || !Array.isArray(value.results))
    throw new ProtocolError("Invalid push response", status);
  const results = value.results.map((result: unknown): MutationResult => {
    if (!object(result) || !integer(result.id) || result.id === 0)
      throw new ProtocolError("Invalid mutation result", status);
    if (result.status === "applied" || result.status === "duplicate")
      return { id: result.id, status: result.status };
    if (
      result.status === "rejected" &&
      object(result.error) &&
      integer(result.error.status) &&
      result.error.status >= 400 &&
      result.error.status < 600 &&
      typeof result.error.message === "string"
    )
      return {
        id: result.id,
        status: "rejected",
        error: { status: result.error.status, message: result.error.message },
      };
    throw new ProtocolError("Invalid mutation result", status);
  });
  return {
    status: status === 503 ? "partial" : "ok",
    lastMutationId: value.last_mutation_id,
    results,
  };
}
function parseProfile(value: unknown, status: number): SessionProfile {
  if (
    !object(value) ||
    typeof value.id !== "string" ||
    typeof value.email !== "string" ||
    typeof value.display_name !== "string" ||
    (value.avatar_url !== null && typeof value.avatar_url !== "string") ||
    typeof value.contact !== "string" ||
    (value.language !== "en" && value.language !== "pl") ||
    (value.theme !== "light" && value.theme !== "dark" && value.theme !== "system") ||
    typeof value.session_id !== "string" ||
    !object(value.alerts) ||
    typeof value.alerts.assignments !== "boolean" ||
    typeof value.alerts.replies !== "boolean" ||
    typeof value.alerts.changes !== "boolean" ||
    typeof value.alerts.deadlines !== "boolean"
  )
    throw new ProtocolError("Invalid session profile", status);
  return {
    id: value.id,
    email: value.email,
    display_name: value.display_name,
    avatar_url: value.avatar_url,
    contact: value.contact,
    language: value.language,
    theme: value.theme,
    session_id: value.session_id,
    alerts: {
      assignments: value.alerts.assignments,
      replies: value.alerts.replies,
      changes: value.alerts.changes,
      deadlines: value.alerts.deadlines,
    },
  };
}

/** Decode UTF-8 incrementally and split LF, CRLF or CR, including split CRLF. */
async function* lines(
  response: Response,
  signal: AbortSignal | undefined,
  kind: "bootstrap" | "events",
): AsyncGenerator<string> {
  if (!response.body) throw new ProtocolError("Missing response body", response.status);
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let done = false;
  let pending = "";
  let skipLf = false;
  const cancel = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) cancel();
  try {
    for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch (cause) {
        if (kind === "events" && signal?.aborted) return;
        const ErrorType = kind === "bootstrap" ? TruncatedError : NetworkError;
        throw new ErrorType("Response stream failed", response.status, { cause });
      }
      if (signal?.aborted) {
        if (kind === "events") return;
        throw new TruncatedError("Bootstrap aborted before completion", response.status);
      }
      let text: string;
      try {
        text = chunk.done ? decoder.decode() : decoder.decode(chunk.value, { stream: true });
      } catch (cause) {
        throw new ProtocolError("Invalid UTF-8 response", response.status, { cause });
      }
      for (const char of text) {
        if (skipLf && char === "\n") {
          skipLf = false;
          continue;
        }
        skipLf = char === "\r";
        if (char === "\r" || char === "\n") {
          if (kind === "events" && signal?.aborted) return;
          yield pending;
          pending = "";
        } else pending += char;
      }
      if (chunk.done) {
        done = true;
        if (pending) yield pending;
        return;
      }
    }
  } finally {
    signal?.removeEventListener("abort", cancel);
    if (!done) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

async function* bootstrapRecords(
  iterator: AsyncGenerator<string>,
  status: number,
): AsyncGenerator<BootstrapRecord> {
  let count = 0;
  let ended = false;
  try {
    for await (const line of iterator) {
      const value = parseJson(line, status);
      if (ended) throw new ProtocolError("Data after bootstrap trailer", status);
      if (object(value) && "end" in value) {
        if (value.end !== true || !integer(value.records) || value.records !== count)
          throw new ProtocolError("Invalid bootstrap trailer", status);
        ended = true;
      } else {
        if (!object(value) || !entity(value.entity) || !object(value.record))
          throw new ProtocolError("Invalid bootstrap record", status);
        count++;
        yield { entity: value.entity, record: value.record };
      }
    }
    if (!ended) throw new TruncatedError("Bootstrap ended without a trailer", status);
  } finally {
    await iterator.return(undefined);
  }
}

async function* pokes(response: Response | null, signal?: AbortSignal): AsyncGenerator<Poke> {
  if (response === null) return;
  let event = "";
  let data: string[] = [];
  for await (const line of lines(response, signal, "events")) {
    if (signal?.aborted) return;
    if (line === "") {
      if (event === "poke" && data.length > 0) {
        const value = parseJson(data.join("\n"), response.status);
        if (!object(value) || Object.keys(value).length !== 0)
          throw new ProtocolError("Invalid poke data", response.status);
        yield { event: "poke", data: value };
      }
      event = "";
      data = [];
    } else if (!line.startsWith(":")) {
      const colon = line.indexOf(":");
      const field = colon < 0 ? line : line.slice(0, colon);
      const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
      if (field === "event") event = value;
      else if (field === "data") data.push(value);
    }
  }
}
