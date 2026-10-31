import type { Entity } from "../records";
import type { SkippedRecord } from "../engine-types";
import type { BootstrapInput, Replica, ReplicaIdentity, ReplicaMeta, Scope } from "./types";

/** The browser refused a database write for lack of space. Nothing of that write was kept. */
export class StorageFullError extends Error {
  constructor(options?: ErrorOptions) {
    super("This device is out of storage space", options);
    this.name = "StorageFullError";
  }
}

/** Turns a quota failure from IndexedDB into a StorageFullError. Anything else passes through. */
export function storageFailure(error: unknown): unknown {
  const quota =
    error !== null &&
    typeof error === "object" &&
    "name" in error &&
    error.name === "QuotaExceededError";
  return quota ? new StorageFullError({ cause: error }) : error;
}

export const REPLICA_PREFIX = "blackwall:";

export function replicaName(input: ReplicaIdentity): string {
  return `${REPLICA_PREFIX}${input.userId}:${input.workspaceId}`;
}

export function replicaIdentity(name: string): ReplicaIdentity | null {
  if (!name.startsWith(REPLICA_PREFIX)) return null;
  const parts = name.slice(REPLICA_PREFIX.length).split(":");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  return { userId: parts[0], workspaceId: parts[1] };
}

export function initialMeta(input: ReplicaIdentity & { schema: number }): ReplicaMeta {
  return {
    userId: input.userId,
    workspaceId: input.workspaceId,
    schema: input.schema,
    serverSchema: 0,
    clientId: crypto.randomUUID(),
    cursor: null,
    lastMutationId: 0,
    nextMutationId: 1,
  };
}

/** The meta with its skipped list and resync obligation replaced. Empty ones leave no trace. */
export function withSkipped(
  meta: ReplicaMeta,
  skipped: readonly SkippedRecord[],
  resync: boolean,
): ReplicaMeta {
  const next = { ...meta };
  delete next.skipped;
  delete next.resync;
  if (skipped.length > 0) next.skipped = skipped;
  if (resync) next.resync = true;
  return next;
}

/** Same key paths as records.keyOf, without normalizing or changing the wire record. */
export function keyPath(entity: Entity): "id" | "user_id" {
  return entity === "alert_preferences" ? "user_id" : "id";
}

export function recordKey(entity: Entity, record: object): string {
  const key = Reflect.get(record, keyPath(entity));
  if (typeof key !== "string") throw new Error(`missing ${keyPath(entity)} for ${entity}`);
  return key;
}

export function scopeKey(scope: Scope): string {
  return `${scope.entity}:${scope.entity === "comments" ? scope.issueId : scope.entityId}`;
}

export function recordScope(entity: Entity, record: object): Scope | null {
  if (entity === "comments" && "issue_id" in record && typeof record.issue_id === "string") {
    return { entity, issueId: record.issue_id };
  }
  if (entity === "activity" && "entity_id" in record && typeof record.entity_id === "string") {
    return { entity, entityId: record.entity_id };
  }
  return null;
}

export function acceptsChange(
  entity: Entity,
  record: object | undefined,
  scopes: ReadonlyMap<string, Scope>,
): boolean {
  if (entity !== "comments" && entity !== "activity") return true;
  const scope = record === undefined ? null : recordScope(entity, record);
  return scope !== null && scopes.has(scopeKey(scope));
}

/** Records per staged bootstrap write, so no one transaction holds the database for long. */
export const BOOTSTRAP_CHUNK = 2000;

/** Writes a whole bootstrap through a stage, in chunks. */
export async function writeStaged(replica: Replica, input: BootstrapInput): Promise<void> {
  const stage = await replica.stageBootstrap();
  let chunk: Partial<Record<Entity, object[]>> = {};
  let size = 0;
  for (const entity of input.entities)
    for (const record of input.records[entity] ?? []) {
      (chunk[entity] ??= []).push(record);
      size += 1;
      if (size < BOOTSTRAP_CHUNK) continue;
      await stage.write(chunk);
      chunk = {};
      size = 0;
    }
  if (size > 0) await stage.write(chunk);
  await stage.commit(input);
}
