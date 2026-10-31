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

/** Prefetches every route's code when the browser is idle, unless the connection is constrained. */
export function prefetchRoutesWhenIdle() {
  const manifest = window.__reactRouterManifest;
  if (!manifest || constrained(navigator.connection)) return () => {};
  const prefetch = () => {
    for (const { rel, href, as } of routeLinks(manifest.routes)) {
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
