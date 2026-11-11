/**
 * Mini-apps' data and settings: the tables `app_rows` and `app_settings`.
 *
 * This is the only file with SQL for those two tables (a test fails if
 * their names appear in any other source file), so that there is one place
 * to check that every statement names its space and its app.
 *
 * - `readOnlyStore` and `writableStore` are what a handler gets as `ctx.db`:
 *   the collections the app declared, each limited to one app in one space.
 *   The space, the app and the person come from the caller of these
 *   functions, who has checked the person's access; nothing a mini-app or a
 *   request body says can change them. The caller closes the store when the
 *   handler has returned, and a closed store refuses everything.
 * - `deleteAllData` deletes everything an app has in a space.
 * - Reading and writing settings are added here with the settings routes.
 *
 * Design: docs/mini-app-contract.md, sections A3 and A6.
 */
import { AppError, type Collection, type ReadCollection, type z } from "@hearth/sdk/server";
import { safeParse } from "zod";
import type { Db } from "../db/database";
import { newId } from "../db/ids";
import { PLAIN_NAME } from "./definition";

/** Which rows a store reaches, and who is reaching for them. */
export type StoreScope = {
  spaceId: string;
  appId: string;
  /** The signed-in person: recorded on what is written, and whom `mine` means. */
  userId: string;
  /** The time that rows written through this store carry. */
  now: Date;
};

/** The fields of a row, as its collection's schema gives them. */
type Fields = Record<string, unknown>;

type StoredRow = {
  id: string;
  data: string;
  createdBy: string;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
};

/** What goes into a statement by name. */
type Bindings = Record<string, string | number>;

/**
 * A handler asked the store for something it does not do: a `where` on a
 * field the collection lacks, a limit above the maximum, anything at all
 * once its request is over. This is a mistake in the app's code, not in the
 * request, so it is a fault: logged, 500.
 */
export class StoreUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoreUsageError";
  }
}

/**
 * A row in the database does not fit its collection's schema: the schema
 * changed and old rows were left behind. The message names the app, the
 * collection and the row, and nothing of the row's content.
 */
export class StoredRowError extends Error {
  readonly appId: string;
  readonly collection: string;
  readonly rowId: string;
  constructor(appId: string, collection: string, rowId: string, reason: string) {
    super(
      `App "${appId}": the row "${rowId}" in the collection "${collection}" does not fit the collection's schema (${reason}). ` +
        "Give every field added to a collection a default, so that rows stored before still fit.",
    );
    this.name = "StoredRowError";
    this.appId = appId;
    this.collection = collection;
    this.rowId = rowId;
  }
}

export const DEFAULT_LIST_LIMIT = 1000;
export const MAX_LIST_LIMIT = 5000;

/** Every statement about rows is limited by this, whatever else it says. */
const SCOPE = "space_id = @spaceId AND app_id = @appId AND collection = @collection";

const COLUMNS =
  "id, data, created_by AS createdBy, updated_by AS updatedBy, created_at AS createdAt, updated_at AS updatedAt";

const describeIssue = (issue: { path: PropertyKey[]; message: string } | undefined): string =>
  issue ? `${issue.path.length > 0 ? `${issue.path.map(String).join(".")}: ` : ""}${issue.message}` : "it is not valid";

/** Whether the request a store was opened for is still being answered. */
type Lifetime = { closed: boolean };

/** One collection of one app in one space. */
function openCollection(
  db: Db,
  scope: StoreScope,
  collection: string,
  schema: z.ZodObject,
  lifetime: Lifetime,
): Collection<Fields> {
  const { appId, userId } = scope;
  const at = scope.now.toISOString();
  const scoped = (): Bindings => ({ spaceId: scope.spaceId, appId, collection });

  const misuse = (message: string) =>
    new StoreUsageError(`App "${appId}", collection "${collection}": ${message}`);

  /**
   * Refuses a store that outlived its request: by then the transaction that
   * held the access check is over, so nothing may be read or written on its
   * strength. An `async` handler gets here after its first `await`.
   */
  function live(): void {
    if (lifetime.closed) {
      throw misuse(
        "ctx.db was used after the handler returned. A handler cannot keep it for later, and cannot use it after an await.",
      );
    }
  }

  /** The JSON path of a field, after checking that the collection has it. */
  function pathOf(field: string, what: string): string {
    if (!Object.hasOwn(schema.shape, field)) {
      throw misuse(`${what} names "${field}", which is not a field of this collection.`);
    }
    if (!PLAIN_NAME.test(field)) {
      throw misuse(`${what} names "${field}". Only fields with plain names can be matched or ordered by.`);
    }
    return `$.${field}`;
  }

  /**
   * What a row stored without this field reads as: the field's default, or
   * undefined when it has none. Rows written before a field was added lack
   * it, and are read with its default; matching and ordering must see them
   * the same way, or `where: { done: false }` would skip those rows.
   */
  function whenMissing(field: string): unknown {
    const fieldSchema = schema.shape[field];
    if (!fieldSchema) return undefined;
    try {
      const parsed = safeParse(fieldSchema, undefined);
      return parsed.success ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Turns `where` into conditions, each beginning with AND, and adds what
   * they need to the bindings. A value is compared together with its kind,
   * so that `true` does not match a stored 1 nor "1" a stored number. A row
   * that lacks the field matches when the value is the field's default.
   */
  function matching(where: unknown, bindings: Bindings): string {
    if (where === undefined) return "";
    if (typeof where !== "object" || where === null || Array.isArray(where)) {
      throw misuse("where must be an object of fields and the values they should equal.");
    }
    let sql = "";
    Object.entries(where).forEach(([field, value], index) => {
      const path = `path${index}`;
      const kind = `json_type(data, @${path})`;
      bindings[path] = pathOf(field, "where");
      // json_type is NULL only where the row has no such field at all.
      const orMissing = whenMissing(field) === value ? ` OR ${kind} IS NULL` : "";
      if (typeof value === "string") {
        bindings[`value${index}`] = value;
        sql += ` AND ((${kind} = 'text' AND json_extract(data, @${path}) = @value${index})${orMissing})`;
      } else if (typeof value === "number" && Number.isFinite(value)) {
        bindings[`value${index}`] = value;
        sql += ` AND ((${kind} IN ('integer', 'real') AND json_extract(data, @${path}) = @value${index})${orMissing})`;
      } else if (typeof value === "boolean") {
        sql += ` AND (${kind} = '${value ? "true" : "false"}'${orMissing})`;
      } else if (value === null) {
        sql += ` AND (${kind} = 'null'${orMissing})`;
      } else if (value === undefined) {
        throw misuse(
          `where.${field} is undefined. Leave the field out to match every value; an undefined value is refused so that a missing input cannot widen what is matched.`,
        );
      } else {
        throw misuse(`where.${field} must be text, a number, true, false or null.`);
      }
    });
    return sql;
  }

  /** The fields of a stored row, checked against the schema as it is today. */
  function fieldsOf(stored: StoredRow): Fields {
    let value: unknown;
    try {
      value = JSON.parse(stored.data);
    } catch {
      throw new StoredRowError(appId, collection, stored.id, "it is not JSON");
    }
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      throw new StoredRowError(appId, collection, stored.id, describeIssue(parsed.error.issues[0]));
    }
    return parsed.data;
  }

  const toRow = (stored: StoredRow, fields: Fields = fieldsOf(stored)) => ({
    ...fields,
    id: stored.id,
    createdBy: stored.createdBy,
    updatedBy: stored.updatedBy,
    createdAt: stored.createdAt,
    updatedAt: stored.updatedAt,
  });

  /**
   * Checks a value that is about to be stored and returns it as the JSON to
   * store and as the fields a later read will give. What does not fit the
   * schema is the request's fault: a route may leave the collection's rules
   * (a name's length, say) to the collection.
   */
  function accept(value: unknown): { data: string; fields: Fields } {
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      throw new AppError("invalid_request", `${collection}: ${describeIssue(parsed.error.issues[0])}`);
    }
    const data = JSON.stringify(parsed.data);
    const stored = schema.safeParse(JSON.parse(data));
    if (!stored.success) {
      throw misuse(
        `the schema does not accept what it stores (${describeIssue(stored.error.issues[0])}). A collection holds JSON: text, numbers, switches, lists and objects of them.`,
      );
    }
    return { data, fields: stored.data };
  }

  function find(id: unknown): StoredRow | undefined {
    live();
    if (typeof id !== "string") return undefined;
    return db
      .prepare(`SELECT ${COLUMNS} FROM app_rows WHERE ${SCOPE} AND id = @id`)
      .get({ ...scoped(), id }) as StoredRow | undefined;
  }

  return {
    get(id) {
      const stored = find(id);
      return stored ? toRow(stored) : null;
    },

    list(options = {}) {
      live();
      const bindings = scoped();
      let conditions = matching(options.where, bindings);
      if (options.mine) {
        conditions += " AND created_by = @userId";
        bindings.userId = userId;
      }

      const limit = options.limit ?? DEFAULT_LIST_LIMIT;
      if (!Number.isInteger(limit) || limit < 0 || limit > MAX_LIST_LIMIT) {
        throw misuse(`limit must be a whole number from 0 to ${MAX_LIST_LIMIT}.`);
      }
      bindings.limit = limit;

      // Rows written in one request carry the same time, so the order they
      // were inserted in (rowid) settles every tie.
      const direction = options.desc ? "DESC" : "ASC";
      const orderBy = options.orderBy ?? "createdAt";
      let order = `created_at ${direction}, rowid ${direction}`;
      if (orderBy === "updatedAt") {
        order = `updated_at ${direction}, ${order}`;
      } else if (orderBy !== "createdAt") {
        bindings.orderPath = pathOf(String(orderBy), "orderBy");
        let value = "json_extract(data, @orderPath)";
        const missing = whenMissing(String(orderBy));
        if (typeof missing === "string" || typeof missing === "boolean" || Number.isFinite(missing)) {
          // json_extract gives a switch as 1 or 0.
          bindings.orderDefault = typeof missing === "boolean" ? Number(missing) : (missing as string | number);
          value = `CASE WHEN json_type(data, @orderPath) IS NULL THEN @orderDefault ELSE ${value} END`;
        }
        order = `${value} ${direction}, ${order}`;
      }

      const rows = db
        .prepare(
          `SELECT ${COLUMNS} FROM app_rows WHERE ${SCOPE}${conditions} ORDER BY ${order} LIMIT @limit`,
        )
        .all(bindings) as StoredRow[];
      return rows.map((stored) => toRow(stored));
    },

    count(where) {
      live();
      const bindings = scoped();
      const conditions = matching(where, bindings);
      const row = db
        .prepare(`SELECT count(*) AS n FROM app_rows WHERE ${SCOPE}${conditions}`)
        .get(bindings) as { n: number };
      return row.n;
    },

    insert(value) {
      live();
      const { data, fields } = accept(value);
      const stored: StoredRow = {
        id: newId(),
        data,
        createdBy: userId,
        updatedBy: userId,
        createdAt: at,
        updatedAt: at,
      };
      db.prepare(
        `INSERT INTO app_rows (id, space_id, app_id, collection, data, created_by, updated_by, created_at, updated_at)
         VALUES (@id, @spaceId, @appId, @collection, @data, @userId, @userId, @at, @at)`,
      ).run({ ...scoped(), id: stored.id, data, userId, at });
      return toRow(stored, fields);
    },

    update(id, patch) {
      const stored = find(id);
      if (!stored) throw new AppError("not_found", `${collection}: There is no row with this ID.`);
      if (typeof patch !== "object" || patch === null || Array.isArray(patch)) {
        throw misuse("update takes an object of the fields to change.");
      }
      const changes = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined));
      const { data, fields } = accept({ ...fieldsOf(stored), ...changes });
      db.prepare(
        `UPDATE app_rows SET data = @data, updated_by = @userId, updated_at = @at WHERE ${SCOPE} AND id = @id`,
      ).run({ ...scoped(), id: stored.id, data, userId, at });
      return toRow({ ...stored, data, updatedBy: userId, updatedAt: at }, fields);
    },

    remove(id) {
      live();
      if (typeof id !== "string") return;
      db.prepare(`DELETE FROM app_rows WHERE ${SCOPE} AND id = @id`).run({ ...scoped(), id });
    },

    removeWhere(where) {
      live();
      if (where === undefined) {
        throw misuse("removeWhere needs to be told which rows; pass {} to delete every row of the collection.");
      }
      const bindings = scoped();
      const conditions = matching(where, bindings);
      return db.prepare(`DELETE FROM app_rows WHERE ${SCOPE}${conditions}`).run(bindings).changes;
    },
  };
}

type Schemas = Readonly<Record<string, z.ZodObject>>;

/** A handler's `ctx.db`, and the way to end it. */
export type Store<C> = {
  /** The app's collections by name. */
  collections: Readonly<Record<string, C>>;
  /** Ends the store: from then on every method of every collection throws StoreUsageError. */
  close(): void;
};

function openStore<C>(
  db: Db,
  scope: StoreScope,
  schemas: Schemas,
  shape: (collection: Collection<Fields>) => C,
): Store<C> {
  const lifetime: Lifetime = { closed: false };
  const collections = Object.freeze(
    Object.fromEntries(
      Object.entries(schemas).map(([name, schema]) => [
        name,
        Object.freeze(shape(openCollection(db, scope, name, schema, lifetime))),
      ]),
    ),
  );
  return {
    collections,
    close: () => {
      lifetime.closed = true;
    },
  };
}

/**
 * An app's collections for a mutation: read and write, all of it limited to
 * the scope's space and app. Call it only with a scope taken from an install
 * the person was found to have edit access to, inside the same transaction
 * as that check, and close it when the handler has returned.
 */
export function writableStore(db: Db, scope: StoreScope, collections: Schemas): Store<Collection<Fields>> {
  return openStore(db, scope, collections, (collection) => collection);
}

/**
 * An app's collections for a query. The methods that write are not there at
 * all, so a query cannot change data whatever its code tries.
 */
export function readOnlyStore(db: Db, scope: StoreScope, collections: Schemas): Store<ReadCollection<Fields>> {
  return openStore(db, scope, collections, ({ get, list, count }) => ({ get, list, count }));
}

/**
 * Deletes every row and every setting one app has in one space, and says how
 * many of each went. The caller holds the transaction, has checked that the
 * person may do this, and deletes the app's entry in the space afterwards.
 */
export function deleteAllData(
  db: Db,
  spaceId: string,
  appId: string,
): { rows: number; settings: number } {
  const rows = db
    .prepare("DELETE FROM app_rows WHERE space_id = ? AND app_id = ?")
    .run(spaceId, appId).changes;
  const settings = db
    .prepare("DELETE FROM app_settings WHERE space_id = ? AND app_id = ?")
    .run(spaceId, appId).changes;
  return { rows, settings };
}
