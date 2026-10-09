import type { DeepReadonly } from "./store";
import type { SyncIssue } from "./records";
import type { SyncStore } from "./store";

/** Server definition: dependencies neither deleted nor in a done/cancelled stage. */
export function blockedCount(store: SyncStore, issueId: string): number {
  const issue = store.get("issues", issueId);
  if (issue === undefined) return 0;
  let count = 0;
  for (const dependencyId of issue.dependencies) {
    const dependency = store.get("issues", dependencyId);
    if (dependency === undefined || dependency.deleted_at !== null) continue;
    const kind = store.stageKind(dependency.stage_id);
    // The server's JOIN excludes stages it can't see: unknown kind counts as neither
    // done nor open, so it is not counted here (and never completes a subtask).
    if (kind === undefined) continue;
    if (kind === "done" || kind === "cancelled") continue;
    count += 1;
  }
  return count;
}

/** Server definition: children with this parent that aren't deleted. */
export function subtaskTotal(store: SyncStore, issueId: string): number {
  let count = 0;
  for (const child of store.byIndex("issues", "parent_id", issueId)) {
    if (child.deleted_at === null) count += 1;
  }
  return count;
}

/** Server definition: those children whose stage kind is done or cancelled. */
export function subtaskCompleted(store: SyncStore, issueId: string): number {
  let count = 0;
  for (const child of store.byIndex("issues", "parent_id", issueId)) {
    if (child.deleted_at !== null) continue;
    const kind = store.stageKind(child.stage_id);
    if (kind === "done" || kind === "cancelled") count += 1;
  }
  return count;
}

/** The UI issue shape: the sync record with derived counts attached. Read-only: records are frozen. */
export type CountedIssue = DeepReadonly<SyncIssue> & {
  blocked_count: number;
  subtask_total: number;
  subtask_completed: number;
};

export function withCounts(store: SyncStore, issue: DeepReadonly<SyncIssue>): CountedIssue {
  const src = issue as unknown as SyncIssue;
  return {
    ...src,
    blocked_count: blockedCount(store, issue.id),
    subtask_total: subtaskTotal(store, issue.id),
    subtask_completed: subtaskCompleted(store, issue.id),
  };
}
