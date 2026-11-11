/**
 * `hearth-apps sync`: tells the framework which mini-apps to build in.
 *
 * It reads the folders named in HEARTH_APPS_DIR (one, or several separated
 * like PATH), each a mini-apps repository such as hearth-stones, and writes
 * three files into the framework, none of them in Git:
 *
 *   packages/server/src/apps/registry.generated.js   what the server holds
 *   packages/web/src/apps/registry.generated.js      what the web app holds
 *   packages/web/src/apps/sources.generated.css      where Tailwind looks for class names
 *
 * With the variable unset, a folder missing or a folder without apps, the
 * three files say "no apps", and the framework builds and tests alone.
 *
 * Before it writes anything it checks, for every folder that holds apps:
 *
 *  - the handshake: the SDK version the folder declares ("hearth.sdk" in its
 *    package.json, a caret range) fits this checkout's @hearth/sdk, and the
 *    folder's @hearth/sdk is a link to this checkout. A version that does not
 *    fit ends with exit status 3, everything else with status 1;
 *  - app IDs (folder names) are well-formed and unique across all folders;
 *  - every app has a widget.tsx, and its widget.tsx, page.tsx and server.ts
 *    have the default export the generated lists import (default-export.mjs);
 *  - no app declares a dependency of its own;
 *  - every file of every app imports only what a mini-app may (import-scan.mjs).
 *
 * Nothing in here runs an app's code. Whether a manifest is valid is checked
 * by `hearth-apps check` and again by the server when it starts.
 *
 * Design: docs/mini-app-contract.md, section A7, and the owner's decision 6.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_EXPORTS, hasDefaultExport } from "./default-export.mjs";
import { scanApp } from "./import-scan.mjs";

/** Exit status for anything wrong with the apps or their folder. */
export const EXIT_PROBLEMS = 1;
/** Exit status when a folder was written for another version of the SDK, and for nothing else. */
export const EXIT_SDK_VERSION = 3;

/** The same pattern as APP_ID_PATTERN in ../src/index.ts; a unit test compares the two. */
export const APP_FOLDER_PATTERN = /^[a-z][a-z0-9-]{1,30}$/;

const DEPENDENCY_FIELDS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];

/** The three files sync writes, relative to the root of the hearth checkout. */
export const GENERATED = {
  server: "packages/server/src/apps/registry.generated.js",
  web: "packages/web/src/apps/registry.generated.js",
  css: "packages/web/src/apps/sources.generated.css",
};

/**
 * One mini-app as sync found it.
 *
 * @typedef {object} FoundApp
 * @property {string} id The folder's name.
 * @property {string} dir The app's folder, absolute.
 * @property {string} folder The apps folder it is in, absolute.
 * @property {boolean} hasPage Whether it has a page.tsx.
 * @property {boolean} hasServer Whether it has a server.ts.
 */

/** Thrown when the apps cannot be built in. The message is meant to be shown as is. */
export class AppsError extends Error {
  /**
   * @param {readonly string[]} problems
   * @param {number} exitCode
   */
  constructor(problems, exitCode) {
    super(problems.join("\n"));
    this.name = "AppsError";
    this.problems = problems;
    this.exitCode = exitCode;
  }
}

/** The root of the hearth checkout this file belongs to. */
export function frameworkRoot() {
  return path.resolve(path.dirname(fs.realpathSync(fileURLToPath(import.meta.url))), "../../..");
}

/**
 * The folders HEARTH_APPS_DIR names, as absolute paths. A relative folder is
 * read from the root of the hearth checkout, wherever the command runs, so
 * that the build and the dev server (packages/web/vite.config.ts) agree.
 *
 * @param {string | undefined} value
 * @param {string} root
 * @returns {string[]}
 */
export function readAppsDirs(value, root) {
  const dirs = (value ?? "")
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "")
    .map((entry) => path.resolve(root, entry));
  return [...new Set(dirs)];
}

/** @returns {unknown} The JSON in a file, or undefined when there is no such file. Throws when it is not JSON. */
function readJson(/** @type {string} */ file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  return JSON.parse(text);
}

const isRecord = (/** @type {unknown} */ value) => typeof value === "object" && value !== null && !Array.isArray(value);

/** @returns {[number, number, number] | null} */
function parseVersion(/** @type {string} */ text) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(text);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/**
 * Whether `version` fits the caret range `range`, as npm reads one:
 * "^1.2.3" allows 1.2.3 up to, not including, 2.0.0; "^0.2.3" allows 0.2.3
 * up to 0.3.0; "^0.0.3" allows 0.0.3 only. Returns null when `range` is not
 * a caret range or `version` not a plain version.
 *
 * @param {string} version
 * @param {string} range
 * @returns {boolean | null}
 */
export function fitsCaretRange(version, range) {
  const have = parseVersion(version);
  const want = range.startsWith("^") ? parseVersion(range.slice(1)) : null;
  if (!have || !want) return null;
  const [major, minor, patch] = want;
  if (major > 0) return have[0] === major && (have[1] > minor || (have[1] === minor && have[2] >= patch));
  if (minor > 0) return have[0] === 0 && have[1] === minor && have[2] >= patch;
  return have[0] === 0 && have[1] === 0 && have[2] === patch;
}

/** The mini-apps in one folder: its direct child folders that hold a manifest.ts. */
function appsIn(/** @type {string} */ folder) {
  /** @type {FoundApp[]} */
  const apps = [];
  for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const dir = path.join(folder, entry.name);
    const has = (/** @type {string} */ file) => fs.statSync(path.join(dir, file), { throwIfNoEntry: false })?.isFile() === true;
    if (!has("manifest.ts")) continue;
    apps.push({ id: entry.name, dir, folder, hasPage: has("page.tsx"), hasServer: has("server.ts") });
  }
  return apps.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * The handshake between one apps folder and this checkout. `hearth-apps new`
 * asks it too, of the folder a new app goes into.
 *
 * @param {string} folder
 * @param {string} root
 * @returns {{ problems: string[], versionProblems: string[] }}
 */
export function handshake(folder, root) {
  const sdkDir = path.join(root, "packages/sdk");
  const sdkPackage = /** @type {{ version: string }} */ (readJson(path.join(sdkDir, "package.json")));
  const declared = `"hearth": { "sdk": "^${sdkPackage.version}" }`;
  const file = path.join(folder, "package.json");

  let manifest;
  try {
    manifest = /** @type {any} */ (readJson(file));
  } catch {
    return { problems: [`${file} is not valid JSON.`], versionProblems: [] };
  }
  if (manifest === undefined) {
    return {
      problems: [`${folder} holds mini-apps but has no package.json. It must say which SDK version the apps were written for: ${declared}.`],
      versionProblems: [],
    };
  }
  const range = isRecord(manifest) && isRecord(manifest.hearth) ? manifest.hearth.sdk : undefined;
  const fits = typeof range === "string" ? fitsCaretRange(sdkPackage.version, range) : null;
  if (typeof range !== "string" || fits === null) {
    const found = range === undefined ? "It has none" : `It has ${JSON.stringify(range)}`;
    return {
      problems: [
        `${file} must say which SDK version the apps were written for, as a caret range: ${declared}. ${found}.`,
      ],
      versionProblems: [],
    };
  }
  if (!fits) {
    return {
      problems: [],
      versionProblems: [
        `The mini-apps in ${folder} were written for @hearth/sdk ${range} ("hearth.sdk" in its package.json), ` +
          `but this checkout of hearth holds @hearth/sdk ${sdkPackage.version}. ` +
          "Update whichever of the two repositories is behind, or change the apps to fit this SDK and declare its version.",
      ],
    };
  }

  const link = path.join(folder, "node_modules/@hearth/sdk");
  let target;
  try {
    target = fs.realpathSync(link);
  } catch {
    return {
      problems: [`${folder} has no @hearth/sdk to build against. Run "pnpm install" there; it links the SDK of the hearth checkout beside it.`],
      versionProblems: [],
    };
  }
  if (target !== fs.realpathSync(sdkDir)) {
    return {
      problems: [
        `${link} leads to ${target}, not to the SDK of this checkout (${sdkDir}). ` +
          "The apps would be checked against one SDK and built with another. Check out the two repositories side by side and run \"pnpm install\" in the apps folder.",
      ],
      versionProblems: [],
    };
  }
  return { problems: [], versionProblems: [] };
}

/** What is wrong with one app, as far as it can be told without running its code. */
function appProblems(/** @type {FoundApp} */ app) {
  /** @type {string[]} */
  const problems = [];
  const where = path.join(path.basename(app.folder), app.id);

  if (!fs.statSync(path.join(app.dir, "widget.tsx"), { throwIfNoEntry: false })?.isFile()) {
    problems.push(`${where}: has no widget.tsx. Every mini-app needs one: its default export is the body of the app's card on the dashboard.`);
  }
  for (const [file, what] of Object.entries(DEFAULT_EXPORTS)) {
    let text;
    try {
      text = fs.readFileSync(path.join(app.dir, file), "utf8");
    } catch {
      continue;
    }
    if (!hasDefaultExport(file, text)) {
      problems.push(`${where}/${file} has no default export. The build imports it as ${what}.`);
    }
  }

  const packageFile = path.join(app.dir, "package.json");
  let manifest;
  try {
    manifest = /** @type {any} */ (readJson(packageFile));
  } catch {
    problems.push(`${where}/package.json is not valid JSON.`);
  }
  if (isRecord(manifest)) {
    for (const field of DEPENDENCY_FIELDS) {
      const names = isRecord(manifest[field]) ? Object.keys(manifest[field]) : [];
      if (names.length > 0) {
        problems.push(
          `${where}/package.json declares ${field} (${names.join(", ")}). A mini-app has no dependencies of its own: it uses only the SDK.`,
        );
      }
    }
  }

  for (const violation of scanApp(app.dir)) {
    const file = path.join(path.basename(app.folder), path.relative(app.folder, violation.file));
    problems.push(`${file}:${violation.line}:${violation.column}: ${violation.message}`);
  }
  return problems;
}

/**
 * Finds the mini-apps in the given folders and checks that they can be
 * built in. Throws AppsError, whose message lists everything that is wrong.
 *
 * @param {readonly string[]} appsDirs Absolute paths.
 * @param {string} root The hearth checkout.
 * @returns {{ apps: FoundApp[], notices: string[] }}
 */
export function findApps(appsDirs, root) {
  /** @type {FoundApp[]} */
  const apps = [];
  /** @type {string[]} */
  const notices = [];
  /** @type {string[]} */
  const problems = [];
  /** @type {string[]} */
  const versionProblems = [];
  /** @type {Map<string, string>} */
  const folderOf = new Map();

  if (appsDirs.length === 0) notices.push("HEARTH_APPS_DIR names no folder: building without mini-apps.");

  for (const folder of appsDirs) {
    const stat = fs.statSync(folder, { throwIfNoEntry: false });
    if (!stat) {
      notices.push(`${folder} does not exist: no mini-apps from there.`);
      continue;
    }
    if (!stat.isDirectory()) {
      problems.push(`${folder}, named in HEARTH_APPS_DIR, is not a folder.`);
      continue;
    }
    const found = appsIn(folder);
    if (found.length === 0) {
      notices.push(`${folder} holds no mini-apps (no folder with a manifest.ts).`);
      continue;
    }

    const shake = handshake(folder, root);
    versionProblems.push(...shake.versionProblems);
    problems.push(...shake.problems);
    // Apps written for another SDK are not looked at further: whatever else
    // is wrong with them may be the very thing the version says.
    if (shake.versionProblems.length > 0) continue;

    for (const app of found) {
      if (!APP_FOLDER_PATTERN.test(app.id)) {
        problems.push(
          `${app.dir}: a mini-app's folder is named after its ID, which is 2 to 31 lower-case letters, digits and hyphens, starting with a letter. "${app.id}" is not.`,
        );
        continue;
      }
      const first = folderOf.get(app.id);
      if (first !== undefined) {
        problems.push(`The mini-app "${app.id}" is in two folders: ${first} and ${folder}. App IDs must be unique across all apps folders.`);
        continue;
      }
      folderOf.set(app.id, folder);
      problems.push(...appProblems(app));
      apps.push(app);
    }
  }

  if (problems.length > 0) throw new AppsError([...problems, ...versionProblems], EXIT_PROBLEMS);
  if (versionProblems.length > 0) throw new AppsError(versionProblems, EXIT_SDK_VERSION);
  return { apps, notices };
}

/** How a generated file imports `target`: a relative path with forward slashes. */
function importPath(/** @type {string} */ fromFile, /** @type {string} */ target) {
  const relative = path.relative(path.dirname(fromFile), target).split(path.sep).join("/");
  return JSON.stringify(relative.startsWith(".") ? relative : `./${relative}`);
}

const header = (/** @type {string} */ open, /** @type {string} */ close, /** @type {string} */ types) =>
  [
    `${open} Written by "hearth-apps sync" from the folders named in HEARTH_APPS_DIR.${close}`,
    `${open} Do not edit it and do not commit it: every build and "pnpm dev" writes it again.${close}`,
    ...(types ? [`${open} Its types are in ${types}, which is in Git.${close}`] : []),
  ].join("\n");

/** @param {readonly FoundApp[]} apps @param {string} file */
function serverRegistry(apps, file) {
  const imports = apps.flatMap((app, index) => [
    `import manifest${index} from ${importPath(file, path.join(app.dir, "manifest.ts"))};`,
    ...(app.hasServer ? [`import server${index} from ${importPath(file, path.join(app.dir, "server.ts"))};`] : []),
  ]);
  const entries = apps.map(
    (app, index) =>
      `  { id: ${JSON.stringify(app.id)}, manifest: manifest${index}, hasPage: ${app.hasPage}${app.hasServer ? `, server: server${index}` : ""} },`,
  );
  return [
    header("//", "", "registry.generated.d.ts"),
    ...imports,
    "",
    apps.length === 0 ? "export const apps = [];" : ["export const apps = [", ...entries, "];"].join("\n"),
    "",
  ].join("\n");
}

/** @param {readonly FoundApp[]} apps @param {string} file */
function webRegistry(apps, file) {
  const imports = apps.map((app, index) => `import manifest${index} from ${importPath(file, path.join(app.dir, "manifest.ts"))};`);
  const entries = apps.map((app, index) =>
    [
      "  {",
      `    id: ${JSON.stringify(app.id)},`,
      `    manifest: manifest${index},`,
      `    hasPage: ${app.hasPage},`,
      `    widget: () => import(${importPath(file, path.join(app.dir, "widget.tsx"))}),`,
      ...(app.hasPage ? [`    page: () => import(${importPath(file, path.join(app.dir, "page.tsx"))}),`] : []),
      "  },",
    ].join("\n"),
  );
  return [
    header("//", "", "registry.generated.d.ts"),
    ...imports,
    "",
    apps.length === 0 ? "export const apps = [];" : ["export const apps = [", ...entries, "];"].join("\n"),
    "",
  ].join("\n");
}

/** @param {readonly FoundApp[]} apps @param {string} file */
function cssSources(apps, file) {
  return [
    header("/*", " */", ""),
    "/* Tailwind does not look outside the web app by itself: these are the mini-apps' folders. */",
    ...apps.map((app) => `@source ${importPath(file, app.dir)};`),
    "",
  ].join("\n");
}

/** Writes a file unless it already holds exactly this, so that a watching dev server is left alone. */
function writeIfChanged(/** @type {string} */ file, /** @type {string} */ content) {
  let current = null;
  try {
    current = fs.readFileSync(file, "utf8");
  } catch {
    // Not there yet.
  }
  if (current === content) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return true;
}

/**
 * Finds the apps, checks them and writes the three generated files.
 * Throws AppsError and writes nothing when something is wrong.
 *
 * @param {object} options
 * @param {readonly string[]} options.appsDirs Absolute paths of the apps folders.
 * @param {string} [options.root] The hearth checkout. Defaults to the one this file is in.
 * @param {string} [options.out] Where the generated files go, in place of `root`. For tests.
 * @returns {{ apps: FoundApp[], notices: string[], files: { server: string, web: string, css: string } }}
 */
export function sync(options) {
  const root = options.root ?? frameworkRoot();
  const out = options.out ?? root;
  const { apps, notices } = findApps(options.appsDirs, root);
  const files = {
    server: path.join(out, GENERATED.server),
    web: path.join(out, GENERATED.web),
    css: path.join(out, GENERATED.css),
  };
  writeIfChanged(files.server, serverRegistry(apps, files.server));
  writeIfChanged(files.web, webRegistry(apps, files.web));
  writeIfChanged(files.css, cssSources(apps, files.css));
  return { apps, notices, files };
}
