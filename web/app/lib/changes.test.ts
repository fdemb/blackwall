import { QueryClient, type InfiniteData } from "@tanstack/react-query";
import { describe, expect, it } from "vite-plus/test";
import { applyChanges, knownVersions, patchIssues } from "./changes";
import { keys } from "./query-client";
import type { Comment, Issue, Label, MemberProfile, PageResult } from "./types";

const WS = "ws-a";

const issue = (id: string, version: number, extra: Partial<Issue> = {}) =>
  ({ id, version, title: id, stage_id: "todo", position: 1, ...extra }) as Issue;
const label = (id: string, name: string, version = 1): Label => ({
  id,
  name,
  version,
  color: "red",
});
const pages = <T>(items: T[]): InfiniteData<PageResult<T>> => ({
  pages: [{ items, has_more: false, next_offset: null }],
  pageParams: [0],
});

function seeded() {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
  client.setQueryData(keys.collection(WS, "labels"), [
    label("l-b", "Bug"),
    label("l-f", "Feature"),
  ]);
  client.setQueryData(keys.issueList(WS, { team_id: "t" }), pages([issue("a", 1), issue("b", 4)]));
  client.setQueryData(keys.issue(WS, "a"), issue("a", 1));
  client.setQueryData(keys.page(WS, "comments", { issue_id: "a" }), pages<Comment>([]));
  client.setQueryData<MemberProfile[]>(keys.members(WS), [
    { id: "u-1", role: "owner", version: 2 } as MemberProfile,
  ]);
  client.setQueryData(keys.collection(WS, "alert_preferences"), [{ user_id: "u-1", version: 7 }]);
  return client;
}

const listed = (client: QueryClient) =>
  client
    .getQueryData<InfiniteData<PageResult<Issue>>>(keys.issueList(WS, { team_id: "t" }))!
    .pages.flatMap((page) => page.items);

describe("applyChanges", () => {
  it("replaces every cached copy of an issue but keeps a newer one", () => {
    const client = seeded();
    applyChanges(client, WS, [
      { entity: "issues", id: "a", record: issue("a", 2, { title: "Renamed" }) },
      { entity: "issues", id: "b", record: issue("b", 3, { title: "Stale" }) },
    ]);
    expect(listed(client).map((i) => [i.id, i.title])).toEqual([
      ["a", "Renamed"],
      ["b", "b"],
    ]);
    expect(client.getQueryData<Issue>(keys.issue(WS, "a"))?.title).toBe("Renamed");
  });

  it("marks issue lists and the report stale, since membership is the server's call", () => {
    const client = seeded();
    client.setQueryData(keys.report(WS), { issue_count: 1 });
    applyChanges(client, WS, [{ entity: "issues", id: "z", record: issue("z", 1) }]);
    expect(client.getQueryState(keys.issueList(WS, { team_id: "t" }))?.isInvalidated).toBe(true);
    expect(client.getQueryState(keys.report(WS))?.isInvalidated).toBe(true);
    expect(listed(client).map((i) => i.id)).toEqual(["a", "b"]);
  });

  it("inserts, sorts and removes records in whole collections", () => {
    const client = seeded();
    applyChanges(client, WS, [
      { entity: "labels", id: "l-c", record: label("l-c", "Chore") },
      { entity: "labels", id: "l-f", record: null },
    ]);
    expect(client.getQueryData<Label[]>(keys.collection(WS, "labels"))?.map((l) => l.name)).toEqual(
      ["Bug", "Chore"],
    );
  });

  it("refetches a paginated list only when a new record belongs to it", () => {
    const client = seeded();
    const comment = (issue_id: string) => ({ id: `c-${issue_id}`, version: 1, issue_id });
    applyChanges(client, WS, [{ entity: "comments", id: "c-b", record: comment("b") }]);
    expect(client.getQueryState(keys.page(WS, "comments", { issue_id: "a" }))?.isInvalidated).toBe(
      false,
    );
    applyChanges(client, WS, [{ entity: "comments", id: "c-a", record: comment("a") }]);
    expect(client.getQueryState(keys.page(WS, "comments", { issue_id: "a" }))?.isInvalidated).toBe(
      true,
    );
  });
});

describe("patchIssues", () => {
  it("applies a guess to lists and details alike", () => {
    const client = seeded();
    patchIssues(client, WS, (i) => (i.id === "a" ? { ...i, stage_id: "done" } : i));
    expect(listed(client).find((i) => i.id === "a")?.stage_id).toBe("done");
    expect(client.getQueryData<Issue>(keys.issue(WS, "a"))?.stage_id).toBe("done");
  });
});

describe("knownVersions", () => {
  it("keeps memberships and alert preferences apart from records keyed by their own id", () => {
    const { records, memberships, preferences } = knownVersions(seeded(), WS);
    expect(records).toMatchObject({ a: 1, b: 4, "l-b": 1, "l-f": 1 });
    expect(records["u-1"]).toBeUndefined();
    expect(memberships).toEqual({ "u-1": 2 });
    expect(preferences).toEqual({ "u-1": 7 });
  });
});
