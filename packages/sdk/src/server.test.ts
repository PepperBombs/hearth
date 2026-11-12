/**
 * `defineServer` and its types. As in index.test.ts, the type tests are
 * checked by `pnpm typecheck`, not by the test runner.
 */
import { describe, expect, expectTypeOf, it } from "vitest";
import { defineApp, type MessageKey, type SettingsOf, type SpaceSettingsOf, type Translate } from "./index";
import {
  APP_ERROR_CODES,
  AppError,
  FETCH_ERROR_CODES,
  FetchError,
  ROW_FIELDS,
  defineServer,
  z,
  type Collection,
  type FetchResponse,
  type InputOf,
  type Job,
  type JobCtx,
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
const tidyRun = (ctx: JobCtx<typeof manifest, { items: typeof items }>) => {
  ctx.write((db) => db.items.removeWhere({ done: true }));
};
const tidy = app.job({ description: "Deletes every ticked item, once an hour.", everyMinutes: 60 }, tidyRun);
const server = app.routes({ list, find, add, clearTicked, forget, tidy });

describe("defineServer", () => {
  it("hands the framework the manifest, the collections and the routes, unchanged", () => {
    expect(server.manifest).toBe(manifest);
    expect(server.collections).toEqual({ items });
    expect(server.collections.items).toBe(items);
    expect(Object.keys(server.routes)).toEqual(["list", "find", "add", "clearTicked", "forget", "tidy"]);
    expect(server.routes.tidy).toBe(tidy);
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

  it("packages a job with what it says about itself and its function, which it does not run", () => {
    expect(tidy).toEqual({ kind: "job", description: "Deletes every ticked item, once an hour.", everyMinutes: 60, run: tidyRun });
    expect("input" in tidy).toBe(false);
    let ran = 0;
    const probe = app.job({ description: "Counts how often it ran.", everyMinutes: 15 }, async () => {
      ran += 1;
    });
    app.routes({ probe, list });
    expect(probe.run).toBeTypeOf("function");
    expect(ran).toBe(0);
  });

  it("keeps an input given to a job past the types, so that the start-up check can refuse it", () => {
    const input = z.object({ id: z.string() });
    const sloppy = (app.job as (about: object, run: () => void) => Job)(
      { description: "Takes what it cannot be given.", everyMinutes: 60, input },
      () => {},
    );
    expect(sloppy).toMatchObject({ kind: "job", input });
  });
});

describe("FetchError", () => {
  it("carries one of five codes and a message", () => {
    const error = new FetchError("refused", "feeds.example.com is not one of the hosts the manifest lists.");
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("FetchError");
    expect(error.code).toBe("refused");
    expect(error.message).toBe("feeds.example.com is not one of the hosts the manifest lists.");
    expect(FETCH_ERROR_CODES).toEqual(["refused", "timeout", "too_large", "network", "stopped"]);
  });

  it("cannot be given another code", () => {
    // @ts-expect-error not a way for a fetch to fail
    expect(new FetchError("forbidden", "No.").code).toBe("forbidden");
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

  it("only takes routes made by query, mutation and job", () => {
    // @ts-expect-error a bare function is not a route
    app.routes({ list: () => [] });
    // @ts-expect-error nor is what a job says about itself
    app.routes({ tidy: { description: "Deletes every ticked item.", everyMinutes: 60 } });
  });
});

describe("types of a job", () => {
  it("requires a description and how often it runs, and takes no input", () => {
    // @ts-expect-error every job says what it does
    app.job({ everyMinutes: 60 }, () => {});
    // @ts-expect-error and how often it runs
    app.job({ description: "Deletes every ticked item." }, () => {});
    // @ts-expect-error in minutes
    app.job({ description: "Deletes every ticked item.", everyMinutes: "hourly" }, () => {});
    // @ts-expect-error a job takes no input: it runs by itself, for no one
    app.job({ description: "Deletes every ticked item.", everyMinutes: 60, input: z.object({ id: z.string() }) }, () => {});
  });

  it("may wait, because it fetches, and answers nobody", () => {
    app.job({ description: "Waits for an answer.", everyMinutes: 60 }, async (ctx) => {
      await ctx.fetch("https://feeds.example.com/headlines.json");
    });
    app.job({ description: "Waits for nothing.", everyMinutes: 60 }, () => {});
    // @ts-expect-error a job's result goes nowhere
    app.job({ description: "Answers.", everyMinutes: 60 }, async () => 5);
  });

  it("is named apart from the queries and mutations on the finished server", () => {
    type Routes = (typeof server)["routes"];
    type JobName = { [K in keyof Routes]: Routes[K] extends { kind: "job" } ? K : never }[keyof Routes];
    type QueryOrMutation = { [K in keyof Routes]: Routes[K] extends { kind: "query" | "mutation" } ? K : never }[keyof Routes];
    expectTypeOf<JobName>().toEqualTypeOf<"tidy">();
    expectTypeOf<QueryOrMutation>().toEqualTypeOf<"list" | "find" | "add" | "clearTicked" | "forget">();
    expectTypeOf<Routes["tidy"]>().toEqualTypeOf<Job>();
  });
});

describe("types of a job's context", () => {
  type Ctx = JobCtx<typeof manifest, { items: typeof items }>;

  it("gives the space's settings and no one's own, and no person, access, language or open store", () => {
    expectTypeOf<Ctx["settings"]>().toEqualTypeOf<{ aisles: string[] }>();
    expectTypeOf<Ctx["settings"]>().toEqualTypeOf<SpaceSettingsOf<typeof server>>();
    expectTypeOf<Ctx["space"]>().toEqualTypeOf<{ readonly kind: "personal" | "group"; readonly name: string }>();
    expectTypeOf<Ctx["now"]>().toEqualTypeOf<Date>();
    expectTypeOf<Ctx>().not.toHaveProperty("user");
    expectTypeOf<Ctx>().not.toHaveProperty("access");
    expectTypeOf<Ctx>().not.toHaveProperty("locale");
    expectTypeOf<Ctx>().not.toHaveProperty("db");
    app.job({ description: "Looks at its context.", everyMinutes: 60 }, (ctx) => {
      // @ts-expect-error a person's own setting is nobody's in a job
      void ctx.settings.hideDone;
      // @ts-expect-error there is no space ID to be had
      void ctx.space.id;
      // @ts-expect-error the context cannot be changed
      ctx.now = new Date();
    });
  });

  it("reads with no way to write, and writes in a work of its own", () => {
    app.job({ description: "Reads, then writes.", everyMinutes: 60 }, (ctx) => {
      const names = ctx.read((db) => {
        expectTypeOf(db.items).toEqualTypeOf<ReadCollection<Item>>();
        expectTypeOf(db.items).not.toHaveProperty("insert");
        expectTypeOf(db.items).not.toHaveProperty("update");
        expectTypeOf(db.items).not.toHaveProperty("remove");
        expectTypeOf(db.items).not.toHaveProperty("removeWhere");
        // @ts-expect-error read gives no way to write
        db.items.insert({ name: "Milk", aisle: "", done: false });
        // @ts-expect-error nor a collection the app does not have
        db.lists.list();
        return db.items.list().map((item) => item.name);
      });
      expectTypeOf(names).toEqualTypeOf<string[]>();
      const removed = ctx.write((db) => {
        expectTypeOf(db.items).toEqualTypeOf<Collection<Item>>();
        return db.items.removeWhere({ done: true });
      });
      expectTypeOf(removed).toEqualTypeOf<number>();
      const nothing = ctx.write((db) => {
        db.items.insert({ name: "Milk", aisle: "", done: false });
      });
      expectTypeOf(nothing).toEqualTypeOf<void>();
    });
  });

  it("refuses a work that waits, which would hold its transaction open", () => {
    app.job({ description: "Tries to wait inside a transaction.", everyMinutes: 60 }, async (ctx) => {
      // @ts-expect-error work runs inside one transaction and cannot wait
      ctx.write(async (db) => db.items.removeWhere({ done: true }));
      // @ts-expect-error nor hand back a promise
      ctx.read((db) => Promise.resolve(db.items.list()));
      // Waiting comes before or after a work, never inside it.
      await ctx.fetch("https://feeds.example.com/headlines.json");
      ctx.write((db) => db.items.removeWhere({ done: true }));
    });
  });

  it("fetches with a GET and some headers, and gets the answer whole", () => {
    app.job({ description: "Fetches.", everyMinutes: 60 }, async (ctx) => {
      const answer = await ctx.fetch("https://feeds.example.com/headlines.json", { headers: { accept: "application/json" } });
      expectTypeOf(answer).toEqualTypeOf<FetchResponse>();
      expectTypeOf(answer.status).toBeNumber();
      expectTypeOf(answer.ok).toBeBoolean();
      expectTypeOf(answer.text).toBeString();
      expectTypeOf(answer.headers).toEqualTypeOf<Readonly<Record<string, string>>>();
      expectTypeOf(answer.json()).toBeUnknown();
      // @ts-expect-error a job only GETs: there is no method to choose
      await ctx.fetch("https://feeds.example.com/headlines.json", { method: "POST" });
      // @ts-expect-error nor a body to send
      await ctx.fetch("https://feeds.example.com/headlines.json", { body: "{}" });
      // @ts-expect-error a header is text
      await ctx.fetch("https://feeds.example.com/headlines.json", { headers: { "x-count": 1 } });
    });
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
