import { isDeepStrictEqual } from "node:util";
import type { Command } from "../../lib/types";
import { SCHEMA } from "../engine";
import { MutationError } from "../mutators";
import type { Scope } from "../persistence/types";
import { seededRandom, simulationId } from "../testing/seeded";
import { convergenceCommand } from "../testing/traffic";
import { exactView, snapshot } from "./compare";
import { addMember, client, command, hold, ready, settle, waitFor, workspace } from "./environment";
import type { Client, User } from "./environment";
import { DATE } from "./scenarios";

export async function runRealConvergence(seed: number, users: [User, User, User], steps: number) {
  const random = seededRandom(seed);
  const integer = (max: number) => Math.floor(random() * max);
  const pick = <T>(items: readonly T[]): T => items[integer(items.length)];
  const trace: string[] = [];
  const coverage = new Set<string>();
  const ws = await workspace(users[0]);
  await addMember(ws, users[0], users[1], "member");
  await addMember(ws, users[0], users[2], "viewer");
  let sequence = 100;
  const id = () => simulationId(seed * 100_000 + sequence++);
  const team = id();
  const issues = [id(), id()];
  await command(ws, users[0], {
    type: "create_team",
    id: team,
    name: "Convergence",
    members: users.map((user) => user.id),
    default_stage_ids: [id(), id(), id(), id()],
  });
  for (const issue of issues)
    await command(ws, users[0], {
      type: "create_issue",
      input: { id: issue, team_id: team, title: "Initial" },
    });
  const clients = users.map((user) => client(ws, user, { randomId: id }));
  const allClients = [...clients];
  const held = clients.map(() => new Map<string, Scope>());
  let accepted = 0;
  let rejected = 0;
  const log = (action: string, detail: unknown = "") => {
    coverage.add(action);
    trace.push(`${trace.length}: ${action} ${JSON.stringify(detail)}`);
  };
  const mutate = async (c: Client, value: Command) => {
    log("mutation", { actor: users.indexOf(c.user), value });
    const { type, ...args } = value;
    try {
      const receipt = await c.engine.mutate(type, args);
      accepted += 1;
      // Stop/reload intentionally abandons receipt promises, preserving the outbox.
      void receipt.settled.catch(() => undefined);
      return receipt;
    } catch (error) {
      if (!(error instanceof MutationError)) throw error;
      rejected += 1;
      log("admission-rejected", { status: error.status, message: error.message });
    }
  };
  const scope = async (index: number, value: Scope) => {
    const key = JSON.stringify(value);
    if (held[index].has(key)) return;
    held[index].set(key, value);
    log("scope", { index, value });
    const release = clients[index].engine.useScope(value);
    if (integer(2)) release();
  };
  const reload = async (index: number) => {
    const before = clients[index];
    log("reload", { index, pending: before.engine.store.pending().length });
    await before.engine.close();
    const next = client(ws, before.user, {
      storage: before.storage,
      connection: before.connection,
      randomId: id,
    });
    clients[index] = next;
    allClients.push(next);
    await next.engine.open();
    for (const value of held[index].values()) next.engine.useScope(value);
    await next.engine.start();
  };
  try {
    await Promise.all(clients.map((c) => ready(c.engine)));
    for (let index = 0; index < clients.length; index++) {
      await scope(index, { entity: "comments", issueId: issues[0] });
      await scope(index, { entity: "activity", entityId: issues[0] });
    }
    // Force every client-side fault and lifecycle boundary even on short runs.
    const first = clients[0];
    first.connection.send("offline");
    log("offline", 0);
    await mutate(first, {
      type: "update_issue",
      id: issues[0],
      patch: { description: "persist across offline reload" },
    });
    await reload(0);
    clients[0].connection.dropNextPush = true;
    clients[0].connection.send("online");
    log("online", 0);
    await waitFor(
      () => clients[0].connection.droppedPushes === 1,
      "committed push response dropped",
    );
    log("drop-response", 0);
    await settle(clients[0].engine);
    clients[1].engine.stop();
    log("stop-start", 1);
    await mutate(clients[1], {
      type: "update_issue",
      id: issues[0],
      patch: { title: "pending while stopped" },
    });
    await ready(clients[1].engine);
    await settle(clients[1].engine);
    await mutate(clients[2], {
      type: "update_issue",
      id: issues[0],
      patch: { title: "viewer denied" },
    });
    const roleResult = await clients[0].engine.runOnline("set_role", {
      user_id: users[2].id,
      role: "member",
    });
    if (roleResult.status !== "applied")
      throw new Error(`set_role failed ${JSON.stringify(roleResult)}`);
    log("set-role", "member");
    await Promise.all(clients.map((c) => c.engine.pull()));
    await waitFor(
      () => clients[2].engine.store.get("members", users[2].id)?.role === "member",
      "member role pulled",
    );
    clients[2].connection.send("offline");
    const staleRole = await mutate(clients[2], {
      type: "create_issue",
      input: { team_id: team, title: "Rejected after role downgrade" },
    });
    if (!staleRole) throw new Error("stale-role edit was not admitted");
    const downgraded = await clients[0].engine.runOnline("set_role", {
      user_id: users[2].id,
      role: "viewer",
    });
    if (downgraded.status !== "applied") throw new Error("role downgrade failed");
    clients[2].connection.send("online");
    const verdict = await staleRole.settled;
    if (verdict === "applied" || verdict.status !== 403 || verdict.message !== "permission denied")
      throw new Error(`wrong stale-role verdict ${JSON.stringify(verdict)}`);
    log("server-rejected", verdict);
    await settle(clients[2].engine);

    for (let step = 0; step < steps; step++) {
      const index = integer(clients.length);
      const c = clients[index];
      switch (integer(12)) {
        case 0:
          c.connection.send(c.connection.online ? "offline" : "online");
          log(c.connection.online ? "online" : "offline", index);
          break;
        case 1:
          c.engine.stop();
          log("stop-start", index);
          await c.engine.start();
          break;
        case 2:
          await reload(index);
          break;
        case 3:
          c.connection.dropNextPush = true;
          log("arm-drop", index);
          break;
        case 4:
          await scope(
            index,
            integer(2)
              ? { entity: "comments", issueId: pick(issues) }
              : { entity: "activity", entityId: pick(issues) },
          );
          break;
        case 5:
          if (clients[0].connection.online) {
            const role = integer(2) ? "member" : "viewer";
            const result = clients[0].engine.runOnline("set_role", { user_id: users[2].id, role });
            void result.catch(() => undefined);
            log("set-role", role);
          }
          break;
        default:
          await mutate(
            c,
            convergenceCommand({
              store: c.engine.store,
              actor: c.user.id,
              team,
              owner: users[0].id,
              text: `seed-${seed}-step-${step} 🦊`,
              at: DATE,
              random,
            }),
          );
      }
      // Real network scheduling stays concurrent; the action sequence is seeded.
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    for (const c of clients) {
      c.connection.dropNextPush = false;
      c.connection.send("online");
      await ready(c.engine);
    }
    // Ensure queued online role changes finish before taking actor-specific snapshots.
    await Promise.all(clients.map((c) => settle(c.engine)));
    const finalRole = await clients[0].engine.runOnline("set_role", {
      user_id: users[2].id,
      role: "viewer",
    });
    if (finalRole.status !== "applied") throw new Error("final role did not apply");
    await Promise.all(clients.map((c) => settle(c.engine)));
    log("quiescence");
    for (let index = 0; index < clients.length; index++) {
      const c = clients[index];
      for (const value of held[index].values()) await hold(c, value);
      await settle(c.engine);
      const fresh = client(ws, c.user, { randomId: id });
      allClients.push(fresh);
      await ready(fresh.engine);
      for (const value of held[index].values()) await hold(fresh, value);
      await settle(fresh.engine);
      await c.engine.pull();
      const actual = exactView(snapshot(c.engine));
      const expected = exactView(snapshot(fresh.engine));
      if (!isDeepStrictEqual(actual, expected))
        throw new Error(
          `actor ${index} differs from fresh bootstrap\nactual=${JSON.stringify(actual)}\nexpected=${JSON.stringify(expected)}`,
        );
      if (c.engine.store.pending().length) throw new Error(`actor ${index} has pending mutations`);
      const replica = await c.storage.open({
        sessionId: c.user.sessionId,
        workspaceId: ws,
        schema: SCHEMA,
      });
      try {
        const disk = await replica.load();
        if (disk.outbox.length) throw new Error(`actor ${index} disk outbox is not empty`);
        for (const [entity, rows] of snapshot(c.engine)) {
          const stored = disk.records[entity] ?? [];
          if (
            stored.length !== rows.size ||
            stored.some((row) => ![...rows.values()].some((value) => isDeepStrictEqual(row, value)))
          )
            throw new Error(`actor ${index} disk ${entity} differs`);
        }
      } finally {
        replica.close();
      }
    }
    return { accepted, rejected, coverage: [...coverage], trace };
  } catch (error) {
    throw new Error(
      `real-server convergence seed=${seed}\n${trace.join("\n")}\n${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  } finally {
    await Promise.all(allClients.map((c) => c.engine.close()));
  }
}
