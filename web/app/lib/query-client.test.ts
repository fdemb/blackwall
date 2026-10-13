import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { SyncStore } from "../sync/store";
import { makeIssue, NOW, testReplay } from "../sync/fixtures";
import { keys, queryClient, watchReportChanges } from "./query-client";

afterEach(() => {
  queryClient.clear();
  vi.useRealTimers();
});

describe("report invalidation", () => {
  it("debounces issue and time changes, ignores unrelated entities, and preserves the last server result", async () => {
    vi.useFakeTimers();
    const store = new SyncStore(() => {});
    queryClient.setQueryData(keys.report("ws"), { issue_count: 77 });
    const cached = queryClient.getQueryData(keys.report("ws"));
    const unsubscribe = watchReportChanges(store, "ws");
    store.applyBase([
      {
        entity: "labels",
        id: "label",
        record: { id: "label", name: "Label", color: "red", version: 1 },
      },
    ]);
    await vi.advanceTimersByTimeAsync(300);
    expect(queryClient.getQueryState(keys.report("ws"))?.isInvalidated).toBe(false);
    store.applyBase([{ entity: "issues", id: "a", record: makeIssue("a") }]);
    await vi.advanceTimersByTimeAsync(200);
    store.applyBase([
      {
        entity: "time_entries",
        id: "t",
        record: {
          id: "t",
          version: 1,
          issue_id: "a",
          user_id: "u",
          minutes: 20,
          note: "",
          logged_at: NOW,
        },
      },
    ]);
    await vi.advanceTimersByTimeAsync(200);
    expect(queryClient.getQueryState(keys.report("ws"))?.isInvalidated).toBe(false);
    await vi.advanceTimersByTimeAsync(50);
    expect(queryClient.getQueryState(keys.report("ws"))?.isInvalidated).toBe(true);
    expect(queryClient.getQueryData(keys.report("ws"))).toBe(cached);
    unsubscribe();
  });
  it("waits for a local edit's confirmation instead of refetching for its prediction", async () => {
    vi.useFakeTimers();
    const store = new SyncStore(testReplay);
    store.applyBase([{ entity: "issues", id: "a", record: makeIssue("a") }]);
    queryClient.setQueryData(keys.report("ws"), { issue_count: 1 });
    const unsubscribe = watchReportChanges(store, "ws");
    const edit = { id: 1, name: "set_title", args: { id: "a", title: "Local" }, at: NOW };
    store.setPending([edit]);
    await vi.advanceTimersByTimeAsync(300);
    expect(queryClient.getQueryState(keys.report("ws"))?.isInvalidated).toBe(false);
    store.batch(() => {
      store.applyBase([
        {
          entity: "issues",
          id: "a",
          record: { ...makeIssue("a"), title: "Local", updated_at: NOW },
        },
      ]);
      store.setPending([]);
    });
    await vi.advanceTimersByTimeAsync(300);
    expect(queryClient.getQueryState(keys.report("ws"))?.isInvalidated).toBe(true);
    unsubscribe();
  });
  it("releases its subscription and scheduled invalidation when the workspace closes", async () => {
    vi.useFakeTimers();
    const store = new SyncStore(() => {});
    queryClient.setQueryData(keys.report("ws"), { issue_count: 1 });
    const unsubscribe = watchReportChanges(store, "ws");
    store.applyBase([{ entity: "issues", id: "a", record: makeIssue("a") }]);
    unsubscribe();
    await vi.advanceTimersByTimeAsync(300);
    expect(queryClient.getQueryState(keys.report("ws"))?.isInvalidated).toBe(false);
    store.applyBase([{ entity: "issues", id: "b", record: makeIssue("b") }]);
    await vi.advanceTimersByTimeAsync(300);
    expect(queryClient.getQueryState(keys.report("ws"))?.isInvalidated).toBe(false);
  });
});
