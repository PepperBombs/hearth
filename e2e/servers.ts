/**
 * The addresses the end-to-end tests use. Shared by playwright.config.ts,
 * which starts the servers, and by the tests that need a second address.
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
 * The stand-in answers for every fetch an app makes through the server
 * (`hearth.fetch`, HEARTH_FETCH_STANDINS), in every copy: one file, beside
 * the owner's and the member's database, so that it goes when the owner's
 * copy starts. Until a test writes it with `writeStandIns`, every such
 * fetch fails as the network would, so no app reaches the hosts it names.
 */
export const STAND_INS = join(SHARED_DB_DIR, "stand-ins.json");

/** Shown as the build version by every copy. */
export const SERVER_VERSION = "e2e";

/** Set HEARTH_E2E_SERVER=0 to leave the real server out and run only the tests that answer /api themselves. */
export const WITH_REAL_SERVER = process.env.HEARTH_E2E_SERVER !== "0";

/**
 * The command that starts one copy of the built server, serving the built
 * web app, with sign-in switched off: every request it answers is from
 * `devUser`. The server's owner is always OWNER_EMAIL.
 *
 * No app it holds reaches the network: the file of stand-in answers,
 * STAND_INS, answers every fetch (HEARTH_FETCH_STANDINS, which only a
 * server in dev mode accepts).
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
    `HEARTH_FETCH_STANDINS=${JSON.stringify(STAND_INS)}`,
    "node packages/server/dist/main.js",
  ].join(" ");
}

/**
 * Writes STAND_INS whole: into a file of its own first, then renamed into
 * place, so that a server, which reads it again at every request, never
 * reads half of it. Each entry answers the requests to its `url` (and
 * `query`), with a `status`, `headers` and `body`, or fails them with
 * `error` ("network" or "timeout"); see packages/server/README.md.
 */
export function writeStandIns(standIns: readonly unknown[]): void {
  mkdirSync(dirname(STAND_INS), { recursive: true });
  const next = `${STAND_INS}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(next, `${JSON.stringify(standIns, null, 2)}\n`);
  renameSync(next, STAND_INS);
}
