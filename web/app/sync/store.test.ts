import { describe, expect, it } from "vite-plus/test";
import { makeIssue, makeTeam, NOW, testReplay } from "./fixtures";
import { keyOf, normalize } from "./records";
import type { ChangeSet } from "./store";
import { SyncStore } from "./store";

function collect(store: SyncStore): { events: ChangeSet[]; stop: () => void } {
  const events: ChangeSet[] = [];
  const stop = store.subscribe((change) => events.push(change));
  return { events, stop };
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
    expect(clean.deadline).toBe("2026-10-08T12:00:00.000Z");
    expect(clean.deleted_at).toBeNull();
    expect(issue.deadline).toBe("2026-10-08T14:00:00+02:00");
  });
});

describe("base", () => {
  it("exposes replaceBase records through get and all", () => {
    const store = new SyncStore(testReplay);
    store.replaceBase({ teams: [makeTeam()], issues: [makeIssue("a"), makeIssue("b")] });
    expect(store.get("issues", "a")?.title).toBe("Issue a");
    expect(store.all("issues")).toHaveLength(2);
    expect(store.get("teams", "team-1")?.name).toBe("Team");
  });

  it("applies upserts and deletes through applyBase", () => {
    const store = new SyncStore(testReplay);
    store.replaceBase({ issues: [makeIssue("a"), makeIssue("b")] });
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
    store.replaceBase({
      issues: [makeIssue("a", { deadline: "2026-10-08T14:00:00+02:00" })],
    });
    const issue = store.get("issues", "a");
    expect(issue?.deadline).toBe("2026-10-08T12:00:00.000Z");
    expect(Object.isFrozen(issue)).toBe(true);
  });

  it("replaceBase only touches the listed entities", () => {
    const store = new SyncStore(testReplay);
    store.replaceBase({ teams: [makeTeam()], issues: [makeIssue("a")] });
    store.replaceBase({ issues: [makeIssue("b")] });
    expect(store.get("issues", "a")).toBeUndefined();
    expect(store.get("issues", "b")).toBeDefined();
    expect(store.get("teams", "team-1")).toBeDefined();
  });
});

describe("replay", () => {
  it("applies pending mutations in order over base", () => {
    const store = new SyncStore(testReplay);
    store.replaceBase({ issues: [makeIssue("a")] });
    store.setPending([
      { id: 1, name: "set_title", args: { id: "a", title: "First" }, at: NOW },
      { id: 2, name: "set_title", args: { id: "a", title: "Second" }, at: NOW },
    ]);
    expect(store.get("issues", "a")?.title).toBe("Second");
  });

  it("lets a later mutation see an earlier mutation's writes", () => {
    const store = new SyncStore(testReplay);
    store.replaceBase({ issues: [makeIssue("a", { title: "Base" })] });
    store.setPending([
      { id: 1, name: "set_title", args: { id: "a", title: "Local" }, at: NOW },
      { id: 2, name: "append_title", args: { id: "a", suffix: "!" }, at: NOW },
    ]);
    expect(store.get("issues", "a")?.title).toBe("Local!");
  });

  it("skips a throwing mutation, reports it, and keeps it pending", () => {
    const store = new SyncStore(testReplay);
    store.replaceBase({ issues: [makeIssue("a")] });
    store.setPending([
      { id: 1, name: "set_title", args: { id: "a", title: "Kept" }, at: NOW },
      { id: 2, name: "boom", args: {}, at: NOW },
    ]);
    expect(store.get("issues", "a")?.title).toBe("Kept");
    expect(store.replayErrors().get(2)).toBeInstanceOf(Error);
    expect(store.pending()).toHaveLength(2);
  });

  it("restores the base value when a pending mutation is removed", () => {
    const store = new SyncStore(testReplay);
    store.replaceBase({ issues: [makeIssue("a", { title: "Base" })] });
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
    store.replaceBase({ issues: [makeIssue("a", { title: "Base" })] });
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
    store.replaceBase({ issues: [makeIssue("a"), makeIssue("b")] });
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
    store.replaceBase({ issues: [makeIssue("a", { title: "Base" })] });
    const { events } = collect(store);
    store.setPending([{ id: 1, name: "set_title", args: { id: "a", title: "Local" }, at: NOW }]);
    store.setPending([]);
    expect(events).toHaveLength(2);
    expect(events[0]?.keys.get("issues")).toEqual(new Set(["a"]));
    expect(events[1]?.keys.get("issues")).toEqual(new Set(["a"]));
  });

  it("emits nothing when the view did not change", () => {
    const store = new SyncStore(testReplay);
    store.replaceBase({ issues: [makeIssue("a")] });
    const { events, stop } = collect(store);
    store.applyBase([{ entity: "issues", id: "a", record: { ...makeIssue("a") } }]);
    store.applyBase([]);
    store.setPending([]);
    store.replaceBase({ issues: [makeIssue("a")] });
    expect(events).toHaveLength(0);
    stop();
    store.applyBase([
      { entity: "issues", id: "a", record: { ...makeIssue("a"), title: "Renamed" } },
    ]);
    expect(events).toHaveLength(0);
  });

  it("produces one event for a batch of calls", () => {
    const store = new SyncStore(testReplay);
    store.replaceBase({ issues: [makeIssue("a", { title: "Base" }), makeIssue("b")] });
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
    store.replaceBase({
      issues: [makeIssue("a", { stage_id: "stage-todo" }), makeIssue("b")],
    });
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
    store.replaceBase({
      issues: [makeIssue("x"), makeIssue("y"), makeIssue("z", { dependencies: ["x", "y"] })],
    });
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
    store.replaceBase({ issues: [makeIssue("a"), makeIssue("b", { team_id: "team-2" })] });
    expect(store.byIndex("issues", "team_id", "team-1").map((issue) => issue.id)).toEqual(["a"]);
    store.setPending([{ id: 1, name: "delete_issue", args: { id: "a" }, at: NOW }]);
    expect(store.byIndex("issues", "team_id", "team-1")).toHaveLength(0);
    expect(store.byIndex("issues", "team_id", "team-2").map((issue) => issue.id)).toEqual(["b"]);
    store.setPending([]);
    expect(store.byIndex("issues", "team_id", "team-1").map((issue) => issue.id)).toEqual(["a"]);
  });

  it("indexes comments, time entries, activity, milestones, sprints and notifications", () => {
    const store = new SyncStore(testReplay);
    store.replaceBase({
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
    });
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
    store.replaceBase({ issues: [makeIssue("a"), makeIssue("b", { stage_id: "stage-done" })] });
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
    store.replaceBase({ teams: [makeTeam()], issues });
    const start = performance.now();
    store.setPending([
      { id: 1, name: "set_title", args: { id: "issue-12345", title: "Local" }, at: NOW },
    ]);
    const elapsed = performance.now() - start;
    expect(store.get("issues", "issue-12345")?.title).toBe("Local");
    expect(elapsed).toBeLessThan(20);
  });
});
