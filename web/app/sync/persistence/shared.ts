import type { Entity } from "../records";
import type { ReplicaIdentity, ReplicaMeta, Scope } from "./types";

export const REPLICA_PREFIX = "blackwall:";

export function replicaName(input: ReplicaIdentity): string {
  return `${REPLICA_PREFIX}${input.sessionId}:${input.workspaceId}`;
}

export function replicaIdentity(name: string): ReplicaIdentity | null {
  if (!name.startsWith(REPLICA_PREFIX)) return null;
  const parts = name.slice(REPLICA_PREFIX.length).split(":");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  return { sessionId: parts[0], workspaceId: parts[1] };
}

export function initialMeta(input: ReplicaIdentity & { schema: number }): ReplicaMeta {
  return {
    ...input,
    serverSchema: 0,
    clientId: crypto.randomUUID(),
    cursor: null,
    lastMutationId: 0,
    nextMutationId: 1,
  };
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
