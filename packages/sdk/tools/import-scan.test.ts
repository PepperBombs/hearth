import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scanApp } from "./import-scan.mjs";
import { FIXTURES, removeTempDirs, tempDir, write } from "./test-repos";

afterEach(removeTempDirs);

const WIDGET = 'import { Icon } from "@hearth/sdk/web";\nexport default function Widget() {\n  return <Icon name="star" />;\n}\n';
const MANIFEST = 'import { defineApp } from "@hearth/sdk";\nexport default defineApp({} as never);\n';
const SERVER =
  'import { defineServer, z } from "@hearth/sdk/server";\nimport manifest from "./manifest";\nexport default defineServer(manifest, { items: z.object({}) }).routes({});\n';

/** An app's folder holding a manifest, a widget and a server file, plus or instead of these whatever is given. */
function app(files: Record<string, string> = {}): string {
  const dir = path.join(tempDir(), "notes");
  write(dir, { "manifest.ts": MANIFEST, "widget.tsx": WIDGET, "server.ts": SERVER, ...files });
  return dir;
}

/** What the scan refuses, as "file:line: message", so a test can read it. */
function refused(dir: string, overrides?: ReadonlyMap<string, string>): string[] {
  return scanApp(dir, { overrides }).map(
    (violation) => `${path.relative(dir, violation.file)}:${violation.line}: ${violation.message}`,
  );
}

describe("scanApp: what is allowed", () => {
  it("passes the framework's own sample apps", () => {
    expect(scanApp(path.join(FIXTURES, "checklist"))).toEqual([]);
    expect(scanApp(path.join(FIXTURES, "feed"))).toEqual([]);
  });

  it("passes an app whose sides keep to their own part of the SDK", () => {
    const dir = app({
      "page.tsx": 'import { useState } from "react";\nimport { Row } from "./parts/row";\nexport default function Page() {\n  return <Row n={useState(0)[0]} />;\n}\n',
      "parts/row.tsx": 'import { Tag } from "@hearth/sdk/web";\nimport manifest from "../manifest";\nexport const Row = ({ n }: { n: number }) => <Tag>{manifest.id}{n}</Tag>;\n',
      "server.ts": 'import { defineServer } from "@hearth/sdk/server";\nimport manifest from "./manifest";\nimport { items } from "./schema.js";\nexport default defineServer(manifest, { items }).routes({});\n',
      "schema.ts": 'import { z } from "@hearth/sdk/server";\nimport { MAX } from "./limits";\nexport const items = z.object({ name: z.string().max(MAX) });\n',
      // Used by both sides: it imports nothing but its own kind.
      "limits.ts": "export const MAX = 80;\n",
      "strings.ts": 'export const en = { empty: "Nothing." } as const;\n',
      "manifest.ts": 'import { defineApp } from "@hearth/sdk";\nimport { en } from "./strings";\nexport default defineApp({ en } as never);\n',
      "widget.tsx": 'import { Icon } from "@hearth/sdk/web";\nimport { MAX } from "./limits";\nimport data from "./sample.json";\nexport default function Widget() {\n  return <Icon name="star" size={MAX + data.length} />;\n}\n',
      "sample.json": "[]\n",
    });
    expect(refused(dir)).toEqual([]);
  });

  it("lets the widget and the page see the server file's types, and nothing more of it", () => {
    const dir = app({
      "widget.tsx":
        'import type server from "./server";\nexport type { default as Server } from "./server";\ntype Routes = typeof import("./server");\nexport default function Widget() {\n  return null as unknown as server & Routes;\n}\n',
    });
    expect(refused(dir)).toEqual([]);
  });

  it("lets a test file import the server, the test runner and the SDK's test helpers", () => {
    const dir = app({
      "server.test.ts": 'import { testApp } from "@hearth/sdk/testing";\nimport { expect, it } from "vitest";\nimport server from "./server";\nit("lists", () => expect(testApp(server)).toBeDefined());\n',
    });
    expect(refused(dir)).toEqual([]);
  });
});

describe("scanApp: what is refused", () => {
  it("refuses another package, a built-in module and the framework's own packages", () => {
    const dir = app({
      "widget.tsx": 'import pad from "left-pad";\nimport fs from "node:fs";\nimport { sessionSchema } from "@hearth/shared";\nexport default () => [pad, fs, sessionSchema];\n',
      "server.ts": SERVER + 'import Database from "better-sqlite3";\nexport const db = Database;\n',
    });
    const found = refused(dir);
    expect(found).toHaveLength(4);
    expect(found[0]).toMatch(/^server\.ts:4: A mini-app may only import its own files and the SDK .*"better-sqlite3" is neither\.$/);
    expect(found[1]).toMatch(/^widget\.tsx:1: .*"left-pad" is neither\.$/);
    expect(found[2]).toMatch(/^widget\.tsx:2: .*"node:fs" is neither\.$/);
    expect(found[3]).toMatch(/^widget\.tsx:3: .*"@hearth\/shared" is neither\.$/);
  });

  it("refuses the parts of the SDK that are not for mini-apps", () => {
    const dir = app({ "manifest.ts": MANIFEST + 'import { manifestSchema } from "@hearth/sdk/manifest-schema";\nexport const schema = manifestSchema;\n' });
    expect(refused(dir)).toEqual([
      expect.stringMatching(/^manifest\.ts:3: .*"@hearth\/sdk\/manifest-schema" is not a part of the SDK that mini-apps import\.$/),
    ]);
  });

  it("refuses what the shell hands a widget, which only the framework reads", () => {
    const dir = app({
      "widget.tsx": 'import { AppScopeContext } from "@hearth/sdk/web/scope";\nexport default function Widget() {\n  return String(AppScopeContext);\n}\n',
    });
    expect(refused(dir)).toEqual([
      expect.stringMatching(/^widget\.tsx:1: .*"@hearth\/sdk\/web\/scope" is not a part of the SDK that mini-apps import\.$/),
    ]);
  });

  it("refuses a file outside the app's folder, however it is named", () => {
    const dir = app({
      "widget.tsx":
        'import other from "../grocery/manifest";\nimport up from "..";\nimport abs from "/etc/hostname";\nexport * from "../../hearth/packages/server/src/app";\nexport default () => [other, up, abs];\n',
    });
    const found = refused(dir);
    expect(found).toHaveLength(4);
    expect(found[0]).toBe(
      'widget.tsx:1: "../grocery/manifest" is a file outside this mini-app\'s folder. A mini-app may only import its own files and the SDK.',
    );
    expect(found[1]).toContain('".." is a file outside');
    expect(found[2]).toContain('"/etc/hostname" is neither');
    expect(found[3]).toContain('"../../hearth/packages/server/src/app" is a file outside');
  });

  it("refuses a link that leads out of the folder", () => {
    const dir = app();
    const outside = path.join(path.dirname(dir), "elsewhere");
    write(outside, { "secret.ts": "export const secret = 1;\n" });
    fs.symlinkSync(outside, path.join(dir, "borrowed"), "dir");
    expect(refused(dir)).toEqual([
      'borrowed:1: "borrowed" is a link to something outside this mini-app\'s folder. An app\'s folder holds its own files only.',
    ]);
  });

  it("refuses the app's own files where the scan does not read: packages and whatever is hidden", () => {
    const dir = app({
      "widget.tsx":
        'import pad from "./node_modules/left-pad/index.js";\nimport cache from "./.cache/data";\nimport type { Secret } from "./parts/.secret";\nexport default () => [pad, cache] as Secret[];\n',
      // None of these is read, so none of them is reported itself.
      "node_modules/left-pad/index.js": 'import fs from "node:fs";\nexport default fs;\n',
      ".cache/data.ts": 'import fs from "node:fs";\nexport default fs;\n',
      "parts/.secret.ts": 'import fs from "node:fs";\nexport type Secret = typeof fs;\n',
    });
    expect(refused(dir)).toEqual([
      'widget.tsx:1: "./node_modules/left-pad/index.js" is in a node_modules folder. A mini-app has no packages of its own: it uses only the SDK.',
      'widget.tsx:2: "./.cache/data" is hidden (".cache" starts with a dot), and the build does not check hidden files. Keep the app\'s code in plain files and folders.',
      'widget.tsx:3: "./parts/.secret" is hidden (".secret" starts with a dot), and the build does not check hidden files. Keep the app\'s code in plain files and folders.',
    ]);
  });

  it("refuses the server file imported as a value by the widget or the page", () => {
    const plain = app({ "widget.tsx": 'import server from "./server";\nexport default () => server;\n' });
    expect(refused(plain)).toEqual([
      'widget.tsx:1: "./server" must be imported with "import type" here: widget.tsx is part of what the browser loads, and any other import would put the server\'s code there.',
    ]);

    // `import { type X }` leaves the import itself in the compiled file.
    const inline = app({ "page.tsx": 'import { type default as Server } from "./server.ts";\nexport default (): Server | null => null;\n' });
    expect(refused(inline)).toEqual([expect.stringMatching(/^page\.tsx:1: "\.\/server\.ts" must be imported with "import type" here: page\.tsx /)]);

    const lazy = app({ "widget.tsx": 'export default () => import("./server");\n' });
    expect(refused(lazy)).toEqual([expect.stringMatching(/^widget\.tsx:1: "\.\/server" must be imported with "import type"/)]);

    // What a bundler lets follow an address does not hide which file it is.
    const asText = app({ "widget.tsx": 'import source from "./server?raw";\nexport default () => source;\n' });
    expect(refused(asText)).toEqual([expect.stringMatching(/^widget\.tsx:1: "\.\/server\?raw" must be imported with "import type"/)]);

    const indirect = app({
      "widget.tsx": 'import { load } from "./parts/load";\nexport default () => load;\n',
      "parts/load.ts": 'import server from "../server";\nexport const load = server;\n',
    });
    expect(refused(indirect)).toEqual([
      expect.stringMatching(/^parts\/load\.ts:1: "\.\.\/server" must be imported with "import type" here: parts\/load\.ts is part of what the browser loads/),
    ]);
  });

  it("refuses the server's part of the SDK in what the browser loads", () => {
    const dir = app({
      "widget.tsx": 'import { z } from "@hearth/sdk/server";\nimport { shape } from "./shape";\nexport default () => [z, shape];\n',
      "shape.ts": 'import type { Row } from "@hearth/sdk/server";\nexport const shape = (row: Row<object>) => row.id;\n',
      "manifest.ts": MANIFEST + 'import { AppError } from "@hearth/sdk/server";\nexport const error = AppError;\n',
    });
    expect(refused(dir)).toEqual([
      'manifest.ts:3: "@hearth/sdk/server" is for server.ts and the files only it imports: manifest.ts is part of what the browser loads.',
      'shape.ts:1: "@hearth/sdk/server" is for server.ts and the files only it imports: shape.ts, which the widget, the page or the manifest imports, is part of what the browser loads.',
      'widget.tsx:1: "@hearth/sdk/server" is for server.ts and the files only it imports: widget.tsx is part of what the browser loads.',
    ]);
  });

  it("refuses the browser's part of the SDK, and react, in what the server runs", () => {
    const dir = app({
      "server.ts": SERVER + 'import { useState } from "react";\nimport { label } from "./label";\nexport const hooks = [useState, label];\n',
      "label.tsx": 'import { Tag } from "@hearth/sdk/web";\nexport const label = Tag;\n',
      "manifest.ts": MANIFEST + 'import { Icon } from "@hearth/sdk/web";\nexport const icon = Icon;\n',
    });
    expect(refused(dir)).toEqual([
      'label.tsx:1: "@hearth/sdk/web" is for the widget and the page: label.tsx is imported by server.ts, which runs on the server.',
      'manifest.ts:3: manifest.ts may import "@hearth/sdk" and the app\'s own files only: the server reads it too, and "@hearth/sdk/web" is for the browser.',
      'server.ts:4: "react" is for the widget and the page: server.ts runs on the server.',
    ]);
  });

  it("refuses a file that takes from both sides, even when nothing imports it yet", () => {
    const dir = app({ "both.tsx": 'import { z } from "@hearth/sdk/server";\nimport { Tag } from "@hearth/sdk/web";\nexport const both = [z, Tag];\n' });
    expect(refused(dir)).toEqual([
      'both.tsx:1: One file cannot import both "@hearth/sdk/server" and what is for the browser (@hearth/sdk/web, react).',
    ]);
  });

  it("refuses require and an import() that does not say what it imports", () => {
    const dir = app({
      "widget.tsx":
        'const name = "./server";\nconst lazy = import(name);\nconst old = require("./manifest");\nimport legacy = require("./manifest");\nexport default () => [lazy, old, legacy];\n',
    });
    expect(refused(dir)).toEqual([
      "widget.tsx:2: An import() must name what it imports as plain text, so that the build can check it.",
      "widget.tsx:3: A mini-app is written with import, not require().",
      "widget.tsx:4: A mini-app is written with import, not require().",
    ]);
  });

  it("keeps the test runner to test files, and test files out of the app", () => {
    const dir = app({
      "widget.tsx": 'import { vi } from "vitest";\nimport { helper } from "./helper.test";\nexport default () => [vi, helper];\n',
      "helper.test.ts": 'import { expect } from "vitest";\nexport const helper = expect;\n',
    });
    expect(refused(dir)).toEqual([
      'helper.test.ts:1: "vitest" is for tests, but helper.test.ts is imported by the app itself.',
      'widget.tsx:1: "vitest" is for test files (*.test.ts) only.',
    ]);
  });

  it("cannot be switched off by a comment", () => {
    const dir = app({
      "widget.tsx": '// eslint-disable-next-line\n// @ts-ignore\nimport fs from "node:fs"; // hearth-ignore\nexport default () => fs;\n',
    });
    expect(refused(dir)).toHaveLength(1);
  });
});

describe("scanApp: text an editor holds", () => {
  it("reads a file as given instead of from disk, and finds a file not saved yet", () => {
    const dir = app();
    const widget = path.join(dir, "widget.tsx");
    expect(refused(dir, new Map([[widget, 'import fs from "node:fs";\nexport default () => fs;\n']]))).toEqual([
      expect.stringContaining('"node:fs" is neither'),
    ]);
    expect(refused(dir, new Map([[path.join(dir, "new.ts"), 'import "left-pad";\n']]))).toEqual([
      expect.stringMatching(/^new\.ts:1: .*"left-pad" is neither/),
    ]);
    expect(refused(dir)).toEqual([]);
  });

  it("says where in the line", () => {
    const dir = app({ "widget.tsx": 'export default null;\n  import fs from "node:fs";\n' });
    expect(scanApp(dir)).toEqual([expect.objectContaining({ file: path.join(dir, "widget.tsx"), line: 2, column: 18 })]);
  });
});
