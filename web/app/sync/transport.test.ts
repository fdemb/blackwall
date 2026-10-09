import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { api, setCsrf } from "../lib/api";
import type { Scope } from "./persistence/types";
import { BOOTSTRAP_ENTITIES } from "./records";
import type { PendingMutation } from "./store";
import { createFakeServer } from "./testing/fake-server";
import type { FakeServerOptions } from "./testing/fake-server";
import {
  AccessError,
  createTransport,
  NetworkError,
  ProtocolError,
  TruncatedError,
  UnauthorizedError,
  UnavailableError,
} from "./transport";
import type { Mutation, Transport } from "./transport";

const id = (n: number) => `11111111-1111-4111-8111-${n.toString(16).padStart(12, "0")}`;
const CLIENT = id(1);
const TEAM = id(2);
const ISSUE = id(3);
const HEADER = { cursor: "10:10:", last_mutation_id: 0, schema: 1 };
const POKE = { event: "poke", data: {} };
const COMMENT_SCOPE: Scope = { entity: "comments", issueId: ISSUE };

describe("review regressions", () => {
  it("classifies EOF inside a bootstrap record as truncation", async () => {
    const snapshot = await responseTransport(
      byteResponse(
        `${JSON.stringify(HEADER)}\n{"entity":"issues","record":{"id":"unfinished`,
        "application/x-ndjson",
      ),
    ).bootstrap(id(50), CLIENT);
    await expect(collect(snapshot.records)).rejects.toBeInstanceOf(TruncatedError);
  });

  it.each([401, 403, 404, 503])("preserves HTTP %i when its error body fails", async (status) => {
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.error(new Error("body lost"));
        },
      }),
      { status, headers: { "Retry-After": "5" } },
    );
    await expect(responseTransport(response).pull(id(50), CLIENT, null)).rejects.toMatchObject({
      name:
        status === 401 ? "UnauthorizedError" : status === 503 ? "UnavailableError" : "AccessError",
      status,
      ...(status === 503 ? { retryAfter: 5 } : {}),
    });
  });

  it.each([
    { status: 200, results: [] },
    { status: 200, results: [{ id: 1, status: "applied" }] },
    {
      status: 200,
      results: [
        { id: 2, status: "applied" },
        { id: 1, status: "applied" },
      ],
    },
    {
      status: 200,
      results: [
        { id: 1, status: "applied" },
        { id: 1, status: "duplicate" },
      ],
    },
    {
      status: 200,
      results: [
        { id: 1, status: "applied" },
        { id: 3, status: "applied" },
      ],
    },
    { status: 503, results: [{ id: 2, status: "applied" }] },
    {
      status: 503,
      results: [
        { id: 1, status: "applied" },
        { id: 2, status: "applied" },
        { id: 3, status: "applied" },
      ],
    },
  ])(
    "rejects push results outside the submitted ordered batch: %j",
    async ({ status, results }) => {
      const transport = responseTransport(
        Response.json({ last_mutation_id: 2, results }, { status }),
      );
      await expect(transport.push(id(50), CLIENT, [label(1), label(2)])).rejects.toBeInstanceOf(
        ProtocolError,
      );
    },
  );
});

function label(n: number): Mutation {
  return {
    id: n,
    name: "create_label",
    args: { id: id(100 + n), name: `Label ${n}`, color: "#ff0000" },
    at: "2026-10-09T12:00:00Z",
  };
}
function fixture(options: FakeServerOptions = {}) {
  const server = createFakeServer(options);
  const owner = server.addUser({ display_name: "Owner" });
  const workspace = server.addWorkspace();
  server.addMember(workspace.id, owner, "owner");
  const token = server.login(owner);
  setCsrf("csrf");
  const fetch = vi.fn(server.fetch);
  const transport = createTransport({
    fetch,
    headers: () => ({ authorization: `Bearer ${token}`, "X-CSRF-Token": "csrf" }),
  });
  const createIssue = () => {
    server.run(owner, {
      type: "create_team",
      id: TEAM,
      name: "Team",
      members: [owner.id],
      default_stage_ids: [id(10), id(11), id(12), id(13)],
    });
    server.run(owner, {
      type: "create_issue",
      input: { id: ISSUE, team_id: TEAM, title: "Issue" },
    });
  };
  return { server, owner, workspace, token, fetch, transport, createIssue };
}
async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of iterable) values.push(value);
  return values;
}
function iterator<T>(iterable: AsyncIterable<T>): AsyncIterator<T> {
  return iterable[Symbol.asyncIterator]();
}
function byteResponse(text: string, type: string): Response {
  const bytes = new TextEncoder().encode(text);
  let index = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (index < bytes.length) controller.enqueue(bytes.slice(index, ++index));
        else controller.close();
      },
    }),
    { headers: { "content-type": type } },
  );
}
function responseTransport(response: Response): Transport {
  return createTransport({ fetch: async () => response });
}
function ndjson(values: unknown[]): Response {
  return byteResponse(
    values.map((value) => JSON.stringify(value)).join("\n"),
    "application/x-ndjson",
  );
}
const methods = ["bootstrap", "pull", "push", "scope", "events", "me"] as const;
function call(transport: Transport, method: (typeof methods)[number]): Promise<unknown> {
  switch (method) {
    case "bootstrap":
      return transport.bootstrap(id(50), CLIENT);
    case "pull":
      return transport.pull(id(50), CLIENT, null);
    case "push":
      return transport.push(id(50), CLIENT, [label(1)]);
    case "scope":
      return transport.scope(id(50), CLIENT, COMMENT_SCOPE);
    case "events":
      return transport.events(id(50), CLIENT);
    case "me":
      return transport.me();
  }
}
afterEach(() => {
  vi.unstubAllGlobals();
  setCsrf("");
});

describe("sync transport requests", () => {
  it("bootstraps the fake's authoritative always-loaded records and acknowledgement", async () => {
    const f = fixture();
    f.createIssue();
    await f.transport.push(f.workspace.id, CLIENT, [label(7)]);
    const snapshot = await f.transport.bootstrap(f.workspace.id, CLIENT);
    expect(snapshot.header).toEqual({
      cursor: (await f.transport.pull(f.workspace.id, CLIENT, null)).cursor,
      last_mutation_id: f.server.clientState(CLIENT).last_mutation_id,
      schema: 1,
    });
    expect(await collect(snapshot.records)).toEqual(
      BOOTSTRAP_ENTITIES.flatMap((entity) =>
        f.server.records(entity, f.owner.id, f.workspace.id).map((record) => ({ entity, record })),
      ),
    );
    expect(new Headers(f.fetch.mock.calls[1][1]?.headers).has("Accept-Encoding")).toBe(false);
  });

  it("pulls raw committed records, deletions and the client's high-water mark", async () => {
    const f = fixture();
    const member = f.server.addUser();
    f.server.addMember(f.workspace.id, member);
    const start = await f.transport.pull(f.workspace.id, CLIENT, null);
    expect(start).toEqual({
      cursor: start.cursor,
      more: false,
      reset: false,
      last_mutation_id: null,
      changes: [],
    });
    const query = String(f.fetch.mock.calls[0][0]);
    expect(new URL(query, "https://example.test").searchParams.has("cursor")).toBe(false);
    await f.transport.push(f.workspace.id, CLIENT, [label(2)]);
    const page = await f.transport.pull(f.workspace.id, CLIENT, start.cursor);
    expect(page).toEqual({
      cursor: page.cursor,
      more: false,
      reset: false,
      last_mutation_id: 2,
      changes: [
        ...f.server
          .records("activity")
          .map((record) => ({ entity: "activity", id: record.id, record })),
        { entity: "labels", id: id(102), record: f.server.record("labels", id(102)) },
      ],
    });
    f.server.removeMember(f.workspace.id, member.id);
    expect((await f.transport.pull(f.workspace.id, CLIENT, page.cursor)).changes).toEqual([
      { entity: "members", id: member.id, record: null },
    ]);
  });

  it("returns intermediate pages and reset responses without acknowledgements", async () => {
    const f = fixture({ pageSize: 2 });
    const start = await f.transport.pull(f.workspace.id, CLIENT, null);
    await f.transport.push(f.workspace.id, CLIENT, [label(1), label(2)]);
    const first = await f.transport.pull(f.workspace.id, CLIENT, start.cursor);
    expect(first).toMatchObject({ more: true, reset: false, last_mutation_id: null });
    expect(first.changes).toEqual([
      ...f.server
        .records("activity")
        .filter((record) => record.entity_id === id(101))
        .map((record) => ({ entity: "activity", id: record.id, record })),
      { entity: "labels", id: id(101), record: f.server.record("labels", id(101)) },
    ]);
    f.server.inject({ kind: "reset_pull" });
    expect(await f.transport.pull(f.workspace.id, CLIENT, first.cursor)).toMatchObject({
      more: false,
      reset: true,
      last_mutation_id: null,
      changes: [],
    });
  });

  it("pushes applied, duplicate and rejected results without sending local data", async () => {
    const f = fixture();
    const pending: PendingMutation = { ...label(1), local: { private: "never send" } };
    expect(await f.transport.push(f.workspace.id, CLIENT, [pending])).toEqual({
      status: "ok",
      lastMutationId: 1,
      results: [{ id: 1, status: "applied" }],
    });
    const request = new Request(
      `https://example.test${f.fetch.mock.calls[0][0]}`,
      f.fetch.mock.calls[0][1],
    );
    expect(await request.json()).toEqual({ client_id: CLIENT, mutations: [label(1)] });
    expect(request.credentials).toBe("same-origin");
    expect(request.headers.get("Content-Type")).toBe("application/json");
    expect(request.headers.get("X-CSRF-Token")).toBe("csrf");
    expect(
      await f.transport.push(f.workspace.id, CLIENT, [label(1), { ...label(2), name: "unknown" }]),
    ).toMatchObject({
      status: "ok",
      lastMutationId: f.server.clientState(CLIENT).last_mutation_id,
      results: [
        { id: 1, status: "duplicate" },
        { id: 2, status: "rejected", error: { status: 400, message: expect.any(String) } },
      ],
    });
    expect(f.server.records("labels")).toHaveLength(1);
  });

  it.each([0, 1])("returns 503 partial results after %i committed mutations", async (after) => {
    const f = fixture();
    f.server.inject({ kind: "unavailable", route: "push", after });
    expect(await f.transport.push(f.workspace.id, CLIENT, [label(1), label(2)])).toEqual({
      status: "partial",
      lastMutationId: f.server.clientState(CLIENT).last_mutation_id,
      results: after === 0 ? [] : [{ id: 1, status: "applied" }],
    });
    expect(f.server.records("labels")).toHaveLength(after);
    expect(f.fetch).toHaveBeenCalledTimes(1);
  });

  it("loads comment and activity scopes from the fake's authoritative records", async () => {
    const f = fixture();
    f.createIssue();
    f.server.run(f.owner, {
      type: "add_comment",
      id: id(20),
      issue_id: ISSUE,
      body: "Comment",
      mentions: [],
      attachments: [],
    });
    expect(await f.transport.scope(f.workspace.id, CLIENT, COMMENT_SCOPE)).toEqual({
      records: f.server.records("comments").filter((record) => record.issue_id === ISSUE),
    });
    expect(
      await f.transport.scope(f.workspace.id, CLIENT, { entity: "activity", entityId: ISSUE }),
    ).toEqual({
      records: f.server.records("activity").filter((record) => record.entity_id === ISSUE),
    });
    expect(
      await f.transport.scope(f.workspace.id, CLIENT, { entity: "comments", issueId: id(99) }),
    ).toEqual({ records: [] });
  });

  it("returns the profile and a stable public session id", async () => {
    const f = fixture();
    const me = await f.transport.me();
    expect(me).toEqual({ ...f.owner, session_id: expect.any(String) });
    expect(await f.transport.me()).toEqual(me);
    expect(me.session_id).not.toBe(f.token);
  });

  it("uses baseUrl and fresh injected headers for every request", async () => {
    const f = fixture();
    let token = "first";
    setCsrf(token);
    const fetch = vi.fn(f.server.fetch);
    const transport = createTransport({
      fetch,
      baseUrl: "https://example.test/",
      headers: () => ({ authorization: `Bearer ${f.token}`, "X-Request": token }),
    });
    await transport.push(f.workspace.id, CLIENT, [label(1)]);
    token = "second";
    setCsrf(token);
    await transport.push(f.workspace.id, CLIENT, [label(2)]);
    expect(String(fetch.mock.calls[0][0])).toBe(
      `https://example.test/api/workspaces/${f.workspace.id}/sync/push?client_id=${CLIENT}`,
    );
    expect(new Headers(fetch.mock.calls[1][1]?.headers).get("X-CSRF-Token")).toBe("second");
    expect(new Headers(fetch.mock.calls[1][1]?.headers).get("X-Request")).toBe("second");
  });

  it("refreshes the REST client's CSRF token from response headers", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({}, { headers: { "X-CSRF-Token": "rotated" } }),
    );
    const transport = createTransport({ fetch });
    await expect(transport.me()).rejects.toBeInstanceOf(ProtocolError);
    vi.stubGlobal("fetch", fetch);
    await api("/api/test", { method: "POST", body: {} });
    expect(new Headers(fetch.mock.calls[1]?.[1]?.headers).get("X-CSRF-Token")).toBe("rotated");
  });
});

describe("bootstrap stream validation", () => {
  it("decodes one-byte chunks inside lines and UTF-8 characters, including a final trailer without a newline", async () => {
    const record = { id: "workspace", name: "Zażółć 🦀", version: 1 };
    const transport = responseTransport(
      ndjson([HEADER, { entity: "workspace", record }, { end: true, records: 1 }]),
    );
    const snapshot = await transport.bootstrap(id(50), CLIENT);
    expect(snapshot.header).toEqual(HEADER);
    expect(await collect(snapshot.records)).toEqual([{ entity: "workspace", record }]);
  });

  it("yields records before the trailer arrives and cancels on early consumer exit", async () => {
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    const cancel = vi.fn();
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(value) {
          controller = value;
        },
        cancel,
      }),
      { headers: { "Content-Type": "application/x-ndjson" } },
    );
    controller?.enqueue(
      new TextEncoder().encode(`${JSON.stringify(HEADER)}\n{"entity":"workspace","record":{}}\n`),
    );
    const snapshot = await responseTransport(response).bootstrap(id(50), CLIENT);
    for await (const record of snapshot.records) {
      expect(record).toEqual({ entity: "workspace", record: {} });
      break;
    }
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it.each([0, 1])("reports the fake's truncation fault after %i records", async (afterRecords) => {
    const f = fixture();
    f.server.inject({ kind: "truncate_bootstrap", afterRecords });
    const snapshot = await f.transport.bootstrap(f.workspace.id, CLIENT);
    await expect(collect(snapshot.records)).rejects.toMatchObject({
      name: "TruncatedError",
      status: 200,
    });
  });

  it.each([
    { name: "count mismatch", lines: [HEADER, { end: true, records: 1 }] },
    {
      name: "unknown entity",
      lines: [HEADER, { entity: "roles", record: {} }, { end: true, records: 1 }],
    },
    { name: "array record", lines: [HEADER, { entity: "issues", record: [] }] },
    { name: "null record", lines: [HEADER, { entity: "issues", record: null }] },
    { name: "false end", lines: [HEADER, { end: false, records: 0 }] },
    { name: "missing count", lines: [HEADER, { end: true }] },
    {
      name: "data after trailer",
      lines: [HEADER, { end: true, records: 0 }, { entity: "issues", record: {} }],
    },
    {
      name: "duplicate trailer",
      lines: [HEADER, { end: true, records: 0 }, { end: true, records: 0 }],
    },
  ])("rejects $name as a protocol error", async ({ lines }) => {
    const snapshot = await responseTransport(ndjson(lines)).bootstrap(id(50), CLIENT);
    await expect(collect(snapshot.records)).rejects.toBeInstanceOf(ProtocolError);
  });

  it.each([
    null,
    [],
    {},
    { ...HEADER, cursor: 5 },
    { ...HEADER, last_mutation_id: 0.5 },
    { ...HEADER, last_mutation_id: -1 },
    { ...HEADER, schema: "1" },
    { ...HEADER, schema: Number.MAX_SAFE_INTEGER + 1 },
  ])("validates every bootstrap header field: %j", async (header) => {
    await expect(
      responseTransport(ndjson([header])).bootstrap(id(50), CLIENT),
    ).rejects.toBeInstanceOf(ProtocolError);
  });

  it("reports an empty bootstrap body as truncated", async () => {
    await expect(responseTransport(ndjson([])).bootstrap(id(50), CLIENT)).rejects.toBeInstanceOf(
      TruncatedError,
    );
  });

  it("reports a failed bootstrap body stream as truncated", async () => {
    let reads = 0;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          if (reads++ === 0)
            controller.enqueue(new TextEncoder().encode(`${JSON.stringify(HEADER)}\n`));
          else controller.error(new Error("connection lost"));
        },
      }),
      { headers: { "Content-Type": "application/x-ndjson" } },
    );
    const snapshot = await responseTransport(response).bootstrap(id(50), CLIENT);
    await expect(collect(snapshot.records)).rejects.toBeInstanceOf(TruncatedError);
  });

  it("rejects invalid UTF-8 as a protocol error", async () => {
    const response = new Response(new Uint8Array([0xff]), {
      headers: { "Content-Type": "application/x-ndjson" },
    });
    await expect(responseTransport(response).bootstrap(id(50), CLIENT)).rejects.toBeInstanceOf(
      ProtocolError,
    );
  });
});

describe("event streams", () => {
  it("yields the initial poke and commit pokes, and ignores fake keepalive comments", async () => {
    const f = fixture({ events: { keepaliveMs: 100 } });
    const abort = new AbortController();
    const events = iterator(
      await f.transport.events(f.workspace.id, CLIENT, { signal: abort.signal }),
    );
    expect(await events.next()).toEqual({ done: false, value: POKE });
    const next = events.next();
    f.server.advance(100);
    let resolved = false;
    void next.then(() => {
      resolved = true;
    });
    await Promise.resolve();
    expect(resolved).toBe(false);
    await f.transport.push(f.workspace.id, CLIENT, [label(1)]);
    f.server.advance(150);
    expect(await next).toEqual({ done: false, value: POKE });
    abort.abort();
    expect(await events.next()).toMatchObject({ done: true });
  });

  it("parses CRLF, CR, LF, split fields, multiline data, comments and unknown fields per SSE rules", async () => {
    const text =
      "\uFEFF: keepalive\r\n\r\nretry: 1000\r\nid: 42\r\nunknown: ignored\r\nevent: ignored\r\nevent: poke\r\ndata: {\r\ndata: }\r\n\r\nevent: poke\rdata:{}\r\revent: poke\ndata: {}\n\n";
    const transport = responseTransport(byteResponse(text, "text/event-stream; charset=utf-8"));
    expect(await collect(await transport.events(id(50), CLIENT))).toEqual([POKE, POKE, POKE]);
  });

  it("discards unknown events, events without data and an incomplete event at EOF", async () => {
    const transport = responseTransport(
      byteResponse(
        "event: other\ndata: garbage\n\nevent: poke\n\nevent: poke\ndata: {}",
        "text/event-stream",
      ),
    );
    expect(await collect(await transport.events(id(50), CLIENT))).toEqual([]);
  });

  it("ends when the fake server closes the stream", async () => {
    const f = fixture();
    f.server.inject({ kind: "close_events", afterMs: 10 });
    const events = iterator(await f.transport.events(f.workspace.id, CLIENT));
    expect(await events.next()).toMatchObject({ value: POKE });
    const next = events.next();
    f.server.advance(10);
    expect(await next).toMatchObject({ done: true });
  });

  it.each(["request", "transport"] as const)(
    "aborting the %s signal unblocks a pending read even when fetch ignores it",
    async (source) => {
      const abort = new AbortController();
      const cancel = vi.fn();
      const transport = createTransport({
        fetch: async () =>
          new Response(new ReadableStream<Uint8Array>({ cancel }), {
            headers: { "Content-Type": "text/event-stream" },
          }),
        signal: source === "transport" ? abort.signal : undefined,
      });
      const events = iterator(
        await transport.events(id(50), CLIENT, {
          signal: source === "request" ? abort.signal : undefined,
        }),
      );
      const next = events.next();
      abort.abort();
      expect(await next).toMatchObject({ done: true });
      expect(cancel).toHaveBeenCalledTimes(1);
    },
  );

  it("ends cleanly when fetch rejects an already-aborted event request", async () => {
    const f = fixture();
    const abort = new AbortController();
    abort.abort();
    expect(
      await collect(await f.transport.events(f.workspace.id, CLIENT, { signal: abort.signal })),
    ).toEqual([]);
  });

  it("combines the transport and request signals", async () => {
    const f = fixture();
    const lifetime = new AbortController();
    const request = new AbortController();
    const transport = createTransport({
      fetch: f.server.fetch,
      headers: () => ({ authorization: `Bearer ${f.token}` }),
      signal: lifetime.signal,
    });
    const events = iterator(
      await transport.events(f.workspace.id, CLIENT, { signal: request.signal }),
    );
    expect(await events.next()).toMatchObject({ value: POKE });
    const next = events.next();
    lifetime.abort();
    expect(await next).toMatchObject({ done: true });
    expect(request.signal.aborted).toBe(false);
  });

  it("cancels the event source on early consumer exit", async () => {
    const cancel = vi.fn();
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("event: poke\ndata: {}\n\n"));
        },
        cancel,
      }),
      { headers: { "Content-Type": "text/event-stream" } },
    );
    for await (const poke of await responseTransport(response).events(id(50), CLIENT)) {
      expect(poke).toEqual(POKE);
      break;
    }
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it.each(["not JSON", "[]", "null", '{"unexpected":true}'])(
    "rejects malformed poke data: %s",
    async (data) => {
      const transport = responseTransport(
        byteResponse(`event: poke\ndata: ${data}\n\n`, "text/event-stream"),
      );
      await expect(collect(await transport.events(id(50), CLIENT))).rejects.toBeInstanceOf(
        ProtocolError,
      );
    },
  );

  it("reports an event body stream failure as a network error", async () => {
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.error(new Error("disconnected"));
        },
      }),
      { headers: { "Content-Type": "text/event-stream" } },
    );
    await expect(
      collect(await responseTransport(response).events(id(50), CLIENT)),
    ).rejects.toMatchObject({ name: "NetworkError", status: 200 });
  });
});

describe("HTTP and network errors", () => {
  it.each(methods)(
    "maps authentication, access, protocol and unavailable errors for %s",
    async (method) => {
      for (const [status, ErrorType] of [
        [401, UnauthorizedError],
        [403, AccessError],
        [404, method === "me" ? ProtocolError : AccessError],
        [400, ProtocolError],
        [415, ProtocolError],
        [422, ProtocolError],
        [500, UnavailableError],
        [503, UnavailableError],
      ] as const) {
        const transport = responseTransport(Response.json({ error: "server message" }, { status }));
        const result = call(transport, method);
        await expect(result).rejects.toBeInstanceOf(ErrorType);
        await expect(result).rejects.toMatchObject({ status, message: "server message" });
      }
    },
  );

  it.each([400, 415, 422])(
    "preserves the server's push error message for HTTP %i",
    async (status) => {
      const transport = responseTransport(
        new Response("Failed to deserialize the JSON body", { status }),
      );
      await expect(transport.push(id(50), CLIENT, [label(1)])).rejects.toMatchObject({
        name: "ProtocolError",
        status,
        message: "Failed to deserialize the JSON body",
      });
    },
  );

  it("preserves real fake-server batch and extraction errors", async () => {
    const f = fixture();
    await expect(f.transport.push(f.workspace.id, CLIENT, [])).rejects.toMatchObject({
      name: "ProtocolError",
      status: 400,
      message: expect.any(String),
    });
    await expect(
      f.transport.push(f.workspace.id, CLIENT, [{ ...label(1), at: "invalid" }]),
    ).rejects.toMatchObject({
      name: "ProtocolError",
      status: 422,
      message: expect.stringContaining("Failed to deserialize"),
    });
  });

  it("maps a plain-text 503 push failure as unavailable rather than a partial result", async () => {
    const transport = responseTransport(
      new Response("upstream unavailable", {
        status: 503,
        headers: { "Retry-After": "5" },
      }),
    );
    await expect(transport.push(id(50), CLIENT, [label(1)])).rejects.toMatchObject({
      name: "UnavailableError",
      status: 503,
      retryAfter: 5,
      message: "upstream unavailable",
    });
  });

  it.each([undefined, "5", "0", "invalid", "-1", "1.5"])(
    "parses Retry-After seconds %s on 500 and 503",
    async (retry) => {
      for (const status of [500, 503]) {
        const headers = new Headers();
        if (retry !== undefined) headers.set("Retry-After", retry);
        const transport = responseTransport(Response.json({ error: "busy" }, { status, headers }));
        await expect(transport.pull(id(50), CLIENT, null)).rejects.toMatchObject({
          name: "UnavailableError",
          status,
          message: "busy",
          retryAfter: retry === "5" ? 5 : retry === "0" ? 0 : null,
        });
      }
    },
  );

  it.each(["bootstrap", "pull"] as const)(
    "maps the fake's unavailable %s fault without retrying",
    async (route) => {
      const f = fixture();
      f.server.inject({ kind: "unavailable", route });
      const result =
        route === "bootstrap"
          ? f.transport.bootstrap(f.workspace.id, CLIENT)
          : f.transport.pull(f.workspace.id, CLIENT, null);
      await expect(result).rejects.toMatchObject({
        name: "UnavailableError",
        status: 503,
        retryAfter: 5,
        message: "service unavailable",
      });
      expect(f.fetch).toHaveBeenCalledTimes(1);
    },
  );

  it("maps real fake-server authentication, membership and missing-workspace errors", async () => {
    const f = fixture();
    await expect(f.transport.pull(id(999), CLIENT, null)).rejects.toMatchObject({
      name: "AccessError",
      status: 403,
    });
    f.server.removeMember(f.workspace.id, f.owner.id);
    await expect(f.transport.pull(f.workspace.id, CLIENT, null)).rejects.toMatchObject({
      name: "AccessError",
      status: 403,
    });
    f.server.logout(f.token);
    await expect(f.transport.me()).rejects.toMatchObject({
      name: "UnauthorizedError",
      status: 401,
      message: "authentication required",
    });
  });

  it.each(methods)("maps fetch rejection for %s without retrying", async (method) => {
    const cause = new TypeError("offline");
    const fetch = vi.fn(async () => {
      throw cause;
    });
    await expect(call(createTransport({ fetch }), method)).rejects.toMatchObject({
      name: "NetworkError",
      status: null,
      cause,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("reports a dropped push response after the mutation committed", async () => {
    const f = fixture();
    f.server.inject({ kind: "drop_response", route: "push" });
    await expect(f.transport.push(f.workspace.id, CLIENT, [label(1)])).rejects.toBeInstanceOf(
      NetworkError,
    );
    expect(f.server.clientState(CLIENT)).toEqual({ last_mutation_id: 1 });
    expect(f.server.record("labels", id(101))).toMatchObject({ name: "Label 1" });
    expect(f.fetch).toHaveBeenCalledTimes(1);
  });

  it.each(["me", "pull", "scope", "push"] as const)(
    "maps a failed JSON body stream for %s",
    async (method) => {
      const response = new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.error(new Error("connection lost"));
          },
        }),
      );
      await expect(call(responseTransport(response), method)).rejects.toMatchObject({
        name: "NetworkError",
        status: 200,
      });
    },
  );
});

describe("response shape validation", () => {
  const pull = {
    cursor: "opaque cursor",
    more: false,
    reset: false,
    last_mutation_id: 0,
    changes: [],
  };
  it.each([
    null,
    [],
    {},
    { ...pull, more: "yes" },
    { ...pull, reset: 0 },
    { ...pull, cursor: null },
    { ...pull, last_mutation_id: "0" },
    { ...pull, changes: {} },
    { ...pull, changes: [{ id: "1", record: {} }] },
    { ...pull, changes: [{ entity: "unknown", id: "1", record: {} }] },
    { ...pull, changes: [{ entity: "issues", record: {} }] },
    { ...pull, changes: [{ entity: "issues", id: "1" }] },
    { ...pull, changes: [{ entity: "issues", id: "1", record: [] }] },
    { ...pull, more: true },
    { ...pull, reset: true },
  ])("rejects malformed pull responses: %j", async (value) => {
    await expect(
      responseTransport(Response.json(value)).pull(id(50), CLIENT, null),
    ).rejects.toBeInstanceOf(ProtocolError);
  });

  it.each([
    null,
    [],
    {},
    { last_mutation_id: "1", results: [] },
    { last_mutation_id: 1, results: {} },
    { last_mutation_id: 1, results: [{}] },
    { last_mutation_id: 1, results: [{ id: 0, status: "applied" }] },
    { last_mutation_id: 1, results: [{ id: 1, status: "unknown" }] },
    { last_mutation_id: 1, results: [{ id: 1, status: "rejected" }] },
    {
      last_mutation_id: 1,
      results: [{ id: 1, status: "rejected", error: { status: "400", message: "bad" } }],
    },
    {
      last_mutation_id: 1,
      results: [{ id: 1, status: "rejected", error: { status: 400, message: null } }],
    },
  ])("rejects malformed successful and partial push responses: %j", async (value) => {
    for (const status of [200, 503])
      await expect(
        responseTransport(Response.json(value, { status })).push(id(50), CLIENT, [label(1)]),
      ).rejects.toBeInstanceOf(ProtocolError);
  });

  it.each([
    null,
    [],
    {},
    { records: null },
    { records: [null] },
    { records: [[]] },
    { records: ["record"] },
  ])("rejects malformed scope responses: %j", async (value) => {
    await expect(
      responseTransport(Response.json(value)).scope(id(50), CLIENT, COMMENT_SCOPE),
    ).rejects.toBeInstanceOf(ProtocolError);
  });

  it("validates the session id, profile fields and nested alert preferences", async () => {
    const f = fixture();
    const profile = { ...f.owner, session_id: "session" };
    for (const key of Object.keys(profile)) {
      const malformed: Record<string, unknown> = { ...profile };
      delete malformed[key];
      await expect(responseTransport(Response.json(malformed)).me()).rejects.toBeInstanceOf(
        ProtocolError,
      );
    }
    for (const malformed of [
      { ...profile, alerts: [] },
      { ...profile, alerts: { ...profile.alerts, replies: "yes" } },
      { ...profile, language: "unknown" },
      { ...profile, theme: "unknown" },
    ])
      await expect(responseTransport(Response.json(malformed)).me()).rejects.toBeInstanceOf(
        ProtocolError,
      );
  });

  it.each(["me", "pull", "scope", "push"] as const)(
    "rejects malformed JSON for %s",
    async (method) => {
      await expect(call(responseTransport(new Response("{")), method)).rejects.toBeInstanceOf(
        ProtocolError,
      );
    },
  );

  it.each(["bootstrap", "events"] as const)(
    "rejects the wrong stream content type for %s",
    async (method) => {
      await expect(call(responseTransport(Response.json({})), method)).rejects.toBeInstanceOf(
        ProtocolError,
      );
    },
  );

  it.each(["bootstrap", "events"] as const)(
    "cancels an invalid %s stream before rejecting",
    async (method) => {
      const cancel = vi.fn();
      const response = new Response(new ReadableStream<Uint8Array>({ cancel }), {
        headers: { "Content-Type": "application/json" },
      });
      await expect(call(responseTransport(response), method)).rejects.toBeInstanceOf(ProtocolError);
      expect(cancel).toHaveBeenCalledTimes(1);
    },
  );
});

describe("bootstrap EOF boundaries", () => {
  it("rejects a complete malformed line as protocol failure", async () => {
    const snapshot = await responseTransport(
      byteResponse(`${JSON.stringify(HEADER)}\n{broken}\n`, "application/x-ndjson"),
    ).bootstrap(id(50), CLIENT);
    await expect(collect(snapshot.records)).rejects.toBeInstanceOf(ProtocolError);
  });

  it("classifies EOF in the header as truncation", async () => {
    await expect(
      responseTransport(byteResponse('{"cursor":"cut', "application/x-ndjson")).bootstrap(
        id(50),
        CLIENT,
      ),
    ).rejects.toBeInstanceOf(TruncatedError);
  });

  it("classifies an incomplete UTF-8 character at EOF as truncation", async () => {
    const prefix = new TextEncoder().encode(
      `${JSON.stringify(HEADER)}\n{"entity":"workspace","record":{"name":"ą`,
    );
    const transport = responseTransport(
      new Response(prefix.slice(0, -1), { headers: { "Content-Type": "application/x-ndjson" } }),
    );
    const snapshot = await transport.bootstrap(id(50), CLIENT);
    await expect(collect(snapshot.records)).rejects.toBeInstanceOf(TruncatedError);
  });

  it("keeps failed partial push bodies classified as unavailable", async () => {
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.error(new Error("body lost"));
        },
      }),
      { status: 503, headers: { "Retry-After": "5" } },
    );
    await expect(
      responseTransport(response).push(id(50), CLIENT, [label(1)]),
    ).rejects.toMatchObject({ name: "UnavailableError", status: 503, retryAfter: 5 });
  });
});
