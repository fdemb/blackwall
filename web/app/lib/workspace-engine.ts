import { createEngine, SCHEMA, type SyncEngine } from "../sync/engine";
import type { EngineSignals } from "../sync/engine-types";
import { createTransport, AccessError, UnauthorizedError, ProtocolError } from "../sync/transport";
import {
  activeWorkspaceEngine,
  closeWorkspaceEngine,
  currentSession,
  replicaStorage,
  setWorkspaceEngine,
  clearSession,
} from "./session-replicas";
import { currentProfile, clearLastWs } from "./auth-guard";
import { queryClient } from "./query-client";

const signals: EngineSignals = {
  getOnline: () => navigator.onLine,
  subscribe(listener) {
    const online = () => listener("online");
    const offline = () => listener("offline");
    const focus = () => listener("focus");
    const visible = () => {
      if (document.visibilityState === "visible") listener("visible");
    };
    window.addEventListener("online", online);
    window.addEventListener("offline", offline);
    window.addEventListener("focus", focus);
    document.addEventListener("visibilitychange", visible);
    return () => {
      window.removeEventListener("online", online);
      window.removeEventListener("offline", offline);
      window.removeEventListener("focus", focus);
      document.removeEventListener("visibilitychange", visible);
    };
  },
};

export function waitUntilReady(engine: SyncEngine, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = (error?: Error) => {
      unsubscribeStatus();
      unsubscribeEvents();
      signal?.removeEventListener("abort", aborted);
      if (error) reject(error);
      else resolve();
    };
    const check = () => {
      const status = engine.status.get();
      if (status.phase === "ready") finish();
      else if (status.lastError instanceof ProtocolError) finish(status.lastError);
    };
    const aborted = () => finish(new Error("Workspace navigation cancelled"));
    const unsubscribeStatus = engine.status.subscribe(check);
    const unsubscribeEvents = engine.subscribe((event) => {
      if (event.type === "unauthorized") finish(new UnauthorizedError("Session expired", 401));
      if (event.type === "accessLost") finish(new AccessError("Workspace access lost", 403));
    });
    signal?.addEventListener("abort", aborted, { once: true });
    if (signal?.aborted) aborted();
    else check();
  });
}

let opening: Promise<unknown> = Promise.resolve();
export function openWorkspaceEngine(
  workspaceId: string,
  signal?: AbortSignal,
): Promise<SyncEngine> {
  const next = opening.then(async () => {
    const profile = currentSession() ?? (await currentProfile());
    if (!profile) throw new UnauthorizedError("Session expired", 401);
    const previous = activeWorkspaceEngine();
    if (previous?.workspaceId === workspaceId && previous.sessionId === profile.session_id) {
      await waitUntilReady(previous.engine, signal);
      return previous.engine;
    }
    await closeWorkspaceEngine();
    if (signal?.aborted) throw new Error("Workspace navigation cancelled");
    const engine = createEngine({
      storage: replicaStorage(),
      transport: createTransport({ fetch: globalThis.fetch.bind(globalThis) }),
      sessionId: profile.session_id,
      workspaceId,
      actor: profile.id,
      schema: SCHEMA,
      randomId: () => crypto.randomUUID(),
      signals,
      clock: {
        now: () => new Date().toISOString(),
        schedule: (ms, run) => {
          const timer = setTimeout(run, ms);
          return () => clearTimeout(timer);
        },
      },
    });
    setWorkspaceEngine({ workspaceId, sessionId: profile.session_id, engine });
    engine.subscribe((event) => {
      if (event.type === "unauthorized") {
        void clearSession().then(() => {
          queryClient.clear();
          window.location.assign("/login");
        });
      } else if (event.type === "accessLost") {
        clearLastWs();
        void closeWorkspaceEngine().then(() => window.location.assign("/"));
      }
    });
    try {
      await engine.open();
      // Tab leader election comes later; every tab starts its own network workers for now.
      await engine.start();
      await waitUntilReady(engine, signal);
      return engine;
    } catch (error) {
      if (activeWorkspaceEngine()?.engine === engine) await closeWorkspaceEngine();
      throw error;
    }
  });
  opening = next.catch(() => undefined);
  return next;
}
