import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { APP_ID_PATTERN, SDK_VERSION } from "../src/index";
import {
  APP_FOLDER_PATTERN,
  AppsError,
  EXIT_PROBLEMS,
  EXIT_SDK_VERSION,
  GENERATED,
  findApps,
  fitsCaretRange,
  readAppsDirs,
  sync,
} from "./sync.mjs";
import { FIXTURES, ROOT, appFiles, makeRepo, removeTempDirs, tempDir, write } from "./test-repos";

afterEach(removeTempDirs);

/** Runs sync into a temporary folder and returns what it wrote, by the names in GENERATED. */
function synced(appsDirs: string[], out = tempDir()) {
  const result = sync({ appsDirs, root: ROOT, out });
  const read = (file: string) => fs.readFileSync(file, "utf8");
  return { ...result, out, server: read(result.files.server), web: read(result.files.web), css: read(result.files.css) };
}

/** The error sync ends with; fails if it ends well. */
function failure(appsDirs: string[]): AppsError {
  try {
    findApps(appsDirs, ROOT);
  } catch (error) {
    if (error instanceof AppsError) return error;
    throw error;
  }
  throw new Error("sync accepted these folders.");
}

/** The lines of a generated file that are not comments or empty. */
const code = (text: string) => text.split("\n").filter((line) => line !== "" && !line.startsWith("//") && !line.startsWith("/*"));

describe("the generated files with no apps", () => {
  it("say so when no folder is named", () => {
    const { apps, notices, server, web, css } = synced([]);
    expect(apps).toEqual([]);
    expect(notices).toEqual(["HEARTH_APPS_DIR names no folder: building without mini-apps."]);
    expect(code(server)).toEqual(["export const apps = [];"]);
    expect(code(web)).toEqual(["export const apps = [];"]);
    expect(code(css)).toEqual([]);
  });

  it("are the same when the folder is missing, and when it holds no apps", () => {
    const none = synced([]);
    const missing = path.join(tempDir(), "hearth-stones");
    const absent = synced([missing]);
    expect(absent.notices).toEqual([`${missing} does not exist: no mini-apps from there.`]);

    // A checkout with a README and a folder that is not an app, as hearth-stones starts out.
    const empty = tempDir();
    write(empty, { "README.md": "# Stones\n", "docs/notes.md": "Nothing yet.\n", ".github/workflows/ci.yml": "name: CI\n" });
    const bare = synced([empty]);
    expect(bare.notices).toEqual([`${empty} holds no mini-apps (no folder with a manifest.ts).`]);

    for (const result of [absent, bare]) {
      expect(result.apps).toEqual([]);
      expect(result.server).toBe(none.server);
      expect(result.web).toBe(none.web);
      expect(result.css).toBe(none.css);
    }
  });

  it("asks nothing of a folder without apps: no package.json, no link to the SDK", () => {
    const empty = tempDir();
    write(empty, { "package.json": "not even JSON" });
    expect(synced([empty]).apps).toEqual([]);
  });
});

describe("the generated files with the framework's sample apps", () => {
  it("list each app with its manifest, its server file and its page when it has them, and its widget", () => {
    const { apps, notices, out, server, web, css, files } = synced([FIXTURES]);
    expect(notices).toEqual([]);
    expect(apps.map((app) => [app.id, app.hasServer, app.hasPage])).toEqual([
      ["checklist", true, true],
      ["feed", false, false],
      ["headlines", true, false],
    ]);

    const from = (file: string, target: string) => JSON.stringify(path.relative(path.dirname(file), path.join(FIXTURES, target)));
    expect(code(server)).toEqual([
      `import manifest0 from ${from(files.server, "checklist/manifest.ts")};`,
      `import server0 from ${from(files.server, "checklist/server.ts")};`,
      `import manifest1 from ${from(files.server, "feed/manifest.ts")};`,
      `import manifest2 from ${from(files.server, "headlines/manifest.ts")};`,
      `import server2 from ${from(files.server, "headlines/server.ts")};`,
      "export const apps = [",
      '  { id: "checklist", manifest: manifest0, hasPage: true, server: server0 },',
      '  { id: "feed", manifest: manifest1, hasPage: false },',
      '  { id: "headlines", manifest: manifest2, hasPage: false, server: server2 },',
      "];",
    ]);
    expect(code(web)).toEqual([
      `import manifest0 from ${from(files.web, "checklist/manifest.ts")};`,
      `import manifest1 from ${from(files.web, "feed/manifest.ts")};`,
      `import manifest2 from ${from(files.web, "headlines/manifest.ts")};`,
      "export const apps = [",
      "  {",
      '    id: "checklist",',
      "    manifest: manifest0,",
      "    hasPage: true,",
      `    widget: () => import(${from(files.web, "checklist/widget.tsx")}),`,
      `    page: () => import(${from(files.web, "checklist/page.tsx")}),`,
      "  },",
      "  {",
      '    id: "feed",',
      "    manifest: manifest1,",
      "    hasPage: false,",
      `    widget: () => import(${from(files.web, "feed/widget.tsx")}),`,
      "  },",
      "  {",
      '    id: "headlines",',
      "    manifest: manifest2,",
      "    hasPage: false,",
      `    widget: () => import(${from(files.web, "headlines/widget.tsx")}),`,
      "  },",
      "];",
    ]);
    expect(code(css)).toEqual([
      `@source ${from(files.css, "checklist")};`,
      `@source ${from(files.css, "feed")};`,
      `@source ${from(files.css, "headlines")};`,
    ]);
    // The server's code never appears in what the web app is given.
    expect(web).not.toContain("server.ts");
    expect(files).toEqual({
      server: path.join(out, GENERATED.server),
      web: path.join(out, GENERATED.web),
      css: path.join(out, GENERATED.css),
    });
  });

  it("writes into the framework itself, where Git ignores the three files", () => {
    const ignored = fs.readFileSync(path.join(ROOT, ".gitignore"), "utf8").split("\n");
    for (const file of Object.values(GENERATED)) expect(ignored).toContain(file);
  });

  it("names an app's page when it has one", () => {
    const repo = makeRepo({ files: { ...appFiles("notes"), "notes/page.tsx": "export default function Page() {\n  return null;\n}\n" } });
    const { apps, server, web } = synced([repo]);
    expect(apps[0]).toMatchObject({ id: "notes", hasPage: true, hasServer: false });
    expect(server).toContain('{ id: "notes", manifest: manifest0, hasPage: true },');
    expect(code(web)).toContain("    hasPage: true,");
    expect(web).toMatch(/ {4}page: \(\) => import\(".*\/notes\/page\.tsx"\),/);
  });

  it("leaves a file alone that already says the same, so that a watching dev server is not restarted", () => {
    const first = synced([FIXTURES]);
    const old = new Date("2020-01-01T00:00:00Z");
    for (const file of Object.values(first.files)) fs.utimesSync(file, old, old);
    const again = synced([FIXTURES], first.out);
    for (const file of Object.values(again.files)) expect(fs.statSync(file).mtime).toEqual(old);

    // A different list is written.
    const changed = synced([], first.out);
    for (const file of Object.values(changed.files)) expect(fs.statSync(file).mtime).not.toEqual(old);
  });
});

describe("several folders", () => {
  it("takes the apps of every folder, in the order the folders are named", () => {
    const stones = makeRepo({ files: appFiles("notes") });
    const { apps, css } = synced([stones, FIXTURES]);
    expect(apps.map((app) => app.id)).toEqual(["notes", "checklist", "feed", "headlines"]);
    expect(code(css)).toHaveLength(4);
  });

  it("refuses an app that is in two folders, naming both", () => {
    const stones = makeRepo({ fixtures: ["feed"], files: appFiles("notes") });
    const error = failure([FIXTURES, stones]);
    expect(error.exitCode).toBe(EXIT_PROBLEMS);
    expect(error.problems).toEqual([
      `The mini-app "feed" is in two folders: ${FIXTURES} and ${stones}. App IDs must be unique across all apps folders.`,
    ]);
  });

  it("reads HEARTH_APPS_DIR like PATH, a relative folder from the root of the checkout", () => {
    expect(readAppsDirs(undefined, ROOT)).toEqual([]);
    expect(readAppsDirs("  ", ROOT)).toEqual([]);
    expect(readAppsDirs("packages/fixture-apps", ROOT)).toEqual([FIXTURES]);
    expect(readAppsDirs(["/srv/stones", "", " ../other-stones ", "/srv/stones"].join(path.delimiter), ROOT)).toEqual([
      "/srv/stones",
      path.resolve(ROOT, "../other-stones"),
    ]);
  });
});

describe("the handshake", () => {
  it("accepts a folder written for this version of the SDK", () => {
    expect(synced([makeRepo({ files: appFiles("notes") })]).apps.map((app) => app.id)).toEqual(["notes"]);
  });

  it("refuses a folder written for another version, with the status that means exactly that, naming both versions", () => {
    const repo = makeRepo({ sdk: "^9.4.0", files: appFiles("notes") });
    const error = failure([repo]);
    expect(error.exitCode).toBe(EXIT_SDK_VERSION);
    expect(EXIT_SDK_VERSION).toBe(3);
    expect(error.problems).toHaveLength(1);
    expect(error.problems[0]).toContain(`The mini-apps in ${repo} were written for @hearth/sdk ^9.4.0`);
    expect(error.problems[0]).toContain(`this checkout of hearth holds @hearth/sdk ${SDK_VERSION}`);
  });

  it("does not look further into apps written for another version", () => {
    const repo = makeRepo({ sdk: "^9.4.0", files: { ...appFiles("notes"), "notes/widget.tsx": 'import "left-pad";\n' } });
    const error = failure([repo]);
    expect(error.exitCode).toBe(EXIT_SDK_VERSION);
    expect(error.problems).toHaveLength(1);
  });

  it("ends with the general status when something else is wrong as well", () => {
    const behind = makeRepo({ sdk: "^9.4.0", files: appFiles("notes") });
    const broken = makeRepo({ files: { ...appFiles("diary"), "diary/widget.tsx": 'import "left-pad";\nexport default () => null;\n' } });
    const error = failure([behind, broken]);
    expect(error.exitCode).toBe(EXIT_PROBLEMS);
    expect(error.problems).toHaveLength(2);
  });

  it("refuses a folder of apps that does not say which version it was written for", () => {
    const silent = makeRepo({ sdk: null, files: appFiles("notes") });
    expect(failure([silent])).toMatchObject({
      exitCode: EXIT_PROBLEMS,
      problems: [
        `${silent}/package.json must say which SDK version the apps were written for, as a caret range: "hearth": { "sdk": "^${SDK_VERSION}" }. It has none.`,
      ],
    });

    const exact = makeRepo({ sdk: SDK_VERSION, files: appFiles("notes") });
    expect(failure([exact]).problems[0]).toContain(`It has "${SDK_VERSION}".`);

    const bare = tempDir();
    write(bare, appFiles("notes"));
    expect(failure([bare])).toMatchObject({ exitCode: EXIT_PROBLEMS, problems: [expect.stringContaining("has no package.json")] });
  });

  it("refuses a folder whose SDK is missing or is not this checkout's", () => {
    const unlinked = makeRepo({ link: null, files: appFiles("notes") });
    expect(failure([unlinked])).toMatchObject({
      exitCode: EXIT_PROBLEMS,
      problems: [expect.stringMatching(/has no @hearth\/sdk to build against\. Run "pnpm install" there/)],
    });

    const elsewhere = tempDir();
    const astray = makeRepo({ link: elsewhere, files: appFiles("notes") });
    const error = failure([astray]);
    expect(error.exitCode).toBe(EXIT_PROBLEMS);
    expect(error.problems[0]).toContain(`leads to ${elsewhere}, not to the SDK of this checkout`);
  });

  it("reads a caret range as npm does", () => {
    const cases: [version: string, range: string, fits: boolean | null][] = [
      ["0.1.0", "^0.1.0", true],
      ["0.1.7", "^0.1.0", true],
      ["0.1.0", "^0.1.3", false],
      ["0.2.0", "^0.1.0", false],
      ["0.1.0", "^0.2.0", false],
      ["1.0.0", "^0.9.0", false],
      ["0.0.3", "^0.0.3", true],
      ["0.0.4", "^0.0.3", false],
      ["1.4.2", "^1.0.0", true],
      ["1.4.2", "^1.4.2", true],
      ["1.4.2", "^1.5.0", false],
      ["1.4.2", "^1.4.3", false],
      ["2.0.0", "^1.9.9", false],
      ["0.1.0", "0.1.0", null],
      ["0.1.0", "~0.1.0", null],
      ["0.1.0", "^0.1", null],
      ["0.1.0", "*", null],
      ["0.1.0-beta.1", "^0.1.0", null],
    ];
    for (const [version, range, fits] of cases) expect([version, range, fitsCaretRange(version, range)]).toEqual([version, range, fits]);
  });
});

describe("what sync refuses in an app", () => {
  it("a dependency of its own, of any kind", () => {
    const repo = makeRepo({
      files: {
        ...appFiles("notes"),
        "notes/package.json": JSON.stringify({ name: "notes", dependencies: { "left-pad": "^1.0.0", dayjs: "*" }, devDependencies: { vitest: "^5.0.0" } }),
      },
    });
    expect(failure([repo])).toMatchObject({
      exitCode: EXIT_PROBLEMS,
      problems: [
        `${path.basename(repo)}/notes/package.json declares dependencies (left-pad, dayjs). A mini-app has no dependencies of its own: it uses only the SDK.`,
        `${path.basename(repo)}/notes/package.json declares devDependencies (vitest). A mini-app has no dependencies of its own: it uses only the SDK.`,
      ],
    });
  });

  it("a foreign import, with the file and the line", () => {
    const repo = makeRepo({
      files: { ...appFiles("notes"), "notes/widget.tsx": 'import { format } from "date-fns";\nexport default function Widget() {\n  return format;\n}\n' },
    });
    expect(failure([repo])).toMatchObject({
      exitCode: EXIT_PROBLEMS,
      problems: [expect.stringMatching(new RegExp(`^${path.basename(repo)}/notes/widget\\.tsx:1:24: A mini-app may only import its own files and the SDK .*"date-fns" is neither\\.$`))],
    });
  });

  it("the server file imported as a value by the widget", () => {
    const repo = makeRepo({ fixtures: ["checklist"] });
    write(repo, { "checklist/widget.tsx": 'import server from "./server";\nexport default function Widget() {\n  return Object.keys(server.routes).length;\n}\n' });
    expect(failure([repo])).toMatchObject({
      exitCode: EXIT_PROBLEMS,
      problems: [expect.stringMatching(/checklist\/widget\.tsx:1:20: "\.\/server" must be imported with "import type" here/)],
    });
  });

  it("a folder name that cannot be an app's ID", () => {
    for (const name of ["Notes", "n", "my_notes", "2do"]) {
      const repo = makeRepo({ files: appFiles(name) });
      expect(failure([repo])).toMatchObject({
        exitCode: EXIT_PROBLEMS,
        problems: [expect.stringContaining(`"${name}" is not.`)],
      });
    }
    expect(APP_FOLDER_PATTERN.source).toBe(APP_ID_PATTERN.source);
    expect(APP_FOLDER_PATTERN.flags).toBe(APP_ID_PATTERN.flags);
  });

  it("an app without a widget", () => {
    const repo = makeRepo({ files: appFiles("notes") });
    fs.rmSync(path.join(repo, "notes/widget.tsx"));
    expect(failure([repo]).problems).toEqual([expect.stringContaining("notes: has no widget.tsx.")]);
  });

  it("a widget, a page or a server file without the default export the build imports, naming the file", () => {
    const repo = makeRepo({ fixtures: ["checklist"], files: appFiles("notes") });
    write(repo, {
      "notes/widget.tsx": "export function Widget() {\n  return null;\n}\n",
      "notes/page.tsx": "export default interface Page {\n  title: string;\n}\nexport type { Page as Other };\n",
      "checklist/server.ts": fs.readFileSync(path.join(repo, "checklist/server.ts"), "utf8").replace("export default app.routes(", "export const routes = app.routes("),
    });
    const where = path.basename(repo);
    expect(failure([repo]).problems).toEqual([
      expect.stringMatching(new RegExp(`^${where}/checklist/server\\.ts has no default export\\. The build imports it as what defineServer`)),
      expect.stringMatching(new RegExp(`^${where}/notes/widget\\.tsx has no default export\\. The build imports it as the body of the app's card`)),
      expect.stringMatching(new RegExp(`^${where}/notes/page\\.tsx has no default export\\. The build imports it as the app's page`)),
    ]);
  });

  it("a default export in any of the forms that survive compiling", () => {
    const repo = makeRepo({ files: { ...appFiles("notes"), ...appFiles("diary"), ...appFiles("tasks"), ...appFiles("quotes") } });
    write(repo, {
      "notes/widget.tsx": "function Widget() {\n  return null;\n}\nexport { Widget as default };\n",
      "notes/page.tsx": "export default class Page {}\n",
      "diary/widget.tsx": 'export { default } from "./card";\n',
      "diary/card.tsx": "export default () => null;\n",
      "tasks/widget.tsx": "const Widget = () => null;\nexport default Widget;\n",
      "quotes/widget.tsx": 'export * as default from "./card";\n',
      "quotes/card.tsx": "export const x = 1;\n",
    });
    expect(synced([repo]).apps.map((app) => app.id)).toEqual(["diary", "notes", "quotes", "tasks"]);
  });

  it("everything at once, and writes nothing", () => {
    const out = tempDir();
    const before = synced([FIXTURES], out);
    const repo = makeRepo({
      files: {
        ...appFiles("notes"),
        "notes/widget.tsx": 'import "left-pad";\n',
        "notes/package.json": '{ "dependencies": { "left-pad": "1" } }',
        ...appFiles("Diary"),
      },
    });
    let error: unknown;
    try {
      sync({ appsDirs: [repo], root: ROOT, out });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(AppsError);
    // A dependency, the foreign import, the widget without a default export and the folder name.
    expect((error as AppsError).problems).toHaveLength(4);
    expect(fs.readFileSync(before.files.server, "utf8")).toBe(before.server);
    expect(fs.readFileSync(before.files.web, "utf8")).toBe(before.web);
    expect(fs.readFileSync(before.files.css, "utf8")).toBe(before.css);
  });

  it("only what is an app: a folder directly inside, holding a manifest.ts", () => {
    const repo = makeRepo({
      files: {
        ...appFiles("notes"),
        "docs/manifest.md": "Not an app.\n",
        "shared/widget.tsx": 'import "left-pad";\n',
        "notes/drafts/manifest.ts": "export default {};\n",
        "manifest.ts": "export default {};\n",
      },
    });
    expect(synced([repo]).apps.map((app) => app.id)).toEqual(["notes"]);
  });
});
