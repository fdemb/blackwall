import { createServer, type Server } from "node:http";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { openproject, openprojectQuery } from "./openproject";

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
