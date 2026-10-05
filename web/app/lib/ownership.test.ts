import { describe, expect, it } from "vite-plus/test";
import { commandOwnershipTargets, issueCapabilities } from "./ownership";
import type { Command, OpenProjectIssue } from "./types";

const metadata: OpenProjectIssue = {
  connection_id: "connection-a",
  project_id: 7,
  work_package_id: 12,
  status_name: "Closed",
  url: "https://op.example/work_packages/12",
  unavailable: false,
};

describe("generated issue ownership policy", () => {
  it.each<Command>([
    { type: "update_issue", id: "imported", patch: { title: "Changed" } },
    { type: "move_issue", id: "imported", stage_id: "stage", before_id: null },
    { type: "delete_issue", id: "imported" },
    { type: "restore_issue", id: "imported" },
    { type: "bulk_issues", ids: ["imported", "local"], action: "delete" },
    { type: "remove_attachment", issue_id: "imported", attachment_id: "attachment" },
    { type: "add_source_link", issue_id: "imported", url: "https://example.com", title: "Example" },
    { type: "create_issue", input: { title: "Child", team_id: "team", parent_id: "imported" } },
  ])("identifies mutation targets for $type", (command) => {
    expect(commandOwnershipTargets(command)).toContain("imported");
  });

  it.each<Command>([
    { type: "add_comment", issue_id: "imported", body: "Local", mentions: [], attachments: [] },
    { type: "edit_comment", id: "comment", body: "Local", mentions: [] },
    { type: "delete_comment", id: "comment" },
    { type: "follow", issue_id: "imported", following: true },
    { type: "log_time", issue_id: "imported", minutes: 30, note: "", logged_at: "2026-05-01" },
    { type: "update_time", id: "time", minutes: 30, note: "", logged_at: "2026-05-01" },
    { type: "delete_time", id: "time" },
  ])("allows local discussion and time action $type", (command) => {
    expect(commandOwnershipTargets(command)).toEqual([]);
  });

  it("retains local capabilities on imported and unavailable issues", () => {
    for (const issue of [
      { openproject: metadata },
      { openproject: { ...metadata, unavailable: true } },
    ]) {
      const capabilities = issueCapabilities(issue);
      expect(capabilities.edit).toBe(false);
      expect(capabilities.move).toBe(false);
      expect(capabilities.source_links).toBe(false);
      expect(capabilities.remove_attachment).toBe(false);
      expect(capabilities.discussion).toBe(true);
      expect(capabilities.follow).toBe(true);
      expect(capabilities.time_tracking).toBe(true);
      expect(capabilities.add_attachment).toBe(true);
    }
    expect(issueCapabilities({}).edit).toBe(true);
  });

  it.each<Command>([
    { type: "update_issue", id: "local", patch: { dependencies: ["imported"] } },
    { type: "update_issue", id: "local", patch: { parent_id: "imported" } },
    { type: "bulk_issues", ids: ["local"], action: { update: { dependencies: ["imported"] } } },
    { type: "import_issues", issues: [{ title: "Child", team_id: "team", parent_id: "imported" }] },
  ])("checks referenced imported records for $type", (command) => {
    expect(commandOwnershipTargets(command)).toContain("imported");
  });
});
