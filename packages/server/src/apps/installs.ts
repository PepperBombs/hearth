/**
 * Apps in spaces: who may use which app where, and adding, removing and
 * deleting them. An app in a space is a row in `space_apps`, called an
 * install here.
 *
 * Every function names its space, and every answer about access comes from
 * one piece of SQL (`VISIBLE`), so the session, the routes and whatever is
 * added later cannot disagree about who sees what.
 *
 * Design: docs/mini-app-contract.md, section A6.
 */
import type {
  AccessLevel,
  AppPrefsPatch,
  AppSummary,
  MemberAccess,
  SpaceKind,
  SpaceRole,
} from "@hearth/shared";
import type { Db } from "../db/database";
import { notFound, Refusal } from "../http/errors";
import type { Registry } from "./registry";
import { deleteAllData } from "./store";

/**
 * The installs a person can reach and what they may do with each: one row
 * for every app that is in a space they belong to and has not been removed.
 * An owner of the space has "edit". A member has the exception an owner
 * made for them, or else what the app gives every member; that may be
 * "none". Their own switch and pin come along, defaulting to on and unpinned.
 *
 * Callers add conditions and an order, and drop apps the server has no code for.
 */
const VISIBLE = `
  SELECT a.space_id AS spaceId,
         a.app_id AS appId,
         CASE WHEN m.role = 'owner' THEN 'edit' ELSE coalesce(x.level, a.member_access) END AS access,
         coalesce(p.enabled, 1) AS enabled,
         coalesce(p.pinned, 0) AS pinned
    FROM space_members m
    JOIN spaces s ON s.id = m.space_id
    JOIN space_apps a ON a.space_id = m.space_id AND a.removed_at IS NULL
    LEFT JOIN app_access x
           ON x.space_id = a.space_id AND x.app_id = a.app_id AND x.user_id = m.user_id
    LEFT JOIN app_prefs p
           ON p.space_id = a.space_id AND p.app_id = a.app_id AND p.user_id = m.user_id
   WHERE m.user_id = @userId`;

type VisibleRow = {
  spaceId: string;
  appId: string;
  access: MemberAccess;
  enabled: 0 | 1;
  pinned: 0 | 1;
};

/**
 * What a person may do with an app in a space: "view", "edit", or null.
 *
 * Null means the app is not there for them, whatever the reason: they are
 * not in the space, the space does not have the app, the app was removed
 * from it, the server holds no code for it, or their access is "none".
 * Every route about one app answers 404 `not_found` for null, so that none
 * of those reasons can be told apart.
 */
export function resolveInstall(
  db: Db,
  registry: Registry,
  userId: string,
  spaceId: string,
  appId: string,
): AccessLevel | null {
  if (!registry.has(appId)) return null;
  const row = db
    .prepare(`${VISIBLE} AND a.space_id = @spaceId AND a.app_id = @appId`)
    .get({ userId, spaceId, appId }) as VisibleRow | undefined;
  if (!row || row.access === "none") return null;
  return row.access;
}

/**
 * Every app a person can reach, for the session: their personal space
 * first, then groups from oldest to newest, and within a space in the order
 * the apps were added. An app the person switched off is still listed, with
 * `enabled: false`, so that they can switch it back on.
 */
export function listAppsForUser(db: Db, registry: Registry, userId: string): AppSummary[] {
  const rows = db
    .prepare(
      `${VISIBLE}
        ORDER BY CASE s.kind WHEN 'personal' THEN 0 ELSE 1 END, s.created_at, s.id,
                 a.created_at, a.app_id`,
    )
    .all({ userId }) as VisibleRow[];

  const apps: AppSummary[] = [];
  for (const row of rows) {
    const app = registry.get(row.appId);
    if (!app || row.access === "none") continue;
    const { manifest } = app;
    apps.push({
      id: row.appId,
      spaceId: row.spaceId,
      name: { en: manifest.name.en, zh: manifest.name.zh },
      description: { en: manifest.description.en, zh: manifest.description.zh },
      icon: manifest.icon,
      color: manifest.color,
      widgetSize: manifest.widget.size,
      access: row.access,
      enabled: row.enabled === 1,
      pinned: row.pinned === 1,
      hasPage: app.hasPage,
    });
  }
  return apps;
}

type Membership = { role: SpaceRole; canAddApps: 0 | 1; kind: SpaceKind };

/** The person's place in a space, or null when they are not in it or it does not exist. */
function membershipOf(db: Db, userId: string, spaceId: string): Membership | null {
  const row = db
    .prepare(
      `SELECT m.role, m.can_add_apps AS canAddApps, s.kind
         FROM space_members m
         JOIN spaces s ON s.id = m.space_id
        WHERE m.space_id = ? AND m.user_id = ?`,
    )
    .get(spaceId, userId) as Membership | undefined;
  return row ?? null;
}

type InstallRow = { memberAccess: MemberAccess; removedAt: string | null };

/** The space's entry for an app, removed or not, or null when it never had one. */
function installOf(db: Db, spaceId: string, appId: string): InstallRow | null {
  const row = db
    .prepare(
      `SELECT member_access AS memberAccess, removed_at AS removedAt
         FROM space_apps
        WHERE space_id = ? AND app_id = ?`,
    )
    .get(spaceId, appId) as InstallRow | undefined;
  return row ?? null;
}

export type AppRequest = { userId: string; spaceId: string; appId: string };

/**
 * Adds an app to a space, or brings a removed one back with the data it had.
 *
 * Owners may, and members an owner has allowed to add apps. `memberAccess`
 * is what the other members of a group get, "none" when left out: the
 * person adding the app is asked, and nothing is shared by default.
 *
 * - A member who adds an app gets an exception giving them "edit", so the
 *   app is theirs to use whatever the others get.
 * - Bringing a removed app back is for owners, because its data comes back
 *   with it, and access starts afresh: `memberAccess` as given, and no
 *   exceptions from before. Each person's own switch, pin and settings stay.
 * - An app that is already there is left exactly as it is. Asking for a
 *   different `memberAccess` is refused; changing access is its own action.
 *
 * Throws a Refusal: 404 when the person is not in the space or the server
 * has no app of this name, 403 when they may not add apps here, 409 when the
 * app cannot be added as things stand.
 */
export function addApp(
  db: Db,
  registry: Registry,
  request: AppRequest & { memberAccess?: MemberAccess },
): "added" | "restored" | "unchanged" {
  const { userId, spaceId, appId } = request;
  return db
    .transaction(() => {
      const member = membershipOf(db, userId, spaceId);
      if (!member) throw notFound();
      const isOwner = member.role === "owner";
      if (!isOwner && member.canAddApps !== 1) {
        throw new Refusal(403, "forbidden", "Adding apps to this space is for its owners and the members they allow.");
      }
      const app = registry.get(appId);
      if (!app) throw notFound();
      if (app.manifest.spaces && !app.manifest.spaces.includes(member.kind)) {
        throw new Refusal(409, "conflict", `This app cannot be added to a ${member.kind} space.`);
      }

      const now = new Date().toISOString();
      const install = installOf(db, spaceId, appId);

      if (!install) {
        db.prepare(
          `INSERT INTO space_apps (space_id, app_id, member_access, created_by, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        ).run(spaceId, appId, request.memberAccess ?? "none", userId, now);
        if (!isOwner) {
          db.prepare(
            `INSERT INTO app_access (space_id, app_id, user_id, level, created_by, updated_at)
             VALUES (?, ?, ?, 'edit', ?, ?)`,
          ).run(spaceId, appId, userId, userId, now);
        }
        return "added";
      }

      // The space has an entry that this member cannot see: the app is there
      // but not for them, or it was removed and its data kept. Either way it
      // is not theirs to add, and the answer does not say which.
      if (!isOwner && resolveInstall(db, registry, userId, spaceId, appId) === null) {
        throw new Refusal(409, "conflict", "This app cannot be added to this space by a member. Ask an owner.");
      }

      if (install.removedAt === null) {
        if (request.memberAccess !== undefined && request.memberAccess !== install.memberAccess) {
          throw new Refusal(409, "conflict", "This app is already in this space. Change who can use it instead.");
        }
        return "unchanged";
      }

      // Only an owner gets here: a removed app is visible to nobody else.
      db.prepare("DELETE FROM app_access WHERE space_id = ? AND app_id = ?").run(spaceId, appId);
      db.prepare(
        `UPDATE space_apps SET removed_at = NULL, member_access = ?
          WHERE space_id = ? AND app_id = ?`,
      ).run(request.memberAccess ?? "none", spaceId, appId);
      return "restored";
    })
    .immediate();
}

/**
 * Changes the caller's own switch and pin for an app in a space: whether it
 * is switched on for them, and whether it is kept at the top. Nobody else's
 * are touched, and nobody's access changes. Anyone who can see the app may,
 * with view access too; what is left out of the patch stays as it is.
 *
 * Throws a Refusal: 404 when the app is not there for this person.
 */
export function setAppPrefs(db: Db, registry: Registry, request: AppRequest & { patch: AppPrefsPatch }): void {
  const { userId, spaceId, appId, patch } = request;
  db.transaction(() => {
    if (resolveInstall(db, registry, userId, spaceId, appId) === null) throw notFound();
    if (patch.enabled === undefined && patch.pinned === undefined) return;
    const flag = (value: boolean | undefined) => (value === undefined ? null : value ? 1 : 0);
    // No row means switched on and not pinned, so a new row starts from there.
    db.prepare(
      `INSERT INTO app_prefs (space_id, app_id, user_id, enabled, pinned)
       VALUES (@spaceId, @appId, @userId, coalesce(@enabled, 1), coalesce(@pinned, 0))
       ON CONFLICT (space_id, app_id, user_id) DO UPDATE
          SET enabled = coalesce(@enabled, enabled), pinned = coalesce(@pinned, pinned)`,
    ).run({ spaceId, appId, userId, enabled: flag(patch.enabled), pinned: flag(patch.pinned) });
  }).immediate();
}

/**
 * Removes an app from a space. Its data, settings and everyone's switches
 * stay in the database, hidden, until the app is added again or an owner
 * deletes the data.
 *
 * Throws a Refusal: 404 when the app is not there for this person, 403 when
 * they are not an owner of the space.
 */
export function removeApp(db: Db, registry: Registry, request: AppRequest): void {
  const { userId, spaceId, appId } = request;
  db.transaction(() => {
    if (resolveInstall(db, registry, userId, spaceId, appId) === null) throw notFound();
    if (membershipOf(db, userId, spaceId)?.role !== "owner") {
      throw new Refusal(403, "forbidden", "Removing an app from a space is for the space's owners.");
    }
    db.prepare(
      "UPDATE space_apps SET removed_at = ? WHERE space_id = ? AND app_id = ? AND removed_at IS NULL",
    ).run(new Date().toISOString(), spaceId, appId);
  }).immediate();
}

/**
 * Deletes everything an app has in a space, for good: its rows, its
 * settings, everyone's access, switches and pins, and the entry itself.
 *
 * Owners only, and only for an app nobody can be using: one that was
 * removed from the space, or whose code the server no longer holds.
 * `confirm` is the app's ID as the person typed it.
 *
 * Throws a Refusal: 404 when the person is not in the space or the space
 * never had the app, 403 when they are not an owner, 400 when `confirm` is
 * not the app's ID, 409 when the app is still in use.
 */
export function deleteAppData(
  db: Db,
  registry: Registry,
  request: AppRequest & { confirm: string },
): { rows: number; settings: number } {
  const { userId, spaceId, appId } = request;
  return db
    .transaction(() => {
      const member = membershipOf(db, userId, spaceId);
      if (!member) throw notFound();
      // The same answer for every app ID, so a member learns nothing about removed apps.
      if (member.role !== "owner") {
        throw new Refusal(403, "forbidden", "Deleting an app's data is for the space's owners.");
      }
      if (request.confirm !== appId) {
        throw new Refusal(400, "invalid_request", "confirm: Must be the ID of the app whose data is to be deleted.");
      }
      const install = installOf(db, spaceId, appId);
      if (!install) throw notFound();
      if (install.removedAt === null && registry.has(appId)) {
        throw new Refusal(409, "conflict", "This app is still in the space. Remove it first, then delete its data.");
      }
      // Rows and settings first: the database refuses to drop the entry while they exist.
      const deleted = deleteAllData(db, spaceId, appId);
      // Access, switches and pins go with the entry.
      db.prepare("DELETE FROM space_apps WHERE space_id = ? AND app_id = ?").run(spaceId, appId);
      return deleted;
    })
    .immediate();
}
