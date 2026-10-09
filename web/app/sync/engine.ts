import { admit, createReplay, MutationError, normalizeArgs, ONLINE_ONLY } from "./mutators";
import { DEFAULT_STAGES } from "./mutators/planning";
import { acceptsChange, recordKey, recordScope, scopeKey } from "./persistence/shared";
import type { Replica, Scope } from "./persistence/types";
import { BOOTSTRAP_ENTITIES, BOOTSTRAP_REPLACED_ENTITIES } from "./records";
import type { Entity } from "./records";
import { immutableCopy, ingest, SyncStore } from "./store";
import { AccessError, ProtocolError, UnauthorizedError, UnavailableError } from "./transport";
import type { Mutation, MutationResult, PullResponse } from "./transport";
import { backoff, Cancelled, cancellable, pause, SerialQueue } from "./engine-scheduling";
import type {
  EngineDependencies,
  EngineEvent,
  EngineStatus,
  MutationReceipt,
  Rejection,
  ScopeStatus,
} from "./engine-types";

export type {
  EngineClock,
  EngineDependencies,
  EngineEvent,
  EngineSignal,
  EngineSignals,
  EngineStatus,
  MutationReceipt,
  Rejection,
  ScopeStatus,
} from "./engine-types";

export const SCHEMA = 1;
type RequestKind = "bootstrap" | "pull" | "scope" | "push" | "events";
type OnlineJob = {
  name: string;
  args: unknown;
  resolve: (result: MutationResult) => void;
  reject: (error: Error) => void;
  settled: boolean;
};
type PushBatch = {
  mutations: readonly Mutation[];
  job: OnlineJob | null;
  processed: boolean;
  attempt: number;
  retryAt: number;
  csrfRefreshes: number;
};

/** One replica. Only start/stop controls leadership and network ownership. */
export function createEngine(deps: EngineDependencies): SyncEngine {
  return new SyncEngine(deps);
}

export class SyncEngine {
  readonly store: SyncStore;
  readonly status: { get: () => EngineStatus; subscribe: (listener: () => void) => () => void };
  private snapshot: EngineStatus;
  private readonly statusListeners = new Set<() => void>();
  private readonly eventListeners = new Set<(event: EngineEvent) => void>();
  private readonly reads = new SerialQueue();
  private readonly commits = new SerialQueue();
  private readonly loadedScopes = new Map<string, Scope>();
  private readonly heldScopes = new Map<string, { scope: Scope; holders: number }>();
  private readonly scopeWork = new Map<string, Promise<void>>();
  private readonly scopeFailures = new Map<string, Error>();
  private readonly scopeListeners = new Set<() => void>();
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
  private readonly onlineJobs: OnlineJob[] = [];
  private readonly delay: ReturnType<typeof backoff>;
  private replica: Replica | null = null;
  private opening: Promise<void> | null = null;
  private closed = false;
  private terminal = false;
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

  constructor(private readonly deps: EngineDependencies) {
    this.store = new SyncStore(createReplay(deps.actor));
    this.delay = backoff(`${deps.sessionId}:${deps.workspaceId}`, deps.clock);
    this.snapshot = Object.freeze({
      phase: "loading",
      online: deps.signals.getOnline(),
      connected: false,
      pending: 0,
      lastError: null,
      rejected: Object.freeze([]),
    });
    this.status = {
      get: () => this.snapshot,
      subscribe: (listener) => {
        this.statusListeners.add(listener);
        return () => this.statusListeners.delete(listener);
      },
    };
    this.store.subscribe((event) => {
      if (event.pendingChanged) this.update({ pending: this.store.pending().length });
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
    if (this.closed || this.terminal) return Promise.reject(new Error("Engine is closed"));
    this.opening ??= this.commits.run(async () => {
      const replica = await this.deps.storage.open({
        sessionId: this.deps.sessionId,
        workspaceId: this.deps.workspaceId,
        schema: this.deps.schema,
      });
      this.replica = replica;
      let loaded = await replica.load();
      if (loaded.meta.schema !== this.deps.schema) {
        await replica.resetBase();
        loaded = await replica.load();
      }
      this.clientId = loaded.meta.clientId;
      this.cursor = loaded.meta.cursor;
      this.acknowledged = loaded.meta.lastMutationId;
      for (const scope of loaded.scopes) this.loadedScopes.set(scopeKey(scope), scope);
      this.store.batch(() => {
        this.store.replaceBase(loaded.records, BOOTSTRAP_REPLACED_ENTITIES);
        this.store.setPending(loaded.outbox);
      });
      this.update({ phase: this.cursor === null ? "bootstrapping" : "ready" });
      if (!this.closed && !this.terminal) {
        this.unsubscribeSignals = this.deps.signals.subscribe((signal) => {
          if (signal === "offline") {
            this.update({ online: false });
            this.cancelNetwork();
          } else if (signal === "online") {
            this.update({ online: true });
            this.beginNetwork();
            void this.pull();
          } else void this.pull();
        });
        this.update({ online: this.deps.signals.getOnline() });
      }
    });
    return this.opening;
  }

  async start(): Promise<void> {
    const lifecycle = this.lifecycle;
    await this.open();
    if (this.started || this.closed || this.terminal || lifecycle !== this.lifecycle) return;
    this.started = true;
    this.update({ online: this.deps.signals.getOnline() });
    this.beginNetwork();
  }

  stop(): void {
    this.started = false;
    this.lifecycle += 1;
    this.cancelNetwork();
    this.rejectCallers(new Error(this.closed ? "Engine is closed" : "Engine is stopped"));
  }

  private rejectCallers(error: Error): void {
    for (const outcome of this.outcomes.values()) outcome.reject(error);
    this.outcomes.clear();
    for (const job of this.onlineJobs.splice(0)) job.reject(error);
    this.batch?.job?.reject(error);
  }

  isClosed(): boolean {
    return this.closed;
  }

  async close(): Promise<void> {
    const first = !this.closed;
    this.closed = true;
    if (first) this.emit({ type: "closed" });
    this.stop();
    this.unsubscribeSignals?.();
    this.unsubscribeSignals = null;
    this.notifyChange();
    await this.commits.drain();
    this.replica?.close();
    this.replica = null;
    this.rejectCallers(new Error("Engine is closed"));
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
      this.requestPush();
      return { id: prepared.id, mutationId: mutation.id, settled };
    });
  }

  async runOnline(name: string, args: unknown): Promise<MutationResult> {
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
    this.requireReplica();
    if (this.blocked.has("push")) throw this.snapshot.lastError ?? new Error("Push is blocked");
    return new Promise((resolve, reject) => {
      const finish = () => {
        if (job.settled) return false;
        job.settled = true;
        const index = this.onlineJobs.indexOf(job);
        if (index !== -1) this.onlineJobs.splice(index, 1);
        return true;
      };
      const job: OnlineJob = {
        name,
        args: immutableCopy(prepared.args),
        settled: false,
        resolve: (result) => {
          if (finish()) resolve(result);
        },
        reject: (error) => {
          if (finish()) reject(error);
        },
      };
      this.onlineJobs.push(job);
      this.requestPush();
    });
  }

  useScope(scope: Scope): () => void {
    if (this.closed || this.terminal) throw new Error("Engine is closed");
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

  private update(patch: Partial<EngineStatus>): void {
    if (Object.entries(patch).every(([key, value]) => Reflect.get(this.snapshot, key) === value))
      return;
    this.snapshot = Object.freeze({ ...this.snapshot, ...patch });
    for (const listener of this.statusListeners) listener();
  }

  private emit(event: EngineEvent): void {
    for (const listener of this.eventListeners) listener(event);
  }

  private requireReplica(): Replica {
    if (!this.replica || this.closed || this.terminal) throw new Error("Engine is closed");
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
    if (
      ![
        "create_team",
        "create_stage",
        "create_label",
        "create_project",
        "create_milestone",
        "create_sprint",
        "add_comment",
        "log_time",
        "save_view",
        "create_integration",
      ].includes(name)
    )
      return { args, id: null };
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

  private beginNetwork(): void {
    if (!this.started || !this.snapshot.online || this.controller) return;
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

  private async readPull(controller: AbortController): Promise<PullResponse> {
    this.check(controller);
    const response = await cancellable(
      this.deps.transport.pull(this.deps.workspaceId, this.clientId, this.cursor, {
        signal: controller.signal,
      }),
      controller.signal,
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
    });
    return response;
  }

  private acknowledge(id: number): void {
    this.acknowledged = Math.max(this.acknowledged, id);
    this.store.setPending(
      this.store.pending().filter((mutation) => mutation.id > this.acknowledged),
    );
    for (const wake of this.ackWaiters) wake();
    this.notifyChange();
  }

  private pushCandidates(): Mutation[] {
    const confirmations = [...this.outcomes.values()]
      .map((outcome) => outcome.mutation)
      .filter((mutation) => mutation.id <= this.acknowledged);
    return [...confirmations, ...this.store.pending()].sort((a, b) => a.id - b.id);
  }

  private requestScope(scope: Scope): void {
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
    const response = await cancellable(
      this.deps.transport.scope(this.deps.workspaceId, this.clientId, scope, {
        signal: controller.signal,
      }),
      controller.signal,
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
      const key = scopeKey(scope);
      const changes = this.store
        .baseAll(scope.entity)
        .filter((record) => {
          const current = recordScope(scope.entity, record);
          return current !== null && scopeKey(current) === key;
        })
        .map((record) => ({
          entity: scope.entity,
          id: recordKey(scope.entity, record),
          record: null,
        }));
      this.loadedScopes.set(key, scope);
      this.scopeFailures.delete(key);
      this.store.batch(() => {
        this.store.applyBase(changes);
        this.store.applyBase(
          records.map((record) => ({
            entity: scope.entity,
            id: recordKey(scope.entity, record),
            record,
          })),
        );
      });
      this.notifyScopes();
    });
  }

  private failScope(key: string, error: Error): void {
    this.scopeFailures.set(key, error);
    this.notifyScopes();
  }

  private notifyScopes(): void {
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
        (this.controller !== controller ||
          (!this.batch && (this.pushCandidates().length > 0 || this.onlineJobs.length > 0)))
      )
        this.requestPush();
    });
  }

  private async push(controller: AbortController): Promise<void> {
    while (this.active(controller)) {
      let allocationRefused = false;
      if (!this.batch) {
        this.batch = await this.commits.run(async () => {
          this.check(controller);
          const mutations = this.pushCandidates().slice(0, 100);
          if (mutations.length)
            return {
              mutations,
              job: null,
              processed: false,
              attempt: 0,
              retryAt: 0,
              csrfRefreshes: 0,
            };
          const job = this.onlineJobs[0];
          if (!job) return null;
          const id = await this.requireReplica().allocateMutationIdIfOutboxEmpty();
          if (id === null) {
            allocationRefused = true;
            const loaded = await this.requireReplica().load();
            this.store.setPending(loaded.outbox);
            return null;
          }
          return {
            mutations: [{ id, name: job.name, args: job.args, at: this.deps.clock.now() }],
            job,
            processed: false,
            attempt: 0,
            retryAt: 0,
            csrfRefreshes: 0,
          };
        });
      }
      const batch = this.batch;
      if (!batch) {
        if (!this.onlineJobs.length) return;
        if (allocationRefused) {
          await pause(this.deps.clock, 1000, controller.signal);
          void this.pull();
        }
        continue;
      }
      this.check(controller);
      if (batch.retryAt > Date.parse(this.deps.clock.now()))
        await pause(
          this.deps.clock,
          batch.retryAt - Date.parse(this.deps.clock.now()),
          controller.signal,
        );
      if (!batch.processed) {
        try {
          const response = await cancellable(
            this.deps.transport.push(this.deps.workspaceId, this.clientId, batch.mutations, {
              signal: controller.signal,
            }),
            controller.signal,
          );
          this.check(controller);
          for (const result of response.results) this.recordResult(result, batch);
          if (response.status === "ok" && batch.job && !batch.job.settled)
            throw new ProtocolError("Push did not settle its online command", 200);
          void this.pull();
          if (response.status === "partial") {
            batch.retryAt =
              Date.parse(this.deps.clock.now()) + this.delay(batch.attempt++, response.retryAfter);
            continue;
          }
          batch.processed = true;
        } catch (error) {
          this.check(controller);
          if (error instanceof AccessError && error.status === 403) {
            if (batch.csrfRefreshes === 0)
              await this.retry("push", controller, async () => {
                try {
                  return await this.deps.transport.me();
                } catch (cause) {
                  if (cause instanceof AccessError)
                    throw new ProtocolError("CSRF refresh failed", cause.status, { cause });
                  throw cause;
                }
              });
            const read = await this.retry("pull", controller, () =>
              this.reads.run(() => this.readPull(controller)),
            );
            if (read.reset || read.more) void this.pull();
            if (batch.csrfRefreshes++ === 0) continue;
            await this.handleError(
              new ProtocolError("Push forbidden after CSRF refresh", 403, { cause: error }),
              "push",
            );
            return;
          }
          if (await this.handleError(error, "push")) return;
          batch.retryAt =
            Date.parse(this.deps.clock.now()) +
            this.delay(
              batch.attempt++,
              error instanceof UnavailableError ? error.retryAfter : null,
            );
          continue;
        }
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

  private recordResult(result: MutationResult, batch: PushBatch): void {
    if (result.status === "rejected") {
      const rejection = Object.freeze({ id: result.id, ...result.error });
      if (!this.reported.has(result.id)) {
        this.reported.add(result.id);
        this.update({ rejected: Object.freeze([...this.snapshot.rejected, rejection]) });
        this.emit({ type: "rejected", rejection });
      }
      this.outcomes.get(result.id)?.resolve(rejection);
    } else this.outcomes.get(result.id)?.resolve("applied");
    this.outcomes.delete(result.id);
    batch.job?.resolve(result);
  }

  private async events(controller: AbortController): Promise<void> {
    let attempt = 0;
    while (this.active(controller) && !this.blocked.has("events")) {
      let retryAfter: number | string | null = null;
      try {
        const stream = await cancellable(
          this.deps.transport.events(this.deps.workspaceId, this.clientId, {
            signal: controller.signal,
          }),
          controller.signal,
        );
        this.check(controller);
        this.update({ connected: true });
        for await (const _poke of stream) {
          this.check(controller);
          attempt = 0;
          void this.pull();
        }
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

  private async poll(controller: AbortController): Promise<void> {
    while (this.active(controller)) {
      await pause(this.deps.clock, 30_000, controller.signal);
      if (!this.snapshot.connected) void this.pull();
    }
  }

  private async handleError(error: unknown, kind: RequestKind): Promise<boolean> {
    const failure = error instanceof Error ? error : new Error(String(error));
    this.update({ lastError: failure });
    this.emit({ type: "error", error: failure });
    if (failure instanceof UnauthorizedError || failure instanceof AccessError) {
      this.terminal = true;
      this.rejectCallers(failure);
      this.stop();
      this.unsubscribeSignals?.();
      this.unsubscribeSignals = null;
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
        this.store.batch(() => {
          this.store.replaceBase({}, BOOTSTRAP_REPLACED_ENTITIES);
          this.store.setPending([]);
        });
        this.update({ phase: "loading" });
        this.emit({ type: failure instanceof UnauthorizedError ? "unauthorized" : "accessLost" });
      });
      return true;
    }
    if (failure instanceof ProtocolError) {
      this.blocked.add(kind);
      if (kind === "events") this.update({ connected: false });
      if (kind === "push") for (const job of [...this.onlineJobs]) job.reject(failure);
      return true;
    }
    return false;
  }

  private finishError(error: unknown): void {
    if (error instanceof Cancelled) return;
    const failure = error instanceof Error ? error : new Error(String(error));
    this.update({ lastError: failure });
    this.emit({ type: "error", error: failure });
  }
}
