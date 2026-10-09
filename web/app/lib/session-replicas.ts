import { IndexedDBReplicaStorage } from "../sync/persistence/idb";
import { SCHEMA } from "../sync/engine";
import type { SyncEngine } from "../sync/engine";
import type { SessionProfile } from "../sync/transport";

const lifetimes = new WeakMap<SyncEngine, AbortController>();
export function workspaceEngineSignal(engine: SyncEngine): AbortSignal {
  let lifetime = lifetimes.get(engine);
  if (!lifetime) {
    lifetime = new AbortController();
    lifetimes.set(engine, lifetime);
  }
  return lifetime.signal;
}

let storage: IndexedDBReplicaStorage | undefined;
let session: SessionProfile | null = null;
let active: { workspaceId: string; sessionId: string; engine: SyncEngine } | null = null;

export function replicaStorage() {
  storage ??= new IndexedDBReplicaStorage();
  return storage;
}
export function currentSession() {
  return session;
}
export async function acceptSession(profile: SessionProfile) {
  if (session?.session_id !== profile.session_id) await closeWorkspaceEngine();
  await replicaStorage().deleteAllExcept(profile.session_id);
  session = profile;
  return profile;
}
export function activeWorkspaceEngine() {
  return active;
}
export function setWorkspaceEngine(next: NonNullable<typeof active>) {
  workspaceEngineSignal(next.engine);
  active = next;
}
export async function closeWorkspaceEngine() {
  const previous = active;
  active = null;
  if (previous) {
    lifetimes.get(previous.engine)?.abort();
    await previous.engine.close();
  }
}
export async function sessionHasPending(): Promise<boolean> {
  const sessionId = session?.session_id;
  if (!sessionId) return false;
  if (active?.engine.store.pending().length) return true;
  for (const identity of await replicaStorage().list()) {
    if (identity.sessionId !== sessionId || identity.workspaceId === active?.workspaceId) continue;
    const replica = await replicaStorage().open({ ...identity, schema: SCHEMA });
    try {
      if ((await replica.load()).outbox.length) return true;
    } finally {
      replica.close();
    }
  }
  return false;
}
export async function clearSession() {
  const sessionId = session?.session_id;
  await closeWorkspaceEngine();
  if (sessionId) {
    for (const identity of await replicaStorage().list()) {
      if (identity.sessionId === sessionId) await replicaStorage().delete(identity);
    }
  }
  if (!sessionId) await replicaStorage().deleteAllExcept(null);
  session = null;
}
