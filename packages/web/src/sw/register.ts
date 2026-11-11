/**
 * Registers the service worker that caches the static shell (see sw.js).
 * Only in production builds: in development it would get in the way of hot reloading.
 */
export function registerServiceWorker(): void {
  if (!import.meta.env.PROD || !("serviceWorker" in navigator)) return;
  window.addEventListener("load", () => {
    // "none" makes the browser check the server for a new worker rather than trust its HTTP cache.
    navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" }).catch(() => {
      /* The app works without it; there is nothing useful to tell the person. */
    });
  });
}
