/**
 * `hearth-apps new`: a new app made as a copy of the sample checklist, and
 * everything it refuses. That the copy passes `hearth-apps check` untouched,
 * which runs the compiler, ESLint and the app's own tests, is in
 * cli.test.ts, as the command is run.
 *
 * Nothing here writes into this checkout: every app is made in a mini-apps
 * repository made up in a temporary folder.
 */
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SDK_VERSION } from "../src/index";
import { TEMPLATE, makeApp, newApp, packageName, readmeOf } from "./new.mjs";
import { AppsError, EXIT_PROBLEMS, EXIT_SDK_VERSION, findApps } from "./sync.mjs";
import { FIXTURES, ROOT, makeRepo, removeTempDirs, tempDir, write } from "./test-repos";

afterEach(removeTempDirs);

const CHECKLIST = path.join(ROOT, TEMPLATE);

/** Runs the command's work as `hearth-apps new <id>` does, and returns its status and what it said. */
function run(id: string, appsDirs: string[], template?: string) {
  const lines: string[] = [];
  const status = newApp({ id, appsDirs, root: ROOT, template, log: (line) => lines.push(line) });
  return { status, output: lines.join("\n") };
}

/** What a folder holds at its top, hidden names included. */
const listing = (dir: string) => fs.readdirSync(dir).sort();

/** Every file below a folder, by path inside it with "/" between folders, and what it holds. */
function tree(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const entry of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const file = path.join(entry.parentPath, entry.name);
    files[path.relative(dir, file).split(path.sep).join("/")] = fs.readFileSync(file, "utf8");
  }
  return files;
}

/** The lines two texts of the same number of lines differ in, as [before, after]. */
function changedLines(before = "", after = ""): [string, string][] {
  const old = before.split("\n");
  const now = after.split("\n");
  expect(now).toHaveLength(old.length);
  return old.flatMap((line, index): [string, string][] => (line === now[index] ? [] : [[line, now[index] ?? ""]]));
}

/** A copy of the checklist in a temporary folder, changed by `edit`. */
function changedTemplate(edit: (dir: string) => void): string {
  const dir = path.join(tempDir(), "checklist");
  fs.cpSync(CHECKLIST, dir, { recursive: true });
  edit(dir);
  return dir;
}

const replaceIn = (file: string, from: string, to: string) => {
  const text = fs.readFileSync(file, "utf8");
  expect(text).toContain(from);
  fs.writeFileSync(file, text.replace(from, to));
};

describe("a new app", () => {
  it("is the checklist in a folder named after its ID, with only what names the app changed", () => {
    const repo = makeRepo();
    const before = listing(repo);
    const made = run("stocks", [repo]);
    expect(made.status).toBe(0);

    const dir = path.join(repo, "stocks");
    // The app and nothing else: no folder it was written in is left behind.
    expect(listing(repo)).toEqual([...before, "stocks"].sort());
    const copy = tree(dir);
    const template = tree(CHECKLIST);
    expect(Object.keys(copy).sort()).toEqual(
      Object.keys(template)
        .map((file) => (file === "checklist.test.ts" ? "stocks.test.ts" : file))
        .sort(),
    );

    // Its server file, widget and page are the checklist's as they are.
    for (const file of ["server.ts", "widget.tsx", "page.tsx"]) expect(copy[file], file).toBe(template[file]);
    // The manifest and the tests differ in the one line that names the app.
    expect(changedLines(template["manifest.ts"], copy["manifest.ts"])).toEqual([['  id: "checklist",', '  id: "stocks",']]);
    expect(changedLines(template["checklist.test.ts"], copy["stocks.test.ts"])).toEqual([
      ['describe("checklist", () => {', 'describe("stocks", () => {'],
    ]);
    // Its package is named after the repository, and still declares nothing.
    expect(JSON.parse(copy["package.json"] ?? "")).toEqual({ ...JSON.parse(template["package.json"] ?? ""), name: "@sample-stones/stocks" });
    expect(copy["README.md"]).toBe(readmeOf("stocks"));

    expect(made.output).toContain(
      `made the mini-app "stocks" in ${dir}, a copy of the sample checklist: README.md, manifest.ts, package.json, page.tsx, server.ts, stocks.test.ts, widget.tsx.`,
    );
    // sync takes it for an app with a page and a server file.
    expect(findApps([repo], ROOT).apps).toMatchObject([{ id: "stocks", dir, hasPage: true, hasServer: true }]);
  });

  it("has a README that names each of its files and says what to change first", () => {
    const repo = makeRepo();
    expect(run("grocery", [repo]).status).toBe(0);
    const dir = path.join(repo, "grocery");
    const readme = fs.readFileSync(path.join(dir, "README.md"), "utf8");
    expect(readme.startsWith("# grocery\n\nA new mini-app, made with `hearth-apps new grocery` as a copy of the\nchecklist")).toBe(true);
    for (const file of fs.readdirSync(dir)) expect(readme).toContain(`\`${file}\``);
    expect(readme).toContain("every text in English and in Simplified\n   Chinese. The `id` stays: it is this folder's name.");
  });

  it("goes beside the apps a folder already has, which stay as they were", () => {
    const repo = makeRepo({ fixtures: ["checklist", "feed"] });
    const feed = tree(path.join(repo, "feed"));
    expect(run("notes", [repo]).status).toBe(0);
    expect(findApps([repo], ROOT).apps.map((app) => app.id)).toEqual(["checklist", "feed", "notes"]);
    expect(tree(path.join(repo, "feed"))).toEqual(feed);
    expect(tree(path.join(repo, "checklist"))).toEqual(tree(CHECKLIST));
  });

  it("names its package after the repository, as @hearth-stones/grocery, or after itself alone", () => {
    expect(packageName("hearth-stones", "grocery")).toBe("@hearth-stones/grocery");
    expect(packageName("@hearth/fixture-apps", "notes")).toBe("@fixture-apps/notes");
    expect(packageName(undefined, "notes")).toBe("notes");
    expect(packageName("My Stones", "notes")).toBe("notes");
    expect(packageName(42, "notes")).toBe("notes");

    const repo = makeRepo();
    fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ private: true, hearth: { sdk: `^${SDK_VERSION}` } }));
    expect(run("notes", [repo]).status).toBe(0);
    expect(JSON.parse(fs.readFileSync(path.join(repo, "notes/package.json"), "utf8")).name).toBe("notes");
  });
});

describe("hearth-apps new refuses, and writes nothing,", () => {
  it("for an ID that cannot name an app's folder", () => {
    const repo = makeRepo();
    const before = listing(repo);
    for (const id of ["Stocks", "s", "1st", "-stocks", "my_app", "my app", "../stocks", "stocks/notes", "", "a".repeat(32)]) {
      const refused = run(id, [repo]);
      expect(refused.status, id).toBe(EXIT_PROBLEMS);
      expect(refused.output).toContain(`${JSON.stringify(id)} cannot be the ID of a mini-app: an ID is 2 to 31 lower-case letters`);
    }
    expect(listing(repo)).toEqual(before);
    expect(run("a".repeat(31), [repo]).status).toBe(0);
  });

  it("for a name that is taken: an app, a folder, a file or a link, even one that leads nowhere", () => {
    const repo = makeRepo({ fixtures: ["feed"], files: { "notes/todo.md": "Buy milk.\n", diary: "A file, not a folder.\n" } });
    fs.symlinkSync(path.join(tempDir(), "gone"), path.join(repo, "linked"));
    const before = listing(repo);
    for (const id of ["feed", "notes", "diary", "linked"]) {
      const refused = run(id, [repo]);
      expect(refused.status, id).toBe(EXIT_PROBLEMS);
      expect(refused.output).toContain(`${path.join(repo, id)} exists already, and hearth-apps new overwrites nothing.`);
    }
    expect(listing(repo)).toEqual(before);
    expect(tree(path.join(repo, "notes"))).toEqual({ "todo.md": "Buy milk.\n" });
    expect(tree(path.join(repo, "feed"))).toEqual(tree(path.join(FIXTURES, "feed")));
  });

  it("when HEARTH_APPS_DIR names more than one folder", () => {
    const first = makeRepo();
    const second = makeRepo();
    expect(run("stocks", [first, second])).toEqual({
      status: EXIT_PROBLEMS,
      output: [
        "hearth-apps new: no app was made.",
        "  - A new app goes into one folder, and HEARTH_APPS_DIR names 2. Name only that one, or run the command in it with the variable unset.",
      ].join("\n"),
    });
    expect(fs.existsSync(path.join(first, "stocks"))).toBe(false);
    expect(fs.existsSync(path.join(second, "stocks"))).toBe(false);
  });

  it("in a folder sync would not take apps from, with sync's own status", () => {
    const file = path.join(tempDir(), "stones.txt");
    fs.writeFileSync(file, "Not a folder.\n");
    const cases = [
      { folder: path.join(tempDir(), "hearth-stones"), status: EXIT_PROBLEMS, says: "hearth-stones does not exist." },
      { folder: file, status: EXIT_PROBLEMS, says: "stones.txt is not a folder." },
      { folder: tempDir(), status: EXIT_PROBLEMS, says: "has no package.json, so it is not a folder of mini-apps." },
      { folder: makeRepo({ sdk: null }), status: EXIT_PROBLEMS, says: "must say which SDK version the apps were written for, as a caret range" },
      { folder: makeRepo({ sdk: SDK_VERSION }), status: EXIT_PROBLEMS, says: `It has "${SDK_VERSION}".` },
      { folder: makeRepo({ link: null }), status: EXIT_PROBLEMS, says: "has no @hearth/sdk to build against." },
      { folder: makeRepo({ link: tempDir() }), status: EXIT_PROBLEMS, says: "not to the SDK of this checkout" },
      {
        folder: makeRepo({ sdk: "^0.9.0" }),
        status: EXIT_SDK_VERSION,
        says: `were written for @hearth/sdk ^0.9.0 ("hearth.sdk" in its package.json), but this checkout of hearth holds @hearth/sdk ${SDK_VERSION}.`,
      },
    ];
    for (const { folder, status, says } of cases) {
      const before = fs.statSync(folder, { throwIfNoEntry: false })?.isDirectory() ? listing(folder) : null;
      const refused = run("stocks", [folder]);
      expect(refused.output).toContain(says);
      expect(refused.status, says).toBe(status);
      if (before) expect(listing(folder)).toEqual(before);
    }
  });

  it("in the hearth checkout itself, however it is reached", () => {
    // A made-up checkout, so that nothing could be written into this one.
    const root = tempDir();
    const linked = path.join(tempDir(), "hearth");
    fs.symlinkSync(root, linked, "dir");
    for (const folder of [root, linked]) {
      let refusal: unknown;
      try {
        makeApp({ id: "stocks", folder, root, template: CHECKLIST });
      } catch (error) {
        refusal = error;
      }
      expect(refusal).toBeInstanceOf(AppsError);
      expect((refusal as AppsError).problems).toEqual([
        `${folder} is the hearth checkout itself. A new app goes into a folder of mini-apps, such as hearth-stones beside it: run "pnpm new stocks" there.`,
      ]);
    }
    expect(listing(root)).toEqual([]);
  });

  it("when the template no longer holds what it changes", () => {
    const repo = makeRepo();
    const before = listing(repo);
    const cases = [
      {
        template: changedTemplate((dir) => replaceIn(path.join(dir, "manifest.ts"), 'id: "checklist",', "id: 'checklist',")),
        says: 'its manifest.ts does not hold `id: "checklist",` exactly once.',
      },
      {
        template: changedTemplate((dir) => fs.appendFileSync(path.join(dir, "manifest.ts"), '// It used to say id: "checklist",\n')),
        says: 'its manifest.ts does not hold `id: "checklist",` exactly once.',
      },
      {
        template: changedTemplate((dir) => replaceIn(path.join(dir, "checklist.test.ts"), 'describe("checklist",', 'describe("the checklist",')),
        says: 'its checklist.test.ts does not hold `describe("checklist",` exactly once.',
      },
      { template: changedTemplate((dir) => fs.rmSync(path.join(dir, "checklist.test.ts"))), says: "it has no checklist.test.ts." },
      { template: changedTemplate((dir) => fs.rmSync(path.join(dir, "package.json"))), says: "it has no package.json." },
      { template: changedTemplate((dir) => fs.writeFileSync(path.join(dir, "package.json"), "[]\n")), says: "its package.json is not an object." },
      { template: changedTemplate((dir) => fs.writeFileSync(path.join(dir, "package.json"), "{\n")), says: "its package.json is not valid JSON." },
      {
        template: changedTemplate((dir) => write(dir, { "stocks.test.ts": "export {};\n" })),
        says: "two of its files would both be stocks.test.ts in the copy.",
      },
      { template: path.join(tempDir(), "checklist"), says: "it is not there." },
    ];
    for (const { template, says } of cases) {
      const refused = run("stocks", [repo], template);
      expect(refused.output).toContain(`The template ${template} cannot be copied: ${says} That is a fault of the hearth checkout`);
      expect(refused.status, says).toBe(EXIT_PROBLEMS);
    }
    expect(listing(repo)).toEqual(before);
  });

  it("when a file cannot be written, leaving nothing behind", () => {
    // The longest ID makes this file's name too long for the file system,
    // after the files before it were written.
    const template = changedTemplate((dir) => write(dir, { [`checklist.${"x".repeat(230)}.ts`]: "export {};\n" }));
    const repo = makeRepo();
    const before = listing(repo);
    expect(() => run("a".repeat(31), [repo], template)).toThrow(/ENAMETOOLONG/);
    expect(listing(repo)).toEqual(before);
  });
});
