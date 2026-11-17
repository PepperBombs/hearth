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
import { notFound, Refusal } from "../http/errors";
import { addApp, resolveInstall, type Caller } from "../apps/installs";
import type { RegisteredApp, Registry } from "../apps/registry";
import { MAX_LIST_LIMIT, readOnlyStore, writableStore, type StoreScope } from "../apps/store";
import { collectionSchemas, madeManifestSchema, type MadeManifest } from "./manifest";

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

export type MadeApp = { appId: string; spaceId: string; manifest: MadeManifest; html: string; version: number };

type MadeAppRow = { appId: string; spaceId: string; manifest: string; html: string; version: number };

/** The made app with this ID, in whatever space it is, or null. */
function readMadeApp(db: Db, appId: string): MadeApp | null {
  if (!MADE_ID.test(appId)) return null;
  const row = db
    .prepare(
      `SELECT app_id AS appId, space_id AS spaceId, manifest, html, version
         FROM made_apps
        WHERE app_id = ?`,
    )
    .get(appId) as MadeAppRow | undefined;
  if (!row) return null;
  // Checked when it was written; read again so that what the server hands on always fits.
  const manifest = madeManifestSchema.safeParse(JSON.parse(row.manifest));
  if (!manifest.success) return null;
  return { appId: row.appId, spaceId: row.spaceId, manifest: manifest.data, html: row.html, version: row.version };
}

/** What the rest of the server sees of a made app: an app with a manifest, no page and no server file. */
function registered(app: MadeApp): RegisteredApp {
  const { manifest } = app;
  return {
    id: app.appId,
    // A made app's texts are what its maker's model wrote, in the maker's language: never translated.
    manifest: {
      id: app.appId,
      name: { en: manifest.name, zh: manifest.name },
      description: { en: manifest.description, zh: manifest.description },
      icon: manifest.icon,
      color: manifest.color,
      widget: { size: manifest.size },
    },
    hasPage: false,
    made: true,
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
      const made = readMadeApp(db, appId);
      return made ? registered(made) : undefined;
    },
    has: (appId) => registry.has(appId) || readMadeApp(db, appId) !== null,
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
  request: { userId: string; spaceId: string; manifest: MadeManifest; html: string },
): { appId: string } {
  return db.transaction(() => {
    let appId = newMadeId();
    while (registry.has(appId)) appId = newMadeId();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO made_apps (app_id, space_id, manifest, html, version, created_by, updated_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)`,
    ).run(appId, request.spaceId, JSON.stringify(request.manifest), request.html, request.userId, request.userId, now, now);
    // The install comes second: addApp finds the app through the registry. The
    // foreign key between the two is checked when the transaction ends.
    addApp(db, registry, { userId: request.userId, spaceId: request.spaceId, appId, memberAccess: "none" });
    return { appId };
  })();
}

export type MadeRequest = { userId: string; spaceId: string; appId: string; by: Caller };

/** The made app, when the person, or an assistant for them, may use it in this space at all. */
function reachable(db: Db, registry: Registry, request: MadeRequest) {
  const level = resolveInstall(db, registry, request.userId, request.spaceId, request.appId, request.by);
  const app = level === null ? null : readMadeApp(db, request.appId);
  // The install was found in this space, so the app is there too; checked all the same.
  if (level === null || !app || app.spaceId !== request.spaceId) throw notFound();
  return { level, app };
}

/** The app's page and manifest, for the sandbox. */
export function madeAppForFrame(db: Db, registry: Registry, request: MadeRequest): MadeApp {
  return db.transaction(() => reachable(db, registry, request).app)();
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
    const app = level === null ? null : readMadeApp(db, appId);
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
