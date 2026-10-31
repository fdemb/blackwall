/** The part of a React Router manifest entry that names the files a route loads. */
type ManifestRoute = {
  module: string;
  clientActionModule?: string;
  clientLoaderModule?: string;
  clientMiddlewareModule?: string;
  hydrateFallbackModule?: string;
  imports?: string[];
  css?: string[];
};

type Connection = { saveData?: boolean; effectiveType?: string };

declare global {
  interface Window {
    __reactRouterManifest?: { routes: Record<string, ManifestRoute> };
  }
  interface Navigator {
    connection?: Connection;
  }
}

type PrefetchLink = { rel: "modulepreload" | "prefetch"; href: string; as?: "style" };

/** The pages people open most from the app shell, warmed before the rest. */
const FIRST = [
  "routes/issue",
  "routes/team",
  "routes/team-board",
  "routes/inbox",
  "routes/inbox-issue",
];

/**
 * One link per file any route can load, the same link types `<Link prefetch>` renders,
 * so navigating to a route only evaluates code that is already downloaded and parsed.
 * Route exports split into their own chunks count too, since the router imports them.
 */
export function routeLinks(routes: Record<string, ManifestRoute>): PrefetchLink[] {
  const ids = [...FIRST.filter((id) => id in routes), ...Object.keys(routes)];
  const modules = new Set<string>();
  const styles = new Set<string>();
  for (const id of ids) {
    const route = routes[id];
    for (const href of [
      route.module,
      route.clientActionModule,
      route.clientLoaderModule,
      route.clientMiddlewareModule,
      route.hydrateFallbackModule,
      ...(route.imports ?? []),
    ]) {
      if (href) modules.add(href);
    }
    for (const href of route.css ?? []) styles.add(href);
  }
  return [
    ...[...modules].map((href) => ({ rel: "modulepreload" as const, href })),
    ...[...styles].map((href) => ({ rel: "prefetch" as const, href, as: "style" as const })),
  ];
}

/** Data Saver is on, or the link is too slow to spend on code nobody asked for yet. */
function constrained(connection: Connection | undefined) {
  return (
    connection?.saveData === true ||
    connection?.effectiveType === "slow-2g" ||
    connection?.effectiveType === "2g"
  );
}

/**
 * Files already requested in a way that serves each link type. A module is only in the module
 * map once preloaded or imported, while any fetch of a stylesheet fills the cache a style
 * prefetch would.
 */
function presentLinks(): Record<PrefetchLink["rel"], Set<string>> {
  const present = { modulepreload: new Set<string>(), prefetch: new Set<string>() };
  for (const element of document.querySelectorAll("link, script")) {
    const href = element.getAttribute("href") ?? element.getAttribute("src");
    if (!href) continue;
    const url = new URL(href, document.baseURI).href;
    const rel = element.getAttribute("rel");
    const module =
      element.tagName === "SCRIPT"
        ? element.getAttribute("type") === "module"
        : rel === "modulepreload" || rel === "preload";
    if (module) present.modulepreload.add(url);
    if (rel === "stylesheet" || rel === "preload" || rel === "prefetch") present.prefetch.add(url);
  }
  return present;
}

/** Prefetches every route's code when the browser is idle, unless the connection is constrained. */
export function prefetchRoutesWhenIdle() {
  const manifest = window.__reactRouterManifest;
  if (!manifest || constrained(navigator.connection)) return () => {};
  const prefetch = () => {
    // The layout remounts when someone leaves a workspace and comes back.
    const present = presentLinks();
    for (const { rel, href, as } of routeLinks(manifest.routes)) {
      if (present[rel].has(new URL(href, document.baseURI).href)) continue;
      const link = document.createElement("link");
      link.rel = rel;
      link.href = href;
      if (as) link.as = as;
      document.head.append(link);
    }
  };
  // Safari has no requestIdleCallback.
  if (!("requestIdleCallback" in window)) {
    const timer = setTimeout(prefetch, 2000);
    return () => clearTimeout(timer);
  }
  const handle = requestIdleCallback(prefetch, { timeout: 10_000 });
  return () => cancelIdleCallback(handle);
}
