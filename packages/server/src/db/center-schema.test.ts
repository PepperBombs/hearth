/**
 * Migration 10, the app center (docs/center.md), tested as SQL. It must
 * apply on a copy of real data, where the deploy tries each release first,
 * and the rules below are the ones the database itself keeps, whatever the
 * code above it does.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { migrate, openDatabase, type Db } from "./database";
import { MIGRATIONS } from "./migrations";

const NOW = "2026-11-01T00:00:00.000Z";
const LATER = "2026-11-02T00:00:00.000Z";

const all = (db: Db, sql: string, ...params: unknown[]) => db.prepare(sql).all(...params);
const count = (db: Db, table: string) => (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
const schema = (db: Db) => all(db, "SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name");
const upTo = (id: number) => MIGRATIONS.filter((migration) => migration.id <= id);
const tables = (db: Db) =>
  (all(db, "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name") as { name: string }[]).map((row) => row.name);
const dump = (db: Db) =>
  Object.fromEntries(tables(db).filter((table) => table !== "migrations").map((table) => [table, all(db, `SELECT * FROM ${table} ORDER BY rowid`)]));

const MANIFEST = JSON.stringify({ name: "Ledger", icon: "list", collections: { entries: { fields: { amount: { type: "number" } } } } });

/** A made app with its install and first version, as src/made/apps.ts writes one. */
function addMadeApp(db: Db, appId: string, spaceId: string, userId: string, template: string | null = null): void {
  db.transaction(() => {
    db.prepare(
      `INSERT INTO made_apps (app_id, space_id, manifest, html, version, created_by, updated_by, created_at, updated_at, template, template_hash)
       VALUES (?, ?, ?, '<p>Ledger</p>', 1, ?, ?, ?, ?, ?, ?)`,
    ).run(appId, spaceId, MANIFEST, userId, userId, NOW, NOW, template, template === null ? null : "built-in-hash");
    db.prepare("INSERT INTO space_apps (space_id, app_id, created_by, created_at) VALUES (?, ?, ?, ?)").run(spaceId, appId, userId, NOW);
    db.prepare(
      "INSERT INTO made_app_versions (app_id, version, manifest, html, note, created_by, created_at) VALUES (?, 1, ?, '<p>Ledger</p>', '', ?, ?)",
    ).run(appId, MANIFEST, userId, NOW);
  })();
}

/** What a server of the release before the app center holds: three people, a group, made apps of a person and of the group, a built-in copy, rows and a conversation. */
function releaseBefore(db: Db): void {
  const user = db.prepare("INSERT INTO users (id, email, name, locale, theme, created_at) VALUES (?, ?, ?, ?, ?, ?)");
  const space = db.prepare("INSERT INTO spaces (id, kind, name, created_by, created_at, assistant) VALUES (?, ?, ?, ?, ?, ?)");
  const member = db.prepare("INSERT INTO space_members (space_id, user_id, role, can_add_apps, created_at) VALUES (?, ?, ?, ?, ?)");
  user.run("u-sam", "sam@example.com", "Sam Example", "en", "dark", NOW);
  user.run("u-lin", "lin@example.com", "Lin Example", "zh", "system", LATER);
  user.run("u-noa", "noa@example.com", "Noa Example", "en", "light", LATER);
  space.run("s-sam", "personal", "", "u-sam", NOW, "edit");
  space.run("s-lin", "personal", "", "u-lin", LATER, "none");
  space.run("s-noa", "personal", "", "u-noa", LATER, "none");
  space.run("family", "group", "Family", "u-sam", NOW, "view");
  member.run("s-sam", "u-sam", "owner", 0, NOW);
  member.run("s-lin", "u-lin", "owner", 0, LATER);
  member.run("s-noa", "u-noa", "owner", 0, LATER);
  member.run("family", "u-sam", "owner", 0, NOW);
  member.run("family", "u-lin", "member", 1, LATER);
  addMadeApp(db, "m-ledger0001", "s-lin", "u-lin");
  addMadeApp(db, "m-family0001", "family", "u-sam");
  addMadeApp(db, "m-grocery001", "s-sam", "u-sam", "grocery");
  db.prepare(
    `INSERT INTO app_rows (id, space_id, app_id, collection, data, created_by, updated_by, created_at, updated_at)
     VALUES ('row-1', 's-lin', 'm-ledger0001', 'entries', '{"amount":12}', 'u-lin', 'u-lin', ?, ?)`,
  ).run(NOW, NOW);
  db.prepare("INSERT INTO chats (id, space_id, user_id, title, created_at, updated_at) VALUES ('c-1', 's-lin', 'u-lin', 'Ledger', ?, ?)").run(NOW, NOW);
}

/** A listing, as src/center/published.ts writes one. */
function publish(
  db: Db,
  id: string,
  options: { spaceId?: string; by?: string; sourceAppId?: string; revision?: number; note?: string; manifest?: string } = {},
): void {
  db.prepare(
    `INSERT INTO published_apps
       (id, space_id, created_by, source_space_id, source_app_id, manifest, html, hash, revision, note, created_at, updated_at)
     VALUES (?, ?, ?, 's-lin', ?, ?, '<p>Ledger</p>', 'snapshot-hash', ?, ?, ?, ?)`,
  ).run(
    id,
    options.spaceId ?? "family",
    options.by ?? "u-lin",
    options.sourceAppId ?? "m-ledger0001",
    options.manifest ?? MANIFEST,
    options.revision ?? 1,
    options.note ?? "",
    NOW,
    NOW,
  );
}

/** Makes a made app a copy of a listing, as adding a copy will. */
function copyOf(db: Db, appId: string, listingId: string | null): void {
  db.prepare("UPDATE made_apps SET origin = ?, origin_hash = 'snapshot-hash', origin_revision = 1 WHERE app_id = ?").run(listingId, appId);
}

const origins = (db: Db) => all(db, "SELECT app_id AS appId, origin, origin_hash AS hash, origin_revision AS revision FROM made_apps ORDER BY app_id");

describe("migration 10 on a database that migration 9 made", () => {
  it("applies with made apps in place, leaves everything as it was and starts with nothing published", () => {
    const path = join(mkdtempSync(join(tmpdir(), "hearth-migrate-")), "hearth.db");
    let db = openDatabase(path);
    expect(migrate(db, upTo(9)).map((migration) => migration.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    releaseBefore(db);
    const before = dump(db);
    db.close();

    // The release with the app center starts on the same file.
    db = openDatabase(path);
    try {
      expect(migrate(db, upTo(10)).map((migration) => migration.id)).toEqual([10]);
      expect(all(db, "SELECT id, name FROM migrations ORDER BY id")).toEqual(upTo(10).map(({ id, name }) => ({ id, name })));
      const after = dump(db);
      for (const [table, rows] of Object.entries(before)) {
        // Every made app is a copy of nothing, built-in copies included: their template stays theirs.
        const expected = table === "made_apps" ? rows.map((row) => ({ ...(row as object), origin: null, origin_hash: null, origin_revision: null })) : rows;
        expect(after[table], table).toEqual(expected);
      }
      expect(count(db, "published_apps")).toBe(0);
      expect(all(db, "PRAGMA foreign_key_check")).toEqual([]);
      expect(db.pragma("integrity_check", { simple: true })).toBe("ok");

      // An app from before can be published at once, and copied.
      publish(db, "p-ledger0001");
      addMadeApp(db, "m-copy000001", "s-sam", "u-sam");
      copyOf(db, "m-copy000001", "p-ledger0001");
      expect(count(db, "published_apps")).toBe(1);
    } finally {
      db.close();
    }
  });

  it("gives the same schema as a new database", () => {
    const fresh = openDatabase(":memory:");
    migrate(fresh);
    const upgraded = openDatabase(":memory:");
    migrate(upgraded, upTo(9));
    releaseBefore(upgraded);
    migrate(upgraded);
    expect(schema(upgraded)).toEqual(schema(fresh));
  });
});

describe("published_apps", () => {
  function world() {
    const db = openDatabase(":memory:");
    migrate(db);
    releaseBefore(db);
    return db;
  }

  it("are published by a member of their group, once per app and group", () => {
    const db = world();
    publish(db, "p-1");
    // Noa is in no group with anyone; nobody is on the server as u-kim; no group is called "club".
    expect(() => publish(db, "p-2", { sourceAppId: "m-other00001", by: "u-noa" })).toThrow(/FOREIGN KEY/);
    expect(() => publish(db, "p-3", { sourceAppId: "m-other00002", by: "u-kim" })).toThrow(/FOREIGN KEY/);
    expect(() => publish(db, "p-4", { sourceAppId: "m-other00003", spaceId: "club" })).toThrow(/FOREIGN KEY/);
    // The same app once in a group, under one ID.
    expect(() => publish(db, "p-5")).toThrow(/UNIQUE/);
    expect(() => publish(db, "p-1", { sourceAppId: "m-family0001" })).toThrow(/UNIQUE|PRIMARY KEY/);
    publish(db, "p-6", { sourceAppId: "m-family0001", by: "u-sam" });
  });

  it("accept only the revisions, notes and manifests the contract names", () => {
    const db = world();
    expect(() => publish(db, "p-1", { revision: 0 })).toThrow(/CHECK/);
    expect(() => publish(db, "p-1", { note: "x".repeat(201) })).toThrow(/CHECK/);
    expect(() => publish(db, "p-1", { manifest: "not json" })).toThrow(/CHECK/);
    publish(db, "p-1", { revision: 3, note: "x".repeat(200) });
  });

  it("depend on nothing of the app they came from: it may change, move or go", () => {
    const db = world();
    publish(db, "p-1");
    db.prepare("UPDATE made_apps SET html = '<p>Changed</p>', version = 2 WHERE app_id = 'm-ledger0001'").run();
    db.prepare("DELETE FROM app_rows WHERE app_id = 'm-ledger0001'").run();
    db.prepare("UPDATE space_apps SET space_id = 's-sam' WHERE app_id = 'm-ledger0001'").run();
    db.prepare("DELETE FROM space_apps WHERE app_id = 'm-ledger0001'").run();
    expect(count(db, "made_apps")).toBe(2);
    expect(all(db, "SELECT id, source_space_id AS sourceSpaceId, html FROM published_apps")).toEqual([
      { id: "p-1", sourceSpaceId: "s-lin", html: "<p>Ledger</p>" },
    ]);
  });

  it("go when their publisher leaves the group or the group is deleted, and leave their copies as they are", () => {
    const db = world();
    db.prepare("INSERT INTO spaces (id, kind, name, created_by, created_at) VALUES ('club', 'group', 'Book club', 'u-lin', ?)").run(NOW);
    db.prepare("INSERT INTO space_members (space_id, user_id, role, created_at) VALUES ('club', 'u-lin', 'owner', ?)").run(NOW);
    publish(db, "p-family");
    publish(db, "p-sams", { sourceAppId: "m-family0001", by: "u-sam" });
    publish(db, "p-club", { spaceId: "club" });
    addMadeApp(db, "m-copy000001", "s-sam", "u-sam");
    addMadeApp(db, "m-copy000002", "s-lin", "u-lin");
    copyOf(db, "m-copy000001", "p-family");
    copyOf(db, "m-copy000002", "p-club");

    // Lin leaves the family: her listing there goes, Sam's stays, and the copy keeps what it was copied from.
    db.prepare("DELETE FROM space_members WHERE space_id = 'family' AND user_id = 'u-lin'").run();
    expect(all(db, "SELECT id FROM published_apps ORDER BY id")).toEqual([{ id: "p-club" }, { id: "p-sams" }]);
    // Lin deletes the book club: its listing goes with its members.
    db.prepare("DELETE FROM spaces WHERE id = 'club'").run();
    expect(all(db, "SELECT id FROM published_apps")).toEqual([{ id: "p-sams" }]);
    expect(origins(db)).toEqual([
      { appId: "m-copy000001", origin: null, hash: "snapshot-hash", revision: 1 },
      { appId: "m-copy000002", origin: null, hash: "snapshot-hash", revision: 1 },
      { appId: "m-family0001", origin: null, hash: null, revision: null },
      { appId: "m-grocery001", origin: null, hash: null, revision: null },
      { appId: "m-ledger0001", origin: null, hash: null, revision: null },
    ]);
    expect(count(db, "app_rows")).toBe(1);
  });

  it("are unpublished by deleting them, which leaves their copies working, with their rows", () => {
    const db = world();
    publish(db, "p-1");
    addMadeApp(db, "m-copy000001", "s-sam", "u-sam");
    copyOf(db, "m-copy000001", "p-1");
    db.prepare(
      `INSERT INTO app_rows (id, space_id, app_id, collection, data, created_by, updated_by, created_at, updated_at)
       VALUES ('row-2', 's-sam', 'm-copy000001', 'entries', '{"amount":3}', 'u-sam', 'u-sam', ?, ?)`,
    ).run(NOW, NOW);
    // A copy names a listing there is, or none.
    expect(() => copyOf(db, "m-grocery001", "p-none")).toThrow(/FOREIGN KEY/);

    db.prepare("DELETE FROM published_apps WHERE id = 'p-1'").run();
    expect(origins(db)[0]).toEqual({ appId: "m-copy000001", origin: null, hash: "snapshot-hash", revision: 1 });
    expect(all(db, "SELECT id FROM app_rows ORDER BY id")).toEqual([{ id: "row-1" }, { id: "row-2" }]);
    // Deleting a copy leaves the listing it came from.
    publish(db, "p-2");
    copyOf(db, "m-copy000001", "p-2");
    db.prepare("DELETE FROM app_rows WHERE app_id = 'm-copy000001'").run();
    db.prepare("DELETE FROM space_apps WHERE app_id = 'm-copy000001'").run();
    expect(all(db, "SELECT id FROM published_apps")).toEqual([{ id: "p-2" }]);
  });

  it("find the copies of a listing, and the listings of an app, through an index", () => {
    const db = world();
    const plan = (sql: string) => (all(db, `EXPLAIN QUERY PLAN ${sql}`) as { detail: string }[]).map((step) => step.detail).join("\n");
    expect(plan("SELECT app_id FROM made_apps WHERE origin = 'p-1'")).toMatch(/USING (COVERING )?INDEX made_apps_by_origin/);
    expect(plan("SELECT id FROM published_apps WHERE source_app_id = 'm-ledger0001'")).toMatch(/USING INDEX published_apps_of_source/);
  });
});
