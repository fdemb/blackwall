import {
  admit,
  createReplay,
  createsRecord,
  MutationError,
  normalizeArgs,
  ONLINE_ONLY,
} from "./mutators";
import { DEFAULT_STAGES } from "./mutators/planning";
import { acceptsChange, recordKey, recordScope, scopeKey } from "./persistence/shared";
import type { Replica, ReplicaCloseReason, Scope } from "./persistence/types";
import { BOOTSTRAP_ENTITIES, BOOTSTRAP_REPLACED_ENTITIES } from "./records";
import type { Change, Entity } from "./records";
import { immutableCopy, ingest, SyncStore } from "./store";
import type { PendingMutation } from "./store";
import {
  AccessError,
  NetworkError,
  ProtocolError,
  UnauthorizedError,
  UnavailableError,
} from "./transport";
import type { Mutation, MutationResult, PullResponse } from "./transport";
import { backoff, Cancelled, cancellable, pause, SerialQueue } from "./engine-scheduling";
import type {
  EngineDependencies,
  EngineEvent,
  EngineRole,
  EngineStatus,
  MutationReceipt,
  Rejection,
  ScopeStatus,
  TabChannel,
} from "./engine-types";
import type { LoadedReplica } from "./persistence/types";
import type { TabBody, TabCall, TabError, TabMessage, TabOutcome } from "./tabs";

export type {
  EngineClock,
  EngineDependencies,
  EngineEvent,
  EngineRole,
  EngineSignal,
  EngineSignals,
  EngineStatus,
  MutationReceipt,
  Rejection,
  ScopeStatus,
  TabChannel,
  TabLocks,
} from "./engine-types";
export type { TabMessage } from "./tabs";

export const SCHEMA = 4;

export class OutdatedError extends Error {
  constructor(message = "A newer version is open in another tab. Reload to continue.") {
    super(message);
  }
}

/** A follower re-sends an unanswered request on this cadence, in case the leader went away. */
const REQUEST_RESEND_MS = 1000;
/** A pull or scope read that takes longer fails and retries, so it can't hold the read queue. */
const READ_DEADLINE_MS = 30_000;
/** A push or online command that takes longer fails and retries with the same ids. */
const WRITE_DEADLINE_MS = 60_000;
/** The server comments every 15 seconds, so an event stream silent for five of them is dead. */
const STREAM_IDLE_MS = 75_000;
/** The server caps mutations per push at 100 and request bodies at 6 MiB. */
const PUSH_MUTATIONS = 100;
const PUSH_BYTES = 4 * 1024 * 1024;
const encoder = new TextEncoder();
type RequestKind = "bootstrap" | "pull" | "scope" | "push" | "events";
type PushBatch = {
  /** Halved after a 413, so a body the server refuses never blocks the outbox. */
  mutations: readonly Mutation[];
  processed: boolean;
  attempt: number;
  retryAt: number;
  csrfRefreshes: number;
};
/** A follower's request to the leader, kept until its reply or the engine stops. */
type RemoteRequest = {
  call: TabCall;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  cancelResend: () => void;
};
type TabReply = { ok: true; value: unknown } | { ok: false; error: TabError };
type ServedReply = { reply: Promise<TabReply>; cancelExpiry: () => void };

/** Its share of a push body, as the transport encodes it. */
function encodedSize({ id, name, args, at }: Mutation): number {
  return encoder.encode(JSON.stringify({ id, name, args, at })).length + 1;
}

/** The oldest mutations that fit one push. The first always goes, so a large one isn't skipped. */
function pushBatch(candidates: readonly Mutation[]): Mutation[] {
  const batch: Mutation[] = [];
  let bytes = 0;
  for (const mutation of candidates.slice(0, PUSH_MUTATIONS)) {
    bytes += encodedSize(mutation);
    if (batch.length > 0 && bytes > PUSH_BYTES) break;
    batch.push(mutation);
  }
  return batch;
}

function tabError(error: unknown): TabError {
  const message = error instanceof Error ? error.message : String(error);
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === "number" ? { message, status } : { message };
}

function errorFrom(error: TabError): Error {
  return error.status === undefined
    ? new Error(error.message)
    : new MutationError(error.status, error.message);
}

/** One replica. Only start/stop controls leadership and network ownership. */
export function createEngine(deps: EngineDependencies): SyncEngine {
  return new SyncEngine(deps);
}

export class SyncEngine {
  readonly store: SyncStore;
  readonly status: { get: () => EngineStatus; subscribe: (listener: () => void) => () => void };
  private snapshot: EngineStatus;
  private readonly channel: TabChannel | null;
  private readonly tabId: string;
  private readonly lockName: string;
  private role: EngineRole;
  private lockPending = false;
  private lockHeld = false;
  private releaseLock: (() => void) | null = null;
  /** Coordination messages wait here until open has loaded the replica. */
  private ready = false;
  private readonly inbox: TabMessage[] = [];
  /** Acknowledged mutations whose push result is still unknown, retained for a confirmation push. */
  private readonly unconfirmed = new Map<number, Mutation>();
  /** Pushed mutations whose result this engine has seen, until a pull acknowledges them. */
  private readonly resulted = new Set<number>();
  /** Mutation ids another tab appended while this engine listened. */
  private readonly appendedIds = new Set<number>();
  /** The leader's replies, so a re-sent request runs once. */
  private readonly served = new Map<string, ServedReply>();
  private readonly remote = new Map<string, RemoteRequest>();
  private requestCount = 0;
  private leaderId = "";
  private leaderOnline = false;
  private leaderBlocked = false;
  private readonly onMessage = (event: { data: TabMessage }) => this.receive(event.data);
  private readonly statusListeners = new Set<() => void>();
  private readonly eventListeners = new Set<(event: EngineEvent) => void>();
  private readonly reads = new SerialQueue();
  private readonly commits = new SerialQueue();
  private readonly onlineRequests = new SerialQueue();
  private readonly loadedScopes = new Map<string, Scope>();
  private readonly heldScopes = new Map<string, { scope: Scope; holders: number }>();
  private readonly scopeWork = new Map<string, Promise<void>>();
  private readonly scopeFailures = new Map<string, Error>();
  private readonly scopeListeners = new Set<() => void>();
  /** Leader requests waiting for their scope to load or fail. */
  private readonly scopeWaiters = new Set<() => void>();
  private readonly blocked = new Set<RequestKind>();
  private readonly outcomes = new Map<
    number,
    {
      mutation: Mutation;
      resolve: (result: "applied" | Rejection) => void;
      reject: (error: Error) => void;
    }
  >();
  private readonly ackWaiters = new Set<() => void>();
  private readonly changes = new Set<() => void>();
  private retirement: Promise<void> | null = null;
  private sealed = false;
  private readonly reported = new Set<number>();
  private readonly onlineCalls = new Set<AbortController>();
  private readonly delay: ReturnType<typeof backoff>;
  private replica: Replica | null = null;
  private opening: Promise<void> | null = null;
  private closed = false;
  private terminal = false;
  private outdated: OutdatedError | null = null;
  private started = false;
  private lifecycle = 0;
  private controller: AbortController | null = null;
  private unsubscribeSignals: (() => void) | null = null;
  private clientId = "";
  private cursor: string | null = null;
  private acknowledged = 0;
  private pullAgain = false;
  private pulling: Promise<void> | null = null;
  private pushing: Promise<void> | null = null;
  private batch: PushBatch | null = null;
  /** The last error came from a push, so only a push success clears it. */
  private writeFailing = false;

  constructor(private readonly deps: EngineDependencies) {
    this.store = new SyncStore(createReplay(deps.actor));
    this.delay = backoff(`${deps.sessionId}:${deps.workspaceId}`, deps.clock);
    this.lockName = `blackwall-sync:${deps.sessionId}:${deps.workspaceId}`;
    this.role = deps.locks ? "follower" : "leader";
    this.tabId = deps.channel ? deps.randomId() : "";
    this.channel = deps.channel?.(this.lockName) ?? null;
    this.channel?.addEventListener("message", this.onMessage);
    this.snapshot = Object.freeze({
      phase: "loading",
      role: this.role,
      online: deps.signals.getOnline(),
      connected: false,
      pending: 0,
      blocked: false,
      lastError: null,
      rejected: Object.freeze([]),
      unresolved: Object.freeze([]),
    });
    this.status = {
      get: () => this.snapshot,
      subscribe: (listener) => {
        this.statusListeners.add(listener);
        return () => this.statusListeners.delete(listener);
      },
    };
    this.store.subscribe((event) => {
      if (event.pendingChanged) {
        this.update({ pending: this.store.pending().length });
        this.notifyChange();
      }
    });
  }

  subscribe(listener: (event: EngineEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  /** Whether a scope is in the replica. A protocol error that blocks its loads reports "error". */
  scopeStatus(scope: Scope): ScopeStatus {
    const key = scopeKey(scope);
    if (this.loadedScopes.has(key)) return "loaded";
    return this.scopeFailures.has(key) ? "error" : "loading";
  }

  scopeError(scope: Scope): Error | null {
    return this.scopeFailures.get(scopeKey(scope)) ?? null;
  }

  subscribeScopes(listener: () => void): () => void {
    this.scopeListeners.add(listener);
    return () => this.scopeListeners.delete(listener);
  }

  open(): Promise<void> {
    if (this.closed || this.terminal)
      return Promise.reject(this.outdated ?? new Error("Engine is closed"));
    this.opening ??= this.commits.run(async () => {
      const replica = await this.deps.storage.open({
        sessionId: this.deps.sessionId,
        workspaceId: this.deps.workspaceId,
        schema: this.deps.schema,
        onClose: (reason, newVersion) => this.replicaClosed(reason, newVersion),
      });
      this.replica = replica;
      let loaded = await replica.load();
      if (loaded.meta.schema !== this.deps.schema) {
        await replica.resetBase();
        loaded = await replica.load();
      }
      this.applyLoaded(loaded);
      this.update({ phase: this.cursor === null ? "bootstrapping" : "ready" });
      if (!this.closed && !this.terminal) {
        this.unsubscribeSignals = this.deps.signals.subscribe((signal) => {
          if (signal === "offline") {
            this.update({ online: false });
            this.notifyChange();
            this.cancelNetwork();
          } else if (signal === "online") {
            this.update({ online: this.role === "leader" || this.leaderOnline });
            this.notifyChange();
            this.beginNetwork();
            void this.pull();
          } else void this.pull();
        });
        this.update({
          online: this.deps.signals.getOnline() && (this.role === "leader" || this.leaderOnline),
        });
      }
      this.ready = true;
      if (this.channel && !this.closed) this.post({ type: "hello" });
      for (const message of this.inbox.splice(0)) this.receive(message);
    });
    return this.opening;
  }

  /** Replaces the in-memory replica with what the database holds. */
  private applyLoaded(loaded: LoadedReplica): void {
    this.clientId = loaded.meta.clientId;
    this.cursor = loaded.meta.cursor;
    this.acknowledged = loaded.meta.lastMutationId;
    for (const mutation of loaded.unconfirmed) this.unconfirmed.set(mutation.id, mutation);
    this.loadedScopes.clear();
    for (const scope of loaded.scopes) this.loadedScopes.set(scopeKey(scope), scope);
    this.store.batch(() => {
      this.store.replaceBase(loaded.records, BOOTSTRAP_REPLACED_ENTITIES);
      this.store.setPending(loaded.outbox);
    });
    this.update({ unresolved: Object.freeze(loaded.rejected) });
  }

  async start(): Promise<void> {
    const lifecycle = this.lifecycle;
    await this.open();
    if (this.started || this.closed || this.terminal || lifecycle !== this.lifecycle) return;
    this.started = true;
    this.notifyChange();
    this.update({
      online: this.deps.signals.getOnline() && (this.role === "leader" || this.leaderOnline),
    });
    this.requestLeadership();
    this.beginNetwork();
    // A follower has no network work to begin, so its holds are requested here instead.
    if (this.role === "follower")
      for (const { scope } of this.heldScopes.values()) this.requestScope(scope);
  }

  stop(): void {
    this.started = false;
    this.lifecycle += 1;
    this.cancelNetwork();
    this.releaseLeadership();
    this.rejectCallers(new Error(this.closed ? "Engine is closed" : "Engine is stopped"));
  }

  private rejectCallers(error: Error): void {
    for (const outcome of this.outcomes.values()) outcome.reject(error);
    this.outcomes.clear();
    this.cancelOnline(error);
    for (const entry of this.served.values()) entry.cancelExpiry();
    this.served.clear();
    for (const remote of this.remote.values()) {
      remote.cancelResend();
      remote.reject(error);
    }
    this.remote.clear();
  }

  isClosed(): boolean {
    return this.closed;
  }

  async close(): Promise<void> {
    const first = !this.closed;
    this.closed = true;
    if (first) this.emit({ type: "closed" });
    this.stop();
    this.channel?.removeEventListener("message", this.onMessage);
    this.channel?.close();
    this.unsubscribeSignals?.();
    this.unsubscribeSignals = null;
    this.notifyChange();
    await this.commits.drain();
    this.replica?.close();
    this.replica = null;
    this.rejectCallers(new Error("Engine is closed"));
  }

  /**
   * Asks for the replica's lock. The callback holds it until stop or close, so a request made
   * while stopped is released as soon as it is granted.
   */
  private requestLeadership(): void {
    const locks = this.deps.locks;
    if (!locks || this.lockPending || this.lockHeld) return;
    this.lockPending = true;
    locks
      .request(this.lockName, () => {
        this.lockPending = false;
        if (!this.started || this.closed || this.terminal) return Promise.resolve();
        this.lockHeld = true;
        const released = new Promise<void>((resolve) => {
          this.releaseLock = resolve;
        });
        this.takeLeadership().catch((error: unknown) => this.finishError(error));
        return released;
      })
      .catch((error: unknown) => this.finishError(error));
  }

  private releaseLeadership(): void {
    if (this.deps.locks) this.setRole("follower");
    if (!this.lockHeld) return;
    this.lockHeld = false;
    const release = this.releaseLock;
    this.releaseLock = null;
    release?.();
  }

  /**
   * Runs once the lock is granted. The leader role starts immediately, so messages from the
   * previous leader are ignored. The replica reloads before network work, which picks up
   * everything that leader persisted. Requests this tab sent as a follower run here instead.
   */
  private async takeLeadership(): Promise<void> {
    this.setRole("leader");
    await this.commits.run(async () => {
      this.applyLoaded(await this.requireReplica().load());
    });
    for (const [requestId, remote] of [...this.remote]) {
      this.remote.delete(requestId);
      remote.cancelResend();
      remote.resolve(null);
    }
    this.post(this.statusMessage());
    this.beginNetwork();
  }

  private setRole(role: EngineRole): void {
    if (this.role === role) return;
    this.role = role;
    this.update({
      role,
      online: this.deps.signals.getOnline() && (role === "leader" || this.leaderOnline),
      blocked: role === "leader" ? this.outboxBlocked() : this.leaderBlocked,
    });
  }

  /**
   * Refuses new mutations and closes once the outbox is empty. Network work keeps running until
   * then. Offline, the engine stays open and idle until it drains or the page unloads.
   */
  retire(): Promise<void> {
    this.sealed = true;
    this.retirement ??= this.closeWhenDrained();
    this.notifyChange();
    return this.retirement;
  }

  /** Accepts mutations again after retire(), unless the engine has already closed. */
  reclaim(): void {
    if (this.closed) return;
    this.sealed = false;
    this.notifyChange();
  }

  private async closeWhenDrained(): Promise<void> {
    // A reclaim in the same turn must win, so the first check waits a turn.
    await Promise.resolve();
    while (!this.closed) {
      if (this.sealed && this.store.pending().length === 0) {
        await this.close();
        return;
      }
      await new Promise<void>((resolve) => this.changes.add(resolve));
    }
  }

  private notifyChange(): void {
    const waiting = [...this.changes];
    this.changes.clear();
    for (const wake of waiting) wake();
  }

  async mutate(name: string, args: unknown): Promise<MutationReceipt> {
    await this.open();
    const lifecycle = this.lifecycle;
    return this.commits.run(async () => {
      if (this.sealed) throw new Error("Engine is retiring");
      const replica = this.requireReplica();
      if (ONLINE_ONLY.some((command) => command === name))
        throw new MutationError(400, "Use runOnline for this command");
      const prepared = this.prepare(name, args);
      const at = this.deps.clock.now();
      const admitted = admit(this.store, this.deps.actor, { name, args: prepared.args, at });
      const mutation = await replica.appendMutation(() => ({
        name,
        args: admitted.args,
        at,
        ...(admitted.local === undefined ? {} : { local: admitted.local }),
      }));
      const settled = new Promise<"applied" | Rejection>((resolve, reject) =>
        this.outcomes.set(mutation.id, { mutation, resolve, reject }),
      );
      void settled.catch(() => undefined);
      if (this.closed || this.terminal || lifecycle !== this.lifecycle) {
        this.outcomes
          .get(mutation.id)
          ?.reject(
            new Error(this.closed || this.terminal ? "Engine is closed" : "Engine is stopped"),
          );
        this.outcomes.delete(mutation.id);
      }
      this.store.setPending([...this.store.pending(), mutation].sort((a, b) => a.id - b.id));
      this.post({ type: "appended", mutation });
      this.requestPush();
      return { id: prepared.id, mutationId: mutation.id, settled };
    });
  }

  async runOnline(name: string, args: unknown): Promise<MutationResult> {
    if (this.outdated) throw this.outdated;
    if (!this.deps.signals.getOnline())
      throw new MutationError(400, "This command requires an online connection");
    await this.open();
    if (this.sealed) throw new Error("Engine is retiring");
    if (!this.snapshot.online)
      throw new MutationError(400, "This command requires an online connection");
    if (
      !ONLINE_ONLY.some((command) => command === name) ||
      name === "add_attachment" ||
      name === "attach_comment_file"
    )
      throw new MutationError(400, "Not an online sync command");
    const prepared = this.prepare(name, args);
    if (!prepared.args || typeof prepared.args !== "object" || Array.isArray(prepared.args))
      throw new MutationError(400, "invalid command arguments");
    const input = {
      command: immutableCopy({ type: name, ...prepared.args }),
      idempotencyKey: this.deps.randomId(),
    };
    const controller = new AbortController();
    this.onlineCalls.add(controller);
    try {
      return await cancellable(
        this.onlineRequests.run(() => this.sendOnline(input, controller)),
        controller.signal,
      );
    } catch (error) {
      if (controller.signal.aborted) throw controller.signal.reason;
      throw error;
    } finally {
      this.onlineCalls.delete(controller);
    }
  }

  private async sendOnline(
    input: { command: object; idempotencyKey: string },
    controller: AbortController,
  ): Promise<MutationResult> {
    for (let attempt = 0, csrfRefreshes = 0; ; attempt++) {
      controller.signal.throwIfAborted();
      await this.drainOutbox(controller.signal);
      try {
        await this.withDeadline(controller, WRITE_DEADLINE_MS, (signal) =>
          this.deps.transport.command(this.deps.workspaceId, input, { signal }),
        );
        controller.signal.throwIfAborted();
        // The server pokes the leader's event stream, including when a follower sends this call.
        if (this.role === "leader") void this.pull();
        // Keep the callers' mutation-result shape without allocating a sync mutation id.
        return { id: 0, status: "applied" };
      } catch (caught) {
        controller.signal.throwIfAborted();
        const next = await this.onlineFailure(caught, controller, csrfRefreshes === 0);
        if (next === "refreshed") {
          csrfRefreshes++;
          continue;
        }
        await pause(this.deps.clock, this.delay(attempt, next.retryAfter), controller.signal);
      }
    }
  }

  /** Online commands wait until earlier offline edits have been pushed. */
  private async drainOutbox(signal: AbortSignal): Promise<void> {
    for (;;) {
      signal.throwIfAborted();
      if (this.started && this.snapshot.online) {
        if ((await this.requireReplica().loadOutbox()).length === 0) return;
        if (this.role === "leader" ? this.outboxBlocked() : this.leaderBlocked)
          throw new Error("Pending changes can't be sent. Reload and try again.");
      }
      this.requestPush();
      await this.waitForOutboxChange(signal);
    }
  }

  /**
   * Rethrows a terminal online-command failure. Returns "refreshed" when a
   * first 403 was a stale CSRF token worth one immediate retry, otherwise
   * the server's retry hint for a backoff.
   */
  private async onlineFailure(
    caught: unknown,
    controller: AbortController,
    canRefreshCsrf: boolean,
  ): Promise<"refreshed" | { retryAfter: number | string | null }> {
    let error = caught;
    if (error instanceof AccessError && (error.status === 403 || error.status === 404)) {
      const { status, message } = error;
      const refresh = status === 403 && canRefreshCsrf;
      let verified = false;
      try {
        await this.verifyCommandAccess(controller, refresh);
        verified = true;
      } catch (cause) {
        controller.signal.throwIfAborted();
        error = cause;
      }
      if (verified) {
        if (refresh) return "refreshed";
        throw new MutationError(status, message);
      }
    }
    if (error instanceof UnauthorizedError || error instanceof AccessError) {
      await this.handleError(error, "push");
      throw error;
    }
    if (
      error instanceof ProtocolError &&
      error.status !== null &&
      error.status >= 400 &&
      error.status < 500
    )
      throw new MutationError(error.status, error.message);
    if (!(error instanceof NetworkError || error instanceof UnavailableError)) throw error;
    return { retryAfter: error instanceof UnavailableError ? error.retryAfter : null };
  }

  private async verifyCommandAccess(
    controller: AbortController,
    refreshCsrf: boolean,
  ): Promise<void> {
    if (refreshCsrf) await cancellable(this.refreshCsrf(), controller.signal);
    // A command may forbid an action or miss its target while workspace access is still valid.
    await cancellable(
      this.deps.transport.pull(this.deps.workspaceId, this.clientId, this.cursor, {
        signal: controller.signal,
      }),
      controller.signal,
    );
  }

  private cancelOnline(error: Error): void {
    for (const controller of this.onlineCalls) controller.abort(error);
  }

  private async waitForOutboxChange(signal: AbortSignal): Promise<void> {
    let wake = () => {};
    const work = new Promise<void>((resolve) => {
      wake = resolve;
    });
    this.changes.add(wake);
    const cancel = this.deps.clock.schedule(1000, wake);
    try {
      await cancellable(work, signal);
    } finally {
      cancel();
      this.changes.delete(wake);
    }
  }

  useScope(scope: Scope): () => void {
    if (this.closed || (this.terminal && !this.outdated)) throw new Error("Engine is closed");
    const key = scopeKey(scope);
    const held = this.heldScopes.get(key) ?? { scope: { ...scope }, holders: 0 };
    held.holders += 1;
    this.heldScopes.set(key, held);
    this.requestScope(held.scope);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      held.holders -= 1;
      if (held.holders === 0) this.heldScopes.delete(key);
    };
  }

  pull(): Promise<void> {
    const controller = this.controller;
    if (!controller || this.blocked.has("pull") || this.blocked.has("bootstrap"))
      return Promise.resolve();
    this.pullAgain = true;
    if (this.pulling) return this.pulling;
    const work = (async () => {
      while (this.pullAgain && this.active(controller)) {
        this.pullAgain = false;
        if (await this.pullPages(controller)) this.pullAgain = true;
      }
    })().catch((error: unknown) => this.finishError(error));
    this.pulling = work;
    void work.then(() => {
      if (this.pulling !== work) return;
      this.pulling = null;
      if (this.pullAgain && this.controller) void this.pull();
      this.requestPush();
    });
    return work;
  }

  /**
   * Clears protocol blocks and scope failures and restarts network work, for a user's retry after
   * a fix on the server. A follower asks the leader, which holds the blocks.
   */
  unblock(): void {
    if (this.role === "follower") {
      this.post({ type: "retry" });
      return;
    }
    this.blocked.clear();
    this.scopeFailures.clear();
    this.batch = null;
    this.update({ blocked: false, lastError: null });
    this.post(this.statusMessage());
    this.notifyScopes();
    this.cancelNetwork();
    this.beginNetwork();
  }

  /** Only unblock() or a new engine clears these blocks; until then the outbox can't drain. */
  private outboxBlocked(): boolean {
    return this.blocked.has("push") || this.blocked.has("pull") || this.blocked.has("bootstrap");
  }

  private statusMessage(): TabBody {
    const error = this.snapshot.lastError;
    return {
      type: "status",
      connected: this.snapshot.connected,
      online: this.snapshot.online,
      blocked: this.outboxBlocked(),
      error:
        error === null || error instanceof OutdatedError
          ? null
          : {
              message: error.message,
              unreachable: error instanceof NetworkError || error instanceof UnavailableError,
            },
    };
  }

  private update(patch: Partial<EngineStatus>): void {
    if (Object.entries(patch).every(([key, value]) => Reflect.get(this.snapshot, key) === value))
      return;
    this.snapshot = Object.freeze({ ...this.snapshot, ...patch });
    for (const listener of this.statusListeners) listener();
    if (
      this.role === "leader" &&
      ("connected" in patch || "online" in patch || "lastError" in patch)
    )
      this.post(this.statusMessage());
  }

  private post(body: TabBody): void {
    if (!this.channel || this.closed) return;
    this.channel.postMessage({ ...body, from: this.tabId } as TabMessage);
  }

  private receive(message: TabMessage): void {
    if (this.closed || message.from === this.tabId) return;
    if (this.terminal && message.type !== "unauthorized" && message.type !== "accessLost") return;
    if (!this.ready) {
      this.inbox.push(message);
      return;
    }
    this.dispatch(message);
  }

  private dispatch(message: TabMessage): void {
    switch (message.type) {
      case "appended":
        this.receiveAppended(message.mutation);
        return;
      case "pulled":
      case "reset":
      case "status":
        if (this.role === "follower") this.receiveFromLeader(message);
        return;
      case "result":
        this.receiveResult(message.mutationId, message.outcome);
        return;
      case "resolved":
        this.dropUnresolved(message.mutationId);
        if (this.role === "leader") this.resolveStored(message.mutationId);
        return;
      case "hello":
      case "retry":
      case "request":
        if (this.role === "leader") this.receiveFromFollower(message);
        return;
      case "unauthorized":
      case "accessLost":
        this.receiveSessionEnd(message.type);
        return;
      case "reply":
        this.receiveReply(
          message.requestId,
          message.ok ? { ok: true, value: message.value } : { ok: false, error: message.error },
        );
        return;
    }
  }

  private receiveFromLeader(
    message: Extract<TabMessage, { type: "pulled" | "reset" | "status" }>,
  ): void {
    switch (message.type) {
      case "pulled":
        this.receivePulled(message);
        return;
      case "reset":
        this.receiveReset();
        return;
      case "status":
        this.receiveStatus(message);
        return;
    }
  }

  private receiveFromFollower(
    message: Extract<TabMessage, { type: "hello" | "retry" | "request" }>,
  ): void {
    switch (message.type) {
      case "hello":
        this.post(this.statusMessage());
        return;
      case "retry":
        this.unblock();
        return;
      case "request":
        this.serve(message);
        return;
    }
  }

  private receiveStatus(message: Extract<TabMessage, { type: "status" }>): void {
    // Not `connected`: the leader's stream drops on every reconnect, and the leader stays online then.
    this.leaderOnline = message.online;
    this.leaderBlocked = message.blocked;
    this.update({
      connected: message.connected,
      online: this.leaderOnline && this.deps.signals.getOnline(),
      blocked: message.blocked,
      lastError: this.leaderError(message.error),
    });
    this.notifyChange();
    // A new leader announces itself with its status, so waiting scope requests go to it.
    if (message.from !== this.leaderId) {
      this.leaderId = message.from;
      this.resendScopeRequests();
    }
  }

  /** The leader's sync error as this follower reports it. This tab's outdated error stays. */
  private leaderError(error: Extract<TabBody, { type: "status" }>["error"]): Error | null {
    const current = this.snapshot.lastError;
    if (current instanceof OutdatedError) return current;
    if (error === null) return null;
    if (current?.message === error.message) return current;
    return error.unreachable ? new NetworkError(error.message) : new Error(error.message);
  }

  /** Another tab's mutation is in the database. Track it, unless its push already acknowledged it. */
  private receiveAppended(mutation: PendingMutation): void {
    this.appendedIds.add(mutation.id);
    if (mutation.id <= this.acknowledged) {
      this.unconfirmed.set(mutation.id, mutation);
      return;
    }
    if (this.store.pending().some((pending) => pending.id === mutation.id)) return;
    this.store.setPending([...this.store.pending(), mutation].sort((a, b) => a.id - b.id));
    this.requestPush();
  }

  /** The leader persisted this page or scope before sending it, so the follower never runs ahead. */
  private receivePulled(message: Extract<TabBody, { type: "pulled" }>): void {
    if (message.scope) {
      this.loadedScopes.set(scopeKey(message.scope), message.scope);
      this.scopeFailures.delete(scopeKey(message.scope));
    }
    const accepted = message.changes.filter((change) =>
      acceptsChange(
        change.entity,
        change.record ?? this.store.baseGet(change.entity, change.id),
        this.loadedScopes,
      ),
    );
    if (message.cursor !== null) this.cursor = message.cursor;
    this.store.batch(() => {
      this.store.applyBase(accepted);
      if (message.acknowledgedUpTo !== null) this.acknowledge(message.acknowledgedUpTo);
    });
    this.update({ phase: this.cursor === null ? "bootstrapping" : "ready" });
    if (message.scope) this.notifyScopes();
  }

  /** Another tab's session ended. This tab stops, closes its handle and clears its view. */
  private receiveSessionEnd(ending: "unauthorized" | "accessLost"): void {
    const failure =
      ending === "unauthorized"
        ? new UnauthorizedError("Session ended in another tab", 401)
        : new AccessError("Workspace access ended in another tab", 403);
    this.endLocal(ending, failure);
  }

  /** An upgrade keeps the readable view; deleting the database still ends workspace access. */
  private replicaClosed(reason: ReplicaCloseReason, newVersion?: number | null): void {
    if (this.closed || this.terminal) return;
    if (reason === "versionchange" && newVersion != null) {
      const failure = new OutdatedError();
      this.outdated = failure;
      this.update({ lastError: failure });
      this.endSession(failure);
      this.replica?.close();
      this.replica = null;
      this.update({ online: false });
      this.emit({ type: "outdated" });
      return;
    }
    if (this.role === "leader") this.post({ type: "accessLost" });
    this.endLocal("accessLost", new AccessError("Replica database was closed"));
  }

  private endLocal(ending: "unauthorized" | "accessLost", failure: Error): void {
    if (this.terminal && !this.outdated) return;
    this.outdated = null;
    this.endSession(failure);
    this.commits
      .run(async () => {
        this.replica?.close();
        this.replica = null;
        this.clearView();
        this.update({ phase: "loading" });
        this.emit({ type: ending });
      })
      .catch((error: unknown) => this.finishError(error));
  }

  /** Stops this engine for good. Callers fail, and network work ends. */
  private endSession(failure: Error): void {
    this.terminal = true;
    this.rejectCallers(failure);
    this.stop();
    this.unsubscribeSignals?.();
    this.unsubscribeSignals = null;
  }

  private clearView(): void {
    this.store.batch(() => {
      this.store.replaceBase({}, BOOTSTRAP_REPLACED_ENTITIES);
      this.store.setPending([]);
    });
  }

  private receiveReset(): void {
    this.commits
      .run(async () => {
        this.applyLoaded(await this.requireReplica().load());
      })
      .then(() => {
        this.notifyScopes();
        for (const { scope } of this.heldScopes.values()) this.requestScope(scope);
      })
      .catch((error: unknown) => this.finishError(error));
  }

  /** The leader's verdict for a mutation. Only the tab that created it settles its receipt. */
  private receiveResult(mutationId: number, outcome: TabOutcome): void {
    if (mutationId > this.acknowledged) this.resulted.add(mutationId);
    const rejection = this.settle(mutationId, outcome, false);
    this.unconfirmed.delete(mutationId);
    this.appendedIds.delete(mutationId);
    if (rejection?.command) this.keepUnresolved([rejection]);
  }

  private receiveReply(requestId: string, reply: TabReply): void {
    const remote = this.remote.get(requestId);
    if (!remote) return;
    this.remote.delete(requestId);
    remote.cancelResend();
    if (reply.ok) remote.resolve(reply.value);
    else remote.reject(errorFrom(reply.error));
  }

  /** Runs a follower's request on the leader and replies. A repeated request joins the first run. */
  private serve(request: Extract<TabBody, { type: "request" }>): void {
    let served = this.served.get(request.requestId);
    if (!served) {
      served = { reply: this.performScope(request.scope), cancelExpiry: () => {} };
      this.served.set(request.requestId, served);
    }
    served.cancelExpiry();
    const entry = served;
    void entry.reply.then((reply) => {
      if (this.served.get(request.requestId) !== entry) return;
      this.post({ type: "reply", requestId: request.requestId, ...reply });
      entry.cancelExpiry();
      entry.cancelExpiry = this.deps.clock.schedule(2 * REQUEST_RESEND_MS, () => {
        this.served.delete(request.requestId);
      });
    });
  }

  /**
   * Holds the scope on the leader until it is loaded or has failed, then answers. The follower
   * asks again after a reset or a leader change, so the leader doesn't keep the hold.
   */
  private performScope(scope: Scope): Promise<TabReply> {
    const key = scopeKey(scope);
    let release: () => void;
    try {
      release = this.useScope(scope);
    } catch (error) {
      return Promise.resolve({ ok: false, error: tabError(error) });
    }
    return new Promise((resolve) => {
      const settle = (): boolean => {
        let reply: TabReply;
        if (this.loadedScopes.has(key)) reply = { ok: true, value: null };
        else {
          const failure = this.scopeFailures.get(key);
          if (failure === undefined) return false;
          reply = { ok: false, error: tabError(failure) };
        }
        this.scopeWaiters.delete(settle);
        release();
        resolve(reply);
        return true;
      };
      if (!settle()) this.scopeWaiters.add(settle);
    });
  }

  /**
   * Sends a call to the leader and re-sends it until a reply arrives. This covers a leader that
   * closed before answering. Re-sends reuse the request id, so the leader answers them from its
   * record of the first run.
   */
  private ask(
    call: TabCall,
    resolve: (value: unknown) => void,
    reject: (error: Error) => void,
  ): void {
    if (!this.channel) {
      reject(new Error("Tab coordination needs a channel"));
      return;
    }
    this.requestCount += 1;
    const requestId = `${this.tabId}:${this.requestCount}`;
    const remote: RemoteRequest = { call, resolve, reject, cancelResend: () => {} };
    this.remote.set(requestId, remote);
    const send = () => {
      this.post({ type: "request", requestId, ...call });
      remote.cancelResend = this.deps.clock.schedule(REQUEST_RESEND_MS, send);
    };
    send();
  }

  /**
   * Settles this tab's receipt for a mutation. A rejection is reported once per engine, and
   * returned with its command so it can be kept.
   */
  private settle(id: number, outcome: TabOutcome, reportOrphan: boolean): Rejection | null {
    const owned = this.outcomes.get(id);
    this.outcomes.delete(id);
    if (outcome === "applied") {
      owned?.resolve("applied");
      return null;
    }
    const source =
      owned?.mutation ??
      this.unconfirmed.get(id) ??
      this.store.pending().find((mutation) => mutation.id === id);
    const command = source ? { name: source.name, args: immutableCopy(source.args) } : null;
    const rejection: Rejection = Object.freeze({ ...outcome, command });
    if ((owned !== undefined || reportOrphan) && !this.reported.has(id)) {
      this.reported.add(id);
      this.update({ rejected: Object.freeze([...this.snapshot.rejected, rejection]) });
      this.emit({ type: "rejected", rejection });
    }
    owned?.resolve(rejection);
    return rejection;
  }

  /**
   * Forgets a kept rejection in every tab, once the user restored, retried or dismissed it. The
   * leader deletes it from the replica after any write that may still be storing it.
   */
  resolveRejection(id: number): void {
    this.dropUnresolved(id);
    this.post({ type: "resolved", mutationId: id });
    if (this.role === "leader" || !this.channel) this.resolveStored(id);
  }

  private resolveStored(id: number): void {
    this.commits
      .run(() => this.requireReplica().resolveRejection(id))
      .catch((error: unknown) => this.finishError(error));
  }

  private keepUnresolved(rejections: readonly Rejection[]): void {
    const kept = new Map(this.snapshot.unresolved.map((rejection) => [rejection.id, rejection]));
    for (const rejection of rejections) kept.set(rejection.id, rejection);
    this.update({ unresolved: Object.freeze([...kept.values()].sort((a, b) => a.id - b.id)) });
  }

  private dropUnresolved(id: number): void {
    const unresolved = this.snapshot.unresolved.filter((rejection) => rejection.id !== id);
    if (unresolved.length < this.snapshot.unresolved.length)
      this.update({ unresolved: Object.freeze(unresolved) });
  }

  private emit(event: EngineEvent): void {
    for (const listener of this.eventListeners) listener(event);
  }

  private requireReplica(): Replica {
    if (!this.replica || this.closed || this.terminal)
      throw this.outdated ?? new Error("Engine is closed");
    return this.replica;
  }

  private prepare(name: string, raw: unknown): { args: unknown; id: string | null } {
    const args = normalizeArgs(name, raw);
    if (args === null || typeof args !== "object" || Array.isArray(args)) return { args, id: null };
    if (
      name === "create_issue" &&
      "input" in args &&
      args.input !== null &&
      typeof args.input === "object" &&
      !Array.isArray(args.input)
    ) {
      const input = args.input;
      const id = "id" in input ? input.id : this.deps.randomId();
      if (typeof id !== "string") throw new MutationError(400, "id must be a string");
      return { args: { ...args, input: { ...input, id } }, id };
    }
    if (!createsRecord(name)) return { args, id: null };
    const id = "id" in args ? args.id : this.deps.randomId();
    if (typeof id !== "string") throw new MutationError(400, "id must be a string");
    return {
      args: {
        ...args,
        id,
        ...(name === "create_team" && !("default_stage_ids" in args)
          ? { default_stage_ids: DEFAULT_STAGES.map(() => this.deps.randomId()) }
          : {}),
      },
      id,
    };
  }

  private active(controller: AbortController): boolean {
    return this.controller === controller && !controller.signal.aborted;
  }

  private check(controller: AbortController): void {
    if (!this.active(controller)) throw new Cancelled();
  }

  /**
   * After a leader change, a follower's unloaded scopes are asked again. The old leader may have
   * acknowledged them without loading them, and the new leader only loads its own holds.
   */
  private resendScopeRequests(): void {
    for (const [requestId, remote] of [...this.remote]) {
      if (remote.call.kind !== "loadScope") continue;
      this.remote.delete(requestId);
      remote.cancelResend();
    }
    for (const { scope } of this.heldScopes.values()) this.requestScope(scope);
  }

  /**
   * The leader loads the scope and sends its records as `pulled` messages with the scope set. A
   * leader that already holds the scope answers without a message, and the records come from the
   * database.
   */
  private askForScope(scope: Scope): void {
    const key = scopeKey(scope);
    if (!this.started || this.closed || this.loadedScopes.has(key)) return;
    for (const remote of this.remote.values())
      if (remote.call.kind === "loadScope" && scopeKey(remote.call.scope) === key) return;
    this.ask(
      { kind: "loadScope", scope },
      () => {
        this.adoptScope(scope).catch((error: unknown) => this.finishError(error));
      },
      (error) => {
        // A stopped or closed engine rejects its requests too, and that is not a scope failure.
        if (this.started && !this.closed && !this.terminal) this.failScope(key, error);
      },
    );
  }

  /** Applies a scope the leader answered for, unless a `pulled` message already loaded it. */
  private async adoptScope(scope: Scope): Promise<void> {
    const key = scopeKey(scope);
    await this.commits.run(async () => {
      if (this.loadedScopes.has(key)) return;
      const { loaded, records } = await this.requireReplica().loadScope(scope);
      // Not loaded means the leader's load is still running, so its `pulled` message will bring it.
      if (!loaded) return;
      this.loadedScopes.set(key, scope);
      this.scopeFailures.delete(key);
      this.store.batch(() => this.store.applyBase(this.scopeChanges(scope, records)));
      this.notifyScopes();
    });
  }

  private beginNetwork(): void {
    if (!this.started || !this.snapshot.online || this.controller || this.role !== "leader") return;
    const controller = new AbortController();
    this.controller = controller;
    void this.pull();
    this.requestPush();
    for (const { scope } of this.heldScopes.values()) this.requestScope(scope);
    void this.events(controller).catch((error: unknown) => this.finishError(error));
    void this.poll(controller).catch((error: unknown) => this.finishError(error));
  }

  private cancelNetwork(): void {
    this.controller?.abort();
    this.controller = null;
    this.pullAgain = false;
    this.update({ connected: false });
  }

  private async retry<T>(
    kind: RequestKind,
    controller: AbortController,
    work: () => Promise<T>,
  ): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      this.check(controller);
      if (this.blocked.has(kind)) throw new Cancelled();
      try {
        const result = await cancellable(work(), controller.signal);
        this.check(controller);
        return result;
      } catch (error) {
        this.check(controller);
        if (await this.handleError(error, kind)) throw new Cancelled();
        await pause(
          this.deps.clock,
          this.delay(attempt, error instanceof UnavailableError ? error.retryAfter : null),
          controller.signal,
        );
      }
    }
  }

  private async bootstrap(controller: AbortController): Promise<void> {
    this.update({ phase: "bootstrapping" });
    this.check(controller);
    const response = await cancellable(
      (async () => {
        const response = await this.deps.transport.bootstrap(this.deps.workspaceId, this.clientId, {
          signal: controller.signal,
        });
        const records: Partial<Record<Entity, object[]>> = {};
        for await (const { entity, record } of response.records)
          (records[entity] ??= []).push(this.prepareRecord(entity, record));
        return { header: response.header, records };
      })(),
      controller.signal,
    );
    await this.commits.run(async () => {
      this.check(controller);
      await this.requireReplica().writeBootstrap({
        cursor: response.header.cursor,
        lastMutationId: response.header.last_mutation_id,
        serverSchema: response.header.schema,
        records: response.records,
        entities: BOOTSTRAP_ENTITIES,
      });
      this.cursor = response.header.cursor;
      this.loadedScopes.clear();
      this.store.batch(() => {
        this.store.replaceBase(response.records, BOOTSTRAP_REPLACED_ENTITIES);
        this.acknowledge(response.header.last_mutation_id);
      });
      this.notifyScopes();
      this.post({ type: "reset" });
    });
    this.check(controller);
    this.update({ phase: "ready" });
    for (const { scope } of this.heldScopes.values()) this.requestScope(scope);
    this.requestPush();
  }

  private prepareRecord(entity: Entity, record: object): object {
    try {
      const prepared = ingest(entity, record);
      recordKey(entity, prepared);
      return prepared;
    } catch (cause) {
      throw new ProtocolError(`Invalid ${entity} record`, 200, { cause });
    }
  }

  private async pullPages(controller: AbortController): Promise<boolean> {
    if (this.cursor === null) {
      await this.retry("bootstrap", controller, () =>
        this.reads.run(() => this.bootstrap(controller)),
      );
      return false;
    }
    const response = await this.retry("pull", controller, () =>
      this.reads.run(() => this.readPull(controller)),
    );
    if (response.reset)
      await this.retry("bootstrap", controller, () =>
        this.reads.run(() => this.bootstrap(controller)),
      );
    this.check(controller);
    this.update({ phase: "ready" });
    return response.more;
  }

  /**
   * Aborts a request that outlives its deadline with a NetworkError, which callers back off from.
   * `extend` restarts the deadline, for a stream that proves it is alive.
   */
  private async withDeadline<T>(
    controller: AbortController,
    milliseconds: number,
    read: (signal: AbortSignal, extend: () => void) => Promise<T>,
  ): Promise<T> {
    const request = new AbortController();
    const timeout = new NetworkError("Request timed out");
    const abort = () => request.abort(controller.signal.reason);
    controller.signal.addEventListener("abort", abort, { once: true });
    if (controller.signal.aborted) abort();
    let cancel = () => {};
    const extend = () => {
      cancel();
      cancel = this.deps.clock.schedule(milliseconds, () => request.abort(timeout));
    };
    extend();
    try {
      return await cancellable(read(request.signal, extend), request.signal);
    } catch (error) {
      throw request.signal.reason === timeout ? timeout : error;
    } finally {
      cancel();
      controller.signal.removeEventListener("abort", abort);
    }
  }

  private async readPull(controller: AbortController): Promise<PullResponse> {
    this.check(controller);
    const cursor = this.cursor;
    const response = await this.withDeadline(controller, READ_DEADLINE_MS, (signal) =>
      this.deps.transport.pull(this.deps.workspaceId, this.clientId, cursor, { signal }),
    );
    this.check(controller);
    const changes = response.changes.map((change) => {
      const record =
        change.record === null ? null : this.prepareRecord(change.entity, change.record);
      if (record !== null && recordKey(change.entity, record) !== change.id)
        throw new ProtocolError("Change id does not match record key", 200);
      return { ...change, record };
    });
    if (response.reset) return response;
    await this.commits.run(async () => {
      this.check(controller);
      await this.requireReplica().applyPull({
        changes,
        cursor: response.cursor,
        acknowledgedUpTo: response.last_mutation_id,
      });
      const accepted = changes.filter((change) =>
        acceptsChange(
          change.entity,
          change.record ?? this.store.baseGet(change.entity, change.id),
          this.loadedScopes,
        ),
      );
      this.cursor = response.cursor;
      this.store.batch(() => {
        this.store.applyBase(accepted);
        if (response.last_mutation_id !== null) this.acknowledge(response.last_mutation_id);
      });
      this.recovered();
      this.post({
        type: "pulled",
        changes,
        cursor: response.cursor,
        acknowledgedUpTo: response.last_mutation_id,
      });
    });
    return response;
  }

  private acknowledge(id: number): void {
    this.acknowledged = Math.max(this.acknowledged, id);
    // An acknowledged mutation with no result seen may have been rejected, so keep it for a
    // confirmation push. The replica keeps it too, until `confirm`.
    for (const mutation of this.store.pending())
      if (
        mutation.id <= this.acknowledged &&
        !this.outcomes.has(mutation.id) &&
        !this.resulted.has(mutation.id)
      )
        this.unconfirmed.set(mutation.id, mutation);
    for (const resulted of this.resulted)
      if (resulted <= this.acknowledged) this.resulted.delete(resulted);
    this.store.setPending(
      this.store.pending().filter((mutation) => mutation.id > this.acknowledged),
    );
    for (const wake of this.ackWaiters) wake();
    this.notifyChange();
  }

  /**
   * Batches come from the database's outbox. Another tab may have appended mutations whose
   * messages were lost, and tabs without locks or a channel all push the same outbox. Each batch
   * then starts at the oldest unacknowledged id, and the server's per-client ordering turns any
   * overlap between tabs into duplicates instead of skipping a mutation.
   */
  private async reloadOutbox(): Promise<void> {
    const current = new Map(this.store.pending().map((mutation) => [mutation.id, mutation]));
    const stored = await this.requireReplica().loadOutbox();
    this.store.setPending(stored.map((mutation) => current.get(mutation.id) ?? mutation));
  }

  private pushCandidates(): Mutation[] {
    const confirmations = new Map<number, Mutation>(this.unconfirmed);
    for (const { mutation } of this.outcomes.values())
      if (mutation.id <= this.acknowledged) confirmations.set(mutation.id, mutation);
    return [...confirmations.values(), ...this.store.pending()].sort((a, b) => a.id - b.id);
  }

  private requestScope(scope: Scope): void {
    if (this.role === "follower") {
      this.askForScope(scope);
      return;
    }
    const controller = this.controller;
    const key = scopeKey(scope);
    if (
      !controller ||
      this.cursor === null ||
      this.loadedScopes.has(key) ||
      this.scopeWork.has(key) ||
      this.blocked.has("scope")
    )
      return;
    const work = this.retry("scope", controller, () =>
      this.reads.run(async () => {
        this.check(controller);
        if (this.loadedScopes.has(key)) return;
        await this.loadScope(scope, controller).catch((error: unknown) => {
          if (error instanceof ProtocolError) this.failScope(key, error);
          throw error;
        });
      }),
    ).catch((error: unknown) => this.finishError(error));
    this.scopeWork.set(key, work);
    void work.then(() => {
      this.scopeWork.delete(key);
      if (this.heldScopes.has(key)) this.requestScope(scope);
    });
  }

  private async loadScope(scope: Scope, controller: AbortController): Promise<void> {
    const response = await this.withDeadline(controller, READ_DEADLINE_MS, (signal) =>
      this.deps.transport.scope(this.deps.workspaceId, this.clientId, scope, { signal }),
    );
    const records = response.records.map((record) => this.prepareRecord(scope.entity, record));
    for (const record of records) {
      const receivedScope = recordScope(scope.entity, record);
      if (receivedScope === null || scopeKey(receivedScope) !== scopeKey(scope))
        throw new ProtocolError("Record does not belong to requested scope", 200);
    }
    await this.commits.run(async () => {
      this.check(controller);
      await this.requireReplica().writeScope({ scope, records });
      const changes = this.scopeChanges(scope, records);
      this.loadedScopes.set(scopeKey(scope), scope);
      this.scopeFailures.delete(scopeKey(scope));
      this.store.batch(() => this.store.applyBase(changes));
      this.post({
        type: "pulled",
        changes,
        cursor: this.cursor,
        acknowledgedUpTo: null,
        scope,
      });
      this.notifyScopes();
    });
  }

  /** Base changes that replace a scope's records with `records`: remove the old ones, then upsert. */
  private scopeChanges(scope: Scope, records: readonly object[]): Change[] {
    const scoped =
      scope.entity === "comments"
        ? this.store.baseByIndex("comments", "issue_id", scope.issueId)
        : this.store.baseByIndex("activity", "entity_id", scope.entityId);
    const removed = scoped.map((record) => ({
      entity: scope.entity,
      id: recordKey(scope.entity, record),
      record: null,
    }));
    const upserts = records.map((record) => ({
      entity: scope.entity,
      id: recordKey(scope.entity, record),
      record,
    }));
    return [...removed, ...upserts];
  }

  private failScope(key: string, error: Error): void {
    this.scopeFailures.set(key, error);
    this.notifyScopes();
  }

  private notifyScopes(): void {
    for (const wake of [...this.scopeWaiters]) wake();
    for (const listener of this.scopeListeners) listener();
  }

  private requestPush(): void {
    const controller = this.controller;
    if (
      !controller ||
      this.pushing ||
      this.blocked.has("push") ||
      (this.batch?.processed && (this.blocked.has("pull") || this.blocked.has("bootstrap")))
    )
      return;
    const work = this.push(controller).catch((error: unknown) => this.finishError(error));
    this.pushing = work;
    void work.then(() => {
      this.pushing = null;
      if (
        this.controller &&
        (this.controller !== controller || (!this.batch && this.pushCandidates().length > 0))
      )
        this.requestPush();
    });
  }

  private async push(controller: AbortController): Promise<void> {
    while (this.active(controller)) {
      this.batch ??= await this.nextBatch(controller);
      const batch = this.batch;
      if (!batch) return;
      this.check(controller);
      const wait = batch.retryAt - Date.parse(this.deps.clock.now());
      if (wait > 0) await pause(this.deps.clock, wait, controller.signal);
      if (!batch.processed) {
        const step = await this.sendBatch(batch, controller);
        if (step === "stop") return;
        if (step === "again") continue;
      }
      this.check(controller);
      if (this.blocked.has("pull") || this.blocked.has("bootstrap")) return;
      void this.pull();
      if (batch.mutations.some((mutation) => mutation.id > this.acknowledged)) {
        await this.waitForAcknowledgement(batch, controller);
        continue;
      }
      this.batch = null;
    }
  }

  private nextBatch(controller: AbortController): Promise<PushBatch | null> {
    return this.commits.run(async () => {
      this.check(controller);
      await this.reloadOutbox();
      const mutations = pushBatch(this.pushCandidates());
      if (mutations.length === 0) return null;
      return { mutations, processed: false, attempt: 0, retryAt: 0, csrfRefreshes: 0 };
    });
  }

  /** Sends one batch. "again" means send it again once `retryAt` passes; "stop" ends pushing. */
  private async sendBatch(
    batch: PushBatch,
    controller: AbortController,
  ): Promise<"sent" | "again" | "stop"> {
    try {
      const response = await this.withDeadline(controller, WRITE_DEADLINE_MS, (signal) =>
        this.deps.transport.push(this.deps.workspaceId, this.clientId, batch.mutations, {
          signal,
        }),
      );
      this.check(controller);
      const rejected = response.results.flatMap((result) => this.recordResult(result) ?? []);
      this.keepUnresolved(rejected);
      this.confirm(
        response.results.map((result) => result.id),
        rejected,
      );
      this.recovered("push");
      void this.pull();
      if (response.status === "partial") {
        this.scheduleRetry(batch, response.retryAfter);
        return "again";
      }
      batch.processed = true;
      return "sent";
    } catch (error) {
      this.check(controller);
      return this.pushFailed(error, batch, controller);
    }
  }

  private async pushFailed(
    error: unknown,
    batch: PushBatch,
    controller: AbortController,
  ): Promise<"again" | "stop"> {
    if (error instanceof ProtocolError && error.status === 413 && batch.mutations.length > 1) {
      batch.mutations = batch.mutations.slice(0, Math.ceil(batch.mutations.length / 2));
      return "again";
    }
    if (error instanceof AccessError && error.status === 403)
      return this.pushForbidden(error, batch, controller);
    if (await this.handleError(error, "push")) return "stop";
    this.scheduleRetry(batch, error instanceof UnavailableError ? error.retryAfter : null);
    return "again";
  }

  /**
   * A first 403 may be a stale CSRF token: refresh it once and retry. A read confirms workspace
   * access either way; a second 403 with access intact blocks pushing.
   */
  private async pushForbidden(
    error: AccessError,
    batch: PushBatch,
    controller: AbortController,
  ): Promise<"again" | "stop"> {
    if (batch.csrfRefreshes === 0) await this.retry("push", controller, () => this.refreshCsrf());
    const read = await this.retry("pull", controller, () =>
      this.reads.run(() => this.readPull(controller)),
    );
    if (read.reset || read.more) void this.pull();
    if (batch.csrfRefreshes++ === 0) return "again";
    await this.handleError(
      new ProtocolError("Push forbidden after CSRF refresh", 403, { cause: error }),
      "push",
    );
    return "stop";
  }

  private scheduleRetry(batch: PushBatch, retryAfter?: number | string | null): void {
    batch.retryAt = Date.parse(this.deps.clock.now()) + this.delay(batch.attempt++, retryAfter);
  }

  /** A forbidden /api/me means the refresh itself failed, which no retry fixes. */
  private async refreshCsrf(): Promise<void> {
    try {
      await this.deps.transport.me();
    } catch (cause) {
      if (cause instanceof AccessError)
        throw new ProtocolError("CSRF refresh failed", cause.status, { cause });
      throw cause;
    }
  }

  private async waitForAcknowledgement(
    batch: PushBatch,
    controller: AbortController,
  ): Promise<void> {
    let wake = () => {};
    const work = new Promise<void>((resolve) => {
      wake = resolve;
    });
    this.ackWaiters.add(wake);
    const cancel = this.deps.clock.schedule(this.delay(batch.attempt++), wake);
    try {
      await cancellable(work, controller.signal);
    } finally {
      cancel();
      this.ackWaiters.delete(wake);
    }
  }

  /**
   * The replica drops these from its outbox once acknowledged, since their results are known.
   * Queued before the pull that follows, so that pull's acknowledgement sees them confirmed.
   */
  private confirm(ids: readonly number[], rejected: readonly Rejection[]): void {
    if (ids.length === 0) return;
    this.commits
      .run(() => this.requireReplica().confirm(ids, rejected))
      .catch((error: unknown) => this.finishError(error));
  }

  /** Returns a rejection that kept its command, so the user can still recover the edit. */
  private recordResult(result: MutationResult): Rejection | null {
    const outcome: TabOutcome =
      result.status === "rejected"
        ? { id: result.id, status: result.error.status, message: result.error.message }
        : "applied";
    // The creating tab reports its own rejections. The leader reports the others that no tab
    // appended while it listened, since their creator may have closed.
    const reportOrphan = this.role === "leader" && !this.appendedIds.has(result.id);
    const rejection = this.settle(result.id, outcome, reportOrphan);
    if (result.id > this.acknowledged) this.resulted.add(result.id);
    this.unconfirmed.delete(result.id);
    this.appendedIds.delete(result.id);
    this.post({ type: "result", mutationId: result.id, outcome });
    return rejection?.command ? rejection : null;
  }

  private async events(controller: AbortController): Promise<void> {
    let attempt = 0;
    while (this.active(controller) && !this.blocked.has("events")) {
      let retryAfter: number | string | null = null;
      try {
        await this.withDeadline(controller, STREAM_IDLE_MS, (signal, extend) =>
          this.listen(controller, signal, () => {
            extend();
            attempt = 0;
          }),
        );
        this.check(controller);
      } catch (error) {
        this.check(controller);
        if (await this.handleError(error, "events")) return;
        if (error instanceof UnavailableError) retryAfter = error.retryAfter;
      }
      this.update({ connected: false });
      await pause(this.deps.clock, this.delay(attempt++, retryAfter), controller.signal);
    }
  }

  /** Reads one event stream until it ends. Every poke or keep-alive calls `alive`. */
  private async listen(
    controller: AbortController,
    signal: AbortSignal,
    alive: () => void,
  ): Promise<void> {
    const stream = await this.deps.transport.events(this.deps.workspaceId, this.clientId, {
      signal,
    });
    if (signal.aborted) return;
    this.check(controller);
    this.update({ connected: true });
    this.recovered();
    for await (const message of stream) {
      if (signal.aborted) return;
      this.check(controller);
      alive();
      if (message.event === "poke") void this.pull();
    }
  }

  private async poll(controller: AbortController): Promise<void> {
    while (this.active(controller)) {
      await pause(this.deps.clock, 30_000, controller.signal);
      if (!this.snapshot.connected) void this.pull();
    }
  }

  private async handleError(error: unknown, kind: RequestKind): Promise<boolean> {
    const failure = error instanceof Error ? error : new Error(String(error));
    this.writeFailing = kind === "push";
    this.update({ lastError: failure });
    this.emit({ type: "error", error: failure });
    if (failure instanceof UnauthorizedError || failure instanceof AccessError) {
      const ending = failure instanceof UnauthorizedError ? "unauthorized" : "accessLost";
      // Followers hear first, so they stop before the replica they read is deleted.
      this.post({ type: ending });
      this.endSession(failure);
      await this.commits.run(async () => {
        this.replica?.close();
        this.replica = null;
        if (failure instanceof UnauthorizedError) {
          for (const identity of await this.deps.storage.list())
            if (identity.sessionId === this.deps.sessionId)
              await this.deps.storage.delete(identity);
        } else
          await this.deps.storage.delete({
            sessionId: this.deps.sessionId,
            workspaceId: this.deps.workspaceId,
          });
        this.clearView();
        this.update({ phase: "loading" });
        this.emit({ type: ending });
      });
      return true;
    }
    if (failure instanceof ProtocolError) {
      this.blocked.add(kind);
      this.update({ blocked: this.outboxBlocked() });
      if (this.role === "leader") this.post(this.statusMessage());
      if (kind === "events") this.update({ connected: false });
      return true;
    }
    return false;
  }

  /**
   * A request succeeded, so an earlier error no longer describes the connection. Blocks stay. A
   * failing push stays reported until a push succeeds, since reads can't drain the outbox.
   */
  private recovered(kind: "read" | "push" = "read"): void {
    if (this.writeFailing && kind !== "push") return;
    this.writeFailing = false;
    const error = this.snapshot.lastError;
    if (error && !(error instanceof ProtocolError || error instanceof OutdatedError))
      this.update({ lastError: null });
  }

  private finishError(error: unknown): void {
    if (error instanceof Cancelled || this.terminal) return;
    const failure = error instanceof Error ? error : new Error(String(error));
    this.update({ lastError: failure });
    this.emit({ type: "error", error: failure });
  }
}
