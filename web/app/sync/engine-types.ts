import type { ReplicaStorage } from "./persistence/types";
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
}

/** A comment or activity scope: loaded into the replica, still loading, or blocked by a protocol error. */
export type ScopeStatus = "loading" | "loaded" | "error";

export interface Rejection {
  id: number;
  status: number;
  message: string;
}

export interface EngineStatus {
  phase: "loading" | "bootstrapping" | "ready";
  connected: boolean;
  online: boolean;
  pending: number;
  lastError: Error | null;
  rejected: readonly Rejection[];
}

export type EngineEvent =
  | { type: "rejected"; rejection: Rejection }
  | { type: "error"; error: Error }
  | { type: "unauthorized" }
  | { type: "accessLost" };

export interface MutationReceipt {
  /** Created record id, or null for an edit. */
  id: string | null;
  mutationId: number;
  settled: Promise<"applied" | Rejection>;
}
