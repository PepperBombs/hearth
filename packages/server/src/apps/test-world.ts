/**
 * A small world for tests of apps in spaces: four people, their personal
 * spaces and one group, and apps made in Hearth to put in them. Sample data
 * only. Not part of the running server.
 */
import type { Db } from "../db/database";
import { createUserWithPersonalSpace } from "../db/people";
import { checkMadeManifest, madeManifestSchema, type MadeManifest } from "../made/manifest";
import { OWNER_EMAIL, testDatabase } from "../testing";

export const NOW = "2026-01-01T00:00:00.000Z";

export const SAM = OWNER_EMAIL;
export const LIN = "lin@example.com";
export const KIM = "kim@example.com";
export const NOA = "noa@example.com";

/**
 * Sam owns the server and the group "family". Lin is a plain member of it,
 * Kim a member who may add apps. Noa is on the server but not in the family.
 */
export function family(db: Db = testDatabase()) {
  const sam = createUserWithPersonalSpace(db, { email: SAM, locale: "en" });
  const lin = createUserWithPersonalSpace(db, { email: LIN, locale: "zh" });
  const kim = createUserWithPersonalSpace(db, { email: KIM, locale: "en" });
  const noa = createUserWithPersonalSpace(db, { email: NOA, locale: "en" });
  const personal = (userId: string) =>
    (
      db
        .prepare("SELECT id FROM spaces WHERE created_by = ? AND kind = 'personal'")
        .get(userId) as { id: string }
    ).id;
  db.prepare(
    "INSERT INTO spaces (id, kind, name, created_by, created_at) VALUES ('family', 'group', 'Family', ?, ?)",
  ).run(sam.id, "2026-01-02T00:00:00.000Z");
  const join = db.prepare(
    "INSERT INTO space_members (space_id, user_id, role, can_add_apps, created_at) VALUES ('family', ?, ?, ?, ?)",
  );
  join.run(sam.id, "owner", 0, "2026-01-02T00:00:00.000Z");
  join.run(lin.id, "member", 0, "2026-01-03T00:00:00.000Z");
  join.run(kim.id, "member", 1, "2026-01-04T00:00:00.000Z");
  return {
    db,
    sam,
    lin,
    kim,
    noa,
    family: "family",
    samsSpace: personal(sam.id),
    linsSpace: personal(lin.id),
    kimsSpace: personal(kim.id),
  };
}

/**
 * A checklist as a person's model might make it: one collection of items,
 * a setting the space shares (`sections`) and one of each person's own
 * (`hideDone`), named and described in both languages.
 */
export const CHECKLIST: MadeManifest = madeManifestSchema.parse({
  name: { en: "Checklist", zh: "清单" },
  description: { en: "A list of things to do, ticked off as you go.", zh: "一份待办清单，完成一项勾选一项。" },
  icon: "list-checks",
  color: "teal",
  size: "tall",
  collections: {
    items: {
      fields: { name: { type: "text", required: true }, section: { type: "text" }, done: { type: "boolean" } },
    },
  },
  settings: {
    sections: {
      type: "list",
      scope: "space",
      default: [],
      maxItems: 20,
      maxLength: 40,
      label: { en: "Sections", zh: "分组" },
      help: { en: "Items are grouped in this order.", zh: "事项按此顺序分组。" },
    },
    hideDone: { type: "switch", scope: "user", default: false, label: { en: "Hide ticked items", zh: "隐藏已勾选的事项" } },
  },
});

/** A journal: one collection, no settings. */
export const JOURNAL: MadeManifest = madeManifestSchema.parse({
  name: { en: "Journal", zh: "日记" },
  description: { en: "One entry a day.", zh: "每天一篇。" },
  icon: "notebook-text",
  color: "purple",
  size: "wide",
  collections: { entries: { fields: { text: { type: "text", required: true } } } },
});

/** The page of the apps made here. The tests reach their rows through the routes, as a page's bridge does. */
export const PAGE = "<!doctype html><html><head><title>Sample</title></head><body><p>A sample app.</p></body></html>";

/** What a made app's ID looks like: "m-" and ten lower-case letters or digits. */
const MADE_ID = /^m-[a-z0-9]{10}$/;

type InstallOptions = { memberAccess?: "none" | "view" | "edit"; removedAt?: string; createdAt?: string };

/**
 * Makes an app in Hearth in a space directly, as `createMadeApp` would have
 * after its checks: its manifest and page with their first version
 * (`made_apps`, `made_app_versions`), and its install (`space_apps`). The ID
 * is given, so that a test can name the app, and must look like a made
 * app's; the manifest, the checklist's unless another is given, must be one
 * `createMadeApp` takes. Who made it gets no exception of their own, as an
 * owner needs none: grant one where a test needs it.
 */
export function makeApp(
  db: Db,
  spaceId: string,
  appId: string,
  createdBy: string,
  options: InstallOptions & { manifest?: MadeManifest; html?: string } = {},
): void {
  if (!MADE_ID.test(appId)) throw new Error(`"${appId}" is not a made app's ID: "m-" and ten lower-case letters or digits.`);
  const problem = checkMadeManifest(options.manifest ?? CHECKLIST);
  if (problem !== null) throw new Error(`The manifest of "${appId}" is not one Hearth takes: ${problem}`);
  const manifest = JSON.stringify(options.manifest ?? CHECKLIST);
  const html = options.html ?? PAGE;
  const at = options.createdAt ?? NOW;
  db.transaction(() => {
    db.prepare(
      `INSERT INTO made_apps (app_id, space_id, manifest, html, version, created_by, updated_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)`,
    ).run(appId, spaceId, manifest, html, createdBy, createdBy, at, at);
    db.prepare(
      `INSERT INTO made_app_versions (app_id, version, manifest, html, note, created_by, created_at)
       VALUES (?, 1, ?, ?, '', ?, ?)`,
    ).run(appId, manifest, html, createdBy, at);
    install(db, spaceId, appId, createdBy, options);
  })();
}

/**
 * Puts an install in a space directly, as the add route would have, with
 * no app made for it: on its own, the install of an app the server holds
 * no app for, such as one a release before the built-in apps left (the
 * build's "grocery", say); after `makeApp`, the same app's install in
 * another space, which nothing in Hearth makes.
 */
export function install(db: Db, spaceId: string, appId: string, createdBy: string, options: InstallOptions = {}): void {
  db.prepare(
    `INSERT INTO space_apps (space_id, app_id, member_access, created_by, created_at, removed_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    spaceId,
    appId,
    options.memberAccess ?? "none",
    createdBy,
    options.createdAt ?? NOW,
    options.removedAt ?? null,
  );
}

/**
 * Gives a made app a manifest this release cannot read, as one a later
 * release wrote might be: the server then holds no app of that ID, and the
 * app's install and data are left alone. Returns what puts it back.
 */
export function unreadable(db: Db, appId: string): () => void {
  const { manifest } = db.prepare("SELECT manifest FROM made_apps WHERE app_id = ?").get(appId) as { manifest: string };
  const later = { ...(JSON.parse(manifest) as object), fromALaterRelease: true };
  db.prepare("UPDATE made_apps SET manifest = ? WHERE app_id = ?").run(JSON.stringify(later), appId);
  return () => {
    db.prepare("UPDATE made_apps SET manifest = ? WHERE app_id = ?").run(manifest, appId);
  };
}

/** An owner's exception for one member. */
export function grant(
  db: Db,
  spaceId: string,
  appId: string,
  userId: string,
  level: "none" | "view" | "edit",
  by: string,
): void {
  db.prepare(
    `INSERT INTO app_access (space_id, app_id, user_id, level, created_by, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(spaceId, appId, userId, level, by, NOW);
}

/** A person's own switch and pin for an app. */
export function setPrefs(
  db: Db,
  spaceId: string,
  appId: string,
  userId: string,
  prefs: { enabled: boolean; pinned: boolean },
): void {
  db.prepare(
    "INSERT INTO app_prefs (space_id, app_id, user_id, enabled, pinned) VALUES (?, ?, ?, ?, ?)",
  ).run(spaceId, appId, userId, prefs.enabled ? 1 : 0, prefs.pinned ? 1 : 0);
}

export function count(db: Db, table: string, spaceId: string, appId: string): number {
  return (
    db
      .prepare(`SELECT count(*) AS n FROM ${table} WHERE space_id = ? AND app_id = ?`)
      .get(spaceId, appId) as { n: number }
  ).n;
}
