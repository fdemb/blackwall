import "fake-indexeddb/auto";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { IDBFactory } from "fake-indexeddb";
import type { Command, Role } from "../../lib/types";
import { createEngine, SCHEMA } from "../engine";
import type { EngineSignal, MutationReceipt, SyncEngine } from "../engine";
import { withCounts } from "../derived";
import { MutationError } from "../mutators";
import { IndexedDBReplicaStorage } from "../persistence/idb";
import { MemoryReplicaStorage } from "../persistence/memory";
import type { LoadedReplica, ReplicaStorage, Scope } from "../persistence/types";
import { recordKey, scopeKey } from "../persistence/shared";
import { BOOTSTRAP_ENTITIES, ENTITIES, normalize } from "../records";
import type { Entity } from "../records";
import { createTransport, ProtocolError } from "../transport";
import { createFakeServer } from "./fake-server";
import type { Fault, MutationResult, Route } from "./fake-server";
import { object } from "./commands";
import { createTabHub } from "./tabs";

import { seededRandom, simulationId } from "./seeded";
import { convergenceCommand } from "./traffic";
export { seededRandom, simulationId };

class Signals {
  online = true;
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

type WireFault =
  | { kind: "malformed"; route: "bootstrap" | "pull" | "scope" | "push" }
  | { kind: "failed_auth_body"; route: Route; status: 401 | 403 };

type Outcome =
  | { kind: "pending" }
  | { kind: "applied" }
  | { kind: "rejected"; status: number; message: string }
  | { kind: "cancelled"; reason: string };

interface Accepted {
  client: Client;
  generation: number;
  receipt: MutationReceipt;
  command: Command;
  outcome: Outcome;
}

interface Client {
  index: number;
  actor: string;
  sessionId: string;
  token: string;
  csrf: string;
  signals: Signals;
  storage: ReplicaStorage;
  engine: SyncEngine;
  generation: number;
  running: boolean;
  wiped: boolean;
  held: Map<string, { scope: Scope; release: () => void }>;
  wireFaults: WireFault[];
  pendingReads: number;
  pendingPushes: number;
  pendingWrites: number;
  gate: (() => void) | null;
  holdWrite: boolean;
  admissions: number;
  onlineCalls: number;
  clientId: string;
  blocked: boolean;
  retryPayload: string | null;
  /** A tab closed by the harness; it reopens during healing. */
  tabClosed: boolean;
}

export interface ConvergenceResult {
  seed: number;
  traceHash: string;
  trace: readonly string[];
  coverage: readonly string[];
  accepted: number;
}

function check(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function equal(actual: unknown, expected: unknown, message: string): void {
  if (!isDeepStrictEqual(actual, expected)) {
    throw new Error(
      `${message}\nactual: ${JSON.stringify(actual)}\nexpected: ${JSON.stringify(expected)}`,
    );
  }
}

function sorted(entity: Entity, records: readonly object[]): readonly object[] {
  return [...records].sort((a, b) => recordKey(entity, a).localeCompare(recordKey(entity, b)));
}

async function flush(turns = 24): Promise<void> {
  for (let i = 0; i < turns; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

/**
 * Runs real engines, transports and storage. Only time, HTTP faults and host IO are controlled.
 * With `tabs`, every client is a tab of one browser: one session, one database, one lock and
 * one channel. The leader tab may close at random.
 */
export async function runConvergence(
  seed: number,
  steps = 90,
  options: { tabs?: boolean } = {},
): Promise<ConvergenceResult> {
  const tabs = options.tabs === true;
  const hub = tabs ? createTabHub() : null;
  const database = new IDBFactory();
  const random = seededRandom(seed);
  const faultRandom = seededRandom(seed ^ 0xf00d);
  const pick = <T>(items: readonly T[]): T => {
    check(items.length > 0, "cannot pick from an empty set");
    return items[Math.floor(random() * items.length)];
  };
  const integer = (max: number) => Math.floor(random() * max);
  const trace: string[] = [];
  const coverage = new Set<string>();
  const accepted: Accepted[] = [];
  const results = new Map<string, MutationResult>();
  const payloads = new Map<string, string>();
  const newestObserved = new Map<string, number>();
  const serverPushes: object[] = [];
  const allEngines: SyncEngine[] = [];
  const clients: Client[] = [];
  let step = -1;
  let sequence = 100;
  let failure: unknown;
  const log = (action: string) => {
    coverage.add(action.split(" ")[0]);
    trace.push(`${step}: ${action}`);
  };
  const server = createFakeServer({
    random: faultRandom,
    pageSize: 24,
    events: { coalesceMs: 1, keepaliveMs: 100_000, lifetimeMs: 1_000_000 },
    onFault(_route, fault) {
      coverage.add(fault.kind);
    },
    onPush({ clientId, mutations, previous }) {
      try {
        // Tabs share one client id, so the pushing tab is the leader.
        const client =
          clients.find(
            (entry) => entry.clientId === clientId && entry.engine.status.get().role === "leader",
          ) ?? clients.find((entry) => entry.clientId === clientId);
        check(client !== undefined, "unrecognized server push client");
        let last = previous;
        for (const mutation of mutations) {
          const key = `${clientId}:${mutation.id}`;
          const payload = JSON.stringify(mutation);
          const before = payloads.get(key);
          if (before === undefined) {
            check(
              mutation.id > (newestObserved.get(clientId) ?? 0),
              "new mutation arrived out of order",
            );
            newestObserved.set(clientId, mutation.id);
          }
          if (before !== undefined) equal(payload, before, `changed retry payload ${key}`);
          payloads.set(key, payload);
          if (mutation.id > last) {
            // An aborted, allocated online command may leave an id gap.
            check(
              !client.engine.store
                .pending()
                .some(
                  (pending) =>
                    pending.id < mutation.id &&
                    pending.id > previous &&
                    !mutations.some((item) => item.id === pending.id),
                ),
              `push ${mutation.id} overtook older pending work`,
            );
            last = mutation.id;
          }
          if (mutation.name === "set_role" || mutation.name === "remove_member") {
            check(
              !client.engine.store.pending().some((pending) => pending.id < mutation.id),
              "online command overtook a concurrently admitted mutation",
            );
          }
        }
        serverPushes.push({ client: client.index, mutations, previous });
      } catch (error) {
        failure ??= error;
        throw error;
      }
    },
    onResult(clientId, result) {
      const key = `${clientId}:${result.id}`;
      if (result.status !== "duplicate") results.set(key, result);
    },
  });
  const owner = server.addUser({ display_name: "Owner 🦊" });
  const admin = server.addUser({ display_name: "Admin" });
  const member = server.addUser({ display_name: "Member" });
  const viewer = server.addUser({ display_name: "Viewer" });
  const workspace = server.addWorkspace({ name: "Convergence 🦊" });
  for (const [user, role] of [
    [owner, "owner"],
    [admin, "admin"],
    [member, "member"],
    [viewer, "viewer"],
  ] satisfies [typeof owner, Role][])
    server.addMember(workspace.id, user, role);
  const team = simulationId(1);
  const issue = simulationId(2);
  server.run(owner, {
    type: "create_team",
    id: team,
    name: "Team",
    members: [owner.id, admin.id, member.id],
    default_stage_ids: [3, 4, 5, 6].map(simulationId),
  });
  for (const id of [issue, simulationId(7), simulationId(8)]) {
    server.run(owner, { type: "create_issue", input: { id, team_id: team, title: "Issue 🦊" } });
    server.run(member, {
      type: "add_comment",
      id: simulationId(sequence++),
      issue_id: id,
      body: "Initial 🦊",
      mentions: [owner.id],
      attachments: [],
    });
  }

  const wrapStorage = (client: Client, storage: ReplicaStorage): ReplicaStorage => ({
    ...storage,
    list: () => storage.list(),
    delete: (identity) => storage.delete(identity),
    deleteAllExcept: (session) => storage.deleteAllExcept(session),
    async open(input) {
      const replica = await storage.open(input);
      async function write<T>(work: () => Promise<T>): Promise<T> {
        client.pendingWrites++;
        try {
          if (client.holdWrite) {
            client.holdWrite = false;
            await new Promise<void>((resolve) => {
              client.gate = resolve;
            });
            client.gate = null;
          }
          const value = await work();
          // Expose the disk/store boundary to close, stop and new admission.
          await flush(1);
          return value;
        } finally {
          client.pendingWrites--;
        }
      }
      return {
        load: () => replica.load(),
        loadOutbox: () => replica.loadOutbox(),
        close: () => replica.close(),
        resetBase: () => write(() => replica.resetBase()),
        writeBootstrap: (value) => write(() => replica.writeBootstrap(value)),
        applyPull: (value) => write(() => replica.applyPull(value)),
        writeScope: (value) => write(() => replica.writeScope(value)),
        appendMutation: (value) => write(() => replica.appendMutation(value)),
        allocateMutationIdIfOutboxEmpty: () =>
          write(() => replica.allocateMutationIdIfOutboxEmpty()),
      };
    },
  });

  const build = (client: Client): SyncEngine => {
    const transport = createTransport({
      headers: () => ({ cookie: `blackwall_session=${client.token}` }),
      async fetch(input, init) {
        const url = new URL(String(input), "http://fake.test");
        const route = url.pathname.split("/").at(-1);
        const headers = new Headers(init?.headers);
        check(headers.get("cookie") === `blackwall_session=${client.token}`, "missing cookie auth");
        check(!headers.has("authorization"), "unexpected bearer auth");
        // Each simulated tab has its own REST token singleton.
        if (init?.method === "POST") headers.set("X-CSRF-Token", client.csrf);
        const faultIndex = client.wireFaults.findIndex((fault) => fault.route === route);
        const fault = faultIndex < 0 ? undefined : client.wireFaults.splice(faultIndex, 1)[0];
        const read = route === "bootstrap" || route === "pull" || route === "scope";
        if (read) client.pendingReads++;
        if (route === "push") client.pendingPushes++;
        try {
          if (route === "push") {
            const payload = String(init?.body);
            if (client.retryPayload !== null)
              equal(payload, client.retryPayload, "retry changed the captured batch");
            client.retryPayload = payload;
          }
          if (fault?.kind === "failed_auth_body" && !(route === "me" && fault.status === 403)) {
            server.removeMember(workspace.id, client.actor);
            if (fault.status === 401) server.logout(client.token);
          }
          let response = await server.fetch(input, { ...init, headers });
          if (fault?.kind === "failed_auth_body" && route === "me" && fault.status === 403) {
            response = Response.json({ error: "CSRF refresh refused" }, { status: 403 });
          }
          const csrf = response.headers.get("X-CSRF-Token");
          if (csrf) client.csrf = csrf;
          if (route === "push" && response.ok) client.retryPayload = null;
          if (fault?.kind === "failed_auth_body" && response.status === fault.status) {
            response = new Response(
              new ReadableStream({
                start(controller) {
                  controller.error(new Error("failed error body"));
                },
              }),
              { status: fault.status },
            );
            coverage.add(`auth-${route}-${fault.status}`);
          }
          if (fault?.kind === "malformed" && response.ok) {
            coverage.add(`malformed-${route}`);
            if (route === "bootstrap") {
              const text = await response.text();
              const lines = text.trimEnd().split("\n");
              const index = lines.findIndex((line) => line.includes('"entity":"issues"'));
              check(index > 0, "missing bootstrap issue for corruption");
              const row: unknown = JSON.parse(lines[index]);
              check(object(row) && object(row.record), "invalid bootstrap fixture");
              row.record.updated_at = "bad timestamp";
              lines[index] = JSON.stringify(row);
              response = new Response(lines.join("\n") + "\n", { headers: response.headers });
            } else if (route === "push") {
              response = Response.json({
                last_mutation_id: 999999,
                results: [{ id: 999999, status: "applied" }],
              });
            } else if (route === "scope") {
              response = Response.json({ records: [{ id: issue, created_at: "bad timestamp" }] });
            } else {
              const page: unknown = await response.json();
              check(object(page) && Array.isArray(page.changes), "invalid pull fixture");
              page.changes.push({
                entity: "issues",
                id: issue,
                record: { ...server.record("issues", issue), updated_at: "bad timestamp" },
              });
              response = Response.json(page);
            }
          }
          return response;
        } finally {
          if (read) client.pendingReads--;
          if (route === "push") client.pendingPushes--;
        }
      },
    });
    const engine = createEngine({
      storage: client.storage,
      transport,
      actor: client.actor,
      sessionId: client.sessionId,
      workspaceId: workspace.id,
      schema: SCHEMA,
      signals: client.signals,
      clock: { now: server.now, schedule: server.schedule },
      randomId: () => simulationId(sequence++),
      ...(hub ? { locks: hub.locks, channel: hub.channel } : {}),
    });
    engine.subscribe((event) => {
      if (event.type === "error" && event.error instanceof ProtocolError) client.blocked = true;
      if (event.type === "accessLost" || event.type === "unauthorized") {
        check(
          server.record("members", client.actor, owner.id) === null,
          "client wiped while its actor still had workspace access",
        );
        client.wiped = true;
        coverage.add(event.type);
      }
    });
    allEngines.push(engine);
    return engine;
  };

  async function disk(client: Client): Promise<LoadedReplica> {
    const replica = await client.storage.open({
      sessionId: client.sessionId,
      workspaceId: workspace.id,
      schema: SCHEMA,
    });
    try {
      return await replica.load();
    } finally {
      replica.close();
    }
  }

  async function settleIO(): Promise<void> {
    for (let turn = 0; turn < 200; turn++) {
      await flush(2);
      if (
        clients.every(
          (client) =>
            client.gate !== null || (client.pendingWrites === 0 && client.admissions === 0),
        )
      ) {
        await flush();
        if (
          clients.every(
            (client) =>
              client.gate !== null || (client.pendingWrites === 0 && client.admissions === 0),
          )
        )
          return;
      }
    }
    throw new Error("host IO did not drain");
  }

  function admit(client: Client, command: Command): void {
    log(`mutate c${client.index} ${JSON.stringify(command)}`);
    client.admissions++;
    void client.engine
      .mutate(command.type, command)
      .then(
        (receipt) => {
          const item: Accepted = {
            client,
            generation: client.generation,
            command,
            receipt,
            outcome: { kind: "pending" },
          };
          accepted.push(item);
          void receipt.settled.then(
            (value) => {
              item.outcome =
                value === "applied"
                  ? { kind: "applied" }
                  : { kind: "rejected", status: value.status, message: value.message };
            },
            (error: unknown) => {
              const reason = error instanceof Error ? error.message : String(error);
              check(
                /closed|stopped|permission|authentication/i.test(reason),
                `unclassified receipt rejection: ${reason}`,
              );
              item.outcome = { kind: "cancelled", reason };
            },
          );
        },
        (error: unknown) => {
          check(
            error instanceof MutationError ||
              (error instanceof Error && /closed/.test(error.message)),
            `unexpected admission error: ${String(error)}`,
          );
          coverage.add("admission-rejected");
        },
      )
      .catch((error: unknown) => {
        failure ??= error;
      })
      .finally(() => {
        client.admissions--;
      });
  }

  function online(client: Client, remove = false): void {
    log(`online c${client.index} ${remove ? "remove_member" : "set_role"}`);
    client.onlineCalls++;
    void client.engine
      .runOnline(
        remove ? "remove_member" : "set_role",
        remove
          ? { user_id: viewer.id }
          : { user_id: member.id, role: pick(["member", "viewer"] satisfies Role[]) },
      )
      .then(
        (result) => {
          check(
            result.status !== "rejected" || result.error.status >= 400,
            "missing online rejection status",
          );
        },
        (error: unknown) => {
          check(error instanceof Error, "online promise rejected without an error");
        },
      )
      .catch((error: unknown) => {
        failure ??= error;
      })
      .finally(() => {
        client.onlineCalls--;
      });
  }

  function commandFor(client: Client): Command {
    return convergenceCommand({
      store: client.engine.store,
      actor: client.actor,
      team,
      owner: owner.id,
      text: `s${seed}-${step}-${sequence++} 🦊`,
      at: server.now(),
      random,
    });
  }

  function hold(client: Client, scope: Scope) {
    const key = scopeKey(scope);
    const prior = client.held.get(key);
    if (prior) {
      prior.release();
      prior.release();
      client.held.delete(key);
      log(`release c${client.index} ${key}`);
    } else {
      client.held.set(key, { scope, release: client.engine.useScope(scope) });
      log(`hold c${client.index} ${key}`);
    }
  }

  async function reload(client: Client): Promise<void> {
    client.gate?.();
    client.holdWrite = false;
    await client.engine.close();
    await settleIO();
    client.generation++;
    client.blocked = false;
    client.retryPayload = null;
    client.engine = build(client);
    await client.engine.open();
    for (const held of client.held.values()) held.release = client.engine.useScope(held.scope);
    if (client.running) await client.engine.start();
  }

  try {
    const actors = tabs
      ? Array.from({ length: seed % 2 === 0 ? 3 : 2 }, () => owner)
      : seed % 2 === 0
        ? [owner, admin, member]
        : [owner, member];
    const browserToken = tabs ? server.login(owner) : null;
    for (const [index, actor] of actors.entries()) {
      const token = browserToken ?? server.login(actor);
      const storage: ReplicaStorage =
        tabs || index === 1
          ? new IndexedDBReplicaStorage({ indexedDB: tabs ? database : new IDBFactory() })
          : new MemoryReplicaStorage();
      // build() does not start work, so the client is populated before its first request.
      const client = {
        index,
        actor: actor.id,
        token,
        csrf: server.csrfToken(token),
        sessionId: simulationId(tabs ? 20 : 20 + index),
        signals: new Signals(),
        storage,
        generation: 0,
        running: true,
        wiped: false,
        held: new Map(),
        wireFaults: [],
        pendingReads: 0,
        pendingPushes: 0,
        pendingWrites: 0,
        gate: null,
        holdWrite: false,
        admissions: 0,
        onlineCalls: 0,
        clientId: "",
        blocked: false,
        retryPayload: null,
        tabClosed: false,
      } satisfies Omit<Client, "engine">;
      let engine: SyncEngine;
      const entry: Client = {
        ...client,
        get engine() {
          return engine;
        },
        set engine(value) {
          engine = value;
        },
      };
      entry.storage = wrapStorage(entry, storage);
      entry.engine = build(entry);
      clients.push(entry);
      await entry.engine.open();
      entry.clientId = (await disk(entry)).meta.clientId;
      await entry.engine.start();
    }
    await settleIO();
    for (const client of clients) hold(client, { entity: "comments", issueId: issue });
    // Seeded stress segment: mutations queue while pokes exceed delayed pull throughput.
    server.inject({ kind: "response_delay", route: "pull", milliseconds: 180 });
    server.inject({ kind: "unavailable", route: "scope" });
    hold(clients[0], { entity: "activity", entityId: issue });
    for (step = 0; step < 12; step++) {
      server.run(member, { type: "update_issue", id: issue, patch: { title: `poke ${step}` } });
      admit(clients[0], { type: "update_issue", id: issue, patch: { title: `queued ${step}` } });
      server.advance(2);
      await settleIO();
      log("poke-storm");
    }
    for (step = 12; step < steps; step++) {
      if (failure !== undefined) throw failure;
      for (const client of clients) client.gate?.();
      const active = clients.filter((client) => !client.wiped && !client.tabClosed);
      const client = pick(active);
      switch (integer(tabs ? 19 : 18)) {
        case 0:
        case 1:
        case 2:
        case 3:
        case 4:
          admit(client, commandFor(client));
          break;
        case 5:
          log("server-edit");
          try {
            const issues = server.records("issues").filter((row) => row.deleted_at === null);
            if (!issues.length)
              server.run(owner, {
                type: "create_issue",
                input: { id: simulationId(sequence++), team_id: team, title: "Server replacement" },
              });
            server.run(pick([owner, admin, member]), {
              type: "update_issue",
              id: pick(server.records("issues").filter((row) => row.deleted_at === null)).id,
              patch: { title: `server ${seed}-${step} 🦊` },
            });
          } catch (error) {
            check(error instanceof MutationError, "unexpected server edit failure");
          }
          break;
        case 6: {
          const targetId = client.engine.store.all("issues").length
            ? pick(client.engine.store.all("issues")).id
            : issue;
          hold(
            client,
            integer(2) === 0
              ? { entity: "comments", issueId: targetId }
              : { entity: "activity", entityId: targetId },
          );
          break;
        }
        case 7: {
          const route = pick(["push", "pull", "scope", "bootstrap", "events"] satisfies Route[]);
          const fault: Fault = pick([
            { kind: "delay", route, milliseconds: [10, 800] },
            { kind: "drop_response", route },
            { kind: "duplicate_push" },
            { kind: "unavailable", route, after: integer(4) },
            {
              kind: "response_delay",
              route: pick(["push", "pull", "scope", "bootstrap"]),
              milliseconds: [30, 900],
            },
            { kind: "truncate_bootstrap", afterRecords: integer(12) },
            { kind: "cut_bootstrap", byte: integer(1600) },
            { kind: "close_events", afterMs: 2 + integer(100) },
            { kind: "reset_pull" },
          ] satisfies Fault[]);
          log(`fault ${JSON.stringify(fault)}`);
          server.inject(fault);
          break;
        }
        case 8:
          client.signals.send(client.signals.online ? "offline" : "online");
          log(`connectivity c${client.index} ${client.signals.online}`);
          break;
        case 9:
          client.running = !client.running;
          if (client.running) await client.engine.start();
          else client.engine.stop();
          log(`lifecycle c${client.index} ${client.running ? "start" : "stop"}`);
          break;
        case 10:
          log(
            `reload c${client.index} pending=${client.engine.status.get().pending} reads=${client.pendingReads} pushes=${client.pendingPushes}`,
          );
          await reload(client);
          break;
        case 11:
          log(`csrf-rotation c${client.index}`);
          server.rotateCsrf(client.token);
          break;
        case 12:
          log("horizon");
          server.advanceHorizon();
          break;
        case 13:
          client.signals.send(pick(["focus", "visible"]));
          log(`signal c${client.index}`);
          break;
        case 14:
          log(`commit-boundary c${client.index}`);
          client.holdWrite = true;
          admit(client, commandFor(client));
          online(client);
          await flush();
          if (integer(2) === 0) client.engine.stop();
          client.gate?.();
          client.holdWrite = false;
          if (integer(2) === 0) await reload(client);
          break;
        case 15:
          online(client, integer(12) === 0);
          // Admission races the outbox-empty allocation.
          admit(client, commandFor(client));
          break;
        case 16: {
          const route = pick(["pull", "scope", "bootstrap", "push"] satisfies (
            | "pull"
            | "scope"
            | "bootstrap"
            | "push"
          )[]);
          log(`malformed c${client.index} ${route}`);
          client.wireFaults.push({ kind: "malformed", route });
          if (route === "bootstrap") server.inject({ kind: "reset_pull" });
          if (route === "push") {
            online(client);
            admit(client, commandFor(client));
          }
          if (route === "scope") hold(client, { entity: "activity", entityId: simulationId(7) });
          void client.engine.pull();
          break;
        }
        case 17:
          log("advance-large");
          server.advance(1000 + integer(7000));
          break;
        case 18: {
          const leaderTab = clients.find(
            (entry) =>
              !entry.wiped && !entry.tabClosed && entry.engine.status.get().role === "leader",
          );
          // Keep one open tab, so the picks above always have a client.
          if (!leaderTab || active.length < 2) break;
          log(`close-leader c${leaderTab.index}`);
          leaderTab.tabClosed = true;
          await leaderTab.engine.close();
          break;
        }
      }
      server.advance(integer(160));
      await settleIO();
    }

    step = steps;
    log("heal");
    server.clearFaults();
    for (const client of clients) {
      client.gate?.();
      client.holdWrite = false;
      client.wireFaults.length = 0;
      client.signals.send("online");
      client.running = true;
      if (client.tabClosed) {
        client.tabClosed = false;
        await reload(client);
      }
      // Protocol errors deliberately block their lane until a new engine opens.
      if (client.blocked) await reload(client);
      await client.engine.start();
      void client.engine.pull();
    }
    let quiet = false;
    for (let tick = 0; tick < 200; tick++) {
      for (const client of clients) {
        if (client.blocked) await reload(client);
      }
      server.advance(1000);
      await settleIO();
      if (failure !== undefined) throw failure;
      quiet = clients.every(
        (client) =>
          client.engine.status.get().pending === 0 &&
          client.engine.status.get().phase === "ready" &&
          client.engine.status.get().connected &&
          client.pendingReads === 0 &&
          client.pendingPushes === 0 &&
          client.pendingWrites === 0 &&
          client.admissions === 0 &&
          client.onlineCalls === 0,
      );
      if (quiet) {
        for (const client of clients) {
          const saved = await disk(client);
          if (
            [...client.held.keys()].some(
              (key) => !saved.scopes.some((scope) => scopeKey(scope) === key),
            )
          )
            quiet = false;
        }
      }
      if (quiet) {
        await Promise.all(clients.map((client) => client.engine.pull()));
        await settleIO();
        break;
      }
    }
    check(
      quiet,
      `did not quiesce in 200 simulated seconds: ${JSON.stringify(
        clients.map((client) => ({
          index: client.index,
          status: client.engine.status.get(),
          reads: client.pendingReads,
          pushes: client.pendingPushes,
          online: client.onlineCalls,
        })),
      )}`,
    );

    for (const client of clients) {
      for (const entity of BOOTSTRAP_ENTITIES) {
        equal(
          sorted(entity, client.engine.store.all(entity)),
          sorted(
            entity,
            server.records(entity, client.actor).map((row) => normalize(entity, row)),
          ),
          `client ${client.index} ${entity} did not converge`,
        );
      }
      for (const { scope } of client.held.values()) {
        const actual = client.engine.store
          .all(scope.entity)
          .filter((row) =>
            scope.entity === "comments"
              ? "issue_id" in row && row.issue_id === scope.issueId
              : "entity_id" in row && row.entity_id === scope.entityId,
          );
        const expected = server
          .records(scope.entity, client.actor)
          .filter((row) =>
            scope.entity === "comments"
              ? "issue_id" in row && row.issue_id === scope.issueId
              : "entity_id" in row && row.entity_id === scope.entityId,
          );
        equal(
          sorted(scope.entity, actual),
          sorted(
            scope.entity,
            expected.map((row) => normalize(scope.entity, row)),
          ),
          `client ${client.index} held scope ${scopeKey(scope)} did not converge`,
        );
      }
      const authoritative = server.records("issues", client.actor);
      const kinds = new Map(
        server
          .records("teams", client.actor)
          .flatMap((row) =>
            row.stages.map((stage) => [stage.id, stage.kind] satisfies [string, string]),
          ),
      );
      const done = (id: string) => ["done", "cancelled"].includes(kinds.get(id) ?? "");
      for (const row of client.engine.store.all("issues")) {
        const counted = withCounts(client.engine.store, row);
        const children = authoritative.filter(
          (item) => item.parent_id === row.id && item.deleted_at === null,
        );
        equal(
          [counted.blocked_count, counted.subtask_total, counted.subtask_completed],
          [
            authoritative.filter(
              (item) =>
                row.dependencies.includes(item.id) &&
                item.deleted_at === null &&
                kinds.has(item.stage_id) &&
                !done(item.stage_id),
            ).length,
            children.length,
            children.filter((item) => done(item.stage_id)).length,
          ],
          `client ${client.index} counts ${row.id}`,
        );
      }
      const saved = await disk(client);
      equal(saved.outbox, [], `client ${client.index} persisted outbox not empty`);
      equal(
        saved.meta.lastMutationId,
        server.clientState(client.clientId).last_mutation_id,
        `client ${client.index} persisted an acknowledgement the server did not issue`,
      );
      const before = Object.fromEntries(
        ENTITIES.map((entity) => [entity, sorted(entity, client.engine.store.all(entity))]),
      );
      client.running = false;
      await reload(client);
      const after = Object.fromEntries(
        ENTITIES.map((entity) => [entity, sorted(entity, client.engine.store.all(entity))]),
      );
      equal(after, before, `client ${client.index} reloaded view changed`);
    }
    for (const item of accepted) {
      check(item.outcome.kind !== "pending", `receipt ${item.receipt.mutationId} never settled`);
      const result = results.get(`${item.client.clientId}:${item.receipt.mutationId}`);
      check(
        result !== undefined,
        `accepted mutation ${item.receipt.mutationId} never reached the server`,
      );
      if (item.outcome.kind === "applied") {
        check(
          result.status === "applied",
          `client ${item.client.index} receipt ${item.receipt.mutationId} ${JSON.stringify(item.command)} claimed applied but server ${JSON.stringify(result)}`,
        );
        const entity =
          item.command.type === "create_issue"
            ? "issues"
            : item.command.type === "create_label"
              ? "labels"
              : item.command.type === "create_project"
                ? "projects"
                : null;
        if (entity && item.receipt.id)
          check(
            server.record(entity, item.receipt.id) !== null,
            `applied create ${item.receipt.id} lost`,
          );
      }
      if (item.outcome.kind === "rejected") {
        check(result.status === "rejected", "receipt rejection disagrees with server");
        equal(item.outcome.status, result.error.status, "rejection lost server status");
      }
    }
    const summarize = (): ConvergenceResult => {
      trace.push(`server pushes: ${JSON.stringify(serverPushes)}`);
      trace.push(
        `outcomes: ${JSON.stringify(
          accepted.map((item) => ({
            client: item.client.index,
            id: item.receipt.mutationId,
            outcome: item.outcome,
          })),
        )}`,
      );
      return {
        seed,
        trace,
        traceHash: createHash("sha256").update(trace.join("\n")).digest("hex"),
        coverage: [...coverage].sort(),
        accepted: accepted.length,
      };
    };
    // Tabs share one storage identity, so the access-loss tail below does not apply.
    if (tabs) return summarize();
    // Exercise a genuine access loss on a seeded route after the convergence oracle.
    // /me 403 only refuses CSRF refresh; it must preserve an otherwise authorized replica.
    const authClient = clients[1];
    authClient.signals.send("online");
    authClient.engine.stop();
    const authRoute = (["me", "bootstrap", "pull", "push", "scope", "events"] satisfies Route[])[
      seed % 6
    ];
    const authStatus = seed % 12 < 6 ? 401 : 403;
    log(`auth c1 ${authRoute} ${authStatus} failed-body`);
    authClient.wireFaults.push({ kind: "failed_auth_body", route: authRoute, status: authStatus });
    if (authRoute === "bootstrap") server.inject({ kind: "reset_pull" });
    if (authRoute === "scope")
      authClient.engine.useScope({ entity: "activity", entityId: simulationId(9998) });
    if (authRoute === "me") server.rotateCsrf(authClient.token);
    if (authRoute === "push" || authRoute === "me") online(authClient);
    await authClient.engine.start();
    for (let tick = 0; tick < 20; tick++) {
      await settleIO();
      if (authClient.wiped || authClient.blocked) break;
      server.advance(1000);
    }
    check(coverage.has(`auth-${authRoute}-${authStatus}`), "auth fault did not reach its route");
    const preserved = authRoute === "me" && authStatus === 403;
    check(authClient.wiped !== preserved, "auth failure applied the wrong cleanup policy");
    if (preserved) {
      check(authClient.blocked, "CSRF refresh refusal did not complete callers");
      check((await authClient.storage.list()).length === 1, "CSRF refusal removed persistence");
    } else {
      equal(await authClient.storage.list(), [], "wiped client retained persistence");
      equal(authClient.engine.store.all("issues"), [], "wiped client retained its view");
      check(
        server.record("members", authClient.actor, owner.id) === null,
        "wiped actor retained access",
      );
    }
    await settleIO();
    check(authClient.onlineCalls === 0, "auth error abandoned an online caller");
    for (const other of clients.filter((client) => client !== authClient)) {
      check((await other.storage.list()).length === 1, "wipe removed another client's replica");
    }
    return summarize();
  } catch (error) {
    throw new Error(
      `Convergence seed=${seed} step=${step}\nReproduce: SYNC_FUZZ_SEED=${seed} vp test run app/sync/convergence.test.ts\n${trace.slice(-45).join("\n")}\n${error instanceof Error ? error.stack : String(error)}`,
      { cause: error },
    );
  } finally {
    for (const client of clients) {
      client.gate?.();
      client.holdWrite = false;
    }
    for (const engine of allEngines) await engine.close();
    server.close();
  }
}
