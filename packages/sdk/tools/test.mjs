/**
 * `hearth-apps test`: runs the tests of mini-apps.
 *
 * An app's tests are its test files (`*.test.ts`, or `.test.` with another
 * JavaScript or TypeScript extension), written with `testApp(server)` from
 * `@hearth/sdk/testing`. `testApp` calls an app's queries and mutations as
 * the server answers them, with the framework's own store and an in-memory
 * database, so the tests run inside the framework's server package: its
 * vitest, with packages/server/vitest.apps.config.ts, whose setup file
 * hands `testApp` the framework's implementation.
 *
 * Which apps: those in the folders named in HEARTH_APPS_DIR, or in the
 * folder the command runs in when the variable is not set, as for
 * `hearth-apps check`. sync's checks come first and write nothing: the
 * tests of apps a build would refuse are not run, and a folder written for
 * another SDK version ends with status 3, as there.
 *
 * Design: docs/mini-app-contract.md, section A9.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { TEST_FILE, isUnread } from "./import-scan.mjs";
import { AppsError, EXIT_PROBLEMS, findApps, frameworkRoot } from "./sync.mjs";

/**
 * The script a package runs as `name`, as an absolute path, for the copy of
 * the package that `from` (a package.json) sees.
 *
 * @param {string} packageName
 * @param {string} name
 * @param {string} from
 */
export function binOf(packageName, name, from) {
  const packageFile = createRequire(from).resolve(`${packageName}/package.json`);
  const bin = JSON.parse(fs.readFileSync(packageFile, "utf8")).bin;
  return path.resolve(path.dirname(packageFile), typeof bin === "string" ? bin : bin[name]);
}

/**
 * The test files below an app's folder, as absolute paths, leaving out what
 * the import scan does not read (`node_modules`, names that start with a dot).
 *
 * @param {string} dir
 * @returns {string[]}
 */
export function testFilesIn(dir) {
  /** @type {string[]} */
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (isUnread(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...testFilesIn(full));
    else if (entry.isFile() && TEST_FILE.test(entry.name)) files.push(full);
  }
  return files.sort();
}

/**
 * Runs the tests of the apps that have any, in one run of vitest inside the
 * server package. Returns 0 when they passed or there were none, 1 when a
 * test failed or the run could not start.
 *
 * @param {object} options
 * @param {readonly import("./sync.mjs").FoundApp[]} options.apps As sync found them.
 * @param {string} options.root The hearth checkout.
 * @param {(line: string) => void} options.log
 * @returns {number}
 */
export function runAppTests({ apps, root, log }) {
  const tested = apps.filter((app) => testFilesIn(app.dir).length > 0);
  if (tested.length === 0) {
    log("hearth-apps test: none of the mini-apps has tests.");
    return 0;
  }

  /** @type {Map<string, string[]>} */
  const byFolder = new Map();
  for (const app of tested) byFolder.set(app.folder, [...(byFolder.get(app.folder) ?? []), app.id]);
  const names = tested.map((app) => app.id).join(", ");
  log(`hearth-apps test: running the tests of ${tested.length === 1 ? "1 mini-app" : `${tested.length} mini-apps`} (${names}).`);

  const serverPackage = path.join(root, "packages/server");
  const vitest = binOf("vitest", "vitest", path.join(serverPackage, "package.json"));
  const result = spawnSync(process.execPath, [vitest, "run", "--config", "vitest.apps.config.ts"], {
    cwd: serverPackage,
    stdio: "inherit",
    env: {
      ...process.env,
      HEARTH_APP_TESTS: JSON.stringify([...byFolder].map(([folder, ids]) => ({ folder, apps: ids }))),
    },
  });
  if (result.error) {
    log(`hearth-apps test: vitest could not be started (${result.error.message}).`);
    return EXIT_PROBLEMS;
  }
  if (result.status !== 0) {
    log("hearth-apps test: failed.");
    // Status 3 means one thing only (sync.mjs), whatever vitest ends with.
    return EXIT_PROBLEMS;
  }
  log(`hearth-apps test: the tests of ${names} passed.`);
  return 0;
}

/**
 * The whole command: sync's checks without writing anything, then the
 * tests. Returns the exit status: 0, 1, or 3 for a folder written for
 * another SDK version.
 *
 * @param {object} options
 * @param {readonly string[]} options.appsDirs Absolute paths of the apps folders.
 * @param {string} [options.root] The hearth checkout. Defaults to the one this file is in.
 * @param {(line: string) => void} [options.log]
 * @returns {number}
 */
export function test(options) {
  const root = options.root ?? frameworkRoot();
  const log = options.log ?? ((line) => console.error(line));

  let found;
  try {
    found = findApps(options.appsDirs, root);
  } catch (error) {
    if (!(error instanceof AppsError)) throw error;
    log("hearth-apps test: the mini-apps cannot be built in, so their tests were not run.");
    for (const problem of error.problems) log(`  - ${problem}`);
    return error.exitCode;
  }
  for (const notice of found.notices) log(`hearth-apps test: ${notice}`);
  if (found.apps.length === 0) {
    log("hearth-apps test: no mini-apps to test.");
    return 0;
  }
  return runAppTests({ apps: found.apps, root, log });
}
