import { describe, expect, it } from "vite-plus/test";
import { mutate, seedStore, TEAM, TEAM_OTHER } from "../sync/mutators/fixtures";
import { countedIssue, resolveIssue } from "./queries";

describe("issue URLs", () => {
  it("name an issue by id until the server confirms its number, then by that key", () => {
    const store = seedStore();
    mutate(store, "create_issue", { input: { id: "issue-new", title: "New", team_id: TEAM } });
    const local = () => countedIssue(store, "issue-new");
    // The team's issues go up to 15, so the prediction is TEAM-16, shown but never linked.
    expect(local()).toMatchObject({ key: "TEAM-16", ref: "issue-new" });
    expect(resolveIssue(store, "TEAM-16")).toBeUndefined();

    // Another client's create takes 16 first.
    const remote = { ...store.get("issues", "issue-1")!, id: "issue-remote", number: 16 };
    store.applyBase([{ entity: "issues", id: remote.id, record: remote }]);
    expect(resolveIssue(store, "team-16")).toBe("issue-remote");
    expect(local()).toMatchObject({ key: "TEAM-17", ref: "issue-new" });

    // The pull confirms the create as 17; the key becomes its URL and TEAM-16 stays the other issue.
    const confirmed = { ...store.get("issues", "issue-new")!, number: 17 };
    store.applyBase([{ entity: "issues", id: confirmed.id, record: confirmed }]);
    store.setPending([]);
    expect(local()).toMatchObject({ key: "TEAM-17", ref: "TEAM-17" });
    expect(resolveIssue(store, "TEAM-17")).toBe("issue-new");
    expect(resolveIssue(store, "TEAM-16")).toBe("issue-remote");
    expect(resolveIssue(store, "issue-new")).toBe("issue-new");
  });

  it("still name an issue by a key it held before it moved", () => {
    const store = seedStore();
    const moved = {
      ...store.get("issues", "issue-2")!,
      team_id: TEAM_OTHER,
      number: 1,
      former_keys: [{ team_id: TEAM, number: 2 }],
    };
    store.applyBase([{ entity: "issues", id: moved.id, record: moved }]);
    expect(resolveIssue(store, "TEAM-2")).toBe("issue-2");
    expect(resolveIssue(store, "OTH-1")).toBe("issue-2");
    expect(countedIssue(store, "issue-2")).toMatchObject({ key: "OTH-1", ref: "OTH-1" });
  });

  it("give a key to the issue holding it now over one that held it before moving", () => {
    const store = seedStore();
    const moved = {
      ...store.get("issues", "issue-2")!,
      team_id: TEAM_OTHER,
      number: 1,
      former_keys: [{ team_id: TEAM, number: 2 }],
    };
    store.applyBase([{ entity: "issues", id: moved.id, record: moved }]);
    const holder = { ...store.get("issues", "issue-3")!, id: "issue-holder", number: 2 };
    store.applyBase([{ entity: "issues", id: holder.id, record: holder }]);
    expect(resolveIssue(store, "TEAM-2")).toBe("issue-holder");
  });
});
