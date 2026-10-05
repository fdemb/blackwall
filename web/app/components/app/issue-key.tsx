import { issueKey } from "~/lib/format";
import type { Issue } from "~/lib/types";
import { cn } from "~/lib/utils";

export function issueKeyLength(issues: readonly Pick<Issue, "number">[]): number {
  return issues.reduce((length, issue) => Math.max(length, issueKey(issue.number).length), 0);
}

export function IssueKey({
  number,
  length = 0,
  className,
}: {
  number: Issue["number"];
  length?: number;
  className?: string;
}) {
  return (
    <span className={cn("inline-grid shrink-0 whitespace-nowrap tabular-nums", className)}>
      {/* Let the font measure the prefix and tabular digits, rather than approximating with ch. */}
      <span aria-hidden="true" className="invisible col-start-1 row-start-1">
        {issueKey(0).padEnd(length, "0")}
      </span>
      <span className="col-start-1 row-start-1">{issueKey(number)}</span>
    </span>
  );
}
