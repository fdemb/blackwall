import type { Scope } from "./persistence/types";
import type { Change } from "./records";
import type { PendingMutation } from "./store";

export interface TabError {
  message: string;
  status?: number;
}

/** A push result: applied, unknown, or the server's rejection without its command. */
export type TabOutcome = "applied" | "unknown" | { id: number; status: number; message: string };

/**
 * A leader's term and the number of its latest replica message. Each tab that takes the lock
 * claims a higher term in the database, so followers ignore a superseded leader's late messages.
 * They count the messages of a term, so a gap shows one they missed.
 */
export interface TabMark {
  term: number;
  seq: number;
}

/** Messages between engines that share one replica. Each one names its sender. */
export type TabBody =
  | { type: "appended"; mutation: PendingMutation }
  | ({
      type: "pulled";
      changes: readonly Change[];
      cursor: string | null;
      acknowledgedUpTo: number | null;
      /** Set when this message loads a comment or activity scope. */
      scope?: Scope;
      /** The replica's revision after the write this reports. Absent when nothing was written. */
      revision?: number;
    } & TabMark)
  | ({ type: "reset" } & TabMark)
  /** The leader dropped these scopes from the replica, because no tab held them for a while. */
  | ({ type: "evicted"; scopes: readonly Scope[]; revision: number } & TabMark)
  /** The session ended, so every tab stops. The leader sends this before it deletes anything. */
  | { type: "unauthorized" }
  | { type: "accessLost" }
  /**
   * `blocked`: a protocol error stopped the leader's push or reads, so the outbox can't drain.
   * `stalled`: the server keeps failing the leader's pushes, which it keeps retrying.
   * `error`: the leader's last sync error, while it retries.
   */
  | ({
      type: "status";
      connected: boolean;
      online: boolean;
      blocked: boolean;
      stalled: boolean;
      /** The leader's disk refused a write, so this tab's data can run ahead of it. */
      storageFull: boolean;
      error: { message: string; unreachable: boolean } | null;
    } & TabMark)
  | { type: "result"; mutationId: number; outcome: TabOutcome }
  /** The user dealt with a kept rejection, so every tab forgets it. */
  | { type: "resolved"; mutationId: number }
  /** A new or resumed tab asks the leader to repeat its status. */
  | { type: "hello" }
  /**
   * Every tab sends this now and then. `visible`: the page is visible and waits for the lock, so a
   * hidden leader can hand over to it. `holding`: the keys of the scopes the tab holds.
   */
  | { type: "presence"; visible: boolean; holding: readonly string[] }
  /** A follower's user asked to retry, so the leader clears its protocol blocks. */
  | { type: "retry" }
  | ({ type: "request"; requestId: string } & TabCall)
  | ({ type: "reply"; requestId: string } & (
      | { ok: true; value: unknown }
      | { ok: false; error: TabError }
    ));

export type TabCall = { kind: "loadScope"; scope: Scope };

export type TabMessage = TabBody & { from: string };

/** The leader's messages that change the replica, numbered by its mark. */
export type ReplicaMessage = Extract<TabMessage, { type: "pulled" | "reset" | "evicted" }>;
