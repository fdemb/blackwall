import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { SCHEMA } from "../sync/engine";
import { createTabHub } from "../sync/testing/tabs";
import { createFakeServer } from "../sync/testing/fake-server";
import { currentProfile } from "./auth-guard";
import { auth, setCsrf } from "./api";
import {
  activeWorkspaceEngine,
  acceptSession,
  clearSession,
  closeAllWorkspaceEngines,
  currentSession,
  replicaStorage,
  sessionHasPending,
} from "./session-replicas";
import {
  browserTabDependencies,
  attachWorkspaceEngine,
  openWorkspaceEngine,
} from "./workspace-engine";
import { logoutSession } from "./session";
import { runCommand, waitForUploadTarget } from "./workspace-commands";

const id = (n: number) => `22222222-2222-4222-8222-${String(n).padStart(12, "0")}`;
const servers: ReturnType<typeof createFakeServer>[] = [];
const assign = vi.fn();
async function until(check: () => boolean) {
  for (let step = 0; step < 300; step += 1) {
    if (check()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  expect(check()).toBe(true);
}
async function seed(sessionId: string, workspaceId: string, pending = false) {
  const replica = await replicaStorage().open({ sessionId, workspaceId, schema: SCHEMA });
  if (pending)
    await replica.appendMutation(() => ({
      name: "mark_all_notifications_read",
      args: {},
      at: "2026-10-09T12:00:00Z",
    }));
  replica.close();
}
async function fixture() {
  const server = createFakeServer();
  servers.push(server);
  const owner = server.addUser();
  const workspace = server.addWorkspace();
  server.addMember(workspace.id, owner, "owner");
  server.run(owner, {
    type: "create_team",
    id: id(1),
    name: "Team",
    members: [],
    default_stage_ids: [id(10), id(11), id(12), id(13)],
  });
  server.run(owner, {
    type: "create_issue",
    input: { id: id(2), title: "On disk", team_id: id(1) },
  });
  const token = server.login(owner);
  setCsrf(server.csrfToken(token));
  const fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    headers.set("cookie", `blackwall_session=${token}`);
    return server.fetch(input, { ...init, headers });
  });
  vi.stubGlobal("fetch", fetch);
  const profile = await currentProfile();
  if (!profile) throw new Error("fixture login failed");
  return { server, owner, workspace, token, profile, fetch };
}
beforeEach(() => {
  assign.mockClear();
  vi.stubGlobal("navigator", { onLine: true });
  vi.stubGlobal("window", Object.assign(new EventTarget(), { location: { assign } }));
  vi.stubGlobal("document", Object.assign(new EventTarget(), { visibilityState: "visible" }));
  vi.stubGlobal("sessionStorage", {
    clear: vi.fn(),
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await clearSession();
  await replicaStorage().deleteAllExcept(null);
  for (const server of servers.splice(0)) server.close();
  vi.unstubAllGlobals();
});

describe("session replica lifetime", () => {
  it("GET /api/me deletes other sessions' replicas and preserves this session", async () => {
    const { profile } = await fixture();
    await seed(id(90), id(91), true);
    await seed(profile.session_id, id(92));
    await currentProfile();
    expect(await replicaStorage().list()).toEqual([
      { sessionId: profile.session_id, workspaceId: id(92) },
    ]);
    expect(currentSession()?.session_id).toBe(profile.session_id);
  });
  it("an older /api/me reply that lands last neither changes the session nor deletes the newer replica", async () => {
    const { profile } = await fixture();
    let resolveOlder: (value: typeof profile) => void = () => {};
    let resolveNewer: (value: typeof profile) => void = () => {};
    vi.spyOn(auth, "me")
      .mockImplementationOnce(() => new Promise((resolve) => (resolveOlder = resolve)))
      .mockImplementationOnce(() => new Promise((resolve) => (resolveNewer = resolve)));
    const older = currentProfile();
    const newer = currentProfile();
    const newerProfile = { ...profile, session_id: id(99) };
    resolveNewer(newerProfile);
    await expect(newer).resolves.toEqual(newerProfile);
    const replica = await replicaStorage().open({
      sessionId: newerProfile.session_id,
      workspaceId: id(90),
      schema: SCHEMA,
    });
    await replica.appendMutation(() => ({
      name: "mark_all_notifications_read",
      args: {},
      at: "2026-10-09T12:00:00Z",
    }));
    replica.close();
    resolveOlder(profile);
    await expect(older).resolves.toEqual(newerProfile);
    expect(currentSession()?.session_id).toBe(newerProfile.session_id);
    expect(await replicaStorage().list()).toEqual([
      { sessionId: newerProfile.session_id, workspaceId: id(90) },
    ]);
  });
  it("detects pending edits in an unopened workspace and deletes replicas before the logout request", async () => {
    const { profile, fetch } = await fixture();
    await seed(profile.session_id, id(91), true);
    expect(await sessionHasPending()).toBe(true);
    fetch.mockImplementationOnce(async () => {
      expect(await replicaStorage().list()).toEqual([]);
      return new Response(null, { status: 204 });
    });
    await logoutSession();
    expect(fetch.mock.calls.at(-1)?.[0]).toBe("/api/auth/logout");
    expect(currentSession()).toBeNull();
    expect(assign).toHaveBeenCalledWith("/login");
  });
  it("changing session closes the previous engine and removes its replicas", async () => {
    const { profile, workspace } = await fixture();
    const engine = await openWorkspaceEngine(workspace.id);
    await acceptSession({ ...profile, session_id: id(99) });
    expect(await replicaStorage().list()).toEqual([]);
    expect(activeWorkspaceEngine(workspace.id)).toBeNull();
    await expect(engine.mutate("mark_all_notifications_read", {})).rejects.toThrow("closed");
  });
  it("unauthorized sync clears the current session and returns to login after deleting its replicas", async () => {
    const { server, token, workspace, profile } = await fixture();
    const engine = await openWorkspaceEngine(workspace.id);
    await seed(id(90), id(91));
    server.logout(token);
    await engine.pull();
    await until(() => assign.mock.calls.length > 0);
    expect(assign).toHaveBeenCalledWith("/login");
    expect(currentSession()).toBeNull();
    expect(
      (await replicaStorage().list()).some((replica) => replica.sessionId === profile.session_id),
    ).toBe(false);
    expect(await replicaStorage().list()).toEqual([{ sessionId: id(90), workspaceId: id(91) }]);
  });
  it("access loss deletes only the workspace replica and leaves for home", async () => {
    const { server, owner, workspace, profile } = await fixture();
    const engine = await openWorkspaceEngine(workspace.id);
    await seed(profile.session_id, id(91));
    server.removeMember(workspace.id, owner.id);
    await engine.pull();
    await until(() => assign.mock.calls.length > 0);
    expect(assign).toHaveBeenCalledWith("/");
    expect(currentSession()?.session_id).toBe(profile.session_id);
    expect(await replicaStorage().list()).toEqual([
      { sessionId: profile.session_id, workspaceId: id(91) },
    ]);
  });
});

async function settle() {
  for (let step = 0; step < 50; step += 1)
    await new Promise<void>((resolve) => setImmediate(resolve));
}
describe("workspace loader lifecycle", () => {
  it("opens a disk replica while its pull is delayed and reuses the current engine", async () => {
    const { server, owner, workspace } = await fixture();
    const initial = await openWorkspaceEngine(workspace.id);
    await initial.pull();
    await closeAllWorkspaceEngines();
    server.run(owner, { type: "update_issue", id: id(2), patch: { title: "On server" } });
    server.inject({ kind: "delay", route: "pull", milliseconds: 60_000 });
    const reopened = await openWorkspaceEngine(workspace.id);
    expect(reopened.store.get("issues", id(2))?.title).toBe("On disk");
    expect(reopened.status.get().phase).toBe("ready");
    expect(await openWorkspaceEngine(workspace.id)).toBe(reopened);
  });
  it("switching workspaces closes the previous engine once its screen unmounts", async () => {
    const { server, owner, workspace } = await fixture();
    const previous = await openWorkspaceEngine(workspace.id);
    const detach = attachWorkspaceEngine(previous);
    const other = server.addWorkspace();
    server.addMember(other.id, owner, "owner");
    const next = await openWorkspaceEngine(other.id);
    expect(activeWorkspaceEngine(other.id)?.engine).toBe(next);
    expect(next.store.get("workspace", other.id)?.id).toBe(other.id);
    await expect(previous.mutate("mark_all_notifications_read", {})).resolves.toBeDefined();
    detach();
    await previous.retire();
    await expect(previous.mutate("mark_all_notifications_read", {})).rejects.toThrow("closed");
  });
  it("leaving a workspace with an empty outbox closes its engine", async () => {
    const { workspace } = await fixture();
    const engine = await openWorkspaceEngine(workspace.id);
    attachWorkspaceEngine(engine)();
    await engine.retire();
    expect(activeWorkspaceEngine(workspace.id)).toBeNull();
    await expect(engine.mutate("mark_all_notifications_read", {})).rejects.toThrow("closed");
  });
  it("leaving with pending edits keeps sending them and closes only after the outbox is empty", async () => {
    const { server, workspace, fetch } = await fixture();
    const engine = await openWorkspaceEngine(workspace.id);
    server.inject({ kind: "delay", route: "push", milliseconds: 60_000 });
    await engine.mutate("update_issue", { id: id(2), patch: { title: "Sent after leaving" } });
    await until(() => fetch.mock.calls.some(([url]) => String(url).includes("/push?")));
    attachWorkspaceEngine(engine)();
    let closed = false;
    void engine.retire().then(() => {
      closed = true;
    });
    await expect(engine.mutate("mark_all_notifications_read", {})).rejects.toThrow("retiring");
    await settle();
    expect(closed).toBe(false);
    server.advance(60_000);
    await until(() => closed);
    expect(server.record("issues", id(2))?.title).toBe("Sent after leaving");
    expect(activeWorkspaceEngine(workspace.id)).toBeNull();
  });
  it("returning to a leaving workspace before it closes reuses its engine", async () => {
    const { server, workspace, fetch } = await fixture();
    const engine = await openWorkspaceEngine(workspace.id);
    server.inject({ kind: "delay", route: "push", milliseconds: 60_000 });
    await engine.mutate("update_issue", { id: id(2), patch: { title: "Kept" } });
    await until(() => fetch.mock.calls.some(([url]) => String(url).includes("/push?")));
    attachWorkspaceEngine(engine)();
    let closed = false;
    void engine.retire().then(() => {
      closed = true;
    });
    expect(await openWorkspaceEngine(workspace.id)).toBe(engine);
    expect(activeWorkspaceEngine(workspace.id)?.engine).toBe(engine);
    server.advance(60_000);
    await until(() => engine.status.get().pending === 0);
    await settle();
    expect(closed).toBe(false);
    await expect(engine.mutate("mark_all_notifications_read", {})).resolves.toBeDefined();
  });
  it("a leaving workspace stays open while offline and closes once it is back online and drained", async () => {
    const { server, workspace } = await fixture();
    const engine = await openWorkspaceEngine(workspace.id);
    window.dispatchEvent(new Event("offline"));
    await engine.mutate("update_issue", { id: id(2), patch: { title: "Offline edit" } });
    attachWorkspaceEngine(engine)();
    let closed = false;
    void engine.retire().then(() => {
      closed = true;
    });
    await settle();
    expect(closed).toBe(false);
    window.dispatchEvent(new Event("online"));
    await until(() => closed);
    expect(server.record("issues", id(2))?.title).toBe("Offline edit");
  });
  it("closing a workspace rejects uploads waiting for unconfirmed creates", async () => {
    const { workspace } = await fixture();
    const engine = await openWorkspaceEngine(workspace.id);
    engine.stop();
    await runCommand(engine, {
      type: "create_issue",
      input: { id: id(200), title: "Queued", team_id: id(1) },
    });
    const upload = waitForUploadTarget(engine, id(200));
    const observed = upload.catch((error: unknown) => error);
    await closeAllWorkspaceEngines();
    expect(await observed).toMatchObject({ message: "Workspace engine closed" });
  });
  it("an aborted open of another workspace leaves the mounted one writable", async () => {
    const { server, owner, workspace, fetch } = await fixture();
    const other = server.addWorkspace();
    server.addMember(other.id, owner, "owner");
    const mounted = await openWorkspaceEngine(workspace.id);
    const detach = attachWorkspaceEngine(mounted);
    server.inject({ kind: "delay", route: "bootstrap", milliseconds: 60_000 });
    const navigation = new AbortController();
    const observed = openWorkspaceEngine(other.id, navigation.signal).catch(
      (error: unknown) => error,
    );
    await until(() => fetch.mock.calls.some(([url]) => String(url).includes(`/sync/bootstrap`)));
    navigation.abort();
    expect(await observed).toMatchObject({ message: "Workspace navigation cancelled" });
    expect(activeWorkspaceEngine(other.id)).toBeNull();
    await expect(mounted.mutate("mark_all_notifications_read", {})).resolves.toBeDefined();
    detach();
  });
  it("opening another workspace keeps the mounted one writable until its screen unmounts", async () => {
    const { server, owner, workspace } = await fixture();
    const other = server.addWorkspace();
    server.addMember(other.id, owner, "owner");
    const first = await openWorkspaceEngine(workspace.id);
    const detachFirst = attachWorkspaceEngine(first);
    const second = await openWorkspaceEngine(other.id);
    const detachSecond = attachWorkspaceEngine(second);
    await expect(first.mutate("mark_all_notifications_read", {})).resolves.toBeDefined();
    detachFirst();
    await first.retire();
    expect(activeWorkspaceEngine(workspace.id)).toBeNull();
    await expect(first.mutate("mark_all_notifications_read", {})).rejects.toThrow("closed");
    expect(activeWorkspaceEngine(other.id)?.engine).toBe(second);
    await expect(second.mutate("mark_all_notifications_read", {})).resolves.toBeDefined();
    detachSecond();
  });
  it("a strict-mode remount in the same turn keeps the engine writable", async () => {
    const { workspace } = await fixture();
    const engine = await openWorkspaceEngine(workspace.id);
    attachWorkspaceEngine(engine)();
    const detach = attachWorkspaceEngine(engine);
    await settle();
    await expect(engine.mutate("mark_all_notifications_read", {})).resolves.toBeDefined();
    expect(activeWorkspaceEngine(workspace.id)?.engine).toBe(engine);
    detach();
  });
});

function tabBrowser(hub: ReturnType<typeof createTabHub>) {
  return {
    locks: hub.locks,
    BroadcastChannel: class {
      private readonly endpoint;
      constructor(name: string) {
        this.endpoint = hub.channel(name);
      }
      postMessage: ReturnType<typeof hub.channel>["postMessage"] = (message) =>
        this.endpoint.postMessage(message);
      addEventListener: ReturnType<typeof hub.channel>["addEventListener"] = (type, listener) =>
        this.endpoint.addEventListener(type, listener);
      removeEventListener: ReturnType<typeof hub.channel>["removeEventListener"] = (
        type,
        listener,
      ) => this.endpoint.removeEventListener(type, listener);
      close = () => this.endpoint.close();
    },
  };
}

describe("app tab coordination", () => {
  it("adapts browser locks and constructs named channels when both are available", async () => {
    const hub = createTabHub();
    const browser = tabBrowser(hub);
    const request = vi.spyOn(browser.locks, "request");
    const deps = browserTabDependencies(browser);
    const callback = vi.fn(async () => {});
    await deps.locks?.request("workspace", callback);
    expect(request).toHaveBeenCalledWith("workspace", callback);
    expect(callback).toHaveBeenCalledOnce();
    const receive = vi.fn();
    const channel = deps.channel?.("workspace");
    channel?.addEventListener("message", receive);
    const sender = hub.channel("workspace");
    sender.postMessage({ type: "hello", from: "other" });
    await settle();
    expect(receive).toHaveBeenCalledWith({ data: { type: "hello", from: "other" } });
    channel?.close();
    sender.close();
  });

  it("passes neither dependency when either browser API is unavailable", () => {
    const browser = tabBrowser(createTabHub());
    expect(browserTabDependencies({})).toEqual({});
    expect(browserTabDependencies({ locks: browser.locks })).toEqual({});
    expect(browserTabDependencies({ BroadcastChannel: browser.BroadcastChannel })).toEqual({});
  });

  async function twoTabs() {
    const hub = createTabHub();
    const browser = tabBrowser(hub);
    vi.stubGlobal("navigator", { onLine: true, locks: browser.locks });
    vi.stubGlobal("BroadcastChannel", browser.BroadcastChannel);
    const f = await fixture();
    const first = await openWorkspaceEngine(f.workspace.id);
    // A fresh module graph gives the second tab its own app session and engine registry.
    vi.resetModules();
    const secondSession = await import("./session-replicas");
    const secondApp = await import("./workspace-engine");
    await secondSession.acceptSession(f.profile);
    const second = await secondApp.openWorkspaceEngine(f.workspace.id);
    await until(() => first.status.get().connected && second.status.get().connected);
    return { ...f, hub, first, second, secondSession, secondApp };
  }

  it("elects one app leader and hands leadership over when its workspace unmounts", async () => {
    const f = await twoTabs();
    try {
      expect([f.first, f.second].map((engine) => engine.status.get().role)).toEqual([
        "leader",
        "follower",
      ]);
      const before = f.fetch.mock.calls.length;
      await f.second.pull();
      await settle();
      expect(f.fetch.mock.calls.length).toBe(before);
      attachWorkspaceEngine(f.first)();
      await f.first.retire();
      await until(() => f.second.status.get().role === "leader" && f.second.status.get().connected);
      expect(activeWorkspaceEngine(f.workspace.id)).toBeNull();
      expect(f.secondSession.activeWorkspaceEngine(f.workspace.id)?.engine).toBe(f.second);
    } finally {
      await f.secondSession.closeAllWorkspaceEngines();
    }
  });

  it("closes a leaving follower without taking leadership when the leader later closes", async () => {
    const f = await twoTabs();
    try {
      f.secondApp.attachWorkspaceEngine(f.second)();
      await f.second.retire();
      await closeAllWorkspaceEngines();
      await settle();
      expect(f.second.isClosed()).toBe(true);
      expect(f.second.status.get().role).toBe("follower");
      expect(f.first.isClosed()).toBe(true);
      expect(f.secondSession.activeWorkspaceEngine(f.workspace.id)).toBeNull();
    } finally {
      await f.secondSession.closeAllWorkspaceEngines();
    }
  });

  it.each(["unauthorized", "accessLost"] as const)(
    "handles %s in the follower app as well as the leader",
    async (ending) => {
      const f = await twoTabs();
      const events: string[] = [];
      f.second.subscribe((event) => events.push(event.type));
      try {
        if (ending === "unauthorized") f.server.logout(f.token);
        else f.server.removeMember(f.workspace.id, f.owner.id);
        await f.first.pull();
        await until(() => events.includes(ending));
        await until(() => f.first.isClosed() && f.second.isClosed());
        expect(assign).toHaveBeenCalledWith(ending === "unauthorized" ? "/login" : "/");
        expect(f.secondSession.activeWorkspaceEngine(f.workspace.id)).toBeNull();
        expect(await replicaStorage().list()).toEqual([]);
        if (ending === "unauthorized") {
          await until(() => f.secondSession.currentSession() === null);
          expect(currentSession()).toBeNull();
        }
      } finally {
        await f.secondSession.closeAllWorkspaceEngines();
      }
    },
  );

  it("logout closes both tabs and deletes the session replica", async () => {
    const f = await twoTabs();
    try {
      vi.spyOn(auth, "logout").mockImplementation(async () => {
        expect(await replicaStorage().list()).toEqual([]);
        f.server.logout(f.token);
        return null;
      });
      await logoutSession();
      await until(() => f.second.isClosed());
      expect(f.first.isClosed()).toBe(true);
      expect(await replicaStorage().list()).toEqual([]);
    } finally {
      await f.secondSession.closeAllWorkspaceEngines();
    }
  });

  it("accepting another session deletes the old replica and closes its follower", async () => {
    const f = await twoTabs();
    try {
      await acceptSession({ ...f.profile, session_id: id(99) });
      await until(() => f.second.isClosed());
      expect(f.first.isClosed()).toBe(true);
      expect(await replicaStorage().list()).toEqual([]);
    } finally {
      await f.secondSession.closeAllWorkspaceEngines();
    }
  });

  it("marks a follower offline when its browser is offline or its leader disconnects", async () => {
    const f = await twoTabs();
    const sender = f.hub.channel(`blackwall-sync:${f.profile.session_id}:${f.workspace.id}`);
    try {
      expect(f.second.status.get().online).toBe(true);
      sender.postMessage({ type: "status", connected: false, online: true, from: "leader" });
      await until(() => !f.second.status.get().online);
      window.dispatchEvent(new Event("online"));
      expect(f.second.status.get().online).toBe(false);
      sender.postMessage({ type: "status", connected: true, online: true, from: "leader" });
      await until(() => f.second.status.get().online);
      vi.stubGlobal("navigator", { onLine: false });
      window.dispatchEvent(new Event("offline"));
      sender.postMessage({ type: "status", connected: true, online: true, from: "leader" });
      await settle();
      expect(f.second.status.get().online).toBe(false);
      await expect(runCommand(f.second, { type: "import_issues", issues: [] })).rejects.toThrow(
        "online connection",
      );
    } finally {
      sender.close();
      await f.secondSession.closeAllWorkspaceEngines();
    }
  });
});
