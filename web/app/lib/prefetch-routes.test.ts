import { describe, expect, it } from "vite-plus/test";
import { routeLinks } from "./prefetch-routes";

describe("routeLinks", () => {
  it("preloads every route module and its shared chunks once, and prefetches its styles", () => {
    const links = routeLinks({
      root: {
        module: "/assets/root-1.js",
        imports: ["/assets/chunk-a.js"],
        css: ["/assets/root-1.css"],
      },
      "routes/issue": {
        module: "/assets/issue-1.js",
        imports: ["/assets/chunk-a.js", "/assets/editor-1.js"],
      },
      "routes/inbox-issue": {
        module: "/assets/inbox-issue-1.js",
        imports: ["/assets/editor-1.js"],
        css: ["/assets/root-1.css"],
      },
    });

    expect(links).toEqual([
      { rel: "modulepreload", href: "/assets/root-1.js" },
      { rel: "modulepreload", href: "/assets/chunk-a.js" },
      { rel: "modulepreload", href: "/assets/issue-1.js" },
      { rel: "modulepreload", href: "/assets/editor-1.js" },
      { rel: "modulepreload", href: "/assets/inbox-issue-1.js" },
      { rel: "prefetch", href: "/assets/root-1.css", as: "style" },
    ]);
  });
});
