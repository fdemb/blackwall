import "fake-indexeddb/auto";
import { forceCloseDatabase, IDBFactory } from "fake-indexeddb";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { setCsrf } from "../lib/api";
import { createEngine, OutdatedError, SCHEMA } from "./engine";
import type { EngineEvent, EngineSignal, SyncEngine } from "./engine";
import { IDB_VERSION, IndexedDBReplicaStorage } from "./persistence/idb";
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
    key: "TEA",
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
    userId: owner.id,
  });
  const signals = new Signals();
  let sequence = 100;
  const build = (schema = SCHEMA) => {
    const engine = createEngine({
      storage,
      transport,
      actor: owner.id,
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
  const commands = () =>
    fetch.mock.calls
      .filter(([url]) => String(url).endsWith("/commands"))
      .map(([, init]) => JSON.parse(String(init?.body)));
  const requests = (route: string) =>
    fetch.mock.calls.filter(([url]) =>
      route === "me"
        ? String(url).endsWith("/internal-api/me")
        : String(url).includes(`/${route}?`),
    ).length;
  const advance = async (ms: number) => {
    server.advance(ms);
    await flush();
  };
  const disk = async () => {
    const replica = await storage.open({
      userId: owner.id,
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
    commands,
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

async function workspacesOnDisk(f: { storage: ReplicaStorage }) {
  return (await f.storage.list()).map((identity) => identity.workspaceId).sort();
}

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
    const team = await f.engine.mutate("create_team", { name: "Offline team", key: "OFF" });
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

  it("retries a dropped command response with the same key and applies it once", async () => {
    const f = fixture();
    await f.ready();
    const before = await f.disk();
    f.server.inject({ kind: "drop_response", route: "commands" });
    const online = f.engine.runOnline("remove_member", { user_id: f.peer.id });
    await until(() => f.commands().length === 1);
    await flush();
    expect(f.server.record("members", f.peer.id)).toBeNull();
    await f.advance(1000);
    expect(await online).toEqual({ id: 0, status: "applied" });
    expect(f.commands()).toHaveLength(2);
    expect(f.commands()[1]).toEqual(f.commands()[0]);
    expect(f.pushes()).toHaveLength(0);
    expect((await f.disk()).meta.nextMutationId).toBe(before.meta.nextMutationId);
  });

  it("rejects an online business error with the server's status and message, preserving access", async () => {
    const f = fixture();
    await f.ready();
    f.server.setRole(f.workspace.id, f.owner.id, "member");
    await expect(
      f.engine.runOnline("set_role", { user_id: f.peer.id, role: "admin" }),
    ).rejects.toMatchObject({ name: "MutationError", status: 403, message: "permission denied" });
    expect(await f.storage.list()).toHaveLength(1);
    const receipt = await f.engine.mutate("update_issue", {
      id: ISSUE,
      patch: { title: "Still allowed" },
    });
    expect(await receipt.settled).toBe("applied");
  });

  it.each([500, 502, 503])("retries command HTTP %i with the same body and key", async (status) => {
    const f = fixture();
    await f.ready();
    const fetch = f.server.fetch;
    let failed = false;
    f.fetch.mockImplementation(async (...args) => {
      if (String(args[0]).endsWith("/commands") && !failed) {
        failed = true;
        return Response.json({ error: "try again" }, { status });
      }
      return fetch(...args);
    });
    const online = f.engine.runOnline("set_role", { user_id: f.peer.id, role: "viewer" });
    await until(() => f.commands().length === 1);
    await flush();
    await f.advance(1000);
    expect(await online).toMatchObject({ status: "applied" });
    expect(f.commands()).toHaveLength(2);
    expect(f.commands()[1]).toEqual(f.commands()[0]);
  });

  it("treats a missing command target as a business 404 while workspace access remains valid", async () => {
    const f = fixture();
    await f.ready();
    const fetch = f.server.fetch;
    f.fetch.mockImplementation(async (...args) =>
      String(args[0]).endsWith("/commands")
        ? Response.json({ error: "invitation not found" }, { status: 404 })
        : fetch(...args),
    );
    await expect(f.engine.runOnline("resend_invitation", { id: id(900) })).rejects.toMatchObject({
      name: "MutationError",
      status: 404,
      message: "invitation not found",
    });
    expect(await f.storage.list()).toHaveLength(1);
    expect(f.engine.store.all("issues")).toHaveLength(2);
  });

  it("keeps an online retry pending through an offline interval with the same key", async () => {
    const f = fixture();
    await f.ready();
    f.server.inject({ kind: "drop_response", route: "commands" });
    const online = f.engine.runOnline("remove_member", { user_id: f.peer.id });
    await until(() => f.commands().length === 1);
    await flush();
    f.signals.send("offline");
    await f.advance(5000);
    expect(f.commands()).toHaveLength(1);
    f.signals.send("online");
    expect(await online).toMatchObject({ status: "applied" });
    expect(f.commands()).toHaveLength(2);
    expect(f.commands()[1]).toEqual(f.commands()[0]);
  });

  it("refreshes CSRF for an online command and preserves its key", async () => {
    const f = fixture();
    await f.ready();
    f.server.rotateCsrf(f.token);
    const online = f.engine.runOnline("set_role", { user_id: f.peer.id, role: "viewer" });
    expect(await online).toMatchObject({ status: "applied" });
    expect(f.commands()).toHaveLength(2);
    expect(f.commands()[1]).toEqual(f.commands()[0]);
    expect(f.requests("me")).toBe(1);
  });

  it.each(["session", "membership"] as const)("handles online command loss of %s", async (kind) => {
    const f = fixture();
    await f.ready();
    if (kind === "session") f.server.logout(f.token);
    else f.server.removeMember(f.workspace.id, f.owner.id);
    await expect(
      f.engine.runOnline("set_role", { user_id: f.peer.id, role: "viewer" }),
    ).rejects.toMatchObject({ status: kind === "session" ? 401 : 403 });
    expect(await f.storage.list()).toEqual([{ userId: f.owner.id, workspaceId: f.workspace.id }]);
    expect(f.engine.store.all("issues")).toEqual([]);
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
    expect(f.engine.store.get("issues", id(100))?.number).toBe(3);
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

  it("waits for a pending outbox mutation before sending a REST command", async () => {
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
    expect(f.commands()).toHaveLength(0);
    await f.engine.start();
    expect(await online).toEqual({ id: 0, status: "applied" });
    expect(await receipt.settled).toBe("applied");
    await until(() => f.engine.store.get("members", f.peer.id)?.role === "viewer");
    expect(f.pushes().map((batch) => batch.map((mutation) => mutation.name))).toEqual([
      ["update_issue"],
    ]);
    expect((await f.disk()).outbox).toHaveLength(0);
    const routes = f.fetch.mock.calls.map(([url]) => String(url));
    expect(routes.findIndex((url) => url.endsWith("/commands"))).toBeGreaterThan(
      routes.findIndex((url) => url.includes("/push?")),
    );
    expect((await f.disk()).meta.nextMutationId).toBe(2);
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
    "stops on 401 and leaves every replica as it is with %s",
    async (backend) => {
      const f = fixture(
        backend === "memory"
          ? new MemoryReplicaStorage()
          : new IndexedDBReplicaStorage({ indexedDB: new IDBFactory() }),
      );
      await f.ready();
      (await f.storage.open({ userId: f.owner.id, workspaceId: id(60), schema: SCHEMA })).close();
      const events: EngineEvent[] = [];
      f.engine.subscribe((event) => events.push(event));
      f.server.logout(f.token);
      await f.engine.pull();
      await until(() => events.some((event) => event.type === "unauthorized"));
      expect(await workspacesOnDisk(f)).toEqual([f.workspace.id, id(60)].sort());
      expect(f.engine.status.get().phase).toBe("loading");
      expect(f.engine.store.all("issues")).toHaveLength(0);
    },
  );

  it("stops on 403, emits accessLost and leaves the replica as it is", async () => {
    const f = fixture();
    await f.ready();
    (await f.storage.open({ userId: f.owner.id, workspaceId: id(60), schema: SCHEMA })).close();
    const events: EngineEvent[] = [];
    f.engine.subscribe((event) => events.push(event));
    f.server.removeMember(f.workspace.id, f.owner.id);
    await f.engine.pull();
    await until(() => events.some((event) => event.type === "accessLost"));
    expect(await workspacesOnDisk(f)).toEqual([f.workspace.id, id(60)].sort());
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
      const upgraded = f.build(SCHEMA + 1);
      await upgraded.open();
      expect(upgraded.store.all("members")).toHaveLength(0);
      const reset = await f.disk();
      expect(reset.meta).toMatchObject({
        schema: SCHEMA + 1,
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

  it.each(["memory", "indexeddb"])(
    "re-bootstraps a schema 4 replica with OpenProject-era shapes and keeps its outbox with %s",
    async (backend) => {
      const f = fixture(
        backend === "memory"
          ? new MemoryReplicaStorage()
          : new IndexedDBReplicaStorage({ indexedDB: new IDBFactory() }),
      );
      // Schema 4 issues carried `openproject`, and comments had no `tracker`.
      const { tracker: _, ...current } = f.authoritativeIssue(ISSUE);
      const old = await f.storage.open({
        userId: f.owner.id,
        workspaceId: f.workspace.id,
        schema: 4,
      });
      await old.writeBootstrap({
        cursor: "1:1:",
        lastMutationId: 0,
        serverSchema: 4,
        records: { issues: [{ ...current, openproject: null }] },
        entities: ["issues"],
      });
      await old.writeScope({
        scope: { entity: "comments", issueId: ISSUE },
        records: [{ id: id(80), issue_id: ISSUE, body: "Old", created_at: f.server.now() }],
      });
      await old.appendMutation(() => ({
        name: "update_issue",
        args: { id: ISSUE, patch: { title: "Queued before upgrade" } },
        at: f.server.now(),
      }));
      const before = await old.load();
      old.close();

      await f.engine.open();
      expect(f.engine.store.all("issues")).toHaveLength(0);
      const reset = await f.disk();
      expect(reset.meta).toMatchObject({ schema: SCHEMA, cursor: null });
      expect(reset.scopes).toEqual([]);
      expect(reset.outbox).toEqual(before.outbox);
      await f.engine.start();
      await until(
        () => f.engine.status.get().phase === "ready" && f.engine.status.get().pending === 0,
      );
      const issue = f.engine.store.get("issues", ISSUE);
      expect(issue).toEqual(f.authoritativeIssue(ISSUE));
      expect(issue).toMatchObject({ title: "Queued before upgrade", tracker: null });
      expect(issue).not.toHaveProperty("openproject");
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
    f.server.inject({ kind: "unavailable", route: "commands" });
    const labels = [id(80)];
    const online = f.engine.runOnline("import_issues", {
      issues: [{ team_id: TEAM, title: "Import", labels }],
    });
    void online.catch(() => undefined);
    await until(() => f.commands().length === 1);
    await flush();
    const first = f.commands()[0];
    labels.push(id(81));
    await f.advance(5000);
    await expect(online).rejects.toMatchObject({
      status: 400,
      message: "not supported by the fake",
    });
    expect(f.commands()[1]).toEqual(first);
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
    expect(await f.storage.list()).toEqual([{ userId: f.owner.id, workspaceId: f.workspace.id }]);
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

  it("confirms a push membership 403 with a read before ending access", async () => {
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
    expect(await f.storage.list()).toEqual([{ userId: f.owner.id, workspaceId: f.workspace.id }]);
    expect(f.engine.store.all("issues")).toHaveLength(0);
    expect(f.engine.status.get().pending).toBe(0);
  });

  it("rejects an online call when a blocked push can never drain the outbox", async () => {
    const f = fixture();
    await f.ready();
    f.transport.push = async () => {
      throw new ProtocolError("Bad push body", 400);
    };
    await f.engine.mutate("update_issue", { id: ISSUE, patch: { title: "Stuck" } });
    await until(() => f.engine.status.get().lastError instanceof ProtocolError);
    const online = f.engine.runOnline("set_role", { user_id: f.peer.id, role: "viewer" });
    await expect(online).rejects.toThrow("Reload");
    expect(f.server.record("members", f.peer.id)?.role).not.toBe("viewer");
  });

  it("rejects a missing online result instead of abandoning its caller", async () => {
    const f = fixture();
    await f.ready();
    const original = f.server.fetch;
    f.fetch.mockImplementation(async (...args) => {
      const response = await original(...args);
      return String(args[0]).endsWith("/commands")
        ? Response.json({ result: {}, versions: {}, changes: [] })
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
    "rejects in-flight and waiting online calls on %s",
    async (action) => {
      const f = fixture();
      await f.ready();
      f.server.inject({ kind: "delay", route: "commands", milliseconds: 1000 });
      const first = f.engine.runOnline("set_role", { user_id: f.peer.id, role: "viewer" });
      const second = f.engine.runOnline("set_role", { user_id: f.peer.id, role: "member" });
      const rejected = [
        expect(first).rejects.toThrow(/closed|stopped/),
        expect(second).rejects.toThrow(/closed|stopped/),
      ];
      await until(() => f.commands().length === 1);
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
        `/internal-api/workspaces/${f.workspace.id}/sync/bootstrap?client_id=${before.meta.clientId}&user_id=${f.owner.id}`,
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

describe("external replica closure", () => {
  it("an upgrade stops work and rejects edits while preserving the old tab's readable view", async () => {
    const database = new IDBFactory();
    const f = fixture(new IndexedDBReplicaStorage({ indexedDB: database }));
    await f.ready();
    f.signals.send("offline");
    const receipt = await f.engine.mutate("update_issue", {
      id: ISSUE,
      patch: { title: "Unsaved draft" },
    });
    const observed = receipt.settled.catch((error: unknown) => error);
    const events: EngineEvent[] = [];
    f.engine.subscribe((event) => events.push(event));
    const view = f.engine.store.all("issues");
    const upgraded = await new IndexedDBReplicaStorage({
      indexedDB: database,
      version: IDB_VERSION + 1,
    }).open({
      userId: f.owner.id,
      workspaceId: f.workspace.id,
      schema: SCHEMA,
    });
    try {
      expect(events).toEqual([{ type: "outdated" }]);
      expect(f.engine.isClosed()).toBe(false);
      expect(f.engine.store.all("issues")).toEqual(view);
      expect(f.engine.status.get()).toMatchObject({
        phase: "ready",
        online: false,
        connected: false,
        pending: 1,
      });
      expect(f.engine.status.get().lastError).toBeInstanceOf(OutdatedError);
      expect(await observed).toBeInstanceOf(OutdatedError);
      expect((await upgraded.load()).outbox).toHaveLength(1);
      const requests = f.fetch.mock.calls.length;
      f.signals.send("online");
      await f.advance(60_000);
      await expect(f.engine.start()).rejects.toBeInstanceOf(OutdatedError);
      await expect(
        f.engine.mutate("update_issue", { id: ISSUE, patch: { title: "Blocked" } }),
      ).rejects.toThrow("Reload to continue");
      await expect(
        f.engine.runOnline("set_role", { user_id: f.peer.id, role: "admin" }),
      ).rejects.toBeInstanceOf(OutdatedError);
      expect(f.fetch.mock.calls.length).toBe(requests);
      expect(f.engine.store.get("issues", ISSUE)?.title).toBe("Unsaved draft");
      expect(() => f.engine.useScope({ entity: "comments", issueId: ISSUE })()).not.toThrow();
    } finally {
      upgraded.close();
    }
  });

  it("unexpected termination still reports access loss", async () => {
    const database = new IDBFactory();
    const original = database.open.bind(database);
    let connection: IDBDatabase | undefined;
    database.open = (...args) => {
      const request = original(...args);
      request.addEventListener("success", () => {
        connection = request.result;
      });
      return request;
    };
    const f = fixture(new IndexedDBReplicaStorage({ indexedDB: database }));
    await f.ready();
    const events: EngineEvent[] = [];
    f.engine.subscribe((event) => events.push(event));
    if (!connection) throw new Error("Replica connection missing");
    Reflect.apply(forceCloseDatabase, undefined, [connection]);
    await until(() => events.some((event) => event.type === "accessLost"));
    expect(events).toEqual([{ type: "accessLost" }]);
    expect(f.engine.store.all("issues")).toEqual([]);
  });

  it("deleting the replica reports access loss and clears its view", async () => {
    const f = fixture(new IndexedDBReplicaStorage({ indexedDB: new IDBFactory() }));
    await f.ready();
    const events: EngineEvent[] = [];
    f.engine.subscribe((event) => events.push(event));
    await f.storage.delete({ userId: f.owner.id, workspaceId: f.workspace.id });
    await until(() => events.some((event) => event.type === "accessLost"));
    expect(events).toEqual([{ type: "accessLost" }]);
    expect(f.engine.store.all("issues")).toEqual([]);
    expect(await f.storage.list()).toEqual([]);
    await expect(
      f.engine.mutate("mark_all_notifications_read", { notifications: [] }),
    ).rejects.toThrow("closed");
  });
});

describe("offline sync review fixes", () => {
  it("keeps every edit when tabs without locks or a channel push the same outbox", async () => {
    const f = fixture();
    await f.ready();
    const other = f.build();
    await other.start();
    await until(() => other.status.get().phase === "ready");
    const original = f.transport.push;
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    f.transport.push = async (...args) => {
      if (calls++ === 0) await held;
      return original(...args);
    };
    const first = await f.engine.mutate("update_issue", { id: ISSUE, patch: { title: "First" } });
    await until(() => calls > 0);
    const second = await other.mutate("update_issue", {
      id: OTHER_ISSUE,
      patch: { title: "Second" },
    });
    expect(await second.settled).toBe("applied");
    release();
    expect(await first.settled).toBe("applied");
    expect(f.authoritativeIssue(ISSUE).title).toBe("First");
    expect(f.authoritativeIssue(OTHER_ISSUE).title).toBe("Second");
  });

  it("splits a push the server refuses as too large", async () => {
    const f = fixture();
    await f.ready();
    const limit = 1024 * 1024;
    const original = f.server.fetch;
    f.fetch.mockImplementation(async (...args) => {
      const body = args[1]?.body;
      if (String(args[0]).includes("/push?") && String(body).length > limit)
        return Response.json({ error: "Payload Too Large" }, { status: 413 });
      return original(...args);
    });
    f.engine.stop();
    for (let n = 0; n < 64; n += 1)
      await f.engine.mutate("update_issue", {
        id: ISSUE,
        patch: { description: `${n} ${"x".repeat(90_000)}` },
      });
    await f.engine.start();
    await until(() => f.engine.status.get().pending === 0);
    expect(f.engine.status.get().blocked).toBe(false);
    expect(f.pushes()[0].length).toBeLessThan(64);
    expect(f.authoritativeIssue(ISSUE).description.startsWith("63 ")).toBe(true);
  });

  it("times out a stalled scope read so later edits still drain", async () => {
    const f = fixture();
    await f.ready();
    const original = f.transport.scope;
    let stalled = false;
    f.transport.scope = (...args) => {
      if (stalled) return original(...args);
      stalled = true;
      return new Promise(() => {});
    };
    f.engine.useScope({ entity: "comments", issueId: ISSUE });
    await until(() => stalled);
    const receipt = await f.engine.mutate("update_issue", { id: ISSUE, patch: { title: "Later" } });
    await f.advance(30_000);
    await until(() => f.engine.status.get().pending === 0);
    expect(await receipt.settled).toBe("applied");
    await f.advance(60_000);
    await until(() => f.engine.scopeStatus({ entity: "comments", issueId: ISSUE }) === "loaded");
  });

  it("times out a stalled push and resends the same batch", async () => {
    const f = fixture();
    await f.ready();
    const original = f.transport.push;
    let stalled = false;
    f.transport.push = (...args) => {
      if (stalled) return original(...args);
      stalled = true;
      return new Promise(() => {});
    };
    const first = await f.engine.mutate("update_issue", { id: ISSUE, patch: { title: "One" } });
    const second = await f.engine.mutate("update_issue", { id: ISSUE, patch: { title: "Two" } });
    await until(() => stalled);
    await f.advance(60_000);
    await f.advance(5000);
    await until(() => f.engine.status.get().pending === 0);
    expect(await first.settled).toBe("applied");
    expect(await second.settled).toBe("applied");
    expect(f.authoritativeIssue(ISSUE).title).toBe("Two");
  });

  it("reconnects an event stream that stops sending keep-alives", async () => {
    const f = fixture();
    f.server.inject({ kind: "close_events", afterMs: 10 });
    await f.ready();
    const original = f.transport.events;
    f.transport.events = async () => ({
      [Symbol.asyncIterator]: () => ({ next: () => new Promise<never>(() => {}) }),
    });
    await f.advance(10);
    await until(() => !f.engine.status.get().connected);
    await f.advance(1000);
    await until(() => f.engine.status.get().connected);
    f.transport.events = original;
    f.server.run(f.peer, { type: "update_issue", id: ISSUE, patch: { title: "Silent" } });
    await f.advance(60_000);
    expect(f.engine.store.get("issues", ISSUE)?.title).toBe("Original");
    await f.advance(15_000);
    await f.advance(5000);
    await until(() => f.engine.store.get("issues", ISSUE)?.title === "Silent");
  });

  it("keeps a rejected command across reopen until it is resolved", async () => {
    const f = fixture();
    await f.ready();
    f.signals.send("offline");
    await f.engine.mutate("update_issue", { id: ISSUE, patch: { dependencies: [OTHER_ISSUE] } });
    f.server.run(f.peer, {
      type: "update_issue",
      id: OTHER_ISSUE,
      patch: { dependencies: [ISSUE] },
    });
    f.signals.send("online");
    await until(() => f.engine.status.get().unresolved.length === 1);
    await until(() => f.engine.status.get().pending === 0);
    await f.engine.close();
    const reopened = f.build();
    await reopened.open();
    const [kept] = reopened.status.get().unresolved;
    expect(kept).toMatchObject({
      status: 400,
      command: { name: "update_issue", args: { patch: { dependencies: [OTHER_ISSUE] } } },
    });
    reopened.resolveRejection(kept.id);
    expect(reopened.status.get().unresolved).toEqual([]);
    await flush();
    expect((await f.disk()).rejected).toEqual([]);
  });

  it("reports a rejection whose response was lost even after a pull and reopen", async () => {
    const results: { status: string }[] = [];
    const f = fixture(new MemoryReplicaStorage(), {
      onResult: (_client, result) => results.push(result),
    });
    await f.ready();
    f.signals.send("offline");
    await f.engine.mutate("update_issue", { id: ISSUE, patch: { dependencies: [OTHER_ISSUE] } });
    f.server.run(f.peer, {
      type: "update_issue",
      id: OTHER_ISSUE,
      patch: { dependencies: [ISSUE] },
    });
    f.server.inject({ kind: "drop_response", route: "push" });
    f.signals.send("online");
    await until(() => results.length === 1);
    await f.engine.pull();
    expect(f.engine.status.get().pending).toBe(0);
    expect((await f.disk()).unconfirmed).toHaveLength(1);
    await f.engine.close();
    const reopened = f.build();
    await reopened.start();
    await until(() => reopened.status.get().rejected.length === 1);
    expect(reopened.status.get().rejected[0]).toMatchObject({
      status: 400,
      command: { name: "update_issue" },
    });
    await flush();
    expect((await f.disk()).unconfirmed).toEqual([]);
  });

  it("clears protocol blocks on unblock so the outbox drains", async () => {
    const f = fixture();
    await f.ready();
    const original = f.transport.pull;
    f.transport.pull = async () => {
      throw new ProtocolError("Bad cursor", 400);
    };
    await f.engine.mutate("update_issue", { id: ISSUE, patch: { title: "Blocked" } });
    await until(() => f.engine.status.get().blocked);
    f.transport.pull = original;
    f.engine.unblock();
    expect(f.engine.status.get()).toMatchObject({ blocked: false, lastError: null });
    await until(() => f.engine.status.get().pending === 0);
    expect(f.authoritativeIssue(ISSUE).title).toBe("Blocked");
  });
});

type Fixture = ReturnType<typeof fixture>;

/** Advances the fake clock in steps, letting the engine's async work run in between. */
async function elapse(f: Fixture, done: () => boolean, step = 1000, limit = 600) {
  for (let steps = 0; steps < limit && !done(); steps += 1) {
    f.server.advance(step);
    for (let tick = 0; tick < 20; tick += 1) await flush();
  }
  expect(done(), "scenario did not finish within the simulated time").toBe(true);
}

let signIns = 0;
/**
 * Another sign-in of `userId`: a new session over the same storage, transport and server. The
 * replica is `replicaUser`'s, which differs when the browser's cookie changed accounts under it.
 */
function signIn(f: Fixture, userId: string, replicaUser = userId): SyncEngine {
  const token = f.server.login(userId);
  setCsrf(f.server.csrfToken(token));
  const engine = createEngine({
    storage: f.storage,
    transport: createTransport({
      fetch: f.fetch,
      headers: () => ({ cookie: `blackwall_session=${token}` }),
      userId: replicaUser,
    }),
    actor: replicaUser,
    workspaceId: f.workspace.id,
    schema: SCHEMA,
    clock: { now: f.server.now, schedule: f.server.schedule },
    randomId: () => id(5000 + signIns++),
    signals: f.signals,
  });
  engines.push(engine);
  return engine;
}

const titled = (issues: readonly { title: string }[], title: string) =>
  issues.filter((issue) => issue.title === title);

describe("pending edits are never frozen or lost", () => {
  it("continues the same replica when the user signs in again after a 401", async () => {
    const f = fixture();
    await f.ready();
    const { clientId } = (await f.disk()).meta;
    const events: EngineEvent[] = [];
    f.engine.subscribe((event) => events.push(event));
    f.server.inject({ kind: "drop_response", route: "push" });
    await f.engine.mutate("create_issue", {
      input: { title: "Its response was lost", team_id: TEAM },
    });
    await until(() => f.pushes().length === 1);
    f.signals.send("offline");
    await f.engine.mutate("create_issue", { input: { title: "Typed offline", team_id: TEAM } });
    f.server.logout(f.token);
    f.signals.send("online");
    await until(() => events.some((event) => event.type === "unauthorized"));
    expect(await f.storage.list()).toEqual([{ userId: f.owner.id, workspaceId: f.workspace.id }]);

    const second = signIn(f, f.owner.id);
    await second.start();
    await until(() => second.status.get().phase === "ready" && second.status.get().pending === 0);
    const issues = f.server.records("issues");
    expect(titled(issues, "Its response was lost")).toHaveLength(1);
    expect(titled(issues, "Typed offline")).toHaveLength(1);
    expect(f.server.clientState(clientId).last_mutation_id).toBe(2);
    expect(second.status.get()).toMatchObject({ rejected: [], unresolved: [] });
    expect(events.some((event) => event.type === "rejected")).toBe(false);
    expect(await f.storage.list()).toEqual([{ userId: f.owner.id, workspaceId: f.workspace.id }]);
    expect((await f.disk()).meta.clientId).toBe(clientId);
  });

  it("keeps an edit through a 5xx streak while reads work, reports a stall, and applies it on recovery", async () => {
    const f = fixture();
    await f.ready();
    f.server.poisonMutation(1, "error");
    const receipt = await f.engine.mutate("update_issue", {
      id: ISSUE,
      patch: { description: "Text the user typed" },
    });
    const later = await f.engine.mutate("update_issue", { id: ISSUE, patch: { title: "Later" } });
    await elapse(f, () => f.engine.status.get().stalled);
    expect(f.engine.status.get()).toMatchObject({ pending: 2, blocked: false, unresolved: [] });

    await elapse(f, () => f.pushes().length >= 15);
    expect(f.engine.status.get()).toMatchObject({
      stalled: true,
      pending: 2,
      blocked: false,
      rejected: [],
      unresolved: [],
    });
    expect(f.authoritativeIssue(ISSUE).description).toBe("");
    expect(f.pushes().every((batch) => batch[0].id === 1)).toBe(true);

    f.server.healMutation(1);
    await elapse(f, () => f.engine.status.get().pending === 0);
    expect(await receipt.settled).toBe("applied");
    expect(await later.settled).toBe("applied");
    expect(f.engine.status.get()).toMatchObject({ stalled: false, rejected: [], unresolved: [] });
    expect(f.authoritativeIssue(ISSUE)).toMatchObject({
      title: "Later",
      description: "Text the user typed",
    });
    expect(f.engine.store.get("issues", ISSUE)).toEqual(f.authoritativeIssue(ISSUE));
  });

  it.each(["network", "outage"] as const)(
    "keeps an edit through a %s failure and applies it afterwards",
    async (kind) => {
      const f = fixture();
      await f.ready();
      const original = f.server.fetch;
      let down = true;
      let attempts = 0;
      f.fetch.mockImplementation(async (...args) => {
        const url = String(args[0]);
        if (!down || !url.includes("/sync/")) return original(...args);
        if (url.includes("/push?")) attempts += 1;
        if (kind === "network") throw new TypeError("Failed to fetch");
        return Response.json({ error: "down" }, { status: 503 });
      });
      const receipt = await f.engine.mutate("update_issue", {
        id: ISSUE,
        patch: { title: "Kept through the outage" },
      });
      await elapse(f, () => attempts >= 12);
      expect(f.engine.status.get().unresolved).toEqual([]);
      down = false;
      await elapse(f, () => f.engine.status.get().pending === 0);
      expect(await receipt.settled).toBe("applied");
      expect(f.engine.status.get()).toMatchObject({ rejected: [], unresolved: [] });
      expect(f.authoritativeIssue(ISSUE).title).toBe("Kept through the outage");
    },
  );

  it("neither duplicates nor rejects an edit the server committed before a 502", async () => {
    const f = fixture();
    await f.ready();
    f.server.inject({ kind: "fail_response", route: "push", status: 502 });
    const receipt = await f.engine.mutate("create_issue", {
      input: { title: "Committed before the 502", team_id: TEAM },
    });
    let outcome: unknown;
    void receipt.settled.then((value) => (outcome = value));
    await elapse(f, () => outcome !== undefined && f.engine.status.get().pending === 0);
    expect(outcome).toBe("applied");
    expect(titled(f.server.records("issues"), "Committed before the 502")).toHaveLength(1);
    expect(f.engine.status.get()).toMatchObject({ rejected: [], unresolved: [], stalled: false });
    expect(f.engine.store.all("issues")).toHaveLength(3);
  });

  it("sets a single mutation the server refuses as too large aside, without blocking", async () => {
    const f = fixture(new MemoryReplicaStorage(), { maxPushBytes: 1500 });
    await f.ready();
    f.signals.send("offline");
    const receipts = [
      await f.engine.mutate("update_issue", { id: ISSUE, patch: { title: "Small" } }),
      await f.engine.mutate("update_issue", {
        id: ISSUE,
        patch: { description: "x".repeat(4000) },
      }),
      await f.engine.mutate("update_issue", { id: ISSUE, patch: { title: "Also small" } }),
    ];
    f.signals.send("online");
    await elapse(f, () => f.engine.status.get().pending === 0);

    expect(await Promise.all(receipts.map((receipt) => receipt.settled))).toMatchObject([
      "applied",
      { id: 2, status: 413, message: "This edit is too large to save." },
      "applied",
    ]);
    expect(f.engine.status.get().blocked).toBe(false);
    expect(f.engine.status.get().unresolved).toMatchObject([
      { id: 2, command: { args: { patch: { description: "x".repeat(4000) } } } },
    ]);
    expect(f.engine.store.get("issues", ISSUE)).toEqual(f.authoritativeIssue(ISSUE));
  });

  it("does not set aside a too-large mutation the server already processed", async () => {
    const f = fixture(new MemoryReplicaStorage(), { maxPushBytes: 1500 });
    await f.ready();
    f.engine.stop();
    const receipt = await f.engine.mutate("update_issue", {
      id: ISSUE,
      patch: { description: "x".repeat(4000) },
    });
    const { meta, outbox } = await f.disk();
    const small = { id: 1, name: "update_issue", args: { id: ISSUE, patch: { title: "A" } } };
    await f.transport.push(f.workspace.id, meta.clientId, [{ ...small, at: outbox[0].at }]);
    await f.engine.start();
    expect(await receipt.settled).toBe("unknown");
    expect(f.engine.status.get()).toMatchObject({ rejected: [], unresolved: [] });
  });

  it("treats a proxy 404 on push as a protocol error and keeps the replica", async () => {
    const f = fixture();
    await f.ready();
    const original = f.server.fetch;
    f.fetch.mockImplementation(async (...args) =>
      String(args[0]).includes("/push?")
        ? new Response("<html>Not Found</html>", {
            status: 404,
            headers: { "Content-Type": "text/html" },
          })
        : original(...args),
    );
    const events: EngineEvent[] = [];
    f.engine.subscribe((event) => events.push(event));
    await f.engine.mutate("update_issue", { id: ISSUE, patch: { title: "Edit" } });
    await until(() => f.engine.status.get().blocked);
    expect(events.some((event) => event.type === "accessLost")).toBe(false);
    expect(await f.storage.list()).toHaveLength(1);
    expect(f.engine.status.get().pending).toBe(1);
  });

  it("keeps the replica and its edits when access is lost, and pushes them when access returns", async () => {
    const f = fixture();
    await f.ready();
    const { clientId } = (await f.disk()).meta;
    const events: EngineEvent[] = [];
    f.engine.subscribe((event) => events.push(event));
    f.signals.send("offline");
    await f.engine.mutate("create_label", { name: "Typed before access ended", color: "#00ff00" });
    f.server.removeMember(f.workspace.id, f.owner.id);
    f.signals.send("online");
    await until(() => events.some((event) => event.type === "accessLost"));

    const disk = await f.disk();
    expect(disk.outbox).toMatchObject([{ id: 1, name: "create_label" }]);
    expect(disk.rejected).toEqual([]);
    expect(f.server.clientState(clientId).last_mutation_id).toBe(0);

    f.server.addMember(f.workspace.id, f.owner, "owner");
    const returned = f.build();
    await returned.start();
    await until(
      () => returned.status.get().phase === "ready" && returned.status.get().pending === 0,
    );
    expect(returned.status.get()).toMatchObject({ rejected: [], unresolved: [] });
    expect(f.server.clientState(clientId).last_mutation_id).toBe(1);
    expect(
      f.server.records("labels").filter((label) => label.name === "Typed before access ended"),
    ).toHaveLength(1);
  });

  it("reports an outcome as unknown when the server no longer remembers a rejection", async () => {
    const f = fixture();
    await f.ready();
    f.engine.stop();
    const receipt = await f.engine.mutate("update_issue", {
      id: ISSUE,
      patch: { dependencies: [OTHER_ISSUE] },
    });
    f.server.run(f.peer, {
      type: "update_issue",
      id: OTHER_ISSUE,
      patch: { dependencies: [ISSUE] },
    });
    const { meta, outbox } = await f.disk();
    expect((await f.transport.push(f.workspace.id, meta.clientId, outbox)).results[0].status).toBe(
      "rejected",
    );
    for (let batch = 0; batch < 10; batch += 1)
      await f.transport.push(
        f.workspace.id,
        meta.clientId,
        Array.from({ length: 100 }, (_, index) => ({
          id: 2 + batch * 100 + index,
          name: "update_issue",
          args: { id: id(500), patch: { title: "Gone" } },
          at: "2026-10-09T12:00:00Z",
        })),
      );
    await f.engine.start();
    expect(await receipt.settled).toBe("unknown");
    expect(f.engine.status.get().rejected).toEqual([]);
  });

  it("stops without pushing when the cookie belongs to another user than the replica", async () => {
    const f = fixture();
    await f.ready();
    const { clientId } = (await f.disk()).meta;
    f.engine.stop();
    await f.engine.mutate("create_label", { name: "Typed as the first user", color: "#00ff00" });
    await f.engine.close();

    const stale = signIn(f, f.peer.id, f.owner.id);
    const events: EngineEvent[] = [];
    stale.subscribe((event) => events.push(event));
    await stale.start();
    await until(() => events.some((event) => event.type === "unauthorized"));
    expect(stale.status.get().lastError).toMatchObject({ message: "account changed", status: 401 });
    const requests = f.fetch.mock.calls.length;
    await f.advance(120_000);
    expect(f.fetch.mock.calls.length).toBe(requests);

    expect(f.server.clientState(clientId).last_mutation_id).toBe(0);
    expect(f.server.records("labels")).toHaveLength(0);
    expect((await f.disk()).outbox).toMatchObject([{ id: 1, name: "create_label" }]);
    expect(await f.storage.list()).toEqual([{ userId: f.owner.id, workspaceId: f.workspace.id }]);
  });

  it.each(["pull", "bootstrap"] as const)(
    "stops pushing and reports a blocked state when a %s acknowledges fewer mutations than the replica holds",
    async (route) => {
      const f = fixture();
      await f.ready();
      await f.engine.mutate("create_label", { name: "Acknowledged", color: "#00ff00" });
      await until(() => f.engine.status.get().pending === 0);
      expect((await f.disk()).meta.lastMutationId).toBe(1);

      const original = f.server.fetch;
      f.fetch.mockImplementation(async (...args) => {
        const response = await original(...args);
        const url = String(args[0]);
        if (route === "pull" && url.includes("/pull?")) {
          const body = await response.json();
          return Response.json({ ...body, last_mutation_id: body.last_mutation_id && 0 });
        }
        if (route === "bootstrap" && url.includes("/bootstrap?")) {
          const [header, ...rest] = (await response.text()).split("\n");
          const forgotten = JSON.stringify({ ...JSON.parse(header), last_mutation_id: 0 });
          return new Response([forgotten, ...rest].join("\n"), { headers: response.headers });
        }
        return response;
      });
      if (route === "bootstrap") f.server.inject({ kind: "reset_pull" });
      f.server.run(f.owner, { type: "create_label", name: "Elsewhere", color: "#0000ff" });
      const pushes = f.pushes().length;
      await f.engine.pull();
      await until(() => f.engine.status.get().blocked);
      expect(f.engine.status.get().lastError).toBeInstanceOf(ProtocolError);
      expect(f.engine.status.get().lastError?.message).toContain("already holds 1");

      await f.engine.mutate("create_label", { name: "Must wait", color: "#ff0000" });
      await f.advance(120_000);
      expect(f.pushes()).toHaveLength(pushes);
      expect(f.engine.status.get().pending).toBe(1);
      expect((await f.disk()).meta.lastMutationId).toBe(1);
    },
  );

  it("blocks pushing and keeps the outbox when the server refuses a push as lost client state", async () => {
    const f = fixture();
    await f.ready();
    await f.engine.mutate("create_label", { name: "Acknowledged", color: "#00ff00" });
    await until(() => f.engine.status.get().pending === 0);
    const { clientId, lastMutationId } = (await f.disk()).meta;
    expect(lastMutationId).toBe(1);

    const original = f.server.fetch;
    f.fetch.mockImplementation((...args) =>
      String(args[0]).includes("/pull?") ? new Promise<Response>(() => {}) : original(...args),
    );
    f.server.loseClient(clientId);
    const pushes = f.pushes().length;
    await f.engine.mutate("create_label", { name: "Must not run", color: "#ff0000" });
    await until(() => f.engine.status.get().blocked);
    expect(f.engine.status.get().lastError).toBeInstanceOf(ProtocolError);
    expect(f.engine.status.get().lastError).toMatchObject({
      status: 409,
      message: "client state lost",
    });
    const refused = f.fetch.mock.calls.filter(([url]) => String(url).includes("/push?")).at(-1);
    expect(JSON.parse(String(refused?.[1]?.body)).acknowledged).toBe(1);

    await f.advance(120_000);
    expect(f.pushes()).toHaveLength(pushes + 1);
    expect(f.server.records("labels").map((label) => label.name)).toEqual(["Acknowledged"]);
    expect(f.server.clientState(clientId).last_mutation_id).toBe(0);
    expect(f.engine.status.get().pending).toBe(1);
    expect((await f.disk()).outbox).toMatchObject([{ id: 2, name: "create_label" }]);
  });

  describe("a single too-large mutation waits for a final acknowledgement", () => {
    async function oversized(options: { processed: boolean; reset: boolean; held?: boolean }) {
      const f = fixture(new MemoryReplicaStorage(), { maxPushBytes: 1500, pageSize: 1 });
      await f.ready();
      f.engine.stop();
      const receipt = await f.engine.mutate("update_issue", {
        id: ISSUE,
        patch: { description: "x".repeat(4000) },
      });
      const { meta, outbox } = await f.disk();
      if (options.processed) {
        const small = { id: 1, name: "update_issue", args: { id: ISSUE, patch: { title: "A" } } };
        await f.transport.push(f.workspace.id, meta.clientId, [{ ...small, at: outbox[0].at }]);
      }
      for (const [index, name] of ["One", "Two", "Three"].entries())
        f.server.run(f.owner, {
          type: "create_label",
          id: id(700 + index),
          name,
          color: "#0000ff",
        });
      const held: (() => void)[] = [];
      const delivered: { final: boolean; more: boolean; reset: boolean; ack: number | null }[] = [];
      if (options.held) {
        const original = f.server.fetch;
        f.fetch.mockImplementation(async (...args) => {
          if (!String(args[0]).includes("/pull?")) return original(...args);
          await new Promise<void>((release) => held.push(release));
          const response = await original(...args);
          const page = await response.clone().json();
          delivered.push({
            final: !page.more && !page.reset && page.last_mutation_id !== null,
            more: page.more,
            reset: page.reset,
            ack: page.last_mutation_id,
          });
          return response;
        });
      }
      if (options.reset) {
        const original = f.server.fetch;
        let refused = false;
        f.fetch.mockImplementation(async (...args) => {
          const url = String(args[0]);
          if (refused && url.includes("/pull?")) {
            refused = false;
            f.server.inject({ kind: "reset_pull" });
          }
          const response = await original(...args);
          if (url.includes("/push?") && response.status === 413) refused = true;
          return response;
        });
      }
      await f.engine.start();
      return { f, receipt, held, delivered };
    }

    it.each([true, false])(
      "decides only after the final page, with every pull held, processed %s",
      async (processed) => {
        const { f, receipt, held, delivered } = await oversized({
          processed,
          reset: false,
          held: true,
        });
        let decided = false;
        void receipt.settled.then(() => (decided = true));
        for (let step = 0; step < 100 && !decided; step += 1) {
          await until(() => held.length > 0 || decided);
          if (decided) break;
          held.shift()?.();
          for (let tick = 0; tick < 5; tick += 1) await flush();
          if (!delivered.some((page) => page.final)) {
            expect(decided, `decided early after ${JSON.stringify(delivered)}`).toBe(false);
            expect((await f.disk()).outbox).toHaveLength(1);
          }
        }
        expect(delivered.filter((page) => !page.final).length).toBeGreaterThan(1);
        await until(() => decided);
        expect(await receipt.settled).toEqual(
          processed ? "unknown" : expect.objectContaining({ status: 413 }),
        );
      },
    );

    it.each([false, true])(
      "settles unknown when the server processed it, reset %s",
      async (reset) => {
        const { f, receipt } = await oversized({ processed: true, reset });
        expect(await receipt.settled).toBe("unknown");
        expect(f.engine.status.get()).toMatchObject({
          rejected: [],
          unresolved: [],
          blocked: false,
        });
        await until(() => f.engine.status.get().pending === 0);
        expect((await f.disk()).rejected).toEqual([]);
      },
    );

    it.each([false, true])(
      "sets it aside as a 413 when it was not processed, reset %s",
      async (reset) => {
        const { f, receipt } = await oversized({ processed: false, reset });
        expect(await receipt.settled).toMatchObject({ id: 1, status: 413 });
        await until(() => f.engine.status.get().unresolved.length === 1);
        expect(f.engine.status.get().unresolved).toMatchObject([{ id: 1 }]);
        expect((await f.disk()).outbox).toEqual([]);
        expect(f.authoritativeIssue(ISSUE).description).toBe("");
      },
    );
  });

  it("does not show a cached workspace as ready after access was lost until a read succeeds", async () => {
    const f = fixture();
    await f.ready();
    const lost: EngineEvent[] = [];
    f.engine.subscribe((event) => lost.push(event));
    f.server.removeMember(f.workspace.id, f.owner.id);
    await f.engine.pull();
    await until(() => lost.some((event) => event.type === "accessLost"));
    expect((await f.disk()).meta.accessLost).toBe(true);

    const denied = f.build();
    const phases: string[] = [];
    denied.status.subscribe(() => phases.push(denied.status.get().phase));
    const events: EngineEvent[] = [];
    denied.subscribe((event) => events.push(event));
    await denied.open();
    expect(denied.status.get().phase).toBe("loading");
    await denied.start();
    await until(() => events.some((event) => event.type === "accessLost"));
    expect(phases).not.toContain("ready");
    expect((await f.disk()).meta.accessLost).toBe(true);

    f.server.addMember(f.workspace.id, f.owner, "owner");
    const returned = f.build();
    await returned.open();
    expect(returned.status.get().phase).toBe("loading");
    await returned.start();
    await until(() => returned.status.get().phase === "ready");
    expect((await f.disk()).meta.accessLost).toBe(false);
  });
});
