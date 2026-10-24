import { describe, expect, it } from "vite-plus/test";
import type { MutatorName } from "./index";
import { MUTATORS, normalizeArgs } from "./index";

const ID = "00000000-0000-4000-8000-000000000001";
const AT = "2026-10-09T12:00:00Z";
const patchDefaults = {
  clear_assignee: false,
  clear_estimate: false,
  clear_deadline: false,
  clear_project: false,
  clear_milestone: false,
  clear_sprint: false,
  clear_parent: false,
};
const filterDefaults = {
  where: [],
  ids: null,
  search: null,
  trash: false,
  archived: false,
  sort: "position",
  group_by: null,
  after: null,
  projection: "full",
};
const inputOptions = {
  id: null,
  stage_id: null,
  assignee: null,
  estimate: null,
  deadline: null,
  project_id: null,
  milestone_id: null,
  sprint_id: null,
  parent_id: null,
};
const patchOptions = {
  title: null,
  description: null,
  stage_id: null,
  assignee: null,
  priority: null,
  labels: null,
  estimate: null,
  deadline: null,
  project_id: null,
  milestone_id: null,
  sprint_id: null,
  parent_id: null,
  dependencies: null,
};
const filterOptions = Object.fromEntries(
  Object.entries(filterDefaults).filter(([, value]) => value === null),
);
interface Case {
  args: Record<string, unknown>;
  options?: Record<string, unknown>;
  defaults?: Record<string, unknown>;
  explicit?: Record<string, unknown>;
}
const id = { args: { id: ID } };

// Independently list every registered command's minimal Rust input and every
// Option field, checked against Rust deserialization during implementation.
const CASES = {
  create_team: {
    args: { name: "Team" },
    options: { id: null, default_stage_ids: null },
    defaults: { members: [] },
  },
  set_team_members: { args: { id: ID, members: [] } },
  set_team_archive: {
    args: { id: ID },
    options: { archive_after_days: null },
    defaults: { archive_after_days: 30 },
    explicit: { archive_after_days: null },
  },
  set_team_appearance: { args: { id: ID, icon: "users", color: "violet" } },
  create_stage: {
    args: { team_id: ID, name: "Stage", kind: "backlog", position: 0 },
    options: { id: null },
  },
  update_stage: { args: { team_id: ID, id: ID, name: "Stage", kind: "backlog", position: 0 } },
  delete_stage: { args: { team_id: ID, id: ID, replacement: ID } },
  create_label: { args: { name: "Label", color: "red" }, options: { id: null } },
  update_label: { args: { id: ID, name: "Label", color: "red" } },
  create_project: {
    args: { name: "Project", team_ids: [] },
    options: { id: null },
    defaults: { description: "" },
  },
  update_project: { args: { id: ID, name: "Project", description: "", team_ids: [] } },
  create_milestone: {
    args: { project_id: ID, name: "Milestone" },
    options: { id: null, deadline: null },
  },
  update_milestone: { args: { id: ID, name: "Milestone" }, options: { deadline: null } },
  create_sprint: {
    args: { team_id: ID, name: "Sprint", goal: "", starts_at: AT, ends_at: AT },
    options: { id: null },
  },
  update_sprint: {
    args: { id: ID, name: "Sprint", goal: "", starts_at: AT, ends_at: AT, state: "planned" },
  },
  complete_sprint: { args: { id: ID }, options: { carryover_sprint_id: null } },
  archive_sprint: id,
  create_issue: {
    args: { input: { title: "Issue", team_id: ID } },
    options: { input: inputOptions },
    defaults: { input: { description: "", priority: "none", labels: [], dependencies: [] } },
  },
  update_issue: {
    args: { id: ID, patch: {} },
    options: { patch: patchOptions },
    defaults: { patch: patchDefaults },
  },
  move_issue: { args: { id: ID, stage_id: ID }, options: { before_id: null } },
  bulk_issues: {
    args: { ids: [], action: { update: {} } },
    options: { action: { update: patchOptions } },
    defaults: { action: { update: patchDefaults } },
  },
  delete_issue: id,
  restore_issue: id,
  archive_issue: id,
  unarchive_issue: id,
  remove_attachment: { args: { issue_id: ID, attachment_id: ID } },
  add_comment: {
    args: { issue_id: ID, body: "Comment" },
    options: { id: null },
    defaults: { mentions: [], attachments: [] },
  },
  edit_comment: { args: { id: ID, body: "Comment" }, defaults: { mentions: [] } },
  delete_comment: id,
  follow: { args: { issue_id: ID, following: true } },
  log_time: {
    args: { issue_id: ID, minutes: 15, logged_at: AT },
    options: { id: null },
    defaults: { note: "" },
  },
  update_time: { args: { id: ID, minutes: 15, note: "", logged_at: AT } },
  delete_time: id,
  save_view: {
    args: { name: "View", shared: false, filter: {} },
    options: { id: null, filter: filterOptions },
    defaults: { filter: filterDefaults },
  },
  update_view: {
    args: { id: ID, name: "View", shared: false, filter: {} },
    options: { filter: filterOptions },
    defaults: { filter: filterDefaults },
  },
  delete_view: id,
  cancel_invitation: id,
  mark_notification_read: { args: { id: ID, created_at: AT } },
  mark_notification_unread: id,
  mark_all_notifications_read: { args: { notifications: [{ id: ID, created_at: AT }] } },
  configure_alerts: {
    args: { assignment: true, reply: true, change: true, mention: true, deadline: true },
  },
  update_integration: { args: { id: ID, enabled: true } },
  delete_integration: id,
  add_source_link: { args: { issue_id: ID, url: "https://example.com", title: "Source" } },
} satisfies Record<MutatorName, Case>;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function merge(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): Record<string, unknown> {
  const out = structuredClone(left);
  for (const [key, value] of Object.entries(right)) {
    const old = out[key];
    out[key] = isObject(old) && isObject(value) ? merge(old, value) : structuredClone(value);
  }
  return out;
}

const cases: Record<MutatorName, Case> = CASES;
describe("command argument normalization", () => {
  it("walks every registered command with minimal args and every explicit Option null", () => {
    expect(Object.keys(cases).sort()).toEqual(Object.keys(MUTATORS).sort());
    for (const [name, test] of Object.entries(cases)) {
      const expected = merge(test.args, test.defaults ?? {});
      expect(normalizeArgs(name, test.args), name).toEqual(expected);
      const explicit = merge(test.args, test.options ?? {});
      expect(normalizeArgs(name, explicit), `${name} nulls`).toEqual(
        merge(expected, test.explicit ?? {}),
      );
      expect(normalizeArgs(name, normalizeArgs(name, explicit)), `${name} twice`).toEqual(
        merge(expected, test.explicit ?? {}),
      );
    }
  });

  it("rejects null on fields with non-Option defaults rather than applying the absent default", () => {
    for (const [name, test] of Object.entries(cases)) {
      for (const [field, value] of Object.entries(test.defaults ?? {})) {
        if (name === "set_team_archive") continue;
        if (isObject(value)) {
          for (const [nested, fallback] of Object.entries(value)) {
            if (fallback === null) continue;
            const args = merge(test.args, { [field]: { [nested]: null } });
            expect(() => normalizeArgs(name, args), `${name}.${field}.${nested}`).toThrow();
          }
        } else {
          expect(
            () => normalizeArgs(name, { ...test.args, [field]: null }),
            `${name}.${field}`,
          ).toThrow();
        }
      }
    }
  });

  it("normalizes nested arrays and ignores unknown fields without stripping array nulls", () => {
    expect(
      normalizeArgs("add_comment", {
        issue_id: ID,
        body: "C",
        attachments: [{ id: ID, name: "a", content_type: "text/plain", size: 1, extra: null }],
        extra: "ignored",
      }),
    ).toEqual({
      issue_id: ID,
      body: "C",
      mentions: [],
      attachments: [{ id: ID, name: "a", content_type: "text/plain", size: 1 }],
    });
    expect(
      normalizeArgs("import_issues", {
        issues: [{ title: "I", team_id: ID, assignee: null }, null],
      }),
    ).toEqual({
      issues: [
        {
          title: "I",
          team_id: ID,
          description: "",
          priority: "none",
          labels: [],
          dependencies: [],
        },
        null,
      ],
    });
    expect(normalizeArgs("update_issue", { id: ID, patch: { labels: [null] } })).toEqual({
      id: ID,
      patch: { ...patchDefaults, labels: [null] },
    });
  });

  it("canonicalizes filter defaults and keeps clause values as sent", () => {
    const where = [
      { field: "deadline", op: "lte", values: ["2026-10-09T15:30:00.123456+02:00"], extra: 1 },
      { field: "assignee", op: "is", values: [ID, null] },
    ];
    for (const name of ["save_view", "update_view"]) {
      expect(
        normalizeArgs(name, {
          id: ID,
          name: "View",
          shared: false,
          filter: { where, unknown: true },
        }),
      ).toEqual({
        id: ID,
        name: "View",
        shared: false,
        filter: {
          ...filterDefaults,
          where: [
            { field: "deadline", op: "lte", values: ["2026-10-09T15:30:00.123456+02:00"] },
            { field: "assignee", op: "is", values: [ID, null] },
          ],
        },
      });
    }
    expect(() =>
      normalizeArgs("save_view", { name: "V", shared: false, filter: { where: null } }),
    ).toThrow("where cannot be null");
  });

  it("does not default required objects and does not share mutable defaults", () => {
    expect(normalizeArgs("save_view", { name: "V", shared: false })).toEqual({
      name: "V",
      shared: false,
    });
    expect(() => normalizeArgs("save_view", { name: "V", shared: false, filter: null })).toThrow();
    const first = normalizeArgs("add_comment", { issue_id: ID, body: "C" });
    const second = normalizeArgs("add_comment", { issue_id: ID, body: "C" });
    expect(first).toEqual(second);
    if (!isObject(first) || !isObject(second)) throw new Error("missing args");
    expect(first.attachments).not.toBe(second.attachments);
  });
});
