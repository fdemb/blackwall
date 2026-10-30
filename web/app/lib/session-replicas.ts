import { IndexedDBReplicaStorage } from "../sync/persistence/idb";
import { SCHEMA } from "../sync/engine";
import type { SyncEngine } from "../sync/engine";
import type { ReplicaIdentity } from "../sync/persistence/types";
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
  await deleteOtherUsersReplicas(profile);
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
/** Pending edits or kept rejections, in an open workspace or on disk, that logout would delete. */
export async function sessionHasPending(): Promise<boolean> {
  if (!session) return false;
  for (const entry of active.values()) {
    const { unresolved } = entry.engine.status.get();
    if (entry.engine.store.pending().length || unresolved.length) return true;
  }
  for (const identity of await replicaStorage().list())
    if ((await inspect(identity))?.work) return true;
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
/**
 * The server ended the session. Sync stops and every replica stays as it is: the same user's next
 * sign-in continues from it, and only a logout or another user's sign-in deletes it.
 */
export async function expireSession() {
  await closeAllWorkspaceEngines();
  forgetSession();
}
/** Logout, which the user confirmed: every replica on this browser goes, pending edits included. */
export async function clearSession() {
  await closeAllWorkspaceEngines();
  await deleteReplicas(await replicaStorage().list());
  forgetSession();
}
function forgetSession() {
  session = null;
  safeRemove("local", SESSION_KEY);
  safeRemove("local", WORKSPACES_KEY);
}

/**
 * What a replica holds, or null when it can't be read, for instance when a newer version of the
 * app wrote it. `legacy` marks a replica from before replicas were named by user, whose meta has
 * no user and whose name holds a session id.
 */
async function inspect(
  identity: ReplicaIdentity,
): Promise<{ work: boolean; legacy: boolean } | null> {
  try {
    const replica = await replicaStorage().open({ ...identity, schema: SCHEMA });
    try {
      const { meta, outbox, unconfirmed, rejected } = await replica.load();
      return {
        work: outbox.length + unconfirmed.length + rejected.length > 0,
        legacy: Reflect.get(meta, "userId") === undefined,
      };
    } finally {
      replica.close();
    }
  } catch (error) {
    console.error(`Replica ${identity.workspaceId} can't be read, so it is kept as it is`, error);
    return null;
  }
}

async function deleteReplicas(identities: readonly ReplicaIdentity[]) {
  for (const identity of identities) {
    try {
      await replicaStorage().delete(identity);
    } catch (error) {
      console.error(`Replica ${identity.workspaceId} couldn't be deleted`, error);
    }
  }
}

/**
 * Signing in as someone else deletes the replicas the previous user left, whatever they hold:
 * privacy wins over keeping their edits. A replica from before replicas were named by user can't
 * be attributed, since its name holds a session id, so one that still holds edits stays on disk
 * unopened, unless it belongs to this session, which opens it until its outbox drains.
 */
async function deleteOtherUsersReplicas(profile: SessionProfile) {
  const doomed: ReplicaIdentity[] = [];
  for (const identity of await replicaStorage().list()) {
    if (identity.userId === profile.id || identity.userId === profile.session_id) continue;
    const found = await inspect(identity);
    if (found?.legacy && found.work)
      console.warn(`Replica ${identity.workspaceId} has edits of unknown ownership, kept`);
    else doomed.push(identity);
  }
  await deleteReplicas(doomed);
}

/**
 * The name a workspace's replica carries for this session: the user's id, or this session's id
 * while a replica from before replicas were named by user still holds edits, so they keep their
 * client id and mutation ids. Once it drains the user-named replica takes over, and the old one
 * goes at the next sign-in.
 */
export async function replicaOwner(profile: SessionProfile, workspaceId: string): Promise<string> {
  const legacy = { userId: profile.session_id, workspaceId };
  const named = (await replicaStorage().list()).some(
    (identity) => identity.userId === legacy.userId && identity.workspaceId === workspaceId,
  );
  return named && (await inspect(legacy))?.work ? legacy.userId : profile.id;
}
