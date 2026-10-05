import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { OpenProjectNotice } from "../components/app/issue-parts";
import { I18nProvider } from "./i18n";
import { importedMutationTargets, isImportedIssue, openprojectIssueUrl } from "./openproject";
import type { Command, OpenProjectIssue } from "./types";

const metadata: OpenProjectIssue = {
  connection_id: "connection-a",
  project_id: 7,
  work_package_id: 12,
  status_name: "Closed",
  url: "https://op.example/work_packages/12",
  unavailable: false,
};

describe("imported issue policy", () => {
  it("renders a clear notice and external link without editable fields", () => {
    const html = renderToStaticMarkup(
      <I18nProvider initial="en">
        <OpenProjectNotice issue={{ openproject: metadata }} />
      </I18nProvider>,
    );
    expect(html).toContain("Edit fields and planning in OpenProject");
    expect(html).toContain('href="https://op.example/work_packages/12"');
    expect(html).toContain('rel="noreferrer noopener"');
    expect(html).not.toContain("<input");
  });
  it("renders retained-data warning in Polish and omits invalid links", () => {
    const html = renderToStaticMarkup(
      <I18nProvider initial="pl">
        <OpenProjectNotice
          issue={{ openproject: { ...metadata, unavailable: true, url: "javascript:alert(1)" } }}
        />
      </I18nProvider>,
    );
    expect(html).toContain("Zachowano ostatnie zsynchronizowane dane");
    expect(html).toContain("Komentarze");
    expect(html).not.toContain("href=");
  });
  it("does not add import chrome to local issues", () => {
    const html = renderToStaticMarkup(
      <I18nProvider initial="en">
        <OpenProjectNotice issue={{}} />
      </I18nProvider>,
    );
    expect(html).toBe("");
  });

  it("keeps any imported record read-only even when unavailable or disconnected", () => {
    expect(isImportedIssue({})).toBe(false);
    expect(isImportedIssue({ openproject: null })).toBe(false);
    expect(isImportedIssue({ openproject: metadata })).toBe(true);
    expect(isImportedIssue({ openproject: { ...metadata, unavailable: true } })).toBe(true);
  });

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
    expect(importedMutationTargets(command)).toContain("imported");
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
    expect(importedMutationTargets(command)).toEqual([]);
  });

  it.each(["javascript:alert(1)", "data:text/html,hello", "/work_packages/12", "invalid"])(
    "does not render unsafe or malformed external URLs: %s",
    (url) => {
      expect(openprojectIssueUrl({ openproject: { ...metadata, url } })).toBeNull();
    },
  );
  it("allows private http links as well as https", () => {
    expect(
      openprojectIssueUrl({
        openproject: { ...metadata, url: "http://10.0.0.2/work_packages/12" },
      }),
    ).toBe("http://10.0.0.2/work_packages/12");
  });
});
