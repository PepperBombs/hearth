/**
 * "A mini-app uses only the SDK", as ESLint reports it.
 *
 * `miniAppBoundary()` returns the configuration for the files of mini-apps:
 *
 *  - `hearth/mini-app-imports`: what a file of an app may import. The rule
 *    asks the import scan (import-scan.mjs), the same one `hearth-apps sync`
 *    runs before every build, so an editor and a pull request show exactly
 *    what the build would refuse. The scan is the gate; this is the early
 *    warning.
 *  - `no-restricted-globals`: an app does not reach outside by a global
 *    either. `fetch`, `process`, `localStorage`, `eval` and `Function` are
 *    refused. An app fetches only in a job, with `ctx.fetch`, from the
 *    hosts its manifest lists (docs/mini-app-contract.md, section C).
 *  - comments cannot switch a rule off (`noInlineConfig`).
 *
 * This file needs only ESLint itself and the TypeScript parser the scan
 * uses, so the framework's own eslint.config.js can import it even when
 * typescript-eslint cannot be loaded. The full configuration for a
 * mini-apps repository is ../eslint.js.
 *
 * Design: docs/mini-app-contract.md, section A7, "SDK only", layer 3.
 */
import path from "node:path";
import { scanApp } from "./import-scan.mjs";

/**
 * The folder of the mini-app that `file` belongs to: a direct child of one
 * of `roots`. Null when it is in none.
 *
 * @param {string} file
 * @param {readonly string[]} roots
 */
function miniAppFolder(file, roots) {
  for (const root of roots) {
    const inside = path.relative(root, file);
    if (inside.startsWith("..") || path.isAbsolute(inside)) continue;
    const parts = inside.split(path.sep);
    if (parts.length >= 2 && parts[0]) return path.join(root, parts[0]);
  }
  return null;
}

/** @type {import("eslint").Rule.RuleModule} */
const miniAppImportsRule = {
  meta: {
    type: "problem",
    docs: { description: "A mini-app imports only the SDK and its own files." },
    schema: [
      {
        type: "object",
        properties: { roots: { type: "array", items: { type: "string" } } },
        additionalProperties: false,
      },
    ],
    messages: { refused: "{{message}}" },
  },
  create(context) {
    /** @type {{ roots?: string[] }} */
    const options = context.options[0] ?? {};
    const roots = (options.roots ?? ["."]).map((root) => path.resolve(context.cwd, root));
    const file = context.physicalFilename;
    const folder = miniAppFolder(file, roots);
    if (!folder) return {};

    return {
      Program() {
        // The scan reads the app's other files from disk and this one as the
        // editor holds it, so a finding moves with the text being typed.
        const overrides = context.filename === file ? new Map([[file, context.sourceCode.text]]) : new Map();
        for (const violation of scanApp(folder, { overrides })) {
          if (violation.file !== file) continue;
          context.report({
            loc: { line: violation.line, column: violation.column - 1 },
            messageId: "refused",
            data: { message: violation.message },
          });
        }
      },
    };
  },
};

const hearthPlugin = { rules: { "mini-app-imports": miniAppImportsRule } };

const RESTRICTED_GLOBALS = [
  { name: "fetch", message: "A mini-app fetches in a job, with ctx.fetch, from the hosts its manifest lists." },
  {
    name: "process",
    message: "A mini-app does not read the server's process or environment. What it needs to know is a setting in its manifest.",
  },
  {
    name: "localStorage",
    message: "A mini-app keeps what it remembers in its settings or its rows, where the space and the person are known.",
  },
  { name: "eval", message: "A mini-app does not run text as code." },
  { name: "Function", message: "A mini-app does not run text as code." },
];

/**
 * The configuration that holds mini-apps to the SDK.
 *
 * @param {{ roots?: string[], base?: string }} [options]
 *   roots: the folders whose direct children are mini-apps, relative to the
 *   configuration file; by default the folder itself, as in a mini-apps
 *   repository. base: the configuration file's folder (`import.meta.dirname`
 *   there). Without it the roots are read from where ESLint runs, which is
 *   the same thing when ESLint runs in the repository's root.
 * @returns {import("eslint").Linter.Config[]}
 */
export function miniAppBoundary(options = {}) {
  const roots = options.roots ?? ["."];
  const base = options.base;
  const extensions = "{js,mjs,cjs,jsx,ts,tsx,mts,cts}";
  return [
    {
      name: "hearth/mini-app-boundary",
      files: roots.map((root) => path.posix.join(root, "*", "**", `*.${extensions}`)),
      plugins: { hearth: hearthPlugin },
      linterOptions: { noInlineConfig: true },
      rules: {
        "hearth/mini-app-imports": ["error", { roots: base ? roots.map((root) => path.resolve(base, root)) : roots }],
        "no-restricted-globals": ["error", ...RESTRICTED_GLOBALS],
      },
    },
  ];
}
