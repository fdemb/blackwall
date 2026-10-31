import { createEngine, OutdatedError, SCHEMA, type SyncEngine } from "../sync/engine";
import type { EngineDependencies, EngineSignals, TabChannel, TabLocks } from "../sync/engine-types";
import { createTransport, AccessError, UnauthorizedError, ProtocolError } from "../sync/transport";
import {
  activeWorkspaceEngine,
  closeAllWorkspaceEngines,
  currentSession,
  reclaimWorkspaceEngine,
  replicaStorage,
  retireWorkspaceEngine,
  setWorkspaceEngine,
  expireSession,
  discardWorkspaceEngine,
} from "./session-replicas";
import { currentProfile, clearLastWs } from "./auth-guard";
import { firstLoad } from "./first-load";
import { queryClient } from "./query-client";

export function browserTabDependencies(browser: {
  locks?: TabLocks;
  BroadcastChannel?: new (name: string) => TabChannel;
}): Pick<EngineDependencies, "locks" | "channel"> {
  const { locks, BroadcastChannel: Channel } = browser;
  if (!locks || !Channel) return {};
  return {
    locks: { request: (name, callback) => locks.request(name, callback) },
    channel: (name) => new Channel(name),
  };
}

let persistenceRequested = false;
/** Asks once per page load. The browser may prompt, and the engine never waits for its answer. */
function requestPersistence(): Promise<boolean> | undefined {
  if (persistenceRequested) return undefined;
  persistenceRequested = true;
  return navigator.storage?.persist?.();
}

const signals: EngineSignals = {
  getOnline: () => navigator.onLine,
  getVisible: () => document.visibilityState === "visible",
  subscribe(listener) {
    const online = () => listener("online");
    const offline = () => listener("offline");
    const focus = () => listener("focus");
    const visibility = () =>
      listener(document.visibilityState === "visible" ? "visible" : "hidden");
    const resume = () => listener("resume");
    const show = (event: PageTransitionEvent) => {
      if (event.persisted) listener("resume");
    };
    window.addEventListener("online", online);
    window.addEventListener("offline", offline);
    window.addEventListener("focus", focus);
    window.addEventListener("pageshow", show);
    document.addEventListener("visibilitychange", visibility);
    document.addEventListener("resume", resume);
    return () => {
      window.removeEventListener("online", online);
      window.removeEventListener("offline", offline);
      window.removeEventListener("focus", focus);
      window.removeEventListener("pageshow", show);
      document.removeEventListener("visibilitychange", visibility);
      document.removeEventListener("resume", resume);
    };
  },
};

export function waitUntilReady(engine: SyncEngine, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = (error?: Error) => {
      firstLoad.set(null);
      unsubscribeStatus();
      unsubscribeEvents();
      signal?.removeEventListener("abort", aborted);
      if (error) reject(error);
      else resolve();
    };
    const check = () => {
      const status = engine.status.get();
      firstLoad.set(status.progress);
      if (status.phase === "ready") finish();
      // The engine retries a protocol error by itself, so only a blocked one ends the wait.
      else if (
        (status.blocked && status.lastError instanceof ProtocolError) ||
        status.lastError instanceof OutdatedError
      )
        finish(status.lastError);
      // 401s kept coming while the session is valid, so signing in again wouldn't help.
      else if (status.blocked && status.lastError instanceof UnauthorizedError)
        finish(new ProtocolError(status.lastError.message, 401));
    };
    const aborted = () => finish(new Error("Workspace navigation cancelled"));
    const unsubscribeStatus = engine.status.subscribe(check);
    const unsubscribeEvents = engine.subscribe((event) => {
      // An ended session closes the engine. A 401 alone may come from a proxy and is checked first.
      if (event.type === "closed") finish(new UnauthorizedError("Session ended", 401));
      if (event.type === "accessLost") finish(new AccessError("Workspace access lost", 403));
      if (event.type === "outdated") finish(new OutdatedError());
    });
    signal?.addEventListener("abort", aborted, { once: true });
    if (signal?.aborted) aborted();
    else check();
  });
}

/**
 * Keeps an engine while its workspace screen is mounted. Unmounting retires it. Opening another
 * workspace does not, so an aborted navigation leaves this engine working.
 */
export function attachWorkspaceEngine(engine: SyncEngine): () => void {
  reclaimWorkspaceEngine((entry) => entry.engine === engine);
  return () => retireWorkspaceEngine(engine);
}

let opening: Promise<unknown> = Promise.resolve();
export function openWorkspaceEngine(
  workspaceId: string,
  signal?: AbortSignal,
): Promise<SyncEngine> {
  const next = opening.then(async () => {
    const profile = currentSession() ?? (await currentProfile());
    if (!profile) throw new UnauthorizedError("Session expired", 401);
    const previous = activeWorkspaceEngine(workspaceId);
    if (previous?.sessionId === profile.session_id) {
      await waitUntilReady(previous.engine, signal);
      return previous.engine;
    }
    if (previous) retireWorkspaceEngine(previous.engine);
    const returning = reclaimWorkspaceEngine(
      (entry) => entry.workspaceId === workspaceId && entry.sessionId === profile.session_id,
    );
    if (returning) {
      await waitUntilReady(returning.engine, signal);
      return returning.engine;
    }
    if (signal?.aborted) throw new Error("Workspace navigation cancelled");
    const engine = createEngine({
      ...browserTabDependencies({
        locks: navigator.locks,
        BroadcastChannel: globalThis.BroadcastChannel,
      }),
      storage: replicaStorage(),
      transport: createTransport({
        fetch: globalThis.fetch.bind(globalThis),
        userId: profile.id,
      }),
      workspaceId,
      actor: profile.id,
      schema: SCHEMA,
      randomId: () => crypto.randomUUID(),
      signals,
      requestPersistence,
      pokeJitterMs: 200,
      clock: {
        now: () => new Date().toISOString(),
        monotonic: () => performance.now(),
        schedule: (ms, run) => {
          const timer = setTimeout(run, ms);
          return () => clearTimeout(timer);
        },
      },
    });
    setWorkspaceEngine({ workspaceId, sessionId: profile.session_id, engine });
    engine.subscribe((event) => {
      if (event.type === "unauthorized") {
        void expireSession().then((ended) => {
          if (!ended) {
            engine.resume();
            return;
          }
          queryClient.clear();
          window.location.assign("/login");
        });
      } else if (event.type === "accessLost") {
        clearLastWs();
        void closeAllWorkspaceEngines().then(() => window.location.assign("/"));
      }
    });
    try {
      await engine.open();
      await engine.start();
      await waitUntilReady(engine, signal);
      return engine;
    } catch (error) {
      await discardWorkspaceEngine(engine);
      throw error;
    }
  });
  opening = next.catch(() => undefined);
  return next;
}
