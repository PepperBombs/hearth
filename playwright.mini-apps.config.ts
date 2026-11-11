import fs from "node:fs";
import path from "node:path";
import { defineConfig } from "@playwright/test";
import {
  MEMBER_EMAIL,
  MINI_APPS_DIRS,
  MINI_APPS_MEMBER_PORT,
  MINI_APPS_MEMBER_URL,
  MINI_APPS_OWNER_PORT,
  MINI_APPS_OWNER_URL,
  MINI_APPS_SHARED_DB,
  MINI_APPS_SHARED_DB_DIR,
  OWNER_EMAIL,
  realServerCommand,
} from "./e2e/servers.ts";

/**
 * End-to-end tests of mini-apps from another repository, in e2e/mini-apps.
 * Run them with `pnpm e2e:mini-apps`; `pnpm e2e` leaves them out.
 *
 * Hearth is built (`pnpm build`) with the mini-apps of the folders named in
 * HEARTH_APPS_DIR, or of `hearth-stones` beside this checkout when it is
 * not set, as the server's deploy builds the two. Then two copies of the
 * real server start, with sign-in switched off, over one database file made
 * afresh: one treats every request as the owner, the other as Lin, a member
 * of the owner's family (e2e/servers.ts). So a test can be two people of a
 * family using an app on one server, each in a browser of their own.
 *
 * Each file in e2e/mini-apps is named after the app it is about
 * (`grocery.spec.ts`) and runs only when the folders hold that app: the
 * apps come and go with the other repository, and a folder without the app
 * has nothing for its file to test. With none of them, nothing runs and the
 * command passes. When an app's texts or layout change there, its file here
 * changes with them.
 *
 * Afterwards the generated lists and both dist folders hold those apps,
 * until the next `pnpm build`. Ports are 4183 and 4184; set
 * HEARTH_E2E_MINI_APPS_PORT to move both.
 */
const reuseExistingServer = !process.env.CI;

/** The IDs of the apps the folders hold: as for `hearth-apps sync`, each folder's direct children with a manifest.ts. */
function appsIn(folders: string): Set<string> {
  const ids = new Set<string>();
  for (const folder of folders.split(path.delimiter).filter((entry) => entry !== "")) {
    const dir = path.resolve(import.meta.dirname, folder);
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && fs.existsSync(path.join(dir, entry.name, "manifest.ts"))) ids.add(entry.name);
    }
  }
  return ids;
}

const held = [...appsIn(MINI_APPS_DIRS)];
/** The test files of the apps the folders hold; a pattern that matches nothing when they hold none. */
const testsOfHeldApps = held.length > 0 ? new RegExp(`[\\\\/]e2e[\\\\/]mini-apps[\\\\/](${held.join("|")})\\.spec\\.ts$`) : /^$/;

export default defineConfig({
  testDir: "./e2e/mini-apps",
  testMatch: testsOfHeldApps,
  outputDir: "./test-results/mini-apps",
  // The tests share one server, with two people on it.
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: [["list"]],
  use: {
    browserName: "chromium",
    baseURL: MINI_APPS_OWNER_URL,
    viewport: { width: 1440, height: 900 },
    locale: "en-US",
    timezoneId: "UTC",
    colorScheme: "light",
    serviceWorkers: "block",
    trace: "off",
    video: "off",
    screenshot: "off",
  },
  webServer: [
    {
      name: "server",
      // Builds Hearth with the mini-apps, then starts the owner's copy on a database file of its
      // own making: what an earlier run left there is deleted.
      command: `pnpm build && rm -rf ${JSON.stringify(MINI_APPS_SHARED_DB_DIR)} && ${realServerCommand(MINI_APPS_OWNER_PORT, OWNER_EMAIL, MINI_APPS_SHARED_DB)}`,
      env: { HEARTH_APPS_DIR: MINI_APPS_DIRS },
      url: `${MINI_APPS_OWNER_URL}/api/health`,
      reuseExistingServer,
      timeout: 180_000,
      stdout: "ignore",
      stderr: "pipe",
    },
    {
      name: "server as a family member",
      // Started after the owner's copy, which created and migrated the database they share.
      command: realServerCommand(MINI_APPS_MEMBER_PORT, MEMBER_EMAIL, MINI_APPS_SHARED_DB),
      url: `${MINI_APPS_MEMBER_URL}/api/health`,
      reuseExistingServer,
      timeout: 120_000,
      stdout: "ignore",
      stderr: "pipe",
    },
  ],
});
