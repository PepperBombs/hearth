/**
 * Loads the page again from the server. The service worker answers a page
 * load from the network first (sw/sw.js), so this brings the current build.
 * In a file of its own so that tests can stand in for it.
 */
export function reloadPage(): void {
  window.location.reload();
}
