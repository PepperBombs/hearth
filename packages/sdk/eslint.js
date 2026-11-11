/**
 * @hearth/sdk/eslint: the ESLint configuration of a mini-apps repository.
 *
 * A repository of mini-apps (hearth-stones, or anyone else's) has an
 * eslint.config.js of one line:
 *
 *     export { default } from "@hearth/sdk/eslint";
 *
 * It lints every app folder with the recommended rules of ESLint and
 * typescript-eslint, and holds each app to "a mini-app uses only the SDK"
 * (tools/eslint-boundary.mjs): what it may import, which globals it may not
 * touch, and no comment that switches a rule off. `hearth-apps check` runs
 * it; an editor shows the same findings while typing.
 *
 * The hard gate is not this file but the import scan in `hearth-apps sync`,
 * which runs before every build whatever ESLint is told.
 *
 * Run ESLint from the repository's root: the apps are the folders directly
 * inside the folder ESLint runs in.
 */
import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";
import { miniAppBoundary } from "./tools/eslint-boundary.mjs";

export { miniAppBoundary };

const SCRIPTS = ["**/*.{js,mjs,cjs}"];
const TYPESCRIPT = ["**/*.{ts,tsx,mts,cts}"];

export default defineConfig([
  globalIgnores(["**/node_modules/"]),
  { name: "hearth/apps-recommended", files: [...SCRIPTS, ...TYPESCRIPT], extends: [js.configs.recommended] },
  { name: "hearth/apps-typescript", files: TYPESCRIPT, extends: [tseslint.configs.recommended] },
  {
    name: "hearth/apps-rules",
    files: [...SCRIPTS, ...TYPESCRIPT],
    rules: { eqeqeq: ["error", "always", { null: "ignore" }] },
  },
  {
    name: "hearth/apps-typescript-rules",
    files: TYPESCRIPT,
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", caughtErrors: "none" }],
    },
  },
  ...miniAppBoundary(),
]);
