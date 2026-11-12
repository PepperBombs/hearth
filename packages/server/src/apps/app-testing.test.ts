/**
 * `testApp` from `@hearth/sdk/testing` with the framework's implementation
 * (app-testing.ts), as `hearth-apps test` hands it over: what a mini-app's
 * own tests rely on. The command itself, running an app's test files, is
 * tested in packages/sdk/tools/cli.test.ts.
 */
import { defineApp } from "@hearth/sdk";
import { AppError, defineServer, FetchError, z, type JobCtx } from "@hearth/sdk/server";
import {
  AppCallError,
  testApp,
  type StandInFetch,
  type StandInRequest,
  type TestApp,
  type TestAppOptions,
} from "@hearth/sdk/testing";
import { provideTestApp, type TestAppHandle, type TestCallerHandle } from "@hearth/sdk/testing/host";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import checklist from "../../../fixture-apps/checklist/server";
import { migrate, openDatabase, type Db } from "../db/database";
import { DEFAULT_PERSON, TEST_GROUP_NAME, createTestApp, type TestWorldParts } from "./app-testing";
import { AppFaultError } from "./calls";
import { ANSWER_TIME_LIMIT_MS } from "./fetch";
import { RUN_TIME_LIMIT_MS } from "./jobs";
import { fakeClock, settle } from "./test-clock";

beforeAll(() => provideTestApp(createTestApp));
afterAll(() => provideTestApp(null));

const notes = defineApp({
  id: "notes",
  name: { en: "Notes", zh: "笔记" },
  description: { en: "Short notes.", zh: "简短的笔记。" },
  icon: "notebook-text",
  color: "amber",
  widget: { size: "small" },
  settings: {
    title: { type: "text", scope: "space", default: "Notes", maxLength: 20, label: { en: "Title", zh: "标题" } },
    size: { type: "number", scope: "user", default: 12, min: 8, max: 24, step: 1, label: { en: "Size", zh: "大小" } },
  },
});

const app = defineServer(notes, { notes: z.object({ text: z.string().min(1), at: z.string().default("") }) });

const server = app.routes({
  whoami: app.query({ description: "Says who is asking, where and with which access." }, (ctx) => ({
    id: ctx.user.id,
    name: ctx.user.name,
    locale: ctx.locale,
    space: ctx.space,
    access: ctx.access,
    settings: ctx.settings,
  })),
  mine: app.query({ description: "Lists the notes the caller wrote." }, (ctx) => ctx.db.notes.list({ mine: true })),
  all: app.query({ description: "Lists every note." }, (ctx) => ctx.db.notes.list()),
  write: app.mutation(
    { description: "Writes a note, with when it is about.", input: z.object({ text: z.string(), at: z.string().default("") }) },
    (ctx, input) => ctx.db.notes.insert(input),
  ),
  taken: app.mutation({ description: "Turns every request down as a conflict." }, () => {
    throw new AppError("conflict", "That note is taken.");
  }),
  broken: app.query({ description: "Fails, as a bug in an app would." }, () => {
    throw new Error("A bug.");
  }),
  later: app.query({ description: "Answers with a promise, which no handler may." }, () => Promise.resolve(1) as never),
});

describe("testApp with the framework's implementation", () => {
  it("calls queries and mutations as the server answers them, with the store of a database of its own", () => {
    const world = testApp(checklist);
    expect(world.space).toEqual({ kind: "group", name: TEST_GROUP_NAME });
    const sam = world.as();
    expect(sam.user.name).toBe(DEFAULT_PERSON);

    const milk = sam.mutation("add", { name: " Milk " });
    expect(milk).toMatchObject({ name: "Milk", section: "", done: false, createdBy: sam.user.id, updatedBy: sam.user.id });
    expect(sam.query("list")).toEqual([milk]);
    expect(sam.mutation("clearTicked")).toBe(0);

    // Every testApp starts empty.
    expect(testApp(checklist).as().query("list")).toEqual([]);
  });

  it("is one person for one name, with the name, language and access asked for", () => {
    const world = testApp(server);
    const lin = world.as({ name: "Lin", locale: "zh", access: "view" });
    const sam = world.as({ name: "Sam" });

    expect(lin.query("whoami")).toEqual({
      id: lin.user.id,
      name: "Lin",
      locale: "zh",
      space: { kind: "group", name: TEST_GROUP_NAME },
      access: "view",
      settings: { title: "Notes", size: 12 },
    });
    expect(sam.query("whoami")).toMatchObject({ name: "Sam", locale: "en", access: "edit" });
    expect(sam.user.id).not.toBe(lin.user.id);

    // The same Lin, now with edit: her notes are hers, whichever caller wrote them.
    const linEdits = world.as({ name: "Lin" });
    expect(linEdits.user).toEqual(lin.user);
    linEdits.mutation("write", { text: "Lin's" });
    sam.mutation("write", { text: "Sam's" });
    expect(lin.query("mine").map((note) => note.text)).toEqual(["Lin's"]);
    expect(lin.query("all").map((note) => note.text)).toEqual(["Lin's", "Sam's"]);
    // And each caller keeps the access it was made with.
    expect(() => lin.mutation("write", { text: "Not with view" })).toThrow(AppCallError);
    expect(lin.query("whoami")).toMatchObject({ access: "view", locale: "zh" });
  });

  it("turns calls down as the routes do, with the code first in the message", () => {
    const viewer = testApp(server).as({ access: "view" });
    const refusal = (call: () => unknown) => {
      try {
        call();
      } catch (error) {
        return error;
      }
      throw new Error("The call was not turned down.");
    };

    expect(refusal(() => viewer.mutation("write", { text: "x" }))).toMatchObject({
      name: "AppCallError",
      status: 403,
      code: "forbidden",
      message: "forbidden: Changing anything in this app needs edit access to it.",
    });
    const editor = testApp(server).as();
    // What the types would not let a test write, as a caller that ignores them would send it.
    const untyped = editor as unknown as TestCallerHandle;
    expect(refusal(() => editor.mutation("write", { text: "" }))).toMatchObject({ status: 400, code: "invalid_request" });
    expect(refusal(() => editor.mutation("write", { text: 1 } as never))).toMatchObject({ status: 400, code: "invalid_request" });
    expect(refusal(() => untyped.query("nope"))).toMatchObject({ status: 404, code: "not_found" });
    // A mutation is not there as a query, nor the other way round.
    expect(refusal(() => untyped.query("write", { text: "x" }))).toMatchObject({ code: "not_found" });
    expect(refusal(() => untyped.mutation("all"))).toMatchObject({ code: "not_found" });
    expect(refusal(() => editor.mutation("taken"))).toMatchObject({ status: 409, code: "conflict", message: "conflict: That note is taken." });
    expect(refusal(() => untyped.query("all", {}))).toMatchObject({
      code: "invalid_request",
      message: "invalid_request: input: This route takes no input.",
    });
    expect(editor.query("all")).toEqual([]);
  });

  it("sends the input through JSON, as a browser does", () => {
    const sam = testApp(server).as();
    const note = sam.mutation("write", { text: "Dentist", at: new Date(Date.UTC(2026, 0, 2)) as unknown as string });
    expect(note.at).toBe("2026-01-02T00:00:00.000Z");
    // Undefined is left out, so the schema's default applies.
    expect(sam.mutation("write", { text: "Later", at: undefined })).toMatchObject({ at: "" });
  });

  it("gives a handler's fault as the error the server would log, so the test fails", () => {
    const sam = testApp(server).as();
    expect(() => sam.query("broken")).toThrow(AppFaultError);
    expect(() => sam.query("broken")).toThrow('Mini-app "notes": the query "broken" failed.');
    expect(() => sam.query("later")).toThrow("returned a promise");
  });

  it("reads and saves settings by name, each under its scope, as the settings routes do", () => {
    const world = testApp(server);
    const sam = world.as({ name: "Sam" });
    const lin = world.as({ name: "Lin", access: "view" });

    expect(lin.settings()).toEqual({ title: "Notes", size: 12 });
    expect(sam.saveSettings({ title: "Family notes", size: 16 })).toEqual({ title: "Family notes", size: 16 });
    // The space's title is everyone's; the size was Sam's own.
    expect(lin.settings()).toEqual({ title: "Family notes", size: 12 });
    expect(lin.query("whoami")).toMatchObject({ settings: { title: "Family notes", size: 12 } });

    // View access saves a person's own, and not the space's.
    expect(lin.saveSettings({ size: 20 })).toEqual({ title: "Family notes", size: 20 });
    expect(() => lin.saveSettings({ title: "Mine" })).toThrow("forbidden");
    expect(() => lin.saveSettings({ title: "Mine", size: 9 })).toThrow("forbidden");
    expect(lin.settings()).toEqual({ title: "Family notes", size: 20 });

    // Names and values are checked against the manifest.
    expect(() => sam.saveSettings({ colour: "red" } as never)).toThrow("invalid_request: user.colour: This app has no setting");
    expect(() => sam.saveSettings({ size: 30 })).toThrow("invalid_request: user.size:");
    expect(() => sam.saveSettings({ size: { big: true } } as never)).toThrow("invalid_request");
    expect(sam.settings()).toEqual({ title: "Family notes", size: 16 });
  });

  it("puts an app that allows only personal spaces in one, with its one person", () => {
    const journal = defineApp({ ...notes, id: "journal", spaces: ["personal"] });
    const journalApp = defineServer(journal, {});
    const journalServer = journalApp.routes({
      whoami: journalApp.query({ description: "Says who is asking and where." }, (ctx) => ({ name: ctx.user.name, space: ctx.space, access: ctx.access })),
    });

    const world = testApp(journalServer);
    expect(world.space).toEqual({ kind: "personal", name: "" });
    expect(world.as({ name: "Kim" }).query("whoami")).toEqual({ name: "Kim", space: { kind: "personal", name: "" }, access: "edit" });
    expect(world.as({ name: "Kim" }).query("whoami")).toMatchObject({ name: "Kim" });
    expect(() => world.as({ name: "Lin" })).toThrow("a personal space has one person, Kim");
    expect(() => world.as({ name: "Kim", access: "view" })).toThrow("may always edit");
    expect(() => testApp(journalServer, { space: "group" })).toThrow("cannot be added to a group space");

    // An app that allows both may be put in a personal space when asked.
    expect(testApp(server, { space: "personal" }).as().query("whoami")).toMatchObject({
      space: { kind: "personal", name: "" },
      access: "edit",
    });
  });

  it("refuses an app the server would refuse at start-up, and anything that is not a server file", () => {
    const silent = { ...server, routes: { ...server.routes, all: { ...server.routes.all, description: " " } } };
    expect(() => testApp(silent)).toThrow(/the server would not start with this app:\n {2}- App "notes": server route "all": Needs a description/);
    expect(() => testApp(notes as never)).toThrow("testApp takes what an app's server.ts exports");
    expect(() => testApp(server).as({ name: "" })).toThrow("needs a name");
    expect(() => testApp(server).as({ access: "own" as never })).toThrow('"view" or "edit"');
  });
});

/* -------------------------------------------------------------------------
 * Jobs in an app's tests (docs/mini-app-contract.md, section C, "Testing")
 * ---------------------------------------------------------------------- */

const tickerManifest = defineApp({
  id: "ticker",
  name: { en: "Ticker", zh: "快讯" },
  description: { en: "Keeps the latest headlines of a feed.", zh: "保存一个订阅源的最新标题。" },
  icon: "file-text",
  color: "teal",
  widget: { size: "small" },
  network: ["feeds.example.com"],
  settings: {
    topic: { type: "text", scope: "space", default: "news", label: { en: "Topic", zh: "主题" } },
    compact: { type: "switch", scope: "user", default: false, label: { en: "Compact", zh: "紧凑" } },
  },
});

const tickerCollections = { items: z.object({ text: z.string().max(200) }) };
const ticker = defineServer(tickerManifest, tickerCollections);
type TickerCtx = JobCtx<typeof tickerManifest, typeof tickerCollections>;

const FEED = "https://feeds.example.com/headlines.json";

/** The refresh as an app would write it: fetch the feed of the space's topic, then keep its items in place of the old. */
async function keepFeed(ctx: TickerCtx): Promise<void> {
  const answer = await ctx.fetch(`${FEED}?topic=${ctx.settings.topic}`, { headers: { accept: "application/json" } });
  if (!answer.ok) throw new Error(`The feed answered ${answer.status}.`);
  const { items } = z.object({ items: z.array(z.string()) }).parse(answer.json());
  ctx.write((db) => {
    db.items.removeWhere({});
    for (const text of items) db.items.insert({ text });
  });
}

/** What the refresh does in the test at hand: keepFeed unless it says otherwise. */
let behaviour: (ctx: TickerCtx) => Promise<void> | void = keepFeed;

const tickerServer = ticker.routes({
  latest: ticker.query({ description: "Lists the headlines kept, oldest first." }, (ctx) => ctx.db.items.list()),
  refresh: ticker.job(
    { description: "Fetches the headlines of the space's topic and keeps them, every hour.", everyMinutes: 60 },
    (ctx) => behaviour(ctx),
  ),
  tidy: ticker.job({ description: "Deletes every headline kept, once a day.", everyMinutes: 1440 }, (ctx) => {
    ctx.write((db) => db.items.removeWhere({}));
  }),
});

type Ticker = typeof tickerServer;

/** A world whose database, time of day or clock this test gives, typed as an app's tests have it. */
const worldWith = (parts: TestWorldParts, options: TestAppOptions = {}) =>
  createTestApp(tickerServer, options, parts) as unknown as TestApp<Ticker>;

/** A moment on the morning these tests run on: 08:00 UTC and so many minutes. */
const at = (minutes: number) => new Date(Date.UTC(2026, 2, 1, 8, minutes));
const iso = (minutes: number) => at(minutes).toISOString();

/** A stand-in that answers the feed with these items, keeping each request it is asked in `seen`. */
function feed(items: string[], seen: StandInRequest[] = []): StandInFetch {
  return (request) => {
    seen.push(request);
    return { body: { items } };
  };
}

/** A stand-in that answers only once `open` is called: a run held up in the middle. */
function gated(items: string[]): { fetch: StandInFetch; asked: () => boolean; open: () => void } {
  let open = () => {};
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  let asked = false;
  return {
    fetch: async () => {
      asked = true;
      await gate;
      return { body: { items } };
    },
    asked: () => asked,
    open: () => open(),
  };
}

/** The job's row in app_jobs, as the runs left it. */
function jobRow(db: Db, job = "refresh") {
  return db
    .prepare(
      `SELECT next_run_at AS nextRunAt, requested_at AS requestedAt, run_id AS runId, last_started_at AS lastStartedAt,
              last_succeeded_at AS lastSucceededAt, last_failed_at AS lastFailedAt, failures
         FROM app_jobs WHERE app_id = 'ticker' AND job = ?`,
    )
    .get(job) as
    | {
        nextRunAt: string;
        requestedAt: string | null;
        runId: string | null;
        lastStartedAt: string | null;
        lastSucceededAt: string | null;
        lastFailedAt: string | null;
        failures: number;
      }
    | undefined;
}

/** Whatever a promise rejects with. */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("The promise was not rejected.");
}

describe("testApp's jobs", () => {
  beforeEach(() => {
    behaviour = keepFeed;
  });

  it("runs a job as the scheduler does: claimed, run with the space's settings behind the rules of ctx.fetch, and recorded", async () => {
    const db = openDatabase(":memory:");
    migrate(db);
    const world = worldWith({ db });
    const sam = world.as({ name: "Sam" });
    const lin = world.as({ name: "Lin", access: "view" });
    sam.saveSettings({ topic: "rust", compact: true });

    let seenCtx: unknown;
    behaviour = async (ctx) => {
      seenCtx = { space: ctx.space, settings: ctx.settings, now: ctx.now };
      await keepFeed(ctx);
    };
    const seen: StandInRequest[] = [];
    expect(await world.runJob("refresh", { fetch: feed(["One", "Two"], seen), now: at(0) })).toEqual({ ok: true, error: null });

    // The stand-in is asked what a host would be: the address, and the headers sent, User-Agent included.
    expect(seen).toEqual([{ url: `${FEED}?topic=rust`, headers: { "user-agent": "Hearth", accept: "application/json" } }]);
    // The job sees the space, the space's settings alone, nobody's own, and when it started.
    expect(seenCtx).toEqual({ space: { kind: "group", name: TEST_GROUP_NAME }, settings: { topic: "rust" }, now: at(0) });

    // Its rows are the app's in this space, written then, in the name of whoever added the app.
    const { createdBy: adder } = db.prepare("SELECT created_by AS createdBy FROM space_apps WHERE app_id = 'ticker'").get() as {
      createdBy: string;
    };
    expect([sam.user.id, lin.user.id]).not.toContain(adder);
    expect(lin.query("latest")).toMatchObject([
      { text: "One", createdBy: adder, createdAt: iso(0) },
      { text: "Two", createdBy: adder, createdAt: iso(0) },
    ]);

    // Recorded as the scheduler records a run: the next an hour to a tenth more after it started.
    const row = jobRow(db);
    expect(row).toMatchObject({ lastStartedAt: iso(0), lastSucceededAt: iso(0), lastFailedAt: null, failures: 0, runId: null });
    expect(Date.parse(row?.nextRunAt ?? "")).toBeGreaterThanOrEqual(at(60).getTime());
    expect(Date.parse(row?.nextRunAt ?? "")).toBeLessThanOrEqual(at(66).getTime());
    // And each person sees it as useJob shows it to them.
    expect(lin.job("refresh")).toEqual({ succeededAt: iso(0), failedAt: null, running: false, canRun: false });
    expect(sam.job("refresh")).toEqual({ succeededAt: iso(0), failedAt: null, running: false, canRun: true });

    // A run of a job that is not due runs all the same.
    expect(await world.runJob("refresh", { fetch: feed(["Three"]), now: at(1) })).toEqual({ ok: true, error: null });
    expect(lin.query("latest").map((item) => item.text)).toEqual(["Three"]);
    expect(lin.job("refresh")).toMatchObject({ succeededAt: iso(1) });
  });

  it("fails a run where the server would: a host the manifest does not list, a header a job may not send, a promise from work", async () => {
    const world = testApp(tickerServer);
    const lin = world.as({ name: "Lin", access: "view" });
    const seen: StandInRequest[] = [];
    expect(await world.runJob("refresh", { fetch: feed(["Kept"], seen), now: at(0) })).toEqual({ ok: true, error: null });

    behaviour = async (ctx) => {
      await ctx.fetch("https://other.example.com/feed.json");
    };
    expect(await world.runJob("refresh", { fetch: feed(["Never"], seen), now: at(10) })).toEqual({
      ok: false,
      error: "other.example.com is not a host this app's manifest lists in network (feeds.example.com): https://other.example.com/feed.json",
    });

    behaviour = async (ctx) => {
      await ctx.fetch(FEED, { headers: { authorization: "Bearer secret" } });
    };
    const header = await world.runJob("refresh", { fetch: feed(["Never"], seen), now: at(20) });
    expect(header).toMatchObject({ ok: false, error: expect.stringMatching(/^A job may not send the header authorization\./) });

    behaviour = (ctx) => {
      try {
        ctx.write((db) => {
          db.items.insert({ text: "Undone" });
          return Promise.resolve() as never;
        });
      } catch {
        // Caught, and the run fails all the same, as on a server.
      }
    };
    const promised = await world.runJob("refresh", { fetch: feed(["Never"], seen), now: at(30) });
    expect(promised).toMatchObject({
      ok: false,
      error: expect.stringContaining('App "ticker", job "refresh": the work given to ctx.write returned a promise.'),
    });

    // The rules kept the two requests from the stand-in, and nothing of the three runs was kept.
    expect(seen).toHaveLength(1);
    expect(lin.query("latest").map((item) => item.text)).toEqual(["Kept"]);
    expect(lin.job("refresh")).toEqual({ succeededAt: iso(0), failedAt: iso(30), running: false, canRun: false });
  });

  it("shows a viewer how the last run went, before the first, after one that went well and after one that did not", async () => {
    const world = testApp(tickerServer);
    const lin = world.as({ name: "Lin", access: "view" });
    expect(lin.job("refresh")).toEqual({ succeededAt: null, failedAt: null, running: false, canRun: false });

    expect(await world.runJob("refresh", { fetch: feed(["Sun"]), now: at(0) })).toEqual({ ok: true, error: null });
    expect(lin.job("refresh")).toEqual({ succeededAt: iso(0), failedAt: null, running: false, canRun: false });

    // An answer that is not 2xx is an answer; the job's own check fails the run.
    expect(await world.runJob("refresh", { fetch: () => ({ status: 503 }), now: at(60) })).toEqual({
      ok: false,
      error: "The feed answered 503.",
    });
    expect(lin.job("refresh")).toEqual({ succeededAt: iso(0), failedAt: iso(60), running: false, canRun: false });
    // The data stays as the last run that went well left it.
    expect(lin.query("latest").map((item) => item.text)).toEqual(["Sun"]);

    // A stand-in that throws fails the request as the network would; a FetchError says how.
    const reset = () => {
      throw new Error("Connection reset by a test");
    };
    expect(await world.runJob("refresh", { fetch: reset, now: at(65) })).toEqual({
      ok: false,
      error: "Could not reach feeds.example.com (Connection reset by a test).",
    });
    const slow = () => Promise.reject(new FetchError("timeout", "No whole answer in time (a test's)."));
    expect(await world.runJob("refresh", { fetch: slow, now: at(70) })).toEqual({
      ok: false,
      error: "No whole answer in time (a test's).",
    });
    expect(lin.job("refresh")).toEqual({ succeededAt: iso(0), failedAt: iso(70), running: false, canRun: false });

    expect(await world.runJob("refresh", { fetch: feed(["Rain"]), now: at(75) })).toEqual({ ok: true, error: null });
    expect(lin.job("refresh")).toEqual({ succeededAt: iso(75), failedAt: null, running: false, canRun: false });
    expect(lin.query("latest").map((item) => item.text)).toEqual(["Rain"]);
  });

  it("asks for a run as Refresh now does: forbidden with view, and with edit at most one every 5 minutes", async () => {
    const db = openDatabase(":memory:");
    let time = at(0).getTime();
    const world = worldWith({ db, now: () => new Date(time) });
    const sam = world.as({ name: "Sam" });
    const lin = world.as({ name: "Lin", access: "view" });

    const refused = (() => {
      try {
        lin.requestRun("refresh");
      } catch (error) {
        return error;
      }
      return null;
    })();
    expect(refused).toBeInstanceOf(AppCallError);
    expect(refused).toMatchObject({ status: 403, code: "forbidden" });
    expect(jobRow(db)).toBeUndefined();

    // A job that has not run is due at once when asked for.
    expect(sam.requestRun("refresh")).toEqual({ succeededAt: null, failedAt: null, running: true, canRun: true });
    expect(jobRow(db)).toMatchObject({ nextRunAt: iso(0), requestedAt: iso(0) });
    expect(await world.runJob("refresh", { fetch: feed(["One"]) })).toEqual({ ok: true, error: null });
    expect(sam.job("refresh")).toEqual({ succeededAt: iso(0), failedAt: null, running: false, canRun: true });

    // A minute after a run started, the next asked for waits for the 5 minutes, however often it is asked.
    time = at(1).getTime();
    expect(sam.requestRun("refresh")).toEqual({ succeededAt: iso(0), failedAt: null, running: true, canRun: true });
    expect(jobRow(db)).toMatchObject({ nextRunAt: iso(5), requestedAt: iso(1) });
    time = at(2).getTime();
    sam.requestRun("refresh");
    expect(jobRow(db)).toMatchObject({ nextRunAt: iso(5), requestedAt: iso(2) });
    // Lin sees it coming, and may not ask herself.
    expect(lin.job("refresh")).toEqual({ succeededAt: iso(0), failedAt: null, running: true, canRun: false });

    time = at(5).getTime();
    expect(await world.runJob("refresh", { fetch: feed(["Two"]) })).toEqual({ ok: true, error: null });
    expect(lin.job("refresh")).toEqual({ succeededAt: iso(5), failedAt: null, running: false, canRun: false });

    // Once the 5 minutes have passed, a run asked for is due at once.
    time = at(20).getTime();
    sam.requestRun("refresh");
    expect(jobRow(db)).toMatchObject({ nextRunAt: iso(20), requestedAt: iso(20) });
  });

  it("changes nothing when a run is asked for during one, and shows the run going on, even one given a time long past", async () => {
    const db = openDatabase(":memory:");
    const world = worldWith({ db });
    const sam = world.as({ name: "Sam" });
    const long = new Date(Date.UTC(2020, 0, 1));
    const held = gated(["Late"]);

    const first = world.runJob("refresh", { fetch: held.fetch, now: long });
    await settle();
    expect(held.asked()).toBe(true);
    expect(sam.job("refresh")).toEqual({ succeededAt: null, failedAt: null, running: true, canRun: true });
    expect(sam.requestRun("refresh")).toEqual({ succeededAt: null, failedAt: null, running: true, canRun: true });
    expect(jobRow(db)).toMatchObject({ requestedAt: null, nextRunAt: long.toISOString() });

    held.open();
    expect(await first).toEqual({ ok: true, error: null });
    expect(sam.job("refresh")).toEqual({ succeededAt: long.toISOString(), failedAt: null, running: false, canRun: true });
    expect(sam.query("latest").map((item) => item.text)).toEqual(["Late"]);
  });

  it("never runs a job beside itself, and runs another job meanwhile", async () => {
    const world = testApp(tickerServer);
    const sam = world.as();
    const held = gated(["Late"]);

    const first = world.runJob("refresh", { fetch: held.fetch });
    await settle();
    const second = await rejection(world.runJob("refresh", { fetch: feed(["Early"]) }));
    expect(second).toBeInstanceOf(Error);
    expect(String(second)).toContain('runJob("refresh") was called while a run of that job was going on');
    // Another job is another claim.
    expect(await world.runJob("tidy")).toEqual({ ok: true, error: null });

    held.open();
    expect(await first).toEqual({ ok: true, error: null });
    expect(sam.query("latest").map((item) => item.text)).toEqual(["Late"]);
    // And once it is over, the job runs again at once.
    expect(await world.runJob("refresh", { fetch: feed(["Again"]) })).toEqual({ ok: true, error: null });
  });

  it("keeps a run to its 5 minutes and an answer to its 20 seconds, and does not pace the requests", async () => {
    const fake = fakeClock();
    const world = worldWith({ clock: fake.clock });
    world.as();

    // Three requests to one host, which a server keeps 6.5 seconds apart: here the clock never moves.
    const seen: StandInRequest[] = [];
    behaviour = async (ctx) => {
      for (let count = 0; count < 3; count += 1) await ctx.fetch(FEED);
    };
    expect(await world.runJob("refresh", { fetch: feed([], seen) })).toEqual({ ok: true, error: null });
    expect(seen).toHaveLength(3);

    behaviour = () => new Promise<void>(() => {});
    const endless = world.runJob("refresh", { fetch: feed([]) });
    await fake.advance(RUN_TIME_LIMIT_MS - 1);
    await fake.advance(1);
    expect(await endless).toEqual({ ok: false, error: "The run took longer than 5 minutes, so it was stopped." });

    behaviour = keepFeed;
    const unanswered = world.runJob("refresh", { fetch: () => new Promise(() => {}) });
    await fake.advance(ANSWER_TIME_LIMIT_MS);
    expect(await unanswered).toEqual({ ok: false, error: "No whole answer within 20 seconds: https://feeds.example.com/headlines.json" });
  });

  it("runs a job in a personal space, writing as its one person", async () => {
    const world = testApp(tickerServer, { space: "personal" });
    const kim = world.as({ name: "Kim" });
    let space: unknown;
    behaviour = async (ctx) => {
      space = ctx.space;
      await keepFeed(ctx);
    };
    expect(await world.runJob("refresh", { fetch: feed(["Mine"]), now: at(0) })).toEqual({ ok: true, error: null });
    expect(space).toEqual({ kind: "personal", name: "" });
    expect(kim.query("latest")).toMatchObject([{ text: "Mine", createdBy: kim.user.id }]);
    expect(kim.job("refresh")).toEqual({ succeededAt: iso(0), failedAt: null, running: false, canRun: true });
  });

  it("turns down what a test gets wrong, and says what", async () => {
    const world = testApp(tickerServer);
    const untyped = world as unknown as TestAppHandle;
    const sam = world.as();
    const caller = sam as unknown as TestCallerHandle;

    const message = async (promise: Promise<unknown>) => String(await rejection(promise));
    expect(await message(untyped.runJob("latest"))).toContain(
      'runJob takes the name of one of the app\'s jobs (refresh, tidy), not "latest".',
    );
    expect(await message(untyped.runJob("refresh", { fetch: "feed" } as never))).toContain("runJob's fetch is a function");
    expect(await message(untyped.runJob("refresh", { now: "2026-03-01" } as never))).toContain("runJob's now is a Date");
    expect(await message(untyped.runJob("refresh", { now: new Date("not a date") }))).toContain("runJob's now is a Date");
    expect(await message(untyped.runJob("refresh", { fetsh: feed([]) } as never))).toContain('runJob takes { fetch, now }, not "fetsh".');
    expect(await message((testApp(server) as unknown as TestAppHandle).runJob("whoami"))).toContain('"notes" has no job to run.');
    expect(await message(testApp(tickerServer, { space: "personal" }).runJob("refresh"))).toContain(
      "came before anyone was in the personal space",
    );

    // An answer HTTP could not carry fails the test, not the job.
    const address = `${FEED}?topic=news`;
    const answers: [unknown, string][] = [
      [{ status: 700 }, "status: Too big"],
      [{ status: 204, body: "Nothing" }, "body: An answer with status 204 has no body."],
      [{ headers: { "a header": "x" } }, "headers: Holds a name or a value that HTTP does not allow."],
      [{ headers: { accept: 1 } }, "headers.accept: "],
      [{ body: 10n }, "body: Is neither text nor a value JSON can hold."],
      [{ json: { items: [] } }, 'An answer has status, headers and body alone, not "json".'],
      [undefined, "An answer is an object of status, headers and body, not a value of type undefined."],
      [new Response("Hello"), "An answer is an object of status, headers and body, not a value of type object."],
    ];
    for (const [answer, problem] of answers) {
      const mistake = await rejection(world.runJob("refresh", { fetch: () => answer as never }));
      expect(mistake).toBeInstanceOf(TypeError);
      expect(String(mistake)).toContain(`testApp: the stand-in's answer to ${address} cannot be an HTTP answer. ${problem}`);
    }

    // Without a stand-in, the network is not there.
    expect(await world.runJob("refresh")).toEqual({
      ok: false,
      error: `No stand-in answers ${address}: runJob was given no fetch.`,
    });

    // A status and a run are there for jobs alone, as the routes have them.
    for (const call of [() => caller.job("latest"), () => caller.requestRun("latest"), () => caller.job("nope")]) {
      expect(call).toThrow(AppCallError);
      expect(call).toThrow("not_found");
    }
  });
});
