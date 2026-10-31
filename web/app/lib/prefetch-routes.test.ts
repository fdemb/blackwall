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
    get tagName() {
      return "LINK";
    }
    getAttribute(name: string) {
      return Reflect.get(this, name) ?? null;
    }
  }

  /** An element already in the page, such as the entry script the server rendered. */
  const element = (tagName: string, attributes: Record<string, string>) => ({
    tagName,
    getAttribute: (name: string) => attributes[name] ?? null,
  });

  function browser(
    connection?: { saveData?: boolean; effectiveType?: string },
    existing: ReturnType<typeof element>[] = [],
  ) {
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
      baseURI: "https://blackwall.test/w/acme/issues",
      createElement: () => new Link(),
      querySelectorAll: () => [...existing, ...head],
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

  it.each([
    [
      "an absolute modulepreload",
      element("LINK", { rel: "modulepreload", href: "https://blackwall.test/assets/issue.js" }),
    ],
    [
      "a relative module script",
      element("SCRIPT", { type: "module", src: "../../assets/issue.js" }),
    ],
    ["a preload", element("LINK", { rel: "preload", as: "script", href: "/assets/issue.js" })],
  ])("skips a module the page already loaded through %s", (_, loaded) => {
    const page = browser({ effectiveType: "4g" }, [loaded]);
    prefetchRoutesWhenIdle();

    page.idle();

    expect(page.head).toEqual([]);
  });

  it.each([
    ["only prefetched it", element("LINK", { rel: "prefetch", href: "/assets/issue.js" })],
    ["loaded it as a classic script", element("SCRIPT", { src: "/assets/issue.js" })],
    [
      "loaded another version of it",
      element("LINK", { rel: "modulepreload", href: "/assets/issue.js?v=2" }),
    ],
  ])("preloads a module when the page %s", (_, other) => {
    const page = browser({ effectiveType: "4g" }, [other]);
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
