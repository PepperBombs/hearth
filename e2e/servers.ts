/**
 * The addresses the end-to-end tests use. Shared by playwright.config.ts
 * and playwright.mini-apps.config.ts, which start the servers, and by the
 * tests that need a second address.
 */
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

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
 * The stand-in answers for every `ctx.fetch` of the owner's and the
 * member's copies, which run their apps' jobs (HEARTH_FETCH_STANDINS): one
 * file for both, beside their database, so that it goes when the owner's
 * copy starts. Until a test writes it with `writeStandIns`, every request a
 * job makes fails as the network would.
 */
export const STAND_INS = join(SHARED_DB_DIR, "stand-ins.json");

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
 *
 * No app it holds fetches anything from outside. Given `standIns`, the path
 * of a file of stand-in answers, it runs its apps' jobs and the file answers
 * every request they make (HEARTH_FETCH_STANDINS, which only a server in dev
 * mode accepts); without one its jobs are switched off (HEARTH_JOBS=off).
 */
export function realServerCommand(port: number, devUser: string, database = ":memory:", standIns: string | null = null): string {
  return [
    "HOST=127.0.0.1",
    `PORT=${port}`,
    "HEARTH_AUTH=dev",
    `HEARTH_OWNER_EMAIL=${OWNER_EMAIL}`,
    `HEARTH_DEV_USER=${devUser}`,
    `HEARTH_DB=${JSON.stringify(database)}`,
    `HEARTH_VERSION=${SERVER_VERSION}`,
    "HEARTH_WEB_DIST=packages/web/dist",
    ...(standIns === null ? ["HEARTH_JOBS=off"] : ["HEARTH_JOBS=on", `HEARTH_FETCH_STANDINS=${JSON.stringify(standIns)}`]),
    "node packages/server/dist/main.js",
  ].join(" ");
}

/**
 * Writes a file of stand-in answers whole: into a file of its own first,
 * then renamed into place, so that a server, which reads it again at every
 * request, never reads half of it. Each entry answers the requests to its
 * `url` (and `query`), with a `status`, `headers` and `body`, or fails them
 * with `error` ("network" or "timeout"); see packages/server/README.md.
 */
export function writeStandIns(path: string, standIns: readonly unknown[]): void {
  mkdirSync(dirname(path), { recursive: true });
  const next = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(next, `${JSON.stringify(standIns, null, 2)}\n`);
  renameSync(next, path);
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
 * The stand-in answers for every `ctx.fetch` of those two copies, which
 * run their apps' jobs, as STAND_INS is for `pnpm e2e`: one file for both,
 * beside their database, so that it goes when the owner's copy starts.
 * Until a test writes it with `writeStandIns`, every request a job makes
 * fails as the network would, so no job of a mini-app reaches the host its
 * manifest names (GitHub Trending's `api.github.com` among them).
 */
export const MINI_APPS_STAND_INS = join(MINI_APPS_SHARED_DB_DIR, "stand-ins.json");

/**
 * The folders of mini-apps those tests build in: HEARTH_APPS_DIR, read as
 * `hearth-apps sync` reads it (several separated like PATH, a relative one
 * from the root of this checkout), or else `hearth-stones` beside this
 * checkout, as the server and CI have it.
 */
export const MINI_APPS_DIRS = process.env.HEARTH_APPS_DIR || "../hearth-stones";
