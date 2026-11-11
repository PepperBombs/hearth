/**
 * The `hearth-apps` command as it is run: by `pnpm build` in this
 * repository, by the deploy, and by a mini-apps repository checking itself.
 *
 * Every run here sends the generated files to a temporary folder (`--out`),
 * so that the tests never change what this checkout builds.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SDK_VERSION } from "../src/index";
import { GENERATED } from "./sync.mjs";
import { BIN, FIXTURES, ROOT, appFiles, makeRepo, removeTempDirs, tempDir, write } from "./test-repos";

afterEach(removeTempDirs);

type Run = { status: number | null; output: string; out: string };

/** Runs the command. `appsDir` is HEARTH_APPS_DIR, left unset when not given. */
function hearthApps(args: string[], options: { appsDir?: string; cwd?: string } = {}): Run {
  const out = tempDir();
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.HEARTH_APPS_DIR;
  if (options.appsDir !== undefined) env.HEARTH_APPS_DIR = options.appsDir;
  const result = spawnSync(process.execPath, [BIN, ...args, "--out", out], {
    cwd: options.cwd ?? ROOT,
    env,
    encoding: "utf8",
  });
  return { status: result.status, output: result.stdout + result.stderr, out };
}

const generated = (run: Run, name: keyof typeof GENERATED) => fs.readFileSync(path.join(run.out, GENERATED[name]), "utf8");
const wroteNothing = (run: Run) => !fs.existsSync(path.join(run.out, "packages"));

// A full check starts the type checker and ESLint.
const SLOW = 120_000;

describe("hearth-apps sync", () => {
  it("builds without apps when no folder is named, the folder is missing, or it is empty", () => {
    const unset = hearthApps(["sync"]);
    expect(unset).toMatchObject({ status: 0, output: expect.stringContaining("this build holds no mini-apps") });

    const missing = hearthApps(["sync"], { appsDir: path.join(tempDir(), "hearth-stones") });
    const empty = hearthApps(["sync"], { appsDir: tempDir() });
    for (const run of [missing, empty]) {
      expect(run.status).toBe(0);
      for (const name of ["server", "web", "css"] as const) expect(generated(run, name)).toBe(generated(unset, name));
    }
    expect(generated(unset, "server")).toContain("export const apps = [];");
  });

  it("builds the framework's sample apps in, named relative to the repository's root", () => {
    const run = hearthApps(["sync"], { appsDir: "packages/fixture-apps", cwd: path.join(ROOT, "packages/web") });
    expect(run).toMatchObject({ status: 0, output: expect.stringContaining("this build holds 2 mini-apps (checklist, feed)") });
    expect(generated(run, "server")).toContain('{ id: "checklist", manifest: manifest0, hasPage: true, server: server0 },');
    expect(generated(run, "web")).toContain('id: "feed"');
  });

  it("ends with status 3 for a folder written for another SDK version, and says both versions", () => {
    const repo = makeRepo({ sdk: "^0.9.0", fixtures: ["checklist"] });
    const run = hearthApps(["sync"], { appsDir: repo });
    expect(run.status).toBe(3);
    expect(run.output).toContain("were written for @hearth/sdk ^0.9.0");
    expect(run.output).toContain(`holds @hearth/sdk ${SDK_VERSION}`);
    expect(wroteNothing(run)).toBe(true);
  });

  it("ends with status 1 for a foreign import", () => {
    const repo = makeRepo({ fixtures: ["feed"] });
    write(repo, { "feed/widget.tsx": 'import dayjs from "dayjs";\nexport default function Widget() {\n  return dayjs;\n}\n' });
    const run = hearthApps(["sync"], { appsDir: repo });
    expect(run.status).toBe(1);
    expect(run.output).toMatch(/feed\/widget\.tsx:1:19: A mini-app may only import its own files and the SDK .*"dayjs" is neither\./);
    expect(wroteNothing(run)).toBe(true);
  });

  it("ends with status 1 for a widget that imports the server file as a value", () => {
    const repo = makeRepo({ fixtures: ["checklist"] });
    write(repo, { "checklist/widget.tsx": 'import server from "./server";\nexport default function Widget() {\n  return typeof server;\n}\n' });
    const run = hearthApps(["sync"], { appsDir: repo });
    expect(run.status).toBe(1);
    expect(run.output).toMatch(/checklist\/widget\.tsx:1:20: "\.\/server" must be imported with "import type" here/);
    expect(wroteNothing(run)).toBe(true);
  });

  it("ends with status 1 for an app that declares a dependency", () => {
    const repo = makeRepo({ fixtures: ["feed"] });
    write(repo, { "feed/package.json": '{ "name": "feed", "dependencies": { "dayjs": "^1.0.0" } }\n' });
    const run = hearthApps(["sync"], { appsDir: repo });
    expect(run.status).toBe(1);
    expect(run.output).toContain("feed/package.json declares dependencies (dayjs). A mini-app has no dependencies of its own");
    expect(wroteNothing(run)).toBe(true);
  });

  it("ends with status 1 for an app that two folders hold, naming both", () => {
    const repo = makeRepo({ fixtures: ["feed"] });
    const run = hearthApps(["sync"], { appsDir: [FIXTURES, repo].join(path.delimiter) });
    expect(run.status).toBe(1);
    expect(run.output).toContain(`The mini-app "feed" is in two folders: ${FIXTURES} and ${repo}.`);
  });
});

describe("hearth-apps check", () => {
  it("passes the framework's sample apps", { timeout: SLOW }, () => {
    const run = hearthApps(["check"], { appsDir: "packages/fixture-apps" });
    expect(run.output).toContain("2 mini-apps passed (checklist, feed)");
    expect(run.status).toBe(0);
  });

  it("passes the same apps in a repository of their own, checked from inside it", { timeout: SLOW }, () => {
    // As hearth-stones will be: beside this checkout, linked to its SDK,
    // with a one-line tsconfig.json and eslint.config.js.
    const repo = makeRepo({ fixtures: ["checklist", "feed"] });
    const run = hearthApps(["check"], { cwd: repo });
    expect(run.output).toContain("2 mini-apps passed (checklist, feed)");
    expect(run.status).toBe(0);
    expect(generated(run, "web")).toContain(`${path.basename(repo)}/checklist/widget.tsx`);
  });

  it("has nothing to say about a folder without apps", () => {
    const run = hearthApps(["check"], { cwd: tempDir() });
    expect(run).toMatchObject({ status: 0, output: expect.stringContaining("no mini-apps to check") });
  });

  it("fails an app whose ID is not its folder's name", { timeout: SLOW }, () => {
    const repo = makeRepo({ files: appFiles("notes", "diary") });
    const run = hearthApps(["check"], { cwd: repo });
    expect(run.status).toBe(1);
    expect(run.output).toContain('App "notes": the manifest\'s id is "diary". An app\'s folder name and its manifest\'s id must be equal.');
    expect(run.output).toContain("failed (manifests and server files)");
  });

  it("fails a manifest with a language missing", { timeout: SLOW }, () => {
    const repo = makeRepo({ fixtures: ["checklist"] });
    const manifest = path.join(repo, "checklist/manifest.ts");
    fs.writeFileSync(manifest, fs.readFileSync(manifest, "utf8").replace('zh: "清单"', 'zh: ""'));
    const run = hearthApps(["check"], { cwd: repo });
    expect(run.status).toBe(1);
    expect(run.output).toContain('App "checklist": manifest name.zh: Must not be empty.');
  });

  it("fails a query or mutation that does not say what it does", { timeout: SLOW }, () => {
    const repo = makeRepo({ fixtures: ["checklist"] });
    const server = path.join(repo, "checklist/server.ts");
    const text = fs.readFileSync(server, "utf8");
    const silent = text.replace('description: "Ticks one item of the checklist off, or unticks it."', 'description: " "');
    expect(silent).not.toBe(text);
    fs.writeFileSync(server, silent);
    const run = hearthApps(["check"], { cwd: repo });
    expect(run.status).toBe(1);
    expect(run.output).toContain('App "checklist": server route "tick": Needs a description');
    expect(run.output).toContain("failed (manifests and server files)");
  });

  it("fails a collection with a field named like one every row has", { timeout: SLOW }, () => {
    const repo = makeRepo({ fixtures: ["checklist"] });
    const server = path.join(repo, "checklist/server.ts");
    const text = fs.readFileSync(server, "utf8");
    const clashing = text.replace("done: z.boolean().default(false),", 'done: z.boolean().default(false),\n    createdAt: z.string().default(""),');
    expect(clashing).not.toBe(text);
    fs.writeFileSync(server, clashing);
    const run = hearthApps(["check"], { cwd: repo });
    expect(run.status).toBe(1);
    expect(run.output).toContain('App "checklist": server collection "items": The field "createdAt" has a name every row already has');
  });

  it("fails an app without a README or a package.json, a type error and a lint error, all in one run", { timeout: SLOW }, () => {
    const repo = makeRepo({ fixtures: ["checklist", "feed"] });
    fs.rmSync(path.join(repo, "feed/README.md"));
    fs.rmSync(path.join(repo, "feed/package.json"));
    const widget = path.join(repo, "feed/widget.tsx");
    fs.writeFileSync(widget, fs.readFileSync(widget, "utf8").replace("size={28}", 'size="large"'));
    fs.appendFileSync(path.join(repo, "checklist/widget.tsx"), "\nexport const saved = localStorage.getItem(\"checklist\");\n");

    const run = hearthApps(["check"], { cwd: repo });
    expect(run.status).toBe(1);
    expect(run.output).toContain("feed has no README.md.");
    expect(run.output).toContain("feed has no package.json.");
    expect(run.output).toMatch(/feed\/widget\.tsx\(\d+,\d+\): error TS2322/);
    expect(run.output).toContain("Unexpected use of 'localStorage'.");
    expect(run.output).toContain("failed (required files, types, lint)");
  });

  it("does not let a comment switch a lint rule off", { timeout: SLOW }, () => {
    const repo = makeRepo({ fixtures: ["feed"] });
    fs.appendFileSync(path.join(repo, "feed/widget.tsx"), "\n// eslint-disable-next-line no-restricted-globals\nexport const load = () => fetch(\"/api/session\");\n");
    const run = hearthApps(["check"], { cwd: repo });
    expect(run.status).toBe(1);
    expect(run.output).toContain("Unexpected use of 'fetch'.");
    expect(run.output).toContain("failed (lint)");
  });

  it("stops at what sync refuses, with sync's status", () => {
    const behind = makeRepo({ sdk: "^0.9.0", fixtures: ["feed"] });
    expect(hearthApps(["check"], { cwd: behind })).toMatchObject({ status: 3, output: expect.stringContaining("^0.9.0") });

    const foreign = makeRepo({ files: { ...appFiles("notes"), "notes/widget.tsx": 'import "left-pad";\nexport default null;\n' } });
    expect(hearthApps(["check"], { cwd: foreign })).toMatchObject({ status: 1, output: expect.stringContaining('"left-pad" is neither') });
  });

  it("says that tests were not run, rather than nothing", { timeout: SLOW }, () => {
    const repo = makeRepo({ files: { ...appFiles("notes"), "notes/notes.test.ts": "export {};\n" } });
    const run = hearthApps(["check"], { cwd: repo });
    expect(run.status).toBe(0);
    expect(run.output).toContain('have test files. They were not run: "hearth-apps test" is not built yet.');
  });
});

describe("hearth-apps", () => {
  it("says what it can do, and ends with status 2 for what it cannot", () => {
    expect(hearthApps([])).toMatchObject({ status: 2, output: expect.stringContaining("Usage: hearth-apps <command>") });
    expect(hearthApps(["publish"])).toMatchObject({ status: 2, output: expect.stringContaining('there is no command "publish"') });
    for (const command of ["dev", "test", "new"]) {
      expect(hearthApps([command])).toMatchObject({ status: 2, output: expect.stringContaining(`hearth-apps ${command} is not built yet`) });
    }
  });
});
