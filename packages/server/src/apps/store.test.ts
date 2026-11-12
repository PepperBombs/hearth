/**
 * The store: what a mini-app's handler gets as `ctx.db`
 * (docs/mini-app-contract.md, sections A3 and A6). The first block is the
 * contract test that data never crosses from one space or one app to another.
 */
import { AppError, z, type Collection } from "@hearth/sdk/server";
import { beforeEach, describe, expect, it } from "vitest";
import checklistServer from "../../../fixture-apps/checklist/server";
import {
  DEFAULT_LIST_LIMIT,
  MAX_LIST_LIMIT,
  readOnlyStore,
  StoredRowError,
  StoreUsageError,
  writableStore,
  type StoreScope,
} from "./store";
import { family, install } from "./test-world";

type Fields = Record<string, unknown>;

const AT = new Date("2026-03-01T08:00:00.000Z");
const LATER = new Date("2026-03-02T09:30:00.000Z");

let world: ReturnType<typeof family>;

beforeEach(() => {
  world = family();
  install(world.db, world.samsSpace, "checklist", world.sam.id);
  install(world.db, world.samsSpace, "journal", world.sam.id);
  install(world.db, world.family, "checklist", world.sam.id, { memberAccess: "edit" });
  install(world.db, world.linsSpace, "checklist", world.lin.id);
});

const scopeOf = (spaceId: string, appId: string, userId: string, now = AT): StoreScope => ({
  spaceId,
  appId,
  userId,
  job: null,
  now,
});

/** The checklist's items in a space, as a mutation of that person would get them. */
function itemsIn(spaceId: string, userId: string, now = AT, appId = "checklist"): Collection<Fields> {
  const store = writableStore(world.db, scopeOf(spaceId, appId, userId, now), checklistServer.collections);
  return store.collections.items!;
}

/** Sam's own checklist. */
const sams = (now = AT) => itemsIn(world.samsSpace, world.sam.id, now);

/** Every stored row as the database has it, to compare before and after. */
const everything = () => world.db.prepare("SELECT * FROM app_rows ORDER BY id").all();

/** A row put there behind the store's back, as an older version of an app might have left it. */
function rawRow(id: string, data: string, spaceId = world.samsSpace, collection = "items"): void {
  world.db
    .prepare(
      `INSERT INTO app_rows (id, space_id, app_id, collection, data, created_by, updated_by, created_at, updated_at)
       VALUES (?, ?, 'checklist', ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, spaceId, collection, data, world.sam.id, world.sam.id, AT.toISOString(), AT.toISOString());
}

function thrownBy(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("Nothing was thrown.");
}

const names = (rows: readonly Fields[]) => rows.map((row) => row.name);

describe("isolation: a store reaches one app in one space and nothing else", () => {
  let milk: string;
  let eggs: string;

  beforeEach(() => {
    milk = sams().insert({ name: "Milk", section: "Dairy", done: true }).id;
    eggs = sams().insert({ name: "Eggs", section: "Dairy", done: false }).id;
  });

  /**
   * Stores that must not see Sam's checklist: the same app in other spaces
   * (one of which Sam is in too), another app in the same space, and the
   * same app in the same space under another collection's name.
   */
  const strangers = (): [string, Collection<Fields>][] => [
    ["the same app in another person's space", itemsIn(world.linsSpace, world.lin.id)],
    ["the same app in a group the person is also in", itemsIn(world.family, world.sam.id)],
    ["another app in the same space", itemsIn(world.samsSpace, world.sam.id, AT, "journal")],
    [
      "another collection of the same app",
      writableStore(world.db, scopeOf(world.samsSpace, "checklist", world.sam.id), {
        others: checklistServer.collections.items,
      }).collections.others!,
    ],
  ];

  it("has something to hide: the rows are there for their own space and app", () => {
    expect(names(sams().list())).toEqual(["Milk", "Eggs"]);
    expect(sams().get(milk)?.name).toBe("Milk");
    expect(sams().count()).toBe(2);
    expect(strangers()).toHaveLength(4);
  });

  it("gives every reading method nothing back from anywhere else", () => {
    for (const [where, items] of strangers()) {
      expect(items.get(milk), where).toBeNull();
      expect(items.get(eggs), where).toBeNull();
      expect(items.list(), where).toEqual([]);
      expect(items.list({ where: { section: "Dairy" } }), where).toEqual([]);
      expect(items.list({ where: { done: true }, orderBy: "name", desc: true, limit: 5 }), where).toEqual([]);
      expect(items.list({ mine: true }), where).toEqual([]);
      expect(items.count(), where).toBe(0);
      expect(items.count({ done: false }), where).toBe(0);
    }
  });

  it("lets no writing method touch a row from anywhere else", () => {
    const before = everything();
    for (const [where, items] of strangers()) {
      const error = thrownBy(() => items.update(milk, { done: false }));
      expect(error, where).toBeInstanceOf(AppError);
      expect((error as AppError).code, where).toBe("not_found");
      items.remove(milk);
      items.remove(eggs);
      expect(items.removeWhere({ done: true }), where).toBe(0);
      expect(items.removeWhere({}), where).toBe(0);
      expect(everything(), where).toEqual(before);
    }
  });

  it("stores what a stranger inserts in the stranger's own space and app", () => {
    for (const [where, items] of strangers()) {
      const row = items.insert({ name: "Bread", section: "", done: false });
      expect(sams().get(row.id), where).toBeNull();
      expect(items.get(row.id)?.name, where).toBe("Bread");
    }
    expect(names(sams().list())).toEqual(["Milk", "Eggs"]);
    expect(sams().count()).toBe(2);
    expect(
      world.db
        .prepare(
          "SELECT space_id AS spaceId, app_id AS appId, collection, created_by AS createdBy FROM app_rows WHERE json_extract(data, '$.name') = 'Bread' ORDER BY space_id, app_id, collection",
        )
        .all(),
    ).toEqual(
      [
        { spaceId: world.linsSpace, appId: "checklist", collection: "items", createdBy: world.lin.id },
        { spaceId: world.family, appId: "checklist", collection: "items", createdBy: world.sam.id },
        { spaceId: world.samsSpace, appId: "journal", collection: "items", createdBy: world.sam.id },
        { spaceId: world.samsSpace, appId: "checklist", collection: "others", createdBy: world.sam.id },
      ].sort(
        (a, b) =>
          a.spaceId.localeCompare(b.spaceId) ||
          a.appId.localeCompare(b.appId) ||
          a.collection.localeCompare(b.collection),
      ),
    );
  });

  it("cannot store a row for an app the space does not have", () => {
    const items = itemsIn(world.kimsSpace, world.kim.id);
    expect(() => items.insert({ name: "Bread", section: "", done: false })).toThrow(/FOREIGN KEY/);
    expect(everything()).toHaveLength(2);
  });

  it("means the person of the store by `mine`, within the space", () => {
    const lin = itemsIn(world.family, world.lin.id);
    const sam = itemsIn(world.family, world.sam.id);
    lin.insert({ name: "Tea", section: "", done: false });
    sam.insert({ name: "Rice", section: "", done: false });
    expect(names(lin.list())).toEqual(["Tea", "Rice"]);
    expect(names(lin.list({ mine: true }))).toEqual(["Tea"]);
    expect(names(sam.list({ mine: true }))).toEqual(["Rice"]);
  });
});

describe("insert", () => {
  it("returns the row with what the framework records", () => {
    const row = sams().insert({ name: "Milk", section: "Dairy", done: false });
    expect(row).toEqual({
      id: expect.stringMatching(/^[0-9a-z]{24}$/),
      name: "Milk",
      section: "Dairy",
      done: false,
      createdBy: world.sam.id,
      updatedBy: world.sam.id,
      createdAt: AT.toISOString(),
      updatedAt: AT.toISOString(),
    });
    expect(sams().get(row.id)).toEqual(row);
  });

  it("stores the row under the store's space, app, collection and person", () => {
    const row = itemsIn(world.family, world.lin.id).insert({ name: "Tea", section: "", done: false });
    expect(world.db.prepare("SELECT * FROM app_rows WHERE id = ?").get(row.id)).toEqual({
      id: row.id,
      space_id: world.family,
      app_id: "checklist",
      collection: "items",
      data: JSON.stringify({ name: "Tea", section: "", done: false }),
      created_by: world.lin.id,
      updated_by: world.lin.id,
      created_at: AT.toISOString(),
      updated_at: AT.toISOString(),
    });
  });

  it("applies the schema: text is trimmed, defaults are filled, unknown fields dropped", () => {
    const row = sams().insert({ name: "  Milk  ", extra: "x", id: "chosen", createdBy: "someone" });
    expect(row.name).toBe("Milk");
    expect(row.section).toBe("");
    expect(row.done).toBe(false);
    expect(row).not.toHaveProperty("extra");
    // What every row has comes from the framework, never from the value.
    expect(row.id).not.toBe("chosen");
    expect(row.createdBy).toBe(world.sam.id);
    const stored = world.db.prepare("SELECT data FROM app_rows WHERE id = ?").get(row.id) as { data: string };
    expect(JSON.parse(stored.data)).toEqual({ name: "Milk", section: "", done: false });
  });

  it.each([
    ["an empty name", { name: "   " }],
    ["a name that is too long", { name: "x".repeat(81) }],
    ["a field of the wrong kind", { name: "Milk", done: "yes" }],
    ["no fields at all", {}],
    ["something that is not an object", "Milk"],
  ])("refuses %s as the request's fault and stores nothing", (_what, value) => {
    const error = thrownBy(() => sams().insert(value as Fields));
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe("invalid_request");
    expect((error as AppError).message).toMatch(/^items: /);
    expect(everything()).toEqual([]);
  });

  it("refuses a schema that does not accept what it stores", () => {
    const store = writableStore(world.db, scopeOf(world.samsSpace, "checklist", world.sam.id), {
      words: z.object({ length: z.string().transform((text) => text.length) }),
    });
    // Stored as a number, which the schema would not read back.
    const error = thrownBy(() => store.collections.words!.insert({ length: "four" }));
    expect(error).toBeInstanceOf(StoreUsageError);
    expect((error as Error).message).toContain('collection "words"');
    expect(everything()).toEqual([]);
  });
});

describe("get", () => {
  it("finds a row by its ID and gives null for anything else", () => {
    const row = sams().insert({ name: "Milk" });
    expect(sams().get(row.id)?.name).toBe("Milk");
    expect(sams().get("nothing")).toBeNull();
    expect(sams().get("")).toBeNull();
    expect(sams().get(undefined as unknown as string)).toBeNull();
    expect(sams().get({ id: row.id } as unknown as string)).toBeNull();
    expect(sams().get(`${row.id}' OR '1'='1`)).toBeNull();
  });
});

describe("list", () => {
  /** Three rows on the first day, in this order, and one the day after. */
  function fill(): void {
    sams().insert({ name: "Milk", section: "Dairy", done: true });
    sams().insert({ name: "Apples", section: "Fruit", done: false });
    sams().insert({ name: "Eggs", section: "Dairy", done: false });
    sams(LATER).insert({ name: "Bread", section: "", done: false });
  }

  it("gives the oldest first, and rows of one moment in the order they were inserted", () => {
    fill();
    expect(names(sams().list())).toEqual(["Milk", "Apples", "Eggs", "Bread"]);
    expect(names(sams().list({ orderBy: "createdAt" }))).toEqual(["Milk", "Apples", "Eggs", "Bread"]);
  });

  it("reverses all of it with desc", () => {
    fill();
    expect(names(sams().list({ desc: true }))).toEqual(["Bread", "Eggs", "Apples", "Milk"]);
  });

  it("orders by a field, with ties in the order they were inserted", () => {
    fill();
    expect(names(sams().list({ orderBy: "name" }))).toEqual(["Apples", "Bread", "Eggs", "Milk"]);
    expect(names(sams().list({ orderBy: "name", desc: true }))).toEqual(["Milk", "Eggs", "Bread", "Apples"]);
    expect(names(sams().list({ orderBy: "section" }))).toEqual(["Bread", "Milk", "Eggs", "Apples"]);
    expect(names(sams().list({ orderBy: "done" }))).toEqual(["Apples", "Eggs", "Bread", "Milk"]);
  });

  it("orders by when a row was last changed", () => {
    fill();
    const milk = sams().list({ where: { name: "Milk" } })[0]!;
    sams(new Date("2026-03-03T00:00:00.000Z")).update(milk.id, { done: false });
    expect(names(sams().list({ orderBy: "updatedAt" }))).toEqual(["Apples", "Eggs", "Bread", "Milk"]);
    expect(names(sams().list({ orderBy: "updatedAt", desc: true }))).toEqual(["Milk", "Bread", "Eggs", "Apples"]);
    // The order of creation is not changed by that.
    expect(names(sams().list())).toEqual(["Milk", "Apples", "Eggs", "Bread"]);
  });

  it("matches rows whose fields equal every value of where", () => {
    fill();
    expect(names(sams().list({ where: { section: "Dairy" } }))).toEqual(["Milk", "Eggs"]);
    expect(names(sams().list({ where: { section: "Dairy", done: false } }))).toEqual(["Eggs"]);
    expect(names(sams().list({ where: { done: true } }))).toEqual(["Milk"]);
    expect(names(sams().list({ where: { section: "" } }))).toEqual(["Bread"]);
    expect(names(sams().list({ where: { section: "dairy" } }))).toEqual([]);
    expect(names(sams().list({ where: {} }))).toEqual(["Milk", "Apples", "Eggs", "Bread"]);
  });

  it("takes at most `limit` rows, after ordering", () => {
    fill();
    expect(names(sams().list({ limit: 2 }))).toEqual(["Milk", "Apples"]);
    expect(names(sams().list({ limit: 1, desc: true }))).toEqual(["Bread"]);
    expect(names(sams().list({ limit: 0 }))).toEqual([]);
    expect(names(sams().list({ limit: MAX_LIST_LIMIT }))).toHaveLength(4);
  });

  it("gives 1000 rows when no limit is asked for, and up to 5000 on request", () => {
    expect([DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT]).toEqual([1000, 5000]);
    const items = sams();
    world.db.transaction(() => {
      for (let n = 0; n < DEFAULT_LIST_LIMIT + 5; n++) items.insert({ name: `Item ${n}` });
    })();
    expect(items.count()).toBe(1005);
    expect(items.list()).toHaveLength(1000);
    expect(items.list({ limit: 5000 })).toHaveLength(1005);
  });

  it.each([5001, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "10"])(
    "refuses the limit %s as a mistake in the app",
    (limit) => {
      const error = thrownBy(() => sams().list({ limit: limit as number }));
      expect(error).toBeInstanceOf(StoreUsageError);
      expect((error as Error).message).toContain("limit");
    },
  );

  it("compares a value together with its kind", () => {
    const store = writableStore(world.db, scopeOf(world.samsSpace, "checklist", world.sam.id), {
      things: z.object({
        label: z.string(),
        amount: z.number(),
        flag: z.union([z.boolean(), z.number(), z.string()]),
        note: z.string().nullable(),
      }),
    });
    const things = store.collections.things!;
    things.insert({ label: "one", amount: 1, flag: true, note: null });
    things.insert({ label: "1", amount: 1.5, flag: 1, note: "" });
    things.insert({ label: "true", amount: 0, flag: "true", note: "null" });
    things.insert({ label: "zero", amount: 0, flag: false, note: null });
    things.insert({ label: "nought", amount: 0, flag: 0, note: "x" });

    const labels = (where: Fields) => things.list({ where }).map((row) => row.label);
    expect(labels({ flag: true })).toEqual(["one"]);
    expect(labels({ flag: 1 })).toEqual(["1"]);
    expect(labels({ flag: "true" })).toEqual(["true"]);
    expect(labels({ flag: false })).toEqual(["zero"]);
    expect(labels({ flag: 0 })).toEqual(["nought"]);
    expect(labels({ amount: 1 })).toEqual(["one"]);
    expect(labels({ amount: 1.5 })).toEqual(["1"]);
    expect(labels({ amount: 0 })).toEqual(["true", "zero", "nought"]);
    expect(labels({ label: "1" })).toEqual(["1"]);
    expect(labels({ note: null })).toEqual(["one", "zero"]);
    expect(labels({ note: "null" })).toEqual(["true"]);
    expect(labels({ note: "" })).toEqual(["1"]);
    expect(things.count({ flag: true })).toBe(1);
    expect(things.count({ note: null })).toBe(2);
  });

  it("takes a value as a value, whatever it looks like", () => {
    sams().insert({ name: "Milk", section: "Dairy" });
    sams().insert({ name: "x' OR '1'='1", section: "$.name" });
    expect(names(sams().list({ where: { name: "x' OR '1'='1" } }))).toEqual(["x' OR '1'='1"]);
    expect(names(sams().list({ where: { section: "$.name" } }))).toEqual(["x' OR '1'='1"]);
    expect(names(sams().list({ where: { name: "%" } }))).toEqual([]);
  });

  it.each([
    ["a field the collection does not have", { colour: "red" }],
    ["one of the fields every row has", { createdBy: "someone" }],
    ["a name that every object has", { constructor: "x" }],
    ["a path into a field", { "name.length": 4 }],
    ["SQL in the place of a field", { "name') = 'Milk' OR ('1": "1" }],
  ])("refuses where on %s", (_what, where) => {
    sams().insert({ name: "Milk" });
    for (const run of [
      () => sams().list({ where }),
      () => sams().count(where),
      () => sams().removeWhere(where),
    ]) {
      const error = thrownBy(run);
      expect(error).toBeInstanceOf(StoreUsageError);
      expect((error as Error).message).toContain("not a field of this collection");
      expect((error as Error).message).toContain('App "checklist", collection "items"');
    }
    expect(sams().count()).toBe(1);
  });

  it.each([
    ["undefined, so that a missing input cannot widen what is matched", { section: undefined }],
    ["a list", { section: ["Dairy"] }],
    ["an object", { section: { not: "Dairy" } }],
    ["a number that is none", { section: Number.NaN }],
  ])("refuses a where value that is %s", (_what, where) => {
    sams().insert({ name: "Milk", section: "Dairy" });
    expect(thrownBy(() => sams().list({ where }))).toBeInstanceOf(StoreUsageError);
    expect(thrownBy(() => sams().count(where))).toBeInstanceOf(StoreUsageError);
    expect(thrownBy(() => sams().removeWhere(where))).toBeInstanceOf(StoreUsageError);
    expect(sams().count()).toBe(1);
  });

  it.each([["text", "section = 'Dairy'"], ["a list", ["section"]], ["null", null]])(
    "refuses a where that is %s",
    (_what, where) => {
      expect(thrownBy(() => sams().list({ where: where as unknown as Fields }))).toBeInstanceOf(StoreUsageError);
      expect(thrownBy(() => sams().removeWhere(where as unknown as Fields))).toBeInstanceOf(StoreUsageError);
    },
  );

  it("refuses to order by anything but a field of the collection", () => {
    sams().insert({ name: "Milk" });
    for (const orderBy of ["colour", "createdBy", "id", "name DESC; DROP TABLE app_rows", "constructor"]) {
      const error = thrownBy(() => sams().list({ orderBy: orderBy as "name" }));
      expect(error).toBeInstanceOf(StoreUsageError);
      expect((error as Error).message).toContain("orderBy");
    }
    expect(sams().count()).toBe(1);
  });
});

describe("rows stored before a field was added", () => {
  beforeEach(() => {
    // As an earlier version of the app, whose items had only a name, left them.
    rawRow("old-1", JSON.stringify({ name: "Flour" }));
    rawRow("old-2", JSON.stringify({ name: "Sugar" }));
    sams(LATER).insert({ name: "Milk", section: "Dairy", done: true });
    sams(LATER).insert({ name: "Salt", section: "", done: false });
  });

  it("are read with the field's default", () => {
    expect(sams().get("old-1")).toMatchObject({ id: "old-1", name: "Flour", section: "", done: false });
  });

  it("match a where that asks for the default, and no other", () => {
    expect(names(sams().list({ where: { done: false } }))).toEqual(["Flour", "Sugar", "Salt"]);
    expect(names(sams().list({ where: { done: true } }))).toEqual(["Milk"]);
    expect(names(sams().list({ where: { section: "" } }))).toEqual(["Flour", "Sugar", "Salt"]);
    expect(names(sams().list({ where: { section: "Dairy" } }))).toEqual(["Milk"]);
    expect(sams().count({ done: false })).toBe(3);
    expect(sams().count({ section: "", done: false })).toBe(3);
  });

  it("are ordered as if they held the default", () => {
    expect(names(sams().list({ orderBy: "done" }))).toEqual(["Flour", "Sugar", "Salt", "Milk"]);
    expect(names(sams().list({ orderBy: "section", desc: true }))).toEqual(["Milk", "Salt", "Sugar", "Flour"]);
  });

  it("are deleted by a removeWhere that asks for the default", () => {
    expect(sams().removeWhere({ done: false })).toBe(3);
    expect(names(sams().list())).toEqual(["Milk"]);
  });

  it("are stored in full once they are changed", () => {
    sams(LATER).update("old-1", { done: true });
    const stored = world.db.prepare("SELECT data FROM app_rows WHERE id = 'old-1'").get() as { data: string };
    expect(JSON.parse(stored.data)).toEqual({ name: "Flour", section: "", done: true });
  });

  it("do not match null or a missing value when the field has no default", () => {
    const store = writableStore(world.db, scopeOf(world.samsSpace, "checklist", world.sam.id), {
      items: z.object({ name: z.string(), note: z.string().nullable().optional() }),
    });
    const items = store.collections.items!;
    expect(items.count({ note: null })).toBe(0);
    items.insert({ name: "Tea", note: null });
    expect(names(items.list({ where: { note: null } }))).toEqual(["Tea"]);
  });
});

describe("count", () => {
  it("counts the rows, all or those matching", () => {
    expect(sams().count()).toBe(0);
    sams().insert({ name: "Milk", done: true });
    sams().insert({ name: "Eggs" });
    sams().insert({ name: "Tea" });
    expect(sams().count()).toBe(3);
    expect(sams().count({})).toBe(3);
    expect(sams().count({ done: false })).toBe(2);
    expect(sams().count({ done: true, name: "Eggs" })).toBe(0);
  });
});

describe("update", () => {
  it("changes the fields given and leaves the others", () => {
    const row = sams().insert({ name: "Milk", section: "Dairy", done: false });
    const changed = itemsIn(world.samsSpace, world.sam.id, LATER).update(row.id, { done: true });
    expect(changed).toEqual({ ...row, done: true, updatedAt: LATER.toISOString() });
    expect(sams().get(row.id)).toEqual(changed);
  });

  it("records who changed the row and when, and keeps who created it", () => {
    const row = itemsIn(world.family, world.sam.id).insert({ name: "Tea" });
    const changed = itemsIn(world.family, world.lin.id, LATER).update(row.id, { name: "Green tea" });
    expect(changed).toMatchObject({
      name: "Green tea",
      createdBy: world.sam.id,
      createdAt: AT.toISOString(),
      updatedBy: world.lin.id,
      updatedAt: LATER.toISOString(),
    });
    expect(world.db.prepare("SELECT created_by, updated_by FROM app_rows WHERE id = ?").get(row.id)).toEqual({
      created_by: world.sam.id,
      updated_by: world.lin.id,
    });
  });

  it("leaves a field alone when it is given as undefined", () => {
    const row = sams().insert({ name: "Milk", section: "Dairy" });
    const changed = sams().update(row.id, { name: undefined, done: true });
    expect(changed).toMatchObject({ name: "Milk", section: "Dairy", done: true });
  });

  it("cannot change what the framework records", () => {
    const row = sams().insert({ name: "Milk" });
    const changed = sams().update(row.id, { id: "other", createdBy: "someone", createdAt: "1999" } as Fields);
    expect(changed).toMatchObject({ id: row.id, createdBy: world.sam.id, createdAt: AT.toISOString() });
    expect(sams().get("other")).toBeNull();
  });

  it("checks the result like an insert, and changes nothing when it does not fit", () => {
    const row = sams().insert({ name: "Milk" });
    for (const patch of [{ name: "  " }, { done: "yes" }, { section: "x".repeat(41) }]) {
      const error = thrownBy(() => sams(LATER).update(row.id, patch as Fields));
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe("invalid_request");
    }
    expect(sams().get(row.id)).toEqual(row);
  });

  it("throws not_found for an ID that is not there", () => {
    sams().insert({ name: "Milk" });
    for (const id of ["nothing", "", undefined, 7]) {
      const error = thrownBy(() => sams().update(id as string, { done: true }));
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe("not_found");
    }
  });

  it.each([["nothing", undefined], ["a list", ["done"]], ["text", "done"]])(
    "refuses %s in the place of the changes",
    (_what, patch) => {
      const row = sams().insert({ name: "Milk" });
      expect(thrownBy(() => sams().update(row.id, patch as unknown as Fields))).toBeInstanceOf(StoreUsageError);
    },
  );
});

describe("remove and removeWhere", () => {
  it("removes one row by its ID, and nothing for an ID that is not there", () => {
    const milk = sams().insert({ name: "Milk" });
    sams().insert({ name: "Eggs" });
    sams().remove(milk.id);
    expect(names(sams().list())).toEqual(["Eggs"]);
    sams().remove(milk.id);
    sams().remove("nothing");
    sams().remove(undefined as unknown as string);
    expect(names(sams().list())).toEqual(["Eggs"]);
  });

  it("removes the rows that match and says how many went", () => {
    sams().insert({ name: "Milk", done: true });
    sams().insert({ name: "Eggs", done: true });
    sams().insert({ name: "Tea" });
    expect(sams().removeWhere({ done: true })).toBe(2);
    expect(names(sams().list())).toEqual(["Tea"]);
    expect(sams().removeWhere({ done: true })).toBe(0);
  });

  it("removes every row of the collection for {}, and only of that collection", () => {
    sams().insert({ name: "Milk" });
    sams().insert({ name: "Eggs" });
    const lins = itemsIn(world.linsSpace, world.lin.id);
    lins.insert({ name: "Tea" });
    expect(sams().removeWhere({})).toBe(2);
    expect(sams().count()).toBe(0);
    expect(lins.count()).toBe(1);
  });

  it("refuses a removeWhere that does not say which rows", () => {
    sams().insert({ name: "Milk" });
    const removeWhere = sams().removeWhere as (where?: Fields) => number;
    expect(thrownBy(() => removeWhere())).toBeInstanceOf(StoreUsageError);
    expect(sams().count()).toBe(1);
  });
});

describe("a stored row that no longer fits its collection", () => {
  it("fails the read, naming the app, the collection and the row but not its content", () => {
    sams().insert({ name: "Milk" });
    rawRow("bad-row", JSON.stringify({ name: 42, secret: "do not print me" }));
    for (const run of [() => sams().list(), () => sams().get("bad-row")]) {
      const error = thrownBy(run);
      expect(error).toBeInstanceOf(StoredRowError);
      expect(error).toMatchObject({ appId: "checklist", collection: "items", rowId: "bad-row" });
      const { message } = error as Error;
      expect(message).toContain('App "checklist"');
      expect(message).toContain('"bad-row"');
      expect(message).toContain('"items"');
      expect(message).toContain("name");
      expect(message).not.toContain("do not print me");
      expect(message).not.toContain("42");
    }
  });

  it("does not stop reads that leave the row out", () => {
    const milk = sams().insert({ name: "Milk", section: "Dairy" });
    rawRow("bad-row", JSON.stringify({ name: 42 }));
    expect(sams().get(milk.id)?.name).toBe("Milk");
    expect(names(sams().list({ where: { section: "Dairy" } }))).toEqual(["Milk"]);
    expect(sams().count()).toBe(2);
  });

  it("cannot be updated, and can be removed", () => {
    rawRow("bad-row", JSON.stringify({ name: 42 }));
    expect(thrownBy(() => sams().update("bad-row", { done: true }))).toBeInstanceOf(StoredRowError);
    sams().remove("bad-row");
    expect(sams().list()).toEqual([]);
  });
});

describe("a query's store", () => {
  it("has the reading methods and no others", () => {
    const row = sams().insert({ name: "Milk" });
    const store = readOnlyStore(
      world.db,
      scopeOf(world.samsSpace, "checklist", world.sam.id),
      checklistServer.collections,
    );
    expect(Object.keys(store.collections)).toEqual(["items"]);
    const items = store.collections.items!;
    expect(Object.keys(items).sort()).toEqual(["count", "get", "list"]);
    for (const method of ["insert", "update", "remove", "removeWhere"]) {
      expect(items).not.toHaveProperty(method);
    }
    expect(items.get(row.id)?.name).toBe("Milk");
    expect(names(items.list())).toEqual(["Milk"]);
    expect(items.count()).toBe(1);
  });

  it("cannot be given the missing methods afterwards", () => {
    const store = readOnlyStore(
      world.db,
      scopeOf(world.samsSpace, "checklist", world.sam.id),
      checklistServer.collections,
    );
    const writable = sams();
    expect(() => {
      (store.collections.items as unknown as Fields).insert = writable.insert;
    }).toThrow(TypeError);
    expect(() => {
      (store.collections as Fields).more = writable;
    }).toThrow(TypeError);
  });
});

describe("a closed store", () => {
  it("refuses everything, so that nothing is read or written once the request is over", () => {
    const row = sams().insert({ name: "Milk" });
    const store = writableStore(
      world.db,
      scopeOf(world.samsSpace, "checklist", world.sam.id),
      checklistServer.collections,
    );
    const items = store.collections.items!;
    expect(items.count()).toBe(1);
    store.close();

    const before = everything();
    for (const run of [
      () => items.get(row.id),
      () => items.list(),
      () => items.count(),
      () => items.insert({ name: "Eggs" }),
      () => items.update(row.id, { done: true }),
      () => items.remove(row.id),
      () => items.removeWhere({}),
    ]) {
      const error = thrownBy(run);
      expect(error).toBeInstanceOf(StoreUsageError);
      expect((error as Error).message).toContain("after the handler returned");
    }
    expect(everything()).toEqual(before);
  });

  it("does not close another request's store", () => {
    const first = writableStore(world.db, scopeOf(world.samsSpace, "checklist", world.sam.id), checklistServer.collections);
    const second = readOnlyStore(world.db, scopeOf(world.samsSpace, "checklist", world.sam.id), checklistServer.collections);
    first.close();
    expect(second.collections.items!.count()).toBe(0);
  });
});

describe("a job's store", () => {
  /** Sam's own checklist as a job's work gets it, written in Kim's name. */
  const jobScope = (): StoreScope => ({
    spaceId: world.samsSpace,
    appId: "checklist",
    userId: world.kim.id,
    job: "tidy",
    now: LATER,
  });
  const jobWrites = () => writableStore(world.db, jobScope(), checklistServer.collections);
  const jobReads = () => readOnlyStore(world.db, jobScope(), checklistServer.collections);

  it("records the person it was given, and the time, on what it writes", () => {
    const row = jobWrites().collections.items!.insert({ name: "Milk" });
    expect(row).toMatchObject({ createdBy: world.kim.id, updatedBy: world.kim.id, createdAt: LATER.toISOString() });
    const updated = jobWrites().collections.items!.update(sams().insert({ name: "Eggs" }).id, { done: true });
    expect(updated).toMatchObject({ createdBy: world.sam.id, updatedBy: world.kim.id, updatedAt: LATER.toISOString() });
  });

  it("refuses list({ mine: true }), since a job is no one, in a work that writes and one that reads", () => {
    sams().insert({ name: "Milk" });
    for (const items of [jobWrites().collections.items!, jobReads().collections.items!]) {
      const error = thrownBy(() => items.list({ mine: true }));
      expect(error).toBeInstanceOf(StoreUsageError);
      expect((error as Error).message).toBe(
        'App "checklist", collection "items": list({ mine: true }) finds the rows of the person asking, and the job "tidy" runs for no one in the space. Leave mine out.',
      );
      // Everything else reads as for anyone.
      expect(names(items.list())).toEqual(["Milk"]);
      expect(names(items.list({ mine: false }))).toEqual(["Milk"]);
    }
  });

  it("refuses everything once closed, saying that it was the job's work that kept it", () => {
    const store = jobWrites();
    const items = store.collections.items!;
    store.close();
    const error = thrownBy(() => items.insert({ name: "Milk" }));
    expect(error).toBeInstanceOf(StoreUsageError);
    expect((error as Error).message).toBe(
      'App "checklist", collection "items": the db that ctx.read or ctx.write gave the job "tidy" was used after its work returned. Work cannot keep it for later, and cannot use it after an await.',
    );
    expect(everything()).toEqual([]);
  });
});
