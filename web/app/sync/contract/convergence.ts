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
  const run = new ConvergenceRun(seed, users);
  try {
    await run.setUp();
    await run.forceFaults();
    await run.checkStaleRoleRejection();
    for (let step = 0; step < steps; step++) {
      await run.randomStep(step);
      // Real network scheduling stays concurrent; the action sequence is seeded.
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await run.quiesce();
    for (let index = 0; index < run.clients.length; index++) await run.verify(index);
    return run.result();
  } catch (error) {
    throw new Error(
      `real-server convergence seed=${seed}\n${run.trace.join("\n")}\n${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  } finally {
    await Promise.all(run.allClients.map((c) => c.engine.close()));
  }
}

/** Three clients (owner, member, viewer) driving one workspace with seeded actions. */
class ConvergenceRun {
  readonly trace: string[] = [];
  readonly clients: Client[] = [];
  /** Every client ever opened, including replaced and fresh ones, for cleanup. */
  readonly allClients: Client[] = [];
  private readonly random: () => number;
  private readonly coverage = new Set<string>();
  private readonly held: Map<string, Scope>[] = [];
  private ws = "";
  private team = "";
  private issues: string[] = [];
  private sequence = 100;
  private accepted = 0;
  private rejected = 0;

  constructor(
    private readonly seed: number,
    private readonly users: [User, User, User],
  ) {
    this.random = seededRandom(seed);
  }

  private integer(max: number): number {
    return Math.floor(this.random() * max);
  }

  private pick<T>(items: readonly T[]): T {
    return items[this.integer(items.length)];
  }

  private readonly id = () => simulationId(this.seed * 100_000 + this.sequence++);

  private log(action: string, detail: unknown = "") {
    this.coverage.add(action);
    this.trace.push(`${this.trace.length}: ${action} ${JSON.stringify(detail)}`);
  }

  async setUp() {
    const [owner, member, viewer] = this.users;
    this.ws = await workspace(owner);
    await addMember(this.ws, owner, member, "member");
    await addMember(this.ws, owner, viewer, "viewer");
    this.team = this.id();
    this.issues = [this.id(), this.id()];
    await command(this.ws, owner, {
      type: "create_team",
      id: this.team,
      name: "Convergence",
      members: this.users.map((user) => user.id),
      default_stage_ids: [this.id(), this.id(), this.id(), this.id()],
    });
    for (const issue of this.issues)
      await command(this.ws, owner, {
        type: "create_issue",
        input: { id: issue, team_id: this.team, title: "Initial" },
      });
    for (const user of this.users) {
      const c = client(this.ws, user, { randomId: this.id });
      this.clients.push(c);
      this.allClients.push(c);
      this.held.push(new Map());
    }
    await Promise.all(this.clients.map((c) => ready(c.engine)));
    for (let index = 0; index < this.clients.length; index++) {
      await this.scope(index, { entity: "comments", issueId: this.issues[0] });
      await this.scope(index, { entity: "activity", entityId: this.issues[0] });
    }
  }

  private async mutate(c: Client, value: Command) {
    this.log("mutation", { actor: this.users.indexOf(c.user), value });
    const { type, ...args } = value;
    try {
      const receipt = await c.engine.mutate(type, args);
      this.accepted += 1;
      // Stop/reload intentionally abandons receipt promises, preserving the outbox.
      void receipt.settled.catch(() => undefined);
      return receipt;
    } catch (error) {
      if (!(error instanceof MutationError)) throw error;
      this.rejected += 1;
      this.log("admission-rejected", { status: error.status, message: error.message });
    }
  }

  private async scope(index: number, value: Scope) {
    const key = JSON.stringify(value);
    if (this.held[index].has(key)) return;
    this.held[index].set(key, value);
    this.log("scope", { index, value });
    const release = this.clients[index].engine.useScope(value);
    if (this.integer(2)) release();
  }

  private async reload(index: number) {
    const before = this.clients[index];
    this.log("reload", { index, pending: before.engine.store.pending().length });
    await before.engine.close();
    const next = client(this.ws, before.user, {
      storage: before.storage,
      connection: before.connection,
      randomId: this.id,
    });
    this.clients[index] = next;
    this.allClients.push(next);
    await next.engine.open();
    for (const value of this.held[index].values()) next.engine.useScope(value);
    await next.engine.start();
  }

  private async setViewerRole(role: "member" | "viewer") {
    const result = await this.clients[0].engine.runOnline("set_role", {
      user_id: this.users[2].id,
      role,
    });
    if (result.status !== "applied")
      throw new Error(`set_role ${role} failed ${JSON.stringify(result)}`);
  }

  /** Forces every client-side fault and lifecycle boundary even on short runs. */
  async forceFaults() {
    const [first, second, third] = this.clients;
    first.connection.send("offline");
    this.log("offline", 0);
    await this.mutate(first, {
      type: "update_issue",
      id: this.issues[0],
      patch: { description: "persist across offline reload" },
    });
    await this.reload(0);
    const reloaded = this.clients[0];
    reloaded.connection.dropNextPush = true;
    reloaded.connection.send("online");
    this.log("online", 0);
    await waitFor(() => reloaded.connection.droppedPushes === 1, "committed push response dropped");
    this.log("drop-response", 0);
    await settle(reloaded.engine);
    second.engine.stop();
    this.log("stop-start", 1);
    await this.mutate(second, {
      type: "update_issue",
      id: this.issues[0],
      patch: { title: "pending while stopped" },
    });
    await ready(second.engine);
    await settle(second.engine);
    await this.mutate(third, {
      type: "update_issue",
      id: this.issues[0],
      patch: { title: "viewer denied" },
    });
  }

  /** An edit admitted under a member role must be rejected after a downgrade lands first. */
  async checkStaleRoleRejection() {
    const viewer = this.clients[2];
    await this.setViewerRole("member");
    this.log("set-role", "member");
    await Promise.all(this.clients.map((c) => c.engine.pull()));
    await waitFor(
      () => viewer.engine.store.get("members", this.users[2].id)?.role === "member",
      "member role pulled",
    );
    viewer.connection.send("offline");
    const staleRole = await this.mutate(viewer, {
      type: "create_issue",
      input: { team_id: this.team, title: "Rejected after role downgrade" },
    });
    if (!staleRole) throw new Error("stale-role edit was not admitted");
    await this.setViewerRole("viewer");
    viewer.connection.send("online");
    const verdict = await staleRole.settled;
    if (verdict === "applied" || verdict.status !== 403 || verdict.message !== "permission denied")
      throw new Error(`wrong stale-role verdict ${JSON.stringify(verdict)}`);
    this.log("server-rejected", verdict);
    await settle(viewer.engine);
  }

  async randomStep(step: number) {
    const index = this.integer(this.clients.length);
    const c = this.clients[index];
    switch (this.integer(12)) {
      case 0:
        c.connection.send(c.connection.online ? "offline" : "online");
        this.log(c.connection.online ? "online" : "offline", index);
        return;
      case 1:
        c.engine.stop();
        this.log("stop-start", index);
        await c.engine.start();
        return;
      case 2:
        await this.reload(index);
        return;
      case 3:
        c.connection.dropNextPush = true;
        this.log("arm-drop", index);
        return;
      case 4:
        await this.scope(
          index,
          this.integer(2)
            ? { entity: "comments", issueId: this.pick(this.issues) }
            : { entity: "activity", entityId: this.pick(this.issues) },
        );
        return;
      case 5:
        this.toggleViewerRole();
        return;
      default:
        await this.mutate(
          c,
          convergenceCommand({
            store: c.engine.store,
            actor: c.user.id,
            team: this.team,
            owner: this.users[0].id,
            text: `seed-${this.seed}-step-${step} 🦊`,
            at: DATE,
            random: this.random,
          }),
        );
    }
  }

  /** Fires a role change without waiting, so it races the other clients. */
  private toggleViewerRole() {
    if (!this.clients[0].connection.online) return;
    const role = this.integer(2) ? "member" : "viewer";
    const result = this.clients[0].engine.runOnline("set_role", {
      user_id: this.users[2].id,
      role,
    });
    void result.catch(() => undefined);
    this.log("set-role", role);
  }

  async quiesce() {
    for (const c of this.clients) {
      c.connection.dropNextPush = false;
      c.connection.send("online");
      await ready(c.engine);
    }
    // Ensure queued online role changes finish before taking actor-specific snapshots.
    await Promise.all(this.clients.map((c) => settle(c.engine)));
    await this.setViewerRole("viewer");
    await Promise.all(this.clients.map((c) => settle(c.engine)));
    this.log("quiescence");
  }

  /** The client's view must match a fresh bootstrap, with nothing pending in memory or on disk. */
  async verify(index: number) {
    const c = this.clients[index];
    for (const value of this.held[index].values()) await hold(c, value);
    await settle(c.engine);
    const fresh = client(this.ws, c.user, { randomId: this.id });
    this.allClients.push(fresh);
    await ready(fresh.engine);
    for (const value of this.held[index].values()) await hold(fresh, value);
    await settle(fresh.engine);
    await c.engine.pull();
    const actual = exactView(snapshot(c.engine));
    const expected = exactView(snapshot(fresh.engine));
    if (!isDeepStrictEqual(actual, expected))
      throw new Error(
        `actor ${index} differs from fresh bootstrap\nactual=${JSON.stringify(actual)}\nexpected=${JSON.stringify(expected)}`,
      );
    if (c.engine.store.pending().length) throw new Error(`actor ${index} has pending mutations`);
    await this.verifyDisk(index, c);
  }

  private async verifyDisk(index: number, c: Client) {
    const replica = await c.storage.open({
      sessionId: c.user.sessionId,
      workspaceId: this.ws,
      schema: SCHEMA,
    });
    try {
      const disk = await replica.load();
      if (disk.outbox.length) throw new Error(`actor ${index} disk outbox is not empty`);
      for (const [entity, rows] of snapshot(c.engine)) {
        const stored = disk.records[entity] ?? [];
        const memory = [...rows.values()];
        if (
          stored.length !== rows.size ||
          stored.some((row) => !memory.some((value) => isDeepStrictEqual(row, value)))
        )
          throw new Error(`actor ${index} disk ${entity} differs`);
      }
    } finally {
      replica.close();
    }
  }

  result() {
    return {
      accepted: this.accepted,
      rejected: this.rejected,
      coverage: [...this.coverage],
      trace: this.trace,
    };
  }
}
