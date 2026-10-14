import { describe, expect, it } from "vite-plus/test";
import { BULK_ISSUE_LIMIT, bulkIssueCommands } from "./bulk-issues";

const issues = (count: number) =>
  Array.from({ length: count }, (_, index) => ({ id: `issue-${index}`, even: index % 2 === 0 }));

describe("bulkIssueCommands", () => {
  it("splits ids into commands of at most 500", () => {
    const commands = bulkIssueCommands(issues(1200), "unarchive");

    expect(commands.map((command) => command.ids.length)).toEqual([500, 500, 200]);
    expect(commands.every((command) => command.type === "bulk_issues")).toBe(true);
    expect(commands.every((command) => command.action === "unarchive")).toBe(true);
    expect(commands.flatMap((command) => command.ids)).toEqual(issues(1200).map((i) => i.id));
  });

  it("keeps a batch of exactly 500 in one command", () => {
    const commands = bulkIssueCommands(issues(BULK_ISSUE_LIMIT), "restore");

    expect(commands).toHaveLength(1);
    expect(commands[0]?.ids).toHaveLength(BULK_ISSUE_LIMIT);
  });

  it("filters before batching", () => {
    const commands = bulkIssueCommands(issues(1200), "restore", (issue) => issue.even);

    expect(commands.map((command) => command.ids.length)).toEqual([500, 100]);
    expect(commands.flatMap((command) => command.ids)).toEqual(
      issues(1200)
        .filter((issue) => issue.even)
        .map((issue) => issue.id),
    );
  });

  it("returns no commands when nothing is included", () => {
    expect(bulkIssueCommands([], "restore")).toEqual([]);
    expect(bulkIssueCommands(issues(3), "restore", () => false)).toEqual([]);
  });
});
