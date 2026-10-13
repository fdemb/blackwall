import type { ReplicaStorage } from "./persistence/types";
import type { TabMessage } from "./tabs";
import type { Transport } from "./transport";

export interface EngineClock {
  now(): string;
  /** Returns a cancellation function, like FakeClock.schedule. */
  schedule(milliseconds: number, run: () => void): () => void;
}

export type EngineSignal = "online" | "offline" | "focus" | "visible";

export interface EngineSignals {
  getOnline(): boolean;
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
  sessionId: string;
  workspaceId: string;
  actor: string;
  clock: EngineClock;
  randomId(): string;
  schema: number;
  signals: EngineSignals;
  /** Elects one leader per replica. Without it, the engine is always the leader. */
  locks?: TabLocks;
  /** Coordinates engines sharing one replica. Named by the session and workspace. */
  channel?: (name: string) => TabChannel;
}

/** Only the leader does network work. Followers keep their store current from messages. */
export type EngineRole = "leader" | "follower";

/** A comment or activity scope: loaded into the replica, still loading, or blocked by a protocol error. */
export type ScopeStatus = "loading" | "loaded" | "error";

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
  lastError: Error | null;
  rejected: readonly Rejection[];
}

export type EngineEvent =
  | { type: "rejected"; rejection: Rejection }
  | { type: "error"; error: Error }
  | { type: "unauthorized" }
  | { type: "accessLost" }
  | { type: "outdated" }
  | { type: "closed" };

export interface MutationReceipt {
  /** Created record id, or null for an edit. */
  id: string | null;
  mutationId: number;
  settled: Promise<"applied" | Rejection>;
}
