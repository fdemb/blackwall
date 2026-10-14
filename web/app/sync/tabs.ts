import type { Scope } from "./persistence/types";
import type { Change } from "./records";
import type { PendingMutation } from "./store";

export interface TabError {
  message: string;
  status?: number;
}

/** A push result: applied, or the server's rejection without its command. */
export type TabOutcome = "applied" | { id: number; status: number; message: string };

/** Messages between engines that share one replica. Each one names its sender. */
export type TabBody =
  | { type: "appended"; mutation: PendingMutation }
  | {
      type: "pulled";
      changes: readonly Change[];
      cursor: string | null;
      acknowledgedUpTo: number | null;
      /** Set when this message loads a comment or activity scope. */
      scope?: Scope;
    }
  | { type: "reset" }
  /** The session ended, so every tab stops. The leader sends this before it deletes anything. */
  | { type: "unauthorized" }
  | { type: "accessLost" }
  /**
   * `blocked`: a protocol error stopped the leader's push or reads, so the outbox can't drain.
   * `error`: the leader's last sync error, while it retries.
   */
  | {
      type: "status";
      connected: boolean;
      online: boolean;
      blocked: boolean;
      error: { message: string; unreachable: boolean } | null;
    }
  | { type: "result"; mutationId: number; outcome: TabOutcome }
  /** The user dealt with a kept rejection, so every tab forgets it. */
  | { type: "resolved"; mutationId: number }
  /** A new tab asks the leader to repeat its status. */
  | { type: "hello" }
  /** A follower's user asked to retry, so the leader clears its protocol blocks. */
  | { type: "retry" }
  | ({ type: "request"; requestId: string } & TabCall)
  | ({ type: "reply"; requestId: string } & (
      | { ok: true; value: unknown }
      | { ok: false; error: TabError }
    ));

export type TabCall = { kind: "loadScope"; scope: Scope };

export type TabMessage = TabBody & { from: string };
