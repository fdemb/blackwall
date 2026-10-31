import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { OutdatedError, SCHEMA, type SyncEngine } from "../sync/engine";
import { IndexedDBReplicaStorage, IDB_VERSION } from "../sync/persistence/idb";
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
import { runCommand, waitForUploadTarget, watchOutdated } from "./workspace-commands";

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
type Work = "pending" | "rejected" | "none";
async function seed(userId: string, workspaceId: string, work: Work = "none") {
  const replica = await replicaStorage().open({ userId, workspaceId, schema: SCHEMA });
  if (work === "pending")
    await replica.appendMutation(() => ({
      name: "mark_all_notifications_read",
      args: {},
      at: "2026-10-09T12:00:00Z",
    }));
  if (work === "rejected")
    await replica.confirm(
      [],
      [{ id: 1, status: 400, message: "refused", command: { name: "update_issue", args: {} } }],
    );
  replica.close();
}
/** What replicas looked like before they were named by user: the meta has a session, no user. */
async function makeLegacy(identity: { userId: string; workspaceId: string }) {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(`blackwall:${identity.userId}:${identity.workspaceId}`);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction("meta", "readwrite");
    const get = tx.objectStore("meta").get("replica");
    get.onsuccess = () => {
      const { userId, ...meta } = get.result;
      tx.objectStore("meta").put({ ...meta, sessionId: userId }, "replica");
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}
/** A replica a newer version of the app wrote, so this version can't open it. */
async function seedUnreadable(userId: string, workspaceId: string) {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(`blackwall:${userId}:${workspaceId}`, IDB_VERSION + 1);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  db.close();
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
    key: "TEA",
    members: [],
    default_stage_ids: [id(10), id(11), id(12), id(13)],
  });
  server.run(owner, {
    type: "create_issue",
    input: { id: id(2), title: "On disk", team_id: id(1) },
  });
  let token = server.login(owner);
  setCsrf(server.csrfToken(token));
  const fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    headers.set("cookie", `blackwall_session=${token}`);
    return server.fetch(input, { ...init, headers });
  });
  vi.stubGlobal("fetch", fetch);
  const profile = await currentProfile();
  if (!profile) throw new Error("fixture login failed");
  /** Starts a new session for `user`, like a sign-in in this browser. */
  const signIn = (user: string) => {
    token = server.login(user);
    setCsrf(server.csrfToken(token));
    return token;
  };
  return { server, owner, workspace, token, profile, fetch, signIn };
}
const pushed = (fetch: { mock: { calls: unknown[][] } }) =>
  fetch.mock.calls.some(([url]) => String(url).includes("/sync/"));
async function replicaClientId(userId: string, workspaceId: string) {
  const replica = await replicaStorage().open({ userId, workspaceId, schema: SCHEMA });
  try {
    return (await replica.load()).meta.clientId;
  } finally {
    replica.close();
  }
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
  for (const server of servers.splice(0)) server.close();
  vi.unstubAllGlobals();
});

describe("user replica lifetime", () => {
  it("signing in keeps the user's replicas and deletes everyone else's", async () => {
    const { profile } = await fixture();
    await seed(profile.id, id(91), "pending");
    await seed(profile.id, id(92));
    await seed(id(777), id(93), "pending");
    await seed(id(778), id(94));
    await currentProfile();
    expect((await replicaStorage().list()).map((replica) => replica.workspaceId).sort()).toEqual(
      [id(91), id(92)].sort(),
    );
    expect(currentSession()?.session_id).toBe(profile.session_id);
  });
  it("another user signing in deletes the first user's replicas without opening or pushing them", async () => {
    const { server, profile, fetch, signIn } = await fixture();
    await seed(profile.id, id(91), "pending");
    const other = server.addUser();
    signIn(other.id);
    fetch.mockClear();
    const next = await currentProfile();
    expect(next?.id).toBe(other.id);
    expect(await replicaStorage().list()).toEqual([]);
    expect(pushed(fetch)).toBe(false);
  });
  it("another user's unreadable replica goes too, and the user's own stays", async () => {
    const { profile } = await fixture();
    await seedUnreadable(id(777), id(91));
    await seedUnreadable(profile.id, id(92));
    vi.spyOn(console, "error").mockImplementation(() => {});
    await currentProfile();
    expect(await replicaStorage().list()).toEqual([{ userId: profile.id, workspaceId: id(92) }]);
  });
  it("never deletes the user's unreadable replica on sign-in, in the logout check or when the session expires", async () => {
    const { profile, server, token, workspace } = await fixture();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    await seedUnreadable(profile.id, id(91));
    await currentProfile();
    const engine = await openWorkspaceEngine(workspace.id);
    expect(await sessionHasPending()).toBe(false);
    expect(logged).toHaveBeenCalled();
    server.logout(token);
    await engine.pull();
    await until(() => assign.mock.calls.length > 0);
    const kept = (await replicaStorage().list()).map((replica) => replica.workspaceId).sort();
    expect(kept).toEqual([workspace.id, id(91)].sort());
  });
  it("logs a replica it can't delete and still deletes the rest at logout", async () => {
    const { profile } = await fixture();
    await seed(profile.id, id(91));
    await seed(profile.id, id(92));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const original = replicaStorage().delete.bind(replicaStorage());
    vi.spyOn(replicaStorage(), "delete").mockImplementation((identity) =>
      identity.workspaceId === id(91) ? Promise.reject(new Error("blocked")) : original(identity),
    );
    await clearSession();
    expect(logged).toHaveBeenCalled();
    expect(await replicaStorage().list()).toEqual([{ userId: profile.id, workspaceId: id(91) }]);
  });
  it("logout asks first when only kept rejections would be lost, and counts every replica on disk", async () => {
    const { profile } = await fixture();
    expect(await sessionHasPending()).toBe(false);
    await seed(profile.id, id(91), "rejected");
    expect(await sessionHasPending()).toBe(true);
    await replicaStorage().delete({ userId: profile.id, workspaceId: id(91) });
    expect(await sessionHasPending()).toBe(false);
    await seed(profile.id, id(92), "pending");
    expect(await sessionHasPending()).toBe(true);
  });
  it("logout counts unsent edits in an open workspace", async () => {
    const { workspace } = await fixture();
    const engine = await openWorkspaceEngine(workspace.id);
    window.dispatchEvent(new Event("offline"));
    await engine.mutate("update_issue", { id: id(2), patch: { title: "Unsent" } });
    expect(await sessionHasPending()).toBe(true);
  });
  it("an older /internal-api/me reply that lands last neither changes the session nor deletes the newer user's replica", async () => {
    const { profile, server } = await fixture();
    const other = server.addUser();
    const otherProfile = { ...profile, id: other.id, session_id: id(99) };
    let resolveOlder: (value: typeof profile) => void = () => {};
    let resolveNewer: (value: typeof profile) => void = () => {};
    vi.spyOn(auth, "me")
      .mockImplementationOnce(() => new Promise((resolve) => (resolveOlder = resolve)))
      .mockImplementationOnce(() => new Promise((resolve) => (resolveNewer = resolve)));
    const older = currentProfile();
    const newer = currentProfile();
    resolveNewer(otherProfile);
    await expect(newer).resolves.toEqual(otherProfile);
    await seed(other.id, id(90), "pending");
    resolveOlder(profile);
    await expect(older).resolves.toEqual(otherProfile);
    expect(currentSession()?.id).toBe(other.id);
    expect(await replicaStorage().list()).toEqual([{ userId: other.id, workspaceId: id(90) }]);
  });
  it("detects pending edits in an unopened workspace and deletes replicas before the logout request", async () => {
    const { profile, fetch } = await fixture();
    await seed(profile.id, id(91), "pending");
    expect(await sessionHasPending()).toBe(true);
    fetch.mockImplementationOnce(async () => {
      expect(await replicaStorage().list()).toEqual([]);
      return new Response(null, { status: 204 });
    });
    await logoutSession();
    expect(fetch.mock.calls.at(-1)?.[0]).toBe("/internal-api/auth/logout");
    expect(currentSession()).toBeNull();
    expect(assign).toHaveBeenCalledWith("/login");
  });
  it("a new session of the same user closes the previous engine and keeps its replica", async () => {
    const { profile, workspace } = await fixture();
    const engine = await openWorkspaceEngine(workspace.id);
    await acceptSession({ ...profile, session_id: id(99) });
    expect(await replicaStorage().list()).toEqual([
      { userId: profile.id, workspaceId: workspace.id },
    ]);
    expect(activeWorkspaceEngine(workspace.id)).toBeNull();
    await expect(
      engine.mutate("mark_all_notifications_read", { notifications: [] }),
    ).rejects.toThrow("closed");
  });
  it("another user's session deletes the previous user's replica", async () => {
    const { profile, workspace } = await fixture();
    await openWorkspaceEngine(workspace.id);
    await acceptSession({ ...profile, id: id(555), session_id: id(99) });
    expect(await replicaStorage().list()).toEqual([]);
    expect(activeWorkspaceEngine(workspace.id)).toBeNull();
  });
  it("a 401 keeps every replica, and the user's next sign-in continues the same replica and sends its edits", async () => {
    const { server, token, workspace, profile, signIn } = await fixture();
    const engine = await openWorkspaceEngine(workspace.id);
    await seed(profile.id, id(91), "pending");
    const clientId = await replicaClientId(profile.id, workspace.id);
    window.dispatchEvent(new Event("offline"));
    await engine.mutate("update_issue", { id: id(2), patch: { title: "Typed offline" } });
    server.logout(token);
    window.dispatchEvent(new Event("online"));
    await until(() => assign.mock.calls.length > 0);
    expect(assign).toHaveBeenCalledWith("/login");
    expect(currentSession()).toBeNull();
    const kept = (await replicaStorage().list()).map((replica) => replica.workspaceId).sort();
    expect(kept).toEqual([workspace.id, id(91)].sort());
    expect(server.record("issues", id(2))?.title).toBe("On disk");

    signIn(profile.id);
    const again = await currentProfile();
    expect(again?.session_id).not.toBe(profile.session_id);
    await openWorkspaceEngine(workspace.id);
    await until(() => server.record("issues", id(2))?.title === "Typed offline");
    expect(await replicaClientId(profile.id, workspace.id)).toBe(clientId);
    expect((await replicaStorage().list()).map((replica) => replica.workspaceId).sort()).toEqual(
      kept,
    );
  });
  it("an upgraded replica asks for reload and preserves the workspace and session", async () => {
    const { profile, workspace } = await fixture();
    const engine = await openWorkspaceEngine(workspace.id);
    const notify = vi.fn();
    const unsubscribe = watchOutdated(engine, notify);
    const upgraded = await new IndexedDBReplicaStorage({ version: IDB_VERSION + 1 }).open({
      userId: profile.id,
      workspaceId: workspace.id,
      schema: SCHEMA,
    });
    try {
      expect(notify).toHaveBeenCalledOnce();
      expect(assign).not.toHaveBeenCalled();
      expect(activeWorkspaceEngine(workspace.id)?.engine).toBe(engine);
      expect(currentSession()?.session_id).toBe(profile.session_id);
      expect(engine.store.get("issues", id(2))?.title).toBe("On disk");
      await expect(
        runCommand(engine, { type: "update_issue", id: id(2), patch: { title: "Blocked" } }),
      ).rejects.toThrow("A newer version is open in another tab. Reload to continue.");
      await expect(
        runCommand(engine, { type: "import_issues", issues: [] }),
      ).rejects.toBeInstanceOf(OutdatedError);
      await expect(waitForUploadTarget(engine, id(2))).rejects.toBeInstanceOf(OutdatedError);
      const lateNotify = vi.fn();
      watchOutdated(engine, lateNotify)();
      expect(lateNotify).toHaveBeenCalledOnce();
      expect(await replicaStorage().list()).toEqual([
        { userId: profile.id, workspaceId: workspace.id },
      ]);
    } finally {
      unsubscribe();
      upgraded.close();
    }
  });
  it("deleting the replica still leaves the workspace for home", async () => {
    const { profile, workspace } = await fixture();
    const engine = await openWorkspaceEngine(workspace.id);
    const notify = vi.fn();
    const unsubscribe = watchOutdated(engine, notify);
    await replicaStorage().delete({ userId: profile.id, workspaceId: workspace.id });
    await until(() => assign.mock.calls.length > 0);
    expect(assign).toHaveBeenCalledWith("/");
    expect(notify).not.toHaveBeenCalled();
    expect(engine.isClosed()).toBe(true);
    unsubscribe();
  });
  it("access loss keeps every replica, the workspace's included, and leaves for home", async () => {
    const { server, owner, workspace, profile } = await fixture();
    const engine = await openWorkspaceEngine(workspace.id);
    await seed(profile.id, id(91));
    server.removeMember(workspace.id, owner.id);
    await engine.pull();
    await until(() => assign.mock.calls.length > 0);
    expect(assign).toHaveBeenCalledWith("/");
    expect(currentSession()?.session_id).toBe(profile.session_id);
    expect((await replicaStorage().list()).map((replica) => replica.workspaceId).sort()).toEqual(
      [workspace.id, id(91)].sort(),
    );
  });
});

describe("replicas from before they were named by user", () => {
  async function legacyWithEdit(sessionName: string, workspaceId: string) {
    const replica = await replicaStorage().open({
      userId: sessionName,
      workspaceId,
      schema: SCHEMA,
    });
    await replica.appendMutation(() => ({
      name: "update_issue",
      args: { id: id(2), patch: { title: "Typed before the upgrade" } },
      at: "2026-10-09T12:00:00Z",
    }));
    replica.close();
    await makeLegacy({ userId: sessionName, workspaceId });
  }
  async function drained(engine: SyncEngine, userId: string, workspaceId: string) {
    await until(() => engine.status.get().pending === 0);
    for (let step = 0; step < 300; step += 1) {
      const replica = await replicaStorage().open({ userId, workspaceId, schema: SCHEMA });
      const { outbox, unconfirmed, rejected } = await replica.load();
      replica.close();
      if (outbox.length + unconfirmed.length + rejected.length === 0) return;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    throw new Error("the replica never emptied its outbox");
  }

  it("keeps opening this session's replica under its old name until its edits are sent, then moves to the user's", async () => {
    const { server, workspace, profile } = await fixture();
    await legacyWithEdit(profile.session_id, workspace.id);
    await currentProfile();
    const engine = await openWorkspaceEngine(workspace.id);
    await drained(engine, profile.session_id, workspace.id);
    await until(() => server.record("issues", id(2))?.title === "Typed before the upgrade");
    expect(await replicaStorage().list()).toEqual([
      { userId: profile.session_id, workspaceId: workspace.id },
    ]);
    await closeAllWorkspaceEngines();
    const next = await openWorkspaceEngine(workspace.id);
    expect(next.store.get("issues", id(2))?.title).toBe("Typed before the upgrade");
    expect((await replicaStorage().list()).map((replica) => replica.userId).sort()).toEqual(
      [profile.id, profile.session_id].sort(),
    );
    await acceptSession({ ...profile, session_id: id(99) });
    expect(await replicaStorage().list()).toEqual([
      { userId: profile.id, workspaceId: workspace.id },
    ]);
  });
  it("deletes an old session's replica with nothing in it and keeps one that still holds edits", async () => {
    await fixture();
    await seed(id(80), id(81));
    await makeLegacy({ userId: id(80), workspaceId: id(81) });
    await legacyWithEdit(id(82), id(83));
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    await currentProfile();
    expect(await replicaStorage().list()).toEqual([{ userId: id(82), workspaceId: id(83) }]);
    expect(warned).toHaveBeenCalled();
    expect(await sessionHasPending()).toBe(true);
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
    await expect(
      previous.mutate("mark_all_notifications_read", { notifications: [] }),
    ).resolves.toBeDefined();
    detach();
    await previous.retire();
    await expect(
      previous.mutate("mark_all_notifications_read", { notifications: [] }),
    ).rejects.toThrow("closed");
  });
  it("leaving a workspace with an empty outbox closes its engine", async () => {
    const { workspace } = await fixture();
    const engine = await openWorkspaceEngine(workspace.id);
    attachWorkspaceEngine(engine)();
    await engine.retire();
    expect(activeWorkspaceEngine(workspace.id)).toBeNull();
    await expect(
      engine.mutate("mark_all_notifications_read", { notifications: [] }),
    ).rejects.toThrow("closed");
  });
  it("returning while the leaving engine closes opens a new engine", async () => {
    const { workspace } = await fixture();
    const engine = await openWorkspaceEngine(workspace.id);
    attachWorkspaceEngine(engine)();
    while (!engine.isClosed()) await Promise.resolve();
    const next = await openWorkspaceEngine(workspace.id);
    expect(next).not.toBe(engine);
    expect(activeWorkspaceEngine(workspace.id)?.engine).toBe(next);
    await expect(
      next.mutate("mark_all_notifications_read", { notifications: [] }),
    ).resolves.toBeDefined();
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
    await expect(
      engine.mutate("mark_all_notifications_read", { notifications: [] }),
    ).rejects.toThrow("retiring");
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
    await expect(
      engine.mutate("mark_all_notifications_read", { notifications: [] }),
    ).resolves.toBeDefined();
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
    await expect(
      mounted.mutate("mark_all_notifications_read", { notifications: [] }),
    ).resolves.toBeDefined();
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
    await expect(
      first.mutate("mark_all_notifications_read", { notifications: [] }),
    ).resolves.toBeDefined();
    detachFirst();
    await first.retire();
    expect(activeWorkspaceEngine(workspace.id)).toBeNull();
    await expect(
      first.mutate("mark_all_notifications_read", { notifications: [] }),
    ).rejects.toThrow("closed");
    expect(activeWorkspaceEngine(other.id)?.engine).toBe(second);
    await expect(
      second.mutate("mark_all_notifications_read", { notifications: [] }),
    ).resolves.toBeDefined();
    detachSecond();
  });
  it("a strict-mode remount in the same turn keeps the engine writable", async () => {
    const { workspace } = await fixture();
    const engine = await openWorkspaceEngine(workspace.id);
    attachWorkspaceEngine(engine)();
    const detach = attachWorkspaceEngine(engine);
    await settle();
    await expect(
      engine.mutate("mark_all_notifications_read", { notifications: [] }),
    ).resolves.toBeDefined();
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
        expect(await replicaStorage().list()).toEqual([
          { userId: f.profile.id, workspaceId: f.workspace.id },
        ]);
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

  it("accepting another session of the user closes this tab's engine and keeps the replica for the other tab", async () => {
    const f = await twoTabs();
    try {
      await acceptSession({ ...f.profile, session_id: id(99) });
      expect(f.first.isClosed()).toBe(true);
      await until(() => f.second.status.get().role === "leader");
      expect(f.second.isClosed()).toBe(false);
      expect(await replicaStorage().list()).toEqual([
        { userId: f.profile.id, workspaceId: f.workspace.id },
      ]);
    } finally {
      await f.secondSession.closeAllWorkspaceEngines();
    }
  });

  it("marks a follower offline when its browser or its leader is offline", async () => {
    const f = await twoTabs();
    const sender = f.hub.channel(`blackwall-sync:${f.profile.id}:${f.workspace.id}`);
    const status = (connected: boolean, online: boolean) =>
      sender.postMessage({
        type: "status",
        connected,
        online,
        blocked: false,
        stalled: false,
        error: null,
        from: "leader",
      });
    try {
      expect(f.second.status.get().online).toBe(true);
      status(false, true);
      await until(() => !f.second.status.get().connected);
      expect(f.second.status.get().online).toBe(true);
      status(false, false);
      await until(() => !f.second.status.get().online);
      window.dispatchEvent(new Event("online"));
      expect(f.second.status.get().online).toBe(false);
      status(true, true);
      await until(() => f.second.status.get().online);
      vi.stubGlobal("navigator", { onLine: false });
      window.dispatchEvent(new Event("offline"));
      status(true, true);
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
