/**
 * `hearth-apps new <id>`: a new mini-app, made as a copy of the framework's
 * sample checklist (packages/fixture-apps/checklist).
 *
 * The copy is a complete, working app from the first moment, so it passes
 * `hearth-apps check` untouched. Only what makes it another app changes on
 * the way:
 *
 *  - its folder is named after the new ID, and so is its test file:
 *    checklist.test.ts becomes <id>.test.ts, and the name its tests are
 *    listed under changes with it;
 *  - the manifest's `id` is the new ID;
 *  - its package.json is named after the repository and the ID, as
 *    `@hearth-stones/grocery`;
 *  - its README.md says where the app came from and what to change first.
 *
 * Everything else is the checklist's until its author changes it: the name,
 * description and strings in both languages, the icon and colour, the
 * settings, the collection and routes, the widget, the page and the tests.
 *
 * Which folder: the one HEARTH_APPS_DIR names, or the folder the command
 * runs in when the variable is not set, as for check, test and dev. It
 * must be a folder of mini-apps that sync would accept (`handshake` in
 * sync.mjs): a package.json that declares an SDK version this checkout
 * fits, else status 3, and its @hearth/sdk linked to this checkout.
 * Nothing is written when anything is refused, and nothing is overwritten.
 *
 * Design: docs/mini-app-contract.md, sections A1 and A9, and step 14.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isUnread } from "./import-scan.mjs";
import { APP_FOLDER_PATTERN, AppsError, EXIT_PROBLEMS, EXIT_SDK_VERSION, frameworkRoot, handshake } from "./sync.mjs";

/** The app every new app starts as, relative to the root of the hearth checkout. */
export const TEMPLATE = "packages/fixture-apps/checklist";
/** The template's ID, which a copy does not keep. */
export const TEMPLATE_ID = "checklist";

/**
 * Where the template names its own ID, by file: each text must be there
 * exactly once, and the copy has the new ID in its place. When the template
 * changes so that one is no longer found, `new` stops and says so rather
 * than make an app that keeps the checklist's ID.
 */
const NAMES_ITS_ID = [
  { file: "manifest.ts", text: (/** @type {string} */ id) => `id: ${JSON.stringify(id)},` },
  { file: `${TEMPLATE_ID}.test.ts`, text: (/** @type {string} */ id) => `describe(${JSON.stringify(id)},` },
];

const isRecord = (/** @type {unknown} */ value) => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The package name of a new app: the repository's own name as its scope, as
 * in `@hearth-stones/grocery`, or the bare ID when the repository has no
 * name that can be a scope.
 *
 * @param {unknown} repository The `name` in the repository's package.json.
 * @param {string} id
 * @returns {string}
 */
export function packageName(repository, id) {
  const bare = typeof repository === "string" ? repository.replace(/^@[^/]*\//, "") : "";
  return /^[a-z0-9][a-z0-9._-]*$/.test(bare) ? `@${bare}/${id}` : id;
}

/**
 * The README.md of a new app: where it came from, and what to change first.
 *
 * @param {string} id
 * @returns {string}
 */
export function readmeOf(id) {
  return `# ${id}

A new mini-app, made with \`hearth-apps new ${id}\` as a copy of the
checklist, the sample app of the Hearth framework. Until it is changed it
works as a checklist: a list of things to do that everyone in the space
shares, ticked off as they go.

To make it the app it is meant to be, change:

1. \`manifest.ts\`: the name and description, the icon, colour and card size,
   the settings and the strings, every text in English and in Simplified
   Chinese. The \`id\` stays: it is this folder's name.
2. \`server.ts\`: the collections the app keeps, and its queries and
   mutations, each with one sentence that says what it does. An app that
   keeps nothing has no server file.
3. \`widget.tsx\`, the body of the app's card on the dashboard, and
   \`page.tsx\`, its own page. An app without a page has no \`page.tsx\`.
4. \`${id}.test.ts\`: its tests, written with \`testApp\` from
   \`@hearth/sdk/testing\`.
5. \`README.md\`, this file: what the app is for, and how its data is shaped.

\`package.json\` names the app and declares no dependencies: a mini-app uses
the SDK and nothing else.

\`pnpm check\` checks the app as the build will, and \`pnpm dev\` runs Hearth
with it on this machine. The SDK's README in Hearth
(\`packages/sdk/README.md\`) says what each file holds and may import.
`;
}

/** A template that cannot be copied is a fault of the hearth checkout, not of the folder the app was to go into. */
function templateFault(/** @type {string} */ template, /** @type {string} */ problem) {
  return new AppsError(
    [`The template ${template} cannot be copied: ${problem} That is a fault of the hearth checkout: packages/sdk/tools/new.mjs must change with the template.`],
    EXIT_PROBLEMS,
  );
}

const existsAlready = (/** @type {string} */ dir) =>
  new AppsError([`${dir} exists already, and hearth-apps new overwrites nothing. Choose another ID, or move that out of the way first.`], EXIT_PROBLEMS);

/**
 * The template's files, by path inside it with "/" between folders, leaving
 * out what the import scan does not read: hidden names and node_modules.
 *
 * @param {string} template
 * @param {string} [prefix]
 * @returns {string[]}
 */
function filesOf(template, prefix = "") {
  /** @type {string[]} */
  const files = [];
  for (const entry of fs.readdirSync(path.join(template, ...prefix.split("/")), { withFileTypes: true })) {
    if (isUnread(entry.name)) continue;
    const file = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) files.push(...filesOf(template, file));
    else if (entry.isFile()) files.push(file);
    else throw templateFault(template, `${file} is neither a file nor a folder.`);
  }
  return files.sort();
}

/** A file's path in the copy: a name that starts with the template's ID starts with the new one. */
function renamed(/** @type {string} */ file, /** @type {string} */ id) {
  const at = file.lastIndexOf("/") + 1;
  const name = file.slice(at);
  return name.startsWith(`${TEMPLATE_ID}.`) ? `${file.slice(0, at)}${id}${name.slice(TEMPLATE_ID.length)}` : file;
}

/**
 * The new app's files and what they hold, by path inside its folder, made
 * from the template in memory before anything is written.
 *
 * @param {string} template The template's folder.
 * @param {string} id
 * @param {string} name The new app's package name.
 * @returns {Map<string, Buffer | string>}
 */
function copyOf(template, id, name) {
  if (!fs.statSync(template, { throwIfNoEntry: false })?.isDirectory()) throw templateFault(template, "it is not there.");
  const originals = filesOf(template);
  for (const needed of ["package.json", ...NAMES_ITS_ID.map((entry) => entry.file)]) {
    if (!originals.includes(needed)) throw templateFault(template, `it has no ${needed}.`);
  }

  /** @type {Map<string, Buffer | string>} */
  const files = new Map();
  const add = (/** @type {string} */ file, /** @type {Buffer | string} */ content) => {
    if (files.has(file)) throw templateFault(template, `two of its files would both be ${file} in the copy.`);
    files.set(file, content);
  };

  for (const file of originals) {
    // Written below: the template's own README is about the template.
    if (file === "README.md") continue;
    const source = path.join(template, ...file.split("/"));
    if (file === "package.json") {
      let fields;
      try {
        fields = JSON.parse(fs.readFileSync(source, "utf8"));
      } catch {
        throw templateFault(template, "its package.json is not valid JSON.");
      }
      if (!isRecord(fields)) throw templateFault(template, "its package.json is not an object.");
      add(file, `${JSON.stringify({ ...fields, name }, null, 2)}\n`);
      continue;
    }
    const edit = NAMES_ITS_ID.find((entry) => entry.file === file);
    if (edit === undefined) {
      add(renamed(file, id), fs.readFileSync(source));
      continue;
    }
    const text = fs.readFileSync(source, "utf8");
    const found = edit.text(TEMPLATE_ID);
    if (text.split(found).length !== 2) throw templateFault(template, `its ${file} does not hold \`${found}\` exactly once.`);
    add(renamed(file, id), text.replace(found, () => edit.text(id)));
  }
  add("README.md", readmeOf(id));
  return files;
}

/**
 * Writes the files into a hidden folder beside where the app goes, then
 * renames that folder into place, so that the app appears whole or not at
 * all. sync and the import scan do not read hidden folders, so one that a
 * stopped run left behind is not taken for an app.
 *
 * @param {string} dir Where the app goes.
 * @param {Map<string, Buffer | string>} files
 */
function writeWhole(dir, files) {
  const staging = path.join(path.dirname(dir), `.hearth-new-${path.basename(dir)}-${randomUUID().slice(0, 8)}`);
  fs.mkdirSync(staging);
  try {
    for (const [file, content] of files) {
      const target = path.join(staging, ...file.split("/"));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content);
    }
    // Something may have taken the name meanwhile.
    if (fs.lstatSync(dir, { throwIfNoEntry: false })) throw existsAlready(dir);
    fs.renameSync(staging, dir);
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Makes a new app in a folder of mini-apps. Throws AppsError, having
 * written nothing, when it cannot: its problems say why, and its exitCode
 * is 3 for a folder written for another SDK version and 1 otherwise.
 *
 * @param {object} options
 * @param {string} options.id The new app's ID, which names its folder.
 * @param {string} options.folder The folder of mini-apps it goes into, absolute.
 * @param {string} [options.root] The hearth checkout. Defaults to the one this file is in.
 * @param {string} [options.template] The app to copy, absolute. Defaults to TEMPLATE in `root`. For tests.
 * @returns {{ dir: string, files: string[] }} The new app's folder, and its files by path inside it.
 */
export function makeApp(options) {
  const { id, folder } = options;
  const root = options.root ?? frameworkRoot();
  const template = options.template ?? path.join(root, TEMPLATE);

  if (!APP_FOLDER_PATTERN.test(id)) {
    throw new AppsError(
      [
        `${JSON.stringify(id)} cannot be the ID of a mini-app: an ID is 2 to 31 lower-case letters, digits and hyphens, starting with a letter. It names the app's folder too.`,
      ],
      EXIT_PROBLEMS,
    );
  }
  const stat = fs.statSync(folder, { throwIfNoEntry: false });
  if (!stat) throw new AppsError([`${folder} does not exist.`], EXIT_PROBLEMS);
  if (!stat.isDirectory()) throw new AppsError([`${folder} is not a folder.`], EXIT_PROBLEMS);
  if (fs.realpathSync(folder) === fs.realpathSync(root)) {
    throw new AppsError(
      [`${folder} is the hearth checkout itself. A new app goes into a folder of mini-apps, such as hearth-stones beside it: run "pnpm new ${id}" there.`],
      EXIT_PROBLEMS,
    );
  }
  const dir = path.join(folder, id);
  if (fs.lstatSync(dir, { throwIfNoEntry: false })) throw existsAlready(dir);

  // What sync asks of a folder that holds apps, which this one is about to.
  const packageFile = path.join(folder, "package.json");
  if (!fs.statSync(packageFile, { throwIfNoEntry: false })?.isFile()) {
    throw new AppsError(
      [
        `${folder} has no package.json, so it is not a folder of mini-apps. Such a folder has a package.json that says which SDK version its apps are written for and links @hearth/sdk, as hearth-stones does.`,
      ],
      EXIT_PROBLEMS,
    );
  }
  const shake = handshake(folder, root);
  if (shake.problems.length > 0) throw new AppsError([...shake.problems, ...shake.versionProblems], EXIT_PROBLEMS);
  if (shake.versionProblems.length > 0) throw new AppsError(shake.versionProblems, EXIT_SDK_VERSION);

  const repository = /** @type {unknown} */ (JSON.parse(fs.readFileSync(packageFile, "utf8")));
  const files = copyOf(template, id, packageName(isRecord(repository) ? /** @type {any} */ (repository).name : undefined, id));
  writeWhole(dir, files);
  return { dir, files: [...files.keys()].sort() };
}

/**
 * The whole command: makes the app and says what it made, or why it made
 * nothing. Returns the exit status: 0, 3 for a folder written for another
 * SDK version, 1 for anything else.
 *
 * @param {object} options
 * @param {string} options.id
 * @param {readonly string[]} options.appsDirs The folders HEARTH_APPS_DIR names, or the one the command runs in. A new app goes into one.
 * @param {string} [options.root] The hearth checkout. Defaults to the one this file is in.
 * @param {string} [options.template] The app to copy. For tests.
 * @param {(line: string) => void} [options.log]
 * @returns {number}
 */
export function newApp(options) {
  const log = options.log ?? ((line) => console.error(line));
  const [folder, ...others] = options.appsDirs;

  let made;
  try {
    if (folder === undefined || others.length > 0) {
      throw new AppsError(
        [
          `A new app goes into one folder, and HEARTH_APPS_DIR names ${options.appsDirs.length}. Name only that one, or run the command in it with the variable unset.`,
        ],
        EXIT_PROBLEMS,
      );
    }
    made = makeApp({ id: options.id, folder, root: options.root, template: options.template });
  } catch (error) {
    if (!(error instanceof AppsError)) throw error;
    log("hearth-apps new: no app was made.");
    for (const problem of error.problems) log(`  - ${problem}`);
    return error.exitCode;
  }

  log(`hearth-apps new: made the mini-app "${options.id}" in ${made.dir}, a copy of the sample checklist: ${made.files.join(", ")}.`);
  log("hearth-apps new: it works as a checklist until it is changed; its README.md says what to change first.");
  log('hearth-apps new: "pnpm check" checks it as the build will, and "pnpm dev" runs Hearth with it (start it again if it is running).');
  return 0;
}
