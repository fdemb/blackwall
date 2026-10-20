import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { TrackerNotice } from "../components/app/issue-parts";
import { I18nProvider } from "./i18n";
import {
  automaticTrackerStage,
  migratedTrackerStageKind,
  trackerIssueUrl,
  trackerProviderName,
  trackerPushError,
} from "./trackers";
import type { Stage, TrackerLink } from "./types";

const metadata: TrackerLink = {
  provider: "openproject",
  connection_id: "connection-a",
  project_id: "7",
  remote_id: "12",
  status_name: "Closed",
  url: "https://op.example/work_packages/12",
};

describe("synced issue indicators", () => {
  const render = (issue: { tracker?: TrackerLink | null }, lang: "en" | "pl" = "en") =>
    renderToStaticMarkup(
      <I18nProvider initial={lang}>
        <TrackerNotice issue={issue} />
      </I18nProvider>,
    );
  it("links to the remote issue without read-only wording", () => {
    const html = render({ tracker: metadata });
    expect(html).toContain("Synced with OpenProject");
    expect(html).toContain('href="https://op.example/work_packages/12"');
    expect(html).toContain('rel="noreferrer noopener"');
    expect(html).not.toContain("read-only");
    expect(html).not.toContain("Couldn");
  });
  it("shows the last push error and omits unsafe links, in Polish too", () => {
    const html = render(
      { tracker: { ...metadata, url: "javascript:alert(1)", push_error: "Status is not allowed" } },
      "pl",
    );
    expect(html).toContain("Synchronizowane z OpenProject");
    expect(html).toContain("Status is not allowed");
    expect(html).not.toContain("href=");
  });
  it("does not add tracker chrome to local issues", () => {
    expect(render({})).toBe("");
    expect(render({ tracker: null })).toBe("");
  });

  it("reads push errors defensively and names unknown providers by kind", () => {
    expect(trackerPushError({ tracker: metadata })).toBeNull();
    expect(trackerPushError({ tracker: { ...metadata, push_error: "  " } })).toBeNull();
    expect(trackerPushError({ tracker: { ...metadata, push_error: " Rejected " } })).toBe(
      "Rejected",
    );
    expect(trackerProviderName("openproject")).toBe("OpenProject");
    expect(trackerProviderName("jira")).toBe("jira");
  });

  it.each(["javascript:alert(1)", "data:text/html,hello", "/work_packages/12", "invalid"])(
    "does not render unsafe or malformed external URLs: %s",
    (url) => {
      expect(trackerIssueUrl({ tracker: { ...metadata, url } })).toBeNull();
    },
  );
  it("allows private http links as well as https", () => {
    expect(
      trackerIssueUrl({
        tracker: { ...metadata, url: "http://10.0.0.2/work_packages/12" },
      }),
    ).toBe("http://10.0.0.2/work_packages/12");
  });
});

describe("tracker status mapping defaults", () => {
  const stages: Stage[] = [
    { id: "done", name: "Done", kind: "done", position: 3, version: 1 },
    { id: "backlog", name: "Backlog", kind: "backlog", position: 1, version: 1 },
    { id: "active", name: "In progress", kind: "active", position: 2, version: 1 },
  ];
  it("matches names before the open or closed fallback and leaves input order intact", () => {
    expect(
      automaticTrackerStage({ id: "1", name: "IN PROGRESS", is_closed: false }, stages)?.id,
    ).toBe("active");
    expect(automaticTrackerStage({ id: "2", name: "Other", is_closed: false }, stages)?.id).toBe(
      "backlog",
    );
    expect(automaticTrackerStage({ id: "3", name: "Closed", is_closed: true }, stages)?.id).toBe(
      "done",
    );
    expect(stages[0]?.id).toBe("done");
    expect(
      automaticTrackerStage({ id: "4", name: "Other", is_closed: false }, [
        { id: "done", name: "Done", kind: "done", position: 3, version: 1 },
      ])?.id,
    ).toBe("done");
    expect(automaticTrackerStage({ id: "4", name: "Other", is_closed: false }, [])).toBeUndefined();
  });
  it("creates closed statuses as done and new statuses as backlog", () => {
    expect(migratedTrackerStageKind({ id: "1", name: "Closed", is_closed: true })).toBe("done");
    expect(migratedTrackerStageKind({ id: "2", name: " New ", is_closed: false })).toBe("backlog");
    expect(migratedTrackerStageKind({ id: "3", name: "In review", is_closed: false })).toBe(
      "active",
    );
  });
});
