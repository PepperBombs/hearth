/**
 * Helpers for the tests of the `hearth-apps` command: mini-apps repositories
 * made up in a temporary folder, outside this checkout, the way hearth-stones
 * lies beside hearth.
 */
import { spawnSync } from "node:child_process";
import { stripVTControlCharacters } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect } from "vitest";
import { SDK_VERSION } from "../src/index";

/** The root of this checkout. */
export const ROOT = path.resolve(import.meta.dirname, "../../..");
export const SDK_DIR = path.join(ROOT, "packages/sdk");
/** The framework's own sample apps. */
export const FIXTURES = path.join(ROOT, "packages/fixture-apps");
export const BIN = path.join(SDK_DIR, "bin/hearth-apps.mjs");

const made: string[] = [];

/** A new empty folder that `removeTempDirs` deletes again. */
export function tempDir(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hearth-apps-")));
  made.push(dir);
  return dir;
}

/** Call in `afterEach`. */
export function removeTempDirs(): void {
  for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
}

/** Writes files into a folder: path inside it, then content. */
export function write(dir: string, files: Record<string, string>): void {
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(dir, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
}

const manifestOf = (id: string) => `import { defineApp } from "@hearth/sdk";

export default defineApp({
  id: ${JSON.stringify(id)},
  name: { en: "Notes", zh: "笔记" },
  description: { en: "Short notes.", zh: "简短的笔记。" },
  icon: "notebook-text",
  color: "amber",
  widget: { size: "small" },
});
`;

/**
 * The files of the smallest app that passes every check, each under
 * `<folder>/`. `id` is what the manifest says, the folder's name unless given.
 */
export function appFiles(folder: string, id = folder): Record<string, string> {
  return {
    [`${folder}/manifest.ts`]: manifestOf(id),
    [`${folder}/widget.tsx`]: "export default function Widget() {\n  return null;\n}\n",
    [`${folder}/package.json`]: `${JSON.stringify({ name: `@sample/${folder}`, version: "0.1.0", private: true, type: "module" }, null, 2)}\n`,
    [`${folder}/README.md`]: "# Notes\n\nA sample app.\n",
  };
}

export type RepoOptions = {
  /** What "hearth.sdk" says. Default: a caret range on this checkout's version. `null` leaves it out. */
  sdk?: string | null;
  /** Where node_modules/@hearth/sdk leads. Default: this checkout's SDK. `null` leaves it out. */
  link?: string | null;
  /** Names of the framework's sample apps to copy in. */
  fixtures?: readonly ("checklist" | "feed")[];
  /** More files, by path inside the repository. */
  files?: Record<string, string>;
};

/**
 * A mini-apps repository in a temporary folder, shaped as the contract
 * describes hearth-stones: package.json with the SDK version it was written
 * for, the link to the SDK, tsconfig.json and eslint.config.js.
 */
export function makeRepo(options: RepoOptions = {}): string {
  const dir = tempDir();
  const sdk = options.sdk === undefined ? `^${SDK_VERSION}` : options.sdk;
  write(dir, {
    "package.json": `${JSON.stringify({ name: "sample-stones", private: true, type: "module", ...(sdk === null ? {} : { hearth: { sdk } }) }, null, 2)}\n`,
    "tsconfig.json": '{ "extends": "@hearth/sdk/tsconfig.app.json", "compilerOptions": { "noEmit": true } }\n',
    "eslint.config.js": 'export { default } from "@hearth/sdk/eslint";\n',
  });
  const link = options.link === undefined ? SDK_DIR : options.link;
  if (link !== null) {
    fs.mkdirSync(path.join(dir, "node_modules/@hearth"), { recursive: true });
    fs.symlinkSync(link, path.join(dir, "node_modules/@hearth/sdk"), "dir");
  }
  for (const name of options.fixtures ?? []) {
    fs.cpSync(path.join(FIXTURES, name), path.join(dir, name), { recursive: true });
  }
  write(dir, options.files ?? {});
  return dir;
}

/**
 * The files of a mini-apps repository set up as hearth-stones is: as
 * docs/mini-app-contract.md (A1) has them, and the lockfile pnpm 10 writes
 * for that package.json, the link to the SDK and nothing else. `dev` is
 * `exec hearth-apps dev`, so that a stop sent to pnpm reaches the command
 * (dev.mjs, `startDevServers`).
 */
export const STONES: Record<string, string> = {
  "package.json": `${JSON.stringify(
    {
      name: "sample-stones",
      private: true,
      type: "module",
      hearth: { sdk: `^${SDK_VERSION}` },
      scripts: { check: "hearth-apps check", test: "hearth-apps test", dev: "exec hearth-apps dev", new: "hearth-apps new" },
      devDependencies: { "@hearth/sdk": "link:../hearth/packages/sdk" },
    },
    null,
    2,
  )}\n`,
  "pnpm-lock.yaml": [
    "lockfileVersion: '9.0'",
    "",
    "settings:",
    "  autoInstallPeers: true",
    "  excludeLinksFromLockfile: false",
    "",
    "importers:",
    "",
    "  .:",
    "    devDependencies:",
    "      '@hearth/sdk':",
    "        specifier: link:../hearth/packages/sdk",
    "        version: link:../hearth/packages/sdk",
    "",
  ].join("\n"),
  "tsconfig.json": '{ "extends": "@hearth/sdk/tsconfig.app.json", "compilerOptions": { "noEmit": true } }\n',
  "eslint.config.js": 'export { default } from "@hearth/sdk/eslint";\n',
};

/**
 * A repository set up as hearth-stones is, beside a folder named "hearth"
 * that is `hearth` (this checkout unless given), as on the server and in CI,
 * and linked to its SDK as they link it, with the real
 * `pnpm install --frozen-lockfile --offline`. `pnpm` runs pnpm in it with
 * `env`, which has no HEARTH_APPS_DIR.
 */
export function setUpStones(hearth: string = ROOT) {
  const base = tempDir();
  fs.symlinkSync(hearth, path.join(base, "hearth"), "dir");
  const stones = path.join(base, "hearth-stones");
  write(stones, STONES);
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.HEARTH_APPS_DIR;
  const pnpm = (args: string[]) => {
    const result = spawnSync("pnpm", args, { cwd: stones, env, encoding: "utf8" });
    expect(result.error).toBeUndefined();
    return { status: result.status, output: printed(result) };
  };
  expect(pnpm(["install", "--frozen-lockfile", "--offline"]).status).toBe(0);
  return { stones, env, pnpm };
}

/**
 * What a command run by a test printed, as plain text. Some environments
 * switch colour on for every child process (GitHub's runners do), and the
 * codes that colour a word would come between the words a test looks for.
 */
export const printed = (result: { stdout: string; stderr: string }): string =>
  stripVTControlCharacters(result.stdout + result.stderr);
