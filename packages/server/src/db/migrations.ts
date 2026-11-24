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
          ON UPDATE CASCADE ON DELETE CASCADE,
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
  {
    // Scheduled jobs (docs/mini-app-contract.md, section C, "Table"). Its SQL
    // is in src/apps/jobs.ts.
    id: 3,
    name: "app-jobs",
    sql: `
      -- One app's job in one space: when it runs next and how its runs went. No row: it has not
      -- run there yet. Status, not data: it follows the app to another space and goes with its entry.
      CREATE TABLE app_jobs (
        space_id          TEXT NOT NULL,
        app_id            TEXT NOT NULL,
        job               TEXT NOT NULL,     -- its name in the app's server.ts
        next_run_at       TEXT NOT NULL,
        requested_at      TEXT,              -- someone asked for a run that has not started
        run_id            TEXT,              -- the run that holds the job now
        run_until         TEXT,              -- when that run counts as lost: its start + the time limit + 1 minute
        last_started_at   TEXT,
        last_succeeded_at TEXT,              -- when the last run that went well ended
        last_failed_at    TEXT,              -- when the last run that went wrong ended
        last_error        TEXT CHECK (last_error IS NULL OR length(last_error) <= 200),
        failures          INTEGER NOT NULL DEFAULT 0 CHECK (failures >= 0),   -- in a row, for the backoff
        PRIMARY KEY (space_id, app_id, job),
        CHECK ((run_id IS NULL) = (run_until IS NULL)),
        FOREIGN KEY (space_id, app_id) REFERENCES space_apps (space_id, app_id)
          ON UPDATE CASCADE ON DELETE CASCADE
      ) STRICT;
    `,
  },
  {
    // The assistant (docs/mini-app-contract.md, section F, "The switches").
    // What it may do is worked out in VISIBLE (src/apps/installs.ts).
    id: 4,
    name: "assistant",
    sql: `
      -- What an assistant may do in the space, for the people in it: nothing, read, or read and
      -- change. Its owners choose; every space starts with nothing.
      ALTER TABLE spaces ADD COLUMN assistant TEXT NOT NULL DEFAULT 'none'
        CHECK (assistant IN ('none', 'view', 'edit'));

      -- 0 when the space's owners left the app out: an assistant gets nothing of it there.
      ALTER TABLE space_apps ADD COLUMN assistant INTEGER NOT NULL DEFAULT 1
        CHECK (assistant IN (0, 1));
    `,
  },
  {
    // Apps made in Hearth, and each person's own model (docs/platform.md).
    // Their SQL is in src/made/apps.ts and src/model/settings.ts.
    id: 5,
    name: "made-apps",
    sql: `
      -- An app made in Hearth: what it is, as a person's model wrote it. Its install is the
      -- space_apps row of the same app, so VISIBLE decides who may use it like any other app,
      -- and its rows are in app_rows. Deferred, so that the app and its install can be written
      -- in one transaction in either order; deleting the install deletes the app, which exists
      -- nowhere else.
      CREATE TABLE made_apps (
        app_id     TEXT PRIMARY KEY,
        space_id   TEXT NOT NULL,
        manifest   TEXT NOT NULL CHECK (json_valid(manifest)),
        html       TEXT NOT NULL,
        version    INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
        created_by TEXT NOT NULL REFERENCES users (id),
        updated_by TEXT NOT NULL REFERENCES users (id),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (space_id, app_id) REFERENCES space_apps (space_id, app_id)
          ON UPDATE CASCADE ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
      ) STRICT;

      -- Each person's own model: how to reach it and which one. The key is sealed with the
      -- server's secret (HEARTH_SECRET) and never leaves the server again.
      CREATE TABLE user_models (
        user_id    TEXT PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
        protocol   TEXT NOT NULL CHECK (protocol IN ('openai', 'anthropic')),
        base_url   TEXT NOT NULL,
        model      TEXT NOT NULL,
        sealed_key TEXT,
        updated_at TEXT NOT NULL
      ) STRICT;
    `,
  },
  {
    // Every version of an app made in Hearth, so that a change can be undone
    // (docs/platform.md, "Changing an app"). Its SQL is in src/made/apps.ts.
    id: 6,
    name: "made-app-versions",
    sql: `
      -- One version of a made app: what it was, who made it so, and what changed, in their words.
      -- made_apps holds the version in use; this table holds it too, and the ones before.
      CREATE TABLE made_app_versions (
        app_id     TEXT NOT NULL REFERENCES made_apps (app_id) ON DELETE CASCADE,
        version    INTEGER NOT NULL CHECK (version >= 1),
        manifest   TEXT NOT NULL CHECK (json_valid(manifest)),
        html       TEXT NOT NULL,
        note       TEXT NOT NULL DEFAULT '' CHECK (length(note) <= 200),
        created_by TEXT NOT NULL REFERENCES users (id),
        created_at TEXT NOT NULL,
        PRIMARY KEY (app_id, version)
      ) STRICT;

      -- Apps made before this have the one version they are at.
      INSERT INTO made_app_versions (app_id, version, manifest, html, note, created_by, created_at)
        SELECT app_id, version, manifest, html, '', updated_by, updated_at FROM made_apps;
    `,
  },
  {
    // The apps shipped with Hearth, which every install of the build's own
    // apps of the same name moves to (docs/platform.md, "Built-in apps").
    id: 7,
    name: "made-app-templates",
    sql: `
      -- The built-in app a made app was added from (src/made/catalog.ts), or NULL for one a model made.
      ALTER TABLE made_apps ADD COLUMN template TEXT;
      -- What the built-in app was (a hash of its manifest and page) when this copy was made or last
      -- brought up to date by Hearth; NULL once a person or their model changed the copy, which
      -- Hearth then leaves as it is (src/made/builtin.ts).
      ALTER TABLE made_apps ADD COLUMN template_hash TEXT;
    `,
  },
  {
    // The chat's history (docs/platform.md, "The chat"): each person's own
    // conversations with their model, per space. Its SQL is in src/model/chats.ts.
    id: 8,
    name: "chats",
    sql: `
      -- One conversation of a person's in a space. Only they ever read it, in a group too. It
      -- goes when they leave the space or are removed from it, as their other rows about it do.
      CREATE TABLE chats (
        id         TEXT PRIMARY KEY,
        space_id   TEXT NOT NULL,
        user_id    TEXT NOT NULL,
        title      TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,     -- when something was last said in it
        UNIQUE (id, space_id, user_id),
        FOREIGN KEY (space_id, user_id) REFERENCES space_members (space_id, user_id) ON DELETE CASCADE
      ) STRICT;

      CREATE INDEX chats_of_person ON chats (space_id, user_id, updated_at);

      -- What was said and done in a conversation, in order: the person's message, the model's
      -- text of one step, a change it made, or why a turn ended. data is the entry without its kind.
      CREATE TABLE chat_entries (
        chat_id    TEXT NOT NULL,
        seq        INTEGER NOT NULL CHECK (seq >= 1),
        space_id   TEXT NOT NULL,
        user_id    TEXT NOT NULL,
        kind       TEXT NOT NULL CHECK (kind IN ('user', 'model', 'action', 'failure')),
        data       TEXT NOT NULL CHECK (json_valid(data)),
        created_at TEXT NOT NULL,
        PRIMARY KEY (chat_id, seq),
        FOREIGN KEY (chat_id, space_id, user_id) REFERENCES chats (id, space_id, user_id) ON DELETE CASCADE
      ) STRICT;
    `,
  },
  {
    // What the model asks before it deletes (docs/platform.md, owner's decision 7): rows it
    // would delete, which go only when the person confirms. Its SQL is in src/model/confirmations.ts.
    id: 9,
    name: "chat-confirmations",
    sql: `
      -- One request of the model's to delete rows of an app, in a conversation of a person's, and
      -- where it stands. It belongs to the conversation, not to the app: it names the app by ID
      -- only, with no key to space_apps, so that it outlives the app (expired) and stays where
      -- it was asked when the app is moved. It goes with its conversation.
      CREATE TABLE chat_confirmations (
        id         TEXT PRIMARY KEY,
        chat_id    TEXT NOT NULL,
        space_id   TEXT NOT NULL,
        user_id    TEXT NOT NULL,
        app_id     TEXT NOT NULL,
        collection TEXT NOT NULL,
        row_ids    TEXT NOT NULL CHECK (json_valid(row_ids)),   -- a JSON list of the rows' IDs
        status     TEXT NOT NULL CHECK (status IN ('pending', 'confirmed', 'declined', 'expired')),
        deleted    INTEGER CHECK (deleted >= 0),                -- how many rows went, once confirmed
        created_at TEXT NOT NULL,
        decided_at TEXT,
        FOREIGN KEY (chat_id, space_id, user_id) REFERENCES chats (id, space_id, user_id) ON DELETE CASCADE
      ) STRICT;

      CREATE INDEX chat_confirmations_of_chat ON chat_confirmations (chat_id, space_id, user_id);
      CREATE INDEX chat_confirmations_of_app ON chat_confirmations (space_id, app_id, status);
    `,
  },
  {
    // The app center (docs/center.md): apps published to a group, and the copies made of them.
    // The SQL about published_apps is in src/center/published.ts, the SQL about copies in
    // src/made/apps.ts.
    id: 10,
    name: "published-apps",
    sql: `
      -- An app published to a group (docs/center.md): a snapshot of its manifest and page.
      -- It goes when its publisher leaves the group or is removed from it, and when
      -- the group is deleted, by the key to space_members, as chats do.
      CREATE TABLE published_apps (
        id              TEXT PRIMARY KEY,              -- 'p-' and 10 of [a-z0-9]
        space_id        TEXT NOT NULL,                 -- the group it is published to
        created_by      TEXT NOT NULL,                 -- the publisher
        source_space_id TEXT NOT NULL,                 -- where it was last published from, no key:
        source_app_id   TEXT NOT NULL,                 --   the source may move or go
        manifest        TEXT NOT NULL CHECK (json_valid(manifest)),
        html            TEXT NOT NULL,
        hash            TEXT NOT NULL,                 -- templateHash(manifest, html)
        revision        INTEGER NOT NULL CHECK (revision >= 1),
        note            TEXT NOT NULL CHECK (length(note) <= 200),   -- what changed, '' for none
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL,
        -- A made app's ID is unique on the server and kept when it moves, so one app has one
        -- listing per group, wherever it lives now.
        UNIQUE (space_id, source_app_id),
        FOREIGN KEY (space_id, created_by) REFERENCES space_members (space_id, user_id) ON DELETE CASCADE
      ) STRICT;

      CREATE INDEX published_apps_of_source ON published_apps (source_app_id);

      -- The published app a made app was copied from, NULL once it is unpublished.
      ALTER TABLE made_apps ADD COLUMN origin TEXT REFERENCES published_apps (id) ON DELETE SET NULL;
      -- So that unpublishing finds the copies to set NULL without reading every made app.
      CREATE INDEX made_apps_by_origin ON made_apps (origin);
      -- The hash of the snapshot it was copied from (or last updated to). It stays when the
      -- listing goes, so a copy is still known as one.
      ALTER TABLE made_apps ADD COLUMN origin_hash TEXT;
      -- The revision it was copied from (or last updated to).
      ALTER TABLE made_apps ADD COLUMN origin_revision INTEGER;
    `,
  },
];
