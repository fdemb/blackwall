import { describe, expect, it } from "vite-plus/test";
import type { Command } from "../../lib/types";
import { MutationError, ONLINE_ONLY } from "../mutators";
import type { Change } from "../records";
import { createFakeServer } from "./fake-server";
import type { FakeServerOptions, PullResponse, PushResponse } from "./fake-server";

const id = (n: number): string => `11111111-1111-4111-8111-${n.toString(16).padStart(12, "0")}`;
const CLIENT = id(1);
const TEAM = id(2);
const STAGES = [id(3), id(4), id(5), id(6)];
const ISSUE = id(8);
const CLIENT_AT = "2020-01-01T00:00:00Z";

function fixture(options: FakeServerOptions = {}) {
  const server = createFakeServer(options);
  const owner = server.addUser({ display_name: "Owner" });
  const member = server.addUser({ display_name: "Member" });
  const workspace = server.addWorkspace();
  server.addMember(workspace.id, owner, "owner");
  server.addMember(workspace.id, member, "member");
  const token = server.login(owner);
  const memberToken = server.login(member);
  server.run(owner, {
    type: "create_team",
    id: TEAM,
    name: "Team",
    members: [owner.id, member.id],
    default_stage_ids: STAGES,
  });
  const url = (route: string, query: Record<string, string> = {}) =>
    `/internal-api/workspaces/${workspace.id}/sync/${route}?${new URLSearchParams({ client_id: CLIENT, ...query })}`;
  const get = (route: string, query: Record<string, string> = {}, auth = token) =>
    server.fetch(url(route, { client_id: auth === memberToken ? id(11) : CLIENT, ...query }), {
      headers: { authorization: `Bearer ${auth}` },
    });
  const push = (mutations: unknown[], auth = token, client = CLIENT) =>
    server.fetch(url("push"), {
      method: "POST",
      headers: { authorization: `Bearer ${auth}`, "content-type": "application/json" },
      body: JSON.stringify({ client_id: client, mutations }),
    });
  const pull = async (cursor?: string, auth = token): Promise<PullResponse> => {
    const response = await get("pull", cursor === undefined ? {} : { cursor }, auth);
    expect(response.status).toBe(200);
    return response.json();
  };
  const createIssue = (issueId = ISSUE, assignee?: string) =>
    server.run(owner, {
      type: "create_issue",
      input: { id: issueId, title: "Issue", team_id: TEAM, assignee },
    });
  return {
    server,
    owner,
    member,
    workspace,
    token,
    memberToken,
    url,
    get,
    push,
    pull,
    createIssue,
  };
}
function mutation(n: number, command: Command) {
  const { type, ...args } = command;
  return { id: n, name: type, args, at: CLIENT_AT };
}
function label(n: number, labelId = id(100 + n)) {
  return mutation(n, { type: "create_label", id: labelId, name: `Label ${n}`, color: "#ff0000" });
}
const change = (page: PullResponse, entity: string, key: string): Change | undefined =>
  page.changes.find((row) => row.entity === entity && row.id === key);
async function ndjson(response: Response): Promise<Record<string, unknown>[]> {
  return (await response.text())
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}
function reader(response: Response) {
  if (!response.body) throw new Error("missing stream");
  return response.body.getReader();
}
async function chunk(stream: ReadableStreamDefaultReader<Uint8Array>): Promise<string | undefined> {
  const next = await stream.read();
  return next.done ? undefined : new TextDecoder().decode(next.value);
}
const POKE = "event: poke\ndata: {}\n\n";

// These exercise the HTTP boundary, using the cases in tests/sync_*.rs.
describe("fake sync push", () => {
  it("deduplicates retries and accepts gaps as a high-water mark", async () => {
    const f = fixture();
    const batch = [label(2), label(8)];
    expect(await (await f.push(batch)).json()).toEqual({
      last_mutation_id: 8,
      results: [
        { id: 2, status: "applied" },
        { id: 8, status: "applied" },
      ],
    });
    expect(await (await f.push(batch)).json()).toEqual({
      last_mutation_id: 8,
      results: [
        { id: 2, status: "duplicate" },
        { id: 8, status: "duplicate" },
      ],
    });
    expect((await (await f.push([label(5)])).json()).results[0].status).toBe("duplicate");
    expect(f.server.records("labels")).toHaveLength(2);
    expect(f.server.records("labels")[0].version).toBe(1);
  });

  it.each(
    [
      [],
      [label(1), label(1)],
      [label(2), label(1)],
      [label(0)],
      [label(-1)],
      Array.from({ length: 101 }, (_, i) => label(i + 1)),
    ].map((batch) => ({ batch })),
  )("rejects an invalid batch before processing any mutation: %j", async ({ batch }) => {
    const f = fixture();
    expect((await f.push(batch)).status).toBe(400);
    expect(f.server.records("labels")).toEqual([]);
    expect(f.server.clientState(CLIENT).last_mutation_id).toBe(0);
  });

  it("validates every envelope before executing the first mutation", async () => {
    const f = fixture();
    for (const invalid of [
      { ...label(2), at: "2026-02-30T00:00:00Z" },
      { ...label(2), at: "2026-01-01T00:00:00" },
      { ...label(2), name: null },
      { ...label(2), id: 1.5 },
    ]) {
      expect((await f.push([label(1), invalid])).status).toBe(422);
      expect(f.server.records("labels")).toEqual([]);
    }
  });

  it("business rejection advances the id and rolls back partial command writes", async () => {
    const f = fixture();
    f.createIssue();
    const before = f.server.record("issues", ISSUE);
    const activities = f.server.records("activity");
    // The mutator writes the issue, then rejects the workflow cycle.
    const rejected = mutation(1, {
      type: "update_issue",
      id: ISSUE,
      patch: { title: "Partial", dependencies: [ISSUE] },
    });
    const response: PushResponse = await (await f.push([rejected, label(3)])).json();
    expect(response.results[0]).toMatchObject({
      id: 1,
      status: "rejected",
      error: { status: 400 },
    });
    expect(response.results[1]).toEqual({ id: 3, status: "applied" });
    expect(f.server.record("issues", ISSUE)).toEqual(before);
    expect(f.server.records("activity")).toHaveLength(activities.length + 1);
    expect(f.server.clientState(CLIENT).last_mutation_id).toBe(3);
    expect((await (await f.push([rejected])).json()).results[0]).toEqual(response.results[0]);
  });

  it("retains only the 1,000 most recent rejections per client", async () => {
    const f = fixture();
    const rejected = (n: number) => ({ id: n * 2, name: "unknown", args: {}, at: CLIENT_AT });
    for (let start = 1; start <= 1001; start += 100) {
      const batch = Array.from({ length: Math.min(100, 1002 - start) }, (_, n) =>
        rejected(start + n),
      );
      expect((await f.push(batch)).status).toBe(200);
    }
    const response: PushResponse = await (
      await f.push([rejected(1), rejected(2), rejected(1001)])
    ).json();
    expect(response.results[0]).toEqual({ id: 2, status: "duplicate" });
    expect(response.results.slice(1)).toMatchObject([
      { id: 4, status: "rejected", error: { status: 400 } },
      { id: 2002, status: "rejected", error: { status: 400 } },
    ]);
    const applied: PushResponse = await (await f.push([label(2003)])).json();
    expect(applied.results[0].status).toBe("applied");
    expect((await (await f.push([rejected(2)])).json()).results[0]).toEqual(response.results[1]);
    const other: PushResponse = await (await f.push([label(2)], f.token, id(12))).json();
    expect(other.results[0].status).toBe("applied");
  });

  it("rejects malformed commands per mutation, including upload commands", async () => {
    const f = fixture();
    f.createIssue();
    const malformed = [
      { id: 1, name: "frobnicator", args: {}, at: CLIENT_AT },
      {
        ...mutation(2, { type: "update_issue", id: ISSUE, patch: {} }),
        args: { id: ISSUE, patch: { priority: "bogus" } },
      },
      { id: 3, name: "update_issue", args: [], at: CLIENT_AT },
      { id: 4, name: "add_attachment", args: {}, at: CLIENT_AT },
    ];
    const body: PushResponse = await (await f.push(malformed)).json();
    expect(body.last_mutation_id).toBe(4);
    expect(body.results.map((r) => r.status)).toEqual([
      "rejected",
      "rejected",
      "rejected",
      "rejected",
    ]);
    expect(body.results[3]).toMatchObject({
      error: { status: 400, message: "use the attachment upload endpoint" },
    });
  });

  it("rejects collisions across entity tables instead of overwriting records", async () => {
    const f = fixture();
    f.createIssue();
    const before = f.server.record("issues", ISSUE);
    const response: PushResponse = await (
      await f.push([
        mutation(1, {
          type: "create_issue",
          input: { id: ISSUE, title: "Overwrite", team_id: TEAM },
        }),
        label(2, ISSUE),
      ])
    ).json();
    expect(response.results).toMatchObject([
      { status: "rejected", error: { status: 409 } },
      { status: "rejected", error: { status: 409 } },
    ]);
    expect(f.server.record("issues", ISSUE)).toEqual(before);
  });

  it("isolates client ownership across actors and workspaces", async () => {
    const f = fixture();
    await f.push([label(1)]);
    for (const route of ["pull", "bootstrap", "scope", "events"])
      expect(
        (
          await f.get(
            route,
            { entity: "comments", issue_id: ISSUE, client_id: CLIENT },
            f.memberToken,
          )
        ).status,
      ).toBe(400);
    expect((await f.push([label(2)], f.memberToken)).status).toBe(400);
    const other = f.server.addWorkspace();
    f.server.addMember(other.id, f.owner, "owner");
    expect(
      (
        await f.server.fetch(`/internal-api/workspaces/${other.id}/sync/pull?client_id=${CLIENT}`, {
          headers: { authorization: `Bearer ${f.token}` },
        })
      ).status,
    ).toBe(400);
  });

  it("membership loss is a request-level 403 without processing", async () => {
    const f = fixture();
    f.server.removeMember(f.workspace.id, f.member.id);
    expect((await f.push([label(1)], f.memberToken)).status).toBe(403);
    for (const route of ["pull", "bootstrap", "scope", "events"])
      expect((await f.get(route, {}, f.memberToken)).status).toBe(403);
    expect(f.server.records("labels")).toEqual([]);
  });

  it("preserves concurrent edits to different fields and uses server time", async () => {
    const f = fixture();
    f.createIssue();
    f.server.advance(1000);
    await f.push([mutation(1, { type: "update_issue", id: ISSUE, patch: { title: "Client" } })]);
    f.server.run(f.member, {
      type: "update_issue",
      id: ISSUE,
      patch: { description: "Concurrent" },
    });
    expect(f.server.record("issues", ISSUE)).toMatchObject({
      title: "Client",
      description: "Concurrent",
      number: 1,
      version: 3,
      followers: [f.owner.id],
      updated_at: f.server.now(),
    });
    f.createIssue(id(9));
    expect(f.server.record("issues", id(9))?.number).toBe(2);
  });

  it("applies viewer personal rules and online membership commands", async () => {
    const f = fixture();
    f.server.setRole(f.workspace.id, f.member.id, "viewer");
    const results: PushResponse = await (
      await f.push(
        [
          label(1),
          mutation(2, { type: "save_view", id: id(15), name: "Mine", shared: false, filter: {} }),
        ],
        f.memberToken,
        id(11),
      )
    ).json();
    expect(results.results).toMatchObject([
      { status: "rejected", error: { status: 403 } },
      { status: "applied" },
    ]);
    await f.push([mutation(1, { type: "set_role", user_id: f.member.id, role: "admin" })]);
    expect(f.server.record("members", f.member.id)?.role).toBe("admin");
    expect(() =>
      f.server.run(f.member, { type: "set_role", user_id: f.owner.id, role: "member" }),
    ).toThrow(MutationError);
    expect(() => f.server.run(f.owner, { type: "remove_member", user_id: f.owner.id })).toThrow(
      "retain an owner",
    );
    await f.push([mutation(2, { type: "remove_member", user_id: f.member.id })]);
    expect(f.server.record("members", f.member.id)).toBeNull();
  });

  it("stops with 403 when a mutation removes the actor mid-batch", async () => {
    const f = fixture();
    f.server.setRole(f.workspace.id, f.member.id, "owner");
    const response = await f.push([
      mutation(1, { type: "remove_member", user_id: f.owner.id }),
      label(2),
    ]);
    expect(response.status).toBe(403);
    expect(f.server.clientState(CLIENT).last_mutation_id).toBe(1);
    expect(f.server.records("labels", f.member.id)).toEqual([]);
  });

  it.each(
    ONLINE_ONLY.filter(
      (name) =>
        !["set_role", "remove_member", "add_attachment", "attach_comment_file"].includes(name),
    ),
  )("explicitly rejects unsupported online-only command %s", async (name) => {
    const f = fixture();
    const body: PushResponse = await (
      await f.push([{ id: 1, name, args: {}, at: CLIENT_AT }])
    ).json();
    expect(body.results[0]).toMatchObject({
      status: "rejected",
      error: { status: 400, message: "not supported by the fake" },
    });
  });
});

describe("fake sync pull", () => {
  it("returns a cursorless response without acknowledging and quiet polls with acknowledgement", async () => {
    const f = fixture();
    await f.push([label(4)]);
    const start = await f.pull();
    expect(start).toMatchObject({ more: false, reset: false, last_mutation_id: null, changes: [] });
    expect(start.cursor).toMatch(/^\d+:\d+:$/);
    expect(await f.pull(start.cursor)).toMatchObject({
      more: false,
      reset: false,
      last_mutation_id: 4,
      changes: [],
    });
  });

  it("pages distinct pairs at transaction boundaries and acknowledges only the final page", async () => {
    const f = fixture({ pageSize: 3 });
    const start = await f.pull();
    await f.push([label(1), label(2), label(3)]);
    const first = await f.pull(start.cursor);
    expect(first).toMatchObject({ more: true, reset: false, last_mutation_id: null });
    expect(first.changes.map((row) => row.entity)).toEqual(["activity", "labels"]);
    const second = await f.pull(first.cursor);
    expect(second.more).toBe(true);
    expect(second.last_mutation_id).toBeNull();
    const final = await f.pull(second.cursor);
    expect(final.more).toBe(false);
    expect(final.last_mutation_id).toBe(3);
    expect(
      [first, second, final].flatMap((page) =>
        page.changes.filter((row) => row.entity === "labels"),
      ),
    ).toHaveLength(3);
  });

  it("renders current state and deduplicates a pair changed repeatedly", async () => {
    const f = fixture({ pageSize: 3 });
    const cursor = (await f.pull()).cursor;
    f.server.seed("labels", [{ id: id(19), version: 1, name: "Old", color: "red" }]);
    f.server.seed("labels", [{ id: id(19), version: 2, name: "New", color: "blue" }]);
    const page = await f.pull(cursor);
    expect(page.more).toBe(false);
    expect(page.changes).toHaveLength(1);
    expect(change(page, "labels", id(19))?.record).toMatchObject({ name: "New", version: 2 });
  });

  it("resets for a transaction larger than the pair limit", async () => {
    const f = fixture({ pageSize: 2 });
    const cursor = (await f.pull()).cursor;
    f.server.run(f.owner, {
      type: "create_issue",
      input: { id: ISSUE, team_id: TEAM, title: "Done", stage_id: STAGES[3] },
    }); // issue + creation and completion activity
    expect(await f.pull(cursor)).toMatchObject({
      reset: true,
      more: false,
      last_mutation_id: null,
      changes: [],
    });
  });

  it("delivers a preceding page before resetting for a later oversized transaction", async () => {
    const f = fixture({ pageSize: 2 });
    const cursor = (await f.pull()).cursor;
    await f.push([label(1)]);
    f.server.run(f.owner, {
      type: "create_issue",
      input: { id: ISSUE, team_id: TEAM, title: "Done", stage_id: STAGES[3] },
    });
    const first = await f.pull(cursor);
    expect(first.more).toBe(true);
    expect(first.reset).toBe(false);
    expect((await f.pull(first.cursor)).reset).toBe(true);
  });

  it("resets when pruning advances the horizon beyond xmin", async () => {
    const f = fixture();
    const cursor = (await f.pull()).cursor;
    await f.push([label(1)]);
    f.server.advanceHorizon();
    expect(await f.pull(cursor)).toMatchObject({
      reset: true,
      last_mutation_id: null,
      changes: [],
    });
    expect((await f.pull((await f.pull()).cursor)).reset).toBe(false);
  });

  it("checks own role markers beyond the first page but ignores others and unchanged roles", async () => {
    const f = fixture({ pageSize: 2 });
    const cursor = (await f.pull()).cursor;
    await f.push([label(1), label(2)]);
    f.server.setRole(f.workspace.id, f.member.id, "admin");
    expect((await f.pull(cursor, f.memberToken)).reset).toBe(true);
    expect((await f.pull(cursor)).reset).toBe(false);
    const after = (await f.pull()).cursor;
    f.server.setRole(f.workspace.id, f.member.id, "admin");
    const page = await f.pull(after, f.memberToken);
    expect(page.reset).toBe(false);
    expect(page.changes.map((row) => row.entity)).toEqual(["members"]);
  });

  it.each([
    "",
    "12",
    "1:2",
    "1:2:3:4",
    "2:1:",
    "0:999999:",
    "1:2:",
    "1:4:2",
    "1:4:1,1",
    "1:4:1,0",
    "1:4:1,4",
    "-1:1:",
    "1e0:1:",
  ])("rejects invalid cursor %j", async (cursor) => {
    const f = fixture();
    expect((await f.get("pull", { cursor })).status).toBe(400);
  });

  it("accepts valid xip cursors and includes committed transactions listed there", async () => {
    const f = fixture();
    const cursor = (await f.pull()).cursor;
    const txid = Number(cursor.split(":")[1]);
    await f.push([label(1)]);
    const latest = (await f.pull()).cursor;
    const xmax = Number(latest.split(":")[1]);
    const page = await f.pull(`${txid}:${xmax}:${txid}`);
    expect(page.reset).toBe(false);
    expect(page.changes.some((row) => row.entity === "labels")).toBe(true);
    expect(
      (
        await f.get("pull", {
          cursor: `0:${xmax}:${Array.from({ length: 10001 }, (_, i) => i).join(",")}`,
        })
      ).status,
    ).toBe(400);
  });

  it("filters private rows, renders admin-only changes null and preserves unshared authoritative views", async () => {
    const f = fixture();
    const cursor = (await f.pull()).cursor;
    f.server.run(f.owner, {
      type: "save_view",
      id: id(30),
      name: "Private",
      shared: false,
      filter: {},
    });
    f.server.run(f.owner, {
      type: "save_view",
      id: id(31),
      name: "Shared",
      shared: true,
      filter: {},
    });
    f.server.seed("integrations", [
      {
        id: id(32),
        version: 1,
        name: "Hook",
        webhook_url: "https://example.test",
        enabled: true,
        secret: "server-field",
      },
    ]);
    f.server.seed("invitations", [
      {
        id: id(33),
        version: 1,
        email: "invite@example.test",
        role: "member",
        state: "pending",
        expires_at: f.server.now(),
        token_hash: "server-field",
      },
    ]);
    const member = await f.pull(cursor, f.memberToken);
    expect(change(member, "views", id(30))).toBeUndefined();
    expect(change(member, "views", id(31))?.record).toMatchObject({ shared: true });
    expect(change(member, "integrations", id(32))?.record).toBeNull();
    expect(change(member, "invitations", id(33))?.record).toBeNull();
    const after = (await f.pull()).cursor;
    f.server.setRole(f.workspace.id, f.member.id, "admin");
    const roleCursor = (await f.pull()).cursor;
    f.server.run(f.member, {
      type: "update_view",
      id: id(31),
      name: "Unshared by admin",
      shared: false,
      filter: {},
    });
    expect(change(await f.pull(roleCursor, f.memberToken), "views", id(31))?.record).toBeNull();
    expect(f.server.record("views", id(31))).toMatchObject({
      name: "Unshared by admin",
      owner: f.owner.id,
      shared: false,
    });
    expect(change(await f.pull(after), "views", id(31))?.record).toMatchObject({ shared: false });
  });

  it("renders deleted rows as null and keeps trashed issues as records", async () => {
    const f = fixture();
    f.createIssue();
    f.server.run(f.owner, {
      type: "save_view",
      id: id(40),
      name: "Delete me",
      shared: true,
      filter: {},
    });
    const cursor = (await f.pull()).cursor;
    f.server.run(f.owner, { type: "delete_view", id: id(40) });
    f.server.run(f.owner, { type: "delete_issue", id: ISSUE });
    const page = await f.pull(cursor);
    expect(change(page, "views", id(40))?.record).toBeNull();
    expect(change(page, "issues", ISSUE)?.record).toMatchObject({ deleted_at: f.server.now() });
  });

  it("assignment notifications and alert preferences reach only their owner", async () => {
    const f = fixture();
    const cursor = (await f.pull()).cursor;
    f.createIssue(ISSUE, f.member.id);
    f.server.run(f.member, {
      type: "configure_alerts",
      assignment: true,
      reply: true,
      change: true,
      mention: true,
      deadline: false,
    });
    const mine = await f.pull(cursor, f.memberToken);
    const theirs = await f.pull(cursor);
    expect(mine.changes.filter((row) => row.entity === "notifications")).toMatchObject([
      { record: { user_id: f.member.id, kind: "assignment" } },
    ]);
    expect(mine.changes.some((row) => row.entity === "alert_preferences")).toBe(true);
    expect(
      theirs.changes.some(
        (row) => row.entity === "notifications" || row.entity === "alert_preferences",
      ),
    ).toBe(false);
  });
});

describe("fake bootstrap, scope and sessions", () => {
  it("streams snapshot header, visible always-loaded records and an accurate trailer", async () => {
    const f = fixture();
    f.createIssue();
    await f.push([label(7)]);
    f.server.run(f.owner, {
      type: "add_comment",
      id: id(50),
      issue_id: ISSUE,
      body: "Scoped",
      mentions: [],
      attachments: [],
    });
    const response = await f.get("bootstrap");
    expect(response.headers.get("content-type")).toBe("application/x-ndjson");
    const lines = await ndjson(response);
    expect(lines[0]).toEqual({ cursor: (await f.pull()).cursor, last_mutation_id: 7, schema: 1 });
    expect(lines.at(-1)).toEqual({ end: true, records: lines.length - 2 });
    expect(lines.some((line) => line.entity === "comments" || line.entity === "activity")).toBe(
      false,
    );
    expect(lines.find((line) => line.entity === "issues")?.record).toEqual(
      f.server.record("issues", ISSUE),
    );
  });

  it("captures bootstrap records before a concurrent commit even if the body is unread", async () => {
    const f = fixture();
    f.createIssue();
    const response = await f.get("bootstrap");
    f.server.run(f.owner, { type: "update_issue", id: ISSUE, patch: { title: "After snapshot" } });
    const lines = await ndjson(response);
    expect(lines.find((line) => line.entity === "issues")?.record).toMatchObject({
      title: "Issue",
    });
    const page = await f.pull(String(lines[0].cursor));
    expect(change(page, "issues", ISSUE)?.record).toMatchObject({ title: "After snapshot" });
  });

  it("loads complete comment and activity scopes for only the target", async () => {
    const f = fixture();
    f.createIssue();
    f.createIssue(id(51));
    f.server.run(f.owner, {
      type: "add_comment",
      id: id(52),
      issue_id: ISSUE,
      body: "First",
      mentions: [],
      attachments: [],
    });
    f.server.run(f.member, {
      type: "add_comment",
      id: id(53),
      issue_id: id(51),
      body: "Other",
      mentions: [],
      attachments: [],
    });
    const comments = await (await f.get("scope", { entity: "comments", issue_id: ISSUE })).json();
    expect(comments.records).toEqual(
      f.server.records("comments").filter((row) => row.issue_id === ISSUE),
    );
    expect(comments.records).toHaveLength(1);
    const activity = await (await f.get("scope", { entity: "activity", entity_id: ISSUE })).json();
    expect(activity.records).toEqual(
      f.server.records("activity").filter((row) => row.entity_id === ISSUE),
    );
    expect(await (await f.get("scope", { entity: "comments", issue_id: id(999) })).json()).toEqual({
      records: [],
    });
  });

  it.each([
    {},
    { entity: "issues" },
    { entity: "comments" },
    { entity: "comments", issue_id: "bad" },
    { entity: "activity", entity_id: "bad" },
  ])("rejects malformed scope %j", async (query) => {
    const f = fixture();
    expect(
      (
        await f.get(
          "scope",
          Object.fromEntries(
            Object.entries(query).filter(
              (entry): entry is [string, string] => typeof entry[1] === "string",
            ),
          ),
        )
      ).status,
    ).toBe(400);
  });

  it("requires UUID client ids on every sync endpoint", async () => {
    const f = fixture();
    for (const route of ["pull", "bootstrap", "scope", "events"]) {
      expect((await f.get(route, { client_id: "bad" })).status).toBe(400);
      expect(
        (
          await f.server.fetch(`/internal-api/workspaces/${f.workspace.id}/sync/${route}`, {
            headers: { authorization: `Bearer ${f.token}` },
          })
        ).status,
      ).toBe(400);
    }
    expect((await f.push([label(1)], f.token, "bad")).status).toBe(422);
  });

  it("returns fresh session ids per login, never authenticates by session id, and expires sessions", async () => {
    const f = fixture({ sessionLifetimeMs: 100 });
    const me = (token: string) =>
      f.server.fetch("/internal-api/me", { headers: { authorization: `Bearer ${token}` } });
    const first = await (await me(f.token)).json();
    const secondToken = f.server.login(f.owner);
    const second = await (await me(secondToken)).json();
    expect(first.session_id).not.toBe(second.session_id);
    expect(first.id).toBe(f.owner.id);
    expect((await me(first.session_id)).status).toBe(401);
    f.server.logout(f.token);
    expect((await f.get("pull")).status).toBe(401);
    f.server.advance(100);
    expect((await me(secondToken)).status).toBe(401);
    expect((await f.server.fetch("/unknown")).status).toBe(404);
  });

  it("prunes idle clients after the session lifetime", async () => {
    const f = fixture();
    await f.push([{ ...label(1), name: "unknown" }]);
    f.server.advance(30 * 24 * 60 * 60 * 1000 + 1);
    f.server.pruneClients();
    expect(f.server.clientState(CLIENT).last_mutation_id).toBe(0);
    const token = f.server.login(f.owner);
    const response: PushResponse = await (await f.push([label(1)], token)).json();
    expect(response.results).toEqual([{ id: 1, status: "applied" }]);
    expect((await (await f.push([label(1)], token)).json()).results).toEqual([
      { id: 1, status: "duplicate" },
    ]);
  });
});

describe("fake events", () => {
  it("sends an initial poke and coalesces a burst to one trailing poke", async () => {
    const f = fixture();
    const response = await f.get("events");
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const stream = reader(response);
    expect(await chunk(stream)).toBe(POKE);
    await f.push([label(1), label(2), label(3)]);
    let delivered = false;
    const next = chunk(stream).then((value) => {
      delivered = true;
      return value;
    });
    f.server.advance(249);
    await Promise.resolve();
    expect(delivered).toBe(false);
    f.server.advance(1);
    expect(await next).toBe(POKE);
    f.server.advance(250);
    f.server.run(f.owner, { type: "create_label", id: id(60), name: "Later", color: "red" });
    expect(await chunk(stream)).toBe(POKE);
    await stream.cancel();
    f.server.close();
  });

  it("drops rolled-back commands and isolates streams by workspace", async () => {
    const f = fixture();
    const stream = reader(await f.get("events"));
    await chunk(stream);
    f.server.advance(250);
    await f.push([{ id: 1, name: "frobnicator", args: {}, at: CLIENT_AT }]);
    const other = f.server.addWorkspace();
    f.server.addMember(other.id, f.owner, "owner");
    f.server.run(
      f.owner,
      { type: "create_label", id: id(61), name: "Other", color: "red" },
      other.id,
    );
    let delivered = false;
    const next = chunk(stream).then((value) => {
      delivered = true;
      return value;
    });
    await Promise.resolve();
    expect(delivered).toBe(false);
    f.server.run(
      f.owner,
      { type: "create_label", id: id(62), name: "Here", color: "red" },
      f.workspace.id,
    );
    expect(await next).toBe(POKE);
    await stream.cancel();
    f.server.close();
  });

  it("sends keepalive comments and ends at its lifetime, including with an unread body", async () => {
    const f = fixture({ events: { coalesceMs: 10, keepaliveMs: 20, lifetimeMs: 50 } });
    const stream = reader(await f.get("events"));
    expect(await chunk(stream)).toBe(POKE);
    f.server.advance(20);
    expect(await chunk(stream)).toBe(":\n\n");
    f.server.advance(20);
    expect(await chunk(stream)).toBe(":\n\n");
    f.server.advance(10);
    expect(await chunk(stream)).toBeUndefined();
    const unread = await f.get("events");
    f.server.advance(50);
    const body = reader(unread);
    expect(await chunk(body)).toBe(POKE);
    expect(await chunk(body)).toBeUndefined();
  });

  it("drops a pending poke at the deadline and reconnects with an initial poke", async () => {
    const f = fixture({ events: { coalesceMs: 100, keepaliveMs: 200, lifetimeMs: 50 } });
    const stream = reader(await f.get("events"));
    await chunk(stream);
    await f.push([label(1)]);
    f.server.advance(50);
    expect(await chunk(stream)).toBeUndefined();
    const reconnected = reader(await f.get("events"));
    expect(await chunk(reconnected)).toBe(POKE);
    await reconnected.cancel();
  });

  it("does not accumulate pokes for a slow reader and respects cancellation", async () => {
    const f = fixture();
    const response = await f.get("events");
    for (let n = 1; n <= 5; n += 1) {
      f.server.advance(250);
      await f.push([label(n)]);
    }
    const stream = reader(response);
    expect(await chunk(stream)).toBe(POKE);
    const abort = new AbortController();
    const aborted = reader(
      await f.server.fetch(f.url("events"), {
        signal: abort.signal,
        headers: { authorization: `Bearer ${f.token}` },
      }),
    );
    await chunk(aborted);
    abort.abort();
    expect(await chunk(aborted)).toBeUndefined();
    await stream.cancel();
    f.server.advance(60_000);
    f.server.close();
  });
});

describe("deterministic faults", () => {
  it("drops a response after applying, then safely deduplicates the retry", async () => {
    const f = fixture();
    f.server.inject({ kind: "drop_response", route: "push" });
    await expect(f.push([label(1)])).rejects.toThrow("Failed to fetch");
    expect(f.server.records("labels")).toHaveLength(1);
    expect(f.server.clientState(CLIENT).last_mutation_id).toBe(1);
    expect((await (await f.push([label(1)])).json()).results[0].status).toBe("duplicate");
  });

  it("duplicates a push request without duplicating effects", async () => {
    const f = fixture();
    const activities = f.server.records("activity").length;
    f.server.inject({ kind: "duplicate_push" });
    expect((await (await f.push([label(1)])).json()).results[0].status).toBe("applied");
    expect(f.server.records("labels")).toHaveLength(1);
    expect(f.server.records("activity")).toHaveLength(activities + 1);
  });

  it("returns 503 with partial committed results and recovers by retrying the same batch", async () => {
    const f = fixture();
    f.server.inject({ kind: "unavailable", route: "push", after: 1 });
    const response = await f.push([label(1), label(2)]);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      last_mutation_id: 1,
      results: [{ id: 1, status: "applied" }],
    });
    expect(f.server.records("labels")).toHaveLength(1);
    expect((await (await f.push([label(1), label(2)])).json()).results).toEqual([
      { id: 1, status: "duplicate" },
      { id: 2, status: "applied" },
    ]);
    f.server.inject({ kind: "unavailable", route: "push" });
    const preflight = await f.push([label(3)]);
    expect(preflight.status).toBe(503);
    expect(await preflight.json()).toEqual({ last_mutation_id: 2, results: [] });
  });

  it.each(["pull", "bootstrap"] as const)(
    "fails the next %s with 503 and Retry-After only once",
    async (route) => {
      const f = fixture();
      f.server.inject({ kind: "unavailable", route });
      const response = await f.get(route);
      expect(response.status).toBe(503);
      expect(response.headers.get("retry-after")).toBe("5");
      expect(await response.json()).toEqual({ error: "service unavailable" });
      expect((await f.get(route)).status).toBe(200);
    },
  );

  it("truncates a bootstrap without a trailer and recovers on the next request", async () => {
    const f = fixture();
    f.server.inject({ kind: "truncate_bootstrap", afterRecords: 2 });
    const lines = await ndjson(await f.get("bootstrap"));
    expect(lines).toHaveLength(3);
    expect(lines.some((line) => line.end)).toBe(false);
    expect((await ndjson(await f.get("bootstrap"))).at(-1)?.end).toBe(true);
  });

  it("closes an event stream early", async () => {
    const f = fixture();
    f.server.inject({ kind: "close_events", afterMs: 10 });
    const stream = reader(await f.get("events"));
    expect(await chunk(stream)).toBe(POKE);
    f.server.advance(10);
    expect(await chunk(stream)).toBeUndefined();
  });

  it("forces one pull reset without acknowledging the outbox", async () => {
    const f = fixture();
    const cursor = (await f.pull()).cursor;
    await f.push([label(1)]);
    f.server.inject({ kind: "reset_pull" });
    expect(await f.pull(cursor)).toMatchObject({
      reset: true,
      changes: [],
      last_mutation_id: null,
    });
    expect((await f.pull(cursor)).last_mutation_id).toBe(1);
  });

  it("delays handling while other requests proceed and supports abort", async () => {
    const f = fixture();
    f.server.inject({ kind: "delay", route: "pull", milliseconds: 100 });
    const cursor = (await f.get("bootstrap")).body;
    await cursor?.cancel();
    const delayed = f.pull();
    await f.push([label(1)]);
    f.server.advance(100);
    expect((await delayed).cursor).toBe((await f.pull()).cursor);
    f.server.inject({ kind: "delay", route: "pull", milliseconds: 100 });
    const abort = new AbortController();
    const request = f.server.fetch(f.url("pull"), {
      signal: abort.signal,
      headers: { authorization: `Bearer ${f.token}` },
    });
    abort.abort();
    await expect(request).rejects.toMatchObject({ name: "AbortError" });
  });

  it("produces the same randomly selected request delays for the same seed", async () => {
    async function simulate(seed: number) {
      const random = () => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        return seed / 2 ** 32;
      };
      const f = fixture({ random });
      const times: number[] = [];
      for (let n = 0; n < 5; n += 1) {
        f.server.inject({ kind: "delay", route: "pull", milliseconds: [1, 20] });
        let done = false;
        const response = f.get("pull").then(() => {
          done = true;
        });
        let elapsed = 0;
        while (!done && elapsed < 25) {
          f.server.advance(1);
          elapsed += 1;
          await Promise.resolve();
          await Promise.resolve();
        }
        await response;
        times.push(elapsed);
      }
      return times;
    }
    expect(await simulate(42)).toEqual(await simulate(42));
    expect(await simulate(42)).not.toEqual(await simulate(43));
  });
});

describe("server-only effects and request order", () => {
  it("handles undelayed requests serially so a read sees the preceding push", async () => {
    const f = fixture();
    const cursor = (await f.pull()).cursor;
    const pushed = f.push([label(1)]);
    const pulled = f.pull(cursor);
    expect((await pushed).status).toBe(200);
    expect(await pulled).toMatchObject({
      last_mutation_id: 1,
      changes: expect.arrayContaining([expect.objectContaining({ entity: "labels" })]),
    });
  });

  it("generates omitted create ids and default stages like REST commands", async () => {
    const f = fixture();
    const response = await f.push([
      { id: 1, name: "create_team", args: { name: "Server ids", members: [] }, at: CLIENT_AT },
    ]);
    expect((await response.json()).results[0].status).toBe("applied");
    const team = f.server.records("teams").find((row) => row.name === "Server ids");
    expect(team?.id).toMatch(/^[\da-f-]{36}$/);
    expect(team?.stages).toHaveLength(4);
    const issue = f.server.run(f.owner, {
      type: "create_issue",
      input: { title: "Server id", team_id: TEAM },
    });
    expect(issue.result.id).toMatch(/^[\da-f-]{36}$/);
    expect(f.server.records("issues")[0].number).toBe(1);
  });

  it("keeps returned records detached from authoritative tables", () => {
    const f = fixture();
    f.createIssue();
    const row = f.server.record("issues", ISSUE);
    if (!row) throw new Error("missing issue");
    row.title = "Modified";
    row.followers.push(id(1000));
    expect(f.server.record("issues", ISSUE)).toMatchObject({
      title: "Issue",
      followers: [f.owner.id],
    });
  });

  it("cleans up assignments, followers and team memberships when removing a member", () => {
    const f = fixture();
    f.createIssue(ISSUE, f.member.id);
    f.server.run(f.member, { type: "follow", issue_id: ISSUE, following: true });
    const before = f.server.record("issues", ISSUE);
    f.server.advance(1000);
    f.server.run(f.owner, { type: "remove_member", user_id: f.member.id });
    expect(f.server.record("issues", ISSUE)).toMatchObject({
      assignee: null,
      followers: [f.owner.id],
      version: (before?.version ?? 0) + 1,
      updated_at: f.server.now(),
    });
    expect(f.server.record("teams", TEAM)?.members).toEqual([f.owner.id]);
  });

  it("records actual changed issue fields and completion activity", () => {
    const f = fixture();
    f.createIssue();
    f.server.run(f.owner, {
      type: "update_issue",
      id: ISSUE,
      patch: { title: "Issue", clear_assignee: true, description: "Changed", stage_id: STAGES[3] },
    });
    const activities = f.server.records("activity");
    expect(activities.find((row) => row.action === "update_issue")).toMatchObject({
      fields: ["description", "stage"],
    });
    expect(activities.filter((row) => row.action === "issue_completed")).toHaveLength(1);
    expect(f.server.record("issues", ISSUE)?.done_at).toBe(f.server.now());
  });

  it("bumps nested stage versions while parent and timestamp-only issue versions stay unchanged", () => {
    const f = fixture();
    f.createIssue();
    const team = f.server.record("teams", TEAM);
    const issue = f.server.record("issues", ISSUE);
    const stage = team?.stages[0];
    if (!team || !stage) throw new Error("missing stage");
    f.server.advance(1000);
    f.server.run(f.owner, {
      type: "update_stage",
      team_id: TEAM,
      id: stage.id,
      name: "Done",
      kind: "done",
      position: stage.position,
    });
    expect(f.server.record("teams", TEAM)?.version).toBe(team.version);
    expect(f.server.record("teams", TEAM)?.stages.find((row) => row.id === stage.id)?.version).toBe(
      stage.version + 1,
    );
    expect(f.server.record("issues", ISSUE)).toMatchObject({
      version: issue?.version,
      done_at: f.server.now(),
    });
    expect(
      f.server
        .records("activity")
        .some((row) => row.action === "issue_completed" && row.entity_id === ISSUE),
    ).toBe(true);
  });

  it("rebalances neighboring issue positions when a move exhausts the ordering gap", () => {
    const f = fixture();
    f.createIssue();
    f.createIssue(id(80));
    f.createIssue(id(81));
    const first = f.server.record("issues", ISSUE);
    const second = f.server.record("issues", id(80));
    if (!first || !second) throw new Error("missing issues");
    f.server.seed("issues", [
      { ...first, position: 0 },
      { ...second, position: 1 },
    ]);
    f.server.run(f.owner, {
      type: "move_issue",
      id: id(81),
      stage_id: first.stage_id,
      before_id: second.id,
    });
    expect(f.server.record("issues", ISSUE)?.position).toBe(0);
    expect(f.server.record("issues", id(80))?.position).toBe(1024);
    expect(f.server.record("issues", id(81))?.position).toBe(512);
    expect(f.server.record("issues", ISSUE)?.version).toBe(first.version + 1);
  });

  it("suppresses disabled alerts and sends reply and mention notifications privately", () => {
    const f = fixture();
    f.createIssue();
    f.server.run(f.member, { type: "follow", issue_id: ISSUE, following: true });
    f.server.run(f.owner, {
      type: "add_comment",
      id: id(90),
      issue_id: ISSUE,
      body: "Reply",
      mentions: [f.member.id],
      attachments: [],
    });
    expect(f.server.records("notifications", f.member.id).map((row) => row.kind)).toEqual([
      "reply",
      "mention",
    ]);
    f.server.run(f.member, {
      type: "configure_alerts",
      assignment: false,
      reply: false,
      change: false,
      mention: false,
      deadline: false,
    });
    f.server.run(f.owner, { type: "update_issue", id: ISSUE, patch: { title: "Changed" } });
    f.server.run(f.owner, {
      type: "add_comment",
      id: id(91),
      issue_id: ISSUE,
      body: "Suppressed",
      mentions: [f.member.id],
      attachments: [],
    });
    expect(f.server.records("notifications", f.member.id)).toHaveLength(2);
  });

  it("requires the Bearer scheme, accepts Request and URL inputs, and exports a bound fetch", async () => {
    const f = fixture();
    const fetch = f.server.fetch;
    expect((await fetch("/internal-api/me", { headers: { authorization: f.token } })).status).toBe(
      401,
    );
    expect(
      (
        await fetch(new URL("http://fake.test/internal-api/me"), {
          headers: { authorization: `Bearer ${f.token}` },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await fetch(
          new Request("http://fake.test/internal-api/me", {
            headers: { authorization: `Bearer ${f.token}` },
          }),
        )
      ).status,
    ).toBe(200);
  });

  it("applies faults without a route to the next request of any kind", async () => {
    const f = fixture();
    f.server.inject({ kind: "delay", milliseconds: 10 });
    let done = false;
    const response = f.get("bootstrap").then((value) => {
      done = true;
      return value;
    });
    await Promise.resolve();
    expect(done).toBe(false);
    f.server.advance(10);
    expect((await response).status).toBe(200);
    f.server.inject({ kind: "drop_response" });
    await expect(f.get("pull")).rejects.toThrow("Failed to fetch");
    expect((await f.get("pull")).status).toBe(200);
  });

  it("bounds raw rows at a transaction boundary even when every transaction touches the same pair", async () => {
    const f = fixture();
    const cursor = (await f.pull()).cursor;
    for (let n = 0; n < 20_003; n += 1)
      f.server.seed("labels", [{ id: id(95), name: `Update ${n}`, version: n + 1, color: "red" }]);
    const first = await f.pull(cursor);
    expect(first.more).toBe(true);
    expect(first.changes).toHaveLength(1);
    expect(first.last_mutation_id).toBeNull();
    expect(change(first, "labels", id(95))?.record).toMatchObject({ name: "Update 20002" });
    const final = await f.pull(first.cursor);
    expect(final.more).toBe(false);
    expect(final.changes).toHaveLength(1);
  });
});

describe("wire details", () => {
  it("does not let an unread keepalive hide a subsequent commit poke", async () => {
    const f = fixture({ events: { coalesceMs: 5, keepaliveMs: 10, lifetimeMs: 100 } });
    const stream = reader(await f.get("events"));
    await chunk(stream);
    f.server.advance(10);
    await f.push([label(1)]);
    expect(await chunk(stream)).toBe(":\n\n");
    expect(await chunk(stream)).toBe(POKE);
    await stream.cancel();
  });

  it("canonicalizes UUIDs in command records and rejects ids belonging to users", async () => {
    const f = fixture();
    const key = "abcdefab-abcd-4abc-8abc-abcdefabcdef";
    await f.push([label(1, key.toUpperCase())]);
    expect(f.server.record("labels", key)).toMatchObject({ id: key });
    expect((await (await f.push([label(2, f.member.id)])).json()).results[0]).toMatchObject({
      status: "rejected",
      error: { status: 409 },
    });
  });

  it("avoids generated id collisions with supplied fixture ids", () => {
    const server = createFakeServer();
    const user = server.addUser({ id: "00000000-0000-4000-8000-000000000001" });
    const workspace = server.addWorkspace();
    expect(workspace.id).not.toBe(user.id);
  });
});

it("rejects malformed filter enums and alert preference types per mutation", async () => {
  const f = fixture();
  const response: PushResponse = await (
    await f.push([
      {
        id: 1,
        name: "save_view",
        args: { id: id(1001), name: "Invalid", shared: false, filter: { sort: "bogus" } },
        at: CLIENT_AT,
      },
      {
        id: 2,
        name: "configure_alerts",
        args: {
          assignment: true,
          reply: true,
          change: true,
          mention: true,
          deadline: "not a boolean",
        },
        at: CLIENT_AT,
      },
    ])
  ).json();
  expect(response.results).toMatchObject([
    { status: "rejected", error: { status: 400 } },
    { status: "rejected", error: { status: 400 } },
  ]);
  expect(response.last_mutation_id).toBe(2);
  expect(f.server.records("views")).toEqual([]);
  expect(f.server.records("alert_preferences")).toEqual([]);
});

describe("fake server fidelity regressions", () => {
  it("delays push acknowledgements after committing without blocking newer snapshots", async () => {
    const pushes: { clientId: string; previous: number }[] = [];
    const results: string[] = [];
    const f = fixture({
      onPush: (input) => pushes.push(input),
      onResult: (_client, result) => results.push(result.status),
    });
    f.server.inject({ kind: "response_delay", route: "push", milliseconds: 100 });
    let delivered = false;
    const response = f.push([label(1)]).then((value) => {
      delivered = true;
      return value;
    });
    await f.pull();
    expect(f.server.records("labels")).toHaveLength(1);
    expect(delivered).toBe(false);
    expect(pushes).toMatchObject([{ clientId: CLIENT, previous: 0 }]);
    expect(results).toEqual(["applied"]);
    f.server.advance(100);
    expect((await response).status).toBe(200);
  });

  it("clears queued faults when healing traffic", async () => {
    const f = fixture();
    f.server.inject({ kind: "unavailable", route: "pull" });
    f.server.inject({ kind: "delay", route: "push", milliseconds: 100 });
    f.server.clearFaults();
    expect((await f.get("pull")).status).toBe(200);
    expect((await f.push([label(1)])).status).toBe(200);
  });

  it("combines byte cuts with delayed bootstrap delivery", async () => {
    const f = fixture();
    f.server.inject({ kind: "cut_bootstrap", byte: 13 });
    f.server.inject({ kind: "response_delay", route: "bootstrap", milliseconds: 100 });
    const response = await f.get("bootstrap");
    let delivered = false;
    const body = response.arrayBuffer().then((bytes) => {
      delivered = true;
      return bytes;
    });
    await f.pull();
    expect(delivered).toBe(false);
    f.server.advance(100);
    expect((await body).byteLength).toBe(13);
  });

  it("lets overlapping pulls return the older captured snapshot last", async () => {
    const f = fixture();
    f.createIssue();
    const cursor = (await f.pull()).cursor;
    f.server.run(f.owner, { type: "update_issue", id: ISSUE, patch: { title: "Older" } });
    const arrivals: string[] = [];
    f.server.inject({ kind: "response_delay", route: "pull", milliseconds: 100 });
    const older = f.pull(cursor).then((page) => {
      arrivals.push("older");
      return page;
    });
    await f.pull();
    f.server.run(f.owner, { type: "update_issue", id: ISSUE, patch: { title: "Newer" } });
    const newer = await f.pull(cursor);
    arrivals.push("newer");
    expect(change(newer, "issues", ISSUE)?.record).toMatchObject({ title: "Newer" });
    expect(arrivals).toEqual(["newer"]);
    f.server.advance(100);
    const old = await older;
    expect(change(old, "issues", ISSUE)?.record).toMatchObject({ title: "Older" });
    expect(old.cursor).not.toBe(newer.cursor);
    expect(arrivals).toEqual(["newer", "older"]);
  });

  it("aborts delayed responses without blocking later snapshots", async () => {
    const f = fixture();
    const controller = new AbortController();
    f.server.inject({ kind: "response_delay", route: "pull", milliseconds: 100 });
    const delayed = f.server.fetch(f.url("pull"), {
      signal: controller.signal,
      headers: { authorization: `Bearer ${f.token}` },
    });
    await f.pull();
    controller.abort();
    await expect(delayed).rejects.toMatchObject({ name: "AbortError" });
    expect((await f.get("pull")).status).toBe(200);
  });

  it("delays bootstrap bodies after capturing their snapshot", async () => {
    const f = fixture();
    f.createIssue();
    f.server.inject({ kind: "response_delay", route: "bootstrap", milliseconds: 100 });
    const older = ndjson(await f.get("bootstrap"));
    f.server.run(f.owner, { type: "update_issue", id: ISSUE, patch: { title: "Newer" } });
    const newer = await ndjson(await f.get("bootstrap"));
    expect(newer.find((line) => line.entity === "issues")?.record).toMatchObject({
      title: "Newer",
    });
    f.server.advance(100);
    expect((await older).find((line) => line.entity === "issues")?.record).toMatchObject({
      title: "Issue",
    });
  });

  it("delays scope responses after capturing their snapshot", async () => {
    const f = fixture();
    f.createIssue();
    f.server.run(f.owner, {
      type: "add_comment",
      id: id(90),
      issue_id: ISSUE,
      body: "Older",
      mentions: [],
      attachments: [],
    });
    f.server.inject({ kind: "response_delay", route: "scope", milliseconds: 100 });
    const older = f.get("scope", { entity: "comments", issue_id: ISSUE });
    await f.pull();
    f.server.run(f.owner, { type: "edit_comment", id: id(90), body: "Newer", mentions: [] });
    expect(
      await (await f.get("scope", { entity: "comments", issue_id: ISSUE })).json(),
    ).toMatchObject({ records: [{ body: "Newer" }] });
    f.server.advance(100);
    expect(await (await older).json()).toMatchObject({ records: [{ body: "Older" }] });
  });

  it("rejects missing or non-JSON content types before applying push", async () => {
    const f = fixture();
    for (const contentType of [undefined, "text/plain"]) {
      const headers = new Headers({ authorization: `Bearer ${f.token}` });
      if (contentType) headers.set("content-type", contentType);
      const response = await f.server.fetch(f.url("push"), {
        method: "POST",
        headers,
        body: JSON.stringify({ client_id: CLIENT, mutations: [label(1)] }),
      });
      expect(response.status).toBe(415);
      expect(await response.json()).toEqual({
        error: "Expected request with `Content-Type: application/json`",
      });
      expect(f.server.records("labels")).toEqual([]);
      expect(f.server.clientState(CLIENT).last_mutation_id).toBe(0);
    }
  });

  it("matches Axum syntax and extraction errors, including malformed at", async () => {
    const f = fixture();
    const cases = [
      [
        "{",
        400,
        "Failed to parse the request body as JSON: EOF while parsing an object at line 1 column 1",
      ],
      [
        `{"client_id":"${CLIENT}","mutations":[{"id":1,"name":"x","at":"bad"}]}`,
        422,
        "Failed to deserialize the JSON body into the target type: mutations[0].at: input contains invalid characters at line 1 column 94",
      ],
      [
        `{"client_id":"${CLIENT}","mutations":[{"id":1,"name":"x","at":"2026-10-08T12:00:00"}]}`,
        422,
        "Failed to deserialize the JSON body into the target type: mutations[0].at: premature end of input at line 1 column 110",
      ],
      [
        `{"client_id":"${CLIENT}","mutations":[{"id":"1","name":"x","at":"2026-10-08T12:00:00Z"}]}`,
        422,
        'Failed to deserialize the JSON body into the target type: mutations[0].id: invalid type: string "1", expected i64 at line 1 column 74',
      ],
      [
        `{"client_id":"${CLIENT}","mutations":[{"id":1,"name":"x"}]}`,
        422,
        "Failed to deserialize the JSON body into the target type: mutations[0]: missing field `at` at line 1 column 84",
      ],
      [
        `{"client_id":"${CLIENT}","mutations":[{"id":1.0,"name":"x","at":"2026-10-08T12:00:00Z"}]}`,
        422,
        "Failed to deserialize the JSON body into the target type: mutations[0].id: invalid type: floating point `1.0`, expected i64 at line 1 column 74",
      ],
      [
        `{"client_id":"${CLIENT}","mutations":[{"id":1,"id":2,"name":"x","at":"2026-10-08T12:00:00Z"}]}`,
        422,
        "Failed to deserialize the JSON body into the target type: mutations[0]: duplicate field `id` at line 1 column 77",
      ],
      [
        `{"client_id":"${CLIENT}","mutations":[{"id":1,"name":[],"at":"2026-10-08T12:00:00Z"}]}`,
        422,
        "Failed to deserialize the JSON body into the target type: mutations[0].name: invalid type: sequence, expected a string at line 1 column 80",
      ],
      [
        '{"client_id":1e}',
        400,
        "Failed to parse the request body as JSON: client_id: invalid number at line 1 column 16",
      ],
      [
        "",
        400,
        "Failed to parse the request body as JSON: EOF while parsing a value at line 1 column 0",
      ],
    ] as const;
    for (const [body, status, error] of cases) {
      const response = await f.server.fetch(f.url("push"), {
        method: "POST",
        headers: { authorization: `Bearer ${f.token}`, "content-type": "application/json" },
        body,
      });
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({ error });
      expect(f.server.clientState(CLIENT).last_mutation_id).toBe(0);
    }
  });

  it("requires comment attachments to belong to the actor's uploads", async () => {
    const f = fixture();
    f.createIssue();
    const attachment = { id: id(400), name: "proof.txt", content_type: "text/plain", size: 12 };
    f.server.uploadAttachment(f.member, ISSUE, attachment);
    const before = f.server.record("issues", ISSUE);
    const command: Command = {
      type: "add_comment",
      id: id(401),
      issue_id: ISSUE,
      body: "Comment",
      mentions: [],
      attachments: [attachment],
    };
    const rejected: PushResponse = await (await f.push([mutation(1, command)])).json();
    expect(rejected.results[0]).toEqual({
      id: 1,
      status: "rejected",
      error: { status: 400, message: "attachment must be uploaded to this issue first" },
    });
    expect(f.server.record("issues", ISSUE)).toEqual(before);
    expect(f.server.record("comments", id(401))).toBeNull();
    const accepted: PushResponse = await (
      await f.push([mutation(1, command)], f.memberToken, id(11))
    ).json();
    expect(accepted.results[0].status).toBe("applied");
  });

  it("moves attachments to comments without changing issue version or updated_at", async () => {
    const f = fixture();
    f.createIssue();
    const attachment = { id: id(400), name: "proof.txt", content_type: "text/plain", size: 12 };
    f.server.uploadAttachment(f.owner, ISSUE, attachment);
    const before = f.server.record("issues", ISSUE);
    const cursor = (await f.pull()).cursor;
    f.server.advance(1000);
    f.server.run(f.owner, {
      type: "add_comment",
      id: id(401),
      issue_id: ISSUE,
      body: "Comment",
      mentions: [],
      attachments: [attachment],
    });
    expect(f.server.record("issues", ISSUE)).toEqual({ ...before, attachments: [] });
    expect(f.server.record("comments", id(401))?.attachments).toEqual([attachment]);
    expect(change(await f.pull(cursor), "issues", ISSUE)?.record).toEqual({
      ...before,
      attachments: [],
    });
  });

  it("records stage and archived fields and completion when an open stage is deleted into Done", () => {
    const f = fixture();
    f.createIssue();
    f.server.run(f.owner, { type: "move_issue", id: ISSUE, stage_id: STAGES[1], before_id: null });
    expect(f.server.records("activity").find((row) => row.action === "move_issue")?.fields).toEqual(
      ["stage"],
    );
    f.server.run(f.owner, {
      type: "delete_stage",
      id: STAGES[1],
      team_id: TEAM,
      replacement: STAGES[3],
    });
    expect(
      f.server.records("activity").filter((row) => row.action === "issue_completed"),
    ).toHaveLength(1);
    f.server.run(f.owner, { type: "archive_issue", id: ISSUE });
    f.server.run(f.owner, { type: "unarchive_issue", id: ISSUE });
    for (const action of ["archive_issue", "unarchive_issue"])
      expect(f.server.records("activity").find((row) => row.action === action)?.fields).toEqual([
        "archived",
      ]);
  });

  it("does not mark workspace changes when allocating an issue number", async () => {
    const f = fixture();
    const cursor = (await f.pull()).cursor;
    const workspace = f.server.record("workspace", f.workspace.id);
    f.createIssue();
    expect((await f.pull(cursor)).changes.some((row) => row.entity === "workspace")).toBe(false);
    expect(f.server.record("workspace", f.workspace.id)).toEqual(workspace);
  });

  it("orders source links by their private UUIDs rather than insertion order", () => {
    const f = fixture();
    f.createIssue();
    const first = { url: "https://example.test/one", title: "one" };
    const second = { url: "https://example.test/two", title: "two" };
    f.server.seedSourceLink(id(500), ISSUE, first);
    f.server.seedSourceLink(id(499), ISSUE, second);
    expect(f.server.record("issues", ISSUE)?.source_links).toEqual([second, first]);
    f.server.run(f.owner, { type: "add_source_link", issue_id: ISSUE, ...second });
    expect(f.server.record("issues", ISSUE)?.source_links).toEqual([second, first]);
  });

  it("generated source-link ids also reorder inserts", () => {
    const f = fixture();
    f.createIssue();
    const links = Array.from({ length: 6 }, (_, n) => ({
      url: `https://example.test/${n}`,
      title: String(n),
    }));
    for (const link of links)
      f.server.run(f.owner, { type: "add_source_link", issue_id: ISSUE, ...link });
    const rendered = f.server.record("issues", ISSUE)?.source_links;
    expect(rendered).toHaveLength(6);
    expect(rendered).not.toEqual(links);
    expect(rendered).toEqual(expect.arrayContaining(links));
  });

  it.each(["comments", "views"] as const)(
    "enforces private workspace %s capacity",
    async (entity) => {
      const f = fixture();
      f.createIssue();
      if (entity === "comments") {
        f.server.seed(
          "comments",
          Array.from({ length: 20_000 }, (_, n) => ({
            id: id(1000 + n),
            version: 1,
            issue_id: ISSUE,
            author: f.owner.id,
            body: "Comment",
            mentions: [],
            attachments: [],
            created_at: f.server.now(),
            edited_at: null,
          })),
        );
      } else {
        f.server.seed(
          "views",
          Array.from({ length: 5000 }, (_, n) => ({
            id: id(1000 + n),
            version: 1,
            owner: f.member.id,
            name: "Private",
            shared: false,
            filter: {},
          })),
        );
        expect(f.server.records("views", f.owner.id)).toEqual([]);
      }
      const command: Command =
        entity === "comments"
          ? {
              type: "add_comment",
              id: id(99),
              issue_id: ISSUE,
              body: "overflow",
              mentions: [],
              attachments: [],
            }
          : { type: "save_view", id: id(99), name: "overflow", shared: false, filter: {} };
      const response: PushResponse = await (await f.push([mutation(1, command)])).json();
      expect(response.results[0]).toMatchObject({
        status: "rejected",
        error: { status: 400, message: "workspace capacity reached" },
      });
    },
  );
});

describe("cookie authentication", () => {
  it("requires matching CSRF on cookie pushes, captures token rotation on me, and exempts bearer requests", async () => {
    const f = fixture();
    const cookie = `unrelated=value; blackwall_session=${f.token}; other=value`;
    const me = await f.server.fetch("/internal-api/me", { headers: { cookie } });
    expect(me.status).toBe(200);
    expect(me.headers.get("X-CSRF-Token")).toBe(f.server.csrfToken(f.token));
    const push = (csrf?: string) =>
      f.server.fetch(f.url("push"), {
        method: "POST",
        headers: {
          cookie,
          "Content-Type": "application/json",
          ...(csrf === undefined ? {} : { "X-CSRF-Token": csrf }),
        },
        body: JSON.stringify({ client_id: CLIENT, mutations: [label(1)] }),
      });
    expect((await push()).status).toBe(403);
    expect((await push("incorrect")).status).toBe(403);
    expect(f.server.clientState(CLIENT).last_mutation_id).toBe(0);
    const old = f.server.csrfToken(f.token);
    const rotated = f.server.rotateCsrf(f.token, "test-rotation");
    expect((await push(old)).status).toBe(403);
    expect(
      (await f.server.fetch("/internal-api/me", { headers: { cookie } })).headers.get(
        "X-CSRF-Token",
      ),
    ).toBe(rotated);
    expect((await push(rotated)).status).toBe(200);
    expect((await f.push([label(2)])).status).toBe(200);
    expect(f.server.records("labels")).toHaveLength(2);
  });
});

describe("REST command idempotency", () => {
  function commands() {
    const f = fixture();
    const send = (command: object, key: unknown, token = f.token) =>
      f.server.fetch(`/internal-api/workspaces/${f.workspace.id}/commands`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ command, idempotency_key: key }),
      });
    return { ...f, send };
  }

  it("replays once, renders current records, and refuses a changed body", async () => {
    const f = commands();
    const command = { type: "set_role", user_id: f.member.id, role: "admin" };
    const first = await f.send(command, "key");
    expect(first.status).toBe(200);
    const applied = await first.json();
    f.server.setRole(f.workspace.id, f.member.id, "viewer");
    const replay = await f.send({ role: "admin", user_id: f.member.id, type: "set_role" }, "key");
    expect(replay.status).toBe(200);
    const repeated = await replay.json();
    expect(repeated.result).toEqual(applied.result);
    expect(repeated.changes.find((change: Change) => change.entity === "members").record.role).toBe(
      "viewer",
    );
    expect(f.server.record("members", f.member.id)?.role).toBe("viewer");
    const changed = await f.send({ ...command, role: "member" }, "key");
    expect(changed.status).toBe(409);
    expect(await changed.json()).toEqual({
      error: "idempotency key reused for a different request",
    });
    expect((await f.send({ type: "remove_member", user_id: f.member.id }, "remove")).status).toBe(
      200,
    );
    expect((await f.send({ type: "remove_member", user_id: f.member.id }, "remove")).status).toBe(
      200,
    );
  });

  it.each(["", "   ", "a".repeat(201), "ą".repeat(101)])("rejects invalid keys %j", async (key) => {
    const f = commands();
    const response = await f.send({ type: "set_role", user_id: f.member.id, role: "viewer" }, key);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "text must contain 1 to 200 bytes" });
  });

  it("scopes keys to the actor and records only successful commands", async () => {
    const f = commands();
    const denied = { type: "set_role", user_id: f.member.id, role: "viewer" };
    expect((await f.send(denied, "same", f.memberToken)).status).toBe(403);
    expect((await f.send(denied, "same")).status).toBe(200);
    f.server.setRole(f.workspace.id, f.member.id, "admin");
    const own = { type: "set_role", user_id: f.member.id, role: "member" };
    expect((await f.send(own, "same", f.memberToken)).status).toBe(200);
  });
});
