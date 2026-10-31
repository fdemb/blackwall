import "fake-indexeddb/auto";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { createEngine, SCHEMA, type SyncEngine } from "../sync/engine";
import { EngineProvider } from "../sync/react";
import { MemoryReplicaStorage } from "../sync/persistence/memory";
import type { Scope } from "../sync/persistence/types";
import { createFakeServer } from "../sync/testing/fake-server";
import { createTransport } from "../sync/transport";
import { setCsrf } from "./api";
import { useActivity, useComments, useIssueIntent } from "./queries";

const id = (n: number) => `11111111-1111-4111-8111-${String(n).padStart(12, "0")}`;
const engines: SyncEngine[] = [];
const servers: ReturnType<typeof createFakeServer>[] = [];
const COMMENTS: Scope = { entity: "comments", issueId: id(2) };
const ACTIVITY: Scope = { entity: "activity", entityId: id(2) };

async function until(check: () => boolean) {
  for (let step = 0; step < 500; step += 1) {
    if (check()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  expect(check()).toBe(true);
}

async function settle() {
  for (let step = 0; step < 50; step += 1)
    await new Promise<void>((resolve) => setImmediate(resolve));
}

type Server = ReturnType<typeof createFakeServer>;
function fixture(wrap: (server: Server) => typeof server.fetch = (server) => server.fetch) {
  const server = createFakeServer();
  servers.push(server);
  const owner = server.addUser();
  const workspace = server.addWorkspace();
  server.addMember(workspace.id, owner, "owner");
  server.run(owner, {
    type: "create_team",
    id: id(1),
    name: "Team",
    key: "TEA",
    members: [],
    default_stage_ids: [id(10), id(11), id(12), id(13)],
  });
  server.run(owner, { type: "create_issue", input: { id: id(2), title: "Issue", team_id: id(1) } });
  server.run(owner, {
    type: "add_comment",
    id: id(3),
    issue_id: id(2),
    body: "First",
    attachments: [],
    mentions: [],
  });
  const token = server.login(owner);
  setCsrf(server.csrfToken(token));
  const headers = () => ({ cookie: `blackwall_session=${token}` });
  const serve = wrap(server);
  const scopeRequests: string[] = [];
  const engine = createEngine({
    storage: new MemoryReplicaStorage(),
    transport: createTransport({
      fetch: (input, init) => {
        if (String(input).includes("/scope?")) scopeRequests.push(String(input));
        return serve(input, init);
      },
      headers,
      userId: owner.id,
    }),
    workspaceId: workspace.id,
    actor: owner.id,
    schema: SCHEMA,
    randomId: () => crypto.randomUUID(),
    clock: { now: server.now, monotonic: server.monotonic, schedule: server.schedule },
    signals: { getOnline: () => true, subscribe: () => () => {} },
  });
  engines.push(engine);
  return { server, engine, scopeRequests };
}

function Probe() {
  const comments = useComments(id(2));
  const activity = useActivity(id(2));
  return (
    <pre>
      {JSON.stringify({
        comments: {
          loading: comments.loading,
          error: comments.error,
          length: comments.items.length,
        },
        activity: { loading: activity.loading, error: activity.error },
      })}
    </pre>
  );
}

type Intent = ReturnType<typeof useIssueIntent>;
function IntentProbe({ onRender }: { onRender: (intent: Intent) => void }) {
  onRender(useIssueIntent(id(2)));
  return null;
}

function render(engine: SyncEngine) {
  const html = renderToStaticMarkup(
    <EngineProvider engine={engine}>
      <Probe />
    </EngineProvider>,
  );
  return JSON.parse((html.match(/<pre>(.*?)<\/pre>/s)?.[1] ?? "").replaceAll("&quot;", '"'));
}

afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.close();
  for (const server of servers.splice(0)) server.close();
});

describe("scope hooks", () => {
  it("reports comments and activity as loading until their first scope load", async () => {
    const { server, engine, scopeRequests } = fixture();
    await engine.start();
    await until(() => engine.status.get().phase === "ready");
    // Scope loads share one read queue, so the held activity load waits behind this delayed one.
    server.inject({ kind: "delay", route: "scope", milliseconds: 20_000 });
    const releaseComments = engine.useScope(COMMENTS);
    const releaseActivity = engine.useScope(ACTIVITY);
    await until(() => scopeRequests.length === 1);
    expect(render(engine)).toEqual({
      comments: { loading: true, error: null, length: 0 },
      activity: { loading: true, error: null },
    });
    server.advance(20_000);
    await until(
      () => engine.scopeStatus(COMMENTS) === "loaded" && engine.scopeStatus(ACTIVITY) === "loaded",
    );
    expect(render(engine)).toEqual({
      comments: { loading: false, error: null, length: 1 },
      activity: { loading: false, error: null },
    });
    releaseComments();
    releaseActivity();
  });

  it("reports a scope blocked by a protocol error through the hook's error field", async () => {
    const { engine, server } = fixture(
      (server) => (input, init) =>
        String(input).includes("/scope?")
          ? Promise.resolve(Response.json({ records: "not a list" }))
          : server.fetch(input, init),
    );
    engine.useScope(COMMENTS);
    await engine.start();
    // The engine retries a bad scope answer with backoff before it blocks the scope.
    for (let step = 0; step < 300 && engine.scopeStatus(COMMENTS) !== "error"; step += 1) {
      server.advance(1000);
      for (let tick = 0; tick < 20; tick += 1)
        await new Promise<void>((resolve) => setImmediate(resolve));
    }
    await until(() => engine.scopeStatus(COMMENTS) === "error");
    const message = engine.scopeError(COMMENTS)?.message;
    expect(message).toBeTruthy();
    expect(render(engine)).toEqual({
      comments: { loading: false, error: message, length: 0 },
      activity: { loading: true, error: null },
    });
  });
});

describe("issue intent", () => {
  it("loads an issue's scopes once when the pointer rests on its row", async () => {
    const { engine, scopeRequests } = fixture();
    await engine.start();
    await until(() => engine.status.get().phase === "ready");
    let intent: Intent | undefined;
    renderToStaticMarkup(
      <EngineProvider engine={engine}>
        <IntentProbe onRender={(value) => (intent = value)} />
      </EngineProvider>,
    );
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      intent!.onHoverStart();
      intent!.onHoverEnd();
      vi.advanceTimersByTime(1000);
      await settle();
      expect(scopeRequests).toEqual([]);

      intent!.onHoverStart();
      vi.advanceTimersByTime(99);
      await settle();
      expect(scopeRequests).toEqual([]);
      vi.advanceTimersByTime(1);
      intent!.onPressStart();
      intent!.onHoverStart();
      vi.advanceTimersByTime(1000);
    } finally {
      vi.useRealTimers();
    }
    await until(
      () => engine.scopeStatus(COMMENTS) === "loaded" && engine.scopeStatus(ACTIVITY) === "loaded",
    );
    expect(scopeRequests).toHaveLength(2);
    expect(render(engine)).toEqual({
      comments: { loading: false, error: null, length: 1 },
      activity: { loading: false, error: null },
    });

    intent!.onPressStart();
    await settle();
    expect(scopeRequests).toHaveLength(2);
  });

  it("loads an issue's scopes once when focus rests on its row", async () => {
    const { engine, scopeRequests } = fixture();
    await engine.start();
    await until(() => engine.status.get().phase === "ready");
    let intent: Intent | undefined;
    renderToStaticMarkup(
      <EngineProvider engine={engine}>
        <IntentProbe onRender={(value) => (intent = value)} />
      </EngineProvider>,
    );
    const row = new EventTarget();
    intent!.ref(row);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      row.dispatchEvent(new Event("focus"));
      row.dispatchEvent(new Event("blur"));
      vi.advanceTimersByTime(1000);
      await settle();
      expect(scopeRequests).toEqual([]);

      row.dispatchEvent(new Event("focus"));
      vi.advanceTimersByTime(100);
    } finally {
      vi.useRealTimers();
    }
    await until(
      () => engine.scopeStatus(COMMENTS) === "loaded" && engine.scopeStatus(ACTIVITY) === "loaded",
    );
    expect(scopeRequests).toHaveLength(2);

    row.dispatchEvent(new Event("focus"));
    await new Promise((resolve) => setTimeout(resolve, 150));
    await settle();
    expect(scopeRequests).toHaveLength(2);
  });
});
