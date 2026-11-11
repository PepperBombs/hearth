/**
 * "A mini-app uses only the SDK" as ESLint reports it: in an editor and in
 * a pull request, before the build's own scan would refuse the same thing.
 */
import path from "node:path";
import { ESLint } from "eslint";
import { afterEach, describe, expect, it } from "vitest";
import { appFiles, makeRepo, removeTempDirs, write } from "./test-repos";

afterEach(removeTempDirs);

/** What ESLint reports for a file, as "rule line: message". */
const found = (results: ESLint.LintResult[], file: string) =>
  (results.find((result) => result.filePath === file)?.messages ?? []).map(
    (message) => `${message.ruleId} ${message.line}: ${message.message}`,
  );

describe("@hearth/sdk/eslint, the configuration of a mini-apps repository", () => {
  it("passes an app that keeps to the SDK", { timeout: 60_000 }, async () => {
    const repo = makeRepo({ fixtures: ["checklist", "feed"] });
    const results = await new ESLint({ cwd: repo }).lintFiles(["."]);
    expect(results.length).toBeGreaterThan(4);
    expect(results.flatMap((result) => result.messages)).toEqual([]);
  });

  it("reports what the import scan refuses, where it is written", { timeout: 60_000 }, async () => {
    const repo = makeRepo({ fixtures: ["checklist"] });
    write(repo, {
      "checklist/widget.tsx":
        'import { Icon } from "@hearth/sdk/web";\nimport fs from "node:fs";\nimport server from "./server";\nexport default function Widget() {\n  return <Icon name="star" label={String([fs, server])} />;\n}\n',
    });
    const results = await new ESLint({ cwd: repo }).lintFiles(["."]);
    expect(found(results, path.join(repo, "checklist/widget.tsx"))).toEqual([
      expect.stringMatching(/^hearth\/mini-app-imports 2: A mini-app may only import its own files and the SDK .*"node:fs" is neither\.$/),
      expect.stringMatching(/^hearth\/mini-app-imports 3: "\.\/server" must be imported with "import type" here: widget\.tsx is part of what the browser loads/),
    ]);
    // The files that are fine say nothing, and each finding is reported once, in its own file.
    expect(results.filter((result) => result.messages.length > 0)).toHaveLength(1);
  });

  it("judges the text being typed, not what was last saved", { timeout: 60_000 }, async () => {
    const repo = makeRepo({ files: appFiles("notes") });
    const [result] = await new ESLint({ cwd: repo }).lintText('import dayjs from "dayjs";\nexport default function Widget() {\n  return dayjs;\n}\n', {
      filePath: path.join(repo, "notes/widget.tsx"),
    });
    expect(result?.messages.map((message) => [message.ruleId, message.line, message.column])).toEqual([["hearth/mini-app-imports", 1, 19]]);
  });

  it("keeps an app's hands off the globals that reach outside, and ignores a comment that says otherwise", { timeout: 60_000 }, async () => {
    const repo = makeRepo({ files: appFiles("notes") });
    write(repo, {
      "notes/widget.tsx": [
        "/* eslint-disable no-restricted-globals */",
        'export const a = fetch("https://example.com");',
        "export const b = process.env.HOME;",
        'export const c = localStorage.getItem("notes");',
        'export const d = eval("1");',
        'export const e = new Function("return 1");',
        "export default function Widget() {",
        "  return null;",
        "}",
        "",
      ].join("\n"),
    });
    const results = await new ESLint({ cwd: repo }).lintFiles(["."]);
    const messages = found(results, path.join(repo, "notes/widget.tsx"));
    for (const [line, name] of [
      [2, "fetch"],
      [3, "process"],
      [4, "localStorage"],
      [5, "eval"],
      [6, "Function"],
    ] as const) {
      expect(messages).toContainEqual(expect.stringMatching(new RegExp(`^no-restricted-globals ${line}: Unexpected use of '${name}'\\.`)));
    }
    // The comment is reported as having no effect, instead of being obeyed.
    expect(messages).toContainEqual(expect.stringMatching(/^null 1: .*has no effect because you have 'noInlineConfig'/));
  });

  it("holds only apps to the rule: a file directly in the repository is not one", { timeout: 60_000 }, async () => {
    const repo = makeRepo({ files: { ...appFiles("notes"), "tools.js": 'import fs from "node:fs";\nexport default fs;\n' } });
    const results = await new ESLint({ cwd: repo }).lintFiles(["."]);
    expect(results.flatMap((result) => result.messages)).toEqual([]);
  });
});

describe("miniAppBoundary, for a repository that keeps its apps in a folder of their own", () => {
  it("finds the apps from the configuration file's place, wherever ESLint is run", { timeout: 60_000 }, async () => {
    // As the framework does for packages/fixture-apps.
    const repo = makeRepo({
      files: {
        "eslint.config.js":
          'import { miniAppBoundary } from "@hearth/sdk/eslint";\nexport default miniAppBoundary({ roots: ["samples/apps"], base: import.meta.dirname });\n',
        "samples/apps/notes/widget.js": 'import fs from "node:fs";\nexport default () => fs;\n',
        "samples/other.js": 'import fs from "node:fs";\nexport default fs;\n',
      },
    });
    for (const cwd of [repo, path.join(repo, "samples/apps/notes")]) {
      const results = await new ESLint({ cwd }).lintFiles(["."]);
      expect(found(results, path.join(repo, "samples/apps/notes/widget.js"))).toEqual([
        expect.stringMatching(/^hearth\/mini-app-imports 1: .*"node:fs" is neither/),
      ]);
      expect(results.filter((result) => result.messages.length > 0)).toHaveLength(1);
    }
  });
});
