import { existsSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { migrate, openDatabase } from "./database";
import { newId } from "./ids";
import { MIGRATIONS, type Migration } from "./migrations";

const tables = (db: ReturnType<typeof openDatabase>) =>
  (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as {
      name: string;
    }[]
  ).map((row) => row.name);

describe("openDatabase", () => {
  it("creates the folder, and turns on WAL and foreign keys", () => {
    const path = join(mkdtempSync(join(tmpdir(), "hearth-db-")), "nested", "data", "hearth.db");
    const db = openDatabase(path);
    try {
      expect(existsSync(path)).toBe(true);
      expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
      expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    } finally {
      db.close();
    }
  });

  it.skipIf(process.platform === "win32")(
    "creates the folder and the files so that only this account can read them",
    () => {
      const folder = join(mkdtempSync(join(tmpdir(), "hearth-db-")), "data");
      const path = join(folder, "hearth.db");
      const db = openDatabase(path);
      try {
        migrate(db);
        const othersCanReach = (file: string) => statSync(file).mode & 0o077;
        expect(othersCanReach(folder)).toBe(0);
        expect(othersCanReach(path)).toBe(0);
        // The write-ahead log holds the newest rows before they reach the main file.
        expect(othersCanReach(`${path}-wal`)).toBe(0);
        expect(othersCanReach(`${path}-shm`)).toBe(0);
      } finally {
        db.close();
      }
    },
  );
});

describe("migrate", () => {
  it("creates the schema and records what it ran", () => {
    const db = openDatabase(":memory:");
    const ran = migrate(db);
    expect(ran.map((migration) => migration.id)).toEqual(MIGRATIONS.map((m) => m.id));
    expect(tables(db)).toEqual([
      "app_access",
      "app_jobs",
      "app_prefs",
      "app_rows",
      "app_settings",
      "invitations",
      "migrations",
      "space_apps",
      "space_invitations",
      "space_members",
      "spaces",
      "users",
    ]);
    const recorded = db.prepare("SELECT id, name FROM migrations ORDER BY id").all();
    expect(recorded).toEqual(MIGRATIONS.map(({ id, name }) => ({ id, name })));
  });

  it("does nothing the second time", () => {
    const db = openDatabase(":memory:");
    migrate(db);
    expect(migrate(db)).toEqual([]);
  });

  it("applies only what is new, in order of ID", () => {
    const db = openDatabase(":memory:");
    const first: Migration = { id: 1, name: "one", sql: "CREATE TABLE a (x TEXT);" };
    const second: Migration = { id: 2, name: "two", sql: "ALTER TABLE a ADD COLUMN y TEXT;" };
    const third: Migration = { id: 3, name: "three", sql: "CREATE TABLE b (z TEXT);" };
    expect(migrate(db, [first]).map((m) => m.id)).toEqual([1]);
    expect(migrate(db, [third, first, second]).map((m) => m.id)).toEqual([2, 3]);
    expect(tables(db)).toEqual(["a", "b", "migrations"]);
  });

  it("rolls a failed migration back and leaves earlier ones in place", () => {
    const db = openDatabase(":memory:");
    const good: Migration = { id: 1, name: "good", sql: "CREATE TABLE a (x TEXT);" };
    const bad: Migration = {
      id: 2,
      name: "bad",
      sql: "CREATE TABLE b (x TEXT); CREATE TABLE a (x TEXT);",
    };
    expect(() => migrate(db, [good, bad])).toThrow();
    expect(tables(db)).toEqual(["a", "migrations"]);
    expect(db.prepare("SELECT id FROM migrations").all()).toEqual([{ id: 1 }]);
  });

  it("refuses a database written by a newer build", () => {
    const db = openDatabase(":memory:");
    migrate(db, [
      { id: 1, name: "one", sql: "CREATE TABLE a (x TEXT);" },
      { id: 2, name: "two", sql: "CREATE TABLE b (x TEXT);" },
    ]);
    expect(() => migrate(db, [{ id: 1, name: "one", sql: "CREATE TABLE a (x TEXT);" }])).toThrow(
      /newer build/,
    );
  });

  it("refuses duplicate IDs", () => {
    const db = openDatabase(":memory:");
    expect(() =>
      migrate(db, [
        { id: 1, name: "one", sql: "CREATE TABLE a (x TEXT);" },
        { id: 1, name: "again", sql: "CREATE TABLE b (x TEXT);" },
      ]),
    ).toThrow(/unique/);
  });
});

describe("schema", () => {
  const now = "2026-01-01T00:00:00.000Z";

  it("refuses email addresses that are not lower-case, and duplicates", () => {
    const db = openDatabase(":memory:");
    migrate(db);
    const insert = db.prepare(
      "INSERT INTO users (id, email, name, locale, theme, created_at) VALUES (?, ?, 'x', 'en', 'system', ?)",
    );
    insert.run(newId(), "sam@example.com", now);
    expect(() => insert.run(newId(), "Sam@example.com", now)).toThrow(/CHECK/);
    expect(() => insert.run(newId(), "sam@example.com", now)).toThrow(/UNIQUE/);
  });

  it("enforces foreign keys", () => {
    const db = openDatabase(":memory:");
    migrate(db);
    expect(() =>
      db
        .prepare(
          "INSERT INTO spaces (id, kind, name, created_by, created_at) VALUES (?, 'group', 'Family', 'nobody', ?)",
        )
        .run(newId(), now),
    ).toThrow(/FOREIGN KEY/);
  });
});

describe("newId", () => {
  it("makes URL-safe strings that do not repeat", () => {
    const ids = new Set(Array.from({ length: 1000 }, newId));
    expect(ids.size).toBe(1000);
    for (const id of ids) expect(id).toMatch(/^[0-9a-z]{24}$/);
  });
});
