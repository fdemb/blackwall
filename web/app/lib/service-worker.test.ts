import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vite-plus/test";

const ORIGIN = "https://blackwall.test";
const SOURCE = readFileSync(new URL("../../public/sw.js", import.meta.url), "utf8");
const SHELL = `<script type="module" src="/assets/entry-1.js"></script><link href="/assets/manifest-1.js">`;

type Handler = (event: object) => void;

/** Runs public/sw.js against an in-memory cache and a scripted network. */
function worker(network: Record<string, () => Response>) {
  const handlers = new Map<string, Handler>();
  const store = new Map<string, Response>();
  const key = (request: { url: string } | string) =>
    new URL(typeof request === "string" ? request : request.url, ORIGIN).pathname;
  let online = true;
  const fetch = async (request: { url: string } | string) => {
    if (!online) throw new TypeError("Failed to fetch");
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
  async function dispatch(type: string, request?: object) {
    const waits: Promise<unknown>[] = [];
    let response: Promise<Response> | undefined;
    handlers.get(type)?.({
      request,
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
    offline: () => {
      online = false;
    },
    install: () => dispatch("install"),
    navigate: (path: string) =>
      dispatch("fetch", { url: `${ORIGIN}${path}`, method: "GET", mode: "navigate" }),
    get: (path: string) =>
      dispatch("fetch", { url: `${ORIGIN}${path}`, method: "GET", mode: "cors" }),
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
      "/assets/manifest-1.js": () => new Response(`import("/assets/route-1.js")`),
      "/assets/route-1.js": () => new Response("route"),
    });
    await sw.install();
    expect([...sw.store.keys()]).toEqual(
      expect.arrayContaining(["/", "/assets/entry-1.js", "/assets/route-1.js"]),
    );
    failing = true;
    expect(await (await sw.navigate("/issues"))?.text()).toBe(SHELL);
    sw.offline();
    expect(await (await sw.navigate("/issues"))?.text()).toBe(SHELL);
    expect(await (await sw.get("/assets/route-1.js"))?.text()).toBe("route");
  });

  it("leaves API requests to the network and drops assets from older builds", async () => {
    let shell = SHELL;
    const sw = worker({
      "/": () => html(shell)(),
      "/assets/entry-1.js": () => new Response("old"),
      "/assets/entry-2.js": () => new Response("new"),
      "/assets/manifest-1.js": () => new Response(""),
      "/assets/font-1.woff2": () => new Response("font"),
    });
    await sw.install();
    await sw.get("/assets/font-1.woff2");
    expect(await sw.get("/api/me")).toBeUndefined();
    shell = `<script type="module" src="/assets/entry-2.js"></script>`;
    await sw.navigate("/");
    expect(sw.store.has("/assets/entry-1.js")).toBe(false);
    expect(sw.store.has("/assets/entry-2.js")).toBe(true);
    expect(sw.store.has("/assets/font-1.woff2")).toBe(true);
  });
});
