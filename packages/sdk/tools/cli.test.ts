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
import { BIN, FIXTURES, ROOT, SDK_DIR, appFiles, makeRepo, printed, removeTempDirs, setUpStones, tempDir, write } from "./test-repos";

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
  return { status: result.status, output: printed(result), out };
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

  it("keeps status 3 through pnpm build, where the deploy reads it", () => {
    // deploy/hearth-deploy.sh tells a version that does not fit from every
    // other failure by the status of `pnpm build`, whose first step is sync.
    const scripts = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).scripts;
    expect(scripts.build).toMatch(/^pnpm apps:sync && /);

    const out = tempDir();
    const env = { ...process.env, HEARTH_APPS_DIR: makeRepo({ sdk: "^0.9.0", fixtures: ["feed"] }) };
    const result = spawnSync("pnpm", ["apps:sync", "--out", out], { cwd: ROOT, env, encoding: "utf8" });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(3);
    expect(fs.readdirSync(out)).toEqual([]);
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
    // The checklist's own tests cannot start it either.
    expect(run.output).toContain("testApp: the server would not start with this app:");
    expect(run.output).toContain("failed (manifests and server files, tests)");
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
    // The compiler writes "file(line,col): error" plainly, and "file:line:col - error"
    // where colour is on (as for a person at a terminal).
    expect(run.output).toMatch(/feed\/widget\.tsx(\(\d+,\d+\):| ?:\d+:\d+ -) error TS2322/);
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

  it("runs the apps' tests last, and fails when one fails", { timeout: SLOW }, () => {
    const repo = makeRepo({ fixtures: ["checklist", "feed"] });
    const passed = hearthApps(["check"], { cwd: repo });
    expect(passed.output).toContain("running the tests of 1 mini-app (checklist)");
    expect(passed.output).toContain("2 mini-apps passed (checklist, feed)");
    expect(passed.status).toBe(0);

    write(repo, { "checklist/wrong.test.ts": FAILING_TEST });
    const failed = hearthApps(["check"], { cwd: repo });
    expect(failed.output).toContain("wrong.test.ts > counts wrongly");
    expect(failed.output).toContain("failed (tests)");
    expect(failed.status).toBe(1);
  });
});

/** A test that fails, in an app's folder. */
const FAILING_TEST = 'import { expect, it } from "vitest";\n\nit("counts wrongly", () => {\n  expect(1 + 1).toBe(3);\n});\n';
/** A test that passes and needs no server file. */
const PASSING_TEST = 'import { expect, it } from "vitest";\n\nit("counts", () => {\n  expect(1 + 1).toBe(2);\n});\n';

describe("hearth-apps test", () => {
  it("runs the apps' tests against the framework's own store, from a repository beside it", { timeout: SLOW }, () => {
    // The checklist's tests call its routes with testApp from @hearth/sdk/testing.
    const repo = makeRepo({ fixtures: ["checklist", "feed"] });
    const run = hearthApps(["test"], { cwd: repo });
    expect(run.output).toContain("running the tests of 1 mini-app (checklist)");
    expect(run.output).toMatch(/Test Files\s+1 passed \(1\)/);
    expect(run.output).toContain("the tests of checklist passed");
    expect(run.status).toBe(0);
    // It writes nothing.
    expect(wroteNothing(run)).toBe(true);
  });

  it("ends with status 1 when a test fails, naming the test", { timeout: SLOW }, () => {
    const repo = makeRepo({ fixtures: ["checklist"], files: { "checklist/wrong.test.ts": FAILING_TEST } });
    const run = hearthApps(["test"], { cwd: repo });
    expect(run.status).toBe(1);
    expect(run.output).toContain("wrong.test.ts > counts wrongly");
    expect(run.output).toContain("expected 2 to be 3");
    expect(run.output).toContain("hearth-apps test: failed.");
  });

  it("finds the test files anywhere in an app's folder, except where the import scan does not look", { timeout: SLOW }, () => {
    const repo = makeRepo({
      files: {
        ...appFiles("notes"),
        "notes/parts/sum.test.ts": PASSING_TEST,
        "notes/.drafts/wrong.test.ts": FAILING_TEST,
        "notes/node_modules/wrong.test.ts": FAILING_TEST,
        // Not an app: no manifest.ts.
        "scripts/wrong.test.ts": FAILING_TEST,
      },
    });
    const run = hearthApps(["test"], { cwd: repo });
    expect(run.output).toMatch(/Test Files\s+1 passed \(1\)/);
    expect(run.status).toBe(0);
  });

  it("runs the tests of every folder HEARTH_APPS_DIR names, in one run", { timeout: SLOW }, () => {
    const first = makeRepo({ files: { ...appFiles("notes"), "notes/notes.test.ts": PASSING_TEST } });
    const second = makeRepo({ files: { ...appFiles("diary"), "diary/diary.test.ts": PASSING_TEST } });
    const run = hearthApps(["test"], { appsDir: [first, second].join(path.delimiter) });
    expect(run.output).toContain("running the tests of 2 mini-apps (notes, diary)");
    expect(run.output).toMatch(/Test Files\s+2 passed \(2\)/);
    expect(run.status).toBe(0);
  });

  it("says when there is nothing to test", () => {
    expect(hearthApps(["test"], { cwd: tempDir() })).toMatchObject({ status: 0, output: expect.stringContaining("no mini-apps to test") });
    const untested = makeRepo({ fixtures: ["feed"] });
    expect(hearthApps(["test"], { cwd: untested })).toMatchObject({
      status: 0,
      output: expect.stringContaining("none of the mini-apps has tests"),
    });
  });

  it("does not run the tests of apps a build would refuse, and keeps sync's status", () => {
    const behind = makeRepo({ sdk: "^0.9.0", fixtures: ["checklist"] });
    const late = hearthApps(["test"], { cwd: behind });
    expect(late).toMatchObject({ status: 3, output: expect.stringContaining("their tests were not run") });
    expect(late.output).not.toContain("RUN");

    const foreign = makeRepo({ files: { ...appFiles("notes"), "notes/notes.test.ts": 'import fs from "node:fs";\nexport default fs;\n' } });
    expect(hearthApps(["test"], { cwd: foreign })).toMatchObject({ status: 1, output: expect.stringContaining('"node:fs" is neither') });
  });
});

describe("hearth-apps new", () => {
  it("makes an app that passes check untouched, where it runs or in the folder HEARTH_APPS_DIR names", { timeout: SLOW }, () => {
    // The Testable line of step 14.
    const repo = makeRepo();
    const here = hearthApps(["new", "stocks"], { cwd: repo });
    expect(here.output).toContain(`made the mini-app "stocks" in ${path.join(repo, "stocks")}, a copy of the sample checklist`);
    expect(here.status).toBe(0);
    const named = hearthApps(["new", "notes"], { appsDir: repo });
    expect(named.output).toContain(`made the mini-app "notes" in ${path.join(repo, "notes")}`);
    expect(named.status).toBe(0);

    const checked = hearthApps(["check"], { cwd: repo });
    expect(checked.output).toContain("running the tests of 2 mini-apps (notes, stocks)");
    expect(checked.output).toContain("2 mini-apps passed (notes, stocks)");
    expect(checked.status).toBe(0);
  });

  it("takes exactly one ID, one that can name an app's folder and is not taken", () => {
    const repo = makeRepo({ fixtures: ["feed"] });
    const before = fs.readdirSync(repo).sort();
    for (const args of [["new"], ["new", "notes", "diary"]]) {
      expect(hearthApps(args, { cwd: repo })).toMatchObject({ status: 2, output: expect.stringContaining("new <id>  Make a new app") });
    }
    expect(hearthApps(["new", "Notes"], { cwd: repo })).toMatchObject({
      status: 1,
      output: expect.stringContaining('"Notes" cannot be the ID of a mini-app'),
    });
    expect(hearthApps(["new", "feed"], { cwd: repo })).toMatchObject({
      status: 1,
      output: expect.stringContaining(`${path.join(repo, "feed")} exists already, and hearth-apps new overwrites nothing.`),
    });
    expect(fs.readdirSync(repo).sort()).toEqual(before);
  });

  it("ends with status 3 in a folder written for another SDK version, and makes nothing", () => {
    const repo = makeRepo({ sdk: "^0.9.0" });
    expect(hearthApps(["new", "stocks"], { cwd: repo })).toMatchObject({
      status: 3,
      output: expect.stringContaining("were written for @hearth/sdk ^0.9.0"),
    });
    expect(fs.existsSync(path.join(repo, "stocks"))).toBe(false);
  });
});

describe("hearth-apps dev", () => {
  /** Runs the command without --out, which dev does not take. */
  const devIn = (cwd: string) => {
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.HEARTH_APPS_DIR;
    const result = spawnSync(process.execPath, [BIN, "dev"], { cwd, env, encoding: "utf8", timeout: 30_000 });
    return { status: result.status, output: printed(result) };
  };

  it("refuses what a build refuses, with sync's status, and starts nothing", () => {
    const behind = devIn(makeRepo({ sdk: "^0.9.0", fixtures: ["feed"] }));
    expect(behind.status).toBe(3);
    expect(behind.output).toContain("hearth-apps dev: the mini-apps cannot be built in. Nothing was started.");
    expect(behind.output).toContain("^0.9.0");

    const foreign = devIn(makeRepo({ files: { ...appFiles("notes"), "notes/widget.tsx": 'import "left-pad";\nexport default null;\n' } }));
    expect(foreign).toMatchObject({ status: 1, output: expect.stringContaining('"left-pad" is neither') });
  });

  it("does not take --out: the dev servers read the lists where a build writes them", () => {
    expect(hearthApps(["dev"], { cwd: makeRepo() })).toMatchObject({ status: 2, output: expect.stringContaining("--out does not apply") });
  });
});

describe("a mini-apps repository set up as hearth-stones is", () => {
  // Beside this checkout, as `setUpStones` makes it. Its `pnpm dev` is in
  // dev.test.ts, beside a stand-in for this checkout: the real one would
  // start the dev servers on their fixed ports.

  it("links the SDK beside it offline, and passes pnpm check with no apps and with one", { timeout: SLOW }, () => {
    const { stones, pnpm } = setUpStones();
    const out = tempDir();
    expect(fs.realpathSync(path.join(stones, "node_modules/@hearth/sdk"))).toBe(fs.realpathSync(SDK_DIR));
    expect(fs.existsSync(path.join(stones, "node_modules/.bin/hearth-apps"))).toBe(true);

    // The Testable line of step 13. --out keeps this checkout's lists as they are.
    const empty = pnpm(["check", "--out", out]);
    expect(empty.output).toContain("no mini-apps to check");
    expect(empty.status).toBe(0);
    expect(pnpm(["test"])).toMatchObject({ status: 0, output: expect.stringContaining("no mini-apps to test") });

    fs.cpSync(path.join(FIXTURES, "checklist"), path.join(stones, "checklist"), { recursive: true });
    const one = pnpm(["check", "--out", out]);
    expect(one.output).toContain("the tests of checklist passed");
    expect(one.output).toContain("1 mini-app passed (checklist)");
    expect(one.status).toBe(0);
  });

  it("makes a new app with pnpm new, which passes pnpm check untouched", { timeout: SLOW }, () => {
    // The Testable line of step 14, as A9 of the contract writes the two commands.
    const { stones, pnpm } = setUpStones();
    const made = pnpm(["new", "stocks"]);
    expect(made.output).toContain(`made the mini-app "stocks" in ${path.join(stones, "stocks")}`);
    expect(made.status).toBe(0);
    expect(JSON.parse(fs.readFileSync(path.join(stones, "stocks/package.json"), "utf8")).name).toBe("@sample-stones/stocks");

    const checked = pnpm(["check", "--out", tempDir()]);
    expect(checked.output).toContain("the tests of stocks passed");
    expect(checked.output).toContain("1 mini-app passed (stocks)");
    expect(checked.status).toBe(0);
  });
});

describe("hearth-apps", () => {
  it("says what it can do, and ends with status 2 for what it cannot", () => {
    expect(hearthApps([])).toMatchObject({ status: 2, output: expect.stringContaining("Usage: hearth-apps <command>") });
    expect(hearthApps(["publish"])).toMatchObject({ status: 2, output: expect.stringContaining('there is no command "publish"') });
    expect(hearthApps(["help"])).toMatchObject({ status: 0, output: expect.stringContaining("new <id>  Make a new app") });
  });
});
