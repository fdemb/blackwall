import { createServer, type Server } from "node:http";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { ApiError, collectPages, workspaces } from "./api";
import { openproject, openprojectQuery } from "./openproject";
import { commandEntityIds, expectedVersions } from "./entity-versions";
import { QueryClient } from "@tanstack/react-query";
import { preloadWorkspace } from "./db";
import { keys } from "./query-client";
import type { Command, Issue, PageResult, Report } from "./types";

interface ReceivedRequest {
  url: URL;
  method: string;
  body: string;
  headers: Headers;
}
const requests: ReceivedRequest[] = [];
let respond: (request: ReceivedRequest) => { status?: number; body: unknown };
let server: Server;
let origin: string;
const nativeFetch = globalThis.fetch;

beforeAll(async () => {
  server = createServer(async (incoming, outgoing) => {
    let body = "";
    incoming.setEncoding("utf8");
    for await (const chunk of incoming) if (typeof chunk === "string") body += chunk;
    const headers = new Headers();
    for (const [key, value] of Object.entries(incoming.headers)) {
      if (typeof value === "string") headers.set(key, value);
    }
    const request = {
      url: new URL(incoming.url ?? "/", origin),
      method: incoming.method ?? "GET",
      body,
      headers,
    };
    requests.push(request);
    const response = respond(request);
    outgoing.writeHead(response.status ?? 200, { "Content-Type": "application/json" });
    outgoing.end(JSON.stringify(response.body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test server address");
  origin = `http://127.0.0.1:${address.port}`;
  vi.stubGlobal("fetch", (path: string, init?: RequestInit) =>
    nativeFetch(new URL(path, origin), init),
  );
});
afterEach(() => {
  requests.length = 0;
});
afterAll(async () => {
  vi.unstubAllGlobals();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

describe("OpenProject connection API", () => {
  it("reads only the workspace-scoped cache and polls local metadata", async () => {
    respond = () => ({ body: { connections: [] } });
    expect(await openproject.list("workspace-a")).toEqual({ connections: [] });
    expect(requests[0].url.pathname).toBe("/api/workspaces/workspace-a/openproject/connections");
    expect(requests[0].method).toBe("GET");
    expect(requests[0].body).toBe("");
    expect(openprojectQuery("workspace-a").refetchInterval).toBe(5_000);
  });

  it("sends credentials only in create and explicit rotation bodies", async () => {
    respond = () => ({ status: 201, body: { id: "connection-a" } });
    const input = { name: "Internal", base_url: "http://10.0.0.2:8080", token: "secret" };
    await openproject.create("workspace-a", input);
    expect(requests[0].method).toBe("POST");
    expect(JSON.parse(requests[0].body)).toEqual(input);
    await openproject.update("workspace-a", "connection-a", { name: "Renamed" });
    expect(requests[1].method).toBe("PATCH");
    expect(JSON.parse(requests[1].body)).toEqual({ name: "Renamed" });
    await openproject.update("workspace-a", "connection-a", { token: "rotated" });
    expect(JSON.parse(requests[2].body)).toEqual({ token: "rotated" });
    expect(requests.every((request) => request.url.origin === origin && !request.url.search)).toBe(
      true,
    );
  });

  it("replaces mappings including optional status IDs", async () => {
    respond = () => ({ body: { id: "connection-a" } });
    const projects = [{ project_id: 7, team_id: "team-a", stage_mapping: { "12": "stage-a" } }];
    await openproject.update("workspace-a", "connection-a", { projects });
    expect(JSON.parse(requests[0].body)).toEqual({ projects });
    await openproject.update("workspace-a", "connection-a", { projects: [] });
    expect(JSON.parse(requests[1].body)).toEqual({ projects: [] });
  });

  it("queues refresh and sync without a browser request to the instance", async () => {
    respond = () => ({ status: 202, body: { queued: true } });
    expect(await openproject.refresh("workspace-a", "connection-a")).toEqual({ queued: true });
    expect(await openproject.sync("workspace-a", "connection-a")).toEqual({ queued: true });
    expect(requests.map((request) => [request.method, request.url.pathname])).toEqual([
      ["POST", "/api/workspaces/workspace-a/openproject/connections/connection-a/refresh"],
      ["POST", "/api/workspaces/workspace-a/openproject/connections/connection-a/sync"],
    ]);
  });

  it("disconnects through DELETE and accepts 204", async () => {
    respond = () => ({ status: 204, body: null });
    expect(await openproject.remove("workspace-a", "connection-a")).toBeNull();
    expect(requests[0].method).toBe("DELETE");
  });

  it("propagates admin and background request failures", async () => {
    respond = () => ({ status: 403, body: { error: "Administrator required" } });
    await expect(openproject.list("workspace-a")).rejects.toMatchObject({ status: 403 });
    respond = () => ({ status: 503, body: { error: "Queue unavailable" } });
    await expect(openproject.sync("workspace-a", "connection-a")).rejects.toThrow(
      "Queue unavailable",
    );
  });
});

const page = <T>(items: T[], next: number | null = null): PageResult<T> => ({
  items,
  has_more: next !== null,
  next_offset: next,
});
const issue: Issue = {
  id: "issue-a",
  version: 4,
  blocked_count: 1,
  subtask_total: 2,
  subtask_completed: 1,
  number: 1,
  title: "Planning",
  description: "",
  team_id: "team-a",
  stage_id: "stage-a",
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
  archived_at: null,
  done_at: null,
  created_at: "2026-10-04T00:00:00Z",
  updated_at: "2026-10-04T00:00:00Z",
};

describe("frontend relational HTTP contract", () => {
  it("loads workspace records into collections, leaving discussion for the issue that needs it", async () => {
    respond = ({ url }) => {
      const resource = url.pathname.split("/").at(-1);
      if (resource === "workspace-a")
        return { body: { workspace: { id: "workspace-a", name: "Operations", version: 1 } } };
      if (resource === "members")
        return {
          body: [
            {
              id: "user-a",
              role: "owner",
              version: 3,
              email: "owner@example.com",
              display_name: "Owner",
              avatar_url: null,
              contact: "",
              team_ids: [],
            },
          ],
        };
      if (resource === "report")
        return {
          body: {
            issue_count: 201,
            inbox_unread: 8,
            label_counts: {},
            project_stats: [],
            issues: [],
            people: [],
            teams: [],
            projects: [],
            sprints: [],
            delivery: [],
            total_minutes: 0,
          },
        };
      if (resource === "views")
        return {
          body:
            url.searchParams.get("offset") === "0"
              ? page(
                  [
                    {
                      id: "view-a",
                      version: 1,
                      name: "Mine",
                      owner: "user-a",
                      shared: false,
                      filter: {},
                    },
                  ],
                  200,
                )
              : page([
                  {
                    id: "view-b",
                    version: 2,
                    name: "Team",
                    owner: "user-a",
                    shared: true,
                    filter: {},
                  },
                ]),
        };
      return { body: page([]) };
    };
    const client = new QueryClient();
    const db = await preloadWorkspace(client, "workspace-a");
    expect(client.getQueryData(keys.workspace("workspace-a"))).toEqual({
      workspace: { id: "workspace-a", name: "Operations", version: 1 },
    });
    expect(db.members.toArray.map((m) => m.version)).toEqual([3]);
    expect(db.views.toArray.map((view) => view.id).sort()).toEqual(["view-a", "view-b"]);
    expect(client.getQueryData<Report>(keys.report("workspace-a"))?.issue_count).toBe(201);
    // Issues load whole, trash and archive included; discussion waits for an issue page.
    expect(
      requests
        .filter(({ url }) => url.pathname.endsWith("/issues"))
        .map(({ url }) => url.searchParams.get("trash") ?? "")
        .sort((a, b) => a.localeCompare(b)),
    ).toEqual(["", "", "true"]);
    expect(
      requests
        .filter(({ url }) => url.pathname.endsWith("/issues"))
        .map(({ url }) => url.searchParams.get("archived") ?? "")
        .sort((a, b) => a.localeCompare(b)),
    ).toEqual(["", "", "true"]);
    expect(
      requests.some(({ url }) => /\/(comments|activity|time_entries)$/.test(url.pathname)),
    ).toBe(false);
    expect(
      requests
        .filter(({ url }) => url.pathname.endsWith("/views"))
        .map(({ url }) => url.searchParams.get("offset")),
    ).toEqual(["0", "200"]);
  });

  it("sends only the edited issue version, with a stable idempotency key", async () => {
    respond = () => ({ body: { result: { id: null }, versions: { "issue-a": 5 } } });
    const command: Command = { type: "update_issue", id: "issue-a", patch: { title: "Updated" } };
    const versions = expectedVersions(commandEntityIds(command, "user-a"), {
      "issue-a": 4,
      "issue-b": 29,
      "team-a": 10,
    });
    await workspaces.command("workspace-a", versions, command, "retry-key");
    expect(JSON.parse(requests[0]!.body)).toEqual({
      expected_versions: { "issue-a": 4 },
      idempotency_key: "retry-key",
      command,
    });
  });

  it("surfaces stale entity conflicts without resubmitting a changed precondition", async () => {
    respond = () => ({ status: 409, body: { error: "entity version conflict" } });
    await expect(
      workspaces.command(
        "workspace-a",
        { "issue-a": 3 },
        { type: "delete_issue", id: "issue-a" },
        "stale-key",
      ),
    ).rejects.toMatchObject({ status: 409, message: "entity version conflict" });
    expect(requests).toHaveLength(1);
    expect(JSON.parse(requests[0]!.body).expected_versions).toEqual({ "issue-a": 3 });
  });

  it("uploads comment attachments as multipart with the comment version", async () => {
    respond = () => ({ body: { result: { id: "attachment-a" }, versions: { "comment-a": 8 } } });
    const file = new File(["attachment contents"], "details.txt", { type: "text/plain" });
    await workspaces.upload(
      "workspace-a",
      "issue-a",
      { "comment-a": 7 },
      file,
      "comment-a",
      "upload-key",
    );
    const request = requests[0]!;
    const form = await new Request(request.url, {
      method: "POST",
      headers: request.headers,
      body: request.body,
    }).formData();
    expect(form.get("expected_versions")).toBe('{"comment-a":7}');
    expect(form.get("comment_id")).toBe("comment-a");
    expect(form.get("idempotency_key")).toBe("upload-key");
    expect(form.has("revision")).toBe(false);
    const attachment = form.get("file");
    expect(attachment).toBeInstanceOf(File);
    if (!(attachment instanceof File)) throw new Error("Expected attachment file");
    expect(attachment.name).toBe("details.txt");
    expect(await attachment.text()).toBe("attachment contents");
  });

  it("imports additions with an empty version map and explicit operation key", async () => {
    respond = () => ({ body: { summary: null, versions: { "issue-c": 1 } } });
    await workspaces.import(
      "workspace-a",
      { issues: [{ title: "Imported", team_id: "team-a" }] },
      "import-key",
    );
    expect(JSON.parse(requests[0]!.body)).toEqual({
      expected_versions: {},
      idempotency_key: "import-key",
      issues: [{ title: "Imported", team_id: "team-a" }],
    });
  });

  it("encodes targeted issue filters and follows the server's pagination offsets", async () => {
    respond = ({ url }) => ({
      body:
        url.searchParams.get("offset") === "0"
          ? page([issue], 100)
          : page([{ ...issue, id: "issue-b", version: 2 }]),
    });
    const issues = await collectPages((offset) =>
      workspaces.issues(
        "workspace-a",
        {
          trash: true,
          archived: true,
          ids: "issue-a,issue-b",
          parent_id: "parent-a",
          dependency_id: "dependency-a",
          no_sprint: true,
          open: true,
          search: "żółć & planning",
        },
        offset,
      ),
    );
    expect(issues.map((issue) => issue.id)).toEqual(["issue-a", "issue-b"]);
    expect(requests.map(({ url }) => url.searchParams.get("offset"))).toEqual(["0", "100"]);
    expect(requests[0]!.url.searchParams.get("search")).toBe("żółć & planning");
    for (const field of ["trash", "archived", "no_sprint", "open"])
      expect(requests[0]!.url.searchParams.get(field)).toBe("true");
    expect(requests[0]!.url.searchParams.get("ids")).toBe("issue-a,issue-b");
  });

  it("rejects a non-advancing page cursor instead of issuing an infinite request loop", async () => {
    respond = () => ({ body: page([issue], 0) });
    await expect(
      collectPages((offset) => workspaces.issues("workspace-a", {}, offset)),
    ).rejects.toThrow("Invalid pagination offset");
    expect(requests).toHaveLength(1);
  });

  it("reads raw issue detail and paginated issue-scoped discussion independently", async () => {
    respond = ({ url }) => ({ body: url.pathname.endsWith("/issue-a") ? issue : page([]) });
    const detail = await workspaces.issue("workspace-a", "issue-a");
    await workspaces.resource("workspace-a", "comments", { issue_id: detail.id, offset: 200 });
    await workspaces.resource("workspace-a", "activity", { entity_id: detail.id });
    expect(detail.version).toBe(4);
    expect(requests[1]!.url.searchParams.get("issue_id")).toBe("issue-a");
    expect(requests[1]!.url.searchParams.get("offset")).toBe("200");
    expect(requests[2]!.url.searchParams.get("entity_id")).toBe("issue-a");
  });

  it("keeps per-entity command preconditions separate from creation and referenced records", () => {
    expect(
      commandEntityIds(
        { type: "add_comment", issue_id: "issue-a", body: "Reply", mentions: [], attachments: [] },
        "user-a",
      ),
    ).toEqual([]);
    expect(
      commandEntityIds(
        {
          type: "log_time",
          issue_id: "issue-a",
          minutes: 60,
          note: "Work",
          logged_at: issue.created_at,
        },
        "user-a",
      ),
    ).toEqual([]);
    expect(
      commandEntityIds(
        {
          type: "update_stage",
          id: "stage-a",
          team_id: "team-a",
          name: "Active",
          kind: "active",
          position: 1,
        },
        "user-a",
      ),
    ).toEqual(["stage-a"]);
    expect(
      commandEntityIds(
        { type: "bulk_issues", ids: ["issue-a", "issue-b"], action: "restore" },
        "user-a",
      ),
    ).toEqual(["issue-a", "issue-b"]);
    expect(commandEntityIds({ type: "remove_member", user_id: "user-b" }, "user-a")).toEqual([
      "user-b",
    ]);
    expect(
      commandEntityIds(
        {
          type: "configure_alerts",
          assignment: true,
          reply: true,
          change: true,
          mention: true,
          deadline: true,
        },
        "user-a",
      ),
    ).toEqual(["user-a"]);
    expect(expectedVersions(["user-a"], {})).toEqual({});
    expect(new ApiError("conflict", 409).status).toBe(409);
  });
});
