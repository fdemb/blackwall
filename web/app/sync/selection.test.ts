import { describe, expect, it, vi } from "vite-plus/test";
import { makeIssue, makeTeam } from "./fixtures";
import { SyncStore } from "./store";
import { createSelection, shallowEqual } from "./selection";

describe("shallowEqual", () => {
  it("compares arrays by element identity, including empty arrays and NaN", () => {
    const record = { id: "a" };
    expect(shallowEqual([record, NaN], [record, NaN])).toBe(true);
    expect(shallowEqual([], [])).toBe(true);
    expect(shallowEqual([record], [{ id: "a" }])).toBe(false);
    expect(shallowEqual([record], [record, record])).toBe(false);
    expect(shallowEqual([0], [-0])).toBe(false);
  });
  it("compares object own fields without recursively comparing records", () => {
    const record = { id: "a" };
    expect(shallowEqual({ record }, { record })).toBe(true);
    expect(shallowEqual({ record }, { record: { id: "a" } })).toBe(false);
    expect(shallowEqual({ a: undefined }, { b: undefined })).toBe(false);
    expect(shallowEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(shallowEqual(null, {})).toBe(false);
    expect(shallowEqual([], {})).toBe(false);
    expect(shallowEqual("a", "a")).toBe(true);
    expect(shallowEqual(1, "1")).toBe(false);
  });
});

describe("selection memoization", () => {
  it("gates selection on every declared entity version and ignores pending bookkeeping", () => {
    const store = new SyncStore(() => {});
    store.replaceBase({ issues: [makeIssue("a")], teams: [makeTeam()] }, ["issues", "teams"]);
    const select = vi.fn((view: SyncStore) => view.all("issues").map((row) => row.title));
    const snapshot = createSelection(store, select, ["issues", "teams"]);
    const first = snapshot();
    expect(snapshot()).toBe(first);
    store.applyBase([
      { entity: "labels", id: "l", record: { id: "l", name: "Label", color: "red", version: 1 } },
    ]);
    store.setPending([]);
    expect(snapshot()).toBe(first);
    expect(select).toHaveBeenCalledTimes(1);
    store.applyBase([
      { entity: "teams", id: "team-1", record: { ...makeTeam(), name: "Changed" } },
    ]);
    expect(snapshot()).toBe(first);
    expect(select).toHaveBeenCalledTimes(2);
    store.applyBase([{ entity: "issues", id: "a", record: makeIssue("a", { title: "Changed" }) }]);
    expect(snapshot()).toEqual(["Changed"]);
    expect(select).toHaveBeenCalledTimes(3);
  });
  it("retains an array when another row changes and replaces it when a selected record changes", () => {
    const store = new SyncStore(() => {});
    store.replaceBase({ issues: [makeIssue("a"), makeIssue("b")] }, ["issues"]);
    const snapshot = createSelection(store, (view) => [view.get("issues", "a")], ["issues"]);
    const first = snapshot();
    store.applyBase([
      { entity: "issues", id: "b", record: makeIssue("b", { title: "Elsewhere" }) },
    ]);
    expect(snapshot()).toBe(first);
    store.applyBase([{ entity: "issues", id: "a", record: makeIssue("a", { title: "Selected" }) }]);
    expect(snapshot()).not.toBe(first);
  });
  it("retains shallowly equal results across dependency changes", () => {
    const store = new SyncStore(() => {});
    store.replaceBase({ issues: [makeIssue("a")] }, ["issues"]);
    const first = createSelection(store, (view) => [...view.all("issues")], ["issues"])();
    const changed = createSelection(store, (view) => [...view.all("issues")], ["issues"], {
      value: first,
    });
    expect(changed()).toBe(first);
  });
  it("retains scalar and object snapshots without repeatedly executing select", () => {
    const store = new SyncStore(() => {});
    const object = createSelection(store, () => ({ size: store.all("issues").length }), ["issues"]);
    const initial = object();
    store.replaceBase({ issues: [] }, ["issues"]);
    expect(object()).toBe(initial);
    expect(createSelection(store, () => 0, [])()).toBe(0);
  });
});
