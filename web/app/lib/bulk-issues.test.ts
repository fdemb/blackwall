import { describe, expect, it } from "vite-plus/test";
import { BULK_ISSUE_LIMIT, bulkIssueCommands } from "./bulk-issues";
import { issueCapabilities } from "./ownership";
import type { OpenProjectIssue } from "./types";

const openproject: OpenProjectIssue = {
  connection_id: "connection-a",
  project_id: 7,
  work_package_id: 12,
  status_name: "Closed",
  url: "https://op.example/work_packages/12",
  unavailable: false,
};

// Odd ids come from OpenProject, whose ownership policy doesn't allow restoring them.
const issues = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    id: `issue-${index}`,
    openproject: index % 2 === 0 ? null : openproject,
  }));

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

  it("filters by capability before batching", () => {
    const commands = bulkIssueCommands(
      issues(1200),
      "restore",
      (issue) => issueCapabilities(issue).restore,
    );

    expect(commands.map((command) => command.ids.length)).toEqual([500, 100]);
    expect(commands.flatMap((command) => command.ids)).toEqual(
      issues(1200)
        .filter((issue) => issue.openproject === null)
        .map((issue) => issue.id),
    );
  });

  it("returns no commands when nothing is included", () => {
    expect(bulkIssueCommands([], "restore")).toEqual([]);
    expect(bulkIssueCommands(issues(3), "restore", () => false)).toEqual([]);
  });
});
