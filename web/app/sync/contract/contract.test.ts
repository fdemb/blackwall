import { afterAll, beforeAll, describe, expect, it, inject } from "vite-plus/test";
import type { Command } from "../../lib/types";
import { MUTATORS, MutationError } from "../mutators";
import type { MutatorName } from "../mutators";
import { createTransport } from "../transport";
import { snapshot, predictionView } from "./compare";
import {
  addMember,
  client,
  command,
  enabled,
  hold,
  login,
  ready,
  register,
  settle,
  suiteName,
  workspace,
  Connection,
} from "./environment";
import type { Client, User } from "./environment";
import { sql } from "./setup";
import { DATE, fixture, scenario } from "./scenarios";

const names = Object.keys(MUTATORS).filter((name): name is MutatorName =>
  Object.hasOwn(MUTATORS, name),
);

const predictions: { name: MutatorName; date?: string }[] = names.map((name) => ({ name }));
for (const name of ["save_view", "update_view"] satisfies MutatorName[]) {
  for (const date of [
    "2026-10-10T14:00:00.120000+02:00",
    "2026-10-10T14:00:00.123456+02:00",
    "2026-10-10T14:00:00.123456789+02:00",
    "2016-12-31T23:59:60Z",
  ])
    predictions.push({ name, date });
}

describe.skipIf(!enabled)(`${suiteName}: prediction contract`, () => {
  let owner: User;
  let member: User;
  let viewer: User;
  const clients: Client[] = [];
  beforeAll(async () => {
    owner = await register("Owner");
    member = await register("Member");
    viewer = await register("Viewer");
  }, 30_000);
  afterAll(async () => {
    await Promise.all(clients.map((c) => c.engine.close()));
  });

  it.each(predictions)(
    "predicts every visible record for $name $date",
    async ({ name, date }) => {
      const ws = await workspace(owner);
      await addMember(ws, owner, member, "member");
      const f = await fixture(ws, owner, member);
      const selected = scenario(name);
      await selected.prepare?.(f);
      const value = await selected.command(f);
      if (date && (value.type === "save_view" || value.type === "update_view"))
        value.filter = {
          ...value.filter,
          where: [...(value.filter.where ?? []), { field: "deadline", op: "lte", values: [date] }],
        };
      const { type, ...args } = value;
      const preparedArgs =
        type === "create_team" && "members" in args && "name" in args && "key" in args
          ? { name: args.name, key: args.key, members: args.members }
          : args;
      const c = client(ws, owner);
      clients.push(c);
      await ready(c.engine);
      const release = await hold(c, { entity: "comments", issueId: f.issue });
      c.engine.stop();
      const before = snapshot(c.engine);
      const receipt = await c.engine.mutate(type, preparedArgs);
      const predicted = snapshot(c.engine);
      expect(c.engine.store.pending()).toHaveLength(1);
      expect(c.engine.store.replayErrors().size).toBe(0);
      expect(predictionView(predicted, before)).not.toEqual(predictionView(before, before));
      await ready(c.engine);
      expect(await receipt.settled).toBe("applied");
      await settle(c.engine);
      expect(predictionView(snapshot(c.engine), before)).toEqual(predictionView(predicted, before));
      release();
      await c.engine.close();
    },
    30_000,
  );

  it("applies an online invite once when its idempotency key is replayed", async () => {
    const ws = await workspace(owner);
    const transport = createTransport({
      baseUrl: inject("syncContract").baseUrl,
      fetch: new Connection(owner).fetch,
    });
    const input = {
      command: {
        type: "invite",
        email: `replay-${crypto.randomUUID()}@example.test`,
        role: "member",
        token_hash: "server-generated",
      },
      idempotencyKey: crypto.randomUUID(),
    };
    const first = await transport.command(ws, input);
    const replay = await transport.command(ws, input);
    expect(first.result.id).not.toBeNull();
    expect(replay.result).toEqual(first.result);
    expect(
      await sql(
        inject("syncContract").databaseUrl,
        `SELECT count(*) FROM jobs WHERE payload->>'invitation_id'='${first.result.id}'`,
      ),
    ).toBe("1");
    await expect(
      transport.command(ws, { ...input, command: { ...input.command, role: "admin" } }),
    ).rejects.toMatchObject({
      status: 409,
      message: "idempotency key reused for a different request",
    });
  });

  it("matches admission and server rejection status/message in each command family", async () => {
    const ws = await workspace(owner);
    await addMember(ws, owner, member, "member");
    await addMember(ws, owner, viewer, "viewer");
    const f = await fixture(ws, owner, member);
    const ownerClient = client(ws, owner);
    const viewerClient = client(ws, viewer);
    clients.push(ownerClient, viewerClient);
    await ready(ownerClient.engine);
    await ready(viewerClient.engine);
    await hold(ownerClient, { entity: "comments", issueId: f.issue });
    const cases: { c: Client; value: Command }[] = [
      { c: ownerClient, value: { type: "update_issue", id: f.issue, patch: { title: "" } } },
      {
        c: ownerClient,
        value: { type: "move_issue", id: f.issue, stage_id: f.stages[0], before_id: f.issue },
      },
      { c: ownerClient, value: { type: "bulk_issues", ids: [], action: "delete" } },
      {
        c: viewerClient,
        value: {
          type: "create_team",
          name: "Denied",
          key: "DEN",
          members: [],
          default_stage_ids: f.stages,
        },
      },
      {
        c: ownerClient,
        value: {
          type: "update_stage",
          team_id: f.team,
          id: f.stages[0],
          name: "",
          kind: "active",
          position: 0,
        },
      },
      { c: ownerClient, value: { type: "update_label", id: f.label, name: "", color: "red" } },
      {
        c: ownerClient,
        value: {
          type: "update_project",
          id: f.project,
          name: "Project",
          description: "",
          team_ids: [],
        },
      },
      {
        c: ownerClient,
        value: { type: "update_milestone", id: f.milestone, name: "", deadline: null },
      },
      { c: ownerClient, value: { type: "archive_sprint", id: f.sprint } },
      { c: ownerClient, value: { type: "edit_comment", id: f.comment, body: "", mentions: [] } },
      {
        c: ownerClient,
        value: { type: "update_time", id: f.time, minutes: 0, note: "", logged_at: DATE },
      },
      {
        c: ownerClient,
        value: { type: "update_view", id: f.view, name: "", shared: true, filter: {} },
      },
      { c: ownerClient, value: { type: "mark_notification_read", id: crypto.randomUUID() } },
      { c: viewerClient, value: { type: "cancel_invitation", id: f.invitation } },
      { c: viewerClient, value: { type: "update_integration", id: f.integration, enabled: false } },
    ];
    for (const { c, value } of cases) {
      const { type, ...args } = value;
      let admission: MutationError | undefined;
      try {
        await c.engine.mutate(type, args);
      } catch (error) {
        if (!(error instanceof MutationError)) throw error;
        admission = error;
      }
      expect(admission, type).toBeDefined();
      expect(c.engine.store.pending(), type).toHaveLength(0);
      const transport = createTransport({
        baseUrl: inject("syncContract").baseUrl,
        fetch: c.connection.fetch,
      });
      const response = await transport.push(ws, crypto.randomUUID(), [
        { id: 1, name: type, args, at: new Date().toISOString() },
      ]);
      expect(response.results, type).toEqual([
        {
          id: 1,
          status: "rejected",
          error: { status: admission?.status, message: admission?.message },
        },
      ]);
    }
  }, 30_000);

  it("logs in and syncs with cookies, rejects missing CSRF, and refreshes the cookie jar token", async () => {
    const user = await login(owner);
    const ws = await workspace(user);
    const connection = new Connection(user, true);
    const c = client(ws, user, { connection });
    clients.push(c);
    await ready(c.engine);
    connection.csrf = "";
    const response = await connection.fetch(
      `${inject("syncContract").baseUrl}/internal-api/workspaces/${ws}/sync/push`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: crypto.randomUUID(),
          mutations: [{ id: 1, name: "mark_all_notifications_read", args: {}, at: DATE }],
        }),
      },
    );
    expect(response.status).toBe(403);
    const transport = createTransport({
      baseUrl: inject("syncContract").baseUrl,
      fetch: connection.fetch,
    });
    await transport.me();
    expect(connection.csrf).toBe(user.csrf);
    const receipt = await c.engine.mutate("configure_alerts", {
      assignment: false,
      reply: true,
      change: false,
      mention: true,
      deadline: false,
    });
    expect(await receipt.settled).toBe("applied");
    await settle(c.engine);
    expect(c.engine.store.get("alert_preferences", user.id)?.assignment).toBe(false);
    await command(ws, user, {
      type: "save_view",
      name: "Bearer still works",
      shared: false,
      filter: {},
    });
    await settle(c.engine);
    expect(c.engine.store.all("views")).toHaveLength(1);
  }, 30_000);
});
