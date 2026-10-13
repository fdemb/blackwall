import type { Issue } from "~/lib/types";
import { cn } from "~/lib/utils";

/**
 * Room for the widest key among `issues`: one sizer per team key, each padded
 * to the most digits any of the keys has. Space-separated, so it compares by value.
 */
export function issueKeyWidth(issues: readonly Pick<Issue, "key">[]): string {
  const prefixes = new Set<string>();
  let digits = 0;
  for (const { key } of issues) {
    const dash = key.lastIndexOf("-") + 1;
    prefixes.add(key.slice(0, dash));
    digits = Math.max(digits, key.length - dash);
  }
  return [...prefixes]
    .sort()
    .map((prefix) => prefix + "0".repeat(digits))
    .join(" ");
}

export function IssueKey({
  value,
  width = "",
  className,
}: {
  value: string;
  /** From `issueKeyWidth`, so keys in one list line up. */
  width?: string;
  className?: string;
}) {
  return (
    <span className={cn("inline-grid shrink-0 whitespace-nowrap tabular-nums", className)}>
      {/* Let the font measure each team's key and tabular digits; the widest sizer wins the cell. */}
      {width
        .split(" ")
        .filter(Boolean)
        .map((sizer) => (
          <span key={sizer} aria-hidden="true" className="invisible col-start-1 row-start-1">
            {sizer}
          </span>
        ))}
      <span className="col-start-1 row-start-1">{value}</span>
    </span>
  );
}
