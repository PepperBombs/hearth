import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { MIGRATIONS, type Migration } from "./migrations";

export type Db = Database.Database;

/** Opens the SQLite file (creating its folder), or an in-memory database for ":memory:". */
export function openDatabase(path: string): Db {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  return db;
}

/**
 * Applies every migration that has not run yet, each in its own transaction,
 * and returns the ones it applied. Refuses a database that a newer build has
 * already changed, so an older build cannot run against a schema it does not know.
 */
export function migrate(db: Db, migrations: readonly Migration[] = MIGRATIONS): Migration[] {
  db.exec(`
    CREATE TABLE IF NOT EXISTS migrations (
      id         INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at TEXT NOT NULL
    ) STRICT;
  `);

  const ordered = [...migrations].sort((a, b) => a.id - b.id);
  ordered.forEach((migration, index) => {
    const previous = ordered[index - 1];
    if (!Number.isInteger(migration.id) || migration.id < 1 || previous?.id === migration.id) {
      throw new Error(`Migration IDs must be unique positive integers; found ${migration.id}.`);
    }
  });

  const applied = db.prepare("SELECT id, name FROM migrations ORDER BY id").all() as {
    id: number;
    name: string;
  }[];
  const known = new Map(ordered.map((migration) => [migration.id, migration]));
  for (const row of applied) {
    const migration = known.get(row.id);
    if (!migration) {
      throw new Error(
        `The database has migration ${row.id} (${row.name}), which this build does not know. It was probably written by a newer build.`,
      );
    }
    if (migration.name !== row.name) {
      throw new Error(
        `Migration ${row.id} is recorded as "${row.name}" but this build calls it "${migration.name}".`,
      );
    }
  }

  const done = new Set(applied.map((row) => row.id));
  const record = db.prepare("INSERT INTO migrations (id, name, applied_at) VALUES (?, ?, ?)");
  const ran: Migration[] = [];
  for (const migration of ordered) {
    if (done.has(migration.id)) continue;
    db.transaction(() => {
      db.exec(migration.sql);
      record.run(migration.id, migration.name, new Date().toISOString());
    })();
    ran.push(migration);
  }
  return ran;
}
