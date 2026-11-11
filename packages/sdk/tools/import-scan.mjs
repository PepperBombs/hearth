/**
 * The import scan: "a mini-app uses only the SDK", checked by reading what
 * each file of an app imports.
 *
 * `hearth-apps sync` runs it before every build, the deploy's included, and
 * a comment in an app cannot switch it off. The ESLint rule
 * `hearth/mini-app-imports` (../eslint.js) reports the same findings in an
 * editor and in a pull request; both call `scanApp`, so there is one list of
 * what is allowed.
 *
 * What a file of an app may import (docs/mini-app-contract.md, section A7):
 *
 *  - its own files: a relative path that stays inside the app's folder;
 *  - `@hearth/sdk`, anywhere;
 *  - `@hearth/sdk/web` and `react`, in the files of the widget and the page;
 *  - `@hearth/sdk/server`, in `server.ts` and the files only it imports;
 *  - `./server` from the widget or the page with `import type` only, so that
 *    the server's code never reaches a browser;
 *  - `vitest` and `@hearth/sdk/testing`, in test files (`*.test.ts`).
 *
 * Everything else is refused: other packages, Node's built-in modules, the
 * framework's own packages, another mini-app, `require`, and an `import()`
 * whose address is not written out as text. So is a file of the app's own
 * that this scan does not read: one in a `node_modules` folder, or one that
 * is hidden or in a hidden folder (a name that starts with a dot).
 *
 * Which side a file is on follows from who imports it. `widget.tsx` and
 * `page.tsx` start the browser's side, `server.ts` the server's, and
 * `manifest.ts` is on both. Only imports that survive compiling count
 * ("value" imports): `import type` is erased, so it puts a file on no side.
 * `import { type X }` is not erased entirely, so it counts. A file that both
 * sides import may use neither `@hearth/sdk/web` nor `@hearth/sdk/server`,
 * and a file nothing imports may use either but not both.
 *
 * Where a part of the SDK may be named does not depend on how it is
 * imported: `import type` from `@hearth/sdk/server` in a widget is refused
 * like any other. The one thing `import type` opens is the app's own
 * `server.ts`, to the widget and the page.
 *
 * This reads source text with the TypeScript parser and runs nothing. It
 * stops accidents; it is not a sandbox.
 */
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

/** The extensions of files that can import something. */
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
const TEST_FILE = /\.test\.[cm]?[jt]sx?$/;

const SDK = "@hearth/sdk";
const WEB_ONLY = ["@hearth/sdk/web", "react"];
const SERVER_ONLY = ["@hearth/sdk/server"];
const TEST_ONLY = ["@hearth/sdk/testing", "vitest"];

/** The files that start each side, by their fixed names at the top of an app's folder. */
const WEB_ENTRIES = ["widget.tsx", "page.tsx"];
const SERVER_ENTRY = "server.ts";
const SHARED_ENTRY = "manifest.ts";

/**
 * One thing the scan refuses.
 *
 * @typedef {object} Violation
 * @property {string} file Absolute path of the file.
 * @property {number} line Counted from 1.
 * @property {number} column Counted from 1.
 * @property {string} message A full sentence for the app's author.
 */

/**
 * @typedef {object} ImportSite
 * @property {string | null} source What is imported, or null when it is not written out as text.
 * @property {boolean} typeOnly Erased when compiled: `import type`, `export type ... from`, `typeof import()`.
 * @property {"import" | "require"} kind
 * @property {number} line
 * @property {number} column
 */

const isSourceFile = (/** @type {string} */ name) => SOURCE_EXTENSIONS.some((extension) => name.endsWith(extension));

/**
 * Files and folders the scan does not read, by name: packages, and whatever
 * is hidden. An app may not import from them either, or its bundle would
 * hold code nobody checked.
 */
const isUnread = (/** @type {string} */ name) => name === "node_modules" || name.startsWith(".");

/**
 * A relative address without what a bundler lets follow it: "./server?raw"
 * and "./server#x" name the file ./server.
 */
const withoutQuery = (/** @type {string} */ source) => source.replace(/[?#].*$/, "");

/** Whether `target` is `folder` or lies inside it. */
function isInside(/** @type {string} */ folder, /** @type {string} */ target) {
  const relative = path.relative(folder, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * Every source file under an app's folder, as absolute paths, and the links
 * in it that lead somewhere else.
 *
 * @param {string} appDir
 * @returns {{ files: string[], strayLinks: string[] }}
 */
function listSourceFiles(appDir) {
  /** @type {string[]} */
  const files = [];
  /** @type {string[]} */
  const strayLinks = [];
  let home = appDir;
  try {
    home = fs.realpathSync(appDir);
  } catch {
    return { files, strayLinks };
  }
  const walk = (/** @type {string} */ dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (isUnread(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        // A link is followed by every tool that reads the app, so one that
        // leads out of the folder would bring in files the scan never saw.
        let target = null;
        try {
          target = fs.realpathSync(full);
        } catch {
          // A link to nothing imports nothing.
        }
        if (target !== null && !isInside(home, target)) strayLinks.push(full);
        else if (target !== null && fs.statSync(target).isFile() && isSourceFile(entry.name)) files.push(full);
        continue;
      }
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && isSourceFile(entry.name)) files.push(full);
    }
  };
  walk(appDir);
  return { files: files.sort(), strayLinks: strayLinks.sort() };
}

/**
 * Everything a file imports, with where it says so.
 *
 * @param {string} file
 * @param {string} text
 * @returns {ImportSite[]}
 */
function importsOf(file, text) {
  const kind = /\.[cm]?tsx$|\.jsx$/.test(file) ? ts.ScriptKind.TSX : /\.[cm]?js$/.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  /** @type {ImportSite[]} */
  const sites = [];

  const add = (/** @type {ts.Node | undefined} */ node, /** @type {boolean} */ typeOnly, /** @type {ImportSite["kind"]} */ siteKind, /** @type {ts.Node} */ fallback) => {
    const at = node ?? fallback;
    const { line, character } = source.getLineAndCharacterOfPosition(at.getStart(source));
    const written = node !== undefined && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node));
    sites.push({ source: written ? node.text : null, typeOnly, kind: siteKind, line: line + 1, column: character + 1 });
  };

  const visit = (/** @type {ts.Node} */ node) => {
    if (ts.isImportDeclaration(node)) {
      // `import { type A } from` is not type-only: the import itself stays.
      add(node.moduleSpecifier, node.importClause?.isTypeOnly === true, "import", node);
    } else if (ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier) add(node.moduleSpecifier, node.isTypeOnly, "import", node);
    } else if (ts.isImportEqualsDeclaration(node)) {
      if (ts.isExternalModuleReference(node.moduleReference)) add(node.moduleReference.expression, false, "require", node);
    } else if (ts.isImportTypeNode(node)) {
      const argument = node.argument;
      add(ts.isLiteralTypeNode(argument) ? argument.literal : undefined, true, "import", node);
    } else if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        add(node.arguments[0], false, "import", node);
      } else if (ts.isIdentifier(node.expression) && node.expression.text === "require") {
        add(node.arguments[0], false, "require", node);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return sites;
}

/**
 * The source file of the app that a relative import names, or null when it
 * names none of them (a file that is not code, or one that does not exist).
 *
 * @param {string} from The importing file.
 * @param {string} source The relative address as written.
 * @param {Set<string>} files The app's source files.
 */
function resolveRelative(from, source, files) {
  const base = path.resolve(path.dirname(from), withoutQuery(source));
  const candidates = [base];
  // "./items.js" may name items.ts, as TypeScript allows.
  const asWritten = /\.([cm]?)jsx?$/.exec(base);
  if (asWritten) {
    const stem = base.slice(0, -asWritten[0].length);
    candidates.push(`${stem}.${asWritten[1]}ts`, `${stem}.${asWritten[1]}tsx`);
  }
  for (const extension of SOURCE_EXTENSIONS) candidates.push(base + extension);
  for (const extension of SOURCE_EXTENSIONS) candidates.push(path.join(base, `index${extension}`));
  return candidates.find((candidate) => files.has(candidate)) ?? null;
}

const isRelative = (/** @type {string} */ source) => source === "." || source === ".." || source.startsWith("./") || source.startsWith("../");

const matches = (/** @type {readonly string[]} */ names, /** @type {string} */ source) => names.includes(source);

/**
 * Checks one app's folder. Returns everything that is not allowed, in the
 * order of the files; an empty list means the app keeps to the SDK.
 *
 * @param {string} appDir The app's folder.
 * @param {{ overrides?: ReadonlyMap<string, string> }} [options]
 *   overrides: the text of files as an editor holds them, by absolute path,
 *   used instead of what is on disk.
 * @returns {Violation[]}
 */
export function scanApp(appDir, options = {}) {
  const root = path.resolve(appDir);
  const overrides = options.overrides ?? new Map();
  const listed = listSourceFiles(root);
  const files = new Set(listed.files);
  for (const file of overrides.keys()) {
    if (isInside(root, file) && isSourceFile(file)) files.add(path.resolve(file));
  }
  const name = (/** @type {string} */ file) => path.relative(root, file).split(path.sep).join("/");

  /** @type {Violation[]} */
  const violations = listed.strayLinks.map((file) => ({
    file,
    line: 1,
    column: 1,
    message: `"${name(file)}" is a link to something outside this mini-app's folder. An app's folder holds its own files only.`,
  }));

  /** @type {Map<string, ImportSite[]>} */
  const sitesOf = new Map();
  for (const file of [...files].sort()) {
    const text = overrides.get(file) ?? fs.readFileSync(file, "utf8");
    sitesOf.set(file, importsOf(file, text));
  }

  const serverEntry = path.join(root, SERVER_ENTRY);
  const isTest = (/** @type {string} */ file) => TEST_FILE.test(file);

  /**
   * The files that end up in a bundle that starts at `entries`: everything
   * reached through imports that survive compiling. The browser's side does
   * not go on into server.ts: importing it there is reported where it
   * happens, once, instead of at every line of the server file.
   *
   * @param {string[]} entries
   * @param {boolean} stopAtServer
   */
  const reach = (entries, stopAtServer) => {
    /** @type {Set<string>} */
    const seen = new Set();
    const queue = entries.map((entry) => path.join(root, entry)).filter((file) => files.has(file));
    for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
      if (seen.has(file)) continue;
      seen.add(file);
      for (const site of sitesOf.get(file) ?? []) {
        if (site.typeOnly || site.source === null || !isRelative(site.source)) continue;
        const target = resolveRelative(file, site.source, files);
        if (target !== null && !(stopAtServer && target === serverEntry)) queue.push(target);
      }
    }
    return seen;
  };
  const web = reach(WEB_ENTRIES, true);
  const shared = reach([SHARED_ENTRY], true);
  const server = reach([SERVER_ENTRY], false);
  const inBrowser = (/** @type {string} */ file) => web.has(file) || shared.has(file);

  for (const [file, sites] of sitesOf) {
    const report = (/** @type {ImportSite} */ site, /** @type {string} */ message) =>
      violations.push({ file, line: site.line, column: site.column, message });
    const usesWeb = sites.some((site) => site.source !== null && matches(WEB_ONLY, site.source));

    for (const site of sites) {
      if (site.kind === "require") {
        report(site, "A mini-app is written with import, not require().");
        continue;
      }
      const source = site.source;
      if (source === null) {
        report(site, "An import() must name what it imports as plain text, so that the build can check it.");
        continue;
      }

      if (isRelative(source)) {
        const target = path.resolve(path.dirname(file), withoutQuery(source));
        if (!isInside(root, target)) {
          report(site, `"${source}" is a file outside this mini-app's folder. A mini-app may only import its own files and the SDK.`);
          continue;
        }
        const unread = path.relative(root, target).split(path.sep).find(isUnread);
        if (unread !== undefined) {
          report(
            site,
            unread === "node_modules"
              ? `"${source}" is in a node_modules folder. A mini-app has no packages of its own: it uses only the SDK.`
              : `"${source}" is hidden ("${unread}" starts with a dot), and the build does not check hidden files. Keep the app's code in plain files and folders.`,
          );
          continue;
        }
        if (site.typeOnly || isTest(file)) continue;
        if (resolveRelative(file, source, files) === serverEntry && (inBrowser(file) || usesWeb)) {
          report(
            site,
            `"${source}" must be imported with "import type" here: ${name(file)} is part of what the browser loads, and any other import would put the server's code there.`,
          );
        }
        continue;
      }

      if (source === SDK) continue;

      if (matches(TEST_ONLY, source)) {
        if (!isTest(file)) report(site, `"${source}" is for test files (*.test.ts) only.`);
        else if (inBrowser(file) || server.has(file)) {
          report(site, `"${source}" is for tests, but ${name(file)} is imported by the app itself.`);
        }
        continue;
      }

      const forWeb = matches(WEB_ONLY, source);
      const forServer = matches(SERVER_ONLY, source);
      if (!forWeb && !forServer) {
        const what = source.startsWith(`${SDK}/`) ? "is not a part of the SDK that mini-apps import" : "is neither";
        report(
          site,
          `A mini-app may only import its own files and the SDK (@hearth/sdk, @hearth/sdk/web and react in the widget and the page, @hearth/sdk/server in server.ts). "${source}" ${what}.`,
        );
        continue;
      }

      // Test files are in no bundle; the rest of this is about bundles.
      if (isTest(file) && !inBrowser(file) && !server.has(file)) continue;

      if (forWeb) {
        if (file === path.join(root, SHARED_ENTRY)) {
          report(site, `manifest.ts may import "@hearth/sdk" and the app's own files only: the server reads it too, and "${source}" is for the browser.`);
        } else if (server.has(file)) {
          const why = file === serverEntry ? "server.ts runs on the server" : `${name(file)} is imported by server.ts, which runs on the server`;
          report(site, `"${source}" is for the widget and the page: ${why}.`);
        } else if (shared.has(file)) {
          report(site, `"${source}" is for the widget and the page, but ${name(file)} is imported by manifest.ts, which the server reads too.`);
        }
        continue;
      }

      // @hearth/sdk/server
      if (inBrowser(file)) {
        const by = WEB_ENTRIES.includes(name(file)) || name(file) === SHARED_ENTRY ? "" : ", which the widget, the page or the manifest imports,";
        report(site, `"${source}" is for server.ts and the files only it imports: ${name(file)}${by} is part of what the browser loads.`);
      } else if (usesWeb && !server.has(file)) {
        // In a file the server runs, the import that is for the browser is the one reported.
        report(site, `One file cannot import both "${source}" and what is for the browser (@hearth/sdk/web, react).`);
      }
    }
  }

  return violations.sort(
    (a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column || a.message.localeCompare(b.message),
  );
}
