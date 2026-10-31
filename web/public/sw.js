// Keeps the app shell and its build assets so a reload works while the server is unreachable.
// Data comes from the IndexedDB replicas; /api is never cached here.
const CACHE = "bw-shell-v1";
// The server answers every app path with the same shell, including its Content-Security-Policy.
const SHELL = "/";
const STATIC = ["/theme.js", "/favicon.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    fetch(SHELL)
      .then((response) => keepShell(response))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== location.origin) return;
  if (url.pathname.startsWith("/api/") || url.pathname === "/health") return;
  if (request.mode === "navigate") event.respondWith(navigate(event));
  // Build assets are content-hashed, so a cached copy never goes stale.
  else if (url.pathname.startsWith("/assets/")) event.respondWith(cacheFirst(event));
  else if (STATIC.includes(url.pathname)) event.respondWith(staleWhileRevalidate(event));
});

async function navigate(event) {
  try {
    const response = await fetch(event.request);
    if (response.status < 500) {
      if (response.ok && response.headers.get("content-type")?.startsWith("text/html"))
        event.waitUntil(keepShell(response.clone()));
      return response;
    }
    return (await caches.match(SHELL)) ?? response;
  } catch (error) {
    const shell = await caches.match(SHELL);
    if (shell) return shell;
    throw error;
  }
}

async function cacheFirst(event) {
  const cached = await caches.match(event.request);
  if (cached) return cached;
  const response = await fetch(event.request);
  if (response.ok) {
    const copy = response.clone();
    event.waitUntil(caches.open(CACHE).then((cache) => cache.put(event.request, copy)));
  }
  return response;
}

async function staleWhileRevalidate(event) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(event.request);
  const fresh = fetch(event.request).then((response) => {
    if (response.ok) void cache.put(event.request, response.clone());
    return response;
  });
  if (!cached) return fresh;
  event.waitUntil(fresh.catch(() => undefined));
  return cached;
}

const ASSET = /\/assets\/[^"'\s)]+/g;

// Stores the shell and the assets it boots with, then drops assets from older builds.
// Route modules are cached by cacheFirst as the page loads them, so install downloads no more than a visit.
async function keepShell(response) {
  if (!response.ok) return;
  const cache = await caches.open(CACHE);
  const html = await response.clone().text();
  await cache.put(SHELL, response);
  const shell = new Set([...STATIC, ...(html.match(ASSET) ?? [])]);
  // A missing file only costs that file offline; it must not stop the rest from being stored.
  for (const path of shell) if (!(await cache.match(path))) await cache.add(path).catch(() => {});
  await prune(cache, await currentBuild(cache, shell));
}

// The shell's assets plus the route modules its manifest lists, so pruning keeps cached routes.
async function currentBuild(cache, shell) {
  const assets = new Set(shell);
  for (const manifest of [...shell].filter((path) => path.includes("/manifest-"))) {
    const text = await cache
      .match(manifest)
      .then((response) => response?.text() ?? "")
      .catch(() => "");
    for (const path of text.match(ASSET) ?? []) assets.add(path);
  }
  return assets;
}

// Fonts are referenced from CSS, which isn't scanned, so they stay.
async function prune(cache, assets) {
  for (const request of await cache.keys()) {
    const path = new URL(request.url).pathname;
    if (path.startsWith("/assets/") && !assets.has(path) && !/\.(woff2?|ttf)$/.test(path))
      await cache.delete(request);
  }
}
