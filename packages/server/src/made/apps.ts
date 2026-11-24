/**
 * Apps made in Hearth (docs/platform.md): the table `made_apps`, and
 * everything that reads or writes one of them. Every app the server holds
 * is one.
 *
 * An app made in Hearth is an install: a `space_apps` row with the same ID,
 * added through `addApp`, so that VISIBLE decides who may use it, and its
 * rows are in the store. What it adds is its manifest and its page, which
 * live here. `madeAppsRegistry` is what every part of the server asks
 * whether an app exists.
 *
 * Its page never runs on the server: the server keeps it and serves it to
 * the sandbox (frame.ts).
 */
import { randomBytes } from "node:crypto";
import type { MadeRow } from "@hearth/shared";
import type { Db } from "../db/database";
import { membershipOf } from "../db/people";
import { notFound, Refusal } from "../http/errors";
import type { MemberAccess } from "@hearth/shared";
import { addApp, resolveInstall, type Caller } from "../apps/installs";
import type { RegisteredApp, Registry } from "../apps/registry";
import { AppError, MAX_LIST_LIMIT, readOnlyStore, rowsNotFitting, writableStore, type StoreScope } from "../apps/store";
import { templateHash } from "./catalog";
import { asSdkManifest, checkMadeManifest, collectionSchemas, madeManifestSchema, type MadeManifest } from "./manifest";

/** Every made app's ID starts so. No app of the releases before them was named like it. */
export const MADE_ID_PREFIX = "m-";
const MADE_ID = /^m-[a-z0-9]{10}$/;
const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

function newMadeId(): string {
  const bytes = randomBytes(10);
  let id = MADE_ID_PREFIX;
  for (const byte of bytes) id += ALPHABET[byte % ALPHABET.length];
  return id;
}

export type MadeApp = {
  appId: string;
  spaceId: string;
  manifest: MadeManifest;
  html: string;
  version: number;
  /** The built-in app it was added from (src/made/catalog.ts), or null for one a person's model made. */
  template: string | null;
  /**
   * For a copy of a published app (docs/center.md), where it came from: the
   * listing (null once it is unpublished), and the hash and revision of the
   * snapshot it was copied from. Null for every other app.
   */
  origin: MadeOrigin | null;
};

export type MadeOrigin = { listingId: string | null; hash: string; revision: number | null };

type MadeAppRow = {
  appId: string;
  spaceId: string;
  manifest: string;
  html: string;
  version: number;
  template: string | null;
  origin: string | null;
  originHash: string | null;
  originRevision: number | null;
};

/** A made app's name in a language: its maker's words, or the built-in app's in that language. */
export function nameOf(manifest: Pick<MadeManifest, "name">, locale: "en" | "zh"): string {
  return typeof manifest.name === "string" ? manifest.name : manifest.name[locale];
}

/** The made app with this ID, in whatever space it is, or null. */
function loadMadeApp(db: Db, appId: string): MadeApp | null {
  if (!MADE_ID.test(appId)) return null;
  const row = db
    .prepare(
      `SELECT app_id AS appId, space_id AS spaceId, manifest, html, version, template,
              origin, origin_hash AS originHash, origin_revision AS originRevision
         FROM made_apps
        WHERE app_id = ?`,
    )
    .get(appId) as MadeAppRow | undefined;
  if (!row) return null;
  // Checked when it was written; read again so that what the server hands on always fits.
  const manifest = madeManifestSchema.safeParse(JSON.parse(row.manifest));
  if (!manifest.success) return null;
  return {
    appId: row.appId,
    spaceId: row.spaceId,
    manifest: manifest.data,
    html: row.html,
    version: row.version,
    template: row.template,
    origin: row.originHash === null ? null : { listingId: row.origin, hash: row.originHash, revision: row.originRevision },
  };
}

/**
 * Whether a copy of a published app is still as it was shared: its manifest
 * and page hash to the snapshot it was copied from. Going back to version 1
 * makes it untouched again. False for every app that is no such copy.
 */
function untouchedCopy(app: Pick<MadeApp, "manifest" | "html" | "origin">): boolean {
  return app.origin !== null && templateHash(app.manifest, app.html) === app.origin.hash;
}

/**
 * What the rest of the server sees of a made app: an app with a manifest.
 * Its page is its own HTML, drawn small in its card and whole on a page of
 * its own (`hearth.view`), so every made app has a page.
 */
function registered(app: MadeApp): RegisteredApp {
  return {
    id: app.appId,
    // A made app's texts are its maker's words, never translated, or a built-in app's, in both languages.
    manifest: asSdkManifest(app.appId, app.manifest),
    hasPage: true,
    madeIn: app.spaceId,
    made: true,
    version: app.version,
    ...(app.template === null ? {} : { template: app.template }),
    // Hashed only for a copy of a published app, which few apps are.
    ...(app.origin === null
      ? {}
      : { copy: { ...(app.origin.listingId === null ? {} : { listingId: app.origin.listingId }), untouched: untouchedCopy(app) } }),
  };
}

/**
 * The apps the server holds: those made in Hearth, read from the database
 * whenever they are asked after, so that a change to one counts at once.
 * An ID that is no made app's, or one whose manifest no longer reads, is
 * no app at all.
 */
export function madeAppsRegistry(db: Db): Registry {
  return {
    get(appId) {
      const made = loadMadeApp(db, appId);
      return made ? registered(made) : undefined;
    },
    has: (appId) => loadMadeApp(db, appId) !== null,
  };
}

/**
 * Whether an assistant may change things in the space at all: what its
 * owners chose in Settings, "edit" or not. The chat makes apps only where
 * it may also fill them.
 */
export function assistantMayChange(db: Db, spaceId: string): boolean {
  const row = db.prepare("SELECT assistant FROM spaces WHERE id = ?").get(spaceId) as { assistant: string } | undefined;
  return row?.assistant === "edit";
}

/**
 * Makes an app in a space, for the person who asked: written here and added
 * to the space by `addApp`, with its rules (owners, and members allowed to
 * add apps; nothing shared with the other members of a group). Throws the
 * Refusal `addApp` throws.
 *
 * A copy of a built-in app names its `template`; a copy of a published app
 * (docs/center.md) its `origin`, the listing and the hash and revision of
 * its snapshot, and leaves `template` NULL, so the built-in apps' rules
 * never touch it. `note` is version 1's, "" when left out.
 */
export function createMadeApp(
  db: Db,
  registry: Registry,
  request: {
    userId: string;
    spaceId: string;
    manifest: MadeManifest;
    html: string;
    /** The built-in app it is a copy of (src/made/catalog.ts). */
    template?: { id: string; hash: string };
    /** The published app it is a copy of. */
    origin?: { id: string; hash: string; revision: number };
    note?: string;
    memberAccess?: MemberAccess;
  },
): { appId: string } {
  const problem = checkMadeManifest(request.manifest);
  if (problem !== null) throw new Refusal(400, "invalid_request", `The manifest is not valid: ${problem}`);
  if (!request.template && (request.manifest.network ?? []).length > 0) throw new Refusal(400, "invalid_request", HOSTS_ARE_HEARTHS);
  return db.transaction(() => {
    let appId = newMadeId();
    while (registry.has(appId)) appId = newMadeId();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO made_apps (app_id, space_id, manifest, html, version, template, template_hash,
                             origin, origin_hash, origin_revision, created_by, updated_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      appId,
      request.spaceId,
      JSON.stringify(request.manifest),
      request.html,
      request.template?.id ?? null,
      request.template?.hash ?? null,
      request.origin?.id ?? null,
      request.origin?.hash ?? null,
      request.origin?.revision ?? null,
      request.userId,
      request.userId,
      now,
      now,
    );
    const note = request.note ?? "";
    writeVersion(db, { appId, version: 1, manifest: request.manifest, html: request.html, note, userId: request.userId, at: now });
    // The install comes second: addApp finds the app through the registry. The
    // foreign key between the two is checked when the transaction ends.
    addApp(db, registry, { userId: request.userId, spaceId: request.spaceId, appId, memberAccess: request.memberAccess ?? "none" });
    return { appId };
  })();
}

export type MadeRequest = { userId: string; spaceId: string; appId: string; by: Caller };

/** The made app, when the person, or an assistant for them, may use it in this space at all. */
function reachable(db: Db, registry: Registry, request: MadeRequest) {
  const level = resolveInstall(db, registry, request.userId, request.spaceId, request.appId, request.by);
  const app = level === null ? null : loadMadeApp(db, request.appId);
  // The install was found in this space, so the app is there too; checked all the same.
  if (level === null || !app || app.spaceId !== request.spaceId) throw notFound();
  return { level, app };
}

/** The app's page and manifest, for the sandbox, with what the person may do with it. */
export function madeAppForFrame(db: Db, registry: Registry, request: MadeRequest): MadeApp & { level: "view" | "edit" } {
  return db.transaction(() => {
    const { app, level } = reachable(db, registry, request);
    return { ...app, level };
  })();
}

/** The made apps of one space that a person, or an assistant for them, may use, with what each may do. */
export function madeAppsIn(
  db: Db,
  registry: Registry,
  request: { userId: string; spaceId: string; by: Caller },
): { app: MadeApp; level: "view" | "edit" }[] {
  const ids = db
    .prepare("SELECT app_id AS appId FROM made_apps WHERE space_id = ? ORDER BY created_at, app_id")
    .all(request.spaceId) as { appId: string }[];
  const found: { app: MadeApp; level: "view" | "edit" }[] = [];
  for (const { appId } of ids) {
    const level = resolveInstall(db, registry, request.userId, request.spaceId, appId, request.by);
    const app = level === null ? null : loadMadeApp(db, appId);
    if (level !== null && app) found.push({ app, level });
  }
  return found;
}

const STATUS = { invalid_request: 400, not_found: 404, conflict: 409 } as const;

/**
 * Runs `work` on the app's collections, inside one transaction with the
 * access check: the store is closed when it returns. A store's refusal (a
 * row that does not fit, a row not found) becomes the answer's.
 */
function withCollection<T>(
  db: Db,
  registry: Registry,
  request: MadeRequest,
  collection: string,
  need: "view" | "edit",
  work: (rows: ReturnType<typeof writableStore>["collections"][string], fields: readonly string[]) => T,
): T {
  return db.transaction(() => {
    const { level, app } = reachable(db, registry, request);
    if (need === "edit" && level !== "edit") {
      throw new Refusal(403, "forbidden", "This app is yours to view here, not to change.");
    }
    const schemas = collectionSchemas(app.manifest);
    if (!Object.hasOwn(schemas, collection)) {
      throw new Refusal(404, "not_found", `This app has no collection "${collection}".`);
    }
    const scope: StoreScope = {
      spaceId: request.spaceId,
      appId: request.appId,
      userId: request.userId,
      now: new Date(),
    };
    const store = need === "edit" ? writableStore(db, scope, schemas) : readOnlyStore(db, scope, schemas);
    try {
      return work(
        store.collections[collection] as ReturnType<typeof writableStore>["collections"][string],
        Object.keys(schemas[collection]!.shape),
      );
    } catch (error) {
      if (error instanceof AppError && Object.hasOwn(STATUS, error.code)) {
        throw new Refusal(STATUS[error.code as keyof typeof STATUS], error.code as keyof typeof STATUS, error.message);
      }
      throw error;
    } finally {
      store.close();
    }
  })();
}

export type ListRequest = { orderBy?: string; desc?: boolean; limit?: number };

export function listMadeRows(
  db: Db,
  registry: Registry,
  request: MadeRequest,
  collection: string,
  options: ListRequest = {},
): MadeRow[] {
  const limit = Math.min(Math.max(1, Math.trunc(options.limit ?? 200)), MAX_LIST_LIMIT);
  return withCollection(db, registry, request, collection, "view", (rows, fields) => {
    const orderBy = options.orderBy;
    if (orderBy !== undefined && orderBy !== "createdAt" && orderBy !== "updatedAt" && !fields.includes(orderBy)) {
      throw new Refusal(400, "invalid_request", `"${orderBy}" is not a field of "${collection}".`);
    }
    return rows.list({ orderBy, desc: options.desc === true, limit }) as MadeRow[];
  });
}

export function addMadeRow(
  db: Db,
  registry: Registry,
  request: MadeRequest,
  collection: string,
  data: Record<string, unknown>,
): MadeRow {
  return withCollection(db, registry, request, collection, "edit", (rows) => rows.insert(data) as MadeRow);
}

export function updateMadeRow(
  db: Db,
  registry: Registry,
  request: MadeRequest,
  collection: string,
  rowId: string,
  data: Record<string, unknown>,
): MadeRow {
  return withCollection(db, registry, request, collection, "edit", (rows) => rows.update(rowId, data) as MadeRow);
}

export function removeMadeRow(db: Db, registry: Registry, request: MadeRequest, collection: string, rowId: string): void {
  withCollection(db, registry, request, collection, "edit", (rows) => rows.remove(rowId));
}

/**
 * The rows the chat's model asks to delete, read with what deleting them
 * needs (edit access, by the assistant for the person), and the names of
 * their collection's fields in the order the manifest gives them. Deletes
 * nothing. A row that is not there is refused (404), naming its ID.
 */
export function rowsToDelete(
  db: Db,
  registry: Registry,
  request: MadeRequest,
  collection: string,
  rowIds: readonly string[],
): { rows: MadeRow[]; fields: readonly string[] } {
  return withCollection(db, registry, request, collection, "edit", (rows, fields) => ({
    rows: rowIds.map((rowId) => {
      const row = rows.get(rowId);
      if (!row) throw new AppError("not_found", `${collection}: There is no row with the ID ${JSON.stringify(rowId)}.`);
      return row as MadeRow;
    }),
    fields,
  }));
}

/**
 * Deletes the rows of these IDs that are still there, through the store,
 * with what deleting needs checked again, and says how many went. Rows
 * gone since are skipped.
 */
export function deleteMadeRows(
  db: Db,
  registry: Registry,
  request: MadeRequest,
  collection: string,
  rowIds: readonly string[],
): number {
  return withCollection(db, registry, request, collection, "edit", (rows) => {
    let deleted = 0;
    for (const rowId of new Set(rowIds)) {
      if (rows.get(rowId) === null) continue;
      rows.remove(rowId);
      deleted++;
    }
    return deleted;
  });
}

/** Whether a made app of this ID is in this space now, whatever its manifest says: false once it was deleted or moved. */
export function madeAppIsIn(db: Db, appId: string, spaceId: string): boolean {
  return db.prepare("SELECT 1 FROM made_apps WHERE app_id = ? AND space_id = ?").get(appId, spaceId) !== undefined;
}

// ---------------------------------------------------------------------------
// Publishing an app to a group (docs/center.md)
// ---------------------------------------------------------------------------

/** A made app as publishing reads it, with whether it is a copy nobody changed. */
export type PublishSource = MadeApp & { untouchedCopy: boolean };

/**
 * The app, for someone who may publish it: who may change it (edit access,
 * and owner or allowed to add apps in its space), and for an app of a
 * group, an owner of that group. Both together come to an owner of the
 * app's space: in a personal space its person, in a group its owners.
 * Throws 404 when the person cannot see the app, as for one that does not
 * exist, and 403 when they can but may not publish it.
 *
 * `untouchedCopy` is true for a copy of a built-in app that Hearth still
 * keeps up to date (`template_hash` set: nobody changed it), and for a copy
 * of a published app whose manifest and page still hash to the snapshot it
 * was copied from (`origin_hash`). Either is someone else's app as they
 * shipped or shared it.
 */
export function publishableApp(db: Db, registry: Registry, request: Omit<MadeRequest, "by">): PublishSource {
  const { app } = reachable(db, registry, { ...request, by: "person" });
  if (membershipOf(db, request.userId, request.spaceId)?.role !== "owner") {
    throw new Refusal(403, "forbidden", "Publishing this app is for the owners of its space.");
  }
  const row = db
    .prepare("SELECT template_hash AS templateHash FROM made_apps WHERE app_id = ? AND space_id = ?")
    .get(app.appId, app.spaceId) as { templateHash: string | null };
  return { ...app, untouchedCopy: row.templateHash !== null || untouchedCopy(app) };
}

// ---------------------------------------------------------------------------
// Changing an app, and going back (docs/platform.md, "Changing an app")
// ---------------------------------------------------------------------------

/** How many versions of an app are kept, the one in use among them. */
export const KEPT_VERSIONS = 30;

export type MadeVersion = { version: number; note: string; createdAt: string };

function writeVersion(
  db: Db,
  version: { appId: string; version: number; manifest: MadeManifest; html: string; note: string; userId: string; at: string },
): void {
  db.prepare(
    `INSERT INTO made_app_versions (app_id, version, manifest, html, note, created_by, created_at)
     VALUES (@appId, @version, @manifest, @html, @note, @userId, @at)`,
  ).run({ ...version, manifest: JSON.stringify(version.manifest) });
  db.prepare("DELETE FROM made_app_versions WHERE app_id = ? AND version <= ?").run(version.appId, version.version - KEPT_VERSIONS);
}

/** The versions of an app, newest first. */
function versionsOf(db: Db, appId: string): MadeVersion[] {
  return db
    .prepare(
      `SELECT version, note, created_at AS createdAt
         FROM made_app_versions
        WHERE app_id = ?
        ORDER BY version DESC`,
    )
    .all(appId) as MadeVersion[];
}

/** An app, its page and its versions, for whoever may use it, or an assistant for them. */
export function readMadeApp(db: Db, registry: Registry, request: MadeRequest): MadeApp & { versions: MadeVersion[] } {
  return db.transaction(() => {
    const { app } = reachable(db, registry, request);
    return { ...app, versions: versionsOf(db, app.appId) };
  })();
}

/**
 * Who may change what an app is: whoever may add apps to its space, with
 * edit access to the app (and for an assistant, edit where the space's
 * owners allow it). A change reaches everyone who uses the app.
 */
function changeable(db: Db, registry: Registry, request: MadeRequest) {
  const found = reachable(db, registry, request);
  const member = membershipOf(db, request.userId, request.spaceId);
  if (found.level !== "edit" || !member || (member.role !== "owner" && member.canAddApps !== 1)) {
    throw new Refusal(403, "forbidden", "Changing this app is for the space's owners and the members they allow to add apps.");
  }
  return found;
}

/**
 * Refuses a manifest that some stored row would not fit: a change must
 * leave every row the app holds readable, or data would be hidden. The
 * message names the rows and why, and what to do instead.
 */
function keepEveryRow(db: Db, app: MadeApp, manifest: MadeManifest): void {
  const { misfits, total } = rowsNotFitting(db, { spaceId: app.spaceId, appId: app.appId }, collectionSchemas(manifest));
  if (total === 0) return;
  const which = misfits.map((misfit) => `${misfit.collection} row ${misfit.rowId}: ${misfit.reason}`).join("; ");
  throw new Refusal(
    409,
    "conflict",
    `${total} stored ${total === 1 ? "row" : "rows"} would no longer fit the app (${which}${total > misfits.length ? "; …" : ""}). ` +
      "Change those rows first, or keep the fields and options they use.",
  );
}

/**
 * Makes `next` the app's version in use. `templateHash` is the built-in app
 * it is now an untouched copy of, when Hearth brings it up to date; a
 * change of anyone else's leaves none, and Hearth leaves the app alone from
 * then on.
 */
function switchTo(
  db: Db,
  app: MadeApp,
  next: { manifest: MadeManifest; html: string; note: string; userId: string; templateHash?: string },
): number {
  const version = app.version + 1;
  const at = new Date().toISOString();
  writeVersion(db, { appId: app.appId, version, manifest: next.manifest, html: next.html, note: next.note, userId: next.userId, at });
  db.prepare(
    `UPDATE made_apps
        SET manifest = @manifest, html = @html, version = @version, updated_by = @userId, updated_at = @at,
            template_hash = @templateHash
      WHERE app_id = @appId AND space_id = @spaceId`,
  ).run({
    manifest: JSON.stringify(next.manifest),
    html: next.html,
    version,
    userId: next.userId,
    at,
    templateHash: next.templateHash ?? null,
    appId: app.appId,
    spaceId: app.spaceId,
  });
  return version;
}

export type Changed = { version: number; previous: number; name: MadeManifest["name"] };

/**
 * The hosts a made app's page may fetch from (its manifest's `network`) are
 * those a built-in app ships with, never chosen by a person's model: a host
 * a page names is one the server fetches from, with its own address.
 */
const HOSTS_ARE_HEARTHS =
  "An app made in Hearth fetches from no host of its own: only the apps Hearth ships name hosts, and theirs stay as they are.";

/**
 * Changes what an app is: its manifest, its page, or both, as a new
 * version. Refused when nothing would change, when the person (or the
 * assistant for them) may not change the app, and when a stored row would
 * not fit the new fields.
 */
export function changeMadeApp(
  db: Db,
  registry: Registry,
  request: MadeRequest & { manifest?: MadeManifest; html?: string; note: string },
): Changed {
  return db.transaction(() => {
    const { app } = changeable(db, registry, request);
    const manifest = request.manifest ?? app.manifest;
    const html = request.html ?? app.html;
    const problem = checkMadeManifest(manifest);
    if (problem !== null) throw new Refusal(400, "invalid_request", `The manifest is not valid: ${problem}`);
    if (JSON.stringify(manifest) === JSON.stringify(app.manifest) && html === app.html) {
      throw new Refusal(409, "conflict", "That would change nothing: the app is like that already.");
    }
    if (JSON.stringify(manifest.network ?? []) !== JSON.stringify(app.manifest.network ?? [])) {
      throw new Refusal(400, "invalid_request", `${HOSTS_ARE_HEARTHS} Keep "network" exactly as the app has it.`);
    }
    keepEveryRow(db, app, manifest);
    const version = switchTo(db, app, { manifest, html, note: request.note, userId: request.userId });
    return { version, previous: app.version, name: manifest.name };
  })();
}

/**
 * Makes an earlier version the one in use again, as a new version: going
 * back is itself a change, which can be undone in turn. Refused like a
 * change when a row written since would not fit that version.
 */
export function restoreMadeVersion(
  db: Db,
  registry: Registry,
  request: MadeRequest & { version: number },
): Changed & { restored: number } {
  return db.transaction(() => {
    const { app } = changeable(db, registry, request);
    if (request.version === app.version) {
      throw new Refusal(409, "conflict", `Version ${request.version} is the one in use.`);
    }
    const row = db
      .prepare("SELECT manifest, html FROM made_app_versions WHERE app_id = ? AND version = ?")
      .get(app.appId, request.version) as { manifest: string; html: string } | undefined;
    const manifest = row ? madeManifestSchema.safeParse(JSON.parse(row.manifest)) : null;
    if (!row || !manifest?.success) {
      throw new Refusal(404, "not_found", `This app has no version ${request.version} any more.`);
    }
    keepEveryRow(db, app, manifest.data);
    const version = switchTo(db, app, {
      manifest: manifest.data,
      html: row.html,
      note: `Back to version ${request.version}`,
      userId: request.userId,
    });
    return { version, previous: app.version, restored: request.version, name: manifest.data.name };
  })();
}

/** Most rows one replace may write: what a refresh of a list of fetched things needs. */
export const MAX_REPLACED_ROWS = 1000;

/**
 * Removes the rows of a collection whose fields equal `where` (all of them
 * for `{}`) and inserts `rows` in their place, in one transaction: all of it
 * or nothing, as a page's refresh of fetched lists needs.
 */
export function replaceMadeRows(
  db: Db,
  registry: Registry,
  request: MadeRequest,
  collection: string,
  where: Record<string, unknown>,
  rows: readonly Record<string, unknown>[],
): { removed: number; added: number } {
  if (rows.length > MAX_REPLACED_ROWS) {
    throw new Refusal(400, "invalid_request", `One replace writes at most ${MAX_REPLACED_ROWS} rows.`);
  }
  return withCollection(db, registry, request, collection, "edit", (collectionRows) => {
    const removed = collectionRows.removeWhere(where);
    for (const row of rows) collectionRows.insert(row);
    return { removed, added: rows.length };
  });
}

// ---------------------------------------------------------------------------
// Built-in apps (docs/platform.md, "Built-in apps")
// ---------------------------------------------------------------------------

/**
 * Turns an install of one of the apps of releases before the built-in apps
 * (`grocery`, `ideas`, `trending`) into an app made in Hearth from a
 * built-in template, in place: the install gets a made app's ID,
 * which every table about it follows (ON UPDATE CASCADE), so its rows,
 * settings, people's access and switches stay exactly as they were. The
 * template must take every row the install holds; when one does not fit,
 * nothing moves, and the reason is thrown.
 */
export function adoptInstall(
  db: Db,
  registry: Registry,
  install: { spaceId: string; appId: string; template: { id: string; hash: string }; manifest: MadeManifest; html: string },
): { appId: string } {
  return db.transaction(() => {
    const row = db
      .prepare("SELECT created_by AS createdBy FROM space_apps WHERE space_id = ? AND app_id = ?")
      .get(install.spaceId, install.appId) as { createdBy: string } | undefined;
    if (!row) throw notFound();
    let appId = newMadeId();
    while (registry.has(appId)) appId = newMadeId();
    const at = new Date().toISOString();
    db.prepare("UPDATE space_apps SET app_id = ? WHERE space_id = ? AND app_id = ?").run(appId, install.spaceId, install.appId);
    db.prepare(
      `INSERT INTO made_apps (app_id, space_id, manifest, html, version, template, template_hash, created_by, updated_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`,
    ).run(
      appId,
      install.spaceId,
      JSON.stringify(install.manifest),
      install.html,
      install.template.id,
      install.template.hash,
      row.createdBy,
      row.createdBy,
      at,
      at,
    );
    writeVersion(db, { appId, version: 1, manifest: install.manifest, html: install.html, note: "", userId: row.createdBy, at });
    const { misfits, total } = rowsNotFitting(db, { spaceId: install.spaceId, appId }, collectionSchemas(install.manifest));
    if (total > 0) {
      const which = misfits.map((misfit) => `${misfit.collection} row ${misfit.rowId}: ${misfit.reason}`).join("; ");
      throw new Error(`${total} row(s) of "${install.appId}" do not fit the built-in app (${which}).`);
    }
    return { appId };
  })();
}

/** The made apps of a space added from a built-in app, removed ones too, newest first. */
export function madeFromTemplate(db: Db, spaceId: string, template: string): { appId: string; removed: boolean }[] {
  const rows = db
    .prepare(
      `SELECT m.app_id AS appId, a.removed_at IS NOT NULL AS removed
         FROM made_apps m
         JOIN space_apps a ON a.space_id = m.space_id AND a.app_id = m.app_id
        WHERE m.space_id = ? AND m.template = ?
        ORDER BY m.created_at DESC, m.app_id`,
    )
    .all(spaceId, template) as { appId: string; removed: 0 | 1 }[];
  return rows.map((row) => ({ appId: row.appId, removed: row.removed === 1 }));
}

/**
 * The made apps of a space copied from one published app (docs/center.md),
 * removed ones too, newest first: one space holds one copy of it. Whoever
 * may see each is not asked, as for `madeFromTemplate`: a copy another
 * member added "only me for now" counts too.
 */
export function copiesOf(db: Db, spaceId: string, listingId: string): { appId: string; removed: boolean }[] {
  const rows = db
    .prepare(
      `SELECT m.app_id AS appId, a.removed_at IS NOT NULL AS removed
         FROM made_apps m
         JOIN space_apps a ON a.space_id = m.space_id AND a.app_id = m.app_id
        WHERE m.space_id = ? AND m.origin = ?
        ORDER BY m.created_at DESC, m.app_id`,
    )
    .all(spaceId, listingId) as { appId: string; removed: 0 | 1 }[];
  return rows.map((row) => ({ appId: row.appId, removed: row.removed === 1 }));
}

/** The note of a version Hearth wrote to bring a built-in app up to date. */
export const UPDATED_WITH_HEARTH = "Updated with Hearth";

/**
 * Brings an untouched copy of a built-in app up to what Hearth ships now, as
 * a new version, which can be undone like any. Throws, changing nothing,
 * when a stored row would not fit the new fields.
 */
export function updateFromTemplate(db: Db, appId: string, template: { manifest: MadeManifest; html: string; hash: string }): number {
  return db.transaction(() => {
    const app = loadMadeApp(db, appId);
    if (!app) throw notFound();
    keepEveryRow(db, app, template.manifest);
    const maker = db.prepare("SELECT created_by AS createdBy FROM made_apps WHERE app_id = ?").get(appId) as { createdBy: string };
    return switchTo(db, app, { manifest: template.manifest, html: template.html, note: UPDATED_WITH_HEARTH, userId: maker.createdBy, templateHash: template.hash });
  })();
}

