import { defineConfig } from "@playwright/test";
import {
  GUEST_EMAIL,
  GUEST_PORT,
  GUEST_URL,
  MEMBER_EMAIL,
  MEMBER_PORT,
  MEMBER_URL,
  MODEL_PORT,
  OWNER_EMAIL,
  OWNER_PORT,
  OWNER_URL,
  SHARED_DB,
  SHARED_DB_DIR,
  WEB_PORT,
  WEB_URL,
  WITH_REAL_SERVER,
  realServerCommand as realServer,
} from "./e2e/servers.ts";

/**
 * End-to-end tests, in ./e2e. Run them with `pnpm e2e`.
 *
 * Two projects:
 *
 * - "web" runs the production build of packages/web, served by `vite preview`.
 *   Every /api request is answered by a stand-in (e2e/fixtures.ts), so each
 *   test decides exactly what the server says: a member, someone not invited,
 *   a failure. This is where almost every test lives.
 *
 * - "server" runs the few tests in e2e/real-server.spec.ts,
 *   e2e/chat-history.spec.ts, e2e/deleting.spec.ts and e2e/center.spec.ts against the real
 *   server, built and started here with sign-in switched off
 *   (HEARTH_AUTH=dev), serving the same built web app. Three copies run: one that treats every
 *   request as the owner, one as a member of the owner's family and one as a
 *   stranger. The owner's and the member's share a database file in the
 *   system's temporary folder, made afresh when the owner's copy starts, so
 *   that they are two people on one server; the stranger's is in memory.
 *   Every copy answers its apps' fetches from one file of stand-in answers
 *   beside that database (STAND_INS), which the tests write, so that no app
 *   reaches the network. Their chat asks a stand-in model, a small server
 *   started here too (e2e/model-stand-in.ts), never a real one. The tests
 *   share the owner, so they run one at a time. Set HEARTH_E2E_SERVER=0 to
 *   leave this project out.
 *
 * Ports are 4173 to 4177; set HEARTH_E2E_PORT to move all five.
 */
const reuseExistingServer = !process.env.CI;

/** The tests that run against the real server. */
const REAL_SERVER_TESTS = /(real-server|chat-history|deleting|center)\.spec\.ts$/;

export default defineConfig({
  testDir: "./e2e",
  outputDir: "./test-results",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: [["list"]],
  use: {
    browserName: "chromium",
    viewport: { width: 1440, height: 900 },
    locale: "en-US",
    timezoneId: "UTC",
    colorScheme: "light",
    // Tests of the service worker, and those that collect the errors of an app's sandboxed page,
    // switch this back on for themselves (see docs/notes/e2e.md).
    serviceWorkers: "block",
    trace: "off",
    video: "off",
    screenshot: "off",
  },
  projects: [
    { name: "web", testIgnore: REAL_SERVER_TESTS, use: { baseURL: WEB_URL } },
    // One at a time: the tests share the owner's preferences, model and spaces.
    ...(WITH_REAL_SERVER ? [{ name: "server", testMatch: REAL_SERVER_TESTS, workers: 1, use: { baseURL: OWNER_URL } }] : []),
  ],
  webServer: [
    {
      name: "web",
      command: `pnpm --filter @hearth/web build && pnpm --filter @hearth/web exec vite preview --host 127.0.0.1 --port ${WEB_PORT} --strictPort`,
      url: WEB_URL,
      reuseExistingServer,
      timeout: 120_000,
      stdout: "ignore",
      stderr: "pipe",
    },
    ...(WITH_REAL_SERVER
      ? [
          {
            name: "stand-in model",
            // Answers the chat of every copy below, in place of a real model. Node runs it as it is, stripping its types.
            command: `node e2e/model-stand-in.ts ${MODEL_PORT}`,
            port: MODEL_PORT,
            reuseExistingServer,
            timeout: 30_000,
            stdout: "ignore" as const,
            stderr: "pipe" as const,
          },
          {
            name: "server",
            // Builds the server, then starts the copy that treats every request as the owner,
            // on a database file of its own making: what an earlier run left there, the file of
            // stand-ins with it, is deleted. The server reads the web app's folder on each request,
            // so it does not matter whether the web build above has finished when this starts.
            command: `pnpm --filter @hearth/server build && rm -rf ${JSON.stringify(SHARED_DB_DIR)} && ${realServer(OWNER_PORT, OWNER_EMAIL, SHARED_DB)}`,
            url: `${OWNER_URL}/api/health`,
            reuseExistingServer,
            timeout: 120_000,
            stdout: "ignore" as const,
            stderr: "pipe" as const,
          },
          {
            name: "server as a family member",
            // Started after the owner's copy, which created and migrated the database they share.
            command: realServer(MEMBER_PORT, MEMBER_EMAIL, SHARED_DB),
            url: `${MEMBER_URL}/api/health`,
            reuseExistingServer,
            timeout: 120_000,
            stdout: "ignore" as const,
            stderr: "pipe" as const,
          },
          {
            name: "server as a stranger",
            // Playwright starts these entries one after another, so the build above is done.
            // Each copy needs its own entry: with reuseExistingServer off (as in CI),
            // Playwright refuses an address that something else already answers on.
            command: realServer(GUEST_PORT, GUEST_EMAIL),
            url: `${GUEST_URL}/api/health`,
            reuseExistingServer,
            timeout: 120_000,
            stdout: "ignore" as const,
            stderr: "pipe" as const,
          },
        ]
      : []),
  ],
});
