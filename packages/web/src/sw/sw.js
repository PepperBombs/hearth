/*
 * Hearth service worker. Hand-written and small on purpose.
 *
 * It caches only the static shell: the page, its hashed scripts and styles,
 * the manifest and the icons. It never handles /api, so data is always live
 * and nothing personal is stored by the worker.
 *
 * The two placeholders below are filled in by the build (see vite.config.ts).
 * The version changes whenever any shell file changes, which makes the browser
 * install this worker afresh, fill a new cache, and delete the old one.
 */
const VERSION = "__HEARTH_SHELL_VERSION__";
const SHELL_FILES = ["__HEARTH_SHELL_FILES__"];

const CACHE_PREFIX = "hearth-shell-";
const CACHE_NAME = CACHE_PREFIX + VERSION;
const SHELL_PAGE = "/";
/** Paths the worker must leave alone: the API, and Cloudflare Access's own pages. */
const NEVER_HANDLE = ["/api/", "/cdn-cgi/"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      // "reload" skips the HTTP cache so a new version never stores stale files.
      await cache.addAll(SHELL_FILES.map((url) => new Request(url, { cache: "reload" })));
      // Nothing is lazy-loaded, so an open page keeps working with what it has
      // already loaded and it is safe to take over at once.
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
          .map((name) => caches.delete(name)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (NEVER_HANDLE.some((prefix) => url.pathname.startsWith(prefix))) return;

  if (request.mode === "navigate") {
    // Network first, so a new deployment and a sign-in redirect are both seen
    // at once. The cached page is only for when the network is unreachable.
    event.respondWith(
      (async () => {
        try {
          return await fetch(request);
        } catch (error) {
          const cached = await caches.match(SHELL_PAGE, { cacheName: CACHE_NAME, ignoreVary: true });
          if (cached) return cached;
          throw error;
        }
      })(),
    );
    return;
  }

  if (SHELL_FILES.includes(url.pathname)) {
    // Shell files are fixed for this version: cache first.
    event.respondWith(
      (async () => {
        const cached = await caches.match(url.pathname, { cacheName: CACHE_NAME, ignoreVary: true });
        return cached ?? fetch(request);
      })(),
    );
  }
  // Anything else goes to the network untouched.
});
