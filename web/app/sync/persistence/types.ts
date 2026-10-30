import type { Rejection } from "../engine-types";
import type { Change, Entity } from "../records";
import type { PendingMutation } from "../store";

export interface ReplicaMeta {
  schema: number;
  serverSchema: number;
  sessionId: string;
  workspaceId: string;
  /** Who the replica belongs to, so a login can tell its own saved edits from another user's. */
  userId: string;
  clientId: string;
  cursor: string | null;
  lastMutationId: number;
  nextMutationId: number;
}

export type Scope =
  | { entity: "comments"; issueId: string }
  | { entity: "activity"; entityId: string };

export interface LoadedReplica {
  meta: ReplicaMeta;
  records: Partial<Record<Entity, readonly object[]>>;
  /** Mutations the server hasn't acknowledged, ascending by id. */
  outbox: readonly PendingMutation[];
  /** Acknowledged mutations whose push result was never received, so a rejection may be unknown. */
  unconfirmed: readonly PendingMutation[];
  scopes: readonly Scope[];
  /** Rejected commands kept until the user resolves them, ascending by mutation id. */
  rejected: readonly Rejection[];
}

/**
 * What a new replica takes over from one an ended session left behind. The server ties a client id
 * to a user and workspace, not to a session, so the new replica keeps the old client id and
 * mutation ids. The server then answers anything it already processed with duplicate or rejected.
 */
export interface SavedWork {
  clientId: string;
  lastMutationId: number;
  nextMutationId: number;
  /** Every outbox row, acknowledged ones included, so lost push results can be asked for again. */
  outbox: readonly PendingMutation[];
  rejected: readonly Rejection[];
}

/**
 * `already`: this replica carries that client id from an earlier takeover.
 * `occupied`: it has issued mutations of its own, so it can't take another replica's ids.
 */
export type Adoption = "adopted" | "already" | "occupied";

/** Each write is one atomic transaction, including its metadata and outbox changes. */
export interface Replica {
  load(): Promise<LoadedReplica>;
  /** The unacknowledged outbox alone, ascending by id, for a push that doesn't need the whole replica. */
  loadOutbox(): Promise<readonly PendingMutation[]>;
  /** Discard base and scopes, adopt the open schema, and keep meta ids and the outbox. */
  resetBase(): Promise<void>;
  writeBootstrap(input: {
    cursor: string;
    lastMutationId: number;
    serverSchema: number;
    records: Partial<Record<Entity, readonly object[]>>;
    entities: readonly Entity[];
  }): Promise<void>;
  applyPull(input: {
    changes: readonly Change[];
    cursor: string;
    acknowledgedUpTo: number | null;
  }): Promise<void>;
  writeScope(input: { scope: Scope; records: readonly object[] }): Promise<void>;
  /** Whether the scope is loaded, and its records, read in one transaction. */
  loadScope(scope: Scope): Promise<{ loaded: boolean; records: readonly object[] }>;
  appendMutation(build: (id: number) => Omit<PendingMutation, "id">): Promise<PendingMutation>;
  /**
   * Records that these mutations' push results arrived. Acknowledgement keeps unconfirmed
   * mutations in the outbox, so a result lost with its response can still be asked for.
   * `rejected` keeps the rejected commands, written in the same transaction.
   */
  confirm(ids: readonly number[], rejected?: readonly Rejection[]): Promise<void>;
  /** Takes over saved work in one write. Only a replica that has issued no mutations adopts. */
  adopt(saved: SavedWork): Promise<Adoption>;
  /** Keeps these rejections and drops their mutations from the outbox, so they are never pushed. */
  discard(rejections: readonly Rejection[]): Promise<void>;
  /**
   * Access to the workspace ended. Empties base, scopes and the outbox, so nothing of the workspace
   * stays on disk, and keeps the given rejections, the client id and the mutation ids.
   */
  revoke(rejections: readonly Rejection[]): Promise<void>;
  /** Forgets a kept rejection once the user restored, retried or dismissed it. */
  resolveRejection(id: number): Promise<void>;
  close(): void;
}

export interface ReplicaIdentity {
  sessionId: string;
  workspaceId: string;
}

export interface ReplicaStorage {
  open(input: ReplicaOpenInput): Promise<Replica>;
  list(): Promise<readonly ReplicaIdentity[]>;
  delete(input: ReplicaIdentity): Promise<void>;
  deleteAllExcept(sessionId: string | null): Promise<void>;
}

export type ReplicaCloseReason = "versionchange" | "terminated";

/** External closure only. Explicit Replica.close() does not notify. */
export type ReplicaCloseListener = (
  event: ReplicaIdentity &
    ({ reason: "versionchange"; newVersion: number | null } | { reason: "terminated" }),
) => void;

export interface ReplicaOpenInput extends ReplicaIdentity {
  schema: number;
  /** Recorded when the replica is created. Unknown owners are never given another user's work. */
  userId?: string;
  /** Called when this handle's database closes from outside, such as a deletion elsewhere. */
  onClose?: (reason: ReplicaCloseReason, newVersion?: number | null) => void;
}
