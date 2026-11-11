/**
 * The addresses the end-to-end tests use. Shared by playwright.config.ts
 * and playwright.mini-apps.config.ts, which start the servers, and by the
 * tests that need a second address.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";

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
 * A third copy that treats every request as a member of the owner's
 * family: Lin, whom the owner invites. It works on the owner's database, so
 * the two copies are two people on one server. The stranger's copy keeps a
 * database of its own, in memory.
 */
export const MEMBER_PORT = base + 3;
export const MEMBER_URL = `http://127.0.0.1:${MEMBER_PORT}`;
export const MEMBER_EMAIL = "lin@example.com";

/** The database the owner's and the member's copies share: a fresh file each time the owner's copy starts. */
export const SHARED_DB_DIR = join(tmpdir(), `hearth-e2e-${base}`);
export const SHARED_DB = join(SHARED_DB_DIR, "hearth.db");

/**
 * The mini-apps both builds hold: the framework's own sample apps. A plain
 * `pnpm build` holds none; the end-to-end tests build with these so that the
 * whole path is tried, from an app's folder to a server that answers for it
 * and a web app that carries its widget.
 */
export const APPS_DIR = "packages/fixture-apps";

/** Shown as the build version by every copy. */
export const SERVER_VERSION = "e2e";

/** Set HEARTH_E2E_SERVER=0 to leave the real server out and run only the tests that answer /api themselves. */
export const WITH_REAL_SERVER = process.env.HEARTH_E2E_SERVER !== "0";

/**
 * The command that starts one copy of the built server, serving the built
 * web app, with sign-in switched off: every request it answers is from
 * `devUser`. The server's owner is always OWNER_EMAIL.
 */
export function realServerCommand(port: number, devUser: string, database = ":memory:"): string {
  return [
    "HOST=127.0.0.1",
    `PORT=${port}`,
    "HEARTH_AUTH=dev",
    `HEARTH_OWNER_EMAIL=${OWNER_EMAIL}`,
    `HEARTH_DEV_USER=${devUser}`,
    `HEARTH_DB=${JSON.stringify(database)}`,
    `HEARTH_VERSION=${SERVER_VERSION}`,
    "HEARTH_WEB_DIST=packages/web/dist",
    "node packages/server/dist/main.js",
  ].join(" ");
}

/**
 * The end-to-end tests of mini-apps from another repository
 * (playwright.mini-apps.config.ts, `pnpm e2e:mini-apps`): Hearth built with
 * those apps, and two copies of its server, the owner's and Lin's, over a
 * database file of their own. Their ports follow the ones above, so the two
 * runs never meet; HEARTH_E2E_MINI_APPS_PORT moves them.
 */
const miniAppsBase = Number(process.env.HEARTH_E2E_MINI_APPS_PORT ?? base + 10);
export const MINI_APPS_OWNER_PORT = miniAppsBase;
export const MINI_APPS_OWNER_URL = `http://127.0.0.1:${MINI_APPS_OWNER_PORT}`;
export const MINI_APPS_MEMBER_PORT = miniAppsBase + 1;
export const MINI_APPS_MEMBER_URL = `http://127.0.0.1:${MINI_APPS_MEMBER_PORT}`;
export const MINI_APPS_SHARED_DB_DIR = join(tmpdir(), `hearth-e2e-mini-apps-${miniAppsBase}`);
export const MINI_APPS_SHARED_DB = join(MINI_APPS_SHARED_DB_DIR, "hearth.db");

/**
 * The folders of mini-apps those tests build in: HEARTH_APPS_DIR, read as
 * `hearth-apps sync` reads it (several separated like PATH, a relative one
 * from the root of this checkout), or else `hearth-stones` beside this
 * checkout, as the server and CI have it.
 */
export const MINI_APPS_DIRS = process.env.HEARTH_APPS_DIR || "../hearth-stones";
