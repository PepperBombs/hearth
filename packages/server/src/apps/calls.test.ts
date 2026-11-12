/**
 * A mini-app's queries and mutations through the routes
 * `POST /api/spaces/:spaceId/apps/:appId/q/:name` and `.../m/:name`
 * (docs/mini-app-contract.md, sections A3, A6 and A8): who may call them,
 * what they are given, and what becomes of what a handler does wrong.
 */
import { defineApp } from "@hearth/sdk";
import { AppError, defineServer, z, type AppErrorCode, type Json } from "@hearth/sdk/server";
import { apiErrorSchema, appCallResponseSchema, type ApiErrorCode } from "@hearth/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NOTHING_HERE } from "../http/errors";
import { as, testApp } from "../testing";
import { AppFaultError } from "./calls";
import type { BundledApp } from "./registry";
import { StoredRowError, StoreUsageError } from "./store";
import { APPS, family, grant, install, KIM, LIN, NOA, NOW, SAM } from "./test-world";

const BASE = "http://hearth.example.com";

let world: ReturnType<typeof family>;
let app: ReturnType<typeof testApp>["app"];
let errors: unknown[];

/* -------------------------------------------------------------------------
 * A second sample app, for what the checklist has no reason to do: looking
 * at its own context and getting things wrong in every way a handler can.
 * ---------------------------------------------------------------------- */
const probeManifest = defineApp({
  id: "probe",
  name: { en: "Probe", zh: "探针" },
  description: { en: "Reports what a handler is given.", zh: "报告处理函数收到的内容。" },
  icon: "box",
  color: "blue",
  widget: { size: "small" },
  settings: {
    greeting: { type: "text", scope: "space", default: "Hello", label: { en: "Greeting", zh: "问候语" } },
    tags: { type: "list", scope: "user", default: ["first"], label: { en: "Tags", zh: "标签" } },
  },
});

const probe = defineServer(probeManifest, {
  notes: z.object({ text: z.string().min(1).max(20), stars: z.number().default(0) }),
});

const WRITING = ["insert", "update", "remove", "removeWhere"] as const;

/** What a handler was given, in a form that can be sent back. */
function report(ctx: object): Json {
  const { user, locale, space, access, settings, now, db } = ctx as {
    user: { id: string; name: string };
    locale: string;
    space: { kind: string; name: string };
    access: string;
    settings: { greeting: string; tags: string[] };
    now: Date;
    db: Record<string, object>;
  };
  return {
    keys: Object.keys(ctx).sort(),
    user,
    locale,
    space,
    access,
    settings,
    now: now.toISOString(),
    nowIsADate: now instanceof Date,
    collections: Object.keys(db),
    methods: Object.keys(db.notes ?? {}).sort(),
    frozen: [ctx, user, space, db, db.notes].every((part) => Object.isFrozen(part)),
    inTransaction: world.db.inTransaction,
  };
}

const probeServer = probe.routes({
  context: probe.query({ description: "Reports what a query is given." }, (ctx) => report(ctx)),
  contextOfChange: probe.mutation({ description: "Reports what a mutation is given." }, (ctx) => report(ctx)),
  all: probe.query({ description: "Lists every note, oldest first." }, (ctx) => ctx.db.notes.list()),
  find: probe.query(
    { description: "Finds one note by its ID.", input: z.object({ id: z.string() }) },
    (ctx, { id }) => ctx.db.notes.get(id),
  ),
  write: probe.mutation(
    { description: "Stores a note.", input: z.object({ text: z.string() }) },
    (ctx, input) => ctx.db.notes.insert({ text: input.text, stars: 0 }),
  ),
  shaped: probe.mutation(
    {
      description: "Answers with its input as the handler received it.",
      input: z.object({ text: z.string().trim().toUpperCase(), stars: z.coerce.number().default(3) }),
    },
    (_ctx, input) => input,
  ),
  nothing: probe.mutation({ description: "Stores a note and answers with nothing." }, (ctx) => {
    ctx.db.notes.insert({ text: "quiet", stars: 0 });
  }),
  touchSettings: probe.query({ description: "Changes the settings it was given and answers with them." }, (ctx) => {
    ctx.settings.tags.push("added");
    return ctx.settings.tags;
  }),
  fail: probe.mutation(
    {
      description: "Stores a note and then goes wrong in the way it is asked to.",
      input: z.object({
        how: z.enum(["invalid_request", "not_found", "conflict", "forbidden", "crash", "bigint", "promise", "cycle"]),
      }),
    },
    (ctx, { how }): Json => {
      ctx.db.notes.insert({ text: `before ${how}`.slice(0, 20), stars: 0 });
      switch (how) {
        case "crash":
          throw new Error("boom: a secret from inside the app");
        case "bigint":
          return 1n as unknown as Json;
        case "promise":
          return Promise.resolve("later") as unknown as Json;
        case "cycle": {
          const loop: Record<string, unknown> = {};
          loop.self = loop;
          return loop as Json;
        }
        default:
          throw new AppError(how as AppErrorCode, `The app said ${how}.`);
      }
    },
  ),
  // The two async handlers get past the type check only through a cast, as
  // JavaScript that ignores the types would.
  lateWrite: probe.mutation({ description: "Waits, then stores a note." }, (async (ctx: {
    db: { notes: { insert(value: { text: string; stars: number }): unknown } };
  }) => {
    await Promise.resolve();
    late.attempts += 1;
    try {
      ctx.db.notes.insert({ text: "late", stars: 0 });
    } catch (error) {
      late.error = error;
      throw error;
    }
  }) as never),
  lateRead: probe.query({ description: "Waits, then lists the notes." }, (async (ctx: {
    db: { notes: { list(): unknown[] } };
  }) => {
    await Promise.resolve();
    late.attempts += 1;
    try {
      return ctx.db.notes.list();
    } catch (error) {
      late.error = error;
      throw error;
    }
  }) as never),
  sneak: probe.query({ description: "Tries to write from a query and says which ways were open." }, (ctx) => {
    const notes = ctx.db.notes as unknown as Record<string, ((...args: unknown[]) => unknown) | undefined>;
    const open: string[] = [];
    for (const method of WRITING) {
      if (method in notes) open.push(method);
      try {
        notes[method]!(method === "insert" ? { text: "sneaked", stars: 0 } : {});
        open.push(`${method} ran`);
      } catch {
        // Not there: that is the point.
      }
    }
    return open;
  }),
  badWhere: probe.query({ description: "Asks for notes by a field they do not have." }, (ctx) =>
    ctx.db.notes.list({ where: { colour: "red" } as never }),
  ),
  waitingInput: probe.query(
    {
      description: "Has an input schema that waits for something.",
      input: z.string().refine(async () => true),
    },
    () => null,
  ),
  // A job is never a route, whichever way it is asked for.
  tidy: probe.job({ description: "Deletes every note, once an hour.", everyMinutes: 60 }, (ctx) => {
    jobRuns += 1;
    ctx.write((db) => db.notes.removeWhere({}));
  }),
});

/** What the two async handlers did after the request was answered. */
let late: { attempts: number; error: unknown };
/** How often the probe's job ran. */
let jobRuns = 0;

const PROBE: BundledApp = { id: "probe", manifest: probeManifest, hasPage: false, server: probeServer };
const ALL_APPS: readonly BundledApp[] = [...APPS, PROBE];

/** A server over the same database holding the given apps. */
function serverWith(apps: readonly BundledApp[]) {
  return testApp({ db: world.db, apps });
}

beforeEach(() => {
  world = family();
  ({ app, errors } = serverWith(ALL_APPS));
  late = { attempts: 0, error: undefined };
  jobRuns = 0;
});

function post(who: string | null, path: string, body: unknown, on = app) {
  const headers: Record<string, string> = who ? as(who) : {};
  headers["content-type"] = "application/json";
  return on.request(`${BASE}${path}`, {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const envelope = (input: unknown) => (input === undefined ? {} : { input });
const query = (who: string | null, spaceId: string, appId: string, name: string, input?: unknown, on = app) =>
  post(who, `/api/spaces/${spaceId}/apps/${appId}/q/${name}`, envelope(input), on);
const mutate = (who: string | null, spaceId: string, appId: string, name: string, input?: unknown, on = app) =>
  post(who, `/api/spaces/${spaceId}/apps/${appId}/m/${name}`, envelope(input), on);

/** The answer of a call that worked. Strict, so that nothing but `output` may be in it. */
async function outputOf(response: Response): Promise<unknown> {
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("application/json");
  return appCallResponseSchema.strict().parse(await response.json()).output;
}

async function expectError(response: Response, status: number, code: ApiErrorCode): Promise<string> {
  expect(response.status).toBe(status);
  const { error } = apiErrorSchema.parse(await response.json());
  expect(error.code).toBe(code);
  return error.message;
}

type StoredRow = {
  id: string;
  space_id: string;
  app_id: string;
  collection: string;
  data: string;
  created_by: string;
  updated_by: string;
};

/** Every stored row, as the database has it. */
const rows = () => world.db.prepare("SELECT * FROM app_rows ORDER BY rowid").all() as StoredRow[];

type Item = { id: string; name: string; section: string; done: boolean; createdBy: string; updatedBy: string };

/** The names on a checklist, as its `list` query gives them to this person. */
async function listed(who: string, spaceId: string, on = app): Promise<string[]> {
  const items = (await outputOf(await query(who, spaceId, "checklist", "list", undefined, on))) as Item[];
  return items.map((item) => item.name);
}

async function addItem(who: string, spaceId: string, name: string): Promise<Item> {
  return (await outputOf(await mutate(who, spaceId, "checklist", "add", { name }))) as Item;
}

describe("the sample checklist", () => {
  beforeEach(() => {
    install(world.db, world.samsSpace, "checklist", world.sam.id);
  });

  it("starts empty", async () => {
    expect(await listed(SAM, world.samsSpace)).toEqual([]);
  });

  it("adds an item and lists it, with what the framework records", async () => {
    const before = Date.now();
    const item = await addItem(SAM, world.samsSpace, "  Water the plants ");
    expect(item).toEqual({
      id: expect.stringMatching(/^[0-9a-z]{24}$/),
      name: "Water the plants",
      section: "",
      done: false,
      createdBy: world.sam.id,
      updatedBy: world.sam.id,
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    });
    const { createdAt, updatedAt } = item as Item & { createdAt: string; updatedAt: string };
    expect(updatedAt).toBe(createdAt);
    expect(Date.parse(createdAt)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(createdAt)).toBeLessThanOrEqual(Date.now());

    expect(await outputOf(await query(SAM, world.samsSpace, "checklist", "list"))).toEqual([item]);
  });

  it("stores the row under the space and app of the address and the signed-in person", async () => {
    const item = await addItem(SAM, world.samsSpace, "Milk");
    expect(rows()).toEqual([
      expect.objectContaining({
        id: item.id,
        space_id: world.samsSpace,
        app_id: "checklist",
        collection: "items",
        created_by: world.sam.id,
        updated_by: world.sam.id,
      }),
    ]);
  });

  it("ticks an item and clears the ticked ones", async () => {
    const milk = await addItem(SAM, world.samsSpace, "Milk");
    await addItem(SAM, world.samsSpace, "Eggs");
    const ticked = (await outputOf(
      await mutate(SAM, world.samsSpace, "checklist", "tick", { id: milk.id, done: true }),
    )) as Item;
    expect(ticked).toMatchObject({ id: milk.id, name: "Milk", done: true });

    expect(await outputOf(await mutate(SAM, world.samsSpace, "checklist", "clearTicked"))).toBe(1);
    expect(await listed(SAM, world.samsSpace)).toEqual(["Eggs"]);
    expect(await outputOf(await mutate(SAM, world.samsSpace, "checklist", "clearTicked"))).toBe(0);
  });

  it("answers a tick of an item that is not there with 404 from the app", async () => {
    const message = await expectError(
      await mutate(SAM, world.samsSpace, "checklist", "tick", { id: "nothing", done: true }),
      404,
      "not_found",
    );
    expect(message).toBe("items: There is no row with this ID.");
    expect(errors).toEqual([]);
  });
});

describe("two spaces with the same app", () => {
  beforeEach(() => {
    install(world.db, world.samsSpace, "checklist", world.sam.id);
    install(world.db, world.linsSpace, "checklist", world.lin.id);
    install(world.db, world.family, "checklist", world.sam.id, { memberAccess: "edit" });
  });

  it("keep their rows apart", async () => {
    await addItem(SAM, world.samsSpace, "Sam's own");
    await addItem(LIN, world.linsSpace, "Lin's own");
    await addItem(SAM, world.family, "From Sam");
    await addItem(LIN, world.family, "From Lin");

    expect(await listed(SAM, world.samsSpace)).toEqual(["Sam's own"]);
    expect(await listed(LIN, world.linsSpace)).toEqual(["Lin's own"]);
    expect(await listed(SAM, world.family)).toEqual(["From Sam", "From Lin"]);
    expect(await listed(LIN, world.family)).toEqual(["From Sam", "From Lin"]);
    expect(rows().map((row) => row.space_id)).toEqual([
      world.samsSpace,
      world.linsSpace,
      world.family,
      world.family,
    ]);
  });

  it("do not let a row of one be changed through another", async () => {
    const own = await addItem(SAM, world.samsSpace, "Sam's own");
    const before = rows();
    // Lin knows the ID, and has edit access to the same app in two other spaces.
    for (const spaceId of [world.linsSpace, world.family]) {
      await expectError(
        await mutate(LIN, spaceId, "checklist", "tick", { id: own.id, done: true }),
        404,
        "not_found",
      );
    }
    // Nor by Sam, through the family's list.
    await expectError(
      await mutate(SAM, world.family, "checklist", "tick", { id: own.id, done: true }),
      404,
      "not_found",
    );
    expect(rows()).toEqual(before);
  });

  it("clear only their own ticked items", async () => {
    const own = await addItem(SAM, world.samsSpace, "Sam's own");
    const shared = await addItem(SAM, world.family, "Shared");
    await mutate(SAM, world.samsSpace, "checklist", "tick", { id: own.id, done: true });
    await mutate(SAM, world.family, "checklist", "tick", { id: shared.id, done: true });

    expect(await outputOf(await mutate(LIN, world.family, "checklist", "clearTicked"))).toBe(1);
    expect(await listed(SAM, world.family)).toEqual([]);
    expect(await listed(SAM, world.samsSpace)).toEqual(["Sam's own"]);
  });

  it("record who changed a shared row", async () => {
    const item = await addItem(SAM, world.family, "Shared");
    const ticked = (await outputOf(
      await mutate(LIN, world.family, "checklist", "tick", { id: item.id, done: true }),
    )) as Item;
    expect(ticked).toMatchObject({ createdBy: world.sam.id, updatedBy: world.lin.id, done: true });
  });
});

describe("who may call an app's routes", () => {
  /** A request for the family's checklist that must find nothing. */
  type Case = { who: string; spaceId?: () => string; appId?: string; prepare?: () => void; apps?: readonly BundledApp[] };
  const cases: [string, Case][] = [
    ["someone who is not in the space", { who: NOA }],
    ["a member when the app is for nobody but the owners", { who: LIN }],
    [
      "a member an owner shut out of an app the others can use",
      {
        who: LIN,
        prepare: () => {
          world.db.prepare("UPDATE space_apps SET member_access = 'edit' WHERE space_id = 'family'").run();
          grant(world.db, world.family, "checklist", world.lin.id, "none", world.sam.id);
        },
      },
    ],
    [
      "an owner once the app was removed from the space",
      {
        who: SAM,
        prepare: () => {
          world.db.prepare("UPDATE space_apps SET removed_at = ? WHERE space_id = 'family'").run(NOW);
        },
      },
    ],
    ["an owner asking for an app the space does not have", { who: SAM, appId: "journal" }],
    ["an owner asking for an app nobody has heard of", { who: SAM, appId: "nothing" }],
    ["anyone asking for a space that does not exist", { who: SAM, spaceId: () => "nowhere" }],
    ["an owner when the server holds no code for the app", { who: SAM, apps: APPS.filter((entry) => entry.id !== "checklist") }],
  ];

  beforeEach(() => {
    install(world.db, world.family, "checklist", world.sam.id);
    world.db
      .prepare(
        `INSERT INTO app_rows (id, space_id, app_id, collection, data, created_by, updated_by, created_at, updated_at)
         VALUES ('row-1', 'family', 'checklist', 'items', '{"name":"Milk","done":true}', ?, ?, ?, ?)`,
      )
      .run(world.sam.id, world.sam.id, NOW, NOW);
  });

  it.each(cases)("answers 404 to %s, for a query and a mutation alike, and changes nothing", async (_what, entry) => {
    entry.prepare?.();
    const on = entry.apps ? serverWith(entry.apps).app : app;
    const spaceId = entry.spaceId?.() ?? world.family;
    const appId = entry.appId ?? "checklist";
    const before = rows();

    const answers = [
      await query(entry.who, spaceId, appId, "list", undefined, on),
      await mutate(entry.who, spaceId, appId, "add", { name: "Eggs" }, on),
      await mutate(entry.who, spaceId, appId, "clearTicked", undefined, on),
      // The same answer whether or not the app has a route of that name, or the input is any good.
      await query(entry.who, spaceId, appId, "nothing", undefined, on),
      await mutate(entry.who, spaceId, appId, "add", { name: 7 }, on),
    ];
    for (const response of answers) {
      expect(await expectError(response, 404, "not_found")).toBe(NOTHING_HERE);
    }
    expect(rows()).toEqual(before);
    expect(errors).toEqual([]);
  });

  it("answers 401 to a request that carries no sign-in", async () => {
    await expectError(await query(null, world.family, "checklist", "list"), 401, "unauthenticated");
    await expectError(await mutate(null, world.family, "checklist", "clearTicked"), 401, "unauthenticated");
    expect(rows()).toHaveLength(1);
  });

  it("answers 404 for an app that has no server file", async () => {
    install(world.db, world.samsSpace, "journal", world.sam.id);
    await expectError(await query(SAM, world.samsSpace, "journal", "list"), 404, "not_found");
    await expectError(await mutate(SAM, world.samsSpace, "journal", "add", { name: "x" }), 404, "not_found");
  });

  describe("with view access", () => {
    beforeEach(() => {
      world.db.prepare("UPDATE space_apps SET member_access = 'view' WHERE space_id = 'family'").run();
    });

    it("can query", async () => {
      expect(await listed(LIN, world.family)).toEqual(["Milk"]);
    });

    it("cannot mutate: 403, and nothing is written", async () => {
      const before = rows();
      for (const [name, input] of [
        ["add", { name: "Eggs" }],
        ["tick", { id: "row-1", done: false }],
        ["clearTicked", undefined],
      ] as const) {
        await expectError(await mutate(LIN, world.family, "checklist", name, input), 403, "forbidden");
      }
      expect(rows()).toEqual(before);
      expect(errors).toEqual([]);
    });

    it("is told 403 before anything about the input", async () => {
      await expectError(await mutate(LIN, world.family, "checklist", "add", { name: 7 }), 403, "forbidden");
      await expectError(await mutate(LIN, world.family, "checklist", "add"), 403, "forbidden");
    });

    it("cannot reach a mutation as a query", async () => {
      await expectError(await query(LIN, world.family, "checklist", "clearTicked"), 404, "not_found");
      expect(rows()).toHaveLength(1);
    });

    it("can mutate once an owner makes an exception, and the others still cannot", async () => {
      grant(world.db, world.family, "checklist", world.kim.id, "edit", world.sam.id);
      expect(await outputOf(await mutate(KIM, world.family, "checklist", "clearTicked"))).toBe(1);
      await expectError(await mutate(LIN, world.family, "checklist", "clearTicked"), 403, "forbidden");
    });
  });

  it("lets a member with edit access and every owner mutate", async () => {
    world.db.prepare("UPDATE space_apps SET member_access = 'edit' WHERE space_id = 'family'").run();
    expect((await addItem(LIN, world.family, "Eggs")).createdBy).toBe(world.lin.id);
    expect((await addItem(SAM, world.family, "Tea")).createdBy).toBe(world.sam.id);
    expect(await listed(KIM, world.family)).toEqual(["Milk", "Eggs", "Tea"]);
  });

  it("goes by the access of the moment", async () => {
    world.db.prepare("UPDATE space_apps SET member_access = 'edit' WHERE space_id = 'family'").run();
    await addItem(LIN, world.family, "Eggs");
    world.db.prepare("UPDATE space_apps SET member_access = 'view' WHERE space_id = 'family'").run();
    await expectError(await mutate(LIN, world.family, "checklist", "add", { name: "Tea" }), 403, "forbidden");
    world.db.prepare("UPDATE space_apps SET member_access = 'none' WHERE space_id = 'family'").run();
    await expectError(await query(LIN, world.family, "checklist", "list"), 404, "not_found");
  });
});

describe("the address of a route", () => {
  beforeEach(() => {
    install(world.db, world.samsSpace, "checklist", world.sam.id);
  });

  it.each(["nothing", "List", "constructor", "__proto__", "toString", "hasOwnProperty", "list.json", "%20"])(
    "answers 404 for the name %s",
    async (name) => {
      await expectError(await query(SAM, world.samsSpace, "checklist", name), 404, "not_found");
      await expectError(await mutate(SAM, world.samsSpace, "checklist", name), 404, "not_found");
      expect(errors).toEqual([]);
    },
  );

  it("does not run a mutation asked for as a query, nor a query asked for as a mutation", async () => {
    const item = await addItem(SAM, world.samsSpace, "Milk");
    await mutate(SAM, world.samsSpace, "checklist", "tick", { id: item.id, done: true });
    await expectError(await query(SAM, world.samsSpace, "checklist", "clearTicked"), 404, "not_found");
    await expectError(await query(SAM, world.samsSpace, "checklist", "add", { name: "Eggs" }), 404, "not_found");
    await expectError(await mutate(SAM, world.samsSpace, "checklist", "list"), 404, "not_found");
    expect(await listed(SAM, world.samsSpace)).toEqual(["Milk"]);
  });

  it("does not run a job asked for as a query or a mutation, whatever access the caller has", async () => {
    install(world.db, world.family, "probe", world.sam.id, { memberAccess: "view" });
    await outputOf(await mutate(SAM, world.family, "probe", "write", { text: "kept" }));
    for (const who of [SAM, LIN]) {
      await expectError(await query(who, world.family, "probe", "tidy"), 404, "not_found");
      await expectError(await mutate(who, world.family, "probe", "tidy"), 404, "not_found");
    }
    expect(jobRuns).toBe(0);
    expect(rows().map((row) => JSON.parse(row.data).text)).toEqual(["kept"]);
    expect(errors).toEqual([]);
  });

  it("answers only POST", async () => {
    for (const method of ["GET", "PUT", "DELETE"]) {
      const response = await app.request(`${BASE}/api/spaces/${world.samsSpace}/apps/checklist/q/list`, {
        method,
        headers: as(SAM),
      });
      await expectError(response, 404, "not_found");
    }
  });
});

describe("the input of a route", () => {
  beforeEach(() => {
    install(world.db, world.samsSpace, "checklist", world.sam.id);
    install(world.db, world.samsSpace, "probe", world.sam.id);
  });

  const at = (name: string) => `/api/spaces/${world.samsSpace}/apps/checklist/m/${name}`;

  it.each([
    ["a body that is not JSON", "add", "name=Milk"],
    ["a body that is not an object", "add", ["Milk"]],
    ["the input outside its envelope", "add", { name: "Milk" }],
    ["something beside the input", "add", { input: { name: "Milk" }, spaceId: "family" }],
    ["no input where the route needs one", "add", {}],
    ["input of the wrong kind", "add", { input: "Milk" }],
    ["a field of the wrong kind", "add", { input: { name: 7 } }],
    ["a field missing", "tick", { input: { id: "x" } }],
    ["input for a route that takes none", "clearTicked", { input: {} }],
    ["null for a route that takes none", "clearTicked", { input: null }],
  ])("refuses %s with 400 and stores nothing", async (_what, name, body) => {
    await expectError(await post(SAM, at(name), body), 400, "invalid_request");
    expect(rows()).toEqual([]);
    expect(errors).toEqual([]);
  });

  it("says where the input is wrong", async () => {
    const message = await expectError(
      await mutate(SAM, world.samsSpace, "checklist", "tick", { id: "x", done: "yes" }),
      400,
      "invalid_request",
    );
    expect(message).toMatch(/^input\.done: /);
    expect(
      await expectError(await mutate(SAM, world.samsSpace, "checklist", "clearTicked", {}), 400, "invalid_request"),
    ).toBe("input: This route takes no input.");
  });

  it("holds a value to the collection's rules too, as the request's fault", async () => {
    for (const name of ["   ", "x".repeat(81)]) {
      const message = await expectError(
        await mutate(SAM, world.samsSpace, "checklist", "add", { name }),
        400,
        "invalid_request",
      );
      expect(message).toMatch(/^items: name: /);
    }
    expect(rows()).toEqual([]);
    expect(errors).toEqual([]);
  });

  it("hands the handler what the input schema makes of the input", async () => {
    expect(await outputOf(await mutate(SAM, world.samsSpace, "probe", "shaped", { text: "  loud " }))).toEqual({
      text: "LOUD",
      stars: 3,
    });
    expect(
      await outputOf(await mutate(SAM, world.samsSpace, "probe", "shaped", { text: "a", stars: "5", more: true })),
    ).toEqual({ text: "A", stars: 5 });
  });

  it("answers 500 for an input schema that would have to wait", async () => {
    await expectError(await query(SAM, world.samsSpace, "probe", "waitingInput", "x"), 500, "internal");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(AppFaultError);
  });
});

describe("the answer of a route", () => {
  beforeEach(() => {
    install(world.db, world.samsSpace, "probe", world.sam.id);
  });

  it("is {} when the handler returns nothing, and the change is kept", async () => {
    const response = await mutate(SAM, world.samsSpace, "probe", "nothing");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({});
    expect(rows()).toHaveLength(1);
  });

  it("carries null as an output of its own", async () => {
    const response = await query(SAM, world.samsSpace, "probe", "find", { id: "nothing" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ output: null });
  });

  it("is never kept by a browser or a proxy", async () => {
    const response = await query(SAM, world.samsSpace, "probe", "all");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});

describe("what a handler is given", () => {
  type Report = {
    keys: string[];
    user: unknown;
    locale: string;
    space: unknown;
    access: string;
    settings: unknown;
    now: string;
    nowIsADate: boolean;
    collections: string[];
    methods: string[];
    frozen: boolean;
    inTransaction: boolean;
  };

  beforeEach(() => {
    install(world.db, world.samsSpace, "probe", world.sam.id);
    install(world.db, world.family, "probe", world.sam.id, { memberAccess: "view" });
  });

  it("is the person, their language, the space without its ID, their access, the settings and the time", async () => {
    const before = Date.now();
    const seen = (await outputOf(await query(LIN, world.family, "probe", "context"))) as Report;
    expect(seen).toMatchObject({
      keys: ["access", "db", "locale", "now", "settings", "space", "user"],
      user: { id: world.lin.id, name: world.lin.name },
      locale: "zh",
      space: { kind: "group", name: "Family" },
      access: "view",
      settings: { greeting: "Hello", tags: ["first"] },
      nowIsADate: true,
      collections: ["notes"],
    });
    expect(Date.parse(seen.now)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(seen.now)).toBeLessThanOrEqual(Date.now());
    // Neither the space's ID nor anyone's email address is anywhere in it.
    const text = JSON.stringify(seen);
    expect(text).not.toContain(world.family);
    expect(text).not.toContain("@");
  });

  it("is a personal space without a name for an app in one", async () => {
    const seen = (await outputOf(await query(SAM, world.samsSpace, "probe", "context"))) as Report;
    expect(seen).toMatchObject({
      user: { id: world.sam.id, name: world.sam.name },
      locale: "en",
      space: { kind: "personal", name: "" },
      access: "edit",
    });
    expect(JSON.stringify(seen)).not.toContain(world.samsSpace);
  });

  it("gives a query collections that can only be read, and a mutation ones that can be written", async () => {
    const reading = (await outputOf(await query(SAM, world.family, "probe", "context"))) as Report;
    expect(reading.methods).toEqual(["count", "get", "list"]);
    const writing = (await outputOf(await mutate(SAM, world.family, "probe", "contextOfChange"))) as Report;
    expect(writing.methods).toEqual(["count", "get", "insert", "list", "remove", "removeWhere", "update"]);
    expect(writing.access).toBe("edit");
  });

  it("cannot be changed by the handler", async () => {
    const seen = (await outputOf(await query(SAM, world.family, "probe", "context"))) as Report;
    expect(seen.frozen).toBe(true);
  });

  it("runs the handler inside the transaction that checked who is asking", async () => {
    expect(world.db.inTransaction).toBe(false);
    const reading = (await outputOf(await query(SAM, world.family, "probe", "context"))) as Report;
    expect(reading.inTransaction).toBe(true);
    const writing = (await outputOf(await mutate(SAM, world.family, "probe", "contextOfChange"))) as Report;
    expect(writing.inTransaction).toBe(true);
    expect(world.db.inTransaction).toBe(false);
  });

  it("does not let one request's changes to its settings reach the next", async () => {
    expect(await outputOf(await query(SAM, world.samsSpace, "probe", "touchSettings"))).toEqual(["first", "added"]);
    expect(await outputOf(await query(SAM, world.samsSpace, "probe", "touchSettings"))).toEqual(["first", "added"]);
    expect(probeManifest.settings?.tags.default).toEqual(["first"]);
  });
});

describe("transactions", () => {
  beforeEach(() => {
    install(world.db, world.samsSpace, "probe", world.sam.id);
  });

  it("reads in a deferred transaction and writes in an immediate one", async () => {
    const begun: string[] = [];
    const real = world.db.transaction.bind(world.db);
    vi.spyOn(world.db, "transaction").mockImplementation(((run: (...args: unknown[]) => unknown) => {
      const transaction = real(run);
      const noting =
        (mode: "default" | "deferred" | "immediate" | "exclusive") =>
        (...args: unknown[]) => {
          begun.push(mode);
          return mode === "default" ? transaction(...args) : transaction[mode](...args);
        };
      return Object.assign(noting("default"), {
        deferred: noting("deferred"),
        immediate: noting("immediate"),
        exclusive: noting("exclusive"),
      });
    }) as never);

    await outputOf(await query(SAM, world.samsSpace, "probe", "all"));
    expect(begun).toEqual(["deferred"]);
    await outputOf(await mutate(SAM, world.samsSpace, "probe", "write", { text: "kept" }));
    expect(begun).toEqual(["deferred", "immediate"]);
    vi.restoreAllMocks();
  });

  it("keeps everything a mutation wrote", async () => {
    await outputOf(await mutate(SAM, world.samsSpace, "probe", "write", { text: "one" }));
    await outputOf(await mutate(SAM, world.samsSpace, "probe", "write", { text: "two" }));
    expect(rows().map((row) => (JSON.parse(row.data) as { text: string }).text)).toEqual(["one", "two"]);
  });
});

describe("a handler that turns the request down", () => {
  beforeEach(() => {
    install(world.db, world.samsSpace, "probe", world.sam.id);
  });

  it.each([
    ["invalid_request", 400],
    ["not_found", 404],
    ["conflict", 409],
  ] as const)("answers an AppError %s with %i and its message, and keeps nothing it wrote", async (code, status) => {
    const message = await expectError(
      await mutate(SAM, world.samsSpace, "probe", "fail", { how: code }),
      status,
      code,
    );
    expect(message).toBe(`The app said ${code}.`);
    expect(rows()).toEqual([]);
    // Turning a request down is not a fault.
    expect(errors).toEqual([]);
  });

  it("treats a code a mini-app may not answer with as a fault", async () => {
    await expectError(await mutate(SAM, world.samsSpace, "probe", "fail", { how: "forbidden" }), 500, "internal");
    expect(rows()).toEqual([]);
    expect(errors).toHaveLength(1);
  });
});

describe("a handler that goes wrong", () => {
  beforeEach(() => {
    install(world.db, world.samsSpace, "probe", world.sam.id);
  });

  /** The one fault that was logged. */
  function fault(): AppFaultError {
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(AppFaultError);
    return errors[0] as AppFaultError;
  }

  it("answers 500 without a word of the error, logs it with the app and the route, and keeps nothing", async () => {
    const message = await expectError(
      await mutate(SAM, world.samsSpace, "probe", "fail", { how: "crash" }),
      500,
      "internal",
    );
    expect(message).not.toContain("secret");
    expect(message).not.toContain("probe");
    expect(rows()).toEqual([]);
    expect(fault().message).toBe('Mini-app "probe": the mutation "fail" failed.');
    expect((fault().cause as Error).message).toBe("boom: a secret from inside the app");
  });

  it("refuses a mutation that returns a promise and keeps nothing it wrote", async () => {
    await expectError(await mutate(SAM, world.samsSpace, "probe", "fail", { how: "promise" }), 500, "internal");
    expect(rows()).toEqual([]);
    expect(fault().message).toContain('the mutation "fail" returned a promise');
    expect(fault().message).toContain("must not be async");
  });

  it("refuses an async mutation, and what it tries after waiting does not land", async () => {
    await expectError(await mutate(SAM, world.samsSpace, "probe", "lateWrite"), 500, "internal");
    expect(fault().message).toContain("returned a promise");
    // Let the handler run on past its await.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(late.attempts).toBe(1);
    expect(late.error).toBeInstanceOf(StoreUsageError);
    expect((late.error as Error).message).toContain("after the handler returned");
    expect(rows()).toEqual([]);
    expect(world.db.inTransaction).toBe(false);
  });

  it("refuses an async query, which cannot read after waiting either", async () => {
    await outputOf(await mutate(SAM, world.samsSpace, "probe", "write", { text: "kept" }));
    await expectError(await query(SAM, world.samsSpace, "probe", "lateRead"), 500, "internal");
    expect(fault().message).toContain('the query "lateRead" returned a promise');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(late.attempts).toBe(1);
    expect(late.error).toBeInstanceOf(StoreUsageError);
  });

  it.each(["bigint", "cycle"])("answers 500 for an answer that is not JSON (%s) and keeps nothing", async (how) => {
    await expectError(await mutate(SAM, world.samsSpace, "probe", "fail", { how }), 500, "internal");
    expect(rows()).toEqual([]);
    expect(fault().message).toContain("cannot be sent as JSON");
  });

  it("gives a query no way to write, whatever its code tries", async () => {
    expect(await outputOf(await query(SAM, world.samsSpace, "probe", "sneak"))).toEqual([]);
    expect(rows()).toEqual([]);
  });

  it("treats a where on a field the collection lacks as the app's fault", async () => {
    await expectError(await query(SAM, world.samsSpace, "probe", "badWhere"), 500, "internal");
    expect(fault().cause).toBeInstanceOf(StoreUsageError);
    expect((fault().cause as Error).message).toContain('"colour", which is not a field of this collection');
  });

  it("fails a query over a stored row that no longer fits, and logs the app, the collection and the row", async () => {
    world.db
      .prepare(
        `INSERT INTO app_rows (id, space_id, app_id, collection, data, created_by, updated_by, created_at, updated_at)
         VALUES ('old-row', ?, 'probe', 'notes', '{"text":""}', ?, ?, ?, ?)`,
      )
      .run(world.samsSpace, world.sam.id, world.sam.id, NOW, NOW);
    await expectError(await query(SAM, world.samsSpace, "probe", "all"), 500, "internal");
    const cause = fault().cause;
    expect(cause).toBeInstanceOf(StoredRowError);
    expect(cause).toMatchObject({ appId: "probe", collection: "notes", rowId: "old-row" });
  });

  it("goes on answering after a fault", async () => {
    await expectError(await mutate(SAM, world.samsSpace, "probe", "fail", { how: "crash" }), 500, "internal");
    await outputOf(await mutate(SAM, world.samsSpace, "probe", "write", { text: "fine" }));
    expect(rows()).toHaveLength(1);
  });
});
