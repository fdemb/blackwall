import type { Rejection, SkippedRecord } from "../engine-types";
import type { Change, Entity } from "../records";
import type { PendingMutation } from "../store";

export interface ReplicaMeta {
  schema: number;
  serverSchema: number;
  userId: string;
  workspaceId: string;
  clientId: string;
  cursor: string | null;
  lastMutationId: number;
  nextMutationId: number;
  /**
   * The server denied this user the workspace, and nothing has answered since. The cached base
   * may predate a removal, so it isn't shown as ready until a read succeeds.
   */
  accessLost?: boolean;
  /** Records the client couldn't parse at its last bootstrap or pull, kept for diagnostics. */
  skipped?: readonly SkippedRecord[];
  /**
   * A pull page skipped a record, so a bootstrap is owed to fetch it again. It survives a reload
   * and ends only with a bootstrap.
   */
  resync?: boolean;
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
    skipped?: readonly SkippedRecord[];
    resync?: boolean;
  }): Promise<void>;
  applyPull(input: {
    changes: readonly Change[];
    cursor: string;
    acknowledgedUpTo: number | null;
    /** When given, replaces the meta's skipped list and resync obligation in the same write. */
    skipped?: readonly SkippedRecord[];
    resync?: boolean;
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
  /** Keeps these rejections and drops their mutations from the outbox, so they are never pushed. */
  discard(rejections: readonly Rejection[]): Promise<void>;
  /** Sets or clears the access-lost marker in the meta. */
  setAccessLost(lost: boolean): Promise<void>;
  /** Forgets a kept rejection once the user restored, retried or dismissed it. */
  resolveRejection(id: number): Promise<void>;
  close(): void;
}

/** A replica lives for one user on one browser, so the user and the workspace name it. */
export interface ReplicaIdentity {
  userId: string;
  workspaceId: string;
}

export interface ReplicaStorage {
  open(input: ReplicaOpenInput): Promise<Replica>;
  list(): Promise<readonly ReplicaIdentity[]>;
  delete(input: ReplicaIdentity): Promise<void>;
}

export type ReplicaCloseReason = "versionchange" | "terminated";

/** External closure only. Explicit Replica.close() does not notify. */
export type ReplicaCloseListener = (
  event: ReplicaIdentity &
    ({ reason: "versionchange"; newVersion: number | null } | { reason: "terminated" }),
) => void;

export interface ReplicaOpenInput extends ReplicaIdentity {
  schema: number;
  /** Called when this handle's database closes from outside, such as a deletion elsewhere. */
  onClose?: (reason: ReplicaCloseReason, newVersion?: number | null) => void;
}
