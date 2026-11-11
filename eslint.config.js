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
import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import globals from "globals";
import { miniAppBoundary } from "./packages/sdk/tools/eslint-boundary.mjs";

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
 * The check itself belongs to the SDK (packages/sdk/tools/eslint-boundary.mjs),
 * because every repository of mini-apps needs it: hearth-stones gets it
 * through "@hearth/sdk/eslint". It says what a file of an app may import,
 * which globals it may not touch, and that no comment switches a rule off.
 *
 * In this repository it applies to every folder directly inside one of
 * MINI_APP_ROOTS: the framework's own sample apps, which tests run against
 * and the template will be copied from.
 *
 * It is imported by path, not as "@hearth/sdk/eslint": that entry point is a
 * whole configuration and loads typescript-eslint, which this file must be
 * able to do without (see above).
 * ---------------------------------------------------------------------- */
const MINI_APP_ROOTS = ["packages/fixture-apps"];

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

const NOT_THE_FRAMEWORK = [
  "^@hearth/(server|web|shared)($|/)|/packages/(server|web|shared)/|^(\\.\\./)+(server|web|shared)/src/",
  "The SDK is what mini-apps are written against, also in other repositories. It stands alone and imports no framework package.",
];

export default defineConfig([
  globalIgnores([
    "**/node_modules/",
    "**/dist/",
    "**/build/",
    "**/coverage/",
    "playwright-report/",
    "test-results/",
    // Written by `hearth-apps sync`; see packages/sdk/tools/sync.mjs.
    "**/*.generated.{js,css}",
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
      "packages/sdk/bin/**",
      "packages/sdk/tools/**",
      "packages/sdk/eslint.js",
      "packages/server/**",
      "e2e/**",
    ],
    languageOptions: { globals: globals.node },
  },
  {
    name: "hearth/browser-globals",
    files: ["packages/web/src/**", "packages/web/public/**", "packages/sdk/src/web/**"],
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
    name: "hearth/sdk-boundary",
    files: ["packages/sdk/src/**"],
    rules: { "no-restricted-imports": forbidImports(NOT_THE_FRAMEWORK) },
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

  ...miniAppBoundary({ roots: MINI_APP_ROOTS, base: import.meta.dirname }),
]);
