/**
 * The addresses the end-to-end tests use. Shared by playwright.config.ts,
 * which starts the servers, and by the tests that need a second address.
 */
const base = Number(process.env.HEARTH_E2E_PORT ?? 4173);

/** The built web app on its own, served by `vite preview`. Tests answer /api themselves. */
export const WEB_PORT = base;
export const WEB_URL = `http://127.0.0.1:${WEB_PORT}`;

/** The real server, with sign-in switched off and every request treated as the owner. */
export const OWNER_PORT = base + 1;
export const OWNER_URL = `http://127.0.0.1:${OWNER_PORT}`;
export const OWNER_EMAIL = "owner@example.com";

/** A second copy of the real server that treats every request as someone who was never invited. */
export const GUEST_PORT = base + 2;
export const GUEST_URL = `http://127.0.0.1:${GUEST_PORT}`;
export const GUEST_EMAIL = "guest@example.com";

/**
 * The mini-apps both builds hold: the framework's own sample apps. A plain
 * `pnpm build` holds none; the end-to-end tests build with these so that the
 * whole path is tried, from an app's folder to a server that answers for it
 * and a web app that carries its widget.
 */
export const APPS_DIR = "packages/fixture-apps";

/** Shown as the build version by both copies. */
export const SERVER_VERSION = "e2e";

/** Set HEARTH_E2E_SERVER=0 to leave the real server out and run only the tests that answer /api themselves. */
export const WITH_REAL_SERVER = process.env.HEARTH_E2E_SERVER !== "0";
