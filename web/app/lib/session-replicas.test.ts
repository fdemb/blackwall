import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { SCHEMA } from "../sync/engine";
import { createFakeServer } from "../sync/testing/fake-server";
import { currentProfile } from "./auth-guard";
import { setCsrf } from "./api";
import {
  activeWorkspaceEngine,
  acceptSession,
  clearSession,
  closeWorkspaceEngine,
  currentSession,
  replicaStorage,
  sessionHasPending,
} from "./session-replicas";
import { openWorkspaceEngine } from "./workspace-engine";
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
    expect(activeWorkspaceEngine()).toBeNull();
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

describe("workspace loader lifecycle", () => {
  it("opens a disk replica while its pull is delayed and reuses the current engine", async () => {
    const { server, owner, workspace } = await fixture();
    const initial = await openWorkspaceEngine(workspace.id);
    await initial.pull();
    await closeWorkspaceEngine();
    server.run(owner, { type: "update_issue", id: id(2), patch: { title: "On server" } });
    server.inject({ kind: "delay", route: "pull", milliseconds: 60_000 });
    const reopened = await openWorkspaceEngine(workspace.id);
    expect(reopened.store.get("issues", id(2))?.title).toBe("On disk");
    expect(reopened.status.get().phase).toBe("ready");
    expect(await openWorkspaceEngine(workspace.id)).toBe(reopened);
  });
  it("switching workspaces closes the previous engine and opens the next", async () => {
    const { server, owner, workspace } = await fixture();
    const previous = await openWorkspaceEngine(workspace.id);
    const other = server.addWorkspace();
    server.addMember(other.id, owner, "owner");
    const next = await openWorkspaceEngine(other.id);
    expect(activeWorkspaceEngine()?.engine).toBe(next);
    expect(next.store.get("workspace", other.id)?.id).toBe(other.id);
    await expect(previous.mutate("mark_all_notifications_read", {})).rejects.toThrow("closed");
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
    await closeWorkspaceEngine();
    expect(await observed).toMatchObject({ message: "Workspace engine closed" });
  });
});
