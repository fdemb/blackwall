import { getCsrf, setCsrf } from "../lib/api";
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
  /** Seconds or an HTTP date. The engine interprets dates with its injected clock. */
  retryAfter?: number | string | null;
}

export interface CommandResponse {
  result: { id: string | null };
  versions: Record<string, number>;
  changes: Change[];
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
    public readonly retryAfter: number | string | null = null,
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
    if ((init.method ?? "GET").toUpperCase() !== "GET") headers.set("X-CSRF-Token", getCsrf());
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
        const header = parseHeader(parseLine(first.value, response.status), response.status);
        return { header, records: bootstrapRecords(iterator, response.status) };
      } catch (error) {
        await iterator.return(undefined);
        throw error;
      }
    },
    async pull(
      ws: string,
      clientId: string,
      cursor: string | null,
      requestOptions: StreamOptions = {},
    ): Promise<PullResponse> {
      const response = await checked(
        path(ws, "pull", clientId, cursor === null ? {} : { cursor }),
        { signal: signalFor(requestOptions.signal) },
      );
      return parsePull(await json(response), response.status);
    },
    async push(
      ws: string,
      clientId: string,
      mutations: readonly Mutation[],
      requestOptions: StreamOptions = {},
    ): Promise<PushResponse> {
      const response = await request(path(ws, "push", clientId), {
        method: "POST",
        signal: signalFor(requestOptions.signal),
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: clientId,
          mutations: mutations.map(({ id, name, args, at }) => ({ id, name, args, at })),
        }),
      });
      if (!response.ok && response.status !== 503) await fail(response, true);
      const text = await bodyText(response).catch((error: unknown) => {
        if (response.ok) throw error;
        throw httpError(response, response.statusText || `HTTP ${response.status}`, true);
      });
      let value: unknown;
      try {
        value = parseJson(text, response.status);
      } catch (error) {
        if (response.status === 503) throw httpError(response, text || response.statusText, true);
        throw error;
      }
      if (response.status === 503 && object(value) && typeof value.error === "string")
        throw httpError(response, value.error, true);
      const result = parsePush(value, response.status, mutations);
      if (response.status === 503) {
        const retry = retryAfter(response);
        if (retry !== null) result.retryAfter = retry;
      }
      return result;
    },
    async command(
      ws: string,
      input: { command: object; idempotencyKey: string },
      requestOptions: StreamOptions = {},
    ): Promise<CommandResponse> {
      const response = await checked(`/api/workspaces/${encodeURIComponent(ws)}/commands`, {
        method: "POST",
        signal: signalFor(requestOptions.signal),
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: input.command, idempotency_key: input.idempotencyKey }),
      });
      const value = await json(response);
      if (
        !object(value) ||
        !object(value.result) ||
        (value.result.id !== null && typeof value.result.id !== "string") ||
        !object(value.versions) ||
        !Object.values(value.versions).every(integer) ||
        !Array.isArray(value.changes)
      )
        throw new ProtocolError("Invalid command response", response.status);
      const changes = value.changes.map((change: unknown): Change => {
        if (
          !object(change) ||
          !entity(change.entity) ||
          typeof change.id !== "string" ||
          (change.record !== null && !object(change.record))
        )
          throw new ProtocolError("Invalid command change", response.status);
        return { entity: change.entity, id: change.id, record: change.record };
      });
      const versions: Record<string, number> = {};
      for (const [id, version] of Object.entries(value.versions)) {
        if (!integer(version)) throw new ProtocolError("Invalid command version", response.status);
        versions[id] = version;
      }
      return { result: { id: value.result.id }, versions, changes };
    },
    async scope(
      ws: string,
      clientId: string,
      scope: Scope,
      requestOptions: StreamOptions = {},
    ): Promise<ScopeResponse> {
      const query: Record<string, string> =
        scope.entity === "comments"
          ? { entity: scope.entity, issue_id: scope.issueId }
          : { entity: scope.entity, entity_id: scope.entityId };
      const response = await checked(path(ws, "scope", clientId, query), {
        signal: signalFor(requestOptions.signal),
      });
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
function retryAfter(response: Response): number | string | null {
  const value = response.headers.get("Retry-After")?.trim();
  if (value === undefined) return null;
  if (/^\d+$/.test(value) && Number.isSafeInteger(Number(value))) return Number(value);
  if (/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)/.test(value) && Number.isFinite(Date.parse(value)))
    return value;
  return null;
}

function httpError(response: Response, message: string, workspace: boolean): TransportError {
  const status = response.status;
  if (status === 401) return new UnauthorizedError(message, status);
  if (status === 403 || (status === 404 && workspace)) return new AccessError(message, status);
  if (status >= 500) {
    return new UnavailableError(message, status, retryAfter(response));
  }
  return new ProtocolError(message, status);
}
async function fail(response: Response, workspace: boolean): Promise<never> {
  const fallback = response.statusText || `HTTP ${response.status}`;
  const failure = httpError(response, fallback, workspace);
  let text: string;
  try {
    text = await response.text();
  } catch {
    throw failure;
  }
  let message = text || fallback;
  try {
    const value: unknown = JSON.parse(text);
    message = object(value) && typeof value.error === "string" ? value.error : fallback;
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
function parsePush(value: unknown, status: number, mutations: readonly Mutation[]): PushResponse {
  if (!object(value) || !integer(value.last_mutation_id) || !Array.isArray(value.results))
    throw new ProtocolError("Invalid push response", status);
  const results = value.results.map((result: unknown) => parseMutationResult(result, status));
  if (
    results.length > mutations.length ||
    (status !== 503 && results.length !== mutations.length) ||
    results.some((result, index) => result.id !== mutations[index].id)
  )
    throw new ProtocolError("Push results do not cover the submitted batch in order", status);
  return {
    status: status === 503 ? "partial" : "ok",
    lastMutationId: value.last_mutation_id,
    results,
  };
}
function parseMutationResult(result: unknown, status: number): MutationResult {
  if (!object(result) || !integer(result.id) || result.id === 0)
    throw new ProtocolError("Invalid mutation result", status);
  if (result.status === "applied" || result.status === "duplicate")
    return { id: result.id, status: result.status };
  const error = result.error;
  if (
    result.status === "rejected" &&
    object(error) &&
    integer(error.status) &&
    error.status >= 400 &&
    error.status < 600 &&
    typeof error.message === "string"
  )
    return {
      id: result.id,
      status: "rejected",
      error: { status: error.status, message: error.message },
    };
  throw new ProtocolError("Invalid mutation result", status);
}

function parseProfile(value: unknown, status: number): SessionProfile {
  if (!isProfile(value)) throw new ProtocolError("Invalid session profile", status);
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

function isProfile(value: unknown): value is SessionProfile {
  return (
    object(value) &&
    ["id", "email", "display_name", "contact", "session_id"].every(
      (key) => typeof value[key] === "string",
    ) &&
    (value.avatar_url === null || typeof value.avatar_url === "string") &&
    (value.language === "en" || value.language === "pl") &&
    (value.theme === "light" || value.theme === "dark" || value.theme === "system") &&
    object(value.alerts) &&
    ["assignments", "replies", "changes", "deadlines"].every(
      (key) => typeof (value.alerts as Record<string, unknown>)[key] === "boolean",
    )
  );
}

interface Line {
  text: string;
  terminated: boolean;
}

function parseLine(line: Line, status: number): unknown {
  try {
    return parseJson(line.text, status);
  } catch (cause) {
    if (!line.terminated)
      throw new TruncatedError("Bootstrap ended inside a line", status, { cause });
    throw cause;
  }
}

/** Splits text on LF, CR or CRLF, keeping a partial line and a CRLF split across chunks. */
class LineSplitter {
  private pending = "";
  private skipLf = false;

  *feed(text: string): Generator<string> {
    for (const char of text) {
      if (this.skipLf && char === "\n") {
        this.skipLf = false;
        continue;
      }
      this.skipLf = char === "\r";
      if (char === "\r" || char === "\n") {
        yield this.pending;
        this.pending = "";
      } else this.pending += char;
    }
  }

  get rest(): string {
    return this.pending;
  }
}

/**
 * Reads the next chunk. Returns null when an aborted event stream should end
 * quietly; an aborted bootstrap is truncated.
 */
async function readChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  status: number,
  signal: AbortSignal | undefined,
  kind: "bootstrap" | "events",
): Promise<ReadableStreamReadResult<Uint8Array> | null> {
  let chunk: ReadableStreamReadResult<Uint8Array>;
  try {
    chunk = await reader.read();
  } catch (cause) {
    if (kind === "events" && signal?.aborted) return null;
    const ErrorType = kind === "bootstrap" ? TruncatedError : NetworkError;
    throw new ErrorType("Response stream failed", status, { cause });
  }
  if (signal?.aborted) {
    if (kind === "events") return null;
    throw new TruncatedError("Bootstrap aborted before completion", status);
  }
  return chunk;
}

function decodeChunk(
  decoder: TextDecoder,
  chunk: ReadableStreamReadResult<Uint8Array>,
  status: number,
  kind: "bootstrap" | "events",
): string {
  try {
    return chunk.done ? decoder.decode() : decoder.decode(chunk.value, { stream: true });
  } catch (cause) {
    const ErrorType = kind === "bootstrap" && chunk.done ? TruncatedError : ProtocolError;
    throw new ErrorType("Invalid UTF-8 response", status, { cause });
  }
}

/** Decode UTF-8 incrementally and split LF, CRLF or CR, including split CRLF. */
async function* lines(
  response: Response,
  signal: AbortSignal | undefined,
  kind: "bootstrap" | "events",
): AsyncGenerator<Line> {
  if (!response.body) throw new ProtocolError("Missing response body", response.status);
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const splitter = new LineSplitter();
  let done = false;
  const cancel = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) cancel();
  try {
    for (;;) {
      const chunk = await readChunk(reader, response.status, signal, kind);
      if (chunk === null) return;
      for (const text of splitter.feed(decodeChunk(decoder, chunk, response.status, kind))) {
        if (kind === "events" && signal?.aborted) return;
        yield { text, terminated: true };
      }
      if (chunk.done) {
        done = true;
        if (splitter.rest) yield { text: splitter.rest, terminated: false };
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
  iterator: AsyncGenerator<Line>,
  status: number,
): AsyncGenerator<BootstrapRecord> {
  let count = 0;
  let ended = false;
  try {
    for await (const line of iterator) {
      if (ended) throw new ProtocolError("Data after bootstrap trailer", status);
      const value = parseLine(line, status);
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
  for await (const { text: line } of lines(response, signal, "events")) {
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
