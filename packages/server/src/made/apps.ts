/**
 * Apps made in Hearth (docs/platform.md): the table `made_apps`, and
 * everything that reads or writes one of them.
 *
 * An app made in Hearth is an install like any other: a `space_apps` row
 * with the same ID, added through `addApp`, so that VISIBLE decides who may
 * use it, and its rows are in the store. What it adds is its manifest and
 * its page, which live here instead of in the build. `withMadeApps` lets
 * every part of the server that asks the registry whether an app exists
 * find these too.
 *
 * Its page never runs on the server: the server keeps it and serves it to
 * the sandbox (frame.ts).
 */
import { randomBytes } from "node:crypto";
import { AppError } from "@hearth/sdk/server";
import type { MadeRow } from "@hearth/shared";
import type { Db } from "../db/database";
import { membershipOf } from "../db/people";
import { notFound, Refusal } from "../http/errors";
import type { MemberAccess } from "@hearth/shared";
import { addApp, resolveInstall, type Caller } from "../apps/installs";
import type { RegisteredApp, Registry } from "../apps/registry";
import { MAX_LIST_LIMIT, readOnlyStore, rowsNotFitting, writableStore, type StoreScope } from "../apps/store";
import { asSdkManifest, checkMadeManifest, collectionSchemas, madeManifestSchema, type MadeManifest } from "./manifest";

/** Every made app's ID starts so. No app of a build is named like it. */
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
};

type MadeAppRow = { appId: string; spaceId: string; manifest: string; html: string; version: number; template: string | null };

/** A made app's name in a language: its maker's words, or the built-in app's in that language. */
export function nameOf(manifest: Pick<MadeManifest, "name">, locale: "en" | "zh"): string {
  return typeof manifest.name === "string" ? manifest.name : manifest.name[locale];
}

/** The made app with this ID, in whatever space it is, or null. */
function loadMadeApp(db: Db, appId: string): MadeApp | null {
  if (!MADE_ID.test(appId)) return null;
  const row = db
    .prepare(
      `SELECT app_id AS appId, space_id AS spaceId, manifest, html, version, template
         FROM made_apps
        WHERE app_id = ?`,
    )
    .get(appId) as MadeAppRow | undefined;
  if (!row) return null;
  // Checked when it was written; read again so that what the server hands on always fits.
  const manifest = madeManifestSchema.safeParse(JSON.parse(row.manifest));
  if (!manifest.success) return null;
  return { appId: row.appId, spaceId: row.spaceId, manifest: manifest.data, html: row.html, version: row.version, template: row.template };
}

/**
 * What the rest of the server sees of a made app: an app with a manifest
 * and no server file. Its page is its own HTML, drawn small in its card and
 * whole on a page of its own (`hearth.view`), so every made app has a page.
 */
function registered(app: MadeApp): RegisteredApp {
  return {
    id: app.appId,
    // A made app's texts are its maker's words, never translated, or a built-in app's, in both languages.
    manifest: asSdkManifest(app.appId, app.manifest),
    hasPage: true,
    made: true,
    version: app.version,
    ...(app.template === null ? {} : { template: app.template }),
  };
}

/**
 * The build's registry, with the apps made in Hearth added: what `get` and
 * `has` answer about any app. `list` stays the build's own apps, the ones
 * any space can add; a made app is in one space only.
 */
export function withMadeApps(db: Db, registry: Registry): Registry {
  return {
    get(appId) {
      const bundled = registry.get(appId);
      if (bundled) return bundled;
      const made = loadMadeApp(db, appId);
      return made ? registered(made) : undefined;
    },
    has: (appId) => registry.has(appId) || loadMadeApp(db, appId) !== null,
    list: () => registry.list(),
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
 */
export function createMadeApp(
  db: Db,
  registry: Registry,
  request: { userId: string; spaceId: string; manifest: MadeManifest; html: string; template?: string; memberAccess?: MemberAccess },
): { appId: string } {
  const problem = checkMadeManifest(request.manifest);
  if (problem !== null) throw new Refusal(400, "invalid_request", `The manifest is not valid: ${problem}`);
  return db.transaction(() => {
    let appId = newMadeId();
    while (registry.has(appId)) appId = newMadeId();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO made_apps (app_id, space_id, manifest, html, version, template, created_by, updated_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
    ).run(appId, request.spaceId, JSON.stringify(request.manifest), request.html, request.template ?? null, request.userId, request.userId, now, now);
    writeVersion(db, { appId, version: 1, manifest: request.manifest, html: request.html, note: "", userId: request.userId, at: now });
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
 * access check, as a mutation's handler runs: the store is closed when it
 * returns. A store's refusal (a row that does not fit, a row not found)
 * becomes the answer's.
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
      job: null,
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

function switchTo(
  db: Db,
  app: MadeApp,
  next: { manifest: MadeManifest; html: string; note: string; userId: string },
): number {
  const version = app.version + 1;
  const at = new Date().toISOString();
  writeVersion(db, { appId: app.appId, version, manifest: next.manifest, html: next.html, note: next.note, userId: next.userId, at });
  db.prepare(
    `UPDATE made_apps
        SET manifest = @manifest, html = @html, version = @version, updated_by = @userId, updated_at = @at
      WHERE app_id = @appId AND space_id = @spaceId`,
  ).run({ manifest: JSON.stringify(next.manifest), html: next.html, version, userId: next.userId, at, appId: app.appId, spaceId: app.spaceId });
  return version;
}

export type Changed = { version: number; previous: number; name: MadeManifest["name"] };

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
 * Turns an install of one of the build's apps into an app made in Hearth
 * from a built-in template, in place: the install gets a made app's ID,
 * which every table about it follows (ON UPDATE CASCADE), so its rows,
 * settings, people's access and switches stay exactly as they were. The
 * template must take every row the install holds; when one does not fit,
 * nothing moves, and the reason is thrown.
 */
export function adoptInstall(
  db: Db,
  registry: Registry,
  install: { spaceId: string; appId: string; template: string; manifest: MadeManifest; html: string },
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
      `INSERT INTO made_apps (app_id, space_id, manifest, html, version, template, created_by, updated_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
    ).run(appId, install.spaceId, JSON.stringify(install.manifest), install.html, install.template, row.createdBy, row.createdBy, at, at);
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

