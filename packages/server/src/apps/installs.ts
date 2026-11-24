/**
 * Apps in spaces: who may use which app where, and adding, removing,
 * moving and deleting them, each person's switch and pin, the owners' list
 * of a space's apps and the owners' choice of who can use each. An app in a
 * space is a row in `space_apps`, called an install here.
 *
 * Every function names its space, and every answer about access comes from
 * one piece of SQL (`VISIBLE`), so the session, the routes and whatever is
 * added later cannot disagree about who sees what. The owners' list reports
 * what was decided (`member_access`, `app_access`); it decides nothing.
 *
 * Design: docs/mini-app-contract.md, section A6.
 */
import type {
  AccessLevel,
  AppAccessRequest,
  AppPrefsPatch,
  AppSummary,
  InstalledApp,
  MemberAccess,
  SpaceApps,
} from "@hearth/shared";
import type { Db } from "../db/database";
import { membershipOf } from "../db/people";
import { listInvitations, listMemberDetails } from "../groups/members";
import { notFound, Refusal } from "../http/errors";
import { expireRequestsFor } from "../model/confirmations";
import type { Registry } from "./registry";
import { countRows, deleteAllData, deleteOwnSettingsOfOthers } from "./store";

/** What a person may do with an install: "edit" for an owner of the space, else their exception or every member's level. */
const ACCESS = `CASE WHEN m.role = 'owner' THEN 'edit' ELSE coalesce(x.level, a.member_access) END`;

/**
 * The installs a person can reach and what they may do with each: one row
 * for every app that is in a space they belong to and has not been removed.
 * An owner of the space has "edit". A member has the exception an owner
 * made for them, or else what the app gives every member; that may be
 * "none". Their own switch and pin come along, defaulting to on and unpinned.
 *
 * `assistant` is what an assistant may do with the app for them
 * (docs/mini-app-contract.md, section F): the lesser of their access and
 * what the space's owners allow an assistant there, and "none" for an app
 * the owners left out.
 *
 * Callers add conditions and an order, and drop apps the server holds no app for.
 */
const VISIBLE = `
  SELECT a.space_id AS spaceId,
         a.app_id AS appId,
         ${ACCESS} AS access,
         CASE
           WHEN a.assistant = 0 OR s.assistant = 'none' OR ${ACCESS} = 'none' THEN 'none'
           WHEN s.assistant = 'view' OR ${ACCESS} = 'view' THEN 'view'
           ELSE 'edit'
         END AS assistant,
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
  assistant: MemberAccess;
  enabled: 0 | 1;
  pinned: 0 | 1;
};

/**
 * Who is asking: the person themselves, through the web app, or an
 * assistant acting for them, their own model in the chat
 * (docs/platform.md, "The chat"), which may do no more than the space's
 * owners allow it.
 */
export type Caller = "person" | "assistant";

/**
 * What a person may do with an app in a space: "view", "edit", or null.
 * With `by: "assistant"`, what an assistant may do with it for them.
 *
 * Null means the app is not there for them, whatever the reason: they are
 * not in the space, the space does not have the app, the app was removed
 * from it, the server holds no app of that ID, or their access is "none"; for
 * an assistant also that the space's owners allow it nothing there, or left
 * the app out. Every route about one app answers 404 `not_found` for null,
 * so that none of those reasons can be told apart.
 */
export function resolveInstall(
  db: Db,
  registry: Registry,
  userId: string,
  spaceId: string,
  appId: string,
  by: Caller = "person",
): AccessLevel | null {
  if (!registry.has(appId)) return null;
  const row = db
    .prepare(`${VISIBLE} AND a.space_id = @spaceId AND a.app_id = @appId`)
    .get({ userId, spaceId, appId }) as VisibleRow | undefined;
  const level = row === undefined ? "none" : by === "assistant" ? row.assistant : row.access;
  return level === "none" ? null : level;
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
      made: app.made,
      version: app.version,
      ...(app.template ? { template: app.template } : {}),
      ...(manifest.settings ? { settings: manifest.settings } : {}),
    });
  }
  return apps;
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
 * An app made in Hearth is added to its space when it is made
 * (`createMadeApp` in src/made/apps.ts), and to no other.
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
 * has no app of this name for it, 403 when they may not add apps here, 409
 * when the app cannot be added as things stand.
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
      // A made app is its space's own: it is not there to be added anywhere else.
      if (!app || app.madeIn !== spaceId) throw notFound();

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
        `UPDATE space_apps SET removed_at = NULL, assistant = 1, member_access = ?
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
 * Every app a space has, as its owners see it: those removed from it and
 * those the server no longer holds an app for too, each with how many rows
 * it keeps, what members get and the exceptions made for single members.
 * Then everyone in the space with their address and right to add apps, and
 * the people invited who have not arrived yet. This is what the owners'
 * table of who can use what is drawn from; it says what was decided, and
 * `resolveInstall` stays the one answer to what a person may do.
 *
 * Throws a Refusal: 404 when the person is not in the space, 403 when they
 * are not an owner.
 */
export function listSpaceApps(db: Db, registry: Registry, request: { userId: string; spaceId: string }): SpaceApps {
  const { userId, spaceId } = request;
  return db
    .transaction((): SpaceApps => {
      const member = membershipOf(db, userId, spaceId);
      if (!member) throw notFound();
      if (member.role !== "owner") {
        throw new Refusal(403, "forbidden", "The list of a space's apps and who can use them is for the space's owners.");
      }
      const installs = db
        .prepare(
          `SELECT app_id AS id, member_access AS memberAccess, removed_at AS removedAt, assistant
             FROM space_apps
            WHERE space_id = ?
            ORDER BY created_at, app_id`,
        )
        .all(spaceId) as (Pick<InstalledApp, "id" | "memberAccess" | "removedAt"> & { assistant: 0 | 1 })[];
      const exceptions = db
        .prepare("SELECT app_id AS appId, user_id AS userId, level FROM app_access WHERE space_id = ? ORDER BY user_id")
        .all(spaceId) as { appId: string; userId: string; level: MemberAccess }[];
      const apps = installs.map((install): InstalledApp => {
        const held = registry.get(install.id);
        return {
          id: install.id,
          hasCode: held !== undefined,
          removedAt: install.removedAt,
          rowCount: countRows(db, spaceId, install.id),
          memberAccess: install.memberAccess,
          members: Object.fromEntries(
            exceptions.filter((exception) => exception.appId === install.id).map((exception) => [exception.userId, exception.level]),
          ),
          assistant: install.assistant === 1,
          ...(held?.template ? { template: held.template } : {}),
          // What the Apps page draws a removed app with, which the session no longer lists.
          ...(held
            ? {
                name: { en: held.manifest.name.en, zh: held.manifest.name.zh },
                icon: held.manifest.icon,
                color: held.manifest.color,
              }
            : {}),
        };
      });
      return { apps, members: listMemberDetails(db, spaceId), invitations: listInvitations(db, spaceId) };
    })
    .deferred();
}

/**
 * Changes who can use an app in a space: what every member gets
 * (`memberAccess`), and exceptions for single members (`null` takes one
 * away, so that the person follows `memberAccess` again). What the request
 * leaves out stays as it is; the request is saved as a whole or not at all.
 * An owner can use the app whatever their exception says.
 *
 * Throws a Refusal: 404 when the app is not there for the person asking,
 * 403 when they are not an owner, 400 for an exception for someone who is
 * not in the space.
 */
export function setAppAccess(db: Db, registry: Registry, request: AppRequest & { change: AppAccessRequest }): void {
  const { userId, spaceId, appId, change } = request;
  db.transaction(() => {
    if (resolveInstall(db, registry, userId, spaceId, appId) === null) throw notFound();
    if (membershipOf(db, userId, spaceId)?.role !== "owner") {
      throw new Refusal(403, "forbidden", "Changing who can use an app is for the space's owners.");
    }
    const exceptions = Object.entries(change.members ?? {});
    for (const [memberId] of exceptions) {
      if (!membershipOf(db, memberId, spaceId)) {
        throw new Refusal(400, "invalid_request", `members.${memberId}: Not someone in this space.`);
      }
    }
    if (change.memberAccess !== undefined) {
      db.prepare("UPDATE space_apps SET member_access = ? WHERE space_id = ? AND app_id = ?").run(
        change.memberAccess,
        spaceId,
        appId,
      );
    }
    if (change.assistant !== undefined) {
      db.prepare("UPDATE space_apps SET assistant = ? WHERE space_id = ? AND app_id = ?").run(
        change.assistant ? 1 : 0,
        spaceId,
        appId,
      );
    }
    const now = new Date().toISOString();
    const clear = db.prepare("DELETE FROM app_access WHERE space_id = ? AND app_id = ? AND user_id = ?");
    const set = db.prepare(
      `INSERT INTO app_access (space_id, app_id, user_id, level, created_by, updated_at)
       VALUES (@spaceId, @appId, @memberId, @level, @userId, @now)
       ON CONFLICT (space_id, app_id, user_id) DO UPDATE SET level = excluded.level, updated_at = excluded.updated_at`,
    );
    for (const [memberId, level] of exceptions) {
      if (level === null) clear.run(spaceId, appId, memberId);
      else set.run({ spaceId, appId, memberId, level, userId, now });
    }
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
 * Moves an app with its data to another space: its rows, the settings
 * everyone in the space shares, and the own settings, switches and pins of
 * the people who are in both spaces. Nothing is merged: a space that has
 * the app, or had it and kept its data, cannot take it.
 *
 * The person moving it must own the space it is in (owner's decision 3),
 * and own the space it goes to or be allowed to add apps there. In one
 * immediate transaction, after the checks:
 *
 * 1. Every exception made for single members goes: access starts afresh.
 * 2. What belongs to people who are not in the new space (their own
 *    settings, switch and pin) is deleted, since it cannot go there.
 * 3. One change of the entry's space, which every table about the app
 *    follows (`ON UPDATE CASCADE`), and of what its members get:
 *    `memberAccess`, "none" when left out. Who added the app stays recorded.
 * 4. A mover who is not an owner of the new space gets edit for
 *    themselves, as when they add an app, so that the app arrives for them
 *    and the owners only until access is chosen.
 *
 * A move therefore never widens access by itself: in the new space the app
 * is for its owners, the mover and whoever the mover chose.
 *
 * Throws a Refusal: 404 when the app is not there for this person, or they
 * are not in the space it should go to (or it does not exist); 403 when they
 * do not own the space it is in, or may not add apps to the other; 409 when
 * the other space cannot take it.
 */
export function moveApp(
  db: Db,
  registry: Registry,
  request: AppRequest & { toSpaceId: string; memberAccess?: MemberAccess },
): void {
  const { userId, spaceId, appId, toSpaceId } = request;
  db.transaction(() => {
    if (resolveInstall(db, registry, userId, spaceId, appId) === null) throw notFound();
    if (membershipOf(db, userId, spaceId)?.role !== "owner") {
      throw new Refusal(403, "forbidden", "Moving an app out of a space is for the space's owners.");
    }
    const target = membershipOf(db, userId, toSpaceId);
    if (!target) throw notFound();
    const ownsTarget = target.role === "owner";
    if (!ownsTarget && target.canAddApps !== 1) {
      throw new Refusal(403, "forbidden", "Moving an app into a space is for its owners and the members they allow to add apps.");
    }
    // The space the app is in has it too, so moving it to where it is ends here.
    if (installOf(db, toSpaceId, appId)) {
      throw new Refusal(
        409,
        "conflict",
        "That space has this app already, or had it and kept its data. Apps are not merged: move it to another space.",
      );
    }

    // The chat's requests to delete its rows were asked in this space, and cannot be carried out here any more.
    expireRequestsFor(db, { spaceId, appId, at: new Date().toISOString() });
    db.prepare("DELETE FROM app_access WHERE space_id = ? AND app_id = ?").run(spaceId, appId);
    db.prepare(
      `DELETE FROM app_prefs
        WHERE space_id = @spaceId AND app_id = @appId
          AND user_id NOT IN (SELECT user_id FROM space_members WHERE space_id = @toSpaceId)`,
    ).run({ spaceId, appId, toSpaceId });
    deleteOwnSettingsOfOthers(db, spaceId, appId, toSpaceId);

    // Access starts afresh where the app goes, and so does what an assistant may do with it.
    db.prepare("UPDATE space_apps SET space_id = ?, member_access = ?, assistant = 1 WHERE space_id = ? AND app_id = ?").run(
      toSpaceId,
      request.memberAccess ?? "none",
      spaceId,
      appId,
    );
    if (!ownsTarget) {
      db.prepare(
        `INSERT INTO app_access (space_id, app_id, user_id, level, created_by, updated_at)
         VALUES (?, ?, ?, 'edit', ?, ?)`,
      ).run(toSpaceId, appId, userId, userId, new Date().toISOString());
    }
  }).immediate();
}

/**
 * Deletes an app from a space for good, with everything it has there: its
 * rows, its settings, everyone's access, switches and pins, the entry
 * itself, and for an app made in Hearth the app and its versions, which go
 * with the entry. The chat's requests to delete rows of it that are still
 * waiting expire. Nothing of it is left to bring back.
 *
 * Owners only. For an app the server holds, in use or removed, `confirm` is
 * its name as the person typed it, in either of its languages, spaces
 * around it aside. For an install the server holds no app for, which has no
 * name the person could have seen, it is the app's ID.
 *
 * Throws a Refusal: 404 when the person is not in the space or the space
 * never had the app, 403 when they are not an owner, 400 when `confirm` is
 * not what it must be.
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
        throw new Refusal(403, "forbidden", "Deleting an app is for the space's owners.");
      }
      const install = installOf(db, spaceId, appId);
      if (!install) throw notFound();
      const held = registry.get(appId);
      if (held) {
        const typed = request.confirm.trim();
        const names = [held.manifest.name.en, held.manifest.name.zh].map((name) => name.trim());
        if (typed === "" || !names.includes(typed)) {
          throw new Refusal(400, "invalid_request", "confirm: Must be the name of the app to be deleted, as it is shown.");
        }
      } else if (request.confirm !== appId) {
        throw new Refusal(400, "invalid_request", "confirm: Must be the ID of the app whose data is to be deleted.");
      }
      expireRequestsFor(db, { spaceId, appId, at: new Date().toISOString() });
      // Rows and settings first: the database refuses to drop the entry while they exist.
      const deleted = deleteAllData(db, spaceId, appId);
      // Access, switches, pins, and a made app with its versions go with the entry.
      db.prepare("DELETE FROM space_apps WHERE space_id = ? AND app_id = ?").run(spaceId, appId);
      return deleted;
    })
    .immediate();
}
