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
  {
    // The tables of the mini-app contract (docs/mini-app-contract.md, section A5).
    id: 2,
    name: "apps-in-spaces",
    sql: `
      -- A member whom an owner allows to add apps to the space. Owners always may.
      ALTER TABLE space_members
        ADD COLUMN can_add_apps INTEGER NOT NULL DEFAULT 0 CHECK (can_add_apps IN (0, 1));

      -- A space may have several owners and always keeps at least one: its
      -- first member is an owner, and the last owner can neither leave nor
      -- stop being one. When the space itself is deleted its row is already
      -- gone by the time its members are, and that is let through.
      CREATE TRIGGER space_members_first_is_owner
        BEFORE INSERT ON space_members
        WHEN NEW.role <> 'owner'
         AND NOT EXISTS (
               SELECT 1 FROM space_members WHERE space_id = NEW.space_id AND role = 'owner')
      BEGIN
        SELECT RAISE(ABORT, 'The first member of a space must be an owner.');
      END;

      CREATE TRIGGER space_members_keep_an_owner_on_delete
        BEFORE DELETE ON space_members
        WHEN OLD.role = 'owner'
         AND EXISTS (SELECT 1 FROM spaces WHERE id = OLD.space_id)
         AND NOT EXISTS (
               SELECT 1 FROM space_members
                WHERE space_id = OLD.space_id AND role = 'owner' AND user_id <> OLD.user_id)
      BEGIN
        SELECT RAISE(ABORT, 'A space must keep at least one owner.');
      END;

      CREATE TRIGGER space_members_keep_an_owner_on_update
        BEFORE UPDATE OF role, space_id ON space_members
        WHEN OLD.role = 'owner'
         AND (NEW.role <> 'owner' OR NEW.space_id <> OLD.space_id)
         AND NOT EXISTS (
               SELECT 1 FROM space_members
                WHERE space_id = OLD.space_id AND role = 'owner' AND user_id <> OLD.user_id)
      BEGIN
        SELECT RAISE(ABORT, 'A space must keep at least one owner.');
      END;

      -- A person added to a group before they first arrived on the server.
      -- The row says what they become when they do, and is removed then.
      CREATE TABLE space_invitations (
        space_id     TEXT NOT NULL REFERENCES spaces (id) ON DELETE CASCADE,
        email        TEXT NOT NULL CHECK (email = lower(email)),
        role         TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'member')),
        can_add_apps INTEGER NOT NULL DEFAULT 0 CHECK (can_add_apps IN (0, 1)),
        invited_by   TEXT NOT NULL REFERENCES users (id),
        created_at   TEXT NOT NULL,
        PRIMARY KEY (space_id, email)
      ) STRICT;

      -- An app added to a space: the saved setting that needs no redeploy.
      CREATE TABLE space_apps (
        -- No cascade: a space with app data is never deleted silently.
        space_id      TEXT NOT NULL REFERENCES spaces (id),
        -- The manifest's ID. There is no table of apps: code comes and goes with deploys.
        app_id        TEXT NOT NULL,
        -- What members of a group get unless app_access says otherwise.
        member_access TEXT NOT NULL DEFAULT 'none' CHECK (member_access IN ('none', 'view', 'edit')),
        created_by    TEXT NOT NULL REFERENCES users (id),
        created_at    TEXT NOT NULL,
        -- Set when the app is removed from the space. Its data is kept until deleted on purpose.
        removed_at    TEXT,
        PRIMARY KEY (space_id, app_id)
      ) STRICT;

      -- Every table below belongs to one app in one space and refers to
      -- space_apps with ON UPDATE CASCADE: moving an app to another space is
      -- one UPDATE of space_apps.space_id, which carries all of it along.
      -- Rows about one person also refer to space_members, so they go when
      -- the person leaves the space, and cannot follow an app into a space
      -- the person is not in.

      -- An owner's exception for one member. No row means space_apps.member_access.
      -- Owners always have edit.
      CREATE TABLE app_access (
        space_id   TEXT NOT NULL,
        app_id     TEXT NOT NULL,
        user_id    TEXT NOT NULL,
        level      TEXT NOT NULL CHECK (level IN ('none', 'view', 'edit')),
        created_by TEXT NOT NULL REFERENCES users (id),
        updated_at TEXT NOT NULL,
        PRIMARY KEY (space_id, app_id, user_id),
        FOREIGN KEY (space_id, app_id) REFERENCES space_apps (space_id, app_id)
          ON UPDATE CASCADE ON DELETE CASCADE,
        FOREIGN KEY (space_id, user_id) REFERENCES space_members (space_id, user_id)
          ON DELETE CASCADE
      ) STRICT;

      -- Each person's own switch and pin. No row means switched on and not pinned.
      CREATE TABLE app_prefs (
        space_id TEXT NOT NULL,
        app_id   TEXT NOT NULL,
        user_id  TEXT NOT NULL,
        enabled  INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        pinned   INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
        PRIMARY KEY (space_id, app_id, user_id),
        FOREIGN KEY (space_id, app_id) REFERENCES space_apps (space_id, app_id)
          ON DELETE CASCADE,
        FOREIGN KEY (space_id, user_id) REFERENCES space_members (space_id, user_id)
          ON DELETE CASCADE
      ) STRICT;

      -- Settings values: one JSON object for the space (user_id NULL) and one per person.
      -- RESTRICT: deleting a space_apps row cannot wipe settings by accident.
      CREATE TABLE app_settings (
        space_id   TEXT NOT NULL,
        app_id     TEXT NOT NULL,
        user_id    TEXT,
        data       TEXT NOT NULL CHECK (json_valid(data)),
        created_by TEXT NOT NULL REFERENCES users (id),
        updated_by TEXT NOT NULL REFERENCES users (id),
        updated_at TEXT NOT NULL,
        FOREIGN KEY (space_id, app_id) REFERENCES space_apps (space_id, app_id)
          ON UPDATE CASCADE ON DELETE RESTRICT,
        FOREIGN KEY (space_id, user_id) REFERENCES space_members (space_id, user_id)
          ON DELETE CASCADE
      ) STRICT;

      CREATE UNIQUE INDEX app_settings_one
        ON app_settings (space_id, app_id, coalesce(user_id, ''));

      -- Every mini-app's data, one JSON document per row.
      -- RESTRICT: deleting a space_apps row cannot wipe data by accident.
      CREATE TABLE app_rows (
        id         TEXT PRIMARY KEY,
        space_id   TEXT NOT NULL,
        app_id     TEXT NOT NULL,
        collection TEXT NOT NULL,
        data       TEXT NOT NULL CHECK (json_valid(data)),
        created_by TEXT NOT NULL REFERENCES users (id),
        updated_by TEXT NOT NULL REFERENCES users (id),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (space_id, app_id) REFERENCES space_apps (space_id, app_id)
          ON UPDATE CASCADE ON DELETE RESTRICT
      ) STRICT;

      CREATE INDEX app_rows_by_scope ON app_rows (space_id, app_id, collection, created_at, id);
    `,
  },
];
