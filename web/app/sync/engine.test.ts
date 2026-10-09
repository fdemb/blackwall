import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { setCsrf } from "../lib/api";
import { createEngine, SCHEMA } from "./engine";
import type { EngineEvent, EngineSignal, SyncEngine } from "./engine";
import { IndexedDBReplicaStorage } from "./persistence/idb";
import { MemoryReplicaStorage } from "./persistence/memory";
import type { ReplicaStorage, Scope } from "./persistence/types";
import { BOOTSTRAP_ENTITIES, normalize } from "./records";
import { createFakeServer } from "./testing/fake-server";
import type { FakeServerOptions } from "./testing/fake-server";
import { createTransport, ProtocolError, TruncatedError, UnavailableError } from "./transport";
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
  setCsrf(server.csrfToken(token));
  const fetch = vi.fn(server.fetch);
  const transport = createTransport({
    fetch,
    headers: () => ({ cookie: `blackwall_session=${token}` }),
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
    fetch.mock.calls.filter(([url]) =>
      route === "me" ? String(url).endsWith("/api/me") : String(url).includes(`/${route}?`),
    ).length;
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
    expect((await f.disk()).records.issues).toEqual(
      f.server.records("issues").map((record) => normalize("issues", record)),
    );
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

  it("settles acknowledgements from an earlier session while independently retrying duplicates", async () => {
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
    expect(f.pushes()).toHaveLength(1);
    expect(f.server.clientState(disk.meta.clientId).last_mutation_id).toBe(receipt.mutationId);
    expect(f.engine.status.get().pending).toBe(0);
  });

  it.each(["applied", "rejected"] as const)(
    "confirms a mutation acknowledged by pull first as %s, behind the in-flight batch",
    async (outcome) => {
      const f = fixture();
      await f.ready();
      const original = f.transport.push;
      let release = () => {};
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let committed = false;
      f.transport.push = async (...args) => {
        const response = await original(...args);
        if (!committed) {
          committed = true;
          await held;
        }
        return response;
      };
      const older = await f.engine.mutate("update_issue", {
        id: ISSUE,
        patch: { title: "Older" },
      });
      await until(() => committed);
      const receipt = await f.engine.mutate("create_label", {
        name: "Prediction",
        color: "#ff0000",
      });
      if (outcome === "rejected")
        f.server.run(f.owner, {
          type: "create_label",
          id: receipt.id ?? "",
          name: "Server",
          color: "#000000",
        });
      const disk = await f.disk();
      const result = await original(f.workspace.id, disk.meta.clientId, disk.outbox);
      expect(result.results.at(-1)?.status).toBe(outcome);
      const settle = vi.fn();
      void receipt.settled.then(settle);
      await f.engine.pull();
      expect(f.engine.status.get().pending).toBe(0);
      expect(settle).not.toHaveBeenCalled();
      const newer = await f.engine.mutate("update_issue", {
        id: ISSUE,
        patch: { title: "Newer" },
      });
      f.fetch.mockClear();
      release();
      expect(await older.settled).toBe("applied");
      if (outcome === "rejected")
        expect(await receipt.settled).toMatchObject({ id: receipt.mutationId, status: 409 });
      else expect(await receipt.settled).toBe("applied");
      expect(await newer.settled).toBe("applied");
      expect(f.pushes().map((batch) => batch.map((mutation) => mutation.id))).toEqual([
        [receipt.mutationId, newer.mutationId],
      ]);
    },
  );

  it("rejects an unknown pull-acknowledged outcome when closed before confirmation", async () => {
    const f = fixture();
    await f.ready();
    const original = f.transport.push;
    let committed = false;
    f.transport.push = async (...args) => {
      const response = await original(...args);
      committed = true;
      await new Promise<void>((resolve) => f.server.schedule(1000, resolve));
      return response;
    };
    const receipt = await f.engine.mutate("update_issue", { id: ISSUE, patch: { title: "Held" } });
    await until(() => committed);
    await f.engine.pull();
    const closed = expect(receipt.settled).rejects.toThrow("Engine is closed");
    await f.engine.close();
    await closed;
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
    await expect(older.settled).rejects.toThrow("stopped");
    expect(await newer.settled).toBe("applied");
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

  it("reports a scope as loading until its first load, then loaded, and loaded from disk on reopen", async () => {
    const f = fixture();
    await f.ready();
    const scope: Scope = { entity: "comments", issueId: ISSUE };
    expect(f.engine.scopeStatus(scope)).toBe("loading");
    const notified = vi.fn();
    const unsubscribe = f.engine.subscribeScopes(notified);
    const release = f.engine.useScope(scope);
    await until(() => f.engine.scopeStatus(scope) === "loaded");
    expect(notified).toHaveBeenCalled();
    release();
    unsubscribe();
    const reopened = f.build();
    await reopened.open();
    expect(reopened.scopeStatus(scope)).toBe("loaded");
    expect(reopened.scopeError(scope)).toBeNull();
  });

  it("reports a scope blocked by a protocol error as error and leaves other scopes loading", async () => {
    const f = fixture();
    const scope: Scope = { entity: "comments", issueId: ISSUE };
    const failure = new ProtocolError("Invalid scope body", 200);
    f.transport.scope = vi.fn(async () => {
      throw failure;
    });
    f.engine.useScope(scope);
    await f.engine.start();
    await until(() => f.engine.scopeStatus(scope) === "error");
    expect(f.engine.scopeError(scope)).toBe(failure);
    expect(f.engine.scopeStatus({ entity: "activity", entityId: ISSUE })).toBe("loading");
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
      command: { name: "create_label", args: expect.objectContaining({ name: "Predicted" }) },
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

  it("recovers the rejection after a dropped response and duplicate retry, seed 179", async () => {
    const results: { status: string }[] = [];
    const f = fixture(new MemoryReplicaStorage(), {
      onResult: (_client, result) => results.push(result),
    });
    await f.ready();
    f.signals.send("offline");
    const receipt = await f.engine.mutate("update_issue", {
      id: ISSUE,
      patch: { dependencies: [OTHER_ISSUE] },
    });
    f.server.run(f.peer, {
      type: "update_issue",
      id: OTHER_ISSUE,
      patch: { dependencies: [ISSUE] },
    });
    f.server.inject({ kind: "drop_response", route: "push" });
    f.signals.send("online");
    await until(() => results.some((result) => result.status === "rejected"));
    await f.advance(1000);
    expect(await receipt.settled).toMatchObject({ id: receipt.mutationId, status: 400 });
    expect(results.map((result) => result.status)).toEqual(["rejected", "rejected"]);
    await until(() => f.engine.status.get().pending === 0);
    expect(f.server.record("issues", ISSUE)?.dependencies).toEqual([]);
    expect(f.engine.store.get("issues", ISSUE)?.dependencies).toEqual([]);
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
    await until(() => f.engine.store.get("comments", id(40))?.body === "Changed");
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

describe("review regressions", () => {
  it.each([{ updated_at: "invalid" }, { dependencies: null }, { id: "mismatched" }])(
    "validates a final pull page before persisting its cursor or acknowledgement: %j",
    async (malformed) => {
      const f = fixture();
      await f.ready();
      f.engine.stop();
      const receipt = await f.engine.mutate("update_issue", {
        id: ISSUE,
        patch: { title: "Pending" },
      });
      void receipt.settled.catch(() => undefined);
      const before = await f.disk();
      await f.transport.push(f.workspace.id, before.meta.clientId, before.outbox);
      const original = f.transport.pull;
      f.transport.pull = async (...args) => {
        const response = await original(...args);
        return {
          ...response,
          changes: response.changes.map((change) => ({
            ...change,
            record:
              change.entity === "issues" && change.record
                ? { ...change.record, ...malformed }
                : change.record,
          })),
        };
      };
      await f.engine.start();
      await until(() => f.engine.status.get().lastError !== null);
      expect(f.engine.status.get().lastError).toBeInstanceOf(ProtocolError);
      const after = await f.disk();
      expect(after.meta.cursor).toBe(before.meta.cursor);
      expect(after.meta.lastMutationId).toBe(before.meta.lastMutationId);
      expect(after.outbox).toEqual(before.outbox);
      expect(after.records).toEqual(before.records);
      expect(f.engine.store.get("issues", ISSUE)?.title).toBe("Pending");
      const reloaded = f.build();
      await reloaded.open();
      expect(reloaded.store.get("issues", ISSUE)?.title).toBe("Pending");
    },
  );

  it("keeps caller-owned arrays out of an online retry payload", async () => {
    const f = fixture();
    await f.ready();
    f.server.inject({ kind: "unavailable", route: "push" });
    const labels = [id(80)];
    const online = f.engine.runOnline("import_issues", {
      issues: [{ team_id: TEAM, title: "Import", labels }],
    });
    void online.catch(() => undefined);
    await until(() => f.pushes().length === 1);
    await flush();
    const first = f.pushes()[0];
    labels.push(id(81));
    await f.advance(1000);
    await online;
    expect(f.pushes()[1]).toEqual(first);
  });

  it("gives a held scope and push turns during sustained pull pokes", async () => {
    const f = fixture();
    await f.ready();
    const original = f.transport.pull;
    let pulls = 0;
    f.transport.pull = async (...args) => {
      const response = await original(...args);
      if (++pulls < 12) void f.engine.pull();
      return response;
    };
    f.server.inject({ kind: "response_delay", route: "pull", milliseconds: 1000 });
    const before = f.requests("pull");
    const reading = f.engine.pull();
    await until(() => f.requests("pull") === before + 1);
    const receipt = await f.engine.mutate("update_issue", { id: ISSUE, patch: { title: "Fair" } });
    void receipt.settled.catch(() => undefined);
    const pushing = vi.fn(f.transport.push);
    let pushTurn = -1;
    f.transport.push = async (...args) => {
      pushTurn = pulls;
      return pushing(...args);
    };
    const scope = vi.fn(f.transport.scope);
    let scopeTurn = -1;
    f.transport.scope = async (...args) => {
      scopeTurn = pulls;
      return scope(...args);
    };
    const release = f.engine.useScope({ entity: "activity", entityId: ISSUE });
    await f.advance(1000);
    await reading;
    await until(() => f.engine.status.get().pending === 0 && scope.mock.calls.length === 1);
    expect(pushing).toHaveBeenCalled();
    expect(pushTurn).toBeLessThan(4);
    expect(scopeTurn).toBeLessThan(4);
    await receipt.settled;
    release();
  });

  it("releases the read queue while a scope backs off", async () => {
    const f = fixture();
    await f.ready();
    const scope = vi.fn(async () => {
      throw new UnavailableError("Scope unavailable", 503, 5);
    });
    f.transport.scope = scope;
    const release = f.engine.useScope({ entity: "comments", issueId: ISSUE });
    await until(() => scope.mock.calls.length === 1);
    await flush();
    const before = f.requests("pull");
    void f.engine.pull();
    await flush();
    expect(f.requests("pull")).toBeGreaterThan(before);
    release();
  });

  it.each(["5", "Fri, 09 Oct 2026 12:00:05 GMT"])(
    "honors event Retry-After %s",
    async (retryAfter) => {
      const f = fixture();
      const original = f.server.fetch;
      let failed = false;
      f.fetch.mockImplementation(async (...args) => {
        if (String(args[0]).includes("/events?") && !failed) {
          failed = true;
          return Response.json(
            { error: "Unavailable" },
            { status: 503, headers: { "Retry-After": retryAfter } },
          );
        }
        return original(...args);
      });
      await f.engine.start();
      await until(() => f.engine.status.get().phase === "ready" && failed);
      await flush();
      await f.advance(4999);
      expect(f.requests("events")).toBe(1);
      await f.advance(1);
      await until(() => f.engine.status.get().connected);
      expect(f.requests("events")).toBe(2);
    },
  );
});

describe("cookie sessions and pending callers", () => {
  it("sends shared CSRF tokens, captures rotation, and refreshes a forced push 403 without wiping", async () => {
    const f = fixture();
    const events: EngineEvent[] = [];
    f.engine.subscribe((event) => events.push(event));
    await f.ready();
    const first = await f.engine.mutate("update_issue", {
      id: ISSUE,
      patch: { title: "Cookie push" },
    });
    expect(await first.settled).toBe("applied");
    await until(() => f.engine.status.get().pending === 0);
    const rotated = f.server.rotateCsrf(f.token, "rotated-cookie-csrf");
    await f.transport.me();
    const second = await f.engine.mutate("update_issue", {
      id: ISSUE,
      patch: { title: "Rotated" },
    });
    expect(await second.settled).toBe("applied");
    await until(() => f.engine.status.get().pending === 0);
    const pushHeaders = () =>
      f.fetch.mock.calls
        .filter(([url]) => String(url).includes("/push?"))
        .map(([, init]) => new Headers(init?.headers));
    expect(pushHeaders()[1].get("X-CSRF-Token")).toBe(rotated);
    expect(
      pushHeaders().every((headers) => headers.has("cookie") && !headers.has("authorization")),
    ).toBe(true);
    f.server.rotateCsrf(f.token, "refresh-needed");
    const third = await f.engine.mutate("update_issue", {
      id: ISSUE,
      patch: { title: "Recovered" },
    });
    expect(await third.settled).toBe("applied");
    await until(() => f.engine.status.get().pending === 0);
    expect(f.pushes()).toHaveLength(4);
    expect(f.pushes()[3]).toEqual(f.pushes()[2]);
    expect(pushHeaders()[2].get("X-CSRF-Token")).toBe(rotated);
    expect(pushHeaders()[3].get("X-CSRF-Token")).toBe("refresh-needed");
    expect(f.requests("me")).toBe(2);
    expect(events.some((event) => event.type === "accessLost")).toBe(false);
    expect(await f.storage.list()).toEqual([{ sessionId: SESSION, workspaceId: f.workspace.id }]);
    expect(f.engine.store.get("issues", ISSUE)?.title).toBe("Recovered");
  });

  it("caps persistent push 403 recovery and preserves the replica and outbox", async () => {
    const f = fixture();
    await f.ready();
    const original = f.server.fetch;
    f.fetch.mockImplementation((...args) =>
      String(args[0]).includes("/push?")
        ? Promise.resolve(Response.json({ error: "CSRF refused" }, { status: 403 }))
        : original(...args),
    );
    const receipt = await f.engine.mutate("update_issue", {
      id: ISSUE,
      patch: { title: "Keep pending" },
    });
    await until(() => f.engine.status.get().lastError instanceof ProtocolError);
    await f.advance(60_000);
    expect(f.pushes()).toHaveLength(2);
    expect(f.requests("me")).toBe(1);
    expect((await f.disk()).outbox.map((mutation) => mutation.id)).toEqual([receipt.mutationId]);
    expect(f.engine.store.get("issues", ISSUE)?.title).toBe("Keep pending");
    await f.engine.close();
    await expect(receipt.settled).rejects.toThrow(/closed|stopped/);
  });

  it("confirms a push membership 403 with a read before wiping", async () => {
    const f = fixture();
    await f.ready();
    const events: EngineEvent[] = [];
    f.engine.subscribe((event) => events.push(event));
    const original = f.server.fetch;
    const responses: { route: string; status: number }[] = [];
    let removed = false;
    f.fetch.mockImplementation(async (...args) => {
      const route = String(args[0]).split("/sync/")[1]?.split("?")[0] ?? "me";
      if (route === "push" && !removed) {
        removed = true;
        f.server.removeMember(f.workspace.id, f.owner.id);
      }
      const response = await original(...args);
      responses.push({ route, status: response.status });
      return response;
    });
    const receipt = await f.engine.mutate("update_issue", {
      id: ISSUE,
      patch: { title: "No membership" },
    });
    void receipt.settled.catch(() => undefined);
    await until(() => events.some((event) => event.type === "accessLost"));
    expect(responses).toContainEqual({ route: "push", status: 403 });
    expect(responses).toContainEqual({ route: "me", status: 200 });
    expect(responses).toContainEqual({ route: "pull", status: 403 });
    expect(await f.storage.list()).toEqual([]);
    expect(f.engine.store.all("issues")).toHaveLength(0);
    expect(f.engine.status.get().pending).toBe(0);
  });

  it("rejects a missing online result instead of abandoning its caller", async () => {
    const f = fixture();
    await f.ready();
    const original = f.server.fetch;
    f.fetch.mockImplementation(async (...args) => {
      const response = await original(...args);
      return String(args[0]).includes("/push?")
        ? Response.json({ last_mutation_id: 1, results: [] })
        : response;
    });
    const online = f.engine.runOnline("set_role", { user_id: f.peer.id, role: "viewer" });
    await expect(online).rejects.toBeInstanceOf(ProtocolError);
    await f.engine.close();
    expect((await f.disk()).outbox).toEqual([]);
  });

  it.each(["stop", "close"] as const)(
    "rejects pending outcomes and queued online calls on %s while preserving outbox",
    async (action) => {
      const f = fixture();
      await f.ready();
      f.server.inject({ kind: "delay", route: "push", milliseconds: 1000 });
      const receipt = await f.engine.mutate("update_issue", {
        id: ISSUE,
        patch: { title: "Preserved" },
      });
      const online = f.engine.runOnline("set_role", { user_id: f.peer.id, role: "viewer" });
      const rejected = expect(online).rejects.toThrow(/closed|stopped/);
      await until(() => f.pushes().length === 1);
      await f.engine[action]();
      await rejected;
      await expect(receipt.settled).rejects.toThrow(/closed|stopped/);
      expect((await f.disk()).outbox.map((mutation) => mutation.id)).toEqual([receipt.mutationId]);
    },
  );

  it.each(["stop", "close"] as const)(
    "rejects both captured and queued online jobs on %s",
    async (action) => {
      const f = fixture();
      await f.ready();
      f.server.inject({ kind: "delay", route: "push", milliseconds: 1000 });
      const first = f.engine.runOnline("set_role", { user_id: f.peer.id, role: "viewer" });
      const second = f.engine.runOnline("set_role", { user_id: f.peer.id, role: "member" });
      const rejected = [
        expect(first).rejects.toThrow(/closed|stopped/),
        expect(second).rejects.toThrow(/closed|stopped/),
      ];
      await until(() => f.pushes().length === 1);
      await f.engine[action]();
      await Promise.all(rejected);
      expect((await f.disk()).outbox).toEqual([]);
    },
  );

  it("stores detached immutable outbox arguments before caller mutation", async () => {
    const f = fixture();
    await f.ready();
    f.engine.stop();
    const dependencies = [OTHER_ISSUE];
    const receipt = await f.engine.mutate("update_issue", { id: ISSUE, patch: { dependencies } });
    dependencies.push(id(81));
    const pending = f.engine.store.pending()[0];
    expect(Object.isFrozen(pending)).toBe(true);
    expect(Object.isFrozen(pending.args)).toBe(true);
    if (
      !pending.args ||
      typeof pending.args !== "object" ||
      !("patch" in pending.args) ||
      !pending.args.patch ||
      typeof pending.args.patch !== "object" ||
      !("dependencies" in pending.args.patch)
    )
      throw new Error("missing prepared dependencies");
    expect(Object.isFrozen(pending.args.patch.dependencies)).toBe(true);
    expect(pending.args.patch.dependencies).toEqual([OTHER_ISSUE]);
    expect((await f.disk()).outbox[0].args).toEqual(pending.args);
    await f.engine.close();
    await expect(receipt.settled).rejects.toThrow(/closed|stopped/);
  });

  it("retries bootstrap cut inside a record without committing the partial stream", async () => {
    const f = fixture();
    const original = f.server.fetch;
    let truncated = false;
    f.fetch.mockImplementation(async (...args) => {
      const response = await original(...args);
      if (!String(args[0]).includes("/bootstrap?") || truncated) return response;
      truncated = true;
      const header = (await response.text()).split("\n")[0];
      return new Response(`${header}\n{"entity":"members","record":{"id":"unfinished`, {
        headers: response.headers,
      });
    });
    await f.engine.start();
    await until(() => f.engine.status.get().lastError !== null);
    expect(f.engine.status.get().lastError).toBeInstanceOf(TruncatedError);
    expect((await f.disk()).meta.cursor).toBeNull();
    expect(f.engine.store.all("members")).toEqual([]);
    await f.advance(1000);
    await until(() => f.engine.status.get().phase === "ready");
    expect(f.requests("bootstrap")).toBe(2);
  });
});

describe("record preparation", () => {
  it.each([0, 1, 70, 113, 256, "utf8-1", "utf8-2", "utf8-3"])(
    "retries a bootstrap cut at byte boundary %s without persisting its prefix",
    async (boundary) => {
      const f = fixture();
      f.server.run(f.owner, { type: "update_issue", id: ISSUE, patch: { title: "Cut 🦊 here" } });
      await f.engine.open();
      const before = await f.disk();
      const full = await f.server.fetch(
        `/api/workspaces/${f.workspace.id}/sync/bootstrap?client_id=${before.meta.clientId}`,
        { headers: { cookie: `blackwall_session=${f.token}` } },
      );
      const bytes = new Uint8Array(await full.arrayBuffer());
      const emoji = bytes.findIndex((byte) => byte === 0xf0);
      expect(emoji).toBeGreaterThan(0);
      const byte = typeof boundary === "number" ? boundary : emoji + Number(boundary.at(-1));
      f.server.inject({ kind: "cut_bootstrap", byte });
      await f.engine.start();
      await until(() => f.engine.status.get().lastError instanceof TruncatedError);
      expect(await f.disk()).toEqual(before);
      expect(f.engine.store.all("issues")).toEqual([]);
      await f.advance(1000);
      await until(() => f.engine.status.get().phase === "ready");
      expect(f.engine.store.get("issues", ISSUE)).toEqual(f.authoritativeIssue(ISSUE));
    },
  );

  it.each(["memory", "indexeddb"])(
    "rejects records outside the requested scope before writing %s state",
    async (backend) => {
      const f = fixture(
        backend === "memory"
          ? new MemoryReplicaStorage()
          : new IndexedDBReplicaStorage({ indexedDB: new IDBFactory() }),
      );
      await f.ready();
      const before = await f.disk();
      const valid = f.server.records("activity").find((row) => row.entity_id === ISSUE);
      if (!valid) throw new Error("missing activity fixture");
      f.transport.scope = async () => ({
        records: [valid, { id: id(87), created_at: "bad timestamp" }],
      });
      const release = f.engine.useScope({ entity: "activity", entityId: ISSUE });
      await until(() => f.engine.status.get().lastError instanceof ProtocolError);
      expect(await f.disk()).toEqual(before);
      expect(f.engine.store.all("activity")).toEqual([]);
      release();
    },
  );

  it("rejects a well-formed record belonging to a different scope", async () => {
    const f = fixture();
    await f.ready();
    const foreign = f.server.records("activity").find((row) => row.entity_id === OTHER_ISSUE);
    if (!foreign) throw new Error("missing foreign activity");
    f.transport.scope = async () => ({ records: [foreign] });
    const release = f.engine.useScope({ entity: "activity", entityId: ISSUE });
    await until(() => f.engine.status.get().lastError instanceof ProtocolError);
    expect((await f.disk()).scopes).toEqual([]);
    expect(f.engine.store.all("activity")).toEqual([]);
    release();
  });

  it.each(["memory", "indexeddb"])(
    "rejects a malformed bootstrap before replacing or acknowledging %s state",
    async (backend) => {
      const f = fixture(
        backend === "memory"
          ? new MemoryReplicaStorage()
          : new IndexedDBReplicaStorage({ indexedDB: new IDBFactory() }),
      );
      await f.ready();
      f.engine.stop();
      const receipt = await f.engine.mutate("update_issue", {
        id: ISSUE,
        patch: { title: "Pending bootstrap" },
      });
      const before = await f.disk();
      await f.transport.push(f.workspace.id, before.meta.clientId, before.outbox);
      const original = f.transport.bootstrap;
      f.transport.bootstrap = async (...args) => {
        const response = await original(...args);
        return {
          header: response.header,
          records: (async function* () {
            for await (const item of response.records)
              yield {
                ...item,
                record:
                  item.entity === "issues"
                    ? { ...item.record, updated_at: "bad timestamp" }
                    : item.record,
              };
          })(),
        };
      };
      f.server.inject({ kind: "reset_pull" });
      await f.engine.start();
      await until(() => f.engine.status.get().lastError instanceof ProtocolError);
      const after = await f.disk();
      expect(after).toEqual(before);
      expect(f.engine.store.get("issues", ISSUE)?.title).toBe("Pending bootstrap");
      await f.engine.close();
      await receipt.settled.catch(() => undefined);
      const reloaded = f.build();
      await reloaded.open();
      expect(reloaded.store.get("issues", ISSUE)?.title).toBe("Pending bootstrap");
    },
  );

  it.each(["memory", "indexeddb"])(
    "rejects malformed scope records before writing their marker with %s",
    async (backend) => {
      const f = fixture(
        backend === "memory"
          ? new MemoryReplicaStorage()
          : new IndexedDBReplicaStorage({ indexedDB: new IDBFactory() }),
      );
      await f.ready();
      f.server.run(f.owner, {
        type: "add_comment",
        id: id(85),
        issue_id: ISSUE,
        body: "Valid first",
        mentions: [],
        attachments: [],
      });
      const original = f.transport.scope;
      f.transport.scope = async (...args) => {
        const response = await original(...args);
        return {
          records: [
            ...response.records,
            { ...response.records[0], id: id(86), created_at: "bad timestamp" },
          ],
        };
      };
      const release = f.engine.useScope({ entity: "comments", issueId: ISSUE });
      await until(() => f.engine.status.get().lastError instanceof ProtocolError);
      const disk = await f.disk();
      expect(disk.scopes).toEqual([]);
      expect(disk.records.comments).toEqual([]);
      expect(f.engine.store.all("comments")).toEqual([]);
      release();
    },
  );

  it("keeps core reads moving through repeated scope 503 backoffs", async () => {
    const f = fixture();
    await f.ready();
    const scope: Scope = { entity: "activity", entityId: ISSUE };
    f.server.inject({ kind: "unavailable", route: "scope" });
    f.server.inject({ kind: "unavailable", route: "scope" });
    const release = f.engine.useScope(scope);
    await until(() => f.requests("scope") === 1 && f.engine.status.get().lastError !== null);
    for (const title of ["During first backoff", "During second backoff"]) {
      f.server.run(f.peer, { type: "update_issue", id: ISSUE, patch: { title } });
      await f.engine.pull();
      expect(f.engine.store.get("issues", ISSUE)?.title).toBe(title);
      await f.advance(5000);
    }
    await until(() => f.requests("scope") === 3);
    await until(() => f.engine.store.all("activity").length > 0);
    expect((await f.disk()).scopes).toEqual([scope]);
    release();
  });
});
