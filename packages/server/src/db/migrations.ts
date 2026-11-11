/**
 * Schema changes, in order. Never edit or reorder one that has shipped:
 * add a new entry with the next number instead.
 *
 * They are strings in code, not .sql files, so the bundled server needs no
 * extra files beside it.
 */
export type Migration = {
  /** Positive, unique, ascending. */
  id: number;
  name: string;
  sql: string;
};

export const MIGRATIONS: readonly Migration[] = [
  {
    id: 1,
    name: "users-spaces-invitations",
    sql: `
      CREATE TABLE users (
        id         TEXT PRIMARY KEY,
        email      TEXT NOT NULL UNIQUE CHECK (email = lower(email)),
        name       TEXT NOT NULL,
        locale     TEXT NOT NULL CHECK (locale IN ('en', 'zh')),
        theme      TEXT NOT NULL CHECK (theme IN ('light', 'dark', 'system')),
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE spaces (
        id         TEXT PRIMARY KEY,
        kind       TEXT NOT NULL CHECK (kind IN ('personal', 'group')),
        name       TEXT NOT NULL,
        created_by TEXT NOT NULL REFERENCES users (id),
        created_at TEXT NOT NULL
      ) STRICT;

      -- Each person has exactly one personal space.
      CREATE UNIQUE INDEX spaces_one_personal_per_user
        ON spaces (created_by) WHERE kind = 'personal';

      CREATE TABLE space_members (
        space_id   TEXT NOT NULL REFERENCES spaces (id) ON DELETE CASCADE,
        user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        role       TEXT NOT NULL CHECK (role IN ('owner', 'member')),
        created_at TEXT NOT NULL,
        PRIMARY KEY (space_id, user_id)
      ) STRICT;

      CREATE INDEX space_members_by_user ON space_members (user_id);

      -- People the owner has allowed in. A row is removed when its person first arrives.
      CREATE TABLE invitations (
        email      TEXT PRIMARY KEY CHECK (email = lower(email)),
        invited_by TEXT NOT NULL REFERENCES users (id),
        created_at TEXT NOT NULL
      ) STRICT;
    `,
  },
];
