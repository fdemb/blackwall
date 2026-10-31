/** The part of a React Router manifest entry that names the files a route loads. */
type ManifestRoute = { module: string; imports?: string[]; css?: string[] };

declare global {
  interface Window {
    __reactRouterManifest?: { routes: Record<string, ManifestRoute> };
  }
}

type PrefetchLink = { rel: "modulepreload" | "prefetch"; href: string; as?: "style" };

/**
 * One link per file any route can load, the same link types `<Link prefetch>` renders,
 * so navigating to a route only evaluates code that is already downloaded and parsed.
 */
export function routeLinks(routes: Record<string, ManifestRoute>): PrefetchLink[] {
  const modules = new Set<string>();
  const styles = new Set<string>();
  for (const route of Object.values(routes)) {
    modules.add(route.module);
    for (const href of route.imports ?? []) modules.add(href);
    for (const href of route.css ?? []) styles.add(href);
  }
  return [
    ...[...modules].map((href) => ({ rel: "modulepreload" as const, href })),
    ...[...styles].map((href) => ({ rel: "prefetch" as const, href, as: "style" as const })),
  ];
}

/** Prefetches every route's code once the browser is idle after the first page renders. */
export function prefetchRoutesWhenIdle() {
  const manifest = window.__reactRouterManifest;
  if (!manifest) return () => {};
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
    const timer = setTimeout(prefetch, 1000);
    return () => clearTimeout(timer);
  }
  const handle = requestIdleCallback(prefetch, { timeout: 3000 });
  return () => cancelIdleCallback(handle);
}
