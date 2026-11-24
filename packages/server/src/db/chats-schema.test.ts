/**
 * Migration 8, the chat's history (docs/platform.md, "The chat"), and
 * migration 9, the chat's requests to delete rows, tested as SQL. Each must
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

/** What a server of the release before the chat's history holds: two people, a group, a made app with two versions, a model. */
function releaseBefore(db: Db): void {
  const user = db.prepare("INSERT INTO users (id, email, name, locale, theme, created_at) VALUES (?, ?, ?, ?, ?, ?)");
  const space = db.prepare("INSERT INTO spaces (id, kind, name, created_by, created_at, assistant) VALUES (?, ?, ?, ?, ?, ?)");
  const member = db.prepare("INSERT INTO space_members (space_id, user_id, role, can_add_apps, created_at) VALUES (?, ?, ?, ?, ?)");
  user.run("u-sam", "sam@example.com", "Sam Example", "en", "dark", NOW);
  user.run("u-lin", "lin@example.com", "Lin Example", "zh", "system", LATER);
  space.run("s-sam", "personal", "", "u-sam", NOW, "edit");
  space.run("s-lin", "personal", "", "u-lin", LATER, "none");
  space.run("family", "group", "Family", "u-sam", NOW, "view");
  member.run("s-sam", "u-sam", "owner", 0, NOW);
  member.run("s-lin", "u-lin", "owner", 0, LATER);
  member.run("family", "u-sam", "owner", 0, NOW);
  member.run("family", "u-lin", "member", 1, LATER);
  const manifest = JSON.stringify({ name: "List", icon: "list", collections: { items: { fields: { name: { type: "text" } } } } });
  db.transaction(() => {
    db.prepare(
      `INSERT INTO made_apps (app_id, space_id, manifest, html, version, created_by, updated_by, created_at, updated_at, template, template_hash)
       VALUES ('m-list', 'family', ?, '<p>v2</p>', 2, 'u-sam', 'u-lin', ?, ?, NULL, NULL)`,
    ).run(manifest, NOW, LATER);
    db.prepare("INSERT INTO space_apps (space_id, app_id, created_by, created_at) VALUES ('family', 'm-list', 'u-sam', ?)").run(NOW);
  })();
  const version = db.prepare(
    "INSERT INTO made_app_versions (app_id, version, manifest, html, note, created_by, created_at) VALUES ('m-list', ?, ?, ?, ?, ?, ?)",
  );
  version.run(1, manifest, "<p>v1</p>", "", "u-sam", NOW);
  version.run(2, manifest, "<p>v2</p>", "Bigger", "u-lin", LATER);
  db.prepare(
    `INSERT INTO app_rows (id, space_id, app_id, collection, data, created_by, updated_by, created_at, updated_at)
     VALUES ('row-1', 'family', 'm-list', 'items', '{"name":"Sample item"}', 'u-lin', 'u-lin', ?, ?)`,
  ).run(LATER, LATER);
  db.prepare(
    "INSERT INTO user_models (user_id, protocol, base_url, model, sealed_key, updated_at) VALUES ('u-sam', 'openai', 'https://api.example.com/v1', 'chat-1', 'v1:sealed', ?)",
  ).run(NOW);
}

function addChat(db: Db, id: string, spaceId: string, userId: string, title = "Plan the week"): void {
  db.prepare("INSERT INTO chats (id, space_id, user_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run(
    id,
    spaceId,
    userId,
    title,
    NOW,
    NOW,
  );
}

function addEntry(db: Db, chatId: string, seq: number, spaceId: string, userId: string, kind = "user", data = '{"text":"Hello"}'): void {
  db.prepare("INSERT INTO chat_entries (chat_id, seq, space_id, user_id, kind, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    chatId,
    seq,
    spaceId,
    userId,
    kind,
    data,
    NOW,
  );
}

describe("migration 8 on a database that migration 7 made", () => {
  it("applies with data in place, leaves that data as it was and starts with no conversation", () => {
    const path = join(mkdtempSync(join(tmpdir(), "hearth-migrate-")), "hearth.db");
    let db = openDatabase(path);
    expect(migrate(db, upTo(7)).map((migration) => migration.id)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    releaseBefore(db);
    const before = Object.fromEntries(tables(db).filter((table) => table !== "migrations").map((table) => [table, all(db, `SELECT * FROM ${table} ORDER BY rowid`)]));
    db.close();

    // The release with the chat's history starts on the same file.
    db = openDatabase(path);
    try {
      expect(migrate(db, upTo(8)).map((migration) => migration.id)).toEqual([8]);
      expect(all(db, "SELECT id, name FROM migrations ORDER BY id")).toEqual(upTo(8).map(({ id, name }) => ({ id, name })));
      for (const [table, rows] of Object.entries(before)) {
        expect(all(db, `SELECT * FROM ${table} ORDER BY rowid`), table).toEqual(rows);
      }
      expect(count(db, "chats")).toBe(0);
      expect(count(db, "chat_entries")).toBe(0);
      expect(all(db, "PRAGMA foreign_key_check")).toEqual([]);
      expect(db.pragma("integrity_check", { simple: true })).toBe("ok");

      // The people from before can keep conversations at once.
      addChat(db, "c-1", "family", "u-lin");
      addEntry(db, "c-1", 1, "family", "u-lin");
      expect(count(db, "chat_entries")).toBe(1);
    } finally {
      db.close();
    }
  });

  it("gives the same schema as a new database", () => {
    const fresh = openDatabase(":memory:");
    migrate(fresh);
    const upgraded = openDatabase(":memory:");
    migrate(upgraded, upTo(7));
    releaseBefore(upgraded);
    migrate(upgraded);
    expect(schema(upgraded)).toEqual(schema(fresh));
  });
});

/** A request of the model's to delete rows, as src/model/confirmations.ts keeps one. */
function addRequest(
  db: Db,
  id: string,
  chat: { chatId: string; spaceId: string; userId: string },
  options: { appId?: string; rowIds?: string; status?: string; deleted?: number | null } = {},
): void {
  db.prepare(
    `INSERT INTO chat_confirmations (id, chat_id, space_id, user_id, app_id, collection, row_ids, status, deleted, created_at, decided_at)
     VALUES (?, ?, ?, ?, ?, 'items', ?, ?, ?, ?, NULL)`,
  ).run(
    id,
    chat.chatId,
    chat.spaceId,
    chat.userId,
    options.appId ?? "m-list",
    options.rowIds ?? '["row-1"]',
    options.status ?? "pending",
    options.deleted ?? null,
    NOW,
  );
}

describe("migration 9 on a database that migration 8 made", () => {
  it("applies with conversations in place, leaves them as they were and starts with no request", () => {
    const path = join(mkdtempSync(join(tmpdir(), "hearth-migrate-")), "hearth.db");
    let db = openDatabase(path);
    expect(migrate(db, upTo(8)).map((migration) => migration.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    releaseBefore(db);
    addChat(db, "c-1", "family", "u-lin");
    addEntry(db, "c-1", 1, "family", "u-lin");
    addEntry(db, "c-1", 2, "family", "u-lin", "action", '{"action":"row_added","appId":"m-list","appName":"List"}');
    const before = Object.fromEntries(tables(db).filter((table) => table !== "migrations").map((table) => [table, all(db, `SELECT * FROM ${table} ORDER BY rowid`)]));
    db.close();

    // The release that asks before deleting starts on the same file.
    db = openDatabase(path);
    try {
      expect(migrate(db).map((migration) => migration.id)).toEqual([9]);
      expect(all(db, "SELECT id, name FROM migrations ORDER BY id")).toEqual(MIGRATIONS.map(({ id, name }) => ({ id, name })));
      for (const [table, rows] of Object.entries(before)) {
        expect(all(db, `SELECT * FROM ${table} ORDER BY rowid`), table).toEqual(rows);
      }
      expect(count(db, "chat_confirmations")).toBe(0);
      expect(all(db, "PRAGMA foreign_key_check")).toEqual([]);
      expect(db.pragma("integrity_check", { simple: true })).toBe("ok");

      // A conversation from before can hold a request at once.
      addRequest(db, "r-1", { chatId: "c-1", spaceId: "family", userId: "u-lin" });
      expect(count(db, "chat_confirmations")).toBe(1);
    } finally {
      db.close();
    }
  });

  it("gives the same schema as a new database", () => {
    const fresh = openDatabase(":memory:");
    migrate(fresh);
    const upgraded = openDatabase(":memory:");
    migrate(upgraded, upTo(8));
    releaseBefore(upgraded);
    addChat(upgraded, "c-1", "family", "u-lin");
    migrate(upgraded);
    expect(schema(upgraded)).toEqual(schema(fresh));
  });
});

describe("chat_confirmations", () => {
  function world() {
    const db = openDatabase(":memory:");
    migrate(db);
    releaseBefore(db);
    addChat(db, "c-sam", "family", "u-sam");
    addChat(db, "c-lin", "family", "u-lin");
    return db;
  }
  const sams = { chatId: "c-sam", spaceId: "family", userId: "u-sam" };

  it("belong to a conversation, with its own space and person, and to nothing else", () => {
    const db = world();
    addRequest(db, "r-1", sams);
    // Lin's conversation is not Sam's; Sam's conversation is not in his personal space; c-none is no conversation.
    expect(() => addRequest(db, "r-2", { ...sams, userId: "u-lin" })).toThrow(/FOREIGN KEY/);
    expect(() => addRequest(db, "r-3", { ...sams, spaceId: "s-sam" })).toThrow(/FOREIGN KEY/);
    expect(() => addRequest(db, "r-4", { ...sams, chatId: "c-none" })).toThrow(/FOREIGN KEY/);
    expect(() => addRequest(db, "r-1", sams)).toThrow(/UNIQUE|PRIMARY KEY/);
  });

  it("accept only the statuses, lists of rows and counts the contract names", () => {
    const db = world();
    for (const [index, status] of ["pending", "confirmed", "declined", "expired"].entries()) addRequest(db, `r-${index}`, sams, { status });
    expect(() => addRequest(db, "r-x", sams, { status: "done" })).toThrow(/CHECK/);
    expect(() => addRequest(db, "r-y", sams, { rowIds: "not json" })).toThrow(/CHECK/);
    expect(() => addRequest(db, "r-z", sams, { status: "confirmed", deleted: -1 })).toThrow(/CHECK/);
  });

  it("go with their conversation, and when their person leaves the space, and nothing else goes", () => {
    const db = world();
    addRequest(db, "r-sam", sams);
    addRequest(db, "r-lin", { chatId: "c-lin", spaceId: "family", userId: "u-lin" });
    db.prepare("DELETE FROM space_members WHERE space_id = 'family' AND user_id = 'u-lin'").run();
    expect(all(db, "SELECT id FROM chat_confirmations")).toEqual([{ id: "r-sam" }]);
    db.prepare("DELETE FROM chats WHERE id = 'c-sam'").run();
    expect(count(db, "chat_confirmations")).toBe(0);
    expect(count(db, "app_rows")).toBe(1);
  });

  it("outlive the app they name, and stay where they were asked when it moves", () => {
    const db = world();
    addRequest(db, "r-sam", sams);
    // Moving the app to Sam's own space changes nothing about the request.
    db.prepare("DELETE FROM app_rows WHERE app_id = 'm-list'").run();
    db.prepare("UPDATE space_apps SET space_id = 's-sam' WHERE space_id = 'family' AND app_id = 'm-list'").run();
    expect(all(db, "SELECT space_id AS spaceId, app_id AS appId FROM chat_confirmations")).toEqual([{ spaceId: "family", appId: "m-list" }]);
    // Deleting it leaves the request, which the code marks expired.
    db.prepare("DELETE FROM space_apps WHERE app_id = 'm-list'").run();
    expect(count(db, "made_apps")).toBe(0);
    expect(count(db, "chat_confirmations")).toBe(1);
  });

  it("can be read for one conversation, and for one app in a space, through an index", () => {
    const db = world();
    const plan = (sql: string) => (all(db, `EXPLAIN QUERY PLAN ${sql}`) as { detail: string }[]).map((step) => step.detail).join("\n");
    expect(plan("SELECT id FROM chat_confirmations WHERE chat_id = 'c-sam' AND space_id = 'family' AND user_id = 'u-sam'")).toMatch(
      /USING INDEX chat_confirmations_of_chat/,
    );
    expect(plan("SELECT id FROM chat_confirmations WHERE space_id = 'family' AND app_id = 'm-list' AND status = 'pending'")).toMatch(
      /USING INDEX chat_confirmations_of_app/,
    );
  });
});

describe("chats and chat_entries", () => {
  function world() {
    const db = openDatabase(":memory:");
    migrate(db);
    releaseBefore(db);
    return db;
  }

  it("belong to a person in the space, and to nobody outside it", () => {
    const db = world();
    addChat(db, "c-sam", "family", "u-sam");
    // Lin is not in Sam's personal space, and nobody is on the server as u-kim.
    expect(() => addChat(db, "c-1", "s-sam", "u-lin")).toThrow(/FOREIGN KEY/);
    expect(() => addChat(db, "c-2", "family", "u-kim")).toThrow(/FOREIGN KEY/);
  });

  it("keep an entry only with its own conversation's space and person", () => {
    const db = world();
    addChat(db, "c-sam", "family", "u-sam");
    addEntry(db, "c-sam", 1, "family", "u-sam");
    expect(() => addEntry(db, "c-sam", 2, "family", "u-lin")).toThrow(/FOREIGN KEY/);
    expect(() => addEntry(db, "c-sam", 2, "s-sam", "u-sam")).toThrow(/FOREIGN KEY/);
    expect(() => addEntry(db, "c-none", 1, "family", "u-sam")).toThrow(/FOREIGN KEY/);
    // One entry for each place in the order.
    expect(() => addEntry(db, "c-sam", 1, "family", "u-sam")).toThrow(/UNIQUE/);
  });

  it("accept only the kinds, titles, places and data the contract names", () => {
    const db = world();
    expect(() => addChat(db, "c-1", "family", "u-sam", "")).toThrow(/CHECK/);
    expect(() => addChat(db, "c-1", "family", "u-sam", "x".repeat(201))).toThrow(/CHECK/);
    addChat(db, "c-1", "family", "u-sam", "x".repeat(200));
    expect(() => addEntry(db, "c-1", 0, "family", "u-sam")).toThrow(/CHECK/);
    expect(() => addEntry(db, "c-1", 1, "family", "u-sam", "assistant")).toThrow(/CHECK/);
    expect(() => addEntry(db, "c-1", 1, "family", "u-sam", "user", "not json")).toThrow(/CHECK/);
    for (const [seq, kind] of ["user", "model", "action", "failure"].entries()) addEntry(db, "c-1", seq + 1, "family", "u-sam", kind);
  });

  it("go with their person's place in the space, and with their conversation, and nothing else goes", () => {
    const db = world();
    addChat(db, "c-sam", "family", "u-sam");
    addEntry(db, "c-sam", 1, "family", "u-sam");
    addChat(db, "c-lin", "family", "u-lin");
    addEntry(db, "c-lin", 1, "family", "u-lin");
    addChat(db, "c-lin-own", "s-lin", "u-lin");
    addEntry(db, "c-lin-own", 1, "s-lin", "u-lin");

    db.prepare("DELETE FROM space_members WHERE space_id = 'family' AND user_id = 'u-lin'").run();
    expect(all(db, "SELECT id FROM chats ORDER BY id")).toEqual([{ id: "c-lin-own" }, { id: "c-sam" }]);
    expect(all(db, "SELECT chat_id AS chatId FROM chat_entries ORDER BY chat_id")).toEqual([{ chatId: "c-lin-own" }, { chatId: "c-sam" }]);
    // What Lin wrote in the group's apps stays.
    expect(count(db, "app_rows")).toBe(1);

    db.prepare("DELETE FROM chats WHERE id = 'c-sam'").run();
    expect(all(db, "SELECT chat_id AS chatId FROM chat_entries")).toEqual([{ chatId: "c-lin-own" }]);
  });

  it("can be listed for one person in one space, newest first, through an index", () => {
    const db = world();
    const plan = all(
      db,
      "EXPLAIN QUERY PLAN SELECT id FROM chats WHERE space_id = 'family' AND user_id = 'u-sam' ORDER BY updated_at DESC, id",
    ) as { detail: string }[];
    expect(plan.map((step) => step.detail).join("\n")).toMatch(/USING INDEX chats_of_person/);
  });
});
