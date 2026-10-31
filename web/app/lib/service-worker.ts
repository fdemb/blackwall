/** Same-origin build assets the page has downloaded so far. */
export function loadedAssets() {
  const urls = [
    ...performance.getEntriesByType("resource").map((entry) => entry.name),
    ...[...document.querySelectorAll("link, script")].map(
      (element) => element.getAttribute("href") ?? element.getAttribute("src"),
    ),
  ];
  const assets = new Set<string>();
  for (const href of urls) {
    if (!href) continue;
    const url = new URL(href, document.baseURI);
    if (url.origin === location.origin && url.pathname.startsWith("/assets/")) assets.add(url.href);
  }
  return [...assets];
}

/**
 * Registers the worker that keeps the app shell for offline reloads. The first visit loads its
 * modules before the worker controls the page, so once it does the page tells it what to keep.
 */
export function registerServiceWorker() {
  const { serviceWorker } = navigator;
  const report = () =>
    serviceWorker.controller?.postMessage({ type: "loaded-assets", urls: loadedAssets() });
  serviceWorker.addEventListener("controllerchange", report);
  serviceWorker.register("/sw.js").catch(() => {});
  report();
  return () => serviceWorker.removeEventListener("controllerchange", report);
}
