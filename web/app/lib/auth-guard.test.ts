import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { SCHEMA } from "../sync/engine";
import type { SessionProfile } from "../sync/transport";

const profile: SessionProfile = {
  id: "11111111-1111-4111-8111-000000000001",
  email: "ada@example.com",
  display_name: "Ada",
  avatar_url: null,
  contact: "",
  language: "en",
  theme: "system",
  session_id: "11111111-1111-4111-8111-000000000002",
};
const list = [
  { id: "11111111-1111-4111-8111-000000000003", name: "Acme", slug: "acme", version: 1 },
];

// Each load is a fresh page: module state is gone, localStorage and IndexedDB stay.
async function reload(fetch: (path: string) => Promise<Response>) {
  vi.resetModules();
  vi.stubGlobal("fetch", fetch);
  return {
    guard: await import("./auth-guard"),
    replicas: await import("./session-replicas"),
  };
}
const json = (body: unknown, status = 200) => Promise.resolve(Response.json(body, { status }));
const online = (path: string) => json(path === "/internal-api/me" ? profile : list);
const offline = () => Promise.reject(new TypeError("Failed to fetch"));

describe("offline startup", () => {
  beforeEach(() => {
    const items = new Map<string, string>();
    vi.stubGlobal("indexedDB", new IDBFactory());
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => items.get(key) ?? null,
        setItem: (key: string, value: string) => items.set(key, value),
        removeItem: (key: string) => items.delete(key),
      },
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("opens the last confirmed session when the server is unreachable, keeping every replica", async () => {
    await (await reload(online)).guard.landing();
    const { guard, replicas } = await reload(offline);
    const other = await replicas
      .replicaStorage()
      .open({ sessionId: "other", workspaceId: list[0].id, schema: SCHEMA });
    other.close();
    await expect(guard.landing()).resolves.toEqual({ profile, list });
    expect(replicas.currentSession()).toEqual(profile);
    expect(await replicas.replicaStorage().list()).toContainEqual({
      sessionId: "other",
      workspaceId: list[0].id,
    });
  });

  it("falls back when the server answers with a gateway error", async () => {
    await (await reload(online)).guard.landing();
    const { guard } = await reload(() => json({ error: "down" }, 503));
    await expect(guard.landing()).resolves.toEqual({ profile, list });
  });

  it("finds a workspace by slug or by an older id link, offline from the remembered list", async () => {
    const { guard } = await reload(online);
    await expect(guard.findWorkspace("acme")).resolves.toEqual(list[0]);
    await expect(guard.findWorkspace("nope")).resolves.toBeUndefined();
    const away = await reload(offline);
    await expect(away.guard.findWorkspace(list[0].id)).resolves.toEqual(list[0]);
  });

  it("forgets the session on 401 and never falls back on 403", async () => {
    await (await reload(online)).guard.landing();
    const { guard } = await reload(() => json({ error: "forbidden" }, 403));
    await expect(guard.currentProfile()).rejects.toMatchObject({ status: 403 });
    const expired = await reload(() => json({ error: "expired" }, 401));
    await expect(expired.guard.currentProfile()).resolves.toBeNull();
    const after = await reload(offline);
    await expect(after.guard.currentProfile()).rejects.toThrow(TypeError);
  });
});

describe("returning after sign-in", () => {
  it("sends a signed-out visitor to sign in and back to the invitation link", async () => {
    const { signInFor, sameOriginPathOrHome } = await import("./auth-guard");
    const login = signInFor("https://bw.example.com/welcome?workspace=w1&token=a%2Fb");
    expect(login).toBe("/login?next=%2Fwelcome%3Fworkspace%3Dw1%26token%3Da%252Fb");
    const next = new URLSearchParams(login.split("?")[1]).get("next");
    expect(sameOriginPathOrHome(next, "https://bw.example.com")).toBe(
      "/welcome?workspace=w1&token=a%2Fb",
    );
    expect(signInFor("https://bw.example.com/")).toBe("/login");
  });
  it("goes home instead of following a next link to another site", async () => {
    const { sameOriginPathOrHome } = await import("./auth-guard");
    for (const next of [
      null,
      "",
      "https://evil.example",
      "//evil.example",
      "/\\evil.example",
      "/.//evil.example",
      "/..//evil.example",
      "/a/..//evil.example",
    ])
      expect(sameOriginPathOrHome(next, "https://bw.example.com")).toBe("/");
  });
});
