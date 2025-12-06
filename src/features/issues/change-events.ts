import type {
  Issue,
  IssueChangeEventType,
  IssueFieldChanges,
  NewIssueChangeEvent,
} from "@/db/schema";

type ChangeEventContext = {
  issueId: string;
  workspaceId: string;
  actorId: string;
};

export function buildChangeEvent(
  ctx: ChangeEventContext,
  eventType: IssueChangeEventType,
  relatedEntityId?: string,
): NewIssueChangeEvent {
  return { ...ctx, eventType, relatedEntityId };
}

export function buildIssueUpdatedEvent(
  ctx: ChangeEventContext,
  updates: Partial<Issue>,
  original: Issue,
): NewIssueChangeEvent | null {
  const changes = computeFieldChanges(updates, original);
  if (Object.keys(changes).length === 0) return null;
  return { ...ctx, eventType: determineEventType(changes), changes };
}

function computeFieldChanges(
  updates: Partial<Issue>,
  original: Issue,
): IssueFieldChanges {
  const changes: IssueFieldChanges = {};

  for (const key of Object.keys(updates) as Array<keyof Issue>) {
    const oldValue = original[key];
    const newValue = updates[key];

    if (oldValue === newValue) continue;
    if (key === "description") {
      if (JSON.stringify(oldValue) === JSON.stringify(newValue)) continue;
    }

    (changes as Record<string, { from: unknown; to: unknown }>)[key] = {
      from: oldValue ?? null,
      to: newValue ?? null,
    };
  }

  return changes;
}

function determineEventType(changes: IssueFieldChanges): IssueChangeEventType {
  if (Object.keys(changes).length === 0) return "issue_updated";

  if (changes.summary) {
    return "summary_changed";
  }

  if (changes.description) {
    return "description_changed";
  }

  if (changes.status) {
    return "status_changed";
  }

  if (changes.priority) {
    return "priority_changed";
  }

  if (changes.assignedToId) {
    return "assignee_changed";
  }

  return "issue_updated";
}
