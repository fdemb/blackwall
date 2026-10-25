import { describe, expect, it } from "vite-plus/test";
import { changedFieldLabels, groupByIssue, parseAlertKind, quotesComment } from "./inbox";
import type { Notification } from "./types";

function notification(id: string, patch: Partial<Notification> = {}): Notification {
  return {
    id,
    version: 1,
    user_id: "me",
    issue_id: "issue-a",
    kind: "change",
    message: "Renew the TLS certificate",
    read_at: null,
    created_at: "2026-10-25T10:00:00Z",
    ...patch,
  };
}

describe("parseAlertKind", () => {
  it("accepts alert kinds and rejects anything else", () => {
    expect(parseAlertKind("mention")).toBe("mention");
    expect(parseAlertKind("archive")).toBeNull();
    expect(parseAlertKind(null)).toBeNull();
  });
});

describe("changedFieldLabels", () => {
  it("lists known fields in activity order whatever order the server sent", () => {
    const changed = notification("n1", { fields: ["stage", "unknown", "assignee", "description"] });
    expect(changedFieldLabels(changed)).toEqual([
      "field.description",
      "field.stage",
      "field.assignee",
    ]);
  });

  it("is empty for rows cached before notifications carried fields", () => {
    expect(changedFieldLabels(notification("n1"))).toEqual([]);
  });
});

describe("groupByIssue", () => {
  it("keeps the newest-first order of issues and of items within each issue", () => {
    const items = [
      notification("n1", { issue_id: "issue-a" }),
      notification("n2", { issue_id: "issue-b" }),
      notification("n3", { issue_id: "issue-a" }),
      notification("n4", { issue_id: null }),
      notification("n5", { issue_id: null }),
    ];
    expect(
      groupByIssue(items).map((group) => [group.issueId, group.items.map((n) => n.id)]),
    ).toEqual([
      ["issue-a", ["n1", "n3"]],
      ["issue-b", ["n2"]],
      [null, ["n4"]],
      [null, ["n5"]],
    ]);
  });
});

describe("quotesComment", () => {
  it("quotes replies and comment mentions but not description mentions or changes", () => {
    expect(quotesComment(notification("n1", { kind: "reply" }))).toBe(true);
    expect(quotesComment(notification("n2", { kind: "mention", fields: [] }))).toBe(true);
    expect(quotesComment(notification("n3", { kind: "mention", fields: ["description"] }))).toBe(
      false,
    );
    expect(quotesComment(notification("n4", { kind: "change" }))).toBe(false);
  });
});
