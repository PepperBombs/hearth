/**
 * ESLint configuration for the whole workspace (flat config, ESLint 10).
 * Run it with `pnpm lint` at the repository root.
 *
 * What it covers: packages/<name>/src, e2e, and the configuration files next
 * to them. What it skips: build output and node_modules.
 *
 * The rules are the recommended sets of ESLint and typescript-eslint plus a
 * few boundaries between packages. Rules that need type information are left
 * out on purpose: they are slower, and the type checker already runs in
 * `pnpm typecheck`.
 */
import path from "node:path";
import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import globals from "globals";

const SCRIPTS = ["**/*.{js,mjs,cjs}"];
const TYPESCRIPT = ["**/*.{ts,tsx,mts,cts}"];

/* -------------------------------------------------------------------------
 * typescript-eslint
 *
 * typescript-eslint 8 needs the TypeScript 6 programming interface and stops
 * with an error when the only `typescript` package it can find is version 7.
 * If that happens here, TypeScript files are NOT linted: this file says so
 * and carries on with the JavaScript files, so that `pnpm lint` still runs.
 * With HEARTH_LINT_STRICT=1 (set in CI) the error is fatal instead, because a
 * lint run that silently skips almost every file must not pass a pull request.
 * The fix is in the dependencies, not here: see docs/architecture.md, "Checks".
 * ---------------------------------------------------------------------- */
async function loadTypescriptEslint() {
  try {
    return (await import("typescript-eslint")).default;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (process.env.HEARTH_LINT_STRICT === "1") {
      throw new Error(
        `typescript-eslint could not be loaded, so TypeScript files cannot be linted (${reason}). ` +
          "See docs/architecture.md, section \"Checks\".",
        { cause: error },
      );
    }
    console.warn(
      [
        "",
        "WARNING: typescript-eslint could not be loaded, so TypeScript files are NOT being linted.",
        `         Reason: ${reason}`,
        "         Only JavaScript files are checked in this run.",
        "         See docs/architecture.md, section \"Checks\", for the fix.",
        "",
      ].join("\n"),
    );
    return null;
  }
}

const tseslint = await loadTypescriptEslint();

/* -------------------------------------------------------------------------
 * "A mini-app uses only the SDK" (AGENTS.md)
 *
 * Mini-apps do not exist yet. This is where the automated check for that
 * rule lives, ready for the step that adds the mini-app contract:
 *
 *  - In this repository it applies to every folder directly inside one of
 *    MINI_APP_ROOTS (for example the template app). Nothing is there today,
 *    so the rule matches no file. Change MINI_APP_ROOTS when the real
 *    location is decided.
 *  - The hearth-apps repository lints itself. Its eslint.config.js imports
 *    `miniAppBoundary` from this file (the two repositories are checked out
 *    side by side) and calls it with the folder that holds its apps:
 *
 *        import { miniAppBoundary } from "../hearth/eslint.config.js";
 *        export default [...miniAppBoundary({ roots: ["."] })];
 *
 *    Once the SDK is a package, this block should move into it so that
 *    hearth-apps imports it from "@hearth/sdk" instead of by path.
 *
 * Inside a mini-app (one folder directly inside a root) an import may name:
 *  - a file inside the same mini-app folder, by relative path;
 *  - a package listed in `allow`, by default only "@hearth/sdk" and anything
 *    below it ("@hearth/sdk/ui").
 * Everything else is an error: framework packages, files outside the folder
 * (another mini-app, the framework's source), Node's built-in modules, and
 * any other package. If the mini-app contract decides that mini-apps may
 * import something else directly, add it to MINI_APP_ALLOWED_PACKAGES.
 * ---------------------------------------------------------------------- */
const MINI_APP_ROOTS = ["apps"];
const MINI_APP_ALLOWED_PACKAGES = ["@hearth/sdk"];

/** The folder of the mini-app that `file` belongs to, or null. */
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
        properties: {
          roots: { type: "array", items: { type: "string" } },
          allow: { type: "array", items: { type: "string" } },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      outside:
        'A mini-app may only import its own files and the SDK. "{{source}}" is a file outside this mini-app\'s folder.',
      notAllowed:
        'A mini-app may only import its own files and the SDK ({{allowed}}). "{{source}}" is neither.',
    },
  },
  create(context) {
    const options = context.options[0] ?? {};
    const roots = (options.roots ?? MINI_APP_ROOTS).map((root) => path.resolve(context.cwd, root));
    const allow = options.allow ?? MINI_APP_ALLOWED_PACKAGES;
    const file = context.physicalFilename;
    const folder = miniAppFolder(file, roots);
    if (!folder) return {};

    function check(node) {
      if (!node || node.type !== "Literal" || typeof node.value !== "string") return;
      const source = node.value;
      if (source.startsWith(".")) {
        const target = path.resolve(path.dirname(file), source);
        const inside = path.relative(folder, target);
        if (inside.startsWith("..") || path.isAbsolute(inside)) {
          context.report({ node, messageId: "outside", data: { source } });
        }
        return;
      }
      if (allow.some((name) => source === name || source.startsWith(`${name}/`))) return;
      const absolute = path.isAbsolute(source) || /^[a-z]:[\\/]/i.test(source) || source.startsWith("file:");
      context.report({
        node,
        messageId: absolute ? "outside" : "notAllowed",
        data: { source, allowed: allow.join(", ") },
      });
    }

    return {
      ImportDeclaration: (node) => check(node.source),
      ExportNamedDeclaration: (node) => check(node.source),
      ExportAllDeclaration: (node) => check(node.source),
      ImportExpression: (node) => check(node.source),
      CallExpression(node) {
        if (node.callee.type === "Identifier" && node.callee.name === "require") {
          check(node.arguments[0]);
        }
      },
    };
  },
};

const hearthPlugin = { rules: { "mini-app-imports": miniAppImportsRule } };

/**
 * The configuration that enforces "a mini-app uses only the SDK".
 *
 * @param {{ roots?: string[], allow?: string[] }} [options]
 *   roots: folders whose direct children are mini-apps, relative to where
 *   ESLint runs. allow: package names a mini-app may import.
 */
export function miniAppBoundary(options = {}) {
  const roots = options.roots ?? MINI_APP_ROOTS;
  const allow = options.allow ?? MINI_APP_ALLOWED_PACKAGES;
  const extensions = "{js,mjs,cjs,jsx,ts,tsx,mts,cts}";
  return [
    {
      name: "hearth/mini-app-boundary",
      files: roots.map((root) => path.posix.join(root, "*", "**", `*.${extensions}`)),
      plugins: { hearth: hearthPlugin },
      rules: { "hearth/mini-app-imports": ["error", { roots, allow }] },
    },
  ];
}

/* -------------------------------------------------------------------------
 * Boundaries between the framework's own packages
 * ---------------------------------------------------------------------- */

/** Builds a `no-restricted-imports` setting from [pattern, message] pairs. */
function forbidImports(...entries) {
  return [
    "error",
    { patterns: entries.map(([regex, message]) => ({ regex, message })) },
  ];
}

const NOT_THE_SERVER = [
  "^@hearth/server($|/)|/packages/server/|^(\\.\\./)+server/src/",
  "The web app and the server share only @hearth/shared, the contract between them.",
];
const NOT_THE_WEB_APP = [
  "^@hearth/web($|/)|/packages/web/|^(\\.\\./)+web/src/",
  "The web app and the server share only @hearth/shared, the contract between them.",
];

export default defineConfig([
  globalIgnores([
    "**/node_modules/",
    "**/dist/",
    "**/build/",
    "**/coverage/",
    "playwright-report/",
    "test-results/",
  ]),

  { name: "hearth/recommended", files: [...SCRIPTS, ...TYPESCRIPT], extends: [js.configs.recommended] },

  tseslint
    ? { name: "hearth/typescript", files: TYPESCRIPT, extends: [tseslint.configs.recommended] }
    : // Without typescript-eslint nothing here can read TypeScript.
      globalIgnores(TYPESCRIPT, "hearth/typescript-not-linted"),

  {
    name: "hearth/rules",
    files: [...SCRIPTS, ...TYPESCRIPT],
    linterOptions: { reportUnusedDisableDirectives: "error" },
    rules: {
      eqeqeq: ["error", "always", { null: "ignore" }],
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", caughtErrors: "none" }],
    },
  },
  {
    name: "hearth/typescript-rules",
    files: TYPESCRIPT,
    rules: tseslint
      ? {
          "no-unused-vars": "off",
          "@typescript-eslint/no-unused-vars": [
            "error",
            { argsIgnorePattern: "^_", caughtErrors: "none" },
          ],
        }
      : {},
  },

  // Which names exist without being imported. TypeScript files do not need
  // this (the type checker knows); it matters for the few plain scripts.
  {
    name: "hearth/node-globals",
    files: [
      "*.config.{js,ts}",
      "packages/*/*.config.{js,ts}",
      "packages/*/scripts/**",
      "packages/server/**",
      "e2e/**",
    ],
    languageOptions: { globals: globals.node },
  },
  {
    name: "hearth/browser-globals",
    files: ["packages/web/src/**", "packages/web/public/**"],
    languageOptions: { globals: globals.browser },
  },
  {
    name: "hearth/service-worker-globals",
    files: ["packages/web/src/sw/**"],
    languageOptions: { globals: globals.serviceworker },
  },

  {
    name: "hearth/shared-boundary",
    files: ["packages/shared/src/**"],
    rules: { "no-restricted-imports": forbidImports(NOT_THE_SERVER, NOT_THE_WEB_APP) },
  },
  {
    name: "hearth/web-boundary",
    files: ["packages/web/src/**"],
    rules: { "no-restricted-imports": forbidImports(NOT_THE_SERVER) },
  },
  {
    name: "hearth/server-boundary",
    files: ["packages/server/src/**"],
    rules: { "no-restricted-imports": forbidImports(NOT_THE_WEB_APP) },
  },

  ...miniAppBoundary(),
]);
