/**
 * `defineServer` and its types. As in index.test.ts, the type tests are
 * checked by `pnpm typecheck`, not by the test runner.
 */
import { describe, expect, expectTypeOf, it } from "vitest";
import { defineApp, type MessageKey, type SettingsOf, type Translate } from "./index";
import {
  APP_ERROR_CODES,
  AppError,
  ROW_FIELDS,
  defineServer,
  z,
  type Collection,
  type InputOf,
  type Json,
  type MutationCtx,
  type OutputOf,
  type QueryCtx,
  type ReadCollection,
  type Row,
} from "./server";

const manifest = defineApp({
  id: "grocery",
  name: { en: "Grocery list", zh: "购物清单" },
  description: { en: "A shared shopping list, grouped by aisle.", zh: "按货架分组的共享购物清单。" },
  icon: "shopping-bag",
  color: "green",
  widget: { size: "tall" },
  settings: {
    aisles: { type: "list", scope: "space", default: [], label: { en: "Aisles", zh: "货架" } },
    hideDone: { type: "switch", scope: "user", default: false, label: { en: "Hide ticked items", zh: "隐藏已勾选的物品" } },
  },
  messages: {
    en: { empty: "Nothing to buy.", left: "{count} left" },
    zh: { empty: "没有要买的东西。", left: "还剩 {count} 项" },
  },
});

const items = z.object({
  name: z.string().trim().min(1).max(80),
  aisle: z.string().max(40).default(""),
  done: z.boolean().default(false),
  note: z.string().optional(),
});
type Item = { name: string; aisle: string; done: boolean; note?: string | undefined };

const app = defineServer(manifest, { items });

const addInput = z.object({ name: z.string(), aisle: z.string().default("") });
const list = app.query({ description: "Lists every item, oldest first." }, (ctx) => ctx.db.items.list());
const find = app.query(
  { description: "Finds one item by its ID.", input: z.object({ id: z.string() }) },
  (ctx, input) => ctx.db.items.get(input.id),
);
const add = app.mutation(
  { description: "Adds an item to the list.", input: addInput },
  (ctx, input) => ctx.db.items.insert({ ...input, done: false }),
);
const clearTicked = app.mutation({ description: "Deletes every ticked item." }, (ctx) =>
  ctx.db.items.removeWhere({ done: true }),
);
const forget = app.mutation(
  { description: "Deletes one item.", input: z.object({ id: z.string() }) },
  (ctx, { id }) => {
    ctx.db.items.remove(id);
  },
);
const server = app.routes({ list, find, add, clearTicked, forget });

describe("defineServer", () => {
  it("hands the framework the manifest, the collections and the routes, unchanged", () => {
    expect(server.manifest).toBe(manifest);
    expect(server.collections).toEqual({ items });
    expect(server.collections.items).toBe(items);
    expect(Object.keys(server.routes)).toEqual(["list", "find", "add", "clearTicked", "forget"]);
  });

  it("packages a query with what it says about itself and its handler", () => {
    expect(list.kind).toBe("query");
    expect(list.description).toBe("Lists every item, oldest first.");
    expect(list.input).toBeUndefined();
    expect("input" in list).toBe(false);
    expect(list.run).toBeTypeOf("function");
    expect(find.kind).toBe("query");
    expect(find.input?.safeParse({ id: "a" }).success).toBe(true);
    expect(find.input?.safeParse({}).success).toBe(false);
  });

  it("packages a mutation likewise, with the very input schema it was given", () => {
    expect(add.kind).toBe("mutation");
    expect(add.description).toBe("Adds an item to the list.");
    expect(add.input).toBe(addInput);
    expect(clearTicked.kind).toBe("mutation");
    expect(clearTicked.input).toBeUndefined();
  });

  it("does not run a handler by itself", () => {
    let ran = 0;
    const probe = app.query({ description: "Counts how often it ran." }, () => ++ran);
    app.routes({ probe });
    expect(ran).toBe(0);
  });
});

describe("AppError", () => {
  it("carries one of three codes and a message", () => {
    const error = new AppError("conflict", "That name is taken.");
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("AppError");
    expect(error.code).toBe("conflict");
    expect(error.message).toBe("That name is taken.");
    expect(APP_ERROR_CODES).toEqual(["invalid_request", "not_found", "conflict"]);
  });

  it("cannot be given a code a mini-app may not answer with", () => {
    // @ts-expect-error forbidden is the framework's answer, never an app's
    expect(new AppError("forbidden", "No.").code).toBe("forbidden");
  });
});

describe("the row fields", () => {
  it("are the ones Row adds to a collection's own", () => {
    expect([...ROW_FIELDS].sort()).toEqual(["createdAt", "createdBy", "id", "updatedAt", "updatedBy"]);
    expectTypeOf<(typeof ROW_FIELDS)[number]>().toEqualTypeOf<Exclude<keyof Row<Item>, keyof Item>>();
  });
});

describe("types of a handler's context", () => {
  it("gives a query read-only collections of the schema's output", () => {
    type Ctx = QueryCtx<typeof manifest, { items: typeof items }>;
    expectTypeOf<Ctx["db"]["items"]>().toEqualTypeOf<ReadCollection<Item>>();
    expectTypeOf<Ctx["db"]["items"]>().not.toHaveProperty("insert");
    expectTypeOf<Ctx["db"]["items"]>().not.toHaveProperty("update");
    expectTypeOf<Ctx["db"]["items"]>().not.toHaveProperty("remove");
    expectTypeOf<Ctx["db"]["items"]>().not.toHaveProperty("removeWhere");
    app.query({ description: "Tries to write." }, (ctx) => {
      // @ts-expect-error a query cannot write
      ctx.db.items.insert({ name: "Milk", aisle: "", done: false });
      // @ts-expect-error nor reach a collection the app does not have
      ctx.db.lists.list();
      return null;
    });
  });

  it("gives a mutation collections it can write to", () => {
    type Ctx = MutationCtx<typeof manifest, { items: typeof items }>;
    expectTypeOf<Ctx["db"]["items"]>().toEqualTypeOf<Collection<Item>>();
    expectTypeOf<Ctx["db"]["items"]["insert"]>().returns.toEqualTypeOf<Row<Item>>();
    expectTypeOf<Ctx["db"]["items"]["removeWhere"]>().returns.toBeNumber();
  });

  it("types the rest of the context, with the app's own settings", () => {
    app.query({ description: "Looks at its context." }, (ctx) => {
      expectTypeOf(ctx.settings).toEqualTypeOf<{ aisles: string[]; hideDone: boolean }>();
      expectTypeOf(ctx.user).toEqualTypeOf<{ readonly id: string; readonly name: string }>();
      expectTypeOf(ctx.locale).toEqualTypeOf<"en" | "zh">();
      expectTypeOf(ctx.space).toEqualTypeOf<{ readonly kind: "personal" | "group"; readonly name: string }>();
      expectTypeOf(ctx.access).toEqualTypeOf<"view" | "edit">();
      expectTypeOf(ctx.now).toEqualTypeOf<Date>();
      // @ts-expect-error there is no space ID to be had
      void ctx.space.id;
      // @ts-expect-error the context cannot be changed
      ctx.access = "edit";
      return null;
    });
  });

  it("checks what a handler asks of a collection", () => {
    app.mutation({ description: "Uses a collection wrongly." }, (ctx) => {
      // @ts-expect-error a field the collection does not have
      ctx.db.items.list({ where: { colour: "red" } });
      // @ts-expect-error a value of the wrong type
      ctx.db.items.list({ where: { done: "yes" } });
      // @ts-expect-error not something to order by
      ctx.db.items.list({ orderBy: "createdBy" });
      // @ts-expect-error a required field is missing
      ctx.db.items.insert({ name: "Milk" });
      // @ts-expect-error a field of the wrong type
      ctx.db.items.update("a", { done: 1 });
      ctx.db.items.list({ where: { aisle: "Dairy", done: false }, mine: true, orderBy: "name", desc: true, limit: 5 });
      ctx.db.items.list({ orderBy: "updatedAt" });
    });
  });
});

describe("types of a route", () => {
  it("carries what a caller sends and what comes back", () => {
    expectTypeOf<InputOf<typeof list>>().toBeVoid();
    expectTypeOf<OutputOf<typeof list>>().toEqualTypeOf<Row<Item>[]>();
    expectTypeOf<InputOf<typeof find>>().toEqualTypeOf<{ id: string }>();
    expectTypeOf<OutputOf<typeof find>>().toEqualTypeOf<Row<Item> | null>();
    // What is sent is the schema's input: `aisle` has a default, so it may be left out.
    expectTypeOf<InputOf<typeof add>>().toEqualTypeOf<{ name: string; aisle?: string | undefined }>();
    expectTypeOf<OutputOf<typeof add>>().toEqualTypeOf<Row<Item>>();
    expectTypeOf<InputOf<typeof clearTicked>>().toBeVoid();
    expectTypeOf<OutputOf<typeof clearTicked>>().toBeNumber();
    expectTypeOf<OutputOf<typeof forget>>().toBeVoid();
  });

  it("tells queries from mutations by name on the finished server", () => {
    type Routes = (typeof server)["routes"];
    type QueryName = { [K in keyof Routes]: Routes[K] extends { kind: "query" } ? K : never }[keyof Routes];
    type MutationName = { [K in keyof Routes]: Routes[K] extends { kind: "mutation" } ? K : never }[keyof Routes];
    expectTypeOf<QueryName>().toEqualTypeOf<"list" | "find">();
    expectTypeOf<MutationName>().toEqualTypeOf<"add" | "clearTicked" | "forget">();
    expectTypeOf<InputOf<Routes["add"]>>().toEqualTypeOf<{ name: string; aisle?: string | undefined }>();
  });

  it("hands the handler the schema's output", () => {
    app.mutation({ description: "Looks at its input.", input: addInput }, (_ctx, input) => {
      expectTypeOf(input).toEqualTypeOf<{ name: string; aisle: string }>();
    });
  });

  it("requires a description", () => {
    // @ts-expect-error every route says what it does
    app.query({}, () => null);
    // @ts-expect-error also one with input
    app.mutation({ input: addInput }, () => null);
  });

  it("refuses an async handler and an answer that is not JSON", () => {
    // @ts-expect-error a handler runs inside one transaction and cannot wait
    app.query({ description: "Waits." }, async () => 1);
    // @ts-expect-error a promise is not an answer either
    app.mutation({ description: "Waits." }, () => Promise.resolve());
    // @ts-expect-error a date does not survive JSON
    app.query({ description: "Says when." }, (ctx) => ({ at: ctx.now }));
    // @ts-expect-error nor does a function
    app.query({ description: "Returns a function." }, () => () => 1);
    // @ts-expect-error a query answers with something
    app.query({ description: "Answers nothing." }, () => {});
    app.query({ description: "Answers with JSON." }, (ctx) => ({ at: ctx.now.toISOString(), tags: ["a"], n: null }));
  });

  it("accepts a row as JSON, optional fields included", () => {
    expectTypeOf<Row<Item>>().toExtend<Json>();
    expectTypeOf<Row<Item>[]>().toExtend<Json>();
    expectTypeOf<readonly string[]>().toExtend<Json>();
    expectTypeOf<Date>().not.toExtend<Json>();
    expectTypeOf<undefined>().not.toExtend<Json>();
  });

  it("only takes routes made by query and mutation", () => {
    // @ts-expect-error a bare function is not a route
    app.routes({ list: () => [] });
  });
});

describe("an app's server stands for its manifest", () => {
  it("in SettingsOf and the message types", () => {
    expectTypeOf<SettingsOf<typeof server>>().toEqualTypeOf<SettingsOf<typeof manifest>>();
    expectTypeOf<SettingsOf<typeof server>>().toEqualTypeOf<{ aisles: string[]; hideDone: boolean }>();
    expectTypeOf<MessageKey<typeof server>>().toEqualTypeOf<"empty" | "left">();
    const t = (() => "") as Translate<typeof server>;
    t("empty");
    t("left", { count: 3 });
    // @ts-expect-error the placeholder is required
    t("left");
    // @ts-expect-error not a key of this app
    t("nope");
  });
});
