/**
 * `@hearth/sdk/testing`: the types an app's tests are written with, and the
 * hand-over to whatever the framework installs. The framework's own
 * implementation is tested in packages/server/src/apps/app-testing.test.ts.
 * As in index.test.ts, the type tests are checked by `pnpm typecheck`.
 */
import { afterEach, describe, expect, expectTypeOf, it } from "vitest";
import { defineApp } from "./index";
import { defineServer, z, type Row } from "./server";
import {
  APP_CALL_ERROR_CODES,
  AppCallError,
  testApp,
  type JobRun,
  type RunJobOptions,
  type StandInAnswer,
  type StandInFetch,
  type StandInRequest,
  type TestApp,
  type TestCaller,
} from "./testing";
import { provideTestApp, providedTestApp, type TestAppHandle } from "./testing-host";

const manifest = defineApp({
  id: "grocery",
  name: { en: "Grocery list", zh: "购物清单" },
  description: { en: "A shared shopping list, grouped by aisle.", zh: "按货架分组的共享购物清单。" },
  icon: "shopping-bag",
  color: "green",
  widget: { size: "tall" },
  settings: {
    aisles: { type: "list", scope: "space", default: [], label: { en: "Aisles", zh: "货架" } },
    sort: {
      type: "select",
      scope: "user",
      default: "added",
      options: { added: { en: "As added", zh: "按添加顺序" }, name: { en: "By name", zh: "按名称" } },
      label: { en: "Order", zh: "顺序" },
    },
  },
});

const app = defineServer(manifest, {
  items: z.object({ name: z.string().min(1), done: z.boolean().default(false) }),
});

const server = app.routes({
  list: app.query({ description: "Lists every item." }, (ctx) => ctx.db.items.list()),
  find: app.query(
    { description: "Finds one item by its ID.", input: z.object({ id: z.string() }) },
    (ctx, input) => ctx.db.items.get(input.id),
  ),
  add: app.mutation(
    { description: "Adds an item.", input: z.object({ name: z.string() }) },
    (ctx, input) => ctx.db.items.insert({ ...input, done: false }),
  ),
  clear: app.mutation({ description: "Deletes every item." }, (ctx) => {
    ctx.db.items.removeWhere({});
  }),
  tidy: app.job({ description: "Deletes every ticked item, once an hour.", everyMinutes: 60 }, (ctx) => {
    ctx.write((db) => db.items.removeWhere({ done: true }));
  }),
});

type Server = typeof server;
type Item = Row<{ name: string; done: boolean }>;

afterEach(() => provideTestApp(null));

describe("testApp's types", () => {
  // The calls below are for the type checker only: these functions never run.
  it("calls the app's routes by name, with their input, and gives their output", () => {
    const calls = (caller: TestCaller<Server>) => {
      expectTypeOf(caller.query("list")).toEqualTypeOf<Item[]>();
      expectTypeOf(caller.query("find", { id: "x" })).toEqualTypeOf<Item | null>();
      expectTypeOf(caller.mutation("add", { name: "Milk" })).toEqualTypeOf<Item>();
      expectTypeOf(caller.mutation("clear")).toEqualTypeOf<void>();
      expectTypeOf(caller.user).toEqualTypeOf<{ readonly id: string; readonly name: string }>();

      // @ts-expect-error a mutation is not a query
      caller.query("add", { name: "Milk" });
      // @ts-expect-error a query is not a mutation
      caller.mutation("list");
      // @ts-expect-error no route of that name
      caller.query("nope");
      // @ts-expect-error the route needs its input
      caller.query("find");
      // @ts-expect-error the route takes no input
      caller.query("list", {});
      // @ts-expect-error a job is not called like a query
      caller.query("tidy");
      // @ts-expect-error nor like a mutation
      caller.mutation("tidy");
    };
    expectTypeOf(calls).toBeFunction();
  });

  it("reads and saves settings by name, typed from the manifest", () => {
    const calls = (caller: TestCaller<Server>) => {
      expectTypeOf(caller.settings()).toEqualTypeOf<{ aisles: string[]; sort: "added" | "name" }>();
      expectTypeOf(caller.saveSettings).parameter(0).toEqualTypeOf<{ aisles?: string[]; sort?: "added" | "name" }>();
      // @ts-expect-error not an option of the select
      caller.saveSettings({ sort: "price" });
    };
    expectTypeOf(calls).toBeFunction();
  });

  it("takes what a server file exports, and nothing else", () => {
    expectTypeOf(testApp<Server>).returns.toEqualTypeOf<TestApp<Server>>();
    expectTypeOf(testApp<Server>).parameter(1).toEqualTypeOf<{ space?: "personal" | "group" } | undefined>();
    // @ts-expect-error a manifest has no routes to test
    expectTypeOf(testApp<typeof manifest>).toBeFunction();
  });

  it("runs a job by its name, with stand-ins for what it fetches, and says how the run went", () => {
    const calls = async (world: TestApp<Server>) => {
      const fetch: StandInFetch = (request) => {
        expectTypeOf(request).toEqualTypeOf<StandInRequest>();
        expectTypeOf(request.url).toEqualTypeOf<string>();
        expectTypeOf(request.headers).toEqualTypeOf<Readonly<Record<string, string>>>();
        return { status: 200, headers: { etag: '"1"' }, body: { items: [] } };
      };
      const run = await world.runJob("tidy", { fetch, now: new Date() });
      expectTypeOf(run).toEqualTypeOf<JobRun>();
      if (run.ok) expectTypeOf(run.error).toEqualTypeOf<null>();
      else expectTypeOf(run.error).toEqualTypeOf<string>();
      expectTypeOf(world.runJob("tidy")).toEqualTypeOf<Promise<JobRun>>();
      // A stand-in may take its time, and may answer with nothing but a status.
      await world.runJob("tidy", { fetch: async () => ({ status: 503 }) });

      // @ts-expect-error a query is no job
      await world.runJob("list");
      // @ts-expect-error nor is a mutation
      await world.runJob("clear");
      // @ts-expect-error no job of that name
      await world.runJob("nope");
      // @ts-expect-error the time is a Date
      await world.runJob("tidy", { now: "2026-03-01T08:00:00.000Z" });
      // @ts-expect-error a stand-in answers with an answer
      await world.runJob("tidy", { fetch: () => "OK" });
    };
    expectTypeOf(calls).toBeFunction();
    expectTypeOf<RunJobOptions>().toEqualTypeOf<{ fetch?: StandInFetch; now?: Date }>();
    expectTypeOf<StandInAnswer>().toEqualTypeOf<{ status?: number; headers?: Record<string, string>; body?: unknown }>();
    expectTypeOf<ReturnType<StandInFetch>>().toEqualTypeOf<StandInAnswer | Promise<StandInAnswer>>();
  });

  it("shows a person how a job is doing, as useJob does, and asks for a run as they would", () => {
    type Shown = { succeededAt: string | null; failedAt: string | null; running: boolean; canRun: boolean };
    const calls = (caller: TestCaller<Server>) => {
      expectTypeOf(caller.job("tidy")).toEqualTypeOf<Shown>();
      expectTypeOf(caller.requestRun("tidy")).toEqualTypeOf<Shown>();

      // @ts-expect-error a query has no status
      caller.job("list");
      // @ts-expect-error nor can it be asked to run
      caller.requestRun("add");
      // @ts-expect-error no job of that name
      caller.job("nope");
    };
    expectTypeOf(calls).toBeFunction();

    // An app without jobs has none to name.
    const quiet = app.routes({ list: app.query({ description: "Lists every item." }, (ctx) => ctx.db.items.list()) });
    expect(Object.keys(quiet.routes)).toEqual(["list"]);
    const none = (world: TestApp<typeof quiet>) => {
      // @ts-expect-error no job at all
      void world.runJob("list");
      // @ts-expect-error nor a status
      world.as().job("list");
    };
    expectTypeOf(none).toBeFunction();
  });
});

describe("testApp", () => {
  it("says how to run the tests when nothing supplies it", () => {
    expect(providedTestApp()).toBeNull();
    expect(() => testApp(server)).toThrow('Run them with "hearth-apps test"');
  });

  it("hands the server and the options to what the framework installed, and gives back its answer", async () => {
    const calls: unknown[][] = [];
    const idle = { succeededAt: null, failedAt: null, running: false, canRun: true };
    const handle: TestAppHandle = {
      space: { kind: "group", name: "Family" },
      as: () => ({
        user: { id: "user-1", name: "Sam" },
        query: (name, input) => ({ name, input }),
        mutation: () => undefined,
        settings: () => ({}),
        saveSettings: (values) => values,
        job: (name) => ({ ...idle, failedAt: name }),
        requestRun: (name) => ({ ...idle, running: true, failedAt: name }),
      }),
      runJob: (name, options) => Promise.resolve({ ok: false, error: `${name} at ${options?.now?.toISOString() ?? "no time"}` }),
    };
    provideTestApp((...args) => {
      calls.push(args);
      return handle;
    });

    const world = testApp(server, { space: "personal" });
    expect(calls).toEqual([[server, { space: "personal" }]]);
    expect(world).toBe(handle);
    expect(world.as().query("find", { id: "row-1" })).toEqual({ name: "find", input: { id: "row-1" } });
    expect(world.as().job("tidy")).toEqual({ ...idle, failedAt: "tidy" });
    expect(world.as().requestRun("tidy")).toEqual({ ...idle, running: true, failedAt: "tidy" });
    const now = new Date(Date.UTC(2026, 2, 1, 8));
    expect(await world.runJob("tidy", { now })).toEqual({ ok: false, error: "tidy at 2026-03-01T08:00:00.000Z" });
    expect(await world.runJob("tidy")).toEqual({ ok: false, error: "tidy at no time" });

    testApp(server);
    expect(calls[1]).toEqual([server, {}]);
  });
});

describe("AppCallError", () => {
  it("starts its message with the code, so that toThrow(code) reads as it means", () => {
    const error = new AppCallError(403, "forbidden", "Changing anything in this app needs edit access to it.");
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ name: "AppCallError", status: 403, code: "forbidden" });
    expect(error.message).toBe("forbidden: Changing anything in this app needs edit access to it.");
    expect(() => {
      throw error;
    }).toThrow("forbidden");
    expect(APP_CALL_ERROR_CODES).toEqual(["invalid_request", "forbidden", "not_found", "conflict"]);
  });
});
