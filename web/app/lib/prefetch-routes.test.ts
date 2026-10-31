import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { prefetchRoutesWhenIdle, routeLinks } from "./prefetch-routes";

describe("routeLinks", () => {
  it("preloads every module a route loads, split exports included, once each", () => {
    const links = routeLinks({
      root: {
        module: "/assets/root-1.js",
        imports: ["/assets/chunk-a.js"],
        css: ["/assets/root-1.css"],
      },
      "routes/authed": {
        module: "/assets/authed-1.js",
        clientLoaderModule: "/assets/authed-1-loader.js",
        clientActionModule: "/assets/authed-1-action.js",
        clientMiddlewareModule: "/assets/authed-1-middleware.js",
        hydrateFallbackModule: "/assets/authed-1-fallback.js",
        imports: ["/assets/chunk-a.js"],
      },
      "routes/inbox-issue": {
        module: "/assets/inbox-issue-1.js",
        imports: ["/assets/editor-1.js"],
        css: ["/assets/root-1.css"],
      },
    });

    expect(links).toEqual([
      { rel: "modulepreload", href: "/assets/inbox-issue-1.js" },
      { rel: "modulepreload", href: "/assets/editor-1.js" },
      { rel: "modulepreload", href: "/assets/root-1.js" },
      { rel: "modulepreload", href: "/assets/chunk-a.js" },
      { rel: "modulepreload", href: "/assets/authed-1.js" },
      { rel: "modulepreload", href: "/assets/authed-1-action.js" },
      { rel: "modulepreload", href: "/assets/authed-1-loader.js" },
      { rel: "modulepreload", href: "/assets/authed-1-middleware.js" },
      { rel: "modulepreload", href: "/assets/authed-1-fallback.js" },
      { rel: "prefetch", href: "/assets/root-1.css", as: "style" },
    ]);
  });

  it("warms the issue page, board and inbox before the rest", () => {
    const hrefs = routeLinks({
      "routes/settings": { module: "/assets/settings.js" },
      "routes/inbox": { module: "/assets/inbox.js" },
      "routes/team-board": { module: "/assets/board.js" },
      "routes/issue": { module: "/assets/issue.js" },
    }).map((link) => link.href);

    expect(hrefs).toEqual([
      "/assets/issue.js",
      "/assets/board.js",
      "/assets/inbox.js",
      "/assets/settings.js",
    ]);
  });
});

describe("prefetchRoutesWhenIdle", () => {
  afterEach(() => vi.unstubAllGlobals());

  /** A `<link>` whose attributes read back the properties the helper sets. */
  class Link {
    getAttribute(name: string) {
      return Reflect.get(this, name) ?? null;
    }
  }

  function browser(connection?: { saveData?: boolean; effectiveType?: string }) {
    const idle = new Map<number, () => void>();
    let handles = 0;
    const head: Link[] = [];
    vi.stubGlobal("window", {
      __reactRouterManifest: { routes: { "routes/issue": { module: "/assets/issue.js" } } },
      requestIdleCallback: (run: () => void) => {
        idle.set(++handles, run);
        return handles;
      },
    });
    vi.stubGlobal("requestIdleCallback", window.requestIdleCallback);
    vi.stubGlobal("cancelIdleCallback", (handle: number) => idle.delete(handle));
    vi.stubGlobal("navigator", { connection });
    vi.stubGlobal("document", {
      createElement: () => new Link(),
      querySelectorAll: () => head,
      head: { append: (link: Link) => head.push(link) },
    });
    return {
      head,
      idle: () => {
        const runs = [...idle.values()];
        idle.clear();
        for (const run of runs) run();
      },
    };
  }

  it("adds the links once the browser goes idle", () => {
    const page = browser({ effectiveType: "4g" });
    prefetchRoutesWhenIdle();
    expect(page.head).toEqual([]);

    page.idle();

    expect(page.head).toEqual([{ rel: "modulepreload", href: "/assets/issue.js" }]);
  });

  it("adds each link once when the workspace layout mounts again", () => {
    const page = browser({ effectiveType: "4g" });
    prefetchRoutesWhenIdle();
    page.idle();
    prefetchRoutesWhenIdle();
    page.idle();

    expect(page.head).toEqual([{ rel: "modulepreload", href: "/assets/issue.js" }]);
  });

  it("adds nothing when the layout unmounts before the browser goes idle", () => {
    const page = browser({ effectiveType: "4g" });
    const cleanup = prefetchRoutesWhenIdle();

    cleanup();
    page.idle();

    expect(page.head).toEqual([]);
  });

  it.each([
    ["Data Saver is on", { saveData: true, effectiveType: "4g" }],
    ["the connection is 2g", { effectiveType: "2g" }],
    ["the connection is slow-2g", { effectiveType: "slow-2g" }],
  ])("downloads nothing when %s", (_, connection) => {
    const page = browser(connection);
    prefetchRoutesWhenIdle();

    page.idle();

    expect(page.head).toEqual([]);
  });
});
