import { defineConfig } from "@playwright/test";
import {
  APPS_DIR,
  GUEST_EMAIL,
  GUEST_PORT,
  GUEST_URL,
  OWNER_EMAIL,
  OWNER_PORT,
  OWNER_URL,
  SERVER_VERSION,
  WEB_PORT,
  WEB_URL,
  WITH_REAL_SERVER,
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
 *   server, built and started here with sign-in switched off (HEARTH_AUTH=dev)
 *   and a database held in memory, serving the same built web app. Two copies
 *   run: one that treats every request as the owner, one as a stranger.
 *   Set HEARTH_E2E_SERVER=0 to leave this project out.
 *
 * Both builds hold the framework's sample apps (packages/fixture-apps):
 * every build command below runs `pnpm apps:sync` first, with
 * HEARTH_APPS_DIR naming that folder. Afterwards the generated lists and
 * both dist folders hold those apps, until the next `pnpm build`.
 *
 * Ports are 4173, 4174 and 4175; set HEARTH_E2E_PORT to move all three.
 */
const reuseExistingServer = !process.env.CI;

/** What every command that builds is given: the folder of mini-apps to build in. */
const buildEnv = { HEARTH_APPS_DIR: APPS_DIR };

const realServer = (port: number, devUser: string) =>
  [
    "HOST=127.0.0.1",
    `PORT=${port}`,
    "HEARTH_AUTH=dev",
    `HEARTH_OWNER_EMAIL=${OWNER_EMAIL}`,
    `HEARTH_DEV_USER=${devUser}`,
    "HEARTH_DB=:memory:",
    `HEARTH_VERSION=${SERVER_VERSION}`,
    "HEARTH_WEB_DIST=packages/web/dist",
    "node packages/server/dist/main.js",
  ].join(" ");

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
    // Tests of the service worker switch this back on for themselves.
    serviceWorkers: "block",
    trace: "off",
    video: "off",
    screenshot: "off",
  },
  projects: [
    { name: "web", testIgnore: /real-server\.spec\.ts$/, use: { baseURL: WEB_URL } },
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
            // Builds the server, then starts the copy that treats every request as the owner.
            // The server reads the web app's folder on each request, so it does not matter
            // whether the web build above has finished when this starts.
            // The list of apps is written again here: it is the same list, and this
            // entry must not depend on the one above having got that far.
            command: `pnpm apps:sync && pnpm --filter @hearth/server build && ${realServer(OWNER_PORT, OWNER_EMAIL)}`,
            env: buildEnv,
            url: `${OWNER_URL}/api/health`,
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
