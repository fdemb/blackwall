import { describe, expect, expectTypeOf, it } from "vite-plus/test";
import { blockedCount, subtaskCompleted, subtaskTotal, withCounts } from "./derived";
import { makeIssue, makeTeam, NOW, testReplay } from "./fixtures";
import { SyncStore } from "./store";

/** Guards type-level assertions so tsc checks them without running them. */
function unreached(): boolean {
  return false;
}

function countedStore(): SyncStore {
  const store = new SyncStore(testReplay);
  store.replaceBase(
    {
      teams: [makeTeam()],
      issues: [
        makeIssue("parent", { dependencies: ["dep-open", "dep-done", "dep-deleted"] }),
        makeIssue("child-open", { parent_id: "parent", stage_id: "stage-todo" }),
        makeIssue("child-done", { parent_id: "parent", stage_id: "stage-done" }),
        makeIssue("child-deleted", {
          parent_id: "parent",
          stage_id: "stage-todo",
          deleted_at: "2026-10-08T12:00:00.000Z",
        }),
        makeIssue("dep-open", { stage_id: "stage-todo" }),
        makeIssue("dep-done", { stage_id: "stage-done" }),
        makeIssue("dep-deleted", {
          stage_id: "stage-todo",
          deleted_at: "2026-10-08T12:00:00.000Z",
        }),
      ],
    },
    ["teams", "issues"],
  );
  return store;
}

describe("derived counts", () => {
  it("matches the server definitions", () => {
    const store = countedStore();
    expect(blockedCount(store, "parent")).toBe(1);
    expect(subtaskTotal(store, "parent")).toBe(2);
    expect(subtaskCompleted(store, "parent")).toBe(1);
  });

  it("returns zero for a missing issue", () => {
    const store = countedStore();
    expect(blockedCount(store, "ghost")).toBe(0);
    expect(subtaskTotal(store, "ghost")).toBe(0);
    expect(subtaskCompleted(store, "ghost")).toBe(0);
  });

  it("follows stage-kind changes on the team", () => {
    const store = countedStore();
    const team = { ...makeTeam(), stages: makeTeam().stages.map((stage) => ({ ...stage })) };
    team.stages[0] = { ...team.stages[0], id: "stage-todo", kind: "done" };
    store.applyBase([{ entity: "teams", id: "team-1", record: team }]);
    expect(blockedCount(store, "parent")).toBe(0);
    expect(subtaskCompleted(store, "parent")).toBe(2);
    expect(subtaskTotal(store, "parent")).toBe(2);
  });

  it("withCounts returns the UI issue shape", () => {
    const store = countedStore();
    const parent = store.get("issues", "parent");
    if (parent === undefined) throw new Error("missing parent");
    const full = withCounts(store, parent);
    expect(full).toMatchObject({
      id: "parent",
      title: "Issue parent",
      blocked_count: 1,
      subtask_total: 2,
      subtask_completed: 1,
    });
  });

  it("N6: withCounts returns a readonly counted issue with a nullable number", () => {
    const store = countedStore();
    const parent = store.get("issues", "parent");
    if (parent === undefined) throw new Error("missing parent");
    const counted = withCounts(store, parent);
    expectTypeOf(counted.number).toEqualTypeOf<number | null>();
    expectTypeOf(counted.dependencies).toEqualTypeOf<readonly string[]>();
    expect(counted.blocked_count).toBe(1);
    if (unreached()) {
      // @ts-expect-error - counted.number.toFixed() throws while the number is null
      counted.number.toFixed();
      // @ts-expect-error - counted issues are readonly
      counted.title = "changed";
      // @ts-expect-error - dependencies are a frozen readonly array
      counted.dependencies.push("x");
    }
  });

  it("F1: soft-deleting a child refreshes subtaskTotal", () => {
    const store = new SyncStore(testReplay);
    store.replaceBase(
      {
        teams: [makeTeam()],
        issues: [makeIssue("parent"), makeIssue("child", { parent_id: "parent" })],
      },
      ["teams", "issues"],
    );
    expect(subtaskTotal(store, "parent")).toBe(1);
    store.applyBase([
      {
        entity: "issues",
        id: "child",
        record: { ...makeIssue("child", { parent_id: "parent" }), deleted_at: NOW },
      },
    ]);
    expect(subtaskTotal(store, "parent")).toBe(0);
  });

  it("F1: completing a child refreshes subtaskCompleted", () => {
    const store = new SyncStore(testReplay);
    store.replaceBase(
      {
        teams: [makeTeam()],
        issues: [makeIssue("parent"), makeIssue("child", { parent_id: "parent" })],
      },
      ["teams", "issues"],
    );
    expect(subtaskCompleted(store, "parent")).toBe(0);
    store.applyBase([
      {
        entity: "issues",
        id: "child",
        record: { ...makeIssue("child", { parent_id: "parent" }), stage_id: "stage-done" },
      },
    ]);
    expect(subtaskCompleted(store, "parent")).toBe(1);
  });

  it("G2: unknown stage kinds are not counted as blocked", () => {
    const store = new SyncStore(testReplay);
    store.replaceBase(
      {
        teams: [makeTeam()],
        issues: [
          makeIssue("parent", { dependencies: ["mystery"] }),
          makeIssue("mystery", { stage_id: "stage-unknown" }),
        ],
      },
      ["teams", "issues"],
    );
    expect(blockedCount(store, "parent")).toBe(0);
  });
});
