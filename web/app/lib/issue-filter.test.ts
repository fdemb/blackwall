import { describe, expect, it } from "vite-plus/test";
import { makeIssue, makeTeam, NOW } from "../sync/fixtures";
import type { SyncIssue } from "../sync/records";
import { SyncStore } from "../sync/store";
import type { FilterClause, FilterField, FilterOp, FilterValue, IssueFilter } from "./types";
import { filterIssues, matchesSearch, relativeDays } from "./issue-filter";
import { countedIssue } from "./queries";

const id = (n: number) => `11111111-1111-4111-8111-${String(n).padStart(12, "0")}`;
function storeOf(issues: SyncIssue[]) {
  const store = new SyncStore(() => {});
  store.replaceBase({ issues, teams: [makeTeam()] }, ["issues", "teams"]);
  return store;
}
// Clause values must be UUIDs, so the chosen issue uses UUID team and stage ids too.
const chosen = makeIssue(id(1), {
  team_id: id(11),
  stage_id: id(12),
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

const where = (field: FilterField, op: FilterOp, ...values: FilterValue[]): IssueFilter => ({
  where: [{ field, op, values }],
});

describe("issue filter clauses", () => {
  const other = makeIssue(id(9), { team_id: "other", stage_id: "other", priority: "none" });
  const idFields: [FilterField, string][] = [
    ["assignee", id(2)],
    ["created_by", id(3)],
    ["team_id", id(11)],
    ["stage_id", id(12)],
    ["sprint_id", id(4)],
    ["project_id", id(5)],
    ["parent_id", id(6)],
    ["labels", id(7)],
    ["dependencies", id(8)],
  ];
  it.each(idFields)("%s is / is_not select the right rows", (field, value) => {
    const store = storeOf([chosen, other]);
    expect(ids(store, where(field, "is", value))).toEqual([chosen.id]);
    expect(ids(store, where(field, "is", value, id(42)))).toEqual([chosen.id]);
    expect(ids(store, where(field, "is", id(42)))).toEqual([]);
    expect(ids(store, where(field, "is_not", value))).toEqual([other.id]);
    expect(ids(store, where(field, "is_not", id(42)))).toEqual([chosen.id, other.id]);
  });
  it("treats null as an empty field or empty set, and is_not as the exact complement", () => {
    const store = storeOf([chosen, makeIssue(id(9))]);
    for (const field of [
      "assignee",
      "created_by",
      "sprint_id",
      "project_id",
      "parent_id",
      "labels",
      "dependencies",
      "deadline",
    ] as const) {
      expect(ids(store, where(field, "is", null))).toEqual([id(9)]);
      expect(ids(store, where(field, "is_not", null))).toEqual([chosen.id]);
    }
    expect(ids(store, where("assignee", "is", id(2), null))).toEqual([chosen.id, id(9)]);
    expect(ids(store, where("assignee", "is_not", id(2), null))).toEqual([]);
    expect(ids(store, where("assignee", "is_not", id(42)))).toEqual([chosen.id, id(9)]);
  });
  it("ANDs clauses, including contradictory ones", () => {
    const store = storeOf([chosen, makeIssue(id(9))]);
    expect(
      ids(store, {
        where: [
          { field: "assignee", op: "is", values: [id(2)] },
          { field: "labels", op: "is", values: [id(7)] },
          { field: "priority", op: "is", values: ["urgent"] },
        ],
      }),
    ).toEqual([chosen.id]);
    expect(
      ids(store, {
        where: [
          { field: "assignee", op: "is", values: [id(2)] },
          { field: "assignee", op: "is", values: [null] },
        ],
      }),
    ).toEqual([]);
  });
  it("compares priority by rank", () => {
    const store = storeOf([
      chosen,
      makeIssue(id(9), { priority: "high" }),
      makeIssue(id(10), { priority: "none" }),
    ]);
    expect(ids(store, where("priority", "gte", "high"))).toEqual([chosen.id, id(9)]);
    expect(ids(store, where("priority", "gt", "high"))).toEqual([chosen.id]);
    expect(ids(store, where("priority", "lt", "high"))).toEqual([id(10)]);
    expect(ids(store, where("priority", "lte", "high"))).toEqual([id(9), id(10)]);
    expect(ids(store, where("priority", "is", "high", "none"))).toEqual([id(9), id(10)]);
    expect(ids(store, where("priority", "is_not", "none"))).toEqual([chosen.id, id(9)]);
  });
  it("compares estimates and never matches a missing one", () => {
    const store = storeOf([
      makeIssue(id(1), { estimate: 8 }),
      makeIssue(id(2), { estimate: 3 }),
      makeIssue(id(3), { estimate: null }),
    ]);
    expect(ids(store, where("estimate", "gte", "5"))).toEqual([id(1)]);
    expect(ids(store, where("estimate", "lt", "5"))).toEqual([id(2)]);
    expect(ids(store, where("estimate", "is", "3", "8"))).toEqual([id(1), id(2)]);
    expect(ids(store, where("estimate", "is", null))).toEqual([id(3)]);
    expect(ids(store, where("estimate", "is_not", "3"))).toEqual([id(1), id(3)]);
  });
  it("compares timestamps with normalized offsets and precision", () => {
    const store = storeOf([
      chosen,
      makeIssue(id(9)),
      makeIssue(id(10), { deadline: "2026-10-08T12:00:00.000001Z" }),
    ]);
    expect(ids(store, where("deadline", "lte", "2026-10-08T14:00:00+02:00"))).toEqual([chosen.id]);
    expect(ids(store, where("deadline", "gt", "2026-10-08T14:00:00+02:00"))).toEqual([id(10)]);
    expect(ids(store, where("deadline", "lt", "2026-10-08T14:00:00+02:00"))).toEqual([]);
    expect(ids(store, where("deadline", "is", "2026-10-08T14:00:00+02:00"))).toEqual([chosen.id]);
    expect(ids(store, where("created_at", "lte", "2026-10-08T14:00:00+02:00"))).toEqual([
      chosen.id,
      id(9),
      id(10),
    ]);
    expect(ids(store, where("updated_at", "gt", "2026-10-08T12:00:00Z"))).toEqual([]);
  });
  it("resolves relative days to the end of the local day", () => {
    const now = new Date();
    const at = (days: number, hour: number) => {
      const d = new Date(now);
      d.setDate(d.getDate() + days);
      d.setHours(hour, 0, 0, 0);
      return d.toISOString();
    };
    const store = storeOf([
      makeIssue(id(1), { deadline: at(0, 23) }),
      makeIssue(id(2), { deadline: at(1, 1) }),
      makeIssue(id(3), { deadline: at(7, 12) }),
      makeIssue(id(4), { deadline: at(-1, 12) }),
      makeIssue(id(5)),
    ]);
    expect(ids(store, where("deadline", "lte", "+0d"))).toEqual([id(1), id(4)]);
    expect(ids(store, where("deadline", "lte", "+7d"))).toEqual([id(1), id(2), id(3), id(4)]);
    expect(ids(store, where("deadline", "gt", "+0d"))).toEqual([id(2), id(3)]);
    expect(ids(store, where("deadline", "lt", "-1d"))).toEqual([id(4)]);
    expect(relativeDays("+7d")).toBe(7);
    expect(relativeDays("-30d")).toBe(-30);
    expect(relativeDays("0d")).toBe(0);
    expect(relativeDays("7")).toBeUndefined();
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
  it("stage_kind reads the stage and never matches a missing stage", () => {
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
    ]);
    store.applyBase([{ entity: "teams", id: team.id, record: team }]);
    expect(ids(store, where("stage_kind", "is_not", "done", "cancelled"))).toEqual([
      chosen.id,
      id(11),
    ]);
    expect(ids(store, where("stage_kind", "is", "done"))).toEqual([id(9)]);
    expect(ids(store, where("stage_kind", "is", "done", "cancelled"))).toEqual([id(9), id(10)]);
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
  it("normalizes UUID spellings on both sides", () => {
    const target = "abcdefab-cdef-4abc-8def-abcdefabcdef";
    const matching = makeIssue(id(20), {
      assignee: target.toUpperCase(),
      labels: [target.toUpperCase()],
      dependencies: [target],
    });
    const store = storeOf([matching, makeIssue(id(21))]);
    for (const value of [
      target.toUpperCase(),
      `{${target}}`,
      `urn:uuid:${target}`,
      target.replaceAll("-", ""),
    ]) {
      expect(
        ids(store, {
          where: [
            { field: "assignee", op: "is", values: [value] },
            { field: "labels", op: "is", values: [value] },
            { field: "dependencies", op: "is", values: [value] },
          ],
        }),
      ).toEqual([matching.id]);
    }
  });
  it("rejects malformed clauses with the server's messages", () => {
    const store = storeOf([chosen]);
    const cases: [IssueFilter, string][] = [
      [where("assignee", "lt", id(2)), "filter op lt does not apply to assignee"],
      [where("priority", "gte", "high", "low"), "filter comparison takes one non-null value"],
      [where("deadline", "lt", null), "filter comparison takes one non-null value"],
      [where("team_id", "is", null), "filter value null does not apply to team_id"],
      [where("priority", "is", "Urgent"), 'filter value "Urgent" is not valid for priority'],
      [where("stage_kind", "is", "open"), 'filter value "open" is not valid for stage_kind'],
      [where("estimate", "is", "-1"), 'filter value "-1" is not valid for estimate'],
      [
        where("estimate", "is", "4294967296"),
        'filter value "4294967296" is not valid for estimate',
      ],
      [where("deadline", "lte", "tomorrow"), 'filter value "tomorrow" is not valid for deadline'],
      [
        where("deadline", "lte", "2026-10-08T12:00:00"),
        'filter value "2026-10-08T12:00:00" is not valid for deadline',
      ],
      [
        where("deadline", "lte", "+99999-01-01T00:00:00Z"),
        'filter value "+99999-01-01T00:00:00Z" is not valid for deadline',
      ],
      [where("assignee", "is", "nope"), 'filter value "nope" is not valid for assignee'],
      [where("assignee", "is"), "filter clause needs 1 to 200 values"],
      [
        where("assignee", "is", ...Array<string>(201).fill(id(1))),
        "filter clause needs 1 to 200 values",
      ],
      [
        { where: Array<FilterClause>(33).fill({ field: "priority", op: "is", values: ["high"] }) },
        "filter has at most 32 clauses",
      ],
    ];
    for (const [filter, message] of cases) {
      expect(() => ids(store, filter), JSON.stringify(filter)).toThrow(message);
    }
  });
  it("treats serde null option fields as unset for server-saved view filters", () => {
    const store = storeOf([chosen, makeIssue(id(9))]);
    expect(
      filterIssues(store, {
        where: [],
        ids: null,
        search: null,
        sort: null,
        group_by: null,
        after: null,
        projection: null,
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
    "%",
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
  ])("does not match %j", (search) => {
    expect(matchesSearch(issue, search)).toBe(false);
  });
  it("treats SQL wildcards literally and requires every search word", () => {
    expect(matchesSearch(makeIssue(id(2), { title: "any title" }), "%")).toBe(false);
    expect(matchesSearch(makeIssue(id(2), { title: "any title" }), "_")).toBe(false);
    expect(matchesSearch(makeIssue(id(2), { title: "Fix widget" }), "Fix & widget")).toBe(true);
    expect(matchesSearch(makeIssue(id(2), { title: "blue red" }), "red blue")).toBe(true);
    expect(matchesSearch(makeIssue(id(2), { title: "red" }), "red blue")).toBe(false);
    expect(matchesSearch(makeIssue(id(2), { title: "red blue" }), "red-blue")).toBe(true);
    expect(matchesSearch(makeIssue(id(2), { title: "bar foo" }), "foo_bar")).toBe(true);
  });
  it("splits URLs, emails, versions, and tags into words", () => {
    expect(matchesSearch(makeIssue(id(2), { title: "https://example.com/a" }), "example.com")).toBe(
      true,
    );
    expect(matchesSearch(makeIssue(id(2), { title: "https://example.com/a" }), "/a")).toBe(true);
    expect(
      matchesSearch(makeIssue(id(2), { title: "Contact user@example.com" }), "user example"),
    ).toBe(true);
    expect(matchesSearch(makeIssue(id(2), { title: "Install 1.2.3" }), "3 2")).toBe(true);
    expect(matchesSearch(makeIssue(id(2), { title: "changed 2026-10-09" }), "-09 2026")).toBe(true);
    expect(matchesSearch(makeIssue(id(2), { title: "3.14e+10 value" }), "value 3.14e+10")).toBe(
      true,
    );
    expect(matchesSearch(makeIssue(id(2), { title: "<b>Widget</b>" }), "b widget")).toBe(true);
  });
  it.each([
    ["foo+bar@example.com Contact", "Contact foo", true],
    ["&amp; entity", "amp entity", true],
    ["abc-123-def", "def -123", true],
    ["a-b-1", "1 a-b", true],
    ["foo123-bar", "bar foo123", true],
    ["naïve—test foo😀bar", "test naïve", true],
    ["naïve—test foo😀bar", "bar foo", true],
    ["Café au lait", "cafe", false],
    ["ΟΣΟ", "ΟΣ", true],
    ["ΟΣ", "ΟΣΟ", false],
  ] as const)("matches %j against %j by words", (title, search, expected) => {
    expect(matchesSearch(makeIssue(id(2), { title, number: null }), search)).toBe(expected);
  });
  it("limits UTF-8 query bytes and keeps search conjunctive with visibility and other filters", () => {
    const store = storeOf([issue, makeIssue(id(2), { title: issue.title, deleted_at: NOW })]);
    expect(
      ids(store, { search: "Widget", where: [{ field: "priority", op: "is", values: ["none"] }] }),
    ).toEqual([]);
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
