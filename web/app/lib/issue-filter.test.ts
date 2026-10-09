import { describe, expect, it } from "vite-plus/test";
import { makeIssue, makeTeam, NOW } from "../sync/fixtures";
import type { SyncIssue } from "../sync/records";
import { SyncStore } from "../sync/store";
import type { IssueFilter } from "./types";
import { filterIssues, matchesSearch } from "./issue-filter";
import { countedIssue } from "./queries";

const id = (n: number) => `11111111-1111-4111-8111-${String(n).padStart(12, "0")}`;
function storeOf(issues: SyncIssue[]) {
  const store = new SyncStore(() => {});
  store.replaceBase({ issues, teams: [makeTeam()] }, ["issues", "teams"]);
  return store;
}
const chosen = makeIssue(id(1), {
  assignee: id(2),
  created_by: id(3),
  sprint_id: id(4),
  project_id: id(5),
  parent_id: id(6),
  labels: [id(7)],
  dependencies: [id(8)],
  priority: "urgent",
  deadline: NOW,
});
const ids = (store: SyncStore, filter: IssueFilter = {}) =>
  filterIssues(store, filter).map((issue) => issue.id);

describe("issue filter SQL predicates", () => {
  const equality: [keyof IssueFilter, string][] = [
    ["assignee", id(2)],
    ["created_by", id(3)],
    ["team_id", "team-1"],
    ["stage_id", "stage-todo"],
    ["sprint_id", id(4)],
    ["project_id", id(5)],
    ["parent_id", id(6)],
    ["priority", "urgent"],
    ["label_id", id(7)],
    ["dependency_id", id(8)],
  ];
  it.each(equality)("matches %s and excludes a different value", (field, value) => {
    const other = makeIssue(id(9), { team_id: "other", stage_id: "other", priority: "none" });
    const store = storeOf([chosen, other]);
    expect(ids(store, { [field]: value })).toEqual([chosen.id]);
    expect(ids(store, { [field]: "missing" })).toEqual([]);
  });
  it("ANDs filters, including contradictory assignee and sprint null checks", () => {
    const store = storeOf([chosen, makeIssue(id(9))]);
    expect(ids(store, { assignee: id(2), label_id: id(7), priority: "urgent" })).toEqual([
      chosen.id,
    ]);
    expect(ids(store, { assignee: id(2), unassigned: true })).toEqual([]);
    expect(ids(store, { sprint_id: id(4), no_sprint: true })).toEqual([]);
    expect(ids(store, { unassigned: true, no_sprint: true })).toEqual([id(9)]);
  });
  it("uses an inclusive due_before with normalized offsets and excludes null deadlines", () => {
    const store = storeOf([
      chosen,
      makeIssue(id(9)),
      makeIssue(id(10), { deadline: "2026-10-08T12:00:00.000001Z" }),
    ]);
    expect(ids(store, { due_before: "2026-10-08T14:00:00+02:00" })).toEqual([chosen.id]);
  });
  it("defaults to live unarchived issues and gives trash precedence over archive", () => {
    const store = storeOf([
      chosen,
      makeIssue(id(9), { archived_at: NOW }),
      makeIssue(id(10), { deleted_at: NOW }),
      makeIssue(id(11), { deleted_at: NOW, archived_at: NOW }),
    ]);
    expect(ids(store)).toEqual([chosen.id]);
    expect(ids(store, { archived: true })).toEqual([id(9)]);
    expect(ids(store, { trash: true })).toEqual([id(10), id(11)]);
    expect(ids(store, { trash: true, archived: true })).toEqual([id(10), id(11)]);
    expect(ids(store, { trash: false, archived: false })).toEqual([chosen.id]);
  });
  it("open uses stage kind and excludes missing, done, and cancelled stages", () => {
    const team = makeTeam();
    team.stages.push({
      id: "cancelled",
      name: "Cancelled",
      kind: "cancelled",
      position: 2,
      version: 1,
    });
    const store = storeOf([
      chosen,
      makeIssue(id(9), { stage_id: "stage-done" }),
      makeIssue(id(10), { stage_id: "cancelled" }),
      makeIssue(id(11), { stage_id: "missing" }),
      makeIssue(id(12), { done_at: NOW }),
    ]);
    store.applyBase([{ entity: "teams", id: team.id, record: team }]);
    expect(ids(store, { open: true })).toEqual([chosen.id, id(12)]);
  });
  it("ids matches the supplied UUID set, including duplicate and uppercase values", () => {
    const store = storeOf([chosen, makeIssue(id(9)), makeIssue(id(10))]);
    expect(ids(store, { ids: `${id(9)},${id(1).toUpperCase()},${id(9)}` })).toEqual([id(1), id(9)]);
    expect(
      ids(store, { ids: `{${id(9)}},urn:uuid:${id(1)},${id(9).replaceAll("-", "")}` }),
    ).toEqual([id(1), id(9)]);
    expect(() => ids(store, { ids: "" })).toThrow("comma-separated UUIDs");
    expect(() => ids(store, { ids: `${id(1)},bad` })).toThrow("comma-separated UUIDs");
    expect(() => ids(store, { ids: Array(201).fill(id(1)).join(",") })).toThrow("at most 200");
  });
  it("treats serde null option fields as unset for server-saved view filters", () => {
    const store = storeOf([chosen, makeIssue(id(9))]);
    expect(
      filterIssues(store, {
        assignee: null,
        created_by: null,
        team_id: null,
        stage_id: null,
        priority: null,
        label_id: null,
        sprint_id: null,
        project_id: null,
        parent_id: null,
        dependency_id: null,
        ids: null,
        due_before: null,
        search: null,
        sort: null,
        group_by: null,
      }).map((issue) => issue.id),
    ).toEqual([chosen.id, id(9)]);
  });
  it("returns the whole local list regardless of REST projection and paging metadata", () => {
    const store = storeOf([chosen, makeIssue(id(9))]);
    expect(
      ids(store, {
        projection: "summary",
        sort: "updated",
        after: "server-cursor",
        group_by: "none",
      }),
    ).toEqual([id(1), id(9)]);
  });
});

describe("issue SQL ordering", () => {
  it("position orders by position, number, then UUID and puts unconfirmed numbers last", () => {
    const store = storeOf([
      makeIssue(id(4), { position: 0, number: null }),
      makeIssue(id(3), { position: 0, number: 2 }),
      makeIssue(id(2), { position: 0, number: 2 }),
      makeIssue(id(1), { position: 1, number: 1 }),
    ]);
    expect(ids(store)).toEqual([id(2), id(3), id(4), id(1)]);
  });
  it("deadline orders ascending nulls last, then position and UUID", () => {
    const store = storeOf([
      makeIssue(id(4)),
      makeIssue(id(3), { deadline: NOW, position: 1 }),
      makeIssue(id(2), { deadline: NOW }),
      makeIssue(id(1), { deadline: NOW }),
    ]);
    expect(ids(store, { sort: "deadline" })).toEqual([id(1), id(2), id(3), id(4)]);
  });
  it("updated orders descending UTC timestamps and ascending UUID at ties", () => {
    const store = storeOf([
      makeIssue(id(3), { updated_at: "2026-10-08T14:00:00+02:00" }),
      makeIssue(id(2), { updated_at: "2026-10-08T12:00:00.000001Z" }),
      makeIssue(id(1)),
    ]);
    expect(ids(store, { sort: "updated" })).toEqual([id(2), id(1), id(3)]);
  });
  it("priority ranks urgent through none, then position and UUID", () => {
    const store = storeOf([
      makeIssue(id(7), { priority: "none" }),
      makeIssue(id(6), { priority: "low" }),
      makeIssue(id(5), { priority: "normal" }),
      makeIssue(id(4), { priority: "high" }),
      makeIssue(id(3), { priority: "urgent", position: 1 }),
      makeIssue(id(2), { priority: "urgent" }),
      makeIssue(id(1), { priority: "urgent" }),
    ]);
    expect(ids(store, { sort: "priority" })).toEqual([1, 2, 3, 4, 5, 6, 7].map(id));
  });
  it.each(["stage", "priority", "assignee"] as const)(
    "prefixes %s groups before the requested sort",
    (group_by) => {
      const store = storeOf([
        makeIssue(id(1), { stage_id: "z", priority: "none", assignee: null, position: 0 }),
        makeIssue(id(2), { stage_id: "b", priority: "high", assignee: id(4), position: 1 }),
        makeIssue(id(3), { stage_id: "a", priority: "urgent", assignee: id(3), position: 2 }),
      ]);
      expect(ids(store, { group_by, sort: "position" })).toEqual([id(3), id(2), id(1)]);
      expect(ids(store, { group_by: "none" })).toEqual([id(1), id(2), id(3)]);
    },
  );
});

describe("issue SQL search", () => {
  const issue = makeIssue(id(1), {
    title: "Fix the red Widget",
    description: "blue failure 100% foo_bar \\path naïve-test",
    number: 42,
  });
  it.each([
    "widget",
    "WIDGET",
    "failure",
    "red blue",
    "blue red",
    "the fix",
    "100%",
    "foo_bar",
    "\\path",
    "naïve",
    "naïve-test",
    "42",
    "#42",
    "###42",
    "",
    " \t ",
  ])(
    "matches %j through literal substring, simple lexemes, or canonical issue number",
    (search) => {
      expect(matchesSearch(issue, search)).toBe(true);
    },
  );
  it.each([
    "widgets",
    "red green",
    "0042",
    "#0042",
    "+42",
    "42 ",
    "#0",
    "-42",
    "9223372036854775808",
    "f.o.o",
    "%",
  ])("does not match %j", (search) => {
    expect(matchesSearch(issue, search)).toBe(false);
  });
  it("treats SQL wildcards literally and requires all full text lexemes", () => {
    expect(matchesSearch(makeIssue(id(2), { title: "any title" }), "%")).toBe(false);
    expect(matchesSearch(makeIssue(id(2), { title: "any title" }), "_")).toBe(false);
    expect(matchesSearch(makeIssue(id(2), { title: "Fix widget" }), "Fix & widget")).toBe(true);
    expect(matchesSearch(makeIssue(id(2), { title: "blue red" }), "red blue")).toBe(true);
    expect(matchesSearch(makeIssue(id(2), { title: "red" }), "red blue")).toBe(false);
    expect(matchesSearch(makeIssue(id(2), { title: "red blue" }), "red-blue")).toBe(false);
    expect(matchesSearch(makeIssue(id(2), { title: "bar foo" }), "foo_bar")).toBe(true);
  });
  it("matches PostgreSQL simple parser email, URL, version, and signed-number lexemes", () => {
    expect(matchesSearch(makeIssue(id(2), { title: "https://example.com/a" }), "example.com")).toBe(
      true,
    );
    expect(matchesSearch(makeIssue(id(2), { title: "https://example.com/a" }), "/a")).toBe(true);
    expect(
      matchesSearch(makeIssue(id(2), { title: "Contact user@example.com" }), "user example"),
    ).toBe(false);
    expect(matchesSearch(makeIssue(id(2), { title: "Install 1.2.3" }), "3 2")).toBe(false);
    expect(matchesSearch(makeIssue(id(2), { title: "changed 2026-10-09" }), "-09 2026")).toBe(true);
    expect(matchesSearch(makeIssue(id(2), { title: "3.14e+10 value" }), "value 3.14e+10")).toBe(
      true,
    );
    expect(matchesSearch(makeIssue(id(2), { title: "<b>Widget</b>" }), "b widget")).toBe(false);
  });
  it.each([
    ["foo+bar@example.com Contact", "Contact foo", true],
    ["&amp; entity", "amp entity", false],
    ["abc-123-def", "def -123", true],
    ["a-b-1", "1 a-b", true],
    ["foo123-bar", "bar foo123", true],
    ["naïve—test foo😀bar", "test naïve", false],
    ["naïve—test foo😀bar", "bar foo", false],
  ] as const)("matches PostgreSQL parsing of %j for %j", (title, search, expected) => {
    expect(matchesSearch(makeIssue(id(2), { title, number: null }), search)).toBe(expected);
  });
  it("limits UTF-8 query bytes and keeps search conjunctive with visibility and other filters", () => {
    const store = storeOf([issue, makeIssue(id(2), { title: issue.title, deleted_at: NOW })]);
    expect(ids(store, { search: "Widget", priority: "urgent" })).toEqual([]);
    expect(ids(store, { search: "Widget", trash: true })).toEqual([id(2)]);
    expect(() => ids(store, { search: "é".repeat(101) })).toThrow("search query too long");
    expect(ids(store, { search: "x".repeat(200) })).toEqual([]);
    expect(matchesSearch({ ...issue, number: null }, "#42")).toBe(false);
  });
});

describe("derived UI issue identity", () => {
  it("retains unaffected rows and refreshes counts when children, dependencies, or stage kinds change", () => {
    const store = storeOf([
      makeIssue(id(1), { dependencies: [id(2)] }),
      makeIssue(id(2)),
      makeIssue(id(3), { parent_id: id(1) }),
      makeIssue(id(4)),
    ]);
    const initial = countedIssue(store, id(1));
    const unaffected = countedIssue(store, id(4));
    expect(initial).toMatchObject({ blocked_count: 1, subtask_total: 1, subtask_completed: 0 });
    store.applyBase([
      {
        entity: "issues",
        id: id(3),
        record: makeIssue(id(3), { parent_id: id(1), stage_id: "stage-done" }),
      },
    ]);
    expect(countedIssue(store, id(1))).toMatchObject({ subtask_completed: 1 });
    expect(countedIssue(store, id(4))).toBe(unaffected);
    const team = makeTeam();
    team.stages[0].kind = "done";
    store.applyBase([{ entity: "teams", id: team.id, record: team }]);
    expect(countedIssue(store, id(1))).toMatchObject({
      blocked_count: 0,
      subtask_total: 1,
      subtask_completed: 1,
    });
    expect(countedIssue(store, id(4))).toBe(unaffected);
  });
});
