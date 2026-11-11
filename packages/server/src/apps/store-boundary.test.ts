/**
 * The tables that hold every mini-app's data are named in one source file
 * only (docs/mini-app-contract.md, section A6): `store.ts`, where every
 * statement carries its space and its app. A query written anywhere else
 * could leave them out, so this test fails when another file names the
 * tables at all.
 *
 * Left out: the migrations, which create the tables, and test files, which
 * look at them directly to check what the store did.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SOURCE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA_TABLES = /\bapp_(rows|settings)\b/;
const ALLOWED = ["apps/store.ts", "db/migrations.ts"];

/** Every TypeScript file below a folder, as a path relative to SOURCE with forward slashes. */
function sourceFiles(folder = SOURCE): string[] {
  return readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(folder, entry.name);
    if (entry.isDirectory()) return sourceFiles(file);
    return /\.tsx?$/.test(entry.name) ? [path.relative(SOURCE, file).split(path.sep).join("/")] : [];
  });
}

const names = (file: string) => DATA_TABLES.test(readFileSync(path.join(SOURCE, file), "utf8"));

describe("SQL for mini-apps' data", () => {
  const files = sourceFiles();
  const checked = files.filter((file) => !file.endsWith(".test.ts") && !ALLOWED.includes(file));

  it("is looked for in the whole of the server's source", () => {
    expect(files).toEqual(expect.arrayContaining(["app.ts", "main.ts", "apps/calls.ts", "apps/installs.ts", ...ALLOWED]));
    expect(checked.length).toBeGreaterThan(15);
    for (const file of ALLOWED) expect(checked).not.toContain(file);
  });

  it("would be found: the two files that may name the tables do", () => {
    for (const file of ALLOWED) expect(names(file), file).toBe(true);
    expect(DATA_TABLES.test("DELETE FROM app_rows WHERE id = ?")).toBe(true);
    expect(DATA_TABLES.test('db.prepare("SELECT data FROM app_settings")')).toBe(true);
  });

  it("is in store.ts and nowhere else", () => {
    expect(checked.filter(names)).toEqual([]);
  });

  it("names its space and its app in every statement", () => {
    const source = readFileSync(path.join(SOURCE, "apps/store.ts"), "utf8");
    // Every piece of text in the file that is a statement about one of the two tables.
    const statements = [...source.matchAll(/[`"]([^`"]*)[`"]/g)]
      .map((match) => match[1] ?? "")
      .filter((text) => DATA_TABLES.test(text) && /\b(SELECT|INSERT|UPDATE|DELETE)\b/.test(text));
    expect(statements.length).toBeGreaterThanOrEqual(8);
    for (const statement of statements) {
      const scoped =
        statement.includes("${SCOPE}") || (/\bspace_id\b/.test(statement) && /\bapp_id\b/.test(statement));
      expect(scoped, statement).toBe(true);
    }
    // And the scope that most of them share is the space, the app and the collection.
    expect(source).toContain('const SCOPE = "space_id = @spaceId AND app_id = @appId AND collection = @collection";');
  });
});
