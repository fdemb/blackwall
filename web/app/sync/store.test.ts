import { describe, expect, expectTypeOf, it } from "vite-plus/test";
import { makeIssue, makeTeam, NOW, testReplay } from "./fixtures";
import { BOOTSTRAP_ENTITIES, keyOf, normalize } from "./records";
import type { ChangeSet, DeepReadonly, PendingMutation, ReplayFn, Tx } from "./store";
import { SyncStore } from "./store";

function collect(store: SyncStore): { events: ChangeSet[]; stop: () => void } {
  const events: ChangeSet[] = [];
  const stop = store.subscribe((change) => events.push(change));
  return { events, stop };
}

/** Guards type-level assertions so tsc checks them without running them. */
function unreached(): boolean {
  return false;
}

describe("records", () => {
  it("keys every entity by id except alert_preferences", () => {
    expect(keyOf("issues", makeIssue("a"))).toBe("a");
    expect(keyOf("members", { id: "user-1" } as never)).toBe("user-1");
    expect(
      keyOf("alert_preferences", {
        user_id: "user-1",
        version: 1,
        assignment: true,
        reply: true,
        change: true,
        mention: true,
        deadline: true,
      }),
    ).toBe("user-1");
  });

  it("normalizes timestamps to UTC ISO without mutating the input", () => {
    const issue = makeIssue("a", {
      deadline: "2026-10-08T14:00:00+02:00",
      deleted_at: null,
      created_at: "2026-10-08T12:00:00.000Z",
    });
    const clean = normalize("issues", issue);
    expect(clean).not.toBe(issue);
    expect(clean.deadline).toBe("2026-10-08T12:00:00.000000Z");
    expect(clean.deleted_at).toBeNull();
    expect(issue.deadline).toBe("2026-10-08T14:00:00+02:00");
  });
});

describe("base", () => {
  it("exposes replaceBase records through get and all", () => {
    const store = new SyncStore(testReplay);
    store.replaceBase({ teams: [makeTeam()], issues: [makeIssue("a"), makeIssue("b")] }, [
      "teams",
      "issues",
    ]);
    expect(store.get("issues", "a")?.title).toBe("Issue a");
    expect(store.all("issues")).toHaveLength(2);
    expect(store.get("teams", "team-1")?.name).toBe("Team");
  });

  it("applies upserts and deletes through applyBase", () => {
    const store = new SyncStore(testReplay);
    store.replaceBase({ issues: [makeIssue("a"), makeIssue("b")] }, ["issues"]);
    store.applyBase([
      { entity: "issues", id: "a", record: { ...makeIssue("a"), title: "Renamed" } },
      { entity: "issues", id: "b", record: null },
    ]);
    expect(store.get("issues", "a")?.title).toBe("Renamed");
    expect(store.get("issues", "b")).toBeUndefined();
    expect(store.all("issues")).toHaveLength(1);
  });

  it("stores records normalized and frozen", () => {
    const store = new SyncStore(testReplay);
    store.replaceBase(
      {
        issues: [makeIssue("a", { deadline: "2026-10-08T14:00:00+02:00" })],
      },
      ["issues"],
    );
    const issue = store.get("issues", "a");
    expect(issue?.deadline).toBe("2026-10-08T12:00:00.000000Z");
    expect(Object.isFrozen(issue)).toBe(true);
  });

  it("replaceBase only touches the listed entities", () => {
    const store = new SyncStore(testReplay);
    store.replaceBase({ teams: [makeTeam()], issues: [makeIssue("a")] }, ["teams", "issues"]);
    store.replaceBase({ issues: [makeIssue("b")] }, ["issues"]);
    expect(store.get("issues", "a")).toBeUndefined();
    expect(store.get("issues", "b")).toBeDefined();
    expect(store.get("teams", "team-1")).toBeDefined();
  });
});

describe("replay", () => {
  it("applies pending mutations in order over base", () => {
    const store = new SyncStore(testReplay);
    store.replaceBase({ issues: [makeIssue("a")] }, ["issues"]);
    store.setPending([
      { id: 1, name: "set_title", args: { id: "a", title: "First" }, at: NOW },
      { id: 2, name: "set_title", args: { id: "a", title: "Second" }, at: NOW },
    ]);
    expect(store.get("issues", "a")?.title).toBe("Second");
  });

  it("lets a later mutation see an earlier mutation's writes", () => {
    const store = new SyncStore(testReplay);
    store.replaceBase({ issues: [makeIssue("a", { title: "Base" })] }, ["issues"]);
    store.setPending([
      { id: 1, name: "set_title", args: { id: "a", title: "Local" }, at: NOW },
      { id: 2, name: "append_title", args: { id: "a", suffix: "!" }, at: NOW },
    ]);
    expect(store.get("issues", "a")?.title).toBe("Local!");
  });

  it("skips a throwing mutation, reports it, and keeps it pending", () => {
    const store = new SyncStore(testReplay);
    store.replaceBase({ issues: [makeIssue("a")] }, ["issues"]);
    store.setPending([
      { id: 1, name: "set_title", args: { id: "a", title: "Kept" }, at: NOW },
      { id: 2, name: "boom", args: {}, at: NOW },
    ]);
    expect(store.get("issues", "a")?.title).toBe("Kept");
    const failure = store.replayErrors().get(2);
    expect(failure).toEqual({ name: "Error", message: "boom" });
    expect(Object.isFrozen(failure)).toBe(true);
    expect(store.pending()).toHaveLength(2);
  });

  it("restores the base value when a pending mutation is removed", () => {
    const store = new SyncStore(testReplay);
    store.replaceBase({ issues: [makeIssue("a", { title: "Base" })] }, ["issues"]);
    store.setPending([{ id: 1, name: "set_title", args: { id: "a", title: "Local" }, at: NOW }]);
    expect(store.get("issues", "a")?.title).toBe("Local");
    store.setPending([]);
    expect(store.get("issues", "a")?.title).toBe("Base");
    expect(store.replayErrors().size).toBe(0);
  });
});

describe("rebase", () => {
  it("keeps pending edits on top of new base data", () => {
    const store = new SyncStore(testReplay);
    store.replaceBase({ issues: [makeIssue("a", { title: "Base" })] }, ["issues"]);
    store.setPending([{ id: 1, name: "set_title", args: { id: "a", title: "Local" }, at: NOW }]);
    store.applyBase([
      { entity: "issues", id: "a", record: { ...makeIssue("a"), title: "Server" } },
    ]);
    expect(store.get("issues", "a")?.title).toBe("Local");
    store.setPending([]);
    expect(store.get("issues", "a")?.title).toBe("Server");
  });

  it("emits exactly the keys whose view changed", () => {
    const store = new SyncStore(testReplay);
    store.replaceBase({ issues: [makeIssue("a"), makeIssue("b")] }, ["issues"]);
    const { events } = collect(store);
    store.applyBase([
      { entity: "issues", id: "a", record: { ...makeIssue("a"), title: "Renamed" } },
      { entity: "issues", id: "b", record: null },
    ]);
    expect(events).toHaveLength(1);
    expect(events[0]?.entities).toEqual(new Set(["issues"]));
    expect(events[0]?.keys.get("issues")).toEqual(new Set(["a", "b"]));
    expect(store.version("issues")).toBe(2);
    expect(store.version("teams")).toBe(0);
  });

  it("reports a removed overlay write as a change", () => {
    const store = new SyncStore(testReplay);
    store.replaceBase({ issues: [makeIssue("a", { title: "Base" })] }, ["issues"]);
    const { events } = collect(store);
    store.setPending([{ id: 1, name: "set_title", args: { id: "a", title: "Local" }, at: NOW }]);
    store.setPending([]);
    expect(events).toHaveLength(2);
    expect(events[0]?.keys.get("issues")).toEqual(new Set(["a"]));
    expect(events[1]?.keys.get("issues")).toEqual(new Set(["a"]));
  });

  it("emits nothing when the view did not change", () => {
    const store = new SyncStore(testReplay);
    store.replaceBase({ issues: [makeIssue("a")] }, ["issues"]);
    const { events, stop } = collect(store);
    store.applyBase([{ entity: "issues", id: "a", record: { ...makeIssue("a") } }]);
    store.applyBase([]);
    store.setPending([]);
    store.replaceBase({ issues: [makeIssue("a")] }, ["issues"]);
    expect(events).toHaveLength(0);
    stop();
    store.applyBase([
      { entity: "issues", id: "a", record: { ...makeIssue("a"), title: "Renamed" } },
    ]);
    expect(events).toHaveLength(0);
  });

  it("produces one event for a batch of calls", () => {
    const store = new SyncStore(testReplay);
    store.replaceBase({ issues: [makeIssue("a", { title: "Base" }), makeIssue("b")] }, ["issues"]);
    const { events } = collect(store);
    store.batch(() => {
      store.applyBase([
        { entity: "issues", id: "b", record: { ...makeIssue("b"), title: "Server" } },
      ]);
      store.setPending([{ id: 1, name: "set_title", args: { id: "a", title: "Local" }, at: NOW }]);
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.keys.get("issues")).toEqual(new Set(["a", "b"]));
    expect(store.get("issues", "a")?.title).toBe("Local");
    expect(store.get("issues", "b")?.title).toBe("Server");
  });
});

describe("indexes", () => {
  it("tracks inserts, moves between values, and deletes", () => {
    const store = new SyncStore(testReplay);
    store.replaceBase(
      {
        issues: [makeIssue("a", { stage_id: "stage-todo" }), makeIssue("b")],
      },
      ["issues"],
    );
    expect(
      store
        .byIndex("issues", "stage_id", "stage-todo")
        .map((issue) => issue.id)
        .sort(),
    ).toEqual(["a", "b"]);
    store.applyBase([
      { entity: "issues", id: "a", record: { ...makeIssue("a"), stage_id: "stage-done" } },
    ]);
    expect(store.byIndex("issues", "stage_id", "stage-todo").map((issue) => issue.id)).toEqual([
      "b",
    ]);
    expect(store.byIndex("issues", "stage_id", "stage-done").map((issue) => issue.id)).toEqual([
      "a",
    ]);
    store.applyBase([{ entity: "issues", id: "a", record: null }]);
    expect(store.byIndex("issues", "stage_id", "stage-done")).toHaveLength(0);
  });

  it("maintains the multi-valued dependency index", () => {
    const store = new SyncStore(testReplay);
    store.replaceBase(
      {
        issues: [makeIssue("x"), makeIssue("y"), makeIssue("z", { dependencies: ["x", "y"] })],
      },
      ["issues"],
    );
    const dependingOnX = () => store.byIndex("issues", "dependency", "x").map((issue) => issue.id);
    expect(dependingOnX()).toEqual(["z"]);
    store.applyBase([
      { entity: "issues", id: "z", record: { ...makeIssue("z"), dependencies: ["y"] } },
    ]);
    expect(dependingOnX()).toEqual([]);
    expect(store.byIndex("issues", "dependency", "y").map((issue) => issue.id)).toEqual(["z"]);
  });

  it("reflects overlay writes and deletes in indexes", () => {
    const store = new SyncStore(testReplay);
    store.replaceBase({ issues: [makeIssue("a"), makeIssue("b", { team_id: "team-2" })] }, [
      "issues",
    ]);
    expect(store.byIndex("issues", "team_id", "team-1").map((issue) => issue.id)).toEqual(["a"]);
    store.setPending([{ id: 1, name: "delete_issue", args: { id: "a" }, at: NOW }]);
    expect(store.byIndex("issues", "team_id", "team-1")).toHaveLength(0);
    expect(store.byIndex("issues", "team_id", "team-2").map((issue) => issue.id)).toEqual(["b"]);
    store.setPending([]);
    expect(store.byIndex("issues", "team_id", "team-1").map((issue) => issue.id)).toEqual(["a"]);
  });

  it("indexes comments, time entries, activity, milestones, sprints and notifications", () => {
    const store = new SyncStore(testReplay);
    store.replaceBase(
      {
        comments: [
          {
            id: "c1",
            version: 1,
            issue_id: "a",
            author: "user-1",
            body: "hi",
            mentions: [],
            attachments: [],
            created_at: NOW,
            edited_at: null,
          },
        ],
        time_entries: [
          {
            id: "t1",
            version: 1,
            issue_id: "a",
            user_id: "user-1",
            minutes: 30,
            note: "",
            logged_at: NOW,
          },
        ],
        activity: [{ id: "e1", actor: "user-1", action: "created", entity_id: "a", at: NOW }],
        milestones: [{ id: "m1", version: 1, project_id: "p1", name: "M", deadline: null }],
        sprints: [
          {
            id: "s1",
            version: 1,
            team_id: "team-1",
            name: "S",
            goal: "",
            starts_at: NOW,
            ends_at: NOW,
            state: "active",
            outcome: null,
          },
        ],
        notifications: [
          {
            id: "n1",
            version: 1,
            user_id: "user-1",
            issue_id: "a",
            kind: "reply",
            message: "m",
            read_at: null,
            created_at: NOW,
            dedup_key: "d",
          },
        ],
      },
      ["comments", "time_entries", "activity", "milestones", "sprints", "notifications"],
    );
    expect(store.byIndex("comments", "issue_id", "a")).toHaveLength(1);
    expect(store.byIndex("time_entries", "issue_id", "a")).toHaveLength(1);
    expect(store.byIndex("time_entries", "user_id", "user-1")).toHaveLength(1);
    expect(store.byIndex("activity", "entity_id", "a")).toHaveLength(1);
    expect(store.byIndex("milestones", "project_id", "p1")).toHaveLength(1);
    expect(store.byIndex("sprints", "team_id", "team-1")).toHaveLength(1);
    expect(store.byIndex("notifications", "issue_id", "a")).toHaveLength(1);
  });

  it("keeps result identity stable until contents change", () => {
    const store = new SyncStore(testReplay);
    store.replaceBase({ issues: [makeIssue("a"), makeIssue("b", { stage_id: "stage-done" })] }, [
      "issues",
    ]);
    const todo = store.byIndex("issues", "stage_id", "stage-todo");
    const all = store.all("issues");
    store.applyBase([
      {
        entity: "issues",
        id: "b",
        record: { ...makeIssue("b", { stage_id: "stage-done" }), title: "Elsewhere" },
      },
    ]);
    expect(store.byIndex("issues", "stage_id", "stage-todo")).toBe(todo);
    expect(store.all("issues")).not.toBe(all);
    store.applyBase([
      {
        entity: "issues",
        id: "b",
        record: {
          ...makeIssue("b", { stage_id: "stage-done" }),
          title: "Elsewhere",
          stage_id: "stage-todo",
        },
      },
    ]);
    expect(store.byIndex("issues", "stage_id", "stage-todo")).not.toBe(todo);
  });
});

describe("performance", () => {
  it("rebases one pending mutation over 20k issues in under 20 ms", () => {
    const store = new SyncStore(testReplay);
    const issues: ReturnType<typeof makeIssue>[] = [];
    for (let i = 0; i < 20000; i += 1) issues.push(makeIssue(`issue-${i}`));
    store.replaceBase({ teams: [makeTeam()], issues }, ["teams", "issues"]);
    const start = performance.now();
    store.setPending([
      { id: 1, name: "set_title", args: { id: "issue-12345", title: "Local" }, at: NOW },
    ]);
    const elapsed = performance.now() - start;
    expect(store.get("issues", "issue-12345")?.title).toBe("Local");
    expect(elapsed).toBeLessThan(20);
  });
});

describe("regressions F1-G2", () => {
  it("F1: refreshes index buckets when membership is unchanged", () => {
    const store = new SyncStore(testReplay);
    store.replaceBase({ teams: [makeTeam()], issues: [makeIssue("a", { title: "Old" })] }, [
      "teams",
      "issues",
    ]);
    const before = store.byIndex("issues", "team_id", "team-1");
    expect(before[0]?.title).toBe("Old");
    store.applyBase([{ entity: "issues", id: "a", record: { ...makeIssue("a"), title: "New" } }]);
    const after = store.byIndex("issues", "team_id", "team-1");
    expect(after[0]?.title).toBe("New");
    expect(after).not.toBe(before);
  });

  it("F2: deep-freezes records and detaches caller-owned objects", () => {
    const store = new SyncStore(testReplay);
    const input = makeIssue("a", { dependencies: ["x"] });
    store.replaceBase({ issues: [input] }, ["issues"]);
    input.dependencies.push("hacked");
    expect(store.get("issues", "a")?.dependencies).toEqual(["x"]);
    const issue = store.get("issues", "a");
    if (issue === undefined) throw new Error("missing");
    expect(Object.isFrozen(issue)).toBe(true);
    expect(Object.isFrozen(issue.dependencies)).toBe(true);
    expect(() => {
      (issue.dependencies as unknown as string[]).push("y");
    }).toThrow();
    expect(store.get("issues", "a")?.dependencies).toEqual(["x"]);
    const viaApply = { ...makeIssue("b", { dependencies: ["p"] }) };
    store.applyBase([{ entity: "issues", id: "b", record: viaApply }]);
    (viaApply as unknown as { dependencies: string[] }).dependencies.push("q");
    expect(store.get("issues", "b")?.dependencies).toEqual(["p"]);
  });

  it("F2: Tx.put detaches nested arrays and Tx.get is frozen", () => {
    const shared: string[] = ["x"];
    let seenFrozen = false;
    let seenNestedFrozen = false;
    const replay = (tx: Tx, mutation: PendingMutation): void => {
      if (mutation.name === "put_shared") {
        tx.put("issues", makeIssue("s", { dependencies: shared }));
      } else if (mutation.name === "observe") {
        const got = tx.get("issues", "s");
        if (got !== undefined) {
          seenFrozen = Object.isFrozen(got);
          seenNestedFrozen = Object.isFrozen(got.dependencies);
        }
      } else {
        testReplay(tx, mutation);
      }
    };
    const store = new SyncStore(replay);
    store.replaceBase({ issues: [] }, ["issues"]);
    store.setPending([
      { id: 1, name: "put_shared", args: {}, at: NOW },
      { id: 2, name: "observe", args: {}, at: NOW },
    ]);
    shared.push("hacked");
    expect(store.get("issues", "s")?.dependencies).toEqual(["x"]);
    expect(seenFrozen).toBe(true);
    expect(seenNestedFrozen).toBe(true);
  });

  it("F3: failed mutations roll back their partial writes", () => {
    const replay = (tx: Tx, mutation: PendingMutation): void => {
      if (mutation.name === "write_then_throw") {
        const a = tx.get("issues", "a");
        if (a === undefined) throw new Error("missing a");
        tx.put("issues", { ...a, title: "Partial" });
        tx.delete("issues", "b");
        throw new Error("boom");
      } else {
        testReplay(tx, mutation);
      }
    };
    const store = new SyncStore(replay);
    store.replaceBase({ issues: [makeIssue("a", { title: "Base" }), makeIssue("b")] }, ["issues"]);
    store.setPending([{ id: 1, name: "write_then_throw", args: {}, at: NOW }]);
    expect(store.get("issues", "a")?.title).toBe("Base");
    expect(store.get("issues", "b")).toBeDefined();
    expect(store.replayErrors().get(1)).toEqual({ name: "Error", message: "boom" });
  });

  it("F3: later mutations do not see a failed mutation's writes", () => {
    const replay = (tx: Tx, mutation: PendingMutation): void => {
      if (mutation.name === "fail_first") {
        const a = tx.get("issues", "a");
        if (a === undefined) throw new Error("missing");
        tx.put("issues", { ...a, title: "Partial" });
        throw new Error("boom");
      } else {
        testReplay(tx, mutation);
      }
    };
    const store = new SyncStore(replay);
    store.replaceBase({ issues: [makeIssue("a", { title: "Base" })] }, ["issues"]);
    store.setPending([
      { id: 1, name: "fail_first", args: {}, at: NOW },
      { id: 2, name: "append_title", args: { id: "a", suffix: "!" }, at: NOW },
    ]);
    expect(store.get("issues", "a")?.title).toBe("Base!");
  });

  it("F4: unchanged replay preserves identity and emits nothing", () => {
    const store = new SyncStore(testReplay);
    store.replaceBase({ issues: [makeIssue("a", { title: "Base" })] }, ["issues"]);
    store.setPending([{ id: 1, name: "set_title", args: { id: "a", title: "Local" }, at: NOW }]);
    const first = store.get("issues", "a");
    const versionBefore = store.version("issues");
    const events: ChangeSet[] = [];
    const stop = store.subscribe((e) => events.push(e));
    store.applyBase([]);
    stop();
    expect(events).toHaveLength(0);
    expect(store.version("issues")).toBe(versionBefore);
    expect(store.get("issues", "a")).toBe(first);
  });

  it("F5: setPending detaches and freezes caller args", () => {
    const store = new SyncStore(testReplay);
    store.replaceBase({ issues: [makeIssue("a", { title: "Base" })] }, ["issues"]);
    const args = { id: "a", title: "First" };
    store.setPending([{ id: 1, name: "set_title", args, at: NOW }]);
    args.title = "Hacked";
    expect(store.get("issues", "a")?.title).toBe("First");
    const pending = store.pending();
    const first = pending[0];
    if (first === undefined) throw new Error("missing pending");
    expect((first.args as { title: string }).title).toBe("First");
    expect(Object.isFrozen(pending)).toBe(true);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.args)).toBe(true);
  });

  it("F6: one pending rename does no O(n) work until read", () => {
    const store = new SyncStore(testReplay);
    const issues: ReturnType<typeof makeIssue>[] = [];
    for (let i = 0; i < 20000; i += 1) issues.push(makeIssue(`issue-${i}`));
    store.replaceBase({ teams: [makeTeam()], issues }, ["teams", "issues"]);
    void store.all("issues");
    void store.byIndex("issues", "team_id", "team-1");
    store.debug.allRebuilds = 0;
    store.debug.indexRebuilds = 0;
    store.debug.baseScans = 0;
    const start = performance.now();
    store.setPending([
      { id: 1, name: "set_title", args: { id: "issue-12345", title: "Local" }, at: NOW },
    ]);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(5);
    expect(store.debug.allRebuilds).toBe(0);
    expect(store.debug.indexRebuilds).toBe(0);
    expect(store.debug.baseScans).toBe(0);
    expect(store.get("issues", "issue-12345")?.title).toBe("Local");
    void store.all("issues");
    expect(store.debug.allRebuilds).toBe(1);
  });

  it("F7: Tx.byIndex does not scan the base table", () => {
    let count = -1;
    const replay = (tx: Tx, mutation: PendingMutation): void => {
      if (mutation.name === "count_bucket") {
        const rows = tx.byIndex("issues", "team_id", "team-2");
        count = rows.length;
        return;
      }
      testReplay(tx, mutation);
    };
    const store = new SyncStore(replay);
    const issues: ReturnType<typeof makeIssue>[] = [];
    for (let i = 0; i < 20000; i += 1) issues.push(makeIssue(`issue-${i}`));
    issues.push(makeIssue("lonely", { team_id: "team-2" }));
    store.replaceBase({ teams: [makeTeam()], issues }, ["teams", "issues"]);
    store.debug.baseScans = 0;
    const start = performance.now();
    store.setPending([{ id: 1, name: "count_bucket", args: {}, at: NOW }]);
    const elapsed = performance.now() - start;
    expect(count).toBe(1);
    expect(store.debug.baseScans).toBe(0);
    expect(elapsed).toBeLessThan(5);
  });

  it("F8: timestamp normalization keeps microsecond precision", () => {
    const a = normalize(
      "issues",
      makeIssue("a", { created_at: "2026-10-08T12:00:00.123001+00:00" }),
    );
    const b = normalize(
      "issues",
      makeIssue("b", { created_at: "2026-10-08T12:00:00.123999+00:00" }),
    );
    expect(a.created_at).toBe("2026-10-08T12:00:00.123001Z");
    expect(b.created_at).toBe("2026-10-08T12:00:00.123999Z");
    expect(a.created_at).not.toBe(b.created_at);
    expect(
      normalize("issues", makeIssue("c", { created_at: "2026-10-08T12:00:00.123Z" })).created_at,
    ).toBe("2026-10-08T12:00:00.123000Z");
    expect(
      normalize("issues", makeIssue("d", { created_at: "2026-10-08T12:00:00Z" })).created_at,
    ).toBe("2026-10-08T12:00:00.000000Z");
    expect(() => normalize("issues", makeIssue("e", { created_at: "not-a-date" }))).toThrow();
  });

  it("G1: replaceBase with explicit entities clears empty ones", () => {
    const store = new SyncStore(testReplay);
    store.replaceBase({ teams: [makeTeam()], issues: [makeIssue("a")] }, ["teams", "issues"]);
    store.replaceBase({ teams: [makeTeam()] }, ["issues", "teams"]);
    expect(store.get("issues", "a")).toBeUndefined();
    expect(store.get("teams", "team-1")).toBeDefined();
    store.replaceBase({ teams: [makeTeam()], issues: [makeIssue("a")] }, ["teams", "issues"]);
    store.replaceBase({ issues: [makeIssue("b")] }, ["issues"]);
    expect(store.get("issues", "b")).toBeDefined();
    expect(store.get("teams", "team-1")).toBeDefined();
  });

  it("re-entrancy: setPending(same) terminates with one no-op pass", () => {
    const store = new SyncStore(testReplay);
    store.replaceBase({ issues: [makeIssue("a", { title: "Base" }), makeIssue("b")] }, ["issues"]);
    store.setPending([{ id: 1, name: "set_title", args: { id: "a", title: "Local" }, at: NOW }]);
    let events = 0;
    const stop = store.subscribe(() => {
      events += 1;
      store.setPending(store.pending());
    });
    store.applyBase([
      { entity: "issues", id: "b", record: { ...makeIssue("b"), title: "Server" } },
    ]);
    stop();
    expect(events).toBe(1);
    expect(store.get("issues", "a")?.title).toBe("Local");
    expect(store.get("issues", "b")?.title).toBe("Server");
  });

  it("re-entrancy: applyBase with a real change emits a second event", () => {
    const store = new SyncStore(testReplay);
    store.replaceBase({ issues: [makeIssue("a"), makeIssue("b")] }, ["issues"]);
    const events: ChangeSet[] = [];
    let calls = 0;
    const stop = store.subscribe((e) => {
      events.push(e);
      calls += 1;
      if (calls === 1) {
        store.applyBase([
          { entity: "issues", id: "b", record: { ...makeIssue("b"), title: "Second" } },
        ]);
      }
    });
    store.applyBase([{ entity: "issues", id: "a", record: { ...makeIssue("a"), title: "First" } }]);
    stop();
    expect(events).toHaveLength(2);
    expect(events[0]?.keys.get("issues")).toEqual(new Set(["a"]));
    expect(events[1]?.keys.get("issues")).toEqual(new Set(["b"]));
  });

  it("notifications: pending and error changes emit events with pendingVersion", () => {
    const store = new SyncStore(testReplay);
    store.replaceBase({ issues: [makeIssue("a")] }, ["issues"]);
    const before = store.pendingVersion();
    const events: ChangeSet[] = [];
    const stop = store.subscribe((e) => events.push(e));
    store.setPending([{ id: 1, name: "set_title", args: { id: "a", title: "Local" }, at: NOW }]);
    expect(store.pendingVersion()).toBeGreaterThan(before);
    expect(events).toHaveLength(1);
    expect(events[0]?.pendingChanged).toBe(true);
    store.setPending([{ id: 1, name: "boom", args: {}, at: NOW }]);
    expect(events[events.length - 1]?.errorsChanged).toBe(true);
    stop();
  });

  it("base API: baseGet reads through the overlay and number null is allowed", () => {
    const store = new SyncStore(testReplay);
    store.replaceBase({ issues: [makeIssue("a", { title: "Base", number: null })] }, ["issues"]);
    expect(store.get("issues", "a")?.number).toBeNull();
    expect(store.baseGet("issues", "a")?.title).toBe("Base");
    store.setPending([{ id: 1, name: "set_title", args: { id: "a", title: "Local" }, at: NOW }]);
    expect(store.get("issues", "a")?.title).toBe("Local");
    expect(store.baseGet("issues", "a")?.title).toBe("Base");
  });

  it("batch still rebases when the callback throws", () => {
    const store = new SyncStore(testReplay);
    store.replaceBase({ issues: [makeIssue("a", { title: "Base" })] }, ["issues"]);
    expect(() => {
      store.batch(() => {
        store.applyBase([
          { entity: "issues", id: "a", record: { ...makeIssue("a"), title: "Server" } },
        ]);
        throw new Error("callback boom");
      });
    }).toThrow("callback boom");
    expect(store.get("issues", "a")?.title).toBe("Server");
  });
});

describe("review N1-N5", () => {
  it("N1: BOOTSTRAP_ENTITIES covers every always-loaded entity", () => {
    expect(BOOTSTRAP_ENTITIES).not.toContain("comments");
    expect(BOOTSTRAP_ENTITIES).not.toContain("activity");
    expect(BOOTSTRAP_ENTITIES).toHaveLength(14);
    for (const entity of [
      "workspace",
      "members",
      "teams",
      "labels",
      "projects",
      "milestones",
      "sprints",
      "views",
      "alert_preferences",
      "notifications",
      "invitations",
      "integrations",
      "issues",
      "time_entries",
    ] as const) {
      expect(BOOTSTRAP_ENTITIES).toContain(entity);
    }
  });

  it("N1: an optional bootstrap scope clears stale records", () => {
    const store = new SyncStore(testReplay);
    store.replaceBase({ teams: [makeTeam()], issues: [makeIssue("a")] }, BOOTSTRAP_ENTITIES);
    expect(store.get("issues", "a")).toBeDefined();
    store.replaceBase({ teams: [makeTeam()] }, BOOTSTRAP_ENTITIES);
    expect(store.get("issues", "a")).toBeUndefined();
    expect(store.all("issues")).toHaveLength(0);
    expect(store.get("teams", "team-1")).toBeDefined();
  });

  it("N2: an equal server record while pending keeps identity and emits nothing", () => {
    const store = new SyncStore(testReplay);
    store.replaceBase({ issues: [makeIssue("a", { title: "Base" })] }, ["issues"]);
    store.setPending([{ id: 1, name: "set_title", args: { id: "a", title: "Local" }, at: NOW }]);
    const before = store.get("issues", "a");
    const allBefore = store.all("issues");
    const byIndexBefore = store.byIndex("issues", "team_id", "team-1");
    const versionBefore = store.version("issues");
    const { events, stop } = collect(store);
    store.applyBase([{ entity: "issues", id: "a", record: { ...makeIssue("a"), title: "Local" } }]);
    stop();
    expect(events).toHaveLength(0);
    expect(store.version("issues")).toBe(versionBefore);
    expect(store.get("issues", "a")).toBe(before);
    expect(store.all("issues")).toBe(allBefore);
    expect(store.byIndex("issues", "team_id", "team-1")).toBe(byIndexBefore);
    expect(store.pending()).toHaveLength(1);
  });

  it("N2: confirming with pending removal in one batch keeps identity", () => {
    const store = new SyncStore(testReplay);
    store.replaceBase({ issues: [makeIssue("a", { title: "Base" })] }, ["issues"]);
    store.setPending([{ id: 1, name: "set_title", args: { id: "a", title: "Local" }, at: NOW }]);
    const before = store.get("issues", "a");
    const allBefore = store.all("issues");
    const byIndexBefore = store.byIndex("issues", "team_id", "team-1");
    const versionBefore = store.version("issues");
    const { events, stop } = collect(store);
    store.batch(() => {
      store.applyBase([
        { entity: "issues", id: "a", record: { ...makeIssue("a"), title: "Local" } },
      ]);
      store.setPending([]);
    });
    stop();
    expect(store.get("issues", "a")).toBe(before);
    expect(store.all("issues")).toBe(allBefore);
    expect(store.byIndex("issues", "team_id", "team-1")).toBe(byIndexBefore);
    expect(store.version("issues")).toBe(versionBefore);
    expect(events).toHaveLength(1);
    expect(events[0]?.pendingChanged).toBe(true);
    expect(events[0]?.entities.size).toBe(0);
  });

  it("N3: plain thrown objects with different statuses or messages emit errorsChanged", () => {
    const replay = (tx: Tx, mutation: DeepReadonly<PendingMutation>): void => {
      void tx;
      const args = mutation.args as { status?: number; message?: string };
      throw { status: args.status, message: args.message };
    };
    const store = new SyncStore(replay);
    store.replaceBase({ issues: [] }, ["issues"]);
    const { events, stop } = collect(store);
    const first = store.pendingVersion();
    store.setPending([{ id: 1, name: "fail", args: { status: 404, message: "nope" }, at: NOW }]);
    expect(store.replayErrors().get(1)).toEqual({ name: "Error", message: "nope", status: 404 });
    expect(Object.isFrozen(store.replayErrors().get(1))).toBe(true);
    expect(events[events.length - 1]?.errorsChanged).toBe(true);
    expect(store.pendingVersion()).toBeGreaterThan(first);
    const second = store.pendingVersion();
    store.setPending([{ id: 1, name: "fail", args: { status: 500, message: "nope" }, at: NOW }]);
    expect(events[events.length - 1]?.errorsChanged).toBe(true);
    expect(store.pendingVersion()).toBeGreaterThan(second);
    const third = store.pendingVersion();
    store.setPending([{ id: 1, name: "fail", args: { status: 500, message: "boom" }, at: NOW }]);
    expect(events[events.length - 1]?.errorsChanged).toBe(true);
    expect(store.pendingVersion()).toBeGreaterThan(third);
    stop();
  });

  it("N3: an Error whose code changes emits errorsChanged", () => {
    const replay: ReplayFn = (tx) => {
      const error = new Error("locked") as Error & { code?: string };
      error.code = tx.get("issues", "x") === undefined ? "E_A" : "E_B";
      throw error;
    };
    const store = new SyncStore(replay);
    store.replaceBase({ issues: [] }, ["issues"]);
    store.setPending([{ id: 1, name: "fail", args: {}, at: NOW }]);
    expect(store.replayErrors().get(1)).toEqual({ name: "Error", message: "locked", code: "E_A" });
    const { events, stop } = collect(store);
    const before = store.pendingVersion();
    store.applyBase([{ entity: "issues", id: "x", record: makeIssue("x") }]);
    stop();
    expect(store.replayErrors().get(1)).toEqual({ name: "Error", message: "locked", code: "E_B" });
    expect(events).toHaveLength(1);
    expect(events[0]?.errorsChanged).toBe(true);
    expect(store.pendingVersion()).toBeGreaterThan(before);
  });

  it("N4: a subscriber that always changes state throws after the rebase cap", () => {
    const store = new SyncStore(testReplay);
    store.replaceBase({ issues: [makeIssue("a", { title: "Base" }), makeIssue("b")] }, ["issues"]);
    let calls = 0;
    const stop = store.subscribe(() => {
      calls += 1;
      store.applyBase([
        { entity: "issues", id: "b", record: { ...makeIssue("b"), title: `v${calls}` } },
      ]);
    });
    expect(() => {
      store.applyBase([
        { entity: "issues", id: "a", record: { ...makeIssue("a"), title: "First" } },
      ]);
    }).toThrow("sync store: rebase feedback loop");
    stop();
    expect(calls).toBe(100);
    expect(store.get("issues", "a")?.title).toBe("First");
    expect(store.get("issues", "b")?.title).toBe("v100");
    const { events, stop: stopLater } = collect(store);
    store.applyBase([]);
    stopLater();
    expect(events).toHaveLength(1);
    expect(events[0]?.keys.get("issues")).toEqual(new Set(["b"]));
  });

  it("N5: normalization round-trips extreme valid timestamps", () => {
    for (const stamp of [
      "0001-01-01T00:00:00Z",
      "0001-01-01T01:30:00+01:00",
      "9999-12-31T23:59:59.999999Z",
      "9999-12-31T22:30:00-01:00",
    ]) {
      const once = normalize("issues", makeIssue("a", { created_at: stamp }));
      const twice = normalize("issues", { ...makeIssue("a"), created_at: once.created_at });
      expect(twice.created_at).toBe(once.created_at);
    }
    expect(
      normalize("issues", makeIssue("a", { created_at: "0001-01-01T00:00:00Z" })).created_at,
    ).toBe("0001-01-01T00:00:00.000000Z");
    expect(
      normalize("issues", makeIssue("a", { created_at: "9999-12-31T23:59:59.999999Z" })).created_at,
    ).toBe("9999-12-31T23:59:59.999999Z");
    expect(() => normalize("issues", makeIssue("a", { created_at: "not-a-date" }))).toThrow();
  });

  it("detaches and freezes client-only pending mutation data", () => {
    const local = { ids: ["original"] };
    let replayed: unknown;
    const store = new SyncStore((_tx, mutation) => {
      replayed = mutation.local;
    });
    store.setPending([{ id: 1, name: "noop", args: {}, at: NOW, local }]);
    local.ids.push("newer");
    expect(replayed).toEqual({ ids: ["original"] });
    expect(store.pending()[0]?.local).toEqual({ ids: ["original"] });
    expect(Object.isFrozen(replayed)).toBe(true);
    if (typeof replayed !== "object" || replayed === null || !("ids" in replayed))
      throw new Error("missing local data");
    expect(Object.isFrozen(replayed.ids)).toBe(true);
  });

  it("N6: pending mutations are deeply readonly", () => {
    const store = new SyncStore(testReplay);
    store.replaceBase({ issues: [makeIssue("a", { title: "Base" })] }, ["issues"]);
    store.setPending([{ id: 1, name: "set_title", args: { id: "a", title: "First" }, at: NOW }]);
    const pending = store.pending();
    expectTypeOf(pending).toEqualTypeOf<readonly DeepReadonly<PendingMutation>[]>();
    const first = pending[0];
    if (first === undefined) throw new Error("missing pending");
    expect((first.args as { title: string }).title).toBe("First");
    if (unreached()) {
      // @ts-expect-error - pending mutations are frozen
      first.id = 2;
      // @ts-expect-error - the pending list is readonly
      pending.push(first);
    }
  });

  it("N6: replay mutations are deeply readonly", () => {
    const replay: ReplayFn = (tx, mutation) => {
      const issue = tx.get("issues", "a");
      if (issue !== undefined && unreached()) {
        // @ts-expect-error - replay mutations are frozen
        mutation.id = 9;
      }
    };
    const store = new SyncStore(replay);
    store.replaceBase({ issues: [makeIssue("a")] }, ["issues"]);
    store.setPending([{ id: 1, name: "noop", args: {}, at: NOW }]);
    expect(store.get("issues", "a")).toBeDefined();
  });
});

describe("incremental replay", () => {
  const mutation = (id: number, name: string, args: unknown = {}): PendingMutation => ({
    id,
    name,
    args,
    at: NOW,
  });

  it("replays only appended mutations and skips unchanged pulls", () => {
    const store = new SyncStore(testReplay);
    store.replaceBase({ issues: [makeIssue("a")] }, ["issues"]);
    for (let i = 1; i <= 500; i += 1) {
      store.setPending([...store.pending(), mutation(i, "set_title", { id: "a", title: `t${i}` })]);
    }
    expect(store.debug.replays).toBe(500);
    store.batch(() => {
      store.applyBase([{ entity: "issues", id: "a", record: makeIssue("a") }]);
      store.setPending(store.pending().filter(() => true));
    });
    expect(store.debug.replays).toBe(500);
    store.applyBase([{ entity: "issues", id: "a", record: makeIssue("a", { title: "Server" }) }]);
    expect(store.debug.replays).toBe(1000);
    expect(store.get("issues", "a")?.title).toBe("t500");
  });

  it("replays again only for base changes a pending mutation read", () => {
    const replay: ReplayFn = (tx, m) => {
      const issue = tx.get("issues", "a");
      if (issue === undefined) return;
      const peers = tx.byIndex("issues", "team_id", "t2").length;
      tx.put("issues", { ...issue, title: `${(m.args as { title: string }).title} ${peers}` });
    };
    const store = new SyncStore(replay);
    store.replaceBase({ issues: [makeIssue("a"), makeIssue("b")] }, ["issues"]);
    store.setPending([mutation(1, "count", { title: "x" })]);
    expect(store.get("issues", "a")?.title).toBe("x 0");
    store.applyBase([{ entity: "issues", id: "b", record: makeIssue("b", { title: "B" }) }]);
    expect(store.debug.replays).toBe(1);
    expect(store.get("issues", "b")?.title).toBe("B");
    store.applyBase([{ entity: "issues", id: "b", record: makeIssue("b", { team_id: "t2" }) }]);
    expect(store.debug.replays).toBe(2);
    expect(store.get("issues", "a")?.title).toBe("x 1");
  });

  it("matches full rebases over random appends, base changes and acks", () => {
    const replay: ReplayFn = (tx, m) => {
      const args = m.args as { id: string; team: string };
      if (m.name === "create") tx.put("issues", makeIssue(args.id, { team_id: args.team }));
      else if (m.name === "move") {
        const issue = tx.get("issues", args.id);
        if (issue === undefined) throw new Error(`missing issue ${args.id}`);
        tx.put("issues", { ...issue, team_id: args.team });
      } else if (m.name === "count_team" || m.name === "count_all") {
        // Reads through an index bucket or a table scan, not just point keys.
        const issue = tx.get("issues", args.id);
        if (issue === undefined) throw new Error(`missing issue ${args.id}`);
        const rows =
          m.name === "count_team" ? tx.byIndex("issues", "team_id", args.team) : tx.all("issues");
        tx.put("issues", { ...issue, title: `n${rows.length}` });
      } else testReplay(tx, m);
    };
    let seed = 7;
    const rand = (n: number): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    const ids = ["a", "b", "c", "d", "e"];
    const teams = ["t1", "t2"];
    const randomMutation = (id: number): PendingMutation => {
      const issue = ids[rand(ids.length)] ?? "a";
      const team = teams[rand(teams.length)] ?? "t1";
      const kinds: [string, unknown][] = [
        ["set_title", { id: issue, title: `v${rand(3)}` }],
        ["append_title", { id: issue, suffix: "!" }],
        ["delete_issue", { id: issue }],
        ["create", { id: issue, team }],
        ["move", { id: issue, team }],
        ["count_team", { id: issue, team }],
        ["count_all", { id: issue }],
        ["boom", {}],
      ];
      const [name, args] = kinds[rand(kinds.length)] ?? ["boom", {}];
      return mutation(id, name, args);
    };
    const randomChange = () => {
      const id = ids[rand(ids.length)] ?? "a";
      const record =
        rand(4) === 0 ? null : makeIssue(id, { title: `v${rand(3)}`, team_id: teams[rand(2)] });
      return { entity: "issues" as const, id, record };
    };
    const incremental = new SyncStore(replay);
    const full = new SyncStore(replay);
    const logs = [incremental, full].map((store) => {
      const log: unknown[] = [];
      store.subscribe((e) => log.push(e));
      return log;
    });
    const seedBase = { issues: [makeIssue("a", { team_id: "t1" }), makeIssue("b")] };
    incremental.replaceBase(seedBase, ["issues"]);
    full.replaceBase(seedBase, ["issues"]);
    let next = 1;
    for (let step = 0; step < 400; step += 1) {
      const op = rand(4);
      const changes = op === 1 ? [randomChange()] : [];
      const appended = op === 0 ? [randomMutation(next++), randomMutation(next++)] : [];
      const acked = op === 2 ? rand(3) : 0;
      const pending = [...incremental.pending().slice(acked), ...appended];
      incremental.batch(() => {
        incremental.applyBase(changes);
        incremental.setPending(pending);
      });
      full.batch(() => {
        full.applyBase(changes);
        full.setPending(pending.map((m) => ({ ...m })));
      });
      expect(incremental.all("issues")).toEqual(full.all("issues"));
      for (const team of teams) {
        expect(incremental.byIndex("issues", "team_id", team)).toEqual(
          full.byIndex("issues", "team_id", team),
        );
      }
      expect(incremental.replayErrors()).toEqual(full.replayErrors());
      expect(incremental.version("issues")).toBe(full.version("issues"));
      expect(incremental.pendingVersion()).toBe(full.pendingVersion());
      expect(logs[0]).toEqual(logs[1]);
    }
    expect(incremental.debug.replays).toBeLessThan(full.debug.replays / 2);
  });
});
