import { IndexedDBReplicaStorage } from "../sync/persistence/idb";
import { SCHEMA } from "../sync/engine";
import type { SyncEngine } from "../sync/engine";
import type { SessionProfile } from "../sync/transport";

interface WorkspaceEngine {
  workspaceId: string;
  sessionId: string;
  engine: SyncEngine;
}

let storage: IndexedDBReplicaStorage | undefined;
let session: SessionProfile | null = null;
let active: WorkspaceEngine | null = null;
// Workspaces the user has left. Each keeps sending its outbox until it is empty, then closes.
const leaving = new Map<string, WorkspaceEngine>();

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
export function setWorkspaceEngine(next: WorkspaceEngine) {
  active = next;
}
/** Stops the active engine from taking edits. It closes after its outbox has been sent. */
export function retireActiveWorkspaceEngine() {
  const previous = active;
  if (!previous) return;
  active = null;
  leaving.set(previous.workspaceId, previous);
  void previous.engine.retire().then(() => {
    if (leaving.get(previous.workspaceId)?.engine === previous.engine)
      leaving.delete(previous.workspaceId);
  });
}
export function retireWorkspaceEngine(engine: SyncEngine) {
  if (active?.engine === engine) retireActiveWorkspaceEngine();
}
/** Closes one engine now. A failed open must not be reclaimed, so its retry starts fresh. */
export async function discardWorkspaceEngine(engine: SyncEngine) {
  if (active?.engine === engine) active = null;
  await engine.close();
}
/** Makes a retiring engine active again, when the user returns to its workspace. */
export function reclaimWorkspaceEngine(
  workspaceId: string,
  sessionId: string,
): WorkspaceEngine | null {
  const entry = leaving.get(workspaceId);
  if (!entry || entry.sessionId !== sessionId) return null;
  retireActiveWorkspaceEngine();
  leaving.delete(workspaceId);
  entry.engine.reclaim();
  active = entry;
  return entry;
}
export function reclaimEngine(engine: SyncEngine) {
  const entry = [...leaving.values()].find((item) => item.engine === engine);
  if (entry) reclaimWorkspaceEngine(entry.workspaceId, entry.sessionId);
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
/** Closes every engine now, active or retiring. Pending edits in their outboxes are lost. */
export async function closeWorkspaceEngine() {
  const engines = [active, ...leaving.values()];
  active = null;
  leaving.clear();
  await Promise.all(
    engines.map(async (entry) => {
      await entry?.engine.close();
    }),
  );
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
