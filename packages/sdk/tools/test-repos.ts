/**
 * Helpers for the tests of the `hearth-apps` command: mini-apps repositories
 * made up in a temporary folder, outside this checkout, the way hearth-stones
 * lies beside hearth.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
