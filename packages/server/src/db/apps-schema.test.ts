/**
 * Migrations 2 and 3: the tables behind apps in spaces
 * (docs/mini-app-contract.md, section A5) and their jobs' status (section
 * C, "Table"), tested as SQL. The rules below are the ones the database
 * itself keeps, whatever the code above it does.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { migrate, openDatabase, type Db } from "./database";
import { MIGRATIONS } from "./migrations";
import { createUserWithPersonalSpace, listSpacesForUser } from "./people";

const NOW = "2026-01-01T00:00:00.000Z";
const LATER = "2026-02-01T00:00:00.000Z";

const all = (db: Db, sql: string, ...params: unknown[]) => db.prepare(sql).all(...params);
const count = (db: Db, table: string, where = "1 = 1", ...params: unknown[]) =>
  (db.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${where}`).get(...params) as { n: number })
    .n;
const schema = (db: Db) => all(db, "SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name");

/** A database with two people, their personal spaces and one group. */
function family() {
  const db = openDatabase(":memory:");
  migrate(db);
  const sam = createUserWithPersonalSpace(db, { email: "sam@example.com", locale: "en" });
  const lin = createUserWithPersonalSpace(db, { email: "lin@example.com", locale: "zh" });
  const kim = createUserWithPersonalSpace(db, { email: "kim@example.com", locale: "en" });
  const personal = (userId: string) =>
    (
      db
        .prepare("SELECT id FROM spaces WHERE created_by = ? AND kind = 'personal'")
        .get(userId) as { id: string }
    ).id;
  db.prepare(
    "INSERT INTO spaces (id, kind, name, created_by, created_at) VALUES ('family', 'group', 'Family', ?, ?)",
  ).run(sam.id, NOW);
  const join = db.prepare(
    "INSERT INTO space_members (space_id, user_id, role, created_at) VALUES ('family', ?, ?, ?)",
  );
  join.run(sam.id, "owner", NOW);
  join.run(lin.id, "member", LATER);
  // Kim is on the server but not in the family.
  return {
    db,
    sam,
    lin,
    kim,
    family: "family",
    samsSpace: personal(sam.id),
    linsSpace: personal(lin.id),
  };
}

function addApp(db: Db, spaceId: string, appId: string, createdBy: string): void {
  db.prepare(
    "INSERT INTO space_apps (space_id, app_id, created_by, created_at) VALUES (?, ?, ?, ?)",
  ).run(spaceId, appId, createdBy, NOW);
}

function addRow(db: Db, id: string, spaceId: string, appId: string, createdBy: string): void {
  db.prepare(
    `INSERT INTO app_rows (id, space_id, app_id, collection, data, created_by, updated_by, created_at, updated_at)
     VALUES (?, ?, ?, 'items', '{"name":"Sample item"}', ?, ?, ?, ?)`,
  ).run(id, spaceId, appId, createdBy, createdBy, NOW, NOW);
}

function addSettings(db: Db, spaceId: string, appId: string, userId: string | null, by: string): void {
  db.prepare(
    `INSERT INTO app_settings (space_id, app_id, user_id, data, created_by, updated_by, updated_at)
     VALUES (?, ?, ?, '{"hideDone":true}', ?, ?, ?)`,
  ).run(spaceId, appId, userId, by, by, NOW);
}

function addAccess(db: Db, spaceId: string, appId: string, userId: string, by: string): void {
  db.prepare(
    `INSERT INTO app_access (space_id, app_id, user_id, level, created_by, updated_at)
     VALUES (?, ?, ?, 'view', ?, ?)`,
  ).run(spaceId, appId, userId, by, NOW);
}

function addPrefs(db: Db, spaceId: string, appId: string, userId: string): void {
  db.prepare(
    "INSERT INTO app_prefs (space_id, app_id, user_id, pinned) VALUES (?, ?, ?, 1)",
  ).run(spaceId, appId, userId);
}

/** A job's status in an install, as a run that went well leaves it. */
function addJob(db: Db, spaceId: string, appId: string, job = "refresh"): void {
  db.prepare(
    `INSERT INTO app_jobs (space_id, app_id, job, next_run_at, last_started_at, last_succeeded_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(spaceId, appId, job, LATER, NOW, NOW);
}

/** The migrations up to this one, as an earlier release had them. */
const upTo = (id: number) => MIGRATIONS.filter((migration) => migration.id <= id);

describe("migration 2 on a database that migration 1 made", () => {
  it("applies with data in place and leaves that data as it was", () => {
    const path = join(mkdtempSync(join(tmpdir(), "hearth-migrate-")), "hearth.db");

    // What a server of the previous release leaves behind, written with the
    // statements that release used.
    let db = openDatabase(path);
    expect(migrate(db, upTo(1)).map((migration) => migration.id)).toEqual([1]);
    const user = db.prepare(
      "INSERT INTO users (id, email, name, locale, theme, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    );
    const space = db.prepare(
      "INSERT INTO spaces (id, kind, name, created_by, created_at) VALUES (?, ?, ?, ?, ?)",
    );
    const member = db.prepare(
      "INSERT INTO space_members (space_id, user_id, role, created_at) VALUES (?, ?, ?, ?)",
    );
    user.run("u-sam", "sam@example.com", "Sam Example", "en", "dark", NOW);
    user.run("u-lin", "lin@example.com", "Lin Example", "zh", "system", LATER);
    space.run("s-sam", "personal", "", "u-sam", NOW);
    space.run("s-lin", "personal", "", "u-lin", LATER);
    member.run("s-sam", "u-sam", "owner", NOW);
    member.run("s-lin", "u-lin", "owner", LATER);
    db.prepare("INSERT INTO invitations (email, invited_by, created_at) VALUES (?, ?, ?)").run(
      "kim@example.com",
      "u-sam",
      NOW,
    );
    const before = {
      users: all(db, "SELECT * FROM users ORDER BY id"),
      spaces: all(db, "SELECT * FROM spaces ORDER BY id"),
      members: all(db, "SELECT * FROM space_members ORDER BY space_id"),
      invitations: all(db, "SELECT * FROM invitations"),
    };
    db.close();

    // The release with migration 2 starts on the same file.
    db = openDatabase(path);
    try {
      expect(migrate(db, upTo(2)).map((migration) => migration.id)).toEqual([2]);
      expect(all(db, "SELECT id, name FROM migrations ORDER BY id")).toEqual(
        upTo(2).map(({ id, name }) => ({ id, name })),
      );

      expect(all(db, "SELECT * FROM users ORDER BY id")).toEqual(before.users);
      expect(all(db, "SELECT * FROM spaces ORDER BY id")).toEqual(before.spaces);
      expect(all(db, "SELECT * FROM invitations")).toEqual(before.invitations);
      // Members keep what they had and gain the new column, switched off.
      expect(all(db, "SELECT * FROM space_members ORDER BY space_id")).toEqual(
        before.members.map((row) => ({ ...(row as object), can_add_apps: 0 })),
      );

      expect(all(db, "PRAGMA foreign_key_check")).toEqual([]);
      expect(db.pragma("integrity_check", { simple: true })).toBe("ok");

      // The code of this release reads the old rows.
      expect(listSpacesForUser(db, "u-lin")).toEqual([
        {
          id: "s-lin",
          kind: "personal",
          name: "",
          role: "owner",
          canAddApps: true,
          members: [{ id: "u-lin", name: "Lin Example", role: "owner" }],
        },
      ]);

      // And the old rows can be built on: a person from before gets an app with a row.
      addApp(db, "s-sam", "checklist", "u-sam");
      addRow(db, "row-1", "s-sam", "checklist", "u-sam");
      expect(count(db, "app_rows")).toBe(1);
    } finally {
      db.close();
    }
  });

  it("gives a new database the same schema as one migrated in two starts", () => {
    const inOneStart = openDatabase(":memory:");
    migrate(inOneStart);
    const inTwoStarts = openDatabase(":memory:");
    migrate(inTwoStarts, upTo(1));
    migrate(inTwoStarts);
    expect(schema(inTwoStarts)).toEqual(schema(inOneStart));
  });

  it("gives a new database the same schema as one migrated a release at a time", () => {
    const inOneStart = openDatabase(":memory:");
    migrate(inOneStart);
    const releaseByRelease = openDatabase(":memory:");
    for (const { id } of MIGRATIONS) {
      expect(migrate(releaseByRelease, upTo(id)).map((migration) => migration.id)).toEqual([id]);
    }
    expect(schema(releaseByRelease)).toEqual(schema(inOneStart));
  });
});

describe("migration 3 on a database that migration 2 made", () => {
  it("applies with data in place, leaves that data as it was, and starts every job afresh", () => {
    const path = join(mkdtempSync(join(tmpdir(), "hearth-migrate-")), "hearth.db");

    // What a server of the release before jobs leaves behind: people, a group,
    // apps in spaces (one of them removed), their rows, settings, access,
    // switches and an invitation, written with the statements that release used.
    let db = openDatabase(path);
    expect(migrate(db, upTo(2)).map((migration) => migration.id)).toEqual([1, 2]);
    const user = db.prepare(
      "INSERT INTO users (id, email, name, locale, theme, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    );
    const space = db.prepare(
      "INSERT INTO spaces (id, kind, name, created_by, created_at) VALUES (?, ?, ?, ?, ?)",
    );
    const member = db.prepare(
      "INSERT INTO space_members (space_id, user_id, role, can_add_apps, created_at) VALUES (?, ?, ?, ?, ?)",
    );
    user.run("u-sam", "sam@example.com", "Sam Example", "en", "dark", NOW);
    user.run("u-lin", "lin@example.com", "Lin Example", "zh", "system", LATER);
    space.run("s-sam", "personal", "", "u-sam", NOW);
    space.run("s-lin", "personal", "", "u-lin", LATER);
    space.run("family", "group", "Family", "u-sam", NOW);
    member.run("s-sam", "u-sam", "owner", 0, NOW);
    member.run("s-lin", "u-lin", "owner", 0, LATER);
    member.run("family", "u-sam", "owner", 0, NOW);
    member.run("family", "u-lin", "member", 1, LATER);
    addApp(db, "family", "checklist", "u-sam");
    addApp(db, "family", "feed", "u-lin");
    db.prepare("UPDATE space_apps SET removed_at = ? WHERE space_id = 'family' AND app_id = 'feed'").run(LATER);
    addRow(db, "row-1", "family", "checklist", "u-lin");
    addRow(db, "row-2", "family", "feed", "u-sam");
    addSettings(db, "family", "checklist", null, "u-sam");
    addSettings(db, "family", "checklist", "u-lin", "u-lin");
    addAccess(db, "family", "checklist", "u-lin", "u-sam");
    addPrefs(db, "family", "checklist", "u-lin");
    db.prepare(
      "INSERT INTO space_invitations (space_id, email, role, invited_by, created_at) VALUES ('family', ?, 'member', ?, ?)",
    ).run("kim@example.com", "u-sam", NOW);
    const kept = [
      "users",
      "spaces",
      "space_members",
      "space_invitations",
      "invitations",
      "space_apps",
      "app_rows",
      "app_settings",
      "app_access",
      "app_prefs",
    ];
    const before = Object.fromEntries(kept.map((table) => [table, all(db, `SELECT * FROM ${table} ORDER BY rowid`)]));
    expect(before.app_rows).toHaveLength(2);
    db.close();

    // The release with jobs starts on the same file.
    db = openDatabase(path);
    try {
      expect(migrate(db).map((migration) => migration.id)).toEqual([3]);
      expect(all(db, "SELECT id, name FROM migrations ORDER BY id")).toEqual(
        MIGRATIONS.map(({ id, name }) => ({ id, name })),
      );
      for (const table of kept) {
        expect(all(db, `SELECT * FROM ${table} ORDER BY rowid`), table).toEqual(before[table]);
      }
      // No job has run anywhere yet: each runs at once, and its row is made then.
      expect(count(db, "app_jobs")).toBe(0);
      expect(all(db, "PRAGMA foreign_key_check")).toEqual([]);
      expect(db.pragma("integrity_check", { simple: true })).toBe("ok");

      // The old rows can be built on: a job's status for each install from before,
      // which follows its app when it moves and goes when the app's data is deleted.
      addJob(db, "family", "checklist");
      addJob(db, "family", "feed");
      // As moveApp does: what is about Lin, who is not in Sam's own space, goes first.
      for (const table of ["app_access", "app_prefs", "app_settings"]) {
        db.prepare(`DELETE FROM ${table} WHERE app_id = 'checklist' AND user_id = 'u-lin'`).run();
      }
      db.prepare("UPDATE space_apps SET space_id = 's-sam' WHERE space_id = 'family' AND app_id = 'checklist'").run();
      expect(all(db, "SELECT space_id AS spaceId, app_id AS appId FROM app_jobs ORDER BY app_id")).toEqual([
        { spaceId: "s-sam", appId: "checklist" },
        { spaceId: "family", appId: "feed" },
      ]);
      db.prepare("DELETE FROM app_rows WHERE space_id = 'family' AND app_id = 'feed'").run();
      db.prepare("DELETE FROM space_apps WHERE space_id = 'family' AND app_id = 'feed'").run();
      expect(all(db, "SELECT app_id AS appId FROM app_jobs")).toEqual([{ appId: "checklist" }]);
    } finally {
      db.close();
    }
  });
});

describe("app_jobs", () => {
  let f: ReturnType<typeof family>;
  beforeEach(() => {
    f = family();
    addApp(f.db, f.family, "checklist", f.sam.id);
  });

  const set = (assignments: string) =>
    f.db.prepare(`UPDATE app_jobs SET ${assignments} WHERE space_id = 'family' AND app_id = 'checklist'`).run();

  it("holds one row for each job of an app in a space", () => {
    addJob(f.db, f.family, "checklist", "refresh");
    addJob(f.db, f.family, "checklist", "tidy");
    expect(() => addJob(f.db, f.family, "checklist", "refresh")).toThrow(/UNIQUE|PRIMARY KEY/);
    expect(count(f.db, "app_jobs")).toBe(2);
  });

  it("is refused for an app the space does not have", () => {
    for (const [spaceId, appId] of [
      [f.family, "feed"],
      [f.linsSpace, "checklist"],
      ["nowhere", "checklist"],
    ] as const) {
      expect(() => addJob(f.db, spaceId, appId)).toThrow(/FOREIGN KEY/);
    }
  });

  it("holds a run's ID and its time together, failures that are not below zero and a short error", () => {
    addJob(f.db, f.family, "checklist");
    set("run_id = 'run-1', run_until = '2026-02-01T00:06:00.000Z'");
    expect(() => set("run_id = NULL")).toThrow(/CHECK/);
    expect(() => set("run_until = NULL")).toThrow(/CHECK/);
    set("run_id = NULL, run_until = NULL");
    expect(() => set("run_id = 'run-2'")).toThrow(/CHECK/);

    expect(() => set("failures = -1")).toThrow(/CHECK/);
    set("failures = 3");
    set(`last_error = '${"x".repeat(200)}'`);
    expect(() => set(`last_error = '${"x".repeat(201)}'`)).toThrow(/CHECK/);
    // Characters, not bytes: two hundred Chinese ones fit.
    set(`last_error = '${"错".repeat(200)}'`);
    expect(() => set("next_run_at = NULL")).toThrow(/NOT NULL/);
  });

  it("stays when the app is removed, and goes with the app's entry", () => {
    addJob(f.db, f.family, "checklist");
    f.db.prepare("UPDATE space_apps SET removed_at = ? WHERE space_id = 'family' AND app_id = 'checklist'").run(LATER);
    expect(count(f.db, "app_jobs")).toBe(1);
    f.db.prepare("DELETE FROM space_apps WHERE space_id = 'family' AND app_id = 'checklist'").run();
    expect(count(f.db, "app_jobs")).toBe(0);
  });
});

describe("a space keeps at least one owner", () => {
  let f: ReturnType<typeof family>;
  beforeEach(() => {
    f = family();
  });

  const setRole = (userId: string, role: string) =>
    f.db
      .prepare("UPDATE space_members SET role = ? WHERE space_id = 'family' AND user_id = ?")
      .run(role, userId);
  const leave = (userId: string) =>
    f.db.prepare("DELETE FROM space_members WHERE space_id = 'family' AND user_id = ?").run(userId);
  const owners = () =>
    (
      all(
        f.db,
        "SELECT user_id FROM space_members WHERE space_id = 'family' AND role = 'owner'",
      ) as { user_id: string }[]
    ).map((row) => row.user_id);

  it("lets a group have several owners", () => {
    setRole(f.lin.id, "owner");
    expect(owners().sort()).toEqual([f.sam.id, f.lin.id].sort());
  });

  it("refuses to remove the last owner or make them a plain member", () => {
    expect(() => leave(f.sam.id)).toThrow(/at least one owner/);
    expect(() => setRole(f.sam.id, "member")).toThrow(/at least one owner/);
    expect(owners()).toEqual([f.sam.id]);
    // A plain member comes and goes freely.
    leave(f.lin.id);
    expect(count(f.db, "space_members", "space_id = 'family'")).toBe(1);
  });

  it("lets an owner step down or leave once there is another", () => {
    setRole(f.lin.id, "owner");
    setRole(f.sam.id, "member");
    expect(owners()).toEqual([f.lin.id]);
    // Now Lin is the last one.
    expect(() => setRole(f.lin.id, "member")).toThrow(/at least one owner/);
    expect(() => leave(f.lin.id)).toThrow(/at least one owner/);

    setRole(f.sam.id, "owner");
    leave(f.lin.id);
    expect(owners()).toEqual([f.sam.id]);
  });

  it("refuses to remove every owner in one statement", () => {
    setRole(f.lin.id, "owner");
    expect(() => f.db.prepare("DELETE FROM space_members WHERE space_id = 'family'").run()).toThrow(
      /at least one owner/,
    );
    expect(() =>
      f.db.prepare("UPDATE space_members SET role = 'member' WHERE space_id = 'family'").run(),
    ).toThrow(/at least one owner/);
    expect(owners()).toHaveLength(2);
  });

  it("refuses to move the last owner's membership to another space", () => {
    expect(() =>
      f.db
        .prepare("UPDATE space_members SET space_id = ? WHERE space_id = 'family' AND user_id = ?")
        .run(f.linsSpace, f.sam.id),
    ).toThrow(/at least one owner/);
  });

  it("holds for a personal space too", () => {
    expect(() =>
      f.db.prepare("DELETE FROM space_members WHERE space_id = ?").run(f.samsSpace),
    ).toThrow(/at least one owner/);
    expect(() =>
      f.db.prepare("UPDATE space_members SET role = 'member' WHERE space_id = ?").run(f.samsSpace),
    ).toThrow(/at least one owner/);
  });

  it("refuses a plain member as the first member of a space", () => {
    f.db
      .prepare(
        "INSERT INTO spaces (id, kind, name, created_by, created_at) VALUES ('team', 'group', 'Team', ?, ?)",
      )
      .run(f.sam.id, NOW);
    const join = f.db.prepare(
      "INSERT INTO space_members (space_id, user_id, role, created_at) VALUES ('team', ?, ?, ?)",
    );
    expect(() => join.run(f.lin.id, "member", NOW)).toThrow(/first member of a space/);
    join.run(f.sam.id, "owner", NOW);
    join.run(f.lin.id, "member", NOW);
    expect(count(f.db, "space_members", "space_id = 'team'")).toBe(2);
  });

  it("does not stand in the way of deleting a space that has no apps", () => {
    f.db.prepare("DELETE FROM spaces WHERE id = 'family'").run();
    expect(count(f.db, "space_members", "space_id = 'family'")).toBe(0);
  });

  it("accepts only 0 and 1 for a member's right to add apps", () => {
    const set = f.db.prepare(
      "UPDATE space_members SET can_add_apps = ? WHERE space_id = 'family' AND user_id = ?",
    );
    set.run(1, f.lin.id);
    expect(() => set.run(2, f.lin.id)).toThrow(/CHECK/);
  });
});

describe("space_invitations", () => {
  let f: ReturnType<typeof family>;
  const invite = (email: string, extra: { role?: string; spaceId?: string; by?: string } = {}) =>
    f.db
      .prepare(
        "INSERT INTO space_invitations (space_id, email, role, invited_by, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(extra.spaceId ?? f.family, email, extra.role ?? "member", extra.by ?? f.sam.id, NOW);
  beforeEach(() => {
    f = family();
  });

  it("holds one row per address and space, saying what the person becomes", () => {
    invite("pat@example.com", { role: "owner" });
    expect(all(f.db, "SELECT role, can_add_apps FROM space_invitations")).toEqual([
      { role: "owner", can_add_apps: 0 },
    ]);
    expect(() => invite("pat@example.com")).toThrow(/UNIQUE|PRIMARY KEY/);
  });

  it("refuses an address that is not lower-case, an unknown role, space or inviter", () => {
    expect(() => invite("Pat@example.com")).toThrow(/CHECK/);
    expect(() => invite("pat@example.com", { role: "guest" })).toThrow(/CHECK/);
    expect(() => invite("pat@example.com", { spaceId: "nowhere" })).toThrow(/FOREIGN KEY/);
    expect(() => invite("pat@example.com", { by: "nobody" })).toThrow(/FOREIGN KEY/);
  });

  it("goes when its space is deleted", () => {
    invite("pat@example.com");
    f.db.prepare("DELETE FROM spaces WHERE id = 'family'").run();
    expect(count(f.db, "space_invitations")).toBe(0);
  });
});

describe("rows that belong to an app in a space", () => {
  let f: ReturnType<typeof family>;
  beforeEach(() => {
    f = family();
    addApp(f.db, f.family, "checklist", f.sam.id);
  });

  it("are refused for an app the space does not have", () => {
    const { db, sam, lin } = f;
    // The family has "checklist"; it does not have "feed", and Lin's own space has neither.
    for (const [spaceId, appId] of [
      [f.family, "feed"],
      [f.linsSpace, "checklist"],
      ["nowhere", "checklist"],
    ] as const) {
      expect(() => addRow(db, "row-x", spaceId, appId, sam.id)).toThrow(/FOREIGN KEY/);
      expect(() => addSettings(db, spaceId, appId, null, sam.id)).toThrow(/FOREIGN KEY/);
      expect(() => addSettings(db, spaceId, appId, lin.id, lin.id)).toThrow(/FOREIGN KEY/);
      expect(() => addAccess(db, spaceId, appId, lin.id, sam.id)).toThrow(/FOREIGN KEY/);
      expect(() => addPrefs(db, spaceId, appId, lin.id)).toThrow(/FOREIGN KEY/);
    }
    // The same statements pass for the app the family does have.
    addRow(db, "row-1", f.family, "checklist", sam.id);
    addSettings(db, f.family, "checklist", null, sam.id);
    addSettings(db, f.family, "checklist", lin.id, lin.id);
    addAccess(db, f.family, "checklist", lin.id, sam.id);
    addPrefs(db, f.family, "checklist", lin.id);
  });

  it("are refused for a person who is not in the space, and for an unknown author", () => {
    const { db, sam, kim } = f;
    expect(() => addAccess(db, f.family, "checklist", kim.id, sam.id)).toThrow(/FOREIGN KEY/);
    expect(() => addPrefs(db, f.family, "checklist", kim.id)).toThrow(/FOREIGN KEY/);
    expect(() => addSettings(db, f.family, "checklist", kim.id, kim.id)).toThrow(/FOREIGN KEY/);
    expect(() => addRow(db, "row-x", f.family, "checklist", "nobody")).toThrow(/FOREIGN KEY/);
    expect(() => addApp(db, f.family, "feed", "nobody")).toThrow(/FOREIGN KEY/);
    expect(() => addApp(db, "nowhere", "feed", sam.id)).toThrow(/FOREIGN KEY/);
  });

  it("follow the app when its space changes, and nothing else moves", () => {
    const { db, sam, lin } = f;
    addApp(db, f.family, "feed", sam.id);
    addApp(db, f.linsSpace, "checklist", lin.id);
    addRow(db, "family-checklist", f.family, "checklist", lin.id);
    addRow(db, "family-feed", f.family, "feed", sam.id);
    addRow(db, "lin-checklist", f.linsSpace, "checklist", lin.id);
    addSettings(db, f.family, "checklist", null, lin.id);
    addSettings(db, f.family, "checklist", sam.id, sam.id);
    addPrefs(db, f.family, "checklist", sam.id);
    addAccess(db, f.family, "feed", lin.id, sam.id);
    addJob(db, f.family, "checklist");
    addJob(db, f.family, "feed");

    db.prepare(
      "UPDATE space_apps SET space_id = ? WHERE space_id = ? AND app_id = 'checklist'",
    ).run(f.samsSpace, f.family);

    const where = (table: string, key = "rowid") =>
      all(db, `SELECT space_id, app_id FROM ${table} ORDER BY ${key}`);
    expect(all(db, "SELECT id, space_id, app_id, created_by FROM app_rows ORDER BY id")).toEqual([
      // Lin wrote it, and that stays so although the row is now in Sam's own space.
      { id: "family-checklist", space_id: f.samsSpace, app_id: "checklist", created_by: lin.id },
      { id: "family-feed", space_id: f.family, app_id: "feed", created_by: sam.id },
      { id: "lin-checklist", space_id: f.linsSpace, app_id: "checklist", created_by: lin.id },
    ]);
    expect(where("app_settings")).toEqual([
      { space_id: f.samsSpace, app_id: "checklist" },
      { space_id: f.samsSpace, app_id: "checklist" },
    ]);
    expect(where("app_prefs")).toEqual([{ space_id: f.samsSpace, app_id: "checklist" }]);
    expect(where("app_access")).toEqual([{ space_id: f.family, app_id: "feed" }]);
    // A job's status follows its app, with how its runs went.
    expect(all(db, "SELECT space_id, app_id, job, last_succeeded_at FROM app_jobs ORDER BY app_id")).toEqual([
      { space_id: f.samsSpace, app_id: "checklist", job: "refresh", last_succeeded_at: NOW },
      { space_id: f.family, app_id: "feed", job: "refresh", last_succeeded_at: NOW },
    ]);
    expect(all(db, "PRAGMA foreign_key_check")).toEqual([]);
  });

  it("stop the app from moving while they name someone who is not in the target space", () => {
    const { db, sam, lin } = f;
    const move = () =>
      db
        .prepare("UPDATE space_apps SET space_id = ? WHERE space_id = ? AND app_id = 'checklist'")
        .run(f.samsSpace, f.family);
    addRow(db, "row-1", f.family, "checklist", lin.id);

    // Lin is not in Sam's personal space, so nothing about Lin as a person may arrive there.
    addPrefs(db, f.family, "checklist", lin.id);
    expect(move).toThrow(/FOREIGN KEY/);
    db.prepare("DELETE FROM app_prefs WHERE user_id = ?").run(lin.id);

    addAccess(db, f.family, "checklist", lin.id, sam.id);
    expect(move).toThrow(/FOREIGN KEY/);
    db.prepare("DELETE FROM app_access WHERE user_id = ?").run(lin.id);

    addSettings(db, f.family, "checklist", lin.id, lin.id);
    expect(move).toThrow(/FOREIGN KEY/);
    // A refused move leaves everything where it was.
    expect(count(db, "app_rows", "space_id = ?", f.family)).toBe(1);
    db.prepare("DELETE FROM app_settings WHERE user_id = ?").run(lin.id);

    // The row Lin wrote is data of the app, not about Lin, and goes along.
    move();
    expect(count(db, "app_rows", "space_id = ?", f.samsSpace)).toBe(1);
  });

  it("cannot be moved into a space that already has the app", () => {
    addApp(f.db, f.samsSpace, "checklist", f.sam.id);
    expect(() =>
      f.db
        .prepare("UPDATE space_apps SET space_id = ? WHERE space_id = ? AND app_id = 'checklist'")
        .run(f.samsSpace, f.family),
    ).toThrow(/UNIQUE|PRIMARY KEY/);
  });

  describe("keep the app's entry from being deleted", () => {
    const remove = () =>
      f.db
        .prepare("DELETE FROM space_apps WHERE space_id = ? AND app_id = 'checklist'")
        .run(f.family);

    it("while it has data", () => {
      addRow(f.db, "row-1", f.family, "checklist", f.sam.id);
      expect(remove).toThrow(/FOREIGN KEY/);
      expect(count(f.db, "app_rows")).toBe(1);
      expect(count(f.db, "space_apps", "app_id = 'checklist'")).toBe(1);

      f.db.prepare("DELETE FROM app_rows WHERE space_id = ? AND app_id = 'checklist'").run(f.family);
      remove();
      expect(count(f.db, "space_apps", "app_id = 'checklist'")).toBe(0);
    });

    it.each([
      ["the space's settings", () => null],
      ["a person's own settings", () => f.lin.id],
    ])("while it has %s", (_, userId) => {
      addSettings(f.db, f.family, "checklist", userId(), f.lin.id);
      expect(remove).toThrow(/FOREIGN KEY/);
      expect(count(f.db, "app_settings")).toBe(1);

      f.db
        .prepare("DELETE FROM app_settings WHERE space_id = ? AND app_id = 'checklist'")
        .run(f.family);
      remove();
      expect(count(f.db, "space_apps", "app_id = 'checklist'")).toBe(0);
    });

    it("but not by access rows, a person's switch or a job's status, which go with it", () => {
      addAccess(f.db, f.family, "checklist", f.lin.id, f.sam.id);
      addPrefs(f.db, f.family, "checklist", f.lin.id);
      addJob(f.db, f.family, "checklist");
      remove();
      expect(count(f.db, "space_apps", "app_id = 'checklist'")).toBe(0);
      expect(count(f.db, "app_access")).toBe(0);
      expect(count(f.db, "app_prefs")).toBe(0);
      expect(count(f.db, "app_jobs")).toBe(0);
    });
  });

  it("keep their space from being deleted", () => {
    expect(() => f.db.prepare("DELETE FROM spaces WHERE id = 'family'").run()).toThrow(
      /FOREIGN KEY/,
    );
    expect(count(f.db, "space_members", "space_id = 'family'")).toBe(2);
  });

  it("lose what is about a person when that person leaves the space, and keep what they wrote", () => {
    const { db, sam, lin } = f;
    addRow(db, "by-lin", f.family, "checklist", lin.id);
    addSettings(db, f.family, "checklist", null, lin.id);
    addSettings(db, f.family, "checklist", lin.id, lin.id);
    addSettings(db, f.family, "checklist", sam.id, sam.id);
    addAccess(db, f.family, "checklist", lin.id, sam.id);
    addPrefs(db, f.family, "checklist", lin.id);
    addPrefs(db, f.family, "checklist", sam.id);

    db.prepare("DELETE FROM space_members WHERE space_id = ? AND user_id = ?").run(
      f.family,
      lin.id,
    );

    expect(count(db, "app_access")).toBe(0);
    expect(all(db, "SELECT user_id FROM app_prefs")).toEqual([{ user_id: sam.id }]);
    // The space's settings, which Lin last saved, and Sam's own stay; Lin's own go.
    expect(all(db, "SELECT user_id, created_by FROM app_settings ORDER BY user_id")).toEqual([
      { user_id: null, created_by: lin.id },
      { user_id: sam.id, created_by: sam.id },
    ]);
    expect(all(db, "SELECT id, created_by FROM app_rows")).toEqual([
      { id: "by-lin", created_by: lin.id },
    ]);
  });

  it("hold one settings object for the space and one per person", () => {
    const { db, sam, lin } = f;
    addSettings(db, f.family, "checklist", null, sam.id);
    addSettings(db, f.family, "checklist", sam.id, sam.id);
    addSettings(db, f.family, "checklist", lin.id, lin.id);
    expect(() => addSettings(db, f.family, "checklist", null, lin.id)).toThrow(/UNIQUE/);
    expect(() => addSettings(db, f.family, "checklist", lin.id, lin.id)).toThrow(/UNIQUE/);
    // Another app in the same space has its own.
    addApp(db, f.family, "feed", sam.id);
    addSettings(db, f.family, "feed", null, sam.id);
    expect(count(db, "app_settings")).toBe(4);
  });

  it("hold one access exception and one switch per person", () => {
    const { db, sam, lin } = f;
    addAccess(db, f.family, "checklist", lin.id, sam.id);
    addPrefs(db, f.family, "checklist", lin.id);
    expect(() => addAccess(db, f.family, "checklist", lin.id, sam.id)).toThrow(/UNIQUE|PRIMARY KEY/);
    expect(() => addPrefs(db, f.family, "checklist", lin.id)).toThrow(/UNIQUE|PRIMARY KEY/);
  });

  it("start out hidden from other members, switched on and not pinned", () => {
    const { db, lin } = f;
    expect(
      db.prepare("SELECT member_access, removed_at FROM space_apps WHERE app_id = 'checklist'").get(),
    ).toEqual({ member_access: "none", removed_at: null });
    db.prepare("INSERT INTO app_prefs (space_id, app_id, user_id) VALUES (?, 'checklist', ?)").run(
      f.family,
      lin.id,
    );
    expect(db.prepare("SELECT enabled, pinned FROM app_prefs").get()).toEqual({
      enabled: 1,
      pinned: 0,
    });
  });

  it("accept only the values the contract names", () => {
    const { db, sam, lin } = f;
    expect(() =>
      db.prepare("UPDATE space_apps SET member_access = 'admin' WHERE app_id = 'checklist'").run(),
    ).toThrow(/CHECK/);
    for (const level of ["none", "view", "edit"]) {
      db.prepare("UPDATE space_apps SET member_access = ? WHERE app_id = 'checklist'").run(level);
    }

    addAccess(db, f.family, "checklist", lin.id, sam.id);
    expect(() => db.prepare("UPDATE app_access SET level = 'owner'").run()).toThrow(/CHECK/);

    addPrefs(db, f.family, "checklist", lin.id);
    expect(() => db.prepare("UPDATE app_prefs SET enabled = 2").run()).toThrow(/CHECK/);
    expect(() => db.prepare("UPDATE app_prefs SET pinned = -1").run()).toThrow(/CHECK/);

    addRow(db, "row-1", f.family, "checklist", sam.id);
    expect(() => db.prepare("UPDATE app_rows SET data = '{not json'").run()).toThrow(/CHECK/);
    addSettings(db, f.family, "checklist", null, sam.id);
    expect(() => db.prepare("UPDATE app_settings SET data = ''").run()).toThrow(/CHECK/);
  });

  it("can be found by space, app and collection through an index", () => {
    const plan = all(
      f.db,
      `EXPLAIN QUERY PLAN
       SELECT id FROM app_rows
        WHERE space_id = 'family' AND app_id = 'checklist' AND collection = 'items'
        ORDER BY created_at, id`,
    ) as { detail: string }[];
    const detail = plan.map((step) => step.detail).join("\n");
    expect(detail).toContain("app_rows_by_scope");
    expect(detail).not.toContain("TEMP B-TREE");
  });
});

describe("every table that belongs to an app in a space", () => {
  it("names both the space and the app, and follows the app when it moves", () => {
    const db = openDatabase(":memory:");
    migrate(db);
    const tables = (
      all(db, "SELECT name FROM sqlite_master WHERE type = 'table'") as { name: string }[]
    ).map((row) => row.name);
    const scoped = tables.filter((table) => {
      const columns = (db.pragma(`table_info(${table})`) as { name: string }[]).map((c) => c.name);
      return table !== "space_apps" && columns.includes("space_id") && columns.includes("app_id");
    });
    expect(scoped.sort()).toEqual(["app_access", "app_jobs", "app_prefs", "app_rows", "app_settings"]);

    for (const table of scoped) {
      const keys = db.pragma(`foreign_key_list(${table})`) as {
        id: number;
        table: string;
        from: string;
        to: string;
        on_update: string;
      }[];
      const toApp = keys.filter((key) => key.table === "space_apps");
      expect(
        toApp.map((key) => `${key.from}->${key.to}`).sort(),
        `${table} must refer to space_apps by space and app`,
      ).toEqual(["app_id->app_id", "space_id->space_id"]);
      expect(new Set(toApp.map((key) => key.id)).size, `${table}: one composite key`).toBe(1);
      expect(
        toApp.every((key) => key.on_update === "CASCADE"),
        `${table} must follow space_apps on update`,
      ).toBe(true);
    }
  });

  it("and is cleared by a move of what is about people who are not in the new space", () => {
    // A row about a person cannot arrive in a space that person is not in, so moving an app
    // (moveApp in src/apps/installs.ts) deletes such rows first, table by table. A new table
    // about an app in a space that names a person must be added there, or every move of that
    // app out of a group fails.
    const db = openDatabase(":memory:");
    migrate(db);
    const tables = (
      all(db, "SELECT name FROM sqlite_master WHERE type = 'table'") as { name: string }[]
    ).map((row) => row.name);
    const aboutPeople = tables.filter((table) => {
      const columns = (db.pragma(`table_info(${table})`) as { name: string }[]).map((c) => c.name);
      return columns.includes("space_id") && columns.includes("app_id") && columns.includes("user_id");
    });
    expect(aboutPeople.sort(), "the tables moveApp clears of people who are not in the new space").toEqual([
      "app_access",
      "app_prefs",
      "app_settings",
    ]);
  });
});
