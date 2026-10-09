import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { createEngine, SCHEMA } from "./engine";
import type { EngineEvent, EngineSignal, SyncEngine } from "./engine";
import { IndexedDBReplicaStorage } from "./persistence/idb";
import { MemoryReplicaStorage } from "./persistence/memory";
import type { ReplicaStorage, Scope } from "./persistence/types";
import { BOOTSTRAP_ENTITIES, normalize } from "./records";
import { createFakeServer } from "./testing/fake-server";
import type { FakeServerOptions } from "./testing/fake-server";
import { createTransport, ProtocolError } from "./transport";
import type { Mutation } from "./transport";

const id = (n: number) => `11111111-1111-4111-8111-${n.toString(16).padStart(12, "0")}`;
const TEAM = id(1);
const ISSUE = id(2);
const OTHER_ISSUE = id(3);
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

function fixture(
  storage: ReplicaStorage = new MemoryReplicaStorage(),
  options: FakeServerOptions = {},
) {
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
    members: [owner.id, peer.id],
    default_stage_ids: [id(10), id(11), id(12), id(13)],
  });
  server.run(owner, {
    type: "create_issue",
    input: { id: ISSUE, team_id: TEAM, title: "Original" },
  });
  server.run(owner, {
    type: "create_issue",
    input: { id: OTHER_ISSUE, team_id: TEAM, title: "Other" },
  });
  const token = server.login(owner);
  const fetch = vi.fn(server.fetch);
  const transport = createTransport({
    fetch,
    headers: () => ({ authorization: `Bearer ${token}` }),
  });
  const signals = new Signals();
  let sequence = 100;
  const build = (schema = SCHEMA) => {
    const engine = createEngine({
      storage,
      transport,
      actor: owner.id,
      sessionId: SESSION,
      workspaceId: workspace.id,
      schema,
      clock: { now: server.now, schedule: server.schedule },
      randomId: () => id(sequence++),
      signals,
    });
    engines.push(engine);
    return engine;
  };
  const engine = build();
  const ready = async () => {
    await engine.start();
    await engine.pull();
    expect(engine.status.get().lastError).toBeNull();
    await until(() => engine.status.get().phase === "ready" && engine.status.get().connected);
    await engine.pull();
  };
  const pushes = (): Mutation[][] =>
    fetch.mock.calls
      .filter(([url]) => String(url).includes("/push?"))
      .map(([, init]) => JSON.parse(String(init?.body)).mutations);
  const requests = (route: string) =>
    fetch.mock.calls.filter(([url]) => String(url).includes(`/${route}?`)).length;
  const advance = async (ms: number) => {
    server.advance(ms);
    await flush();
  };
  const disk = async () => {
    const replica = await storage.open({
      sessionId: SESSION,
      workspaceId: workspace.id,
      schema: SCHEMA,
    });
    const state = await replica.load();
    replica.close();
    return state;
  };
  const authoritativeIssue = (key: string) => {
    const record = server.record("issues", key);
    if (!record) throw new Error("missing authoritative issue");
    return normalize("issues", record);
  };
  return {
    authoritativeIssue,
    server,
    owner,
    peer,
    workspace,
    storage,
    token,
    transport,
    fetch,
    signals,
    engine,
    build,
    ready,
    pushes,
    requests,
    advance,
    disk,
  };
}

afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.close();
  for (const server of servers.splice(0)) server.close();
});

describe("sync engine", () => {
  it("interprets HTTP-date Retry-After using the injected clock", async () => {
    const f = fixture();
    const original = f.server.fetch;
    f.fetch.mockImplementation(async (...args) => {
      const response = await original(...args);
      if (response.status === 503)
        response.headers.set(
          "Retry-After",
          new Date(Date.parse(f.server.now()) + 5000).toUTCString(),
        );
      return response;
    });
    f.server.inject({ kind: "unavailable", route: "bootstrap" });
    await f.engine.start();
    await until(() => f.engine.status.get().lastError !== null);
    await f.advance(4999);
    expect(f.requests("bootstrap")).toBe(1);
    await f.advance(1);
    await until(() => f.engine.status.get().phase === "ready");
    expect(f.requests("bootstrap")).toBe(2);
  });

  it("finishes persistence and store updates before beginning the next read", async () => {
    const storage = new MemoryReplicaStorage();
    const open = storage.open.bind(storage);
    let holdCommit = false;
    let releaseCommit: (() => void) | undefined;
    storage.open = async (input) => {
      const replica = await open(input);
      const apply = replica.applyPull.bind(replica);
      replica.applyPull = async (page) => {
        await apply(page);
        if (holdCommit) {
          holdCommit = false;
          await new Promise<void>((resolve) => {
            releaseCommit = resolve;
          });
        }
      };
      return replica;
    };
    const f = fixture(storage);
    await f.ready();
    holdCommit = true;
    f.server.run(f.peer, { type: "update_issue", id: ISSUE, patch: { title: "Persisted first" } });
    const before = f.requests("pull");
    const pull = f.engine.pull();
    await until(() => releaseCommit !== undefined);
    expect((await f.disk()).records.issues).toEqual(f.server.records("issues"));
    expect(f.engine.store.get("issues", ISSUE)?.title).toBe("Original");
    const releaseScope = f.engine.useScope({ entity: "activity", entityId: ISSUE });
    void f.engine.pull();
    await flush();
    expect(f.requests("pull")).toBe(before + 1);
    expect(f.requests("scope")).toBe(0);
    const observations: string[] = [];
    f.engine.store.subscribe(() =>
      observations.push(f.engine.store.get("issues", ISSUE)?.title ?? ""),
    );
    releaseCommit?.();
    await pull;
    await until(() => f.requests("scope") === 1);
    expect(observations[0]).toBe("Persisted first");
    releaseScope();
  });

  it("does not resurrect a start cancelled while opening the replica", async () => {
    const f = fixture();
    const starting = f.engine.start();
    f.engine.stop();
    await starting;
    expect(f.fetch).not.toHaveBeenCalled();
    f.signals.send("offline");
    expect(f.engine.status.get().online).toBe(false);
    await f.engine.start();
    expect(f.fetch).not.toHaveBeenCalled();
    f.signals.send("online");
    await until(() => f.engine.status.get().phase === "ready");
  });

  it("generates team and default-stage ids once and retains malformed ids for admission", async () => {
    const f = fixture();
    await f.ready();
    f.engine.stop();
    const team = await f.engine.mutate("create_team", { name: "Offline team" });
    expect(team.id).toBe(id(100));
    expect(f.engine.store.get("teams", id(100))?.stages.map((stage) => stage.id)).toEqual([
      id(101),
      id(102),
      id(103),
      id(104),
    ]);
    expect((await f.disk()).outbox[0].args).toMatchObject({
      id: id(100),
      default_stage_ids: [id(101), id(102), id(103), id(104)],
    });
    await expect(
      f.engine.mutate("create_label", { id: 7, name: "Invalid", color: "#ff0000" }),
    ).rejects.toThrow();
    expect((await f.disk()).outbox).toHaveLength(1);
    await f.engine.start();
    await team.settled;
    await until(() => f.engine.status.get().pending === 0);
    expect(f.engine.store.get("teams", id(100))).toEqual(f.server.record("teams", id(100)));
  });

  it("caps ordered push batches at 100 mutations", async () => {
    const f = fixture();
    await f.ready();
    f.engine.stop();
    await Promise.all(
      Array.from({ length: 105 }, (_, n) =>
        f.engine.mutate("update_issue", { id: ISSUE, patch: { title: `Batch ${n}` } }),
      ),
    );
    await f.engine.start();
    await until(() => f.engine.status.get().pending === 0);
    expect(f.pushes().map((batch) => batch.length)).toEqual([100, 5]);
    expect(
      f
        .pushes()
        .flat()
        .map((mutation) => mutation.id),
    ).toEqual(Array.from({ length: 105 }, (_, n) => n + 1));
    expect(f.engine.store.get("issues", ISSUE)).toEqual(f.authoritativeIssue(ISSUE));
  });

  it("retains a rejection when pull acknowledges before its delayed push response", async () => {
    const f = fixture();
    await f.ready();
    f.engine.stop();
    const receipt = await f.engine.mutate("create_label", { name: "Prediction", color: "#ff0000" });
    f.server.run(f.owner, {
      type: "create_label",
      id: receipt.id ?? "",
      name: "Server",
      color: "#000000",
    });
    const original = f.transport.push;
    let committed = false;
    f.transport.push = async (...args) => {
      const response = await original(...args);
      committed = true;
      await new Promise<void>((resolve) => f.server.schedule(1000, resolve));
      return response;
    };
    const settle = vi.fn();
    void receipt.settled.then(settle);
    await f.engine.start();
    await until(() => committed);
    await f.engine.pull();
    expect(f.engine.status.get().pending).toBe(0);
    expect(settle).not.toHaveBeenCalled();
    expect(f.engine.store.get("labels", receipt.id ?? "")?.name).toBe("Server");
    await f.advance(1000);
    expect(await receipt.settled).toMatchObject({ id: receipt.mutationId, status: 409 });
  });

  it("settles acknowledgements from an earlier session without sending the mutation again", async () => {
    const f = fixture();
    await f.ready();
    f.engine.stop();
    const receipt = await f.engine.mutate("update_issue", {
      id: ISSUE,
      patch: { title: "Already committed" },
    });
    const disk = await f.disk();
    await f.transport.push(f.workspace.id, disk.meta.clientId, disk.outbox);
    f.fetch.mockClear();
    await f.engine.start();
    expect(await receipt.settled).toBe("applied");
    expect(f.pushes()).toHaveLength(0);
    expect(f.engine.status.get().pending).toBe(0);
  });

  it("honors Retry-After on bootstrap and partial pushes", async () => {
    const f = fixture();
    f.server.inject({ kind: "unavailable", route: "bootstrap" });
    await f.engine.start();
    await until(() => f.engine.status.get().lastError !== null);
    await f.advance(4999);
    expect(f.requests("bootstrap")).toBe(1);
    await f.advance(1);
    await until(() => f.engine.status.get().phase === "ready");
    await f.engine.pull();
    const original = f.server.fetch;
    f.fetch.mockImplementation(async (...args) => {
      const response = await original(...args);
      if (response.status === 503 && String(args[0]).includes("/push?"))
        response.headers.set("Retry-After", "5");
      return response;
    });
    f.server.inject({ kind: "unavailable", route: "push" });
    const receipt = await f.engine.mutate("update_issue", {
      id: ISSUE,
      patch: { title: "Retry later" },
    });
    await until(() => f.pushes().length === 1);
    await flush();
    await f.advance(4999);
    expect(f.pushes()).toHaveLength(1);
    await f.advance(1);
    expect(await receipt.settled).toBe("applied");
    await until(() => f.engine.status.get().pending === 0);
  });

  it("keeps a failed batch across stop/start and prevents new mutations overtaking it", async () => {
    const f = fixture();
    await f.ready();
    f.server.inject({ kind: "unavailable", route: "push" });
    const older = await f.engine.mutate("update_issue", { id: ISSUE, patch: { title: "Older" } });
    await until(() => f.pushes().length === 1);
    await flush();
    f.engine.stop();
    const newer = await f.engine.mutate("update_issue", { id: ISSUE, patch: { title: "Newer" } });
    await f.engine.start();
    await flush();
    expect(f.pushes()).toHaveLength(1);
    await f.advance(1000);
    await until(() => f.engine.status.get().pending === 0);
    expect(f.pushes().map((batch) => batch.map((mutation) => mutation.id))).toEqual([
      [1],
      [1],
      [2],
    ]);
    expect(await Promise.all([older.settled, newer.settled])).toEqual(["applied", "applied"]);
  });

  it("retries online-only id allocation when the outbox-empty check loses a race", async () => {
    const storage = new MemoryReplicaStorage();
    const open = storage.open.bind(storage);
    let allocations = 0;
    storage.open = async (input) => {
      const replica = await open(input);
      const allocate = replica.allocateMutationIdIfOutboxEmpty.bind(replica);
      replica.allocateMutationIdIfOutboxEmpty = async () =>
        ++allocations === 1 ? null : allocate();
      return replica;
    };
    const f = fixture(storage);
    await f.ready();
    const online = f.engine.runOnline("set_role", { user_id: f.peer.id, role: "viewer" });
    await until(() => allocations === 1);
    expect(f.pushes()).toHaveLength(0);
    await f.advance(1000);
    expect(await online).toEqual({ id: 1, status: "applied" });
    expect(allocations).toBe(2);
    expect((await f.disk()).outbox).toHaveLength(0);
  });

  it("continues core syncing when a scope protocol error blocks only scope loads", async () => {
    const f = fixture();
    f.engine.useScope({ entity: "comments", issueId: ISSUE });
    f.transport.scope = vi.fn(async () => {
      throw new ProtocolError("Invalid scope body", 200);
    });
    await f.engine.start();
    await until(() => f.engine.status.get().phase === "ready");
    expect(f.engine.status.get().lastError).toBeInstanceOf(ProtocolError);
    const receipt = await f.engine.mutate("update_issue", {
      id: ISSUE,
      patch: { title: "Core still works" },
    });
    expect(await receipt.settled).toBe("applied");
    await until(() => f.engine.status.get().pending === 0);
    expect(f.transport.scope).toHaveBeenCalledTimes(1);
  });

  it("publishes stable frozen status snapshots and unsubscribes status listeners", async () => {
    const f = fixture();
    await f.ready();
    f.engine.stop();
    const current = f.engine.status.get();
    expect(f.engine.status.get()).toBe(current);
    expect(Object.isFrozen(current)).toBe(true);
    const listener = vi.fn();
    const release = f.engine.status.subscribe(listener);
    await f.engine.mutate("update_issue", { id: ISSUE, patch: { title: "Observable" } });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(f.engine.status.get().pending).toBe(1);
    release();
    f.signals.send("offline");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("opens from disk before starting and bootstraps the actor's complete view", async () => {
    const f = fixture();
    await f.engine.open();
    expect(f.requests("bootstrap")).toBe(0);
    expect(f.engine.status.get().phase).toBe("bootstrapping");
    await f.ready();
    for (const entity of BOOTSTRAP_ENTITIES)
      expect(f.engine.store.all(entity)).toEqual(
        f.server.records(entity, f.owner.id).map((record) => normalize(entity, record)),
      );
    expect((await f.disk()).meta.cursor).not.toBeNull();
  });

  it("predicts edits immediately, then acknowledges and adopts server versions and numbers", async () => {
    const f = fixture();
    await f.ready();
    const receipt = await f.engine.mutate("create_issue", {
      input: { title: "Created", team_id: TEAM },
    });
    expect(receipt.id).toBe(id(100));
    expect(f.engine.store.get("issues", id(100))?.number).toBeNull();
    expect(f.engine.status.get().pending).toBe(1);
    expect(await receipt.settled).toBe("applied");
    await until(() => f.engine.status.get().pending === 0);
    expect(f.engine.store.get("issues", id(100))).toEqual(f.authoritativeIssue(id(100)));
    const edit = await f.engine.mutate("update_issue", { id: id(100), patch: { title: "Edited" } });
    expect(f.engine.store.get("issues", id(100))?.title).toBe("Edited");
    await edit.settled;
    await until(() => f.engine.status.get().pending === 0);
    expect(f.engine.store.get("issues", id(100))).toEqual(f.authoritativeIssue(id(100)));
  });

  it("receives another user's edit through a poke", async () => {
    const f = fixture();
    await f.ready();
    f.server.run(f.peer, { type: "update_issue", id: ISSUE, patch: { title: "Peer edit" } });
    await f.advance(250);
    await until(() => f.engine.store.get("issues", ISSUE)?.title === "Peer edit");
  });

  it("reports rejection and reverts the prediction only after acknowledgement", async () => {
    const f = fixture();
    await f.ready();
    f.signals.send("offline");
    const receipt = await f.engine.mutate("create_label", { name: "Predicted", color: "#ff0000" });
    f.server.run(f.peer, {
      type: "create_label",
      id: receipt.id ?? "",
      name: "Authoritative",
      color: "#000000",
    });
    const events: EngineEvent[] = [];
    f.engine.subscribe((event) => events.push(event));
    f.signals.send("online");
    expect(await receipt.settled).toEqual({
      id: receipt.mutationId,
      status: 409,
      message: "id already exists",
    });
    await until(() => f.engine.status.get().pending === 0);
    expect(f.engine.store.get("labels", receipt.id ?? "")?.name).toBe("Authoritative");
    expect(f.engine.status.get().rejected).toHaveLength(1);
    expect(events.some((event) => event.type === "rejected")).toBe(true);
  });

  it("queues concurrent offline mutations and retries the oldest batch before newer work", async () => {
    const f = fixture();
    await f.ready();
    f.signals.send("offline");
    const receipts = await Promise.all(
      [1, 2, 3].map((n) =>
        f.engine.mutate("update_issue", { id: ISSUE, patch: { title: `Edit ${n}` } }),
      ),
    );
    expect(f.engine.store.pending().map((mutation) => mutation.id)).toEqual([1, 2, 3]);
    expect(f.pushes()).toHaveLength(0);
    f.server.inject({ kind: "unavailable", route: "push", after: 1 });
    f.signals.send("online");
    await until(() => f.pushes().length === 1);
    const newer = await f.engine.mutate("update_issue", { id: ISSUE, patch: { title: "Newest" } });
    await f.advance(1000);
    await until(() => f.engine.status.get().pending === 0);
    expect(f.pushes().map((batch) => batch.map((mutation) => mutation.id))).toEqual([
      [1, 2, 3],
      [1, 2, 3],
      [4],
    ]);
    expect(await Promise.all([...receipts, newer].map((receipt) => receipt.settled))).toEqual([
      "applied",
      "applied",
      "applied",
      "applied",
    ]);
    expect(f.engine.store.get("issues", ISSUE)).toEqual(f.authoritativeIssue(ISSUE));
  });

  it.each(["memory", "indexeddb"])(
    "restores an outbox and optimistic view after reload with %s",
    async (backend) => {
      const f = fixture(
        backend === "memory"
          ? new MemoryReplicaStorage()
          : new IndexedDBReplicaStorage({ indexedDB: new IDBFactory() }),
      );
      await f.ready();
      f.signals.send("offline");
      await f.engine.mutate("update_issue", { id: ISSUE, patch: { title: "On disk" } });
      await f.engine.close();
      const reloaded = f.build();
      await reloaded.open();
      expect(reloaded.store.get("issues", ISSUE)?.title).toBe("On disk");
      expect(reloaded.status.get().pending).toBe(1);
      await reloaded.start();
      f.signals.send("online");
      await until(() => reloaded.status.get().pending === 0);
      expect(reloaded.store.get("issues", ISSUE)).toEqual(f.authoritativeIssue(ISSUE));
    },
  );

  it("retries a dropped committed push as duplicate without double effects", async () => {
    const f = fixture();
    await f.ready();
    f.server.inject({ kind: "drop_response", route: "push" });
    const receipt = await f.engine.mutate("create_issue", {
      input: { title: "Once", team_id: TEAM },
    });
    await until(() => f.engine.status.get().lastError !== null);
    await f.advance(1000);
    expect(await receipt.settled).toBe("applied");
    await until(() => f.engine.status.get().pending === 0);
    expect(f.pushes()).toHaveLength(2);
    expect(f.pushes()[1]).toEqual(f.pushes()[0]);
    expect(f.server.records("issues").filter((issue) => issue.title === "Once")).toHaveLength(1);
  });

  it("keeps pending work through intermediate pull pages until the final snapshot", async () => {
    const f = fixture(new MemoryReplicaStorage(), { pageSize: 2 });
    await f.ready();
    f.engine.stop();
    const a = await f.engine.mutate("create_label", { name: "One", color: "#ff0000" });
    const b = await f.engine.mutate("create_label", { name: "Two", color: "#ff0000" });
    const loaded = await f.disk();
    await f.transport.push(f.workspace.id, loaded.meta.clientId, loaded.outbox);
    const pages: { more: boolean; pending: number; ack: number | null }[] = [];
    const original = f.transport.pull;
    f.transport.pull = async (...args) => {
      const response = await original(...args);
      pages.push({
        more: response.more,
        pending: f.engine.status.get().pending,
        ack: response.last_mutation_id,
      });
      return response;
    };
    await f.engine.start();
    await until(() => f.engine.status.get().pending === 0);
    expect(pages[0]).toEqual({ more: true, pending: 2, ack: null });
    expect(pages[1]).toEqual({ more: false, pending: 2, ack: 2 });
    expect(await Promise.all([a.settled, b.settled])).toEqual(["applied", "applied"]);
  });

  it("resets through bootstrap while keeping pending predictions on top", async () => {
    const f = fixture();
    await f.ready();
    f.engine.stop();
    const receipt = await f.engine.mutate("update_issue", {
      id: ISSUE,
      patch: { title: "Survives reset" },
    });
    f.server.inject({ kind: "reset_pull" });
    f.server.inject({ kind: "delay", route: "push", milliseconds: 1000 });
    await f.engine.start();
    await until(() => f.requests("bootstrap") === 2 && f.engine.status.get().phase === "ready");
    expect(f.engine.status.get().pending).toBe(1);
    expect(f.engine.store.get("issues", ISSUE)?.title).toBe("Survives reset");
    await f.advance(1000);
    await receipt.settled;
    await until(() => f.engine.status.get().pending === 0);
  });

  it("discards a truncated bootstrap and retries without persisting partial records", async () => {
    const f = fixture();
    f.server.inject({ kind: "truncate_bootstrap", afterRecords: 2 });
    await f.engine.start();
    await until(() => f.engine.status.get().lastError !== null);
    expect(f.engine.store.all("members")).toHaveLength(0);
    expect((await f.disk()).meta.cursor).toBeNull();
    await f.advance(1000);
    await until(() => f.engine.status.get().phase === "ready");
    expect(f.requests("bootstrap")).toBe(2);
  });

  it("serializes delayed snapshots and coalesces pulls without regressing view or cursor", async () => {
    const f = fixture();
    await f.ready();
    f.server.run(f.peer, { type: "update_issue", id: ISSUE, patch: { title: "First" } });
    f.server.inject({ kind: "response_delay", route: "pull", milliseconds: 1000 });
    const count = f.requests("pull");
    const pulling = f.engine.pull();
    await until(() => f.requests("pull") === count + 1);
    f.server.run(f.peer, { type: "update_issue", id: ISSUE, patch: { title: "Second" } });
    void f.engine.pull();
    void f.engine.pull();
    await flush();
    expect(f.requests("pull")).toBe(count + 1);
    await f.advance(1000);
    await pulling;
    expect(f.engine.store.get("issues", ISSUE)?.title).toBe("Second");
    expect((await f.disk()).meta.cursor).toBe(
      (await f.transport.pull(f.workspace.id, (await f.disk()).meta.clientId, null)).cursor,
    );
  });

  it("discards responses from a stopped network generation", async () => {
    const f = fixture();
    await f.ready();
    const original = f.transport.pull;
    let deliver: ((response: Awaited<ReturnType<typeof original>>) => void) | undefined;
    const stale = await original(f.workspace.id, (await f.disk()).meta.clientId, null);
    f.transport.pull = () =>
      new Promise((resolve) => {
        deliver = resolve;
      });
    void f.engine.pull();
    await until(() => deliver !== undefined);
    f.engine.stop();
    f.transport.pull = original;
    f.server.run(f.peer, { type: "update_issue", id: ISSUE, patch: { title: "New generation" } });
    await f.engine.start();
    await until(() => f.engine.store.get("issues", ISSUE)?.title === "New generation");
    const cursor = (await f.disk()).meta.cursor;
    deliver?.(stale);
    await flush();
    expect((await f.disk()).meta.cursor).toBe(cursor);
    expect(f.engine.store.get("issues", ISSUE)?.title).toBe("New generation");
  });

  it("loads held scopes, filters unloaded scopes, retains released scopes, and reloads after reset", async () => {
    const f = fixture();
    await f.ready();
    f.server.run(f.owner, {
      type: "add_comment",
      id: id(40),
      issue_id: ISSUE,
      body: "Loaded",
      attachments: [],
      mentions: [],
    });
    const scope: Scope = { entity: "comments", issueId: ISSUE };
    const release = f.engine.useScope(scope);
    const releaseSecond = f.engine.useScope(scope);
    await until(() => f.engine.store.all("comments").length === 1);
    expect(f.requests("scope")).toBe(1);
    releaseSecond();
    f.server.run(f.owner, { type: "edit_comment", id: id(40), body: "Changed", mentions: [] });
    f.server.run(f.peer, {
      type: "add_comment",
      id: id(41),
      issue_id: OTHER_ISSUE,
      body: "Unloaded",
      attachments: [],
      mentions: [],
    });
    await f.engine.pull();
    expect(f.engine.store.get("comments", id(40))?.body).toBe("Changed");
    expect(f.engine.store.get("comments", id(41))).toBeUndefined();
    f.server.inject({ kind: "reset_pull" });
    await f.engine.pull();
    expect(f.requests("scope")).toBe(2);
    expect(f.engine.store.get("comments", id(40))?.body).toBe("Changed");
    release();
    release();
    f.server.run(f.owner, { type: "delete_comment", id: id(40) });
    await f.engine.pull();
    expect(f.engine.store.get("comments", id(40))).toBeUndefined();
    expect((await f.disk()).scopes).toEqual([scope]);
  });

  it("waits for the outbox before online-only allocation and never stores that command", async () => {
    const f = fixture();
    await f.ready();
    f.engine.stop();
    const receipt = await f.engine.mutate("update_issue", {
      id: ISSUE,
      patch: { title: "Before role" },
    });
    const online = f.engine.runOnline("set_role", { user_id: f.peer.id, role: "viewer" });
    await flush();
    expect(f.pushes()).toHaveLength(0);
    expect((await f.disk()).outbox).toHaveLength(1);
    await f.engine.start();
    expect(await online).toEqual({ id: 2, status: "applied" });
    expect(await receipt.settled).toBe("applied");
    await until(() => f.engine.store.get("members", f.peer.id)?.role === "viewer");
    expect(f.pushes().map((batch) => batch.map((mutation) => mutation.name))).toEqual([
      ["update_issue"],
      ["set_role"],
    ]);
    expect((await f.disk()).outbox).toHaveLength(0);
  });

  it("reconnects dropped events and polls every 30 seconds while disconnected", async () => {
    const f = fixture();
    f.server.inject({ kind: "close_events", afterMs: 10 });
    await f.ready();
    f.server.inject({ kind: "delay", route: "events", milliseconds: 60_000 });
    await f.advance(10);
    await until(() => !f.engine.status.get().connected);
    await f.advance(1000);
    await until(() => f.requests("events") === 2);
    f.server.run(f.peer, { type: "update_issue", id: ISSUE, patch: { title: "Polled" } });
    await f.advance(30_000);
    await until(() => f.engine.store.get("issues", ISSUE)?.title === "Polled");
    await f.advance(30_000);
    await until(() => f.engine.status.get().connected);
  });

  it.each(["memory", "indexeddb"])(
    "wipes only the expired session's replicas on 401 with %s",
    async (backend) => {
      const f = fixture(
        backend === "memory"
          ? new MemoryReplicaStorage()
          : new IndexedDBReplicaStorage({ indexedDB: new IDBFactory() }),
      );
      await f.ready();
      for (const identity of [
        { sessionId: SESSION, workspaceId: id(60) },
        { sessionId: id(61), workspaceId: f.workspace.id },
      ])
        (await f.storage.open({ ...identity, schema: SCHEMA })).close();
      const events: EngineEvent[] = [];
      f.engine.subscribe((event) => events.push(event));
      f.server.logout(f.token);
      await f.engine.pull();
      await until(() => events.some((event) => event.type === "unauthorized"));
      expect(await f.storage.list()).toEqual([{ sessionId: id(61), workspaceId: f.workspace.id }]);
      expect(f.engine.status.get().phase).toBe("loading");
      expect(f.engine.store.all("issues")).toHaveLength(0);
    },
  );

  it("wipes only this workspace replica on 403 and emits accessLost", async () => {
    const f = fixture();
    await f.ready();
    (await f.storage.open({ sessionId: SESSION, workspaceId: id(60), schema: SCHEMA })).close();
    const events: EngineEvent[] = [];
    f.engine.subscribe((event) => events.push(event));
    f.server.removeMember(f.workspace.id, f.owner.id);
    await f.engine.pull();
    await until(() => events.some((event) => event.type === "accessLost"));
    expect(await f.storage.list()).toEqual([{ sessionId: SESSION, workspaceId: id(60) }]);
  });

  it.each(["memory", "indexeddb"])(
    "resets mismatched schema, preserves outbox ids, and bootstraps before push with %s",
    async (backend) => {
      const f = fixture(
        backend === "memory"
          ? new MemoryReplicaStorage()
          : new IndexedDBReplicaStorage({ indexedDB: new IDBFactory() }),
      );
      await f.ready();
      f.engine.stop();
      await f.engine.mutate("update_issue", { id: ISSUE, patch: { title: "New schema" } });
      const before = await f.disk();
      await f.engine.close();
      const upgraded = f.build(2);
      await upgraded.open();
      expect(upgraded.store.all("members")).toHaveLength(0);
      const reset = await f.disk();
      expect(reset.meta).toMatchObject({
        schema: 2,
        cursor: null,
        clientId: before.meta.clientId,
        nextMutationId: before.meta.nextMutationId,
      });
      expect(reset.outbox).toEqual(before.outbox);
      await upgraded.start();
      await until(
        () => upgraded.status.get().phase === "ready" && upgraded.status.get().pending === 0,
      );
      expect(upgraded.store.get("issues", ISSUE)).toEqual(f.authoritativeIssue(ISSUE));
    },
  );

  it("surfaces protocol errors once and stops retrying that request kind", async () => {
    const f = fixture();
    await f.ready();
    const pull = vi.fn(async () => {
      throw new ProtocolError("Bad cursor", 400);
    });
    f.transport.pull = pull;
    await f.engine.pull();
    f.signals.send("focus");
    await f.advance(60_000);
    expect(pull).toHaveBeenCalledTimes(1);
    expect(f.engine.status.get().lastError).toBeInstanceOf(ProtocolError);
    expect(f.engine.status.get().connected).toBe(true);
  });

  it("rejects failed admission and online-only misuse without consuming an outbox id", async () => {
    const f = fixture();
    await f.ready();
    await expect(
      f.engine.mutate("set_role", { user_id: f.peer.id, role: "viewer" }),
    ).rejects.toThrow("runOnline");
    await expect(
      f.engine.mutate("update_issue", { id: id(70), patch: { title: "Missing" } }),
    ).rejects.toThrow("not found");
    expect((await f.disk()).meta.nextMutationId).toBe(1);
    f.signals.send("offline");
    await expect(
      f.engine.runOnline("set_role", { user_id: f.peer.id, role: "viewer" }),
    ).rejects.toThrow("online connection");
  });
});
