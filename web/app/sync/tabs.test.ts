import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { setCsrf } from "../lib/api";
import { createEngine, OutdatedError, SCHEMA } from "./engine";
import type { EngineEvent, EngineSignal, SyncEngine, TabMessage } from "./engine";
import { IDB_VERSION, IndexedDBReplicaStorage } from "./persistence/idb";
import { recordKey } from "./persistence/shared";
import { BOOTSTRAP_ENTITIES, normalize } from "./records";
import { createFakeServer } from "./testing/fake-server";
import type { FakeServerOptions } from "./testing/fake-server";
import { createTabHub } from "./testing/tabs";
import type { TabHub } from "./testing/tabs";
import { createTransport, NetworkError, ProtocolError } from "./transport";

const id = (n: number) => `11111111-1111-4111-8111-${n.toString(16).padStart(12, "0")}`;
const TEAM = id(1);
const ISSUE = id(2);
const SESSION = id(4);
const engines: SyncEngine[] = [];
const servers: ReturnType<typeof createFakeServer>[] = [];

class Signals {
  private online = true;
  private readonly listeners = new Set<(signal: EngineSignal) => void>();
  getOnline = () => this.online;
  subscribe = (listener: (signal: EngineSignal) => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  send(signal: EngineSignal) {
    if (signal === "online" || signal === "offline") this.online = signal === "online";
    for (const listener of this.listeners) listener(signal);
  }
}

async function flush() {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function until(check: () => boolean) {
  for (let step = 0; step < 1000; step += 1) {
    if (check()) return;
    await flush();
  }
  expect(check(), "scenario did not reach its expected state").toBe(true);
}

interface Tab {
  engine: SyncEngine;
  fetch: ReturnType<typeof vi.fn>;
  events: EngineEvent[];
}

function fixture(count = 2, options: FakeServerOptions = {}) {
  let faultSeed = 0x5eed;
  const server = createFakeServer({
    random: () => {
      faultSeed = (Math.imul(faultSeed, 1664525) + 1013904223) >>> 0;
      return faultSeed / 0x1_0000_0000;
    },
    ...options,
  });
  servers.push(server);
  const owner = server.addUser();
  const peer = server.addUser();
  const workspace = server.addWorkspace();
  server.addMember(workspace.id, owner, "owner");
  server.addMember(workspace.id, peer);
  server.run(owner, {
    type: "create_team",
    id: TEAM,
    name: "Team",
    key: "TEA",
    members: [owner.id, peer.id],
    default_stage_ids: [id(10), id(11), id(12), id(13)],
  });
  server.run(owner, {
    type: "create_issue",
    input: { id: ISSUE, team_id: TEAM, title: "Original" },
  });
  const token = server.login(owner);
  setCsrf(server.csrfToken(token));
  // One browser: every tab shares the session cookie, the database, the lock and the channel.
  const hub: TabHub = createTabHub();
  const database = new IDBFactory();
  let sequence = 100;
  const tabs: Tab[] = [];
  const addTab = (): Tab => {
    const fetch = vi.fn(server.fetch);
    const transport = createTransport({
      fetch,
      headers: () => ({ cookie: `blackwall_session=${token}` }),
    });
    const signals = new Signals();
    const events: EngineEvent[] = [];
    const engine = createEngine({
      storage: new IndexedDBReplicaStorage({ indexedDB: database }),
      transport,
      actor: owner.id,
      sessionId: SESSION,
      workspaceId: workspace.id,
      schema: SCHEMA,
      clock: { now: server.now, schedule: server.schedule },
      randomId: () => id(sequence++),
      signals,
      locks: hub.locks,
      channel: hub.channel,
    });
    engine.subscribe((event) => events.push(event));
    engines.push(engine);
    const tab = { engine, fetch, events };
    tabs.push(tab);
    return tab;
  };
  for (let index = 0; index < count; index += 1) addTab();
  const advance = async (ms: number) => {
    server.advance(ms);
    await flush();
  };
  const roles = (): { leader: Tab; follower: Tab } => {
    const leader = tabs.find((tab) => tab.engine.status.get().role === "leader");
    const follower = tabs.find((tab) => tab.engine.status.get().role === "follower");
    if (!leader || !follower) throw new Error("expected one leader and one follower");
    return { leader, follower };
  };
  const requests = (tab: Tab) => tab.fetch.mock.calls.length;
  const pushes = (tab: Tab): { id: number }[][] =>
    tab.fetch.mock.calls
      .filter(([url]) => String(url).includes("/push?"))
      .map(([, init]) => JSON.parse(String(init?.body)).mutations);
  const start = async () => {
    for (const tab of tabs) await tab.engine.start();
    await until(() => roles().leader.engine.status.get().phase === "ready");
    await until(() => tabs.every((tab) => tab.engine.status.get().connected));
  };
  const open = () => tabs.filter((tab) => !tab.engine.isClosed());
  const settleAll = () => until(() => open().every((tab) => tab.engine.status.get().pending === 0));
  /** Each tab's store must equal the server's view for that user, entity by entity. */
  const converged = (tab: Tab) => {
    for (const entity of BOOTSTRAP_ENTITIES) {
      const sort = (rows: readonly object[]) =>
        [...rows].sort((a, b) => recordKey(entity, a).localeCompare(recordKey(entity, b)));
      expect(sort(tab.engine.store.all(entity))).toEqual(
        sort(server.records(entity, owner.id).map((row) => normalize(entity, row))),
      );
    }
  };
  return {
    server,
    owner,
    peer,
    workspaceId: workspace.id,
    database,
    hub,
    tabs,
    addTab,
    open,
    roles,
    requests,
    pushes,
    start,
    advance,
    settleAll,
    converged,
  };
}

afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.close();
  for (const server of servers.splice(0)) server.close();
});

describe("tab coordination", () => {
  it("reports the role, and only the leader makes network requests", async () => {
    const f = fixture(2);
    await f.start();
    const { leader, follower } = f.roles();
    expect(leader.engine.status.get().role).toBe("leader");
    expect(follower.engine.status.get().role).toBe("follower");
    await follower.engine.pull();
    await f.advance(60_000);
    expect(f.requests(follower)).toBe(0);
    expect(f.requests(leader)).toBeGreaterThan(0);
  });

  it("shows a follower's edit at once, pushes it from the leader, and settles it applied", async () => {
    const f = fixture(2);
    await f.start();
    const { leader, follower } = f.roles();
    const receipt = await follower.engine.mutate("update_issue", {
      id: ISSUE,
      patch: { title: "From tab" },
    });
    expect(follower.engine.store.get("issues", ISSUE)?.title).toBe("From tab");
    await until(() => leader.engine.store.get("issues", ISSUE)?.title === "From tab");
    expect(await receipt.settled).toBe("applied");
    expect(
      f
        .pushes(leader)
        .flat()
        .map((mutation) => mutation.id),
    ).toContain(receipt.mutationId);
    expect(f.pushes(follower)).toEqual([]);
    expect(f.server.record("issues", ISSUE)?.title).toBe("From tab");
    await f.settleAll();
  });

  it("gives concurrent edits from two tabs distinct ids, pushes them in order, and converges", async () => {
    const f = fixture(2);
    await f.start();
    const { leader, follower } = f.roles();
    const [fromFollower, fromLeader] = await Promise.all([
      follower.engine.mutate("create_label", { name: "From follower", color: "#00ff00" }),
      leader.engine.mutate("update_issue", { id: ISSUE, patch: { title: "From leader" } }),
    ]);
    expect(fromFollower.mutationId).not.toBe(fromLeader.mutationId);
    expect(await Promise.all([fromFollower.settled, fromLeader.settled])).toEqual([
      "applied",
      "applied",
    ]);
    const ids = f
      .pushes(leader)
      .flat()
      .map((mutation) => mutation.id);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    expect(ids).toEqual(expect.arrayContaining([fromFollower.mutationId, fromLeader.mutationId]));
    await f.settleAll();
    for (const tab of f.tabs) f.converged(tab);
  });

  it("reports a follower's rejection only in the follower, and reverts both views", async () => {
    const f = fixture(2);
    await f.start();
    const { leader, follower } = f.roles();
    // Hold the appended message so the server learns of the collision before the push.
    f.hub.hold();
    const receipt = await follower.engine.mutate("create_label", {
      name: "Predicted",
      color: "#ff0000",
    });
    f.server.run(f.owner, {
      type: "create_label",
      id: receipt.id ?? "",
      name: "Authoritative",
      color: "#000000",
    });
    f.hub.release();
    expect(await receipt.settled).toEqual({
      id: receipt.mutationId,
      status: 409,
      message: "id already exists",
      command: { name: "create_label", args: expect.objectContaining({ name: "Predicted" }) },
    });
    await f.settleAll();
    expect(follower.events.filter((event) => event.type === "rejected")).toHaveLength(1);
    expect(leader.events.filter((event) => event.type === "rejected")).toHaveLength(0);
    for (const tab of f.tabs)
      expect(tab.engine.store.get("labels", receipt.id ?? "")?.name).toBe("Authoritative");
  });

  it("lets a follower take over with mutations in the closed leader's outbox", async () => {
    const f = fixture(2);
    await f.start();
    const { leader, follower } = f.roles();
    // The leader's push commits on the server, but its response is delayed past the leader's close.
    f.server.inject({ kind: "response_delay", route: "push", milliseconds: 500 });
    void leader.engine.mutate("update_issue", { id: ISSUE, patch: { title: "Left behind" } });
    await until(() => f.pushes(leader).length === 1);
    const second = await follower.engine.mutate("create_label", {
      name: "Second",
      color: "#0000ff",
    });
    await leader.engine.close();
    await until(() => follower.engine.status.get().role === "leader");
    expect(await second.settled).toBe("applied");
    await f.settleAll();
    expect(f.server.record("issues", ISSUE)?.title).toBe("Left behind");
    for (const tab of f.open()) f.converged(tab);
  });

  it("pushes a follower's mutation from the database when its appended message is lost", async () => {
    const f = fixture(2);
    await f.start();
    const { leader, follower } = f.roles();
    f.hub.drop("appended");
    const receipt = await follower.engine.mutate("update_issue", {
      id: ISSUE,
      patch: { title: "Lost message" },
    });
    expect(leader.engine.store.pending()).toEqual([]);
    // A pull ends with a push request, and that push reads the outbox from the database.
    await leader.engine.pull();
    expect(await receipt.settled).toBe("applied");
    await until(() => leader.engine.store.get("issues", ISSUE)?.title === "Lost message");
    await f.settleAll();
  });

  it("sends a follower's online command directly and completes across a leader handover", async () => {
    const f = fixture(2);
    await f.start();
    const { leader, follower } = f.roles();
    const scope = { entity: "comments", issueId: ISSUE } as const;
    const release = follower.engine.useScope(scope);
    await until(() => follower.engine.scopeStatus(scope) === "loaded");
    expect(f.requests(follower)).toBe(0);
    f.server.inject({ kind: "response_delay", route: "commands", milliseconds: 500 });
    const online = follower.engine.runOnline("set_role", { user_id: f.peer.id, role: "admin" });
    await until(() => follower.fetch.mock.calls.some(([url]) => String(url).endsWith("/commands")));
    await until(() => f.server.record("members", f.peer.id)?.role === "admin");
    expect(leader.fetch.mock.calls.some(([url]) => String(url).endsWith("/commands"))).toBe(false);
    await leader.engine.close();
    await until(() => follower.engine.status.get().role === "leader");
    await f.advance(500);
    expect(await online).toMatchObject({ status: "applied" });
    release();
  });

  it("rejects a follower's online call when the leader's push is blocked", async () => {
    const f = fixture(2);
    await f.start();
    const { leader, follower } = f.roles();
    leader.fetch.mockImplementation(async (input, init) =>
      String(input).includes("/push?")
        ? Response.json({ results: null })
        : f.server.fetch(input, init),
    );
    await follower.engine.mutate("update_issue", { id: ISSUE, patch: { title: "Stuck" } });
    await until(() => leader.engine.status.get().lastError instanceof ProtocolError);
    const online = follower.engine.runOnline("set_role", { user_id: f.peer.id, role: "admin" });
    await expect(online).rejects.toThrow("Reload");
    expect(follower.fetch.mock.calls.some(([url]) => String(url).endsWith("/commands"))).toBe(
      false,
    );
  });

  it("retains a tab reply for two resend intervals and resets expiry on repeats", async () => {
    const f = fixture(2);
    await f.start();
    const { leader } = f.roles();
    const load = vi.spyOn(leader.engine, "useScope");
    const channel = f.hub.channel(`blackwall-sync:${SESSION}:${f.workspaceId}`);
    const request = {
      type: "request",
      requestId: "repeated-scope",
      kind: "loadScope",
      scope: { entity: "comments", issueId: ISSUE },
      from: id(999),
    } satisfies TabMessage;
    channel.postMessage(request);
    await until(() => f.hub.sent("reply") === 1);
    expect(load).toHaveBeenCalledOnce();
    await f.advance(1500);
    channel.postMessage(request);
    await until(() => f.hub.sent("reply") === 2);
    await f.advance(1500);
    channel.postMessage(request);
    await until(() => f.hub.sent("reply") === 3);
    expect(load).toHaveBeenCalledOnce();
    channel.close();
  });

  it("expires a tab reply and harmlessly loads the scope again on a late repeat", async () => {
    const f = fixture(2);
    await f.start();
    const { leader } = f.roles();
    const load = vi.spyOn(leader.engine, "useScope");
    const channel = f.hub.channel(`blackwall-sync:${SESSION}:${f.workspaceId}`);
    const request = {
      type: "request",
      requestId: "late-scope",
      kind: "loadScope",
      scope: { entity: "comments", issueId: ISSUE },
      from: id(999),
    } satisfies TabMessage;
    channel.postMessage(request);
    await until(() => f.hub.sent("reply") === 1);
    const before = leader.engine.store.baseAll("comments");
    await f.advance(2000);
    channel.postMessage(request);
    await until(() => f.hub.sent("reply") === 2);
    expect(load).toHaveBeenCalledTimes(2);
    expect(leader.engine.store.baseAll("comments")).toEqual(before);
    expect(leader.engine.scopeStatus(request.scope)).toBe("loaded");
    f.converged(leader);
    channel.close();
  });

  it("keeps an unanswered tab request until its first reply is sent", async () => {
    const f = fixture(2);
    await f.start();
    const { leader } = f.roles();
    const load = vi.spyOn(leader.engine, "useScope");
    const channel = f.hub.channel(`blackwall-sync:${SESSION}:${f.workspaceId}`);
    const request = {
      type: "request",
      requestId: "pending-scope",
      kind: "loadScope",
      scope: { entity: "comments", issueId: ISSUE },
      from: id(999),
    } satisfies TabMessage;
    f.server.inject({ kind: "response_delay", route: "scope", milliseconds: 5000 });
    channel.postMessage(request);
    await until(() => leader.fetch.mock.calls.some(([url]) => String(url).includes("/scope?")));
    await flush();
    await f.advance(3000);
    channel.postMessage(request);
    await flush();
    expect(f.hub.sent("reply")).toBe(0);
    expect(load).toHaveBeenCalledOnce();
    await f.advance(2000);
    await until(() => f.hub.sent("reply") === 2);
    expect(load).toHaveBeenCalledOnce();
    channel.close();
  });

  it("doesn't keep holding a follower's scope on the leader after answering", async () => {
    const f = fixture(2);
    await f.start();
    const { leader, follower } = f.roles();
    const scope = { entity: "comments", issueId: ISSUE } as const;
    const scopeReads = () =>
      leader.fetch.mock.calls.filter(([url]) => String(url).includes("/scope?")).length;
    const release = follower.engine.useScope(scope);
    await until(() => follower.engine.scopeStatus(scope) === "loaded");
    release();
    const reads = scopeReads();
    f.server.inject({ kind: "reset_pull" });
    await leader.engine.pull();
    await until(() => leader.engine.scopeStatus(scope) === "loading");
    await f.advance(1000);
    expect(scopeReads()).toBe(reads);
  });

  it("shows the leader's push failure in a follower while it retries", async () => {
    const f = fixture(2);
    await f.start();
    const { leader, follower } = f.roles();
    leader.fetch.mockImplementation((input: RequestInfo | URL, init?: RequestInit) =>
      String(input).includes("/push?")
        ? Promise.reject(new TypeError("Failed to fetch"))
        : f.server.fetch(input, init),
    );
    await follower.engine.mutate("update_issue", { id: ISSUE, patch: { title: "Waiting" } });
    await until(() => follower.engine.status.get().lastError !== null);
    expect(follower.engine.status.get().lastError).toBeInstanceOf(NetworkError);
    // A successful pull doesn't hide a push that keeps failing.
    await leader.engine.pull();
    expect(follower.engine.status.get().lastError).toBeInstanceOf(NetworkError);
    leader.fetch.mockImplementation(f.server.fetch);
    await f.advance(2000);
    await f.settleAll();
    await until(() => follower.engine.status.get().lastError === null);
  });

  it("loads a scope the leader already holds from the database for a follower", async () => {
    const f = fixture(2);
    await f.start();
    const { leader, follower } = f.roles();
    const scope = { entity: "comments", issueId: ISSUE } as const;
    // The follower misses every page while the leader loads the scope, so it can learn of the scope
    // only by asking.
    f.hub.drop("pulled", 1000);
    const leaderRelease = leader.engine.useScope(scope);
    await until(() => leader.engine.scopeStatus(scope) === "loaded");
    const release = follower.engine.useScope(scope);
    await until(() => follower.engine.scopeStatus(scope) === "loaded");
    release();
    leaderRelease();
  });

  it("gives a follower a scope the leader holds from the database, without a reset message", async () => {
    const f = fixture(2);
    await f.start();
    const { leader, follower } = f.roles();
    const scope = { entity: "comments", issueId: ISSUE } as const;
    f.server.run(f.owner, {
      type: "add_comment",
      id: id(50),
      issue_id: ISSUE,
      body: "Loaded",
      attachments: [],
      mentions: [],
    });
    f.hub.drop("pulled", 1000);
    const leaderRelease = leader.engine.useScope(scope);
    await until(() => leader.engine.scopeStatus(scope) === "loaded");
    const resets = f.hub.sent("reset");
    const release = follower.engine.useScope(scope);
    await until(() => follower.engine.scopeStatus(scope) === "loaded");
    expect(f.hub.sent("reset")).toBe(resets);
    expect(follower.engine.store.baseAll("comments").map((comment) => comment.id)).toEqual([
      id(50),
    ]);
    release();
    leaderRelease();
  });

  it("reports a scope the leader failed to load as an error in the follower", async () => {
    const f = fixture(2);
    await f.start();
    const { leader, follower } = f.roles();
    const scope = { entity: "comments", issueId: ISSUE } as const;
    f.server.inject({ kind: "scope_error" });
    const release = follower.engine.useScope(scope);
    await until(() => follower.engine.scopeStatus(scope) === "error");
    expect(follower.engine.scopeError(scope)?.message).toBe("scope rejected");
    expect(leader.engine.scopeStatus(scope)).toBe("error");
    release();
  });

  it("asks the next leader again for a scope the old leader never loaded", async () => {
    // Tabs added after the first is ready get no bootstrap reset to replay later.
    const f = fixture(1);
    const [first] = f.tabs;
    await first.engine.start();
    await until(() => first.engine.status.get().phase === "ready");
    const next = f.addTab();
    const holder = f.addTab();
    // Lock requests are granted in order, so `next` leads after `first` closes.
    await next.engine.start();
    await holder.engine.start();
    await until(() => f.tabs.every((tab) => tab.engine.status.get().connected));
    const scope = { entity: "comments", issueId: ISSUE } as const;
    const scopeRequests = (tab: Tab) =>
      tab.fetch.mock.calls.filter(([url]) => String(url).includes("/scope?")).length;
    // The old leader's load is answered only after it closes, so the holder's request is answered
    // without the scope being loaded.
    f.server.inject({ kind: "response_delay", route: "scope", milliseconds: 500 });
    const release = holder.engine.useScope(scope);
    await until(() => scopeRequests(first) === 1);
    await first.engine.close();
    await until(() => next.engine.status.get().role === "leader");
    await until(() => holder.engine.scopeStatus(scope) === "loaded");
    release();
  });

  it("ends the session in every tab when the leader gets 401", async () => {
    const f = fixture(2, { sessionLifetimeMs: 1000 });
    await f.start();
    const { leader, follower } = f.roles();
    await f.advance(2000);
    void leader.engine.pull();
    await until(() => leader.events.some((event) => event.type === "unauthorized"));
    await until(() => follower.events.some((event) => event.type === "unauthorized"));
    expect(leader.engine.status.get().phase).toBe("loading");
    expect(follower.engine.status.get().phase).toBe("loading");
    expect(follower.engine.store.all("issues")).toEqual([]);
    const requests = f.requests(leader);
    await f.advance(60_000);
    expect(f.requests(leader)).toBe(requests);
  });

  it("ends the session in every tab when the leader gets 403", async () => {
    const f = fixture(2);
    await f.start();
    const { leader, follower } = f.roles();
    f.server.removeMember(f.workspaceId, f.owner.id);
    void leader.engine.pull();
    await until(() => leader.events.some((event) => event.type === "accessLost"));
    await until(() => follower.events.some((event) => event.type === "accessLost"));
    expect(follower.engine.store.all("issues")).toEqual([]);
    expect(leader.events.filter((event) => event.type === "unauthorized")).toEqual([]);
  });

  it("an upgrade makes both old tabs readable but unwritable and releases their leadership", async () => {
    const f = fixture(2);
    await f.start();
    await until(() =>
      f.tabs.every((tab) => tab.engine.store.get("issues", ISSUE)?.title === "Original"),
    );
    const views = f.tabs.map((tab) => tab.engine.store.all("issues"));
    const upgraded = await new IndexedDBReplicaStorage({
      indexedDB: f.database,
      version: IDB_VERSION + 1,
    }).open({
      sessionId: SESSION,
      workspaceId: f.workspaceId,
      schema: SCHEMA,
    });
    try {
      for (const [index, tab] of f.tabs.entries()) {
        expect(tab.events).toEqual([{ type: "outdated" }]);
        expect(tab.engine.store.all("issues")).toEqual(views[index]);
        await expect(tab.engine.mutate("mark_all_notifications_read", {})).rejects.toBeInstanceOf(
          OutdatedError,
        );
      }
      const nextLeader = vi.fn(async () => {});
      await f.hub.locks.request(`blackwall-sync:${SESSION}:${f.workspaceId}`, nextLeader);
      expect(nextLeader).toHaveBeenCalledOnce();
      const requests = f.tabs.map(f.requests);
      await f.advance(60_000);
      expect(f.tabs.map(f.requests)).toEqual(requests);
      // The newer code can still end the session in the old tabs through the channel.
      const channel = f.hub.channel(`blackwall-sync:${SESSION}:${f.workspaceId}`);
      channel.postMessage({ type: "unauthorized", from: "newer-tab" });
      await until(() =>
        f.tabs.every((tab) => tab.events.some((event) => event.type === "unauthorized")),
      );
      expect(f.tabs.every((tab) => tab.engine.store.all("issues").length === 0)).toBe(true);
      channel.close();
    } finally {
      upgraded.close();
    }
  });

  it("stops a follower whose database is deleted under it and reports access loss", async () => {
    const f = fixture(2);
    await f.start();
    const { follower } = f.roles();
    await new IndexedDBReplicaStorage({ indexedDB: f.database }).delete({
      sessionId: SESSION,
      workspaceId: f.workspaceId,
    });
    await until(() => follower.events.some((event) => event.type === "accessLost"));
    expect(follower.engine.status.get().phase).toBe("loading");
    expect(follower.engine.store.all("issues")).toEqual([]);
  });

  it("applies a leader's pulled changes and reset to a follower's view", async () => {
    const f = fixture(2);
    await f.start();
    const { leader, follower } = f.roles();
    f.server.run(f.peer, { type: "update_issue", id: ISSUE, patch: { title: "Peer edit" } });
    await f.advance(1000);
    await until(() => follower.engine.store.get("issues", ISSUE)?.title === "Peer edit");
    f.server.inject({ kind: "reset_pull" });
    void leader.engine.pull();
    await until(() => leader.engine.status.get().phase === "ready");
    f.server.run(f.peer, { type: "update_issue", id: ISSUE, patch: { title: "After reset" } });
    await f.advance(1000);
    await until(() => follower.engine.store.get("issues", ISSUE)?.title === "After reset");
    await f.settleAll();
    for (const tab of f.tabs) f.converged(tab);
  });
});
