import {
  admit,
  createReplay,
  createsRecord,
  MutationError,
  normalizeArgs,
  ONLINE_ONLY,
} from "./mutators";
import { DEFAULT_STAGES } from "./mutators/planning";
import {
  acceptsChange,
  recordKey,
  recordScope,
  scopeKey,
  StorageFullError,
} from "./persistence/shared";
import type { Replica, ReplicaCloseReason, Scope } from "./persistence/types";
import { BOOTSTRAP_ENTITIES, BOOTSTRAP_REPLACED_ENTITIES } from "./records";
import type { Change, Entity } from "./records";
import { immutableCopy, ingest, SyncStore } from "./store";
import type { PendingMutation } from "./store";
import {
  AccessError,
  AccountChangedError,
  NetworkError,
  ProtocolError,
  UnauthorizedError,
  UnavailableError,
} from "./transport";
import type { IssuedInvitation, Mutation, MutationResult, PullResponse } from "./transport";
import { backoff, Cancelled, cancellable, pause, Resync, SerialQueue } from "./engine-scheduling";
import type {
  EngineDependencies,
  EngineEvent,
  EngineRole,
  EngineStatus,
  MutationOutcome,
  MutationReceipt,
  Rejection,
  ScopeStatus,
  SkippedRecord,
  StorageState,
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
  SkippedRecord,
  StorageState,
  TabChannel,
  TabLocks,
} from "./engine-types";
export type { TabMessage } from "./tabs";

export const SCHEMA = 8;

export type OnlineResult = MutationResult & { invitation?: IssuedInvitation };
/** A refreshed CSRF token, retried at once, or a failure to retry after a backoff. */
type OnlineRetry = "refreshed" | { retryAfter: number | string | null };

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
/** Protocol failures in a row on one request kind before the engine stops retrying it. */
export const PROTOCOL_BLOCK_AFTER = 6;
/** A write the browser refused for space is retried this often, and on focus after the minimum. */
const STORAGE_RETRY_MS = 5 * 60_000;
const STORAGE_FOCUS_RETRY_MS = 60_000;
/** A skipped record is fetched again after this long, doubling per failed attempt to the cap. */
const REPAIR_BASE_MS = 30_000;
const REPAIR_CAP_MS = 30 * 60_000;
const repairDelay = (attempts: number) => Math.min(REPAIR_BASE_MS * 2 ** attempts, REPAIR_CAP_MS);
const STORAGE_FULL_EDIT =
  "There isn't enough storage space on this device to save this edit. Free some space and try again.";
/** The server caps mutations per push at 100 and request bodies at 6 MiB. */
const PUSH_MUTATIONS = 100;
const PUSH_BYTES = 4 * 1024 * 1024;
const encoder = new TextEncoder();
type RequestKind = "bootstrap" | "pull" | "scope" | "push" | "events";
/** The server keeps a client's 1,000 newest rejections, so older ones read back as duplicates. */
const REJECTIONS_KEPT = 1000;
/**
 * Server failures in a row on one batch before the engine reports a stall. Nothing is dropped for
 * them: a 5xx or a timeout says nothing about the mutation, so the push retries with capped backoff.
 */
const STALLED_AFTER = 3;
/** 401s in a row, each with the session checked and found valid, before retries stop. */
const UNAUTHORIZED_RETRIES = 3;
const TOO_LARGE = "This edit is too large to save.";
type PushBatch = {
  /** Halved after a 413, so a body the server refuses never blocks the outbox. */
  mutations: readonly Mutation[];
  processed: boolean;
  attempt: number;
  /** On the monotonic clock, so a wall-clock change can neither stall nor hurry the retry. */
  retryAt: number;
  csrfRefreshes: number;
  /** Server failures in a row on this batch. Network failures never count. */
  failures: number;
  /** Leading mutations a partial response already processed. */
  settled: number;
};
type PushFailure = "unreachable" | "server" | "too-large";

/** Null for errors that stop network work, lose access or block pushing instead of retrying. */
function pushFailure(error: unknown): PushFailure | null {
  if (error instanceof ProtocolError && error.status === 413) return "too-large";
  if (error instanceof UnavailableError) return "server";
  if (
    error instanceof UnauthorizedError ||
    error instanceof AccessError ||
    error instanceof ProtocolError
  )
    return null;
  return "unreachable";
}
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

/** The key a raw record would have, or a placeholder for the report when it has none. */
function recordId(entity: Entity, record: object): string {
  try {
    return recordKey(entity, record);
  } catch {
    return "(no id)";
  }
}

type ProtocolStep = "retry" | "resync" | "block";

/**
 * What a protocol failure does next, from how many came in a row on that request kind. A 403 that
 * survived a CSRF refresh, and a push's 409 `client state lost`, never improve by waiting, so they
 * block at once. A pull that keeps failing is re-bootstrapped once, when `resync` allows it,
 * before it blocks.
 */
function protocolStep(error: ProtocolError, failures: number, resync: boolean): ProtocolStep {
  if (error.status === 403 || error.status === 409) return "block";
  if (failures < PROTOCOL_BLOCK_AFTER) return "retry";
  return resync ? "resync" : "block";
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
      resolve: (result: MutationOutcome) => void;
      reject: (error: Error) => void;
    }
  >();
  private readonly ackWaiters = new Set<() => void>();
  private readonly changes = new Set<() => void>();
  private retirement: Promise<void> | null = null;
  private sealed = false;
  private readonly reported = new Set<number>();
  private readonly onlineCalls = new Set<AbortController>();
  /** Requests of online calls, which a 401 aborts without failing their calls. */
  private readonly onlineAttempts = new Set<AbortController>();
  private readonly delay: ReturnType<typeof backoff>;
  private replica: Replica | null = null;
  private opening: Promise<void> | null = null;
  private closed = false;
  private terminal = false;
  /**
   * A 401 stopped network work: "checking" until the app has checked the session, "refused" once
   * 401s kept coming with a valid session, until the user retries.
   */
  private unauthorized: "checking" | "refused" | null = null;
  /** 401s since the server last answered a pull or a push. */
  private unauthorizedStreak = 0;
  private cancelResume: (() => void) | null = null;
  private outdated: OutdatedError | null = null;
  private started = false;
  private lifecycle = 0;
  private controller: AbortController | null = null;
  private unsubscribeSignals: (() => void) | null = null;
  private clientId = "";
  private cursor: string | null = null;
  private acknowledged = 0;
  /** The replica's marker: access was denied and no read has succeeded since. */
  private accessUnverified = false;
  private pullAgain = false;
  private pulling: Promise<void> | null = null;
  private pushing: Promise<void> | null = null;
  private batch: PushBatch | null = null;
  /**
   * 413 rejections the disk had no room to keep. Nothing is pushed until they are saved, so no
   * acknowledgement can pass them and a reload can still find them in the outbox.
   */
  private readonly setAside = new Map<number, Rejection>();
  /** The last error came from a push, so only a push success clears it. */
  private writeFailing = false;
  private readonly protocolFailures = new Map<RequestKind, number>();
  /** A persistent pull protocol error already caused one re-bootstrap. */
  private resynced = false;
  private readonly skipped = new Map<string, SkippedRecord>();
  /** A pull page skipped a record, so a bootstrap is owed. Only a bootstrap clears it. */
  private resyncOwed = false;
  /** The repair timer ran, so the next pull is a bootstrap. */
  private resyncDue = false;
  private resyncAttempts = 0;
  private cancelResync: (() => void) | null = null;
  private readonly scopeRepairs = new Map<
    string,
    { scope: Scope; attempts: number; cancel: (() => void) | null }
  >();
  private serverSchema = 0;
  private cancelStorageRetry: (() => void) | null = null;
  private storageAttempt = Number.NEGATIVE_INFINITY;

  constructor(private readonly deps: EngineDependencies) {
    this.store = new SyncStore(createReplay(deps.actor));
    this.delay = backoff(`${deps.actor}:${deps.workspaceId}`, deps.clock);
    this.lockName = `blackwall-sync:${deps.actor}:${deps.workspaceId}`;
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
      stalled: false,
      lastError: null,
      rejected: Object.freeze([]),
      unresolved: Object.freeze([]),
      skipped: Object.freeze([]),
      storage: "ok",
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

  /**
   * Whether a scope is in the replica. A protocol error that blocks its loads reports "error". An
   * unloaded scope reports "offline" while the browser is, since nothing is loading it then.
   */
  scopeStatus(scope: Scope): ScopeStatus {
    const key = scopeKey(scope);
    if (this.loadedScopes.has(key)) return "loaded";
    if (this.scopeFailures.has(key)) return "error";
    return this.deps.signals.getOnline() ? "loading" : "offline";
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
        userId: this.deps.actor,
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
      if (loaded.meta.cursor === null) this.requestPersistence();
      this.update({ phase: this.openPhase() });
      if (!this.closed && !this.terminal) {
        this.unsubscribeSignals = this.deps.signals.subscribe((signal) => {
          if (signal === "offline") {
            this.update({ online: false });
            this.notifyChange();
            this.cancelNetwork();
          } else if (signal === "online") {
            this.update({ online: this.role === "leader" || this.leaderOnline });
            this.notifyChange();
            this.resyncAttempts = 0;
            this.beginNetwork();
            void this.pull();
          } else {
            void this.pull();
            this.retryStorageOnFocus();
          }
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

  /** A replica whose access was denied shows nothing as ready until a read succeeds. */
  private openPhase(): EngineStatus["phase"] {
    if (this.accessUnverified) return "loading";
    return this.cursor === null ? "bootstrapping" : "ready";
  }

  /** Replaces the in-memory replica with what the database holds. */
  private applyLoaded(loaded: LoadedReplica): void {
    this.clientId = loaded.meta.clientId;
    this.serverSchema = loaded.meta.serverSchema;
    this.cursor = loaded.meta.cursor;
    this.acknowledged = loaded.meta.lastMutationId;
    this.accessUnverified = loaded.meta.accessLost === true;
    this.resyncOwed = loaded.meta.resync === true;
    this.setSkipped(
      new Map(
        (loaded.meta.skipped ?? []).map((record) => [`${record.entity}:${record.id}`, record]),
      ),
    );
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
    if (this.snapshot.storage === "full" && this.role === "leader") this.scheduleStorageRetry();
    // A follower has no network work to begin, so its holds are requested here instead.
    if (this.role === "follower")
      for (const { scope } of this.heldScopes.values()) this.requestScope(scope);
  }

  stop(): void {
    this.started = false;
    this.lifecycle += 1;
    this.cancelNetwork();
    this.releaseLeadership();
    // An online call waiting out a 401 fails the way that 401 would have.
    if (this.unauthorized !== null) this.cancelOnline(new UnauthorizedError("Session ended", 401));
    this.rejectCallers(new Error(this.closed ? "Engine is closed" : "Engine is stopped"));
  }

  /**
   * The app checked the session after a 401 and it is still valid, so the 401 came from something
   * in between. Network work restarts after a backoff. When 401s keep coming, the engine reports
   * itself blocked instead, until the user retries.
   */
  resume(): void {
    if (this.closed || this.unauthorized !== "checking") return;
    if (this.terminal) {
      this.unauthorized = null;
      return;
    }
    if (this.unauthorizedStreak >= UNAUTHORIZED_RETRIES) {
      this.unauthorized = "refused";
      this.update({ blocked: true });
      this.post(this.statusMessage());
      return;
    }
    const wait = this.unauthorizedStreak === 0 ? 0 : this.delay(this.unauthorizedStreak - 1);
    this.cancelResume?.();
    this.cancelResume = this.deps.clock.schedule(wait, () => {
      this.cancelResume = null;
      if (this.closed || this.unauthorized !== "checking") return;
      this.unauthorized = null;
      this.notifyChange();
      this.beginNetwork();
    });
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
    this.cancelResume?.();
    this.cancelResume = null;
    this.stopStorageRetry();
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
    // The view now matches the database, so only an unsaved 413 rejection keeps the disk full.
    this.setStorage(this.setAside.size === 0 ? "ok" : "full");
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
      stalled: false,
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
      const mutation = await replica
        .appendMutation(() => ({
          name,
          args: admitted.args,
          at,
          ...(admitted.local === undefined ? {} : { local: admitted.local }),
        }))
        .catch((error: unknown) => {
          // The edit is refused whole and the caller shows this, so none is lost without a word.
          throw error instanceof StorageFullError
            ? new MutationError(507, STORAGE_FULL_EDIT)
            : error;
        });
      if (this.snapshot.storage === "full" && this.role === "leader") void this.retryStorage();
      const settled = new Promise<MutationOutcome>((resolve, reject) =>
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

  async runOnline(name: string, args: unknown): Promise<OnlineResult> {
    if (this.outdated) throw this.outdated;
    if (!this.deps.signals.getOnline())
      throw new MutationError(400, "This command requires an online connection");
    await this.open();
    if (this.sealed) throw new Error("Engine is retiring");
    this.refuseOnFullDisk();
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
  ): Promise<OnlineResult> {
    for (let attempt = 0, csrfRefreshes = 0; ; attempt++) {
      controller.signal.throwIfAborted();
      await this.drainOutbox(controller.signal);
      // A 401 aborts only this attempt. The next one waits in drainOutbox for the session check,
      // and resends with the same key.
      const request = new AbortController();
      const abort = () => request.abort(controller.signal.reason);
      controller.signal.addEventListener("abort", abort, { once: true });
      this.onlineAttempts.add(request);
      let next: OnlineResult | OnlineRetry;
      try {
        next = await this.attemptOnline(input, request, csrfRefreshes === 0);
      } catch (error) {
        controller.signal.throwIfAborted();
        if (request.signal.aborted) continue;
        throw error;
      } finally {
        controller.signal.removeEventListener("abort", abort);
        this.onlineAttempts.delete(request);
      }
      if (next === "refreshed") {
        csrfRefreshes++;
        continue;
      }
      if ("status" in next) return next;
      await pause(this.deps.clock, this.delay(attempt, next.retryAfter), controller.signal);
    }
  }

  private async attemptOnline(
    input: { command: object; idempotencyKey: string },
    controller: AbortController,
    canRefreshCsrf: boolean,
  ): Promise<OnlineResult | OnlineRetry> {
    try {
      const { result } = await this.withDeadline(controller, WRITE_DEADLINE_MS, (signal) =>
        this.deps.transport.command(this.deps.workspaceId, input, { signal }),
      );
      controller.signal.throwIfAborted();
      // The server pokes the leader's event stream, including when a follower sends this call.
      if (this.role === "leader") void this.pull();
      // Keep the callers' mutation-result shape without allocating a sync mutation id.
      return result.invitation
        ? { id: 0, status: "applied", invitation: result.invitation }
        : { id: 0, status: "applied" };
    } catch (caught) {
      controller.signal.throwIfAborted();
      return this.onlineFailure(caught, controller, canRefreshCsrf);
    }
  }

  /**
   * Online commands wait until earlier offline edits have been pushed, and while the app checks
   * the session after a 401. Once 401s kept coming with a valid session, they fail.
   */
  private async drainOutbox(signal: AbortSignal): Promise<void> {
    for (;;) {
      signal.throwIfAborted();
      this.refuseOnFullDisk();
      if (this.unauthorized === "refused") throw new UnauthorizedError("Session check failed", 401);
      if (this.started && this.snapshot.online && this.unauthorized === null) {
        const stored = await this.requireReplica().loadOutbox();
        // A full disk can leave acknowledged mutations stored after memory settled them.
        if (stored.every((mutation) => mutation.id <= this.acknowledged)) {
          // A 401 or close can land while the outbox loads; check again with no await before
          // the caller registers its attempt.
          signal.throwIfAborted();
          if (this.started && this.snapshot.online && this.unauthorized === null) return;
          continue;
        }
        if (this.role === "leader" ? this.outboxBlocked() : this.leaderBlocked)
          throw new Error("Pending changes can't be sent. Reload and try again.");
      }
      this.requestPush();
      await this.waitForOutboxChange(signal);
    }
  }

  /**
   * The outbox can't drain while the disk is full, since the leader stops announcing pull pages and
   * acknowledged rows stay stored, so an online command would wait for it forever.
   */
  private refuseOnFullDisk(): void {
    if (this.snapshot.storage === "full") throw new MutationError(507, STORAGE_FULL_EDIT);
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
  ): Promise<OnlineRetry> {
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
    if (refreshCsrf) await cancellable(this.refreshCsrf(controller.signal), controller.signal);
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
    this.protocolFailures.clear();
    this.resynced = false;
    this.resyncDue = this.resyncOwed;
    this.resyncAttempts = 0;
    this.scopeFailures.clear();
    this.batch = null;
    this.unauthorized = null;
    this.unauthorizedStreak = 0;
    this.update({ blocked: false, stalled: false, lastError: null });
    void this.retryStorage();
    this.post(this.statusMessage());
    this.notifyScopes();
    this.cancelNetwork();
    this.beginNetwork();
  }

  /** Only unblock() or a new engine clears these blocks; until then the outbox can't drain. */
  private outboxBlocked(): boolean {
    return (
      this.unauthorized === "refused" ||
      this.blocked.has("push") ||
      this.blocked.has("pull") ||
      this.blocked.has("bootstrap")
    );
  }

  private statusMessage(): TabBody {
    const error = this.snapshot.lastError;
    return {
      type: "status",
      connected: this.snapshot.connected,
      online: this.snapshot.online,
      blocked: this.outboxBlocked(),
      stalled: this.snapshot.stalled,
      storageFull: this.snapshot.storage === "full",
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
    // A scope that can't load while offline reports it, so its status changes with the connection.
    if ("online" in patch) this.notifyScopes();
    if (
      this.role === "leader" &&
      ("connected" in patch ||
        "online" in patch ||
        "stalled" in patch ||
        "lastError" in patch ||
        "storage" in patch)
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
      stalled: message.stalled,
      storage: message.storageFull ? "full" : "ok",
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
    this.accessUnverified = false;
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
    this.update({ phase: this.openPhase() });
    if (message.scope) this.notifyScopes();
  }

  /**
   * Another tab got 401 or lost access. A 401 stops this tab's network work until its own session
   * check. Lost access stops this tab for good, closes its handle and clears its view.
   */
  private receiveSessionEnd(ending: "unauthorized" | "accessLost"): void {
    if (ending === "unauthorized") this.suspend();
    else this.endLocal(ending, new AccessError("Workspace access ended in another tab", 403));
  }

  /**
   * A 401 stops network work and keeps the replica, the view and every receipt. A proxy can answer
   * 401 too, so the app checks the session, then calls `resume` or closes the engine.
   */
  private suspend(): void {
    if (this.closed || this.unauthorized !== null || (this.terminal && !this.outdated)) return;
    this.unauthorized = "checking";
    this.cancelNetwork();
    for (const attempt of this.onlineAttempts) attempt.abort(new Cancelled());
    this.emit({ type: "unauthorized" });
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
        this.update({ phase: this.openPhase() });
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
        if (this.loadedScopes.has(key)) {
          // A load that left records out isn't marked loaded on disk, so its records go out here.
          if (this.scopeRepairs.has(key) && this.snapshot.storage === "ok")
            this.post({
              type: "pulled",
              changes: this.scopeChanges(scope, this.scopedRecords(scope)),
              cursor: this.cursor,
              acknowledgedUpTo: null,
              scope,
            });
          reply = { ok: true, value: null };
        } else {
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
    if (outcome === "applied" || outcome === "unknown") {
      owned?.resolve(outcome);
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
    if (
      !this.started ||
      !this.snapshot.online ||
      this.controller ||
      this.role !== "leader" ||
      this.unauthorized !== null
    )
      return;
    const controller = new AbortController();
    this.controller = controller;
    void this.pull();
    this.requestPush();
    for (const { scope } of this.heldScopes.values()) this.requestScope(scope);
    this.scheduleResync(controller);
    for (const key of this.scopeRepairs.keys()) this.scheduleScopeRepair(key, controller);
    void this.events(controller).catch((error: unknown) => this.finishError(error));
    void this.poll(controller).catch((error: unknown) => this.finishError(error));
  }

  private cancelNetwork(): void {
    this.controller?.abort();
    this.controller = null;
    this.pullAgain = false;
    this.cancelResync?.();
    this.cancelResync = null;
    for (const repair of this.scopeRepairs.values()) {
      repair.cancel?.();
      repair.cancel = null;
    }
    this.update({ connected: false });
  }

  /** With `resync`, a persistent protocol error throws `Resync` once instead of blocking. */
  private async retry<T>(
    kind: RequestKind,
    controller: AbortController,
    work: () => Promise<T>,
    resync = false,
  ): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      this.check(controller);
      if (this.blocked.has(kind)) throw new Cancelled();
      try {
        const result = await cancellable(work(), controller.signal);
        this.check(controller);
        this.succeeded(kind);
        return result;
      } catch (error) {
        this.check(controller);
        if (await this.handleError(error, kind, resync)) throw new Cancelled();
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
    // Every record is parsed again below, so the ones still unparseable are reported again.
    const previous = new Map(this.skipped);
    this.setSkipped(new Map());
    const response = await cancellable(
      (async () => {
        const response = await this.deps.transport.bootstrap(this.deps.workspaceId, this.clientId, {
          signal: controller.signal,
        });
        const records: Partial<Record<Entity, object[]>> = {};
        for await (const { entity, record } of response.records) {
          const prepared = this.prepareRecord(entity, record);
          if (prepared !== null) (records[entity] ??= []).push(prepared);
        }
        return { header: response.header, records };
      })(),
      controller.signal,
    )
      .then((downloaded) => {
        this.checkAcknowledged(downloaded.header.last_mutation_id);
        return downloaded;
      })
      .catch((error: unknown) => {
        this.setSkipped(previous);
        throw error;
      });
    await this.commits.run(async () => {
      this.check(controller);
      // A full disk keeps the downloaded workspace in memory instead of downloading it again.
      const persisted = await this.persist(
        () =>
          this.requireReplica().writeBootstrap({
            cursor: response.header.cursor,
            lastMutationId: response.header.last_mutation_id,
            serverSchema: response.header.schema,
            records: response.records,
            entities: BOOTSTRAP_ENTITIES,
            skipped: [...this.skipped.values()],
            resync: false,
          }),
        "snapshot",
      );
      if (persisted) await this.verified();
      this.cursor = response.header.cursor;
      this.serverSchema = response.header.schema;
      this.clearResync();
      this.loadedScopes.clear();
      this.store.batch(() => {
        this.store.replaceBase(response.records, BOOTSTRAP_REPLACED_ENTITIES);
        this.acknowledge(response.header.last_mutation_id);
      });
      this.notifyScopes();
      // Other tabs reload from the database, which holds nothing new when the write failed.
      if (persisted) this.post({ type: "reset" });
    });
    this.check(controller);
    this.update({ phase: "ready" });
    for (const { scope } of this.heldScopes.values()) this.requestScope(scope);
    this.requestPush();
  }

  /**
   * A bootstrap acknowledges and replaces everything, so no obligation is left, even when it
   * skipped a record again. That record is then malformed on the server, and stays listed.
   */
  private clearResync(): void {
    this.resyncOwed = false;
    this.resyncDue = false;
    this.resyncAttempts = 0;
    this.cancelResync?.();
    this.cancelResync = null;
    for (const repair of this.scopeRepairs.values()) repair.cancel?.();
    this.scopeRepairs.clear();
  }

  /**
   * Parses a server record, or returns null and reports it when this client can't. One bad record
   * is left out so the rest of its page loads. Without the workspace row the app can't render, so
   * that one stays a protocol error. `id` is the change's id, which the record's key must match.
   */
  private prepareRecord(entity: Entity, record: object, id?: string): object | null {
    try {
      const prepared = ingest(entity, record);
      const key = recordKey(entity, prepared);
      if (id !== undefined && key !== id) throw new Error("Change id does not match record key");
      this.unskip(entity, key);
      return prepared;
    } catch (cause) {
      if (entity === "workspace")
        throw new ProtocolError(`Invalid ${entity} record`, 200, { cause });
      this.skip(entity, id ?? recordId(entity, record), cause);
      return null;
    }
  }

  private skip(entity: Entity, id: string, cause: unknown): void {
    const message = cause instanceof Error ? cause.message : String(cause);
    console.error(`Skipped invalid ${entity} record ${id}`, cause);
    this.setSkipped(new Map(this.skipped).set(`${entity}:${id}`, { entity, id, message }));
  }

  /** A valid version, or a deletion, of a skipped record ends its report. */
  private unskip(entity: Entity, id: string): void {
    if (!this.skipped.has(`${entity}:${id}`)) return;
    const next = new Map(this.skipped);
    next.delete(`${entity}:${id}`);
    this.setSkipped(next);
  }

  private setSkipped(next: Map<string, SkippedRecord>): void {
    if (next.size === 0 && this.skipped.size === 0) return;
    this.skipped.clear();
    for (const [key, value] of next) this.skipped.set(key, value);
    this.update({ skipped: Object.freeze([...next.values()]) });
  }

  /**
   * One timer at a time. It makes the next pull a bootstrap, with a delay that doubles per failed
   * attempt, from 30 seconds to 30 minutes.
   */
  private scheduleResync(controller: AbortController): void {
    if (!this.resyncOwed || this.cancelResync) return;
    this.cancelResync = this.deps.clock.schedule(repairDelay(this.resyncAttempts), () => {
      this.cancelResync = null;
      if (!this.active(controller)) return;
      this.resyncDue = true;
      void this.pull();
    });
  }

  /** One attempt at the owed bootstrap. A failure goes back on the repair schedule, not the retry loop. */
  private async repair(controller: AbortController): Promise<void> {
    try {
      await cancellable(
        this.reads.run(() => this.bootstrap(controller)),
        controller.signal,
      );
      this.check(controller);
      this.succeeded("bootstrap");
    } catch (error) {
      this.check(controller);
      if (await this.handleError(error, "bootstrap")) throw new Cancelled();
      this.resyncDue = false;
      this.resyncAttempts += 1;
      this.update({ phase: "ready" });
      this.scheduleResync(controller);
    }
  }

  /** A scope that loaded with a skipped record is loaded again later, on the same backoff. */
  private scheduleScopeRepair(key: string, controller: AbortController): void {
    const repair = this.scopeRepairs.get(key);
    if (!repair || repair.cancel) return;
    repair.cancel = this.deps.clock.schedule(repairDelay(repair.attempts), () => {
      repair.cancel = null;
      if (!this.active(controller) || this.scopeRepairs.get(key) !== repair) return;
      repair.attempts += 1;
      this.retry("scope", controller, () =>
        this.reads.run(async () => {
          this.check(controller);
          await this.loadScope(repair.scope, controller);
        }),
      ).catch((error: unknown) => this.finishError(error));
    });
  }

  /** `repair` false leaves a due bootstrap to the next pull, for a caller that decides on this answer. */
  private async pullPages(controller: AbortController, repair = true): Promise<boolean> {
    if (this.cursor === null) {
      await this.retry("bootstrap", controller, () =>
        this.reads.run(() => this.bootstrap(controller)),
      );
      return false;
    }
    if (this.resyncDue && repair) {
      await this.repair(controller);
      return false;
    }
    let response: PullResponse | "resync";
    try {
      response = await this.retry(
        "pull",
        controller,
        () => this.reads.run(() => this.readPull(controller)),
        !this.resynced,
      );
    } catch (error) {
      if (!(error instanceof Resync)) throw error;
      response = "resync";
    }
    if (response === "resync" || response.reset) {
      this.resynced = response === "resync";
      await this.retry("bootstrap", controller, () =>
        this.reads.run(() => this.bootstrap(controller)),
      );
    }
    this.check(controller);
    this.update({ phase: "ready" });
    return response !== "resync" && response.more;
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
    this.checkAcknowledged(response.last_mutation_id);
    if (response.reset) return response;
    const changes: Change[] = [];
    let pageSkipped = false;
    for (const change of response.changes) {
      if (change.record === null) {
        this.unskip(change.entity, change.id);
        changes.push(change);
        continue;
      }
      // A skipped change leaves the previous version in place until a bootstrap replaces it.
      const record = this.prepareRecord(change.entity, change.record, change.id);
      if (record === null) pageSkipped = true;
      else changes.push({ ...change, record });
    }
    if (pageSkipped) {
      this.resyncOwed = true;
      this.scheduleResync(controller);
    }
    await this.commits.run(async () => {
      this.check(controller);
      // Once a write has failed for space, the database waits for a full snapshot instead.
      const persisted = await this.persist(
        () =>
          this.requireReplica().applyPull({
            changes,
            cursor: response.cursor,
            acknowledgedUpTo: response.last_mutation_id,
            skipped: [...this.skipped.values()],
            resync: this.resyncOwed,
          }),
        "increment",
      );
      if (persisted) await this.verified();
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
      // Followers only see what the database holds. Until a snapshot lands they may be behind,
      // and its reset catches them up.
      if (persisted)
        this.post({
          type: "pulled",
          changes,
          cursor: response.cursor,
          acknowledgedUpTo: response.last_mutation_id,
        });
    });
    return response;
  }

  /**
   * The server never forgets a client's high-water mark now, so an answer below what this replica
   * already holds means a database restore or a bug. Pushing again would run mutations a second
   * time, so pushing stops until unblock(), and the state is loud instead of silently kept.
   */
  private checkAcknowledged(id: number | null): void {
    if (id === null || id >= this.acknowledged) return;
    this.blocked.add("push");
    // Pushing stops now, not after the read's retries run out.
    this.update({ blocked: true });
    if (this.role === "leader") this.post(this.statusMessage());
    throw new ProtocolError(
      `The server acknowledged mutation ${id}, but this replica already holds ${this.acknowledged}`,
      200,
    );
  }

  /** A read succeeded, so the access that was denied is back. */
  private async verified(): Promise<void> {
    if (!this.accessUnverified) return;
    await this.requireReplica().setAccessLost(false);
    this.accessUnverified = false;
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
    // A full disk can leave acknowledged mutations in the database that memory already settled.
    this.store.setPending(
      stored
        .filter((mutation) => mutation.id > this.acknowledged)
        .map((mutation) => current.get(mutation.id) ?? mutation),
    );
  }

  private pushCandidates(): Mutation[] {
    if (this.setAside.size > 0) return [];
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
    let protocolError: ProtocolError | null = null;
    const work = this.retry("scope", controller, () =>
      this.reads.run(async () => {
        this.check(controller);
        if (this.loadedScopes.has(key)) return;
        await this.loadScope(scope, controller).catch((error: unknown) => {
          if (error instanceof ProtocolError) protocolError = error;
          throw error;
        });
      }),
    ).catch((error: unknown) => {
      // The scope reports an error once its protocol failures have blocked it, not while they retry.
      if (protocolError && this.blocked.has("scope")) this.failScope(key, protocolError);
      this.finishError(error);
    });
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
    const records: object[] = [];
    let skippedHere = false;
    for (const raw of response.records) {
      const record = this.prepareRecord(scope.entity, raw);
      if (record === null) {
        skippedHere = true;
        continue;
      }
      const receivedScope = recordScope(scope.entity, record);
      if (receivedScope !== null && scopeKey(receivedScope) === scopeKey(scope)) {
        records.push(record);
        continue;
      }
      skippedHere = true;
      this.skip(
        scope.entity,
        recordId(scope.entity, record),
        new Error("Record does not belong to requested scope"),
      );
    }
    await this.commits.run(async () => {
      this.check(controller);
      const persisted = await this.persist(
        () => this.requireReplica().writeScope({ scope, records, partial: skippedHere }),
        "increment",
      );
      if (persisted) await this.verified();
      const changes = this.scopeChanges(scope, records);
      this.loadedScopes.set(scopeKey(scope), scope);
      this.scopeFailures.delete(scopeKey(scope));
      this.store.batch(() => this.store.applyBase(changes));
      if (persisted)
        this.post({
          type: "pulled",
          changes,
          cursor: this.cursor,
          acknowledgedUpTo: null,
          scope,
        });
      this.notifyScopes();
      const key = scopeKey(scope);
      if (skippedHere) {
        this.scopeRepairs.set(
          key,
          this.scopeRepairs.get(key) ?? { scope, attempts: 0, cancel: null },
        );
        this.scheduleScopeRepair(key, controller);
      } else {
        this.scopeRepairs.get(key)?.cancel?.();
        this.scopeRepairs.delete(key);
      }
    });
  }

  /** Base changes that replace a scope's records with `records`: remove the old ones, then upsert. */
  private scopeChanges(scope: Scope, records: readonly object[]): Change[] {
    const removed = this.scopedRecords(scope).map((record) => ({
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

  private scopedRecords(scope: Scope): readonly object[] {
    return scope.entity === "comments"
      ? this.store.baseByIndex("comments", "issue_id", scope.issueId)
      : this.store.baseByIndex("activity", "entity_id", scope.entityId);
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
      if (this.blocked.has("push")) return;
      this.batch ??= await this.nextBatch(controller);
      const batch = this.batch;
      if (!batch) return;
      this.check(controller);
      const wait = batch.retryAt - this.deps.clock.monotonic();
      if (wait > 0) await pause(this.deps.clock, wait, controller.signal);
      // A block can arrive while the batch was chosen or the retry delay ran.
      if (this.blocked.has("push")) return;
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
      return {
        mutations,
        processed: false,
        attempt: 0,
        retryAt: 0,
        csrfRefreshes: 0,
        failures: 0,
        settled: 0,
      };
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
          acknowledged: this.acknowledged,
        }),
      );
      this.check(controller);
      const rejected = response.results.flatMap(
        (result) => this.recordResult(result, response.lastMutationId) ?? [],
      );
      this.keepUnresolved(rejected);
      this.confirm(
        response.results.map((result) => result.id),
        rejected,
      );
      this.recovered("push");
      this.protocolFailures.delete("push");
      void this.pull();
      if (response.status === "partial") {
        if (response.results.length > batch.settled) {
          batch.settled = response.results.length;
          batch.failures = 0;
          this.update({ stalled: false });
        }
        return this.failPush("server", response.retryAfter, batch);
      }
      this.update({ stalled: false });
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
    if (error instanceof AccessError && error.status === 403)
      return this.pushForbidden(error, batch, controller);
    const failure = pushFailure(error);
    if (failure !== "too-large" && (await this.handleError(error, "push"))) return "stop";
    const retryAfter = error instanceof UnavailableError ? error.retryAfter : null;
    if (failure !== "too-large") return this.failPush(failure ?? "unreachable", retryAfter, batch);
    if (batch.mutations.length > 1) {
      batch.mutations = batch.mutations.slice(0, Math.ceil(batch.mutations.length / 2));
      return "again";
    }
    return this.setAsideTooLarge(batch.mutations[0], controller);
  }

  /**
   * Retries a failed attempt after a capped backoff. A server failure or a timeout never discards
   * an edit, because it can't say whether the command ran or what it would have done.
   */
  private failPush(
    failure: "unreachable" | "server",
    retryAfter: number | string | null | undefined,
    batch: PushBatch,
  ): "again" {
    if (failure === "server") {
      batch.failures += 1;
      if (batch.failures >= STALLED_AFTER) this.update({ stalled: true });
    } else this.update({ stalled: false });
    batch.retryAt = this.deps.clock.monotonic() + this.delay(batch.attempt++, retryAfter);
    return "again";
  }

  /**
   * A 413 means the request never reached a command, so a single mutation the server refuses by
   * size can never be sent. Reads first, to a final page or a finished bootstrap, because an
   * earlier push of it may have succeeded with its response lost: then the server holds its
   * outcome, and only the confirmation is too large. An acknowledgement is only final on the last
   * page, so a probe that returned `more` or `reset` decides nothing.
   */
  private async setAsideTooLarge(
    mutation: Mutation | undefined,
    controller: AbortController,
  ): Promise<"again" | "stop"> {
    this.batch = null;
    if (mutation === undefined) return "again";
    for (let more = true; more;) more = await this.pullPages(controller, false);
    const { id } = mutation;
    if (id <= this.acknowledged) {
      this.settle(id, "unknown", false);
      this.unconfirmed.delete(id);
      this.confirm([id], []);
      this.appendedIds.delete(id);
      this.post({ type: "result", mutationId: id, outcome: "unknown" });
      return "again";
    }
    this.setAside.set(
      id,
      Object.freeze({
        id,
        status: 413,
        message: TOO_LARGE,
        command: { name: mutation.name, args: immutableCopy(mutation.args) },
      }),
    );
    await this.commits.run(() => this.storeSetAside());
    return "again";
  }

  /**
   * Keeps the set-aside rejections and drops their mutations from the outbox. Their receipts
   * settle only then, so a rejection the user sees is one a reload still shows. On a full disk they
   * wait for the storage retry, and pushing resumes once they are saved. Runs inside `commits`.
   */
  private async storeSetAside(): Promise<boolean> {
    const rejections = [...this.setAside.values()];
    if (rejections.length === 0) return true;
    try {
      await this.requireReplica().discard(rejections);
    } catch (error) {
      if (!(error instanceof StorageFullError)) throw error;
      this.setStorage("full");
      return false;
    }
    for (const rejection of rejections) {
      const { id, status, message } = rejection;
      const outcome = { id, status, message };
      this.setAside.delete(id);
      this.unconfirmed.delete(id);
      this.settle(id, outcome, true);
      this.appendedIds.delete(id);
      this.store.setPending(this.store.pending().filter((pending) => pending.id !== id));
      this.keepUnresolved([rejection]);
      this.post({ type: "result", mutationId: id, outcome });
    }
    this.post({ type: "reset" });
    this.requestPush();
    return true;
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
    if (batch.csrfRefreshes === 0)
      await this.retry("push", controller, () => this.refreshCsrf(controller.signal));
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

  /**
   * A forbidden /api/me means the refresh itself failed, which no retry fixes. Closing or
   * suspending the engine aborts `signal`, so a late answer can't replace a newer session's token.
   */
  private async refreshCsrf(signal: AbortSignal): Promise<void> {
    try {
      await this.deps.transport.me({ signal });
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
      .catch((error: unknown) => {
        // The row stays unconfirmed on disk, which only costs a repeat push after a reload.
        if (error instanceof StorageFullError) this.setStorage("full");
        else this.finishError(error);
      });
  }

  /** Returns a rejection that kept its command, so the user can still recover the edit. */
  private recordResult(result: MutationResult, lastMutationId: number): Rejection | null {
    // A duplicate this far behind may be a pruned rejection, not an applied edit.
    const outcome: TabOutcome =
      result.status === "rejected"
        ? { id: result.id, status: result.error.status, message: result.error.message }
        : result.status === "duplicate" && lastMutationId - result.id >= REJECTIONS_KEPT
          ? "unknown"
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
      let proven = false;
      try {
        await this.withDeadline(controller, STREAM_IDLE_MS, (signal, extend) =>
          this.listen(controller, signal, () => {
            extend();
            attempt = 0;
            // An open stream proves nothing: a malformed body only fails once it is read.
            if (proven) return;
            proven = true;
            this.recovered("other");
            this.protocolFailures.delete("events");
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

  private async handleError(error: unknown, kind: RequestKind, resync = false): Promise<boolean> {
    const failure = error instanceof Error ? error : new Error(String(error));
    this.writeFailing = kind === "push";
    this.update({ lastError: failure });
    this.emit({ type: "error", error: failure });
    if (failure instanceof UnauthorizedError && !(failure instanceof AccountChangedError)) {
      if (this.unauthorized === null) {
        this.unauthorizedStreak += 1;
        // Every tab stops its network work, and each checks the session for itself.
        this.post({ type: "unauthorized" });
        this.suspend();
      }
      return true;
    }
    // A changed account means the replica isn't the signed-in user's, so this engine ends.
    if (failure instanceof AccountChangedError || failure instanceof AccessError) {
      const ending = failure instanceof AccessError ? "accessLost" : "unauthorized";
      this.post({ type: ending });
      this.endSession(failure);
      // The replica stays on disk with its outbox. The same user's next sign-in, or access
      // returning, continues from it, and the server's answers decide what happens to each edit.
      await this.commits.run(async () => {
        if (failure instanceof AccessError)
          // The cached base may predate the removal, so the next open verifies before it shows it.
          // A replica deleted from outside has nothing left to mark.
          await this.replica?.setAccessLost(true).catch(() => undefined);
        this.replica?.close();
        this.replica = null;
        this.clearView();
        this.update({ phase: "loading" });
        this.emit({ type: ending });
      });
      return true;
    }
    if (failure instanceof ProtocolError) {
      const failures = (this.protocolFailures.get(kind) ?? 0) + 1;
      this.protocolFailures.set(kind, failures);
      const step = protocolStep(failure, failures, resync);
      if (step === "retry") return false;
      if (step === "resync") {
        this.protocolFailures.delete(kind);
        throw new Resync();
      }
      this.blocked.add(kind);
      this.update({ blocked: this.outboxBlocked() });
      if (this.role === "leader") this.post(this.statusMessage());
      if (kind === "events") this.update({ connected: false });
      return true;
    }
    return false;
  }

  /**
   * A request succeeded, so an earlier error no longer describes the connection. Blocks stay, and
   * so does the protocol error that explains one. A failing push stays reported until a push
   * succeeds, since reads can't drain the outbox.
   */
  private recovered(kind: "read" | "push" | "other" = "read"): void {
    // Only an answered pull or push proves that they get past whatever answered 401.
    if (kind !== "other") this.unauthorizedStreak = 0;
    if (this.writeFailing && kind !== "push") return;
    this.writeFailing = false;
    const error = this.snapshot.lastError;
    const kept =
      error instanceof ProtocolError ? this.blocked.size > 0 : error instanceof OutdatedError;
    if (error && !kept) this.update({ lastError: null });
  }

  /** A request of this kind worked, so earlier protocol failures no longer count against it. */
  private succeeded(kind: RequestKind): void {
    this.protocolFailures.delete(kind);
    if (kind === "pull") this.resynced = false;
    this.recovered("other");
  }

  /**
   * Runs a database write. A "snapshot" leaves the database equal to memory. An "increment" builds
   * on the database as it was, so it is skipped once an earlier write failed for space, since
   * applying it would leave the database ahead of what it holds. Both report whether it happened.
   */
  private async persist(
    write: () => Promise<void>,
    kind: "snapshot" | "increment",
  ): Promise<boolean> {
    if (kind === "increment" && this.snapshot.storage === "full") return false;
    try {
      await write();
    } catch (error) {
      if (!(error instanceof StorageFullError)) throw error;
      this.setStorage("full");
      return false;
    }
    if (kind === "snapshot" && (await this.storeSetAside())) this.setStorage("ok");
    return true;
  }

  private setStorage(storage: StorageState): void {
    if (storage === "full") this.scheduleStorageRetry();
    else this.stopStorageRetry();
    if (this.snapshot.storage === storage) return;
    this.update({ storage });
    if (storage === "full") this.emit({ type: "error", error: new StorageFullError() });
  }

  /** One timer at a time, so repeated failures can't keep pushing the retry back. */
  private scheduleStorageRetry(): void {
    if (this.cancelStorageRetry || this.closed || this.terminal) return;
    this.cancelStorageRetry = this.deps.clock.schedule(STORAGE_RETRY_MS, () => {
      this.cancelStorageRetry = null;
      void this.retryStorage();
    });
  }

  private stopStorageRetry(): void {
    this.cancelStorageRetry?.();
    this.cancelStorageRetry = null;
  }

  private retryStorageOnFocus(): void {
    if (this.deps.clock.monotonic() - this.storageAttempt >= STORAGE_FOCUS_RETRY_MS)
      void this.retryStorage();
  }

  /**
   * Writes everything memory holds as one snapshot, which brings the database level again. The
   * loaded scopes follow, since a snapshot clears them from disk.
   */
  private async retryStorage(): Promise<void> {
    if (this.snapshot.storage !== "full" || this.role !== "leader" || !this.started) return;
    this.storageAttempt = this.deps.clock.monotonic();
    try {
      await this.commits.run(async () => {
        if (this.snapshot.storage !== "full") return;
        if (this.cursor === null) {
          if (await this.storeSetAside()) this.setStorage("ok");
          return;
        }
        const records: Partial<Record<Entity, readonly object[]>> = {};
        for (const entity of BOOTSTRAP_ENTITIES) records[entity] = this.store.baseAll(entity);
        const saved = await this.persist(
          () =>
            this.requireReplica().writeBootstrap({
              cursor: this.cursor ?? "",
              lastMutationId: this.acknowledged,
              serverSchema: this.serverSchema,
              records,
              entities: BOOTSTRAP_ENTITIES,
              skipped: [...this.skipped.values()],
              resync: this.resyncOwed,
            }),
          "snapshot",
        );
        if (!saved) return;
        for (const [key, scope] of this.loadedScopes) {
          const scoped = this.store.baseAll(scope.entity).filter((record) => {
            const found = recordScope(scope.entity, record);
            return found !== null && scopeKey(found) === scopeKey(scope);
          });
          const written = await this.persist(
            () =>
              this.requireReplica().writeScope({
                scope,
                records: scoped,
                partial: this.scopeRepairs.has(key),
              }),
            "snapshot",
          );
          if (!written) return;
        }
        // Followers missed every page and scope since the disk filled, so they reload from it.
        this.post({ type: "reset" });
      });
    } catch (error) {
      this.finishError(error);
      if (this.snapshot.storage === "full") this.scheduleStorageRetry();
    }
  }

  /** Asks the browser to keep this origin's data, so it isn't evicted under storage pressure. */
  private requestPersistence(): void {
    try {
      void Promise.resolve(this.deps.requestPersistence?.()).catch(() => undefined);
    } catch {
      // A browser without the storage API is no reason to stop syncing.
    }
  }

  private finishError(error: unknown): void {
    if (error instanceof Cancelled || this.terminal) return;
    const failure = error instanceof Error ? error : new Error(String(error));
    this.update({ lastError: failure });
    this.emit({ type: "error", error: failure });
  }
}
