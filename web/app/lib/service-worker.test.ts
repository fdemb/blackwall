import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { registerServiceWorker } from "./service-worker";

const ORIGIN = "https://blackwall.test";
const SOURCE = readFileSync(new URL("../../public/sw.js", import.meta.url), "utf8");
const SHELL = `<script type="module" src="/assets/entry-1.js"></script><link href="/assets/manifest-1.js">`;
const NEXT_SHELL = `<script type="module" src="/assets/entry-2.js"></script><link href="/assets/manifest-2.js">`;
const manifest = (...modules: string[]) => () =>
  new Response(`window.__reactRouterManifest=${JSON.stringify({ routes: { modules } })}`);

type Handler = (event: object) => void;

/** Runs public/sw.js against an in-memory cache and a scripted network. */
function worker(network: Record<string, () => Response>) {
  const handlers = new Map<string, Handler>();
  const store = new Map<string, Response>();
  const key = (request: { url: string } | string) =>
    new URL(typeof request === "string" ? request : request.url, ORIGIN).pathname;
  const fetched: string[] = [];
  let online = true;
  const fetch = async (request: { url: string } | string) => {
    if (!online) throw new TypeError("Failed to fetch");
    fetched.push(key(request));
    const route = network[key(request)];
    return route ? route() : new Response("missing", { status: 404 });
  };
  const cache = {
    match: async (request: { url: string } | string) => store.get(key(request))?.clone(),
    put: async (request: { url: string } | string, response: Response) => {
      store.set(key(request), response);
    },
    add: async (request: string) => {
      const response = await fetch(request);
      if (!response.ok) throw new TypeError("Request failed");
      store.set(key(request), response);
    },
    delete: async (request: { url: string } | string) => store.delete(key(request)),
    keys: async () => [...store.keys()].map((path) => ({ url: `${ORIGIN}${path}` })),
  };
  const caches = {
    open: async () => cache,
    match: cache.match,
    keys: async () => ["bw-shell-v1"],
    delete: async () => true,
  };
  const self = {
    addEventListener: (type: string, handler: Handler) => handlers.set(type, handler),
    skipWaiting: async () => {},
    clients: { claim: async () => {} },
  };
  runInNewContext(SOURCE, { self, caches, fetch, location: new URL(ORIGIN), URL, Set, Promise });
  async function dispatch(type: string, fields: object = {}) {
    const waits: Promise<unknown>[] = [];
    let response: Promise<Response> | undefined;
    handlers.get(type)?.({
      ...fields,
      waitUntil: (work: Promise<unknown>) => waits.push(work),
      respondWith: (work: Promise<Response>) => {
        response = work;
      },
    });
    const result = await response;
    await Promise.all(waits);
    return result;
  }
  return {
    store,
    fetched,
    offline: () => {
      online = false;
    },
    install: () => dispatch("install"),
    navigate: (path: string) =>
      dispatch("fetch", { request: { url: `${ORIGIN}${path}`, method: "GET", mode: "navigate" } }),
    get: (path: string) =>
      dispatch("fetch", { request: { url: `${ORIGIN}${path}`, method: "GET", mode: "cors" } }),
    message: (data: unknown) => dispatch("message", { data }),
  };
}

const html = (body: string) => () =>
  new Response(body, { headers: { "Content-Type": "text/html" } });

describe("service worker", () => {
  it("serves the cached shell for a navigation when the server is unreachable or failing", async () => {
    let failing = false;
    const sw = worker({
      "/": html(SHELL),
      "/issues": () => (failing ? new Response("down", { status: 503 }) : html(SHELL)()),
      "/assets/entry-1.js": () => new Response("entry"),
      "/assets/manifest-1.js": manifest("/assets/route-1.js"),
      "/assets/route-1.js": () => new Response("route"),
    });
    await sw.install();
    expect([...sw.store.keys()]).toEqual(expect.arrayContaining(["/", "/assets/entry-1.js"]));
    await sw.get("/assets/route-1.js");
    failing = true;
    expect(await (await sw.navigate("/issues"))?.text()).toBe(SHELL);
    sw.offline();
    expect(await (await sw.navigate("/issues"))?.text()).toBe(SHELL);
    expect(await (await sw.get("/assets/route-1.js"))?.text()).toBe("route");
  });

  it("installs only the shell, leaving route modules to be cached as the page loads them", async () => {
    let shell = SHELL;
    const sw = worker({
      "/": () => html(shell)(),
      "/assets/entry-1.js": () => new Response("entry"),
      "/assets/manifest-1.js": manifest("/assets/route-1.js"),
      "/assets/route-1.js": () => new Response("route"),
      "/assets/entry-2.js": () => new Response("new"),
      "/assets/manifest-2.js": manifest(),
    });
    await sw.install();
    expect(sw.fetched).not.toContain("/assets/route-1.js");
    expect(sw.store.has("/assets/route-1.js")).toBe(false);

    await sw.get("/assets/route-1.js");
    await sw.navigate("/");
    expect(sw.store.has("/assets/route-1.js")).toBe(true);

    shell = NEXT_SHELL;
    await sw.navigate("/");
    expect(sw.store.has("/assets/route-1.js")).toBe(false);
  });

  it("leaves API requests to the network and drops assets from older builds", async () => {
    let shell = SHELL;
    const sw = worker({
      "/": () => html(shell)(),
      "/assets/entry-1.js": () => new Response("old"),
      "/assets/entry-2.js": () => new Response("new"),
      "/assets/manifest-1.js": manifest(),
      "/assets/manifest-2.js": manifest(),
      "/assets/font-1.woff2": () => new Response("font"),
    });
    await sw.install();
    await sw.get("/assets/font-1.woff2");
    expect(await sw.get("/api/me")).toBeUndefined();
    shell = NEXT_SHELL;
    await sw.navigate("/");
    expect(sw.store.has("/assets/entry-1.js")).toBe(false);
    expect(sw.store.has("/assets/entry-2.js")).toBe(true);
    expect(sw.store.has("/assets/font-1.woff2")).toBe(true);
  });

  it.each([
    ["missing", () => new Response("missing", { status: 404 })],
    ["not a route manifest", () => new Response("<!doctype html>")],
  ])("prunes nothing when the new build's manifest is %s", async (_, next) => {
    let shell = SHELL;
    const sw = worker({
      "/": () => html(shell)(),
      "/assets/entry-1.js": () => new Response("entry"),
      "/assets/manifest-1.js": manifest("/assets/route-1.js"),
      "/assets/route-1.js": () => new Response("route"),
      "/assets/entry-2.js": () => new Response("new"),
      "/assets/manifest-2.js": next,
    });
    await sw.install();
    await sw.get("/assets/route-1.js");

    shell = NEXT_SHELL;
    await sw.navigate("/");

    expect(sw.store.has("/assets/route-1.js")).toBe(true);
    expect(sw.store.has("/assets/entry-1.js")).toBe(true);
  });

  it("ignores reported URLs outside this origin's build assets", async () => {
    const sw = worker({ "/": html(SHELL), "/api/me": () => new Response("me") });
    await sw.install();

    await sw.message({ type: "loaded-assets", urls: ["https://cdn.test/assets/x.js", "/api/me"] });

    expect(sw.fetched).not.toContain("/api/me");
    expect(sw.store.has("/api/me")).toBe(false);
  });
});

describe("registerServiceWorker", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("caches the modules a first visit loaded before the worker took control", async () => {
    const sw = worker({
      "/": html(SHELL),
      "/assets/entry-1.js": () => new Response("entry"),
      "/assets/manifest-1.js": manifest("/assets/route-1.js"),
      "/assets/route-1.js": () => new Response("route"),
      "/assets/chunk-1.js": () => new Response("chunk"),
    });
    const listeners: (() => void)[] = [];
    const reports: Promise<unknown>[] = [];
    let installed: Promise<unknown> | undefined;
    const container = {
      controller: null as { postMessage: (data: unknown) => void } | null,
      register: () => (installed = sw.install()),
      addEventListener: (_: string, listener: () => void) => listeners.push(listener),
      removeEventListener: () => {},
    };
    vi.stubGlobal("navigator", { serviceWorker: container });
    vi.stubGlobal("location", new URL(`${ORIGIN}/issues/BLA-1`));
    vi.stubGlobal("performance", {
      getEntriesByType: () => [
        { name: `${ORIGIN}/assets/route-1.js` },
        { name: `${ORIGIN}/api/me` },
        { name: "https://fonts.test/assets/font.woff2" },
      ],
    });
    const element = (attributes: Record<string, string>) => ({
      getAttribute: (name: string) => attributes[name] ?? null,
    });
    vi.stubGlobal("document", {
      baseURI: `${ORIGIN}/issues/BLA-1`,
      querySelectorAll: () => [
        element({ type: "module", src: "/assets/entry-1.js" }),
        element({ rel: "modulepreload", href: "../assets/chunk-1.js" }),
      ],
    });

    registerServiceWorker();
    await installed;
    expect(sw.store.has("/assets/route-1.js")).toBe(false);

    container.controller = { postMessage: (data) => reports.push(sw.message(data)) };
    for (const listener of listeners) listener();
    await Promise.all(reports);
    sw.offline();

    expect(await (await sw.get("/assets/route-1.js"))?.text()).toBe("route");
    expect(await (await sw.get("/assets/chunk-1.js"))?.text()).toBe("chunk");
    expect(sw.fetched).not.toContain("/api/me");
  });
});
