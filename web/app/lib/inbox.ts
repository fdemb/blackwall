import { ISSUE_FIELDS } from "./issue-fields";
import type { Key } from "./i18n";
import type { AlertKind, Id, Notification } from "./types";

export const ALERT_KINDS = [
  "assignment",
  "reply",
  "mention",
  "change",
  "deadline",
] as const satisfies readonly AlertKind[];

export function parseAlertKind(value: string | null): AlertKind | null {
  return ALERT_KINDS.find((kind) => kind === value) ?? null;
}

export function changedFieldLabels(notification: Notification): Key[] {
  const fields = new Set(notification.fields ?? []);
  return Object.entries(ISSUE_FIELDS).flatMap(([name, field]) =>
    field && fields.has(name) ? [field.label] : [],
  );
}

/** Replies and comment mentions carry a comment body; description mentions carry the issue title. */
export function quotesComment(notification: Notification): boolean {
  return (
    notification.kind === "reply" ||
    (notification.kind === "mention" && !notification.fields?.length)
  );
}

export interface InboxGroup {
  key: Id;
  issueId: Id | null;
  items: Notification[];
}

export function groupByIssue(notifications: readonly Notification[]): InboxGroup[] {
  const groups = new Map<Id, InboxGroup>();
  for (const notification of notifications) {
    const key = notification.issue_id ?? notification.id;
    const group = groups.get(key);
    if (group) group.items.push(notification);
    else groups.set(key, { key, issueId: notification.issue_id, items: [notification] });
  }
  return [...groups.values()];
}
