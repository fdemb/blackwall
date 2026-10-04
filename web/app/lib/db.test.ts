import { QueryClient } from "@tanstack/react-query";
import { queryOnce } from "@tanstack/react-db";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { createCommandRunner } from "./commands";
import { workspaceDb, type Source } from "./db";
import { issueQuery } from "./queries";
import { applyChanges } from "./sync";
import type { Comment, CommandResult, Issue, IssueFilter, Label } from "./types";

const issue = (id: string, extra: Partial<Issue> = {}): Issue => ({
  id,
  version: 1,
  blocked_count: 0,
  subtask_total: 0,
  subtask_completed: 0,
  number: Number(id.replace(/\D/g, "")) || 1,
  title: `Issue ${id}`,
  description: "",
  team_id: "team-a",
  stage_id: "todo",
  assignee: null,
  priority: "normal",
  labels: [],
  estimate: null,
  deadline: null,
  project_id: null,
  milestone_id: null,
  sprint_id: null,
  parent_id: null,
  dependencies: [],
  position: 1,
  followers: [],
  attachments: [],
  source_links: [],
  deleted_at: null,
  created_at: "2026-10-01T00:00:00+00:00",
  updated_at: "2026-10-01T00:00:00+00:00",
  ...extra,
});

const ISSUES = [
  issue("i1", { priority: "low", position: 3, labels: ["bug"], title: "Rotate keys" }),
  issue("i2", { priority: "urgent", position: 2, stage_id: "done" }),
  issue("i3", {
    priority: "high",
    position: 1,
    assignee: "u1",
    deadline: "2026-10-03T12:00:00+02:00",
  }),
  issue("i4", { deleted_at: "2026-10-02T00:00:00+00:00" }),
];

function source(extra: Partial<Source> = {}): Source {
  const none = () => Promise.resolve([]);
  return {
    teams: none,
    labels: () => Promise.resolve([{ id: "bug", name: "Bug", color: "red", version: 2 }]),
    projects: none,
    milestones: none,
    sprints: none,
    views: none,
    invitations: none,
    alert_preferences: none,
    integrations: none,
    notifications: none,
    members: none,
    issues: () => Promise.resolve(ISSUES),
    comments: none,
    time_entries: none,
    activity: none,
    ...extra,
  };
}

let counter = 0;
const clients = new WeakMap<object, QueryClient>();
async function open(extra: Partial<Source> = {}) {
  const client = new QueryClient();
  const db = workspaceDb(`ws-${++counter}`, client, source(extra));
  clients.set(db, client);
  await Promise.all([db.issues.preload(), db.labels.preload()]);
  return db;
}
/** The query client a test workspace's collections sync through. */
const clientOf = (db: object) => clients.get(db)!;

const ids = (
  db: Awaited<ReturnType<typeof open>>,
  filter: IssueFilter,
  openStages: string[] = [],
) =>
  queryOnce((q) => issueQuery(q, db.issues, filter, openStages)).then((rows) =>
    rows.map((i) => i.id),
  );

afterEach(() => vi.unstubAllGlobals());

describe("issueQuery", () => {
  it("keeps trash apart and orders by position by default", async () => {
    const db = await open();
    expect(await ids(db, {})).toEqual(["i3", "i2", "i1"]);
    expect(await ids(db, { trash: true })).toEqual(["i4"]);
  });

  it("matches the API's filters locally", async () => {
    const db = await open();
    expect(await ids(db, { label_id: "bug" })).toEqual(["i1"]);
    expect(await ids(db, { assignee: "u1" })).toEqual(["i3"]);
    expect(await ids(db, { unassigned: true })).toEqual(["i2", "i1"]);
    expect(await ids(db, { open: true }, ["todo"])).toEqual(["i3", "i1"]);
    expect(await ids(db, { search: "rotate" })).toEqual(["i1"]);
    expect(await ids(db, { search: "#2" })).toEqual(["i2"]);
    // Deadlines are stored in UTC, so a cut-off compares correctly across offsets.
    expect(await ids(db, { due_before: "2026-10-03T10:00:00.000Z" })).toEqual(["i3"]);
    expect(await ids(db, { due_before: "2026-10-03T09:59:59.000Z" })).toEqual([]);
  });

  it("sorts by priority like the server, highest first", async () => {
    const db = await open();
    expect(await ids(db, { sort: "priority" })).toEqual(["i2", "i3", "i1"]);
  });
});

describe("applyChanges", () => {
  it("upserts newer records, skips older ones and removes deleted ones", async () => {
    const db = await open();
    applyChanges(clientOf(db), db, [
      { entity: "issues", id: "i1", record: issue("i1", { version: 2, title: "Renamed" }) },
      { entity: "labels", id: "bug", record: { id: "bug", name: "Old", color: "red", version: 1 } },
      {
        entity: "labels",
        id: "chore",
        record: { id: "chore", name: "Chore", color: "blue", version: 1 },
      },
      { entity: "issues", id: "i2", record: null },
    ]);
    await Promise.resolve();
    expect(db.issues.get("i1")?.title).toBe("Renamed");
    expect(db.labels.get("bug")?.name).toBe("Bug");
    expect(db.labels.get("chore")?.name).toBe("Chore");
    expect(db.issues.has("i2")).toBe(false);
  });
});

describe("command runner", () => {
  function stubServer(
    respond: (body: { command: { type: string } }) => Response | Promise<Response>,
  ) {
    const sent: { expected_versions: Record<string, number>; command: { type: string } }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(init.body as string);
        sent.push(body);
        return respond(body);
      }),
    );
    return sent;
  }
  const ok = (result: Partial<CommandResult>) =>
    new Response(JSON.stringify({ result: { id: null }, versions: {}, changes: [], ...result }), {
      status: 200,
    });

  it("shows an edit at once, sends the cached version, then keeps the server's record", async () => {
    const db = await open();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const sent = stubServer(async () => {
      await gate;
      return ok({
        changes: [
          { entity: "issues", id: "i1", record: issue("i1", { version: 2, title: "Saved" }) },
        ],
      });
    });
    const runner = createCommandRunner(clientOf(db), db, "u1");
    const done = runner.command({ type: "update_issue", id: "i1", patch: { title: "Typed" } });
    expect(db.issues.get("i1")?.title).toBe("Typed");
    release();
    await done;
    expect(sent[0]?.expected_versions).toEqual({ i1: 1 });
    expect(db.issues.get("i1")?.title).toBe("Saved");
    expect(db.issues.get("i1")?.version).toBe(2);
  });

  it("rolls the local edit back when the server refuses it", async () => {
    const db = await open();
    stubServer(() => new Response(JSON.stringify({ error: "stale" }), { status: 409 }));
    const runner = createCommandRunner(clientOf(db), db, "u1");
    await expect(
      runner.command({ type: "update_label", id: "bug", name: "Defect", color: "red" }),
    ).rejects.toThrow("stale");
    expect((db.labels.get("bug") as Label).name).toBe("Bug");
  });

  it("sends writes one at a time, so the second uses the first one's new version", async () => {
    const db = await open();
    let version = 1;
    const sent = stubServer(() => {
      version += 1;
      return ok({
        changes: [{ entity: "issues", id: "i1", record: issue("i1", { version }) }],
      });
    });
    const runner = createCommandRunner(clientOf(db), db, "u1");
    await Promise.all([
      runner.command({ type: "update_issue", id: "i1", patch: { title: "One" } }),
      runner.command({ type: "update_issue", id: "i1", patch: { title: "Two" } }),
    ]);
    expect(sent.map((body) => body.expected_versions.i1)).toEqual([1, 2]);
  });

  it("creates without a local guess and adds the server's record", async () => {
    const db = await open();
    stubServer(() =>
      ok({
        result: { id: "i9" },
        changes: [{ entity: "issues", id: "i9", record: issue("i9") }],
      }),
    );
    const runner = createCommandRunner(clientOf(db), db, "u1");
    const res = await runner.command({
      type: "create_issue",
      input: { team_id: "team-a", title: "New" },
    });
    expect(res.result.id).toBe("i9");
    expect(db.issues.has("i9")).toBe(true);
  });
});

describe("scoped collections", () => {
  it("load only the issue a live query asks for", async () => {
    const asked: (string | undefined)[] = [];
    const db = await open({
      comments: (issueId) => {
        asked.push(issueId);
        return Promise.resolve<Comment[]>([]);
      },
    });
    const { eq } = await import("@tanstack/react-db");
    await queryOnce((q) => q.from({ c: db.comments }).where(({ c }) => eq(c.issue_id, "i1")));
    expect(asked).toEqual(["i1"]);
  });
});
