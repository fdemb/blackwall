import type { Command, Id } from "./types";

type BulkIssuesCommand = Extract<Command, { type: "bulk_issues" }>;

// The server rejects bulk commands over 500 ids.
export const BULK_ISSUE_LIMIT = 500;

export function bulkIssueCommands<T extends { id: Id }>(
  issues: readonly T[],
  action: BulkIssuesCommand["action"],
  include: (issue: T) => boolean = () => true,
): BulkIssuesCommand[] {
  const ids = issues.filter(include).map((issue) => issue.id);
  const commands: BulkIssuesCommand[] = [];
  for (let at = 0; at < ids.length; at += BULK_ISSUE_LIMIT)
    commands.push({ type: "bulk_issues", ids: ids.slice(at, at + BULK_ISSUE_LIMIT), action });
  return commands;
}
