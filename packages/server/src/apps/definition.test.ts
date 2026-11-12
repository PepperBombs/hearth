/**
 * The check of what an app's `server.ts` exports, and that a server with a
 * bad one does not start (docs/mini-app-contract.md, sections A3 and A7,
 * the owner's decision 7, and for jobs section C).
 */
import { defineApp } from "@hearth/sdk";
import { defineServer, z, type Job } from "@hearth/sdk/server";
import { describe, expect, it } from "vitest";
import checklist from "../../../fixture-apps/checklist/manifest";
import checklistServer from "../../../fixture-apps/checklist/server";
import { createApp } from "../app";
import { FIXTURE_APPS, testConfig, testDatabase } from "../testing";
import { checkServer } from "./definition";
import { AppRegistryError, createRegistry } from "./registry";

const notes = defineApp({
  id: "notes",
  name: { en: "Notes", zh: "笔记" },
  description: { en: "Short notes.", zh: "简短的笔记。" },
  icon: "notebook-text",
  color: "amber",
  widget: { size: "small" },
});

const app = defineServer(notes, { notes: z.object({ text: z.string() }) });
const all = app.query({ description: "Lists every note, oldest first." }, (ctx) => ctx.db.notes.list());
const good = app.routes({ all });
const tidy = app.job({ description: "Deletes every note, once a day.", everyMinutes: 1440 }, (ctx) => {
  ctx.write((db) => db.notes.removeWhere({}));
});

/** A server file like `good`, with one thing replaced. */
const withRoutes = (routes: Record<string, unknown>) => ({ ...good, routes });
const withCollections = (collections: Record<string, unknown>) => ({ ...good, collections });

describe("checkServer", () => {
  it("finds nothing wrong with a server file made with defineServer", () => {
    expect(checkServer(good, notes)).toEqual([]);
    expect(checkServer(checklistServer, checklist)).toEqual([]);
    expect(checkServer(defineServer(notes, {}).routes({}), notes)).toEqual([]);
    expect(checkServer(app.routes({ all, tidy }), notes)).toEqual([]);
  });

  it.each([
    ["nothing", null],
    ["text", "server"],
    ["a function", () => good],
    ["a list", [good]],
    ["a builder that never called routes", app],
    ["an object without collections", { manifest: notes, routes: {} }],
    ["an object without routes", { manifest: notes, collections: {} }],
  ])("refuses %s as a server file", (_what, server) => {
    const problems = checkServer(server, notes);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("defineServer(manifest, collections).routes(");
  });

  it("refuses a server file defined with another app's manifest", () => {
    const problems = checkServer(good, checklist);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("another app's manifest");
  });

  describe("every route says what it does", () => {
    it.each([
      ["no description", { ...all, description: undefined }],
      ["an empty description", { ...all, description: "" }],
      ["a description of spaces only", { ...all, description: "   " }],
      ["a description that is not text", { ...all, description: { en: "Lists notes." } }],
    ])("refuses a query with %s", (_what, route) => {
      const problems = checkServer(withRoutes({ all: route }), notes);
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain('server route "all"');
      expect(problems[0]).toContain("Needs a description");
      expect(problems[0]).toContain("what the query does");
    });

    it("refuses a mutation without one too", () => {
      const add = app.mutation({ description: "Stores a note." }, (ctx) => ctx.db.notes.insert({ text: "x" }));
      const problems = checkServer(withRoutes({ all, add: { ...add, description: undefined } }), notes);
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain('server route "add"');
      expect(problems[0]).toContain("what the mutation does");
    });

    it("refuses one written past the types, as plain JavaScript could", () => {
      const sloppy = (app.query as (about: object, run: () => null) => unknown)({}, () => null);
      expect(checkServer(withRoutes({ sloppy }), notes)[0]).toContain("Needs a description");
    });
  });

  it.each([
    ["a bare function", () => []],
    ["nothing", null],
    ["an object of another kind", { kind: "action", description: "Does something.", run: () => null }],
    ["a route without a handler", { kind: "query", description: "Lists notes." }],
  ])("refuses %s in the place of a route", (_what, route) => {
    const problems = checkServer(withRoutes({ all: route }), notes);
    expect(problems).toEqual(['server route "all": Must be made with app.query(...), app.mutation(...) or app.job(...).']);
  });

  it("refuses a job without its function, and what a job says about itself in the place of one", () => {
    const withoutRun = { kind: tidy.kind, description: tidy.description, everyMinutes: tidy.everyMinutes };
    expect(checkServer(withRoutes({ tidy: withoutRun }), notes)).toEqual([
      'server job "tidy": Must be made with app.query(...), app.mutation(...) or app.job(...).',
    ]);
    expect(checkServer(withRoutes({ tidy: { description: tidy.description, everyMinutes: 60 } }), notes)).toEqual([
      'server route "tidy": Must be made with app.query(...), app.mutation(...) or app.job(...).',
    ]);
  });

  it("refuses an input that is not a zod schema", () => {
    const problems = checkServer(withRoutes({ all: { ...all, input: { id: "string" } } }), notes);
    expect(problems).toEqual(['server route "all": Its input must be a zod schema.']);
  });

  it.each(["get-all", "1st", "", "a.b", "über", "a b", "q/x"])("refuses the route name %j", (name) => {
    const problems = checkServer(withRoutes({ [name]: all }), notes);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(`server route "${name}"`);
    expect(problems[0]).toContain("letters, digits and underscores");
  });

  it.each(["id", "createdBy", "updatedBy", "createdAt", "updatedAt"])(
    "refuses a collection with a field named %s, which every row already has",
    (field) => {
      const problems = checkServer(
        withCollections({ notes: z.object({ text: z.string(), [field]: z.string() }) }),
        notes,
      );
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain('server collection "notes"');
      expect(problems[0]).toContain(`The field "${field}" has a name every row already has`);
    },
  );

  it("refuses a field whose name could not be matched or ordered by", () => {
    const problems = checkServer(withCollections({ notes: z.object({ "note text": z.string() }) }), notes);
    expect(problems).toEqual([
      'server collection "notes": The name of the field "note text" must be letters, digits and underscores, starting with a letter.',
    ]);
  });

  it.each([
    ["a schema that is not an object", z.array(z.string())],
    ["a plain object of schemas", { text: z.string() }],
    ["nothing", undefined],
  ])("refuses %s as a collection", (_what, schema) => {
    const problems = checkServer(withCollections({ notes: schema }), notes);
    expect(problems).toEqual(['server collection "notes": Must be a zod object schema, z.object({ ... }).']);
  });

  it("refuses a collection name that is not plain", () => {
    const problems = checkServer(withCollections({ "my-notes": z.object({ text: z.string() }) }), notes);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('server collection "my-notes": Its name must be letters');
  });

  describe("every job", () => {
    it("runs from every quarter of an hour to once a week, in whole minutes", () => {
      for (const everyMinutes of [15, 16, 60, 1440, 10080]) {
        expect(checkServer(withRoutes({ all, tidy: { ...tidy, everyMinutes } }), notes), String(everyMinutes)).toEqual([]);
      }
    });

    it.each([
      [14, "14"],
      [10081, "10081"],
      [60.5, "60.5"],
      [0, "0"],
      [-60, "-60"],
      [Number.NaN, "NaN"],
      [Number.POSITIVE_INFINITY, "Infinity"],
      ["60", '"60"'],
      [60n, "60"],
      [null, "null"],
      [undefined, "missing"],
    ])("is refused when it runs every %s minutes", (everyMinutes, shown) => {
      expect(checkServer(withRoutes({ all, tidy: { ...tidy, everyMinutes } }), notes)).toEqual([
        `server job "tidy": everyMinutes, how often it runs, must be a whole number of minutes from 15 to 10080 (a week); it is ${shown}.`,
      ]);
    });

    it.each([
      ["no description", undefined],
      ["an empty description", ""],
      ["a description of spaces only", "  "],
      ["a description that is not text", { en: "Deletes notes." }],
    ])("is refused with %s", (_what, description) => {
      expect(checkServer(withRoutes({ tidy: { ...tidy, description } }), notes)).toEqual([
        'server job "tidy": Needs a description, one English sentence saying what the job does, for a reader who has not seen the app.',
      ]);
    });

    it("is refused with an input, which it could never be given", () => {
      const input = z.object({ id: z.string() });
      const expected = ['server job "tidy": A job takes no input: it runs by itself, for no one. Leave input out.'];
      expect(checkServer(withRoutes({ tidy: { ...tidy, input } }), notes)).toEqual(expected);
      // Given to app.job past the types, as plain JavaScript could.
      const sloppy = (app.job as (about: object, run: () => void) => Job)(
        { description: "Deletes every note, once a day.", everyMinutes: 1440, input },
        () => {},
      );
      expect(checkServer(withRoutes({ tidy: sloppy }), notes)).toEqual(expected);
    });

    it("has a name like any route's, and is told apart in what is wrong with it", () => {
      expect(checkServer(withRoutes({ "tidy-up": tidy }), notes)).toEqual([
        'server job "tidy-up": Its name must be letters, digits and underscores, starting with a letter.',
      ]);
      expect(checkServer(withRoutes({ tidy: { ...tidy, description: "", everyMinutes: 5, input: z.string() } }), notes)).toHaveLength(3);
    });
  });

  it("reports everything that is wrong at once", () => {
    const problems = checkServer(
      {
        manifest: notes,
        collections: { notes: z.object({ id: z.string() }), "bad name": z.object({}) },
        routes: { all: { ...all, description: "" }, other: 7 },
      },
      notes,
    );
    expect(problems).toHaveLength(4);
  });
});

describe("the registry", () => {
  const bundled = (server: unknown) => ({ id: "notes", manifest: notes, hasPage: false, server });

  it("holds the checked server file of an app that has one, and none for one that has not", () => {
    const registry = createRegistry([...FIXTURE_APPS, bundled(good), { id: "plain", manifest: { ...notes, id: "plain" }, hasPage: false }]);
    expect(registry.get("checklist")?.server).toBe(checklistServer);
    expect(Object.keys(registry.get("checklist")?.server?.routes ?? {})).toEqual(["list", "add", "tick", "clearTicked"]);
    expect(registry.get("notes")?.server).toBe(good);
    expect(registry.get("plain")?.server).toBeUndefined();
  });

  it("refuses an app whose route has no description, naming the app and the route", () => {
    const server = withRoutes({ all: { ...all, description: undefined } });
    let error: unknown;
    try {
      createRegistry([...FIXTURE_APPS, bundled(server)]);
    } catch (thrown) {
      error = thrown;
    }
    expect(error).toBeInstanceOf(AppRegistryError);
    const { problems, message } = error as AppRegistryError;
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^App "notes": server route "all": Needs a description/);
    expect(message).toContain("Hearth cannot start");
    expect(message).toContain("server.ts");
  });

  it("stops the server from being built with a bad server file", () => {
    expect(() =>
      createApp({ config: testConfig(), db: testDatabase(), apps: [bundled({ routes: {} })] }),
    ).toThrow(AppRegistryError);
  });

  it("holds an app's jobs beside its queries, and stops the server for a job that runs too often", () => {
    const server = app.routes({ all, tidy });
    expect(createRegistry([bundled(server)]).get("notes")?.server?.routes.tidy).toBe(tidy);
    const build = () =>
      createApp({ config: testConfig(), db: testDatabase(), apps: [...FIXTURE_APPS, bundled(withRoutes({ all, tidy: { ...tidy, everyMinutes: 14 } }))] });
    expect(build).toThrow(AppRegistryError);
    expect(build).toThrow(/App "notes": server job "tidy": everyMinutes, how often it runs, must be a whole number of minutes from 15 to 10080/);
  });
});

describe("the sample checklist's routes", () => {
  it("each say what they do, in a sentence", () => {
    for (const [name, route] of Object.entries(checklistServer.routes)) {
      expect(route.description, name).toMatch(/^[A-Z].{20,}\.$/);
    }
  });

  it("are one query and three mutations", () => {
    expect(Object.entries(checklistServer.routes).map(([name, route]) => `${name}: ${route.kind}`)).toEqual([
      "list: query",
      "add: mutation",
      "tick: mutation",
      "clearTicked: mutation",
    ]);
  });
});
