import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { OpenProjectNotice } from "../components/app/issue-parts";
import { I18nProvider } from "./i18n";
import {
  automaticOpenProjectStage,
  migratedOpenProjectStageKind,
  isImportedIssue,
  openprojectIssueUrl,
} from "./openproject";
import type { OpenProjectIssue, Stage } from "./types";

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

describe("OpenProject status mapping defaults", () => {
  const stages: Stage[] = [
    { id: "done", name: "Done", kind: "done", position: 3, version: 1 },
    { id: "backlog", name: "Backlog", kind: "backlog", position: 1, version: 1 },
    { id: "active", name: "In progress", kind: "active", position: 2, version: 1 },
  ];
  it("matches names before the open or closed fallback and leaves input order intact", () => {
    expect(
      automaticOpenProjectStage({ id: 1, name: "IN PROGRESS", is_closed: false }, stages)?.id,
    ).toBe("active");
    expect(automaticOpenProjectStage({ id: 2, name: "Other", is_closed: false }, stages)?.id).toBe(
      "backlog",
    );
    expect(automaticOpenProjectStage({ id: 3, name: "Closed", is_closed: true }, stages)?.id).toBe(
      "done",
    );
    expect(stages[0]?.id).toBe("done");
    expect(
      automaticOpenProjectStage({ id: 4, name: "Other", is_closed: false }, [
        { id: "done", name: "Done", kind: "done", position: 3, version: 1 },
      ])?.id,
    ).toBe("done");
    expect(
      automaticOpenProjectStage({ id: 4, name: "Other", is_closed: false }, []),
    ).toBeUndefined();
  });
  it("creates closed statuses as done and new statuses as backlog", () => {
    expect(migratedOpenProjectStageKind({ id: 1, name: "Closed", is_closed: true })).toBe("done");
    expect(migratedOpenProjectStageKind({ id: 2, name: " New ", is_closed: false })).toBe(
      "backlog",
    );
    expect(migratedOpenProjectStageKind({ id: 3, name: "In review", is_closed: false })).toBe(
      "active",
    );
  });
});
