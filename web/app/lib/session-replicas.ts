import { IndexedDBReplicaStorage } from "../sync/persistence/idb";
import { SCHEMA } from "../sync/engine";
import type { SyncEngine } from "../sync/engine";
import type { TabLocks } from "../sync/engine-types";
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
// The user who last signed in here. It outlives an expired session, so the next sign-in can tell
// a returning user from another one when a replica names no user. Only logout clears it.
const LAST_USER_KEY = "bw-last-user:v1";

// One lock for every step that deletes replicas or publishes the session, across tabs.
const TRANSITION_LOCK = "blackwall-session";

let storage: IndexedDBReplicaStorage | undefined;
let session: SessionProfile | null = null;
let injectedLocks: TabLocks | undefined;
// Without Web Locks, transitions in this tab queue here. Other tabs can't be reached.
let queued: Promise<unknown> = Promise.resolve();
// Counts the sign-outs requested so far. A sign-in that was accepted before one must not
// publish its session once the sign-out has run.
let signOuts = 0;
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
/** Replaces the lock adapter transitions use. Without one, `navigator.locks` is used when present. */
export function setSessionLocks(locks: TabLocks | undefined) {
  injectedLocks = locks;
}
function sessionLocks(): TabLocks | undefined {
  if (injectedLocks) return injectedLocks;
  const browser = typeof navigator === "undefined" ? undefined : navigator.locks;
  return browser ? { request: (name, callback) => browser.request(name, callback) } : undefined;
}
/**
 * Runs one session transition alone, in this tab and in every other tab on the browser. Replica
 * deletion and publishing a session are not reentrant, so nothing inside may call another
 * transition.
 */
function transition<T>(run: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const hold = async () => {
      try {
        resolve(await run());
      } catch (error) {
        reject(error);
      }
    };
    const locks = sessionLocks();
    if (locks) locks.request(TRANSITION_LOCK, hold).catch(reject);
    else queued = queued.then(hold);
  });
}
/**
 * Accepts a session the server confirmed. `current` says whether the reply that carried it is still
 * the newest, and is asked again inside the lock before each step that deletes or publishes. An
 * obsolete acceptance changes nothing and returns null.
 */
export function acceptSession(
  profile: SessionProfile,
  current: () => boolean = () => true,
): Promise<SessionProfile | null> {
  const requested = signOuts;
  const live = () => requested === signOuts && current();
  return transition(async () => {
    if (!live()) return null;
    if (session?.session_id !== profile.session_id) await closeAllWorkspaceEngines();
    if (!(await deleteOtherUsersReplicas(profile, live))) return null;
    session = profile;
    safeSet("local", SESSION_KEY, JSON.stringify(profile));
    return profile;
  });
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
export function expireSession(current: () => boolean = () => true): Promise<void> {
  signOuts += 1;
  return transition(async () => {
    if (!current()) return;
    await closeAllWorkspaceEngines();
    forgetSession();
  });
}
/** Logout, which the user confirmed: every replica on this browser goes, pending edits included. */
export function clearSession(): Promise<void> {
  signOuts += 1;
  return transition(async () => {
    await closeAllWorkspaceEngines();
    await deleteReplicas(await replicaStorage().list());
    safeRemove("local", LAST_USER_KEY);
    forgetSession();
  });
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

async function deleteReplicas(identities: readonly ReplicaIdentity[], live = () => true) {
  for (const identity of identities) {
    if (!live()) return;
    try {
      await replicaStorage().delete(identity);
    } catch (error) {
      console.error(`Replica ${identity.workspaceId} couldn't be deleted`, error);
    }
  }
}

/**
 * Signing in as someone else deletes the replicas the previous user left, whatever they hold:
 * privacy wins over keeping their edits. A replica from before replicas were named by user has no
 * user to compare, since its name holds a session id. It is deleted when it is empty or when the
 * browser's last user is someone else. One that holds edits otherwise stays on disk, never opened
 * again, until a logout or another user's sign-in deletes it. An unreadable replica is deleted only
 * when the last user is someone else, because nothing says whose it is.
 *
 * Returns false, with the last user unwritten, when `live` turned false: the reply this sign-in
 * came from was replaced, and the newer one's replicas are not this user's to delete.
 */
async function deleteOtherUsersReplicas(
  profile: SessionProfile,
  live: () => boolean,
): Promise<boolean> {
  const previous = safeGet("local", LAST_USER_KEY);
  const changed = previous !== null && previous !== profile.id;
  const doomed: ReplicaIdentity[] = [];
  for (const identity of await replicaStorage().list()) {
    if (identity.userId === profile.id) continue;
    const found = await inspect(identity);
    if (found === null ? changed : !found.legacy || changed || !found.work) doomed.push(identity);
    else console.warn(`Replica ${identity.workspaceId} has edits of unknown ownership, kept`);
  }
  if (!live()) return false;
  // Inspecting is slow. Delete only what is still on disk and still someone else's.
  const present = await replicaStorage().list();
  await deleteReplicas(
    doomed.filter((identity) =>
      present.some(
        (found) => found.userId === identity.userId && found.workspaceId === identity.workspaceId,
      ),
    ),
    live,
  );
  if (!live()) return false;
  safeSet("local", LAST_USER_KEY, profile.id);
  return true;
}
