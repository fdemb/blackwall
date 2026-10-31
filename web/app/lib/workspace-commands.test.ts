import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { createEngine, SCHEMA, type SyncEngine } from "../sync/engine";
import { createdLabel } from "../sync/mutators";
import { MemoryReplicaStorage } from "../sync/persistence/memory";
import { createFakeServer } from "../sync/testing/fake-server";
import { createTransport } from "../sync/transport";
import { setCsrf } from "./api";
import {
  OnlineRequiredError,
  runCommand,
  runInvitation,
  ServerRejection,
  uuidsIn,
  waitForUploadTarget,
  uploadFile,
  watchRejections,
  whenConfirmed,
} from "./workspace-commands";
import { waitUntilReady } from "./workspace-engine";

const id = (n: number) => `11111111-1111-4111-8111-${String(n).padStart(12, "0")}`;
const engines: SyncEngine[] = [];
const servers: ReturnType<typeof createFakeServer>[] = [];
async function until(check: () => boolean) {
  for (let step = 0; step < 200; step += 1) {
    if (check()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  expect(check()).toBe(true);
}
async function fixture() {
  const server = createFakeServer();
  servers.push(server);
  const owner = server.addUser();
  const peer = server.addUser();
  const workspace = server.addWorkspace();
  server.addMember(workspace.id, owner, "owner");
  server.addMember(workspace.id, peer);
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
    input: { id: id(2), title: "Original", team_id: id(1) },
  });
  const token = server.login(owner);
  setCsrf(server.csrfToken(token));
  const fetch = vi.fn(server.fetch);
  let sequence = 100;
  const engine = createEngine({
    storage: new MemoryReplicaStorage(),
    transport: createTransport({
      fetch,
      headers: () => ({ cookie: `blackwall_session=${token}` }),
      userId: owner.id,
    }),
    workspaceId: workspace.id,
    actor: owner.id,
    schema: SCHEMA,
    randomId: () => id(sequence++),
    clock: { now: server.now, monotonic: server.monotonic, schedule: server.schedule },
    signals: { getOnline: () => true, subscribe: () => () => {} },
  });
  engines.push(engine);
  await engine.start();
  await waitUntilReady(engine);
  await engine.pull();
  return { engine, server, owner, peer, workspace, fetch };
}
afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.close();
  for (const server of servers.splice(0)) server.close();
  vi.unstubAllGlobals();
});

describe("workspace commands", () => {
  it("resolves at durable admission, returns a create id, and predicts before network work", async () => {
    const { engine, fetch } = await fixture();
    engine.stop();
    const before = fetch.mock.calls.length;
    const created = await runCommand(engine, {
      type: "create_issue",
      input: { title: "Offline issue", team_id: id(1) },
    });
    expect(created).toBe(id(100));
    expect(engine.store.get("issues", id(100))?.number).toBe(2);
    expect(engine.status.get().pending).toBe(1);
    expect(fetch.mock.calls.length).toBe(before);
    expect(
      await runCommand(engine, { type: "update_issue", id: id(100), patch: { title: "Edited" } }),
    ).toBeNull();
    expect(engine.store.get("issues", id(100))?.title).toBe("Edited");
  });
  it("rejects admission errors before changing the outbox", async () => {
    const { engine } = await fixture();
    engine.stop();
    await expect(
      runCommand(engine, { type: "update_issue", id: id(999), patch: { title: "Missing" } }),
    ).rejects.toThrow();
    expect(engine.store.pending()).toHaveLength(0);
  });
  it("reports rejections that arrived before the provider mounted only once", async () => {
    const { engine, server, owner, workspace } = await fixture();
    engine.stop();
    await runCommand(engine, { type: "update_issue", id: id(2), patch: { title: "Rejected" } });
    server.setRole(workspace.id, owner.id, "viewer");
    await engine.start();
    await until(() => engine.status.get().rejected.length === 1);
    const notify = vi.fn();
    const unsubscribe = watchRejections(engine, notify);
    expect(notify).toHaveBeenCalledOnce();
    unsubscribe();
    watchRejections(engine, notify)();
    expect(notify).toHaveBeenCalledOnce();
  });
  it("routes online commands through runOnline after draining the outbox", async () => {
    const { engine, fetch, peer } = await fixture();
    engine.stop();
    await runCommand(engine, { type: "update_issue", id: id(2), patch: { title: "Queued first" } });
    const online = runCommand(engine, { type: "set_role", user_id: peer.id, role: "viewer" });
    await engine.start();
    expect(await online).toBeNull();
    await engine.pull();
    const pushed = fetch.mock.calls
      .filter(([url]) => String(url).includes("/push?"))
      .map(([, init]) => JSON.parse(String(init?.body)));
    expect(pushed[0].mutations[0].name).toBe("update_issue");
    expect(
      pushed.flatMap((batch) => batch.mutations.map((mutation: { name: string }) => mutation.name)),
    ).not.toContain("set_role");
    expect(fetch.mock.calls.some(([url]) => String(url).includes("/commands?"))).toBe(true);
    expect(engine.store.pending().some((mutation) => mutation.name === "set_role")).toBe(false);
  });
  it("returns the token an invitation issues and whether the server emailed it", async () => {
    const { engine, server } = await fixture();
    server.emailsInvitations = false;
    const invitation = await runInvitation(engine, {
      type: "invite",
      email: "new@example.com",
      role: "member",
      token_hash: "",
    });
    expect(invitation).toEqual({ token: expect.any(String), emailed: false });
    await engine.pull();
    const [pending] = engine.store.all("invitations");
    expect(pending.email).toBe("new@example.com");

    server.emailsInvitations = true;
    const renewed = await runInvitation(engine, {
      type: "resend_invitation",
      id: pending.id,
      token_hash: "",
    });
    expect(renewed?.emailed).toBe(true);
    expect(renewed?.token).not.toBe(invitation?.token);
  });
});

describe("upload target confirmation", () => {
  it("waits for the issue and comment creates to be acknowledged before allowing upload", async () => {
    const { engine } = await fixture();
    engine.stop();
    const issueId = await runCommand(engine, {
      type: "create_issue",
      input: { id: id(200), title: "New", team_id: id(1) },
    });
    const release = engine.useScope({ entity: "comments", issueId: id(200) });
    const commentId = await runCommand(engine, {
      type: "add_comment",
      id: id(201),
      issue_id: id(200),
      body: "New comment",
      mentions: [],
      attachments: [],
    });
    expect(issueId).toBe(id(200));
    expect(commentId).toBe(id(201));
    let confirmed = false;
    const target = waitForUploadTarget(engine, id(200), id(201)).then(() => {
      confirmed = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(confirmed).toBe(false);
    await engine.start();
    await target;
    expect(engine.store.pending()).toHaveLength(0);
    expect(engine.store.get("issues", id(200))?.number).not.toBeNull();
    release();
  });
  it("uploads over REST after target confirmation, omits version preconditions, and requests a pull", async () => {
    const { engine, workspace, fetch } = await fixture();
    engine.stop();
    await runCommand(engine, {
      type: "create_issue",
      input: { id: id(200), title: "New", team_id: id(1) },
    });
    let pullsAtUpload = 0;
    const rest = vi.fn(async (path: RequestInfo | URL, init?: RequestInit) => {
      pullsAtUpload = fetch.mock.calls.filter(([url]) => String(url).includes("/pull?")).length;
      expect(engine.store.pending()).toHaveLength(0);
      expect(path).toBe(`/internal-api/workspaces/${workspace.id}/issues/${id(200)}/attachments`);
      expect(init?.method).toBe("POST");
      if (!(init?.body instanceof FormData)) throw new Error("Expected upload form data");
      expect(init.body.has("expected_versions")).toBe(false);
      expect(init.body.get("file")).toBeInstanceOf(File);
      expect(init.body.get("idempotency_key")).toBeTypeOf("string");
      return Response.json({ result: { id: id(201) }, versions: {} });
    });
    vi.stubGlobal("fetch", rest);
    const upload = uploadFile(engine, workspace.id, id(200), new File(["test"], "test.txt"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(rest).not.toHaveBeenCalled();
    await engine.start();
    expect(await upload).toBe(id(201));
    expect(rest).toHaveBeenCalledOnce();
    expect(
      fetch.mock.calls.filter(([url]) => String(url).includes("/pull?")).length,
    ).toBeGreaterThan(pullsAtUpload);
  });
  it("allows an existing target while unrelated edits remain pending and rejects missing targets", async () => {
    const { engine } = await fixture();
    engine.stop();
    await runCommand(engine, {
      type: "update_issue",
      id: id(2),
      patch: { title: "Unrelated pending edit" },
    });
    await expect(waitForUploadTarget(engine, id(2))).resolves.toBeUndefined();
    expect(engine.store.pending()).toHaveLength(1);
    await expect(waitForUploadTarget(engine, id(999))).rejects.toThrow("Upload target not found");
  });
});

describe("bootstrap readiness", () => {
  it("renders an already opened disk replica without waiting for a network pull", async () => {
    const { engine } = await fixture();
    engine.stop();
    await expect(waitUntilReady(engine)).resolves.toBeUndefined();
    expect(engine.store.get("issues", id(2))?.title).toBe("Original");
  });
  it("cancels a cold-bootstrap wait when navigation is aborted", async () => {
    const { engine } = await fixture();
    engine.stop();
    const get = vi
      .spyOn(engine.status, "get")
      .mockReturnValue({ ...engine.status.get(), phase: "bootstrapping" });
    const controller = new AbortController();
    const ready = waitUntilReady(engine, controller.signal);
    controller.abort();
    await expect(ready).rejects.toThrow("navigation cancelled");
    get.mockRestore();
  });
});

describe("confirmation for REST writes", () => {
  it("resolves only after the pending creates of the given ids are acknowledged", async () => {
    const { engine } = await fixture();
    engine.stop();
    const stage = await runCommand(engine, {
      type: "create_stage",
      team_id: id(1),
      name: "Review",
      kind: "active",
      position: 4,
    });
    await runCommand(engine, {
      type: "create_issue",
      input: { id: id(300), title: "Unrelated", team_id: id(1) },
    });
    let confirmed = false;
    const wait = whenConfirmed(engine, [stage!]).then(() => {
      confirmed = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(confirmed).toBe(false);
    await engine.start();
    await wait;
    expect(engine.store.pending().some((mutation) => mutation.name === "create_stage")).toBe(false);
  });

  it("resolves at once for ids with no pending create, even while other creates wait", async () => {
    const { engine } = await fixture();
    engine.stop();
    await runCommand(engine, {
      type: "create_issue",
      input: { id: id(300), title: "Waiting", team_id: id(1) },
    });
    await expect(whenConfirmed(engine, [id(2), id(999)])).resolves.toBeUndefined();
    await expect(whenConfirmed(engine, [])).resolves.toBeUndefined();
  });

  it("waits for the default stage ids a pending create_team names", async () => {
    const { engine } = await fixture();
    engine.stop();
    await runCommand(engine, { type: "create_team", name: "Ops", key: "OPS", members: [] });
    const [team] = engine.store.pending();
    const [stage] = (team!.args as { default_stage_ids: string[] }).default_stage_ids;
    let confirmed = false;
    const wait = whenConfirmed(engine, [stage!]).then(() => {
      confirmed = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(confirmed).toBe(false);
    await engine.start();
    await wait;
    expect(engine.store.pending().some((mutation) => mutation.name === "create_team")).toBe(false);
  });

  it("rejects waiting callers when the engine closes before the creates are sent", async () => {
    const { engine } = await fixture();
    engine.stop();
    const issue = await runCommand(engine, {
      type: "create_issue",
      input: { id: id(300), title: "Never sent", team_id: id(1) },
    });
    const wait = whenConfirmed(engine, [issue!]).catch((error: unknown) => error);
    await engine.close();
    expect(await wait).toMatchObject({ message: "Workspace engine closed" });
  });

  it("collects every UUID in a request body, however deeply nested", () => {
    expect(
      uuidsIn({
        name: "not-an-id",
        token: "secret",
        projects: [{ team_id: id(1), stage_mapping: { "10": id(2) } }],
        nested: { list: [id(3), 4, null] },
      }),
    ).toEqual([id(1), id(2), id(3)]);
  });

  it("a tracker mapping waits for a stage created offline, so its REST save never sees an unknown stage", async () => {
    const { engine } = await fixture();
    engine.stop();
    const stage = await runCommand(engine, {
      type: "create_stage",
      team_id: id(1),
      name: "Migrated",
      kind: "active",
      position: 4,
    });
    const body = {
      projects: [{ project_id: "1", team_id: id(1), stage_mapping: { "10": stage } }],
      people_mapping: {},
    };
    let pendingWhenSent = -1;
    const post = vi.fn(() => {
      pendingWhenSent = engine.store.pending().length;
      return new Response(null, { status: 201 });
    });
    const save = whenConfirmed(engine, uuidsIn(body)).then(post);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(post).not.toHaveBeenCalled();
    await engine.start();
    await save;
    expect(post).toHaveBeenCalledTimes(1);
    expect(pendingWhenSent).toBe(0);
  });
});

describe("offline and rejected commands", () => {
  it("fails online-only commands and uploads at once while offline, without sending anything", async () => {
    const { server, owner, workspace } = await fixture();
    const sent = vi.fn();
    const offline = createEngine({
      storage: new MemoryReplicaStorage(),
      transport: createTransport({ fetch: sent, headers: () => ({}) }),
      workspaceId: workspace.id,
      actor: owner.id,
      schema: SCHEMA,
      randomId: () => crypto.randomUUID(),
      clock: { now: server.now, monotonic: server.monotonic, schedule: server.schedule },
      signals: { getOnline: () => false, subscribe: () => () => {} },
    });
    engines.push(offline);
    await expect(
      runCommand(offline, {
        type: "invite",
        email: "new@example.com",
        role: "member",
        token_hash: "server-generated",
      }),
    ).rejects.toBeInstanceOf(OnlineRequiredError);
    await expect(
      uploadFile(offline, workspace.id, id(2), new File(["notes"], "notes.txt")),
    ).rejects.toBeInstanceOf(OnlineRequiredError);
    expect(sent).not.toHaveBeenCalled();
  });

  it("keeps ServerRejection for denied online commands", async () => {
    const { engine, server, owner, peer, workspace } = await fixture();
    server.setRole(workspace.id, owner.id, "member");
    await expect(
      runCommand(engine, { type: "set_role", user_id: peer.id, role: "admin" }),
    ).rejects.toBeInstanceOf(ServerRejection);
    await expect(
      runCommand(engine, { type: "set_role", user_id: peer.id, role: "admin" }),
    ).rejects.toMatchObject({ status: 403, message: "permission denied" });
  });

  it("names the title of a create the server rejects, after the form has closed", async () => {
    const { engine, server, owner, workspace } = await fixture();
    engine.stop();
    await runCommand(engine, {
      type: "create_issue",
      input: { id: id(400), title: "Precious draft", team_id: id(1) },
    });
    server.setRole(workspace.id, owner.id, "viewer");
    await engine.start();
    await until(() => engine.status.get().rejected.length === 1);
    const [rejection] = engine.status.get().rejected;
    expect(rejection).toBeDefined();
    expect(createdLabel(rejection!.command)).toBe("Precious draft");
  });

  it("does not name an edit, which the toast reports by its server message alone", async () => {
    const { engine, server, owner, workspace } = await fixture();
    engine.stop();
    await runCommand(engine, { type: "update_issue", id: id(2), patch: { title: "Rejected" } });
    server.setRole(workspace.id, owner.id, "viewer");
    await engine.start();
    await until(() => engine.status.get().rejected.length === 1);
    expect(createdLabel(engine.status.get().rejected[0]!.command)).toBeNull();
  });
});
