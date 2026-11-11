/**
 * `hearth-apps check`: everything that can be said about a folder of
 * mini-apps before it is merged.
 *
 * It runs sync (sync.mjs), which already refuses a wrong SDK version, a
 * declared dependency, a widget, page or server file without its default
 * export and a foreign import, and then, for the same folders:
 *
 *  1. every app has the files an app must have;
 *  2. every manifest and server file is valid: the very check the server
 *     makes when it starts (packages/server/src/apps/registry.ts), so that
 *     an app which passes here does not stop a deploy;
 *  3. the TypeScript compiler, with the folder's own tsconfig.json;
 *  4. ESLint, with the folder's own configuration.
 *
 * Every stage runs even when an earlier one found something, so one run
 * shows everything. Tests are not run yet: `hearth-apps test` and
 * `@hearth/sdk/testing` arrive with a later step of the build plan.
 *
 * Design: docs/mini-app-contract.md, section A7.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { AppsError, EXIT_PROBLEMS, frameworkRoot, sync } from "./sync.mjs";

const require = createRequire(import.meta.url);

/** Files every mini-app has, besides the manifest.ts that makes its folder an app and the widget.tsx sync asks for. */
const REQUIRED_FILES = ["package.json", "README.md"];

const TEST_FILE = /\.test\.[cm]?[jt]sx?$/;

/** The script a package runs as `name`, as an absolute path. */
function binOf(/** @type {string} */ packageName, /** @type {string} */ name) {
  const packageFile = require.resolve(`${packageName}/package.json`);
  const bin = JSON.parse(fs.readFileSync(packageFile, "utf8")).bin;
  return path.resolve(path.dirname(packageFile), typeof bin === "string" ? bin : bin[name]);
}

/** Whether a folder holds a test file anywhere below it. */
function hasTests(/** @type {string} */ dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    if (entry.isDirectory() ? hasTests(path.join(dir, entry.name)) : TEST_FILE.test(entry.name)) return true;
  }
  return false;
}

/**
 * Runs the whole check and says what it found. Returns the exit status:
 * 0 when everything passed, 3 when a folder was written for another SDK
 * version, 1 for anything else.
 *
 * @param {object} options
 * @param {readonly string[]} options.appsDirs Absolute paths of the apps folders.
 * @param {string} [options.root] The hearth checkout. Defaults to the one this file is in.
 * @param {string} [options.out] Where sync's files go, in place of `root`. For tests.
 * @param {(line: string) => void} [options.log]
 * @returns {number}
 */
export function check(options) {
  const root = options.root ?? frameworkRoot();
  const log = options.log ?? ((line) => console.error(line));

  let found;
  try {
    found = sync({ appsDirs: options.appsDirs, root, out: options.out });
  } catch (error) {
    if (!(error instanceof AppsError)) throw error;
    log("hearth-apps check: the mini-apps cannot be built in.");
    for (const problem of error.problems) log(`  - ${problem}`);
    return error.exitCode;
  }
  for (const notice of found.notices) log(`hearth-apps check: ${notice}`);
  if (found.apps.length === 0) {
    log("hearth-apps check: no mini-apps to check.");
    return 0;
  }

  /** @type {string[]} */
  const failed = [];
  const run = (/** @type {string} */ stage, /** @type {string[]} */ args, /** @type {string} */ cwd) => {
    const result = spawnSync(process.execPath, args, { cwd, stdio: "inherit" });
    if (result.status !== 0) failed.push(stage);
  };

  // 1. The files an app must have.
  for (const app of found.apps) {
    for (const file of REQUIRED_FILES) {
      if (!fs.statSync(path.join(app.dir, file), { throwIfNoEntry: false })?.isFile()) {
        const why =
          file === "README.md"
            ? "It says what the app is for and how its data is shaped."
            : 'It names the app and declares no dependencies: { "name": "...", "version": "0.1.0", "private": true, "type": "module" }.';
        log(`hearth-apps check: ${path.join(path.basename(app.folder), app.id)} has no ${file}. ${why}`);
        if (!failed.includes("required files")) failed.push("required files");
      }
    }
  }

  // 2. Manifests and server files, as the server checks them at start-up.
  const serverPackage = path.join(root, "packages/server");
  run("manifests and server files", ["--import", "tsx", path.join(serverPackage, "src/apps/check-bundle.ts"), found.files.server], serverPackage);

  const folders = [...new Set(found.apps.map((app) => app.folder))];
  for (const folder of folders) {
    const label = folders.length > 1 ? ` in ${folder}` : "";

    // 3. Types.
    if (fs.existsSync(path.join(folder, "tsconfig.json"))) {
      run(`types${label}`, [binOf("typescript", "tsc"), "--noEmit", "-p", path.join(folder, "tsconfig.json")], folder);
    } else {
      log(`hearth-apps check: ${folder} has no tsconfig.json. It needs one: { "extends": "@hearth/sdk/tsconfig.app.json" }.`);
      failed.push(`types${label}`);
    }

    // 4. Lint, for each app's folder. ESLint finds the configuration itself.
    const apps = found.apps.filter((app) => app.folder === folder);
    run(`lint${label}`, [binOf("eslint", "eslint"), "--max-warnings", "0", ...apps.map((app) => app.id)], folder);

    if (apps.some((app) => hasTests(app.dir))) {
      log(`hearth-apps check: the apps in ${folder} have test files. They were not run: "hearth-apps test" is not built yet.`);
    }
  }

  if (failed.length > 0) {
    log(`hearth-apps check: failed (${failed.join(", ")}).`);
    return EXIT_PROBLEMS;
  }
  const names = found.apps.map((app) => app.id).join(", ");
  log(`hearth-apps check: ${found.apps.length === 1 ? "1 mini-app" : `${found.apps.length} mini-apps`} passed (${names}).`);
  return 0;
}
