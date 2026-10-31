import type { ReplicaStorage } from "./persistence/types";
import type { Entity } from "./records";
import type { TabMessage } from "./tabs";
import type { Transport } from "./transport";

export interface EngineClock {
  /** Wall-clock time, for timestamps that leave the device. It can jump, so never wait on it. */
  now(): string;
  /** Milliseconds from an arbitrary origin that never goes back. Every retry time uses it. */
  monotonic(): number;
  /** Returns a cancellation function, like FakeClock.schedule. */
  schedule(milliseconds: number, run: () => void): () => void;
}

/**
 * `visible` and `hidden` follow the page's visibility. `resume` means the page runs again after the
 * browser froze it or kept it in the back/forward cache.
 */
export type EngineSignal = "online" | "offline" | "focus" | "visible" | "hidden" | "resume";

export interface EngineSignals {
  getOnline(): boolean;
  /** Whether the page is visible when the engine opens. Without it, the engine assumes it is. */
  getVisible?(): boolean;
  subscribe(listener: (signal: EngineSignal) => void): () => void;
}

/** Shape of navigator.locks.request with the default exclusive mode. */
export interface TabLocks {
  request(name: string, callback: () => Promise<void>): Promise<void>;
}

/** Shape of BroadcastChannel, narrowed to what the engine uses. */
export interface TabChannel {
  postMessage(message: TabMessage): void;
  addEventListener(type: "message", listener: (event: { data: TabMessage }) => void): void;
  removeEventListener(type: "message", listener: (event: { data: TabMessage }) => void): void;
  close(): void;
}

export interface EngineDependencies {
  storage: ReplicaStorage;
  transport: Transport;
  workspaceId: string;
  /** The user the replica belongs to. It names the replica, its lock and its channel. */
  actor: string;
  clock: EngineClock;
  randomId(): string;
  schema: number;
  signals: EngineSignals;
  /** Asks the browser to keep this origin's storage. Called when a replica is first created. */
  requestPersistence?: () => unknown;
  /** Elects one leader per replica. Without it, the engine is always the leader. */
  locks?: TabLocks;
  /** Coordinates engines sharing one replica. Named by the owner and workspace. */
  channel?: (name: string) => TabChannel;
  /**
   * The longest random wait before a poke's pull, so a commit doesn't pull every client at once.
   * Zero, the default, pulls at once.
   */
  pokeJitterMs?: number;
}

/** Only the leader does network work. Followers keep their store current from messages. */
export type EngineRole = "leader" | "follower";

/**
 * A comment or activity scope: loaded into the replica, still loading, blocked by a protocol error,
 * or not loaded because the browser is offline.
 */
export type ScopeStatus = "loading" | "loaded" | "error" | "offline";

/** `full`: the browser refused a write for lack of space, so the replica on disk is behind memory. */
export type StorageState = "ok" | "full";

/** A server record this client couldn't parse and left out, so the rest of its page still loads. */
export interface SkippedRecord {
  entity: Entity;
  id: string;
  message: string;
}

export interface Rejection {
  id: number;
  status: number;
  message: string;
  /** The rejected command, so the UI can say what was lost. Null if the mutation is gone. */
  command: { name: string; args: unknown } | null;
}

export interface EngineStatus {
  phase: "loading" | "bootstrapping" | "ready";
  role: EngineRole;
  connected: boolean;
  online: boolean;
  pending: number;
  /** A protocol error stopped pushing or pulling, so the outbox can't drain until unblock(). */
  blocked: boolean;
  /** The server keeps failing the outbox's pushes. Nothing is dropped, and the push retries. */
  stalled: boolean;
  lastError: Error | null;
  /** Rejections reported during this engine's life. */
  rejected: readonly Rejection[];
  /** Rejected commands kept in the replica until the user resolves them, across reloads. */
  unresolved: readonly Rejection[];
  /** Records left out for failing to parse, until a pull brings a valid version or a deletion. */
  skipped: readonly SkippedRecord[];
  /**
   * `full` while the browser refuses writes. The view in memory keeps syncing, edits are refused
   * with a message, and the engine writes a snapshot again every few minutes and on focus.
   */
  storage: StorageState;
  /** Records the running bootstrap has received so far, or null when none runs. */
  progress: number | null;
}

export type EngineEvent =
  | { type: "rejected"; rejection: Rejection }
  | { type: "error"; error: Error }
  | { type: "unauthorized" }
  | { type: "accessLost" }
  | { type: "outdated" }
  | { type: "closed" };

/**
 * The server's verdict on a mutation. `unknown` means it processed the mutation but no longer
 * remembers whether it applied: it keeps only a client's last 1,000 rejections.
 */
export type MutationOutcome = "applied" | "unknown" | Rejection;

export interface MutationReceipt {
  /** Created record id, or null for an edit. */
  id: string | null;
  mutationId: number;
  settled: Promise<MutationOutcome>;
}
