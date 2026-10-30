import type { Replica, ReplicaIdentity, ReplicaStorage, SavedWork } from "./types";

/** A replica as the login and session-end cleanup sees it. */
export interface SavedReplica {
  identity: ReplicaIdentity;
  userId: string;
  work: SavedWork;
}

/** Edits the server may not have settled, or rejections the user hasn't dealt with. */
export function hasWork(work: SavedWork): boolean {
  return work.outbox.length > 0 || work.rejected.length > 0;
}

/** An unreadable replica holds nothing worth keeping, so it reads as empty. */
export async function readSaved(
  storage: ReplicaStorage,
  identity: ReplicaIdentity,
  schema: number,
): Promise<SavedReplica> {
  const empty: SavedReplica = {
    identity,
    userId: "",
    work: { clientId: "", lastMutationId: 0, nextMutationId: 1, outbox: [], rejected: [] },
  };
  let replica: Replica;
  try {
    replica = await storage.open({ ...identity, schema });
  } catch {
    return empty;
  }
  try {
    const { meta, outbox, unconfirmed, rejected } = await replica.load();
    return {
      identity,
      userId: meta.userId,
      work: {
        clientId: meta.clientId,
        lastMutationId: meta.lastMutationId,
        nextMutationId: meta.nextMutationId,
        outbox: [...unconfirmed, ...outbox],
        rejected,
      },
    };
  } catch {
    return empty;
  } finally {
    replica.close();
  }
}

/** Deletes the replicas that `among` selects, except those `keep` returns true for. */
export async function pruneReplicas(
  storage: ReplicaStorage,
  schema: number,
  among: (identity: ReplicaIdentity) => boolean,
  keep: (saved: SavedReplica) => boolean,
): Promise<void> {
  for (const identity of await storage.list()) {
    if (!among(identity)) continue;
    if (!keep(await readSaved(storage, identity, schema))) await storage.delete(identity);
  }
}
