import { defineConfig } from "@playwright/test";
import {
  APPS_DIR,
  GUEST_EMAIL,
  GUEST_PORT,
  GUEST_URL,
  MEMBER_EMAIL,
  MEMBER_PORT,
  MEMBER_URL,
  OWNER_EMAIL,
  OWNER_PORT,
  OWNER_URL,
  SHARED_DB,
  SHARED_DB_DIR,
  STAND_INS,
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
 * - "server" runs the few tests in e2e/real-server.spec.ts against the real
 *   server, built and started here with sign-in switched off (HEARTH_AUTH=dev),
 *   serving the same built web app. Three copies run: one that treats every
 *   request as the owner, one as a member of the owner's family and one as a
 *   stranger. The owner's and the member's share a database file in the
 *   system's temporary folder, made afresh when the owner's copy starts, so
 *   that they are two people on one server; the stranger's is in memory.
 *   The owner's and the member's run their apps' jobs, and share one file of
 *   stand-in answers beside the database (STAND_INS), which the tests write,
 *   so that no job reaches the network; the stranger's runs none.
 *   Set HEARTH_E2E_SERVER=0 to leave this project out.
 *
 * Both builds hold the framework's sample apps (packages/fixture-apps):
 * every build command below runs `pnpm apps:sync` first, with
 * HEARTH_APPS_DIR naming that folder. Afterwards the generated lists and
 * both dist folders hold those apps, until the next `pnpm build`.
 *
 * The tests in e2e/mini-apps are not run here: they are about mini-apps of
 * another repository, built in by playwright.mini-apps.config.ts.
 *
 * Ports are 4173 to 4176; set HEARTH_E2E_PORT to move all four.
 */
const reuseExistingServer = !process.env.CI;

/** What every command that builds is given: the folder of mini-apps to build in. */
const buildEnv = { HEARTH_APPS_DIR: APPS_DIR };

/** The tests of mini-apps from another repository, which playwright.mini-apps.config.ts runs. */
const MINI_APPS_TESTS = /[\\/]e2e[\\/]mini-apps[\\/]/;

export default defineConfig({
  testDir: "./e2e",
  testIgnore: MINI_APPS_TESTS,
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
    // Tests of the service worker switch this back on for themselves.
    serviceWorkers: "block",
    trace: "off",
    video: "off",
    screenshot: "off",
  },
  projects: [
    { name: "web", testIgnore: [/real-server\.spec\.ts$/, MINI_APPS_TESTS], use: { baseURL: WEB_URL } },
    ...(WITH_REAL_SERVER ? [{ name: "server", testMatch: /real-server\.spec\.ts$/, use: { baseURL: OWNER_URL } }] : []),
  ],
  webServer: [
    {
      name: "web",
      command: `pnpm apps:sync && pnpm --filter @hearth/web build && pnpm --filter @hearth/web exec vite preview --host 127.0.0.1 --port ${WEB_PORT} --strictPort`,
      env: buildEnv,
      url: WEB_URL,
      reuseExistingServer,
      timeout: 120_000,
      stdout: "ignore",
      stderr: "pipe",
    },
    ...(WITH_REAL_SERVER
      ? [
          {
            name: "server",
            // Builds the server, then starts the copy that treats every request as the owner,
            // on a database file of its own making: what an earlier run left there is deleted.
            // The server reads the web app's folder on each request, so it does not matter
            // whether the web build above has finished when this starts.
            // The list of apps is written again here: it is the same list, and this
            // entry must not depend on the one above having got that far.
            command: `pnpm apps:sync && pnpm --filter @hearth/server build && rm -rf ${JSON.stringify(SHARED_DB_DIR)} && ${realServer(OWNER_PORT, OWNER_EMAIL, SHARED_DB, STAND_INS)}`,
            env: buildEnv,
            url: `${OWNER_URL}/api/health`,
            reuseExistingServer,
            timeout: 120_000,
            stdout: "ignore" as const,
            stderr: "pipe" as const,
          },
          {
            name: "server as a family member",
            // Started after the owner's copy, which created and migrated the database they share.
            // Its jobs run too, over the same stand-ins: the claim in the database keeps each run single.
            command: realServer(MEMBER_PORT, MEMBER_EMAIL, SHARED_DB, STAND_INS),
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
