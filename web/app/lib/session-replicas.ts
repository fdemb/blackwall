import { IndexedDBReplicaStorage } from "../sync/persistence/idb";
import { SCHEMA } from "../sync/engine";
import type { SyncEngine } from "../sync/engine";
import type { SessionProfile } from "../sync/transport";
import type { WorkspaceSummary } from "./types";
import { safeGet, safeRemove, safeSet } from "./storage";

interface WorkspaceEngine {
  workspaceId: string;
  sessionId: string;
  engine: SyncEngine;
}

// The last session and workspace list the server confirmed, so a reload can open replicas offline.
const SESSION_KEY = "bw-session:v1";
const WORKSPACES_KEY = "bw-workspaces:v2";

let storage: IndexedDBReplicaStorage | undefined;
let session: SessionProfile | null = null;
// Engines that take edits, one per workspace. Opening another workspace leaves these open.
const active = new Map<string, WorkspaceEngine>();
// Engines whose screen unmounted. Each keeps sending its outbox until it is empty, then closes.
const leaving = new Set<WorkspaceEngine>();

export function replicaStorage() {
  storage ??= new IndexedDBReplicaStorage();
  return storage;
}
export function currentSession() {
  return session;
}
export async function acceptSession(profile: SessionProfile) {
  if (session?.session_id !== profile.session_id) await closeAllWorkspaceEngines();
  await replicaStorage().deleteAllExcept(profile.session_id);
  session = profile;
  safeSet("local", SESSION_KEY, JSON.stringify(profile));
  return profile;
}
/** Resumes the last confirmed session without asking the server. Other replicas stay. */
export function restoreSession(): SessionProfile | null {
  session ??= read<SessionProfile>(SESSION_KEY);
  return session;
}
export function rememberWorkspaces(list: WorkspaceSummary[]) {
  if (session)
    safeSet("local", WORKSPACES_KEY, JSON.stringify({ sessionId: session.session_id, list }));
}
export function rememberedWorkspaces(): WorkspaceSummary[] | null {
  const saved = read<{ sessionId: string; list: WorkspaceSummary[] }>(WORKSPACES_KEY);
  return saved && saved.sessionId === session?.session_id ? saved.list : null;
}
function read<T>(key: string): T | null {
  try {
    return JSON.parse(safeGet("local", key) ?? "null") as T | null;
  } catch {
    return null;
  }
}
export function activeWorkspaceEngine(workspaceId: string) {
  return active.get(workspaceId) ?? null;
}
export function setWorkspaceEngine(next: WorkspaceEngine) {
  active.set(next.workspaceId, next);
}
function activeEntry(engine: SyncEngine) {
  return [...active.values()].find((entry) => entry.engine === engine);
}
/** Stops an engine from taking edits; it closes after its outbox is sent. */
export function retireWorkspaceEngine(engine: SyncEngine) {
  const entry = activeEntry(engine);
  if (!entry) return;
  active.delete(entry.workspaceId);
  leaving.add(entry);
  void entry.engine.retire().then(() => leaving.delete(entry));
}
/** Makes a retiring engine active again. */
export function reclaimWorkspaceEngine(
  match: (entry: WorkspaceEngine) => boolean,
): WorkspaceEngine | null {
  // A closing engine is still in `leaving` until its close finishes.
  const entry = [...leaving].find((candidate) => !candidate.engine.isClosed() && match(candidate));
  if (!entry) return null;
  leaving.delete(entry);
  active.set(entry.workspaceId, entry);
  entry.engine.reclaim();
  return entry;
}
/** Closes one engine now. A failed open must not be reclaimed, so its retry starts fresh. */
export async function discardWorkspaceEngine(engine: SyncEngine) {
  const entry = activeEntry(engine);
  if (entry) active.delete(entry.workspaceId);
  await engine.close();
}
export async function sessionHasPending(): Promise<boolean> {
  const sessionId = session?.session_id;
  if (!sessionId) return false;
  for (const entry of active.values()) if (entry.engine.store.pending().length) return true;
  for (const identity of await replicaStorage().list()) {
    if (identity.sessionId !== sessionId || active.has(identity.workspaceId)) continue;
    const replica = await replicaStorage().open({ ...identity, schema: SCHEMA });
    try {
      if ((await replica.load()).outbox.length) return true;
    } finally {
      replica.close();
    }
  }
  return false;
}
/**
 * Closes every engine now, active or retiring. Pending edits stay in their outboxes on disk and are
 * sent the next time their replica opens.
 */
export async function closeAllWorkspaceEngines() {
  const engines = [...active.values(), ...leaving];
  active.clear();
  leaving.clear();
  await Promise.all(engines.map((entry) => entry.engine.close()));
}
export async function clearSession() {
  const sessionId = session?.session_id;
  await closeAllWorkspaceEngines();
  if (sessionId) {
    for (const identity of await replicaStorage().list()) {
      if (identity.sessionId === sessionId) await replicaStorage().delete(identity);
    }
  }
  if (!sessionId) await replicaStorage().deleteAllExcept(null);
  session = null;
  safeRemove("local", SESSION_KEY);
  safeRemove("local", WORKSPACES_KEY);
}
