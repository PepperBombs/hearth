/**
 * Running a job (docs/mini-app-contract.md, section C, "Running a job"):
 * claiming a run, the run with its ctx and time limit, recording how it
 * went, asking for a run and reading a job's status. Time is a clock that
 * moves only when told, and ctx.fetch answers from a transport written
 * here: nothing waits and nothing reaches a network.
 */
import { defineApp } from "@hearth/sdk";
import { AppError, defineServer, FetchError, z, type JobCtx } from "@hearth/sdk/server";
import { beforeEach, describe, expect, it } from "vitest";
import { Refusal } from "../http/errors";
import type { TransportRequest } from "./fetch";
import { addApp, deleteAppData, moveApp, removeApp } from "./installs";
import {
  CLAIM_GRACE_MS,
  claimRun,
  jobStatus,
  keptError,
  MAX_ERROR_LENGTH,
  recordRun,
  REQUEST_GAP_MS,
  requestRun,
  RUN_OVER,
  RUN_TIME_LIMIT_MS,
  runClaimed,
  runOnce,
  RunRefusedError,
  type Claim,
  type JobStatus,
  type RunOutcome,
  type RunWorld,
} from "./jobs";
import { createRegistry, type BundledApp, type Registry } from "./registry";
import { changeAppSettings } from "./settings";
import { StoreUsageError } from "./store";
import { fakeClock, settle } from "./test-clock";
import { APPS, family, grant, install } from "./test-world";

/* -------------------------------------------------------------------------
 * A sample app with jobs that do whatever the test at hand asks of them
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

const collections = { items: z.object({ text: z.string().max(200) }) };
const ticker = defineServer(tickerManifest, collections);
type Ctx = JobCtx<typeof tickerManifest, typeof collections>;

/** What the jobs do in the test at hand. */
let behaviour: (ctx: Ctx) => Promise<void> | void = () => {};

const tickerServer = ticker.routes({
  latest: ticker.query({ description: "Lists the headlines kept, oldest first." }, (ctx) => ctx.db.items.list()),
  refresh: ticker.job(
    { description: "Does what the test at hand asks of it, every hour.", everyMinutes: 60 },
    (ctx) => behaviour(ctx),
  ),
  tidy: ticker.job(
    { description: "Does what the test at hand asks of it, every quarter of an hour.", everyMinutes: 15 },
    (ctx) => behaviour(ctx),
  ),
});

const TICKER: BundledApp = { id: "ticker", manifest: tickerManifest, hasPage: false, server: tickerServer };

/** ctx as JavaScript that ignores the SDK's types sees it. */
type LooseCtx = {
  read(work: unknown): unknown;
  write(work: unknown): unknown;
  fetch(url: unknown, init?: unknown): Promise<unknown>;
};
const loose = (ctx: Ctx) => ctx as unknown as LooseCtx;

/* -------------------------------------------------------------------------
 * The world: a family, the ticker in it, time and the way out
 * ---------------------------------------------------------------------- */

const FEED = "https://feeds.example.com/headlines.json";
const MINUTE = 60_000;
/** The moment the fake clock's 0 stands for. */
const START = Date.parse("2026-03-01T08:00:00.000Z");
const at = (ms: number) => new Date(START + ms);
const iso = (ms: number) => at(ms).toISOString();

let place: ReturnType<typeof family>;
let registry: Registry;
let fake: ReturnType<typeof fakeClock>;
/** The time of day, as the fake clock has it. */
const now = () => at(fake.clock.now());
/** What reached the transport. */
let requests: TransportRequest[];
/** How the transport answers; "never" is an answer that never comes. */
let answer: (request: TransportRequest) => Response | "never";

beforeEach(() => {
  place = family();
  registry = createRegistry([...APPS, TICKER]);
  fake = fakeClock();
  requests = [];
  answer = () => Response.json({ items: [] });
  behaviour = () => {};
  // Kim, a member who may add apps, added the ticker to the family; members may view it.
  install(place.db, place.family, "ticker", place.kim.id, { memberAccess: "view" });
  install(place.db, place.family, "checklist", place.sam.id);
  install(place.db, place.linsSpace, "ticker", place.lin.id);
  install(place.db, place.samsSpace, "checklist", place.sam.id);
});

function world(overrides: Partial<RunWorld> = {}): RunWorld {
  return {
    outbound: {
      transport: (request) => {
        requests.push(request);
        const given = answer(request);
        return given === "never" ? new Promise<Response>(() => {}) : Promise.resolve(given);
      },
      pace: null,
      clock: fake.clock,
    },
    clock: fake.clock,
    now,
    random: () => 0,
    ...overrides,
  };
}

const key = (spaceId: string, job = "refresh") => ({ spaceId, appId: "ticker", job });

/** A claim that must be taken. */
function claim(spaceId: string, ms: number, options: { force?: boolean; job?: string } = {}): Claim {
  const result = claimRun(place.db, registry, key(spaceId, options.job), { now: at(ms), force: options.force });
  if (typeof result === "string") throw new Error(`No claim was taken: ${result}.`);
  return result;
}

const run = (spaceId: string, overrides: Partial<RunWorld> = {}, job = "refresh") =>
  runOnce(place.db, registry, key(spaceId, job), world(overrides));

type JobRow = {
  space_id: string;
  app_id: string;
  job: string;
  next_run_at: string;
  requested_at: string | null;
  run_id: string | null;
  run_until: string | null;
  last_started_at: string | null;
  last_succeeded_at: string | null;
  last_failed_at: string | null;
  last_error: string | null;
  failures: number;
};

const jobRows = () => place.db.prepare("SELECT * FROM app_jobs ORDER BY space_id, app_id, job").all() as JobRow[];
const jobRow = (spaceId: string, job = "refresh") =>
  place.db.prepare("SELECT * FROM app_jobs WHERE space_id = ? AND app_id = 'ticker' AND job = ?").get(spaceId, job) as
    | JobRow
    | undefined;

/** A row put straight into the database, as a person's mutation would have stored it. */
function put(spaceId: string, appId: string, data: object, by: string): string {
  const id = `row-${Math.random().toString(36).slice(2)}`;
  place.db
    .prepare(
      `INSERT INTO app_rows (id, space_id, app_id, collection, data, created_by, updated_by, created_at, updated_at)
       VALUES (?, ?, ?, 'items', ?, ?, ?, ?, ?)`,
    )
    .run(id, spaceId, appId, JSON.stringify(data), by, by, iso(-MINUTE), iso(-MINUTE));
  return id;
}

/** The ticker's rows in a space, as stored. */
const kept = (spaceId: string) =>
  place.db
    .prepare(
      `SELECT json_extract(data, '$.text') AS text, created_by AS createdBy, updated_by AS updatedBy, created_at AS createdAt
         FROM app_rows WHERE space_id = ? AND app_id = 'ticker' ORDER BY created_at, rowid`,
    )
    .all(spaceId);

/** A point a job waits at until the test lets it go on. */
function gate() {
  let arrive = () => {};
  let open = () => {};
  const arrived = new Promise<void>((resolve) => (arrive = resolve));
  const opened = new Promise<void>((resolve) => (open = resolve));
  return {
    /** Resolves once the job is waiting. */
    arrived,
    open: () => open(),
    async pass(): Promise<void> {
      arrive();
      await opened;
    },
  };
}

/** A promise, and whether it has settled yet. */
function watch<T>(promise: Promise<T>) {
  const watched = { promise, settled: false };
  promise.then(
    () => (watched.settled = true),
    () => (watched.settled = true),
  );
  return watched;
}

/** What a call throws, so that more than its message can be looked at. */
function thrownBy(work: () => unknown): unknown {
  try {
    work();
  } catch (error) {
    return error;
  }
  throw new Error("Nothing was thrown.");
}

const statusFor = (userId: string, spaceId = place.family, job = "refresh", when = now()) =>
  jobStatus(place.db, registry, { userId, spaceId, appId: "ticker", job }, when);
const ask = (userId: string, spaceId = place.family, job = "refresh", when = now()) =>
  requestRun(place.db, registry, { userId, spaceId, appId: "ticker", job }, when);

function refusal(work: () => unknown): { status: number; code: string } {
  const error = thrownBy(work);
  expect(error).toBeInstanceOf(Refusal);
  const { status, code } = error as Refusal;
  return { status, code };
}

/* -------------------------------------------------------------------------
 * Claiming a run
 * ---------------------------------------------------------------------- */

describe("claimRun", () => {
  it("claims a job that has never run in an install at once, and makes its row then", () => {
    expect(jobRows()).toEqual([]);
    const taken = claim(place.family, 0);
    expect(taken).toEqual({
      spaceId: place.family,
      appId: "ticker",
      job: "refresh",
      runId: expect.stringMatching(/^[0-9a-z]{24}$/),
      startedAt: at(0),
      everyMinutes: 60,
      space: { kind: "group", name: "Family" },
      settings: { topic: "news" },
    });
    expect(Object.isFrozen(taken)).toBe(true);
    expect(jobRows()).toEqual([
      {
        space_id: place.family,
        app_id: "ticker",
        job: "refresh",
        next_run_at: iso(0),
        requested_at: null,
        run_id: taken.runId,
        run_until: iso(RUN_TIME_LIMIT_MS + CLAIM_GRACE_MS),
        last_started_at: iso(0),
        last_succeeded_at: null,
        last_failed_at: null,
        last_error: null,
        failures: 0,
      },
    ]);
    expect(RUN_TIME_LIMIT_MS + CLAIM_GRACE_MS).toBe(6 * MINUTE);
  });

  it("holds one claim at a time, forced or not, and takes over a claim whose time has run out", () => {
    const first = claim(place.family, 0);
    const lastMoment = RUN_TIME_LIMIT_MS + CLAIM_GRACE_MS - 1;
    for (const force of [false, true]) {
      expect(claimRun(place.db, registry, key(place.family), { now: at(MINUTE), force })).toBe("running");
      expect(claimRun(place.db, registry, key(place.family), { now: at(lastMoment), force })).toBe("running");
    }
    // Another job of the same app, and the same job elsewhere, are claims of their own.
    expect(claim(place.family, MINUTE, { job: "tidy" }).runId).not.toBe(first.runId);
    expect(claim(place.linsSpace, MINUTE).runId).not.toBe(first.runId);

    // The server that held it is taken for dead, and its run counts for nothing.
    const second = claim(place.family, lastMoment + 1);
    expect(second.runId).not.toBe(first.runId);
    expect(jobRow(place.family)).toMatchObject({
      run_id: second.runId,
      run_until: iso(lastMoment + 1 + RUN_TIME_LIMIT_MS + CLAIM_GRACE_MS),
      last_started_at: iso(lastMoment + 1),
      last_succeeded_at: null,
      last_failed_at: null,
      failures: 0,
    });
  });

  it("claims a job only when it is due, unless forced", () => {
    recordRun(place.db, claim(place.family, 0), { kind: "succeeded" }, { now: at(MINUTE), random: () => 0 });
    expect(jobRow(place.family)?.next_run_at).toBe(iso(60 * MINUTE));
    expect(claimRun(place.db, registry, key(place.family), { now: at(60 * MINUTE - 1) })).toBe("not_due");
    expect(claim(place.family, 2 * MINUTE, { force: true }).startedAt).toEqual(at(2 * MINUTE));
    expect(jobRow(place.family)?.next_run_at).toBe(iso(60 * MINUTE));
  });

  it("claims a job that is due, and one that was asked for", () => {
    recordRun(place.db, claim(place.family, 0), { kind: "succeeded" }, { now: at(MINUTE), random: () => 0 });
    expect(claim(place.family, 60 * MINUTE).startedAt).toEqual(at(60 * MINUTE));

    recordRun(place.db, claim(place.linsSpace, 0), { kind: "succeeded" }, { now: at(MINUTE), random: () => 0 });
    expect(ask(place.lin.id, place.linsSpace, "refresh", at(10 * MINUTE))).toMatchObject({ state: "requested" });
    expect(claim(place.linsSpace, 10 * MINUTE)).toBeTruthy();
    // The claim clears the request.
    expect(jobRow(place.linsSpace)).toMatchObject({ requested_at: null, last_started_at: iso(10 * MINUTE) });
  });

  it("finds nothing to claim where the install or its code is not there", () => {
    const absent = (spaceId: string, job = "refresh", on = registry) =>
      claimRun(place.db, on, { spaceId, appId: "ticker", job }, { now: at(0), force: true });
    // Not in the space, removed, and an app this build does not hold.
    expect(absent(place.samsSpace)).toBe("absent");
    expect(absent("nowhere")).toBe("absent");
    removeApp(place.db, registry, { userId: place.lin.id, spaceId: place.linsSpace, appId: "ticker" });
    expect(absent(place.linsSpace)).toBe("absent");
    expect(absent(place.family, "refresh", createRegistry(APPS))).toBe("absent");
    // A name that is no job of the app's: a query's, and none at all.
    expect(absent(place.family, "latest")).toBe("absent");
    expect(absent(place.family, "nothing")).toBe("absent");
    expect(absent(place.family, "toString")).toBe("absent");
    // An app without a server file, and one with a server file but no job, both in the family.
    install(place.db, place.family, "feed", place.sam.id);
    for (const [appId, job] of [
      ["feed", "refresh"],
      ["checklist", "add"],
    ] as const) {
      expect(claimRun(place.db, registry, { spaceId: place.family, appId, job }, { now: at(0), force: true })).toBe("absent");
    }
    expect(jobRows()).toEqual([]);
  });

  it("reads the space's settings, and nobody's own, as they are when the run is claimed", () => {
    changeAppSettings(place.db, registry, {
      userId: place.sam.id,
      spaceId: place.family,
      appId: "ticker",
      patch: { space: { topic: "rust" }, user: { compact: true } },
    });
    expect(claim(place.family, 0).settings).toEqual({ topic: "rust" });
    expect(claim(place.linsSpace, 0)).toMatchObject({ space: { kind: "personal", name: "" }, settings: { topic: "news" } });
  });
});

/* -------------------------------------------------------------------------
 * The run
 * ---------------------------------------------------------------------- */

describe("a run's reach: its own app in its own space, and nothing else (A6, for a job)", () => {
  it("reads, changes and stores only the rows of its install, in the name of whoever added the app", async () => {
    put(place.family, "ticker", { text: "The family's own" }, place.sam.id);
    const strangers = [
      put(place.linsSpace, "ticker", { text: "Lin's own" }, place.lin.id),
      // Another app in the same space, with a collection of the same name.
      put(place.family, "checklist", { name: "Milk" }, place.sam.id),
      put(place.samsSpace, "checklist", { name: "Eggs" }, place.sam.id),
    ];
    const elsewhere = () =>
      place.db
        .prepare("SELECT * FROM app_rows WHERE NOT (space_id = ? AND app_id = 'ticker') ORDER BY id")
        .all(place.family);
    const before = elsewhere();
    expect(before).toHaveLength(3);

    const seen: { read?: unknown; updates: unknown[]; removed?: number } = { updates: [] };
    behaviour = (ctx) => {
      seen.read = ctx.read((db) => ({
        texts: db.items.list().map((row) => row.text),
        count: db.items.count(),
        found: strangers.map((id) => db.items.get(id)),
        matched: db.items.list({ where: { text: "Lin's own" } }),
      }));
      ctx.write((db) => {
        for (const id of strangers) {
          const error = thrownBy(() => db.items.update(id, { text: "Taken" }));
          seen.updates.push(error instanceof AppError ? error.code : error);
          db.items.remove(id);
        }
        seen.removed = db.items.removeWhere({});
        db.items.insert({ text: "Fresh" });
      });
    };
    expect(await run(place.family)).toEqual({ kind: "succeeded" });

    expect(seen).toEqual({
      read: { texts: ["The family's own"], count: 1, found: [null, null, null], matched: [] },
      updates: ["not_found", "not_found", "not_found"],
      removed: 1,
    });
    expect(elsewhere()).toEqual(before);
    // Kim added the app to the family, so what the job stores carries Kim.
    expect(kept(place.family)).toEqual([
      { text: "Fresh", createdBy: place.kim.id, updatedBy: place.kim.id, createdAt: iso(0) },
    ]);
  });

  it("stores with the time of the write, not of the start, and refuses list({ mine: true })", async () => {
    const pause = gate();
    let mine: unknown;
    let startedAt: Date | undefined;
    behaviour = async (ctx) => {
      startedAt = ctx.now;
      await pause.pass();
      ctx.write((db) => {
        db.items.insert({ text: "Later" });
        mine = thrownBy(() => db.items.list({ mine: true }));
      });
    };
    const running = run(place.family);
    await pause.arrived;
    await fake.advance(90_000);
    pause.open();
    expect(await running).toEqual({ kind: "succeeded" });
    expect(startedAt).toEqual(at(0));
    expect(kept(place.family)).toEqual([
      { text: "Later", createdBy: place.kim.id, updatedBy: place.kim.id, createdAt: iso(90_000) },
    ]);
    expect(mine).toBeInstanceOf(StoreUsageError);
    expect((mine as Error).message).toContain('the job "refresh" runs for no one in the space');
  });
});

describe("a run's ctx", () => {
  it("holds the space's kind and name, the space's settings, the start and the three ways to work, and nothing of a person", async () => {
    changeAppSettings(place.db, registry, {
      userId: place.sam.id,
      spaceId: place.family,
      appId: "ticker",
      patch: { space: { topic: "rust" }, user: { compact: true } },
    });
    const seen: unknown[] = [];
    behaviour = (ctx) => {
      seen.push({
        keys: Object.keys(ctx).sort(),
        frozen: Object.isFrozen(ctx) && Object.isFrozen(ctx.space),
        space: ctx.space,
        settings: ctx.settings,
        now: ctx.now,
        inTransaction: place.db.inTransaction,
      });
    };
    await fake.advance(MINUTE);
    expect(await run(place.family)).toEqual({ kind: "succeeded" });
    expect(await run(place.linsSpace)).toEqual({ kind: "succeeded" });
    expect(seen).toEqual([
      {
        keys: ["fetch", "now", "read", "settings", "space", "write"],
        frozen: true,
        space: { kind: "group", name: "Family" },
        settings: { topic: "rust" },
        now: at(MINUTE),
        inTransaction: false,
      },
      {
        keys: ["fetch", "now", "read", "settings", "space", "write"],
        frozen: true,
        space: { kind: "personal", name: "" },
        settings: { topic: "news" },
        now: at(MINUTE),
        inTransaction: false,
      },
    ]);
  });

  it("keeps the settings the run started with; a change during it counts from the next run", async () => {
    const pause = gate();
    const topics: string[] = [];
    behaviour = async (ctx) => {
      topics.push(ctx.settings.topic);
      await pause.pass();
      topics.push(ctx.settings.topic);
    };
    const running = run(place.family);
    await pause.arrived;
    changeAppSettings(place.db, registry, {
      userId: place.sam.id,
      spaceId: place.family,
      appId: "ticker",
      patch: { space: { topic: "rust" } },
    });
    pause.open();
    await running;
    behaviour = (ctx) => {
      topics.push(ctx.settings.topic);
    };
    await runOnce(place.db, registry, key(place.family), world(), { force: true });
    expect(topics).toEqual(["news", "news", "rust"]);
  });

  it("reads in a transaction whose db cannot write, and writes all of it or none", async () => {
    put(place.family, "ticker", { text: "Kept" }, place.sam.id);
    const seen: unknown[] = [];
    behaviour = (ctx) => {
      seen.push(
        ctx.read((db) => ({
          methods: Object.keys(db.items).sort(),
          inTransaction: place.db.inTransaction,
          count: db.items.count(),
        })),
      );
      const failed = thrownBy(() =>
        ctx.write((db) => {
          db.items.insert({ text: "Half" });
          db.items.removeWhere({});
          throw new Error("Changed my mind.");
        }),
      );
      seen.push((failed as Error).message);
      seen.push(ctx.write((db) => db.items.count()));
    };
    expect(await run(place.family)).toEqual({ kind: "succeeded" });
    expect(seen).toEqual([{ methods: ["count", "get", "list"], inTransaction: true, count: 1 }, "Changed my mind.", 1]);
    expect(kept(place.family)).toMatchObject([{ text: "Kept" }]);
  });

  it("refuses work that is not a function, and work inside work, without ending the run", async () => {
    const seen: unknown[] = [];
    behaviour = (ctx) => {
      seen.push(thrownBy(() => loose(ctx).write("insert everything")));
      seen.push(
        thrownBy(() =>
          ctx.read(() => {
            ctx.write((db) => db.items.insert({ text: "Nested" }));
          }),
        ),
      );
      ctx.write((db) => db.items.insert({ text: "After" }));
    };
    expect(await run(place.family)).toEqual({ kind: "succeeded" });
    expect(seen.map((error) => (error instanceof StoreUsageError ? error.message : error))).toEqual([
      'App "ticker", job "refresh": ctx.write takes the work to do, a function: ctx.write((db) => ...).',
      'App "ticker", job "refresh": ctx.write was called inside the work of ctx.read or ctx.write. Do all of it in one: work runs in one transaction.',
    ]);
    expect(kept(place.family)).toMatchObject([{ text: "After" }]);
  });

  it("fetches from the hosts the manifest lists, as Hearth, through the run's way out", async () => {
    answer = (request) =>
      request.url === FEED ? Response.json({ items: [{ title: "Rain" }] }) : new Response("no", { status: 500 });
    const seen: unknown[] = [];
    behaviour = async (ctx) => {
      const got = await ctx.fetch(FEED, { headers: { accept: "application/json" } });
      seen.push(got.status, got.json());
      seen.push(await ctx.fetch("https://api.github.com/search/repositories").catch((error: unknown) => error));
    };
    expect(await run(place.family)).toEqual({ kind: "succeeded" });
    expect(seen.slice(0, 2)).toEqual([200, { items: [{ title: "Rain" }] }]);
    expect(seen[2]).toBeInstanceOf(FetchError);
    expect((seen[2] as FetchError).code).toBe("refused");
    expect(requests.map(({ url, headers }) => ({ url, headers }))).toEqual([
      { url: FEED, headers: { "user-agent": "Hearth", accept: "application/json" } },
    ]);
  });

  it("stops working once the run is over: read and write throw, fetch rejects, a kept db is closed", async () => {
    let keptCtx: Ctx | undefined;
    let keptDb: { items: { count(): number } } | undefined;
    behaviour = (ctx) => {
      keptCtx = ctx;
      ctx.read((db) => {
        keptDb = db;
      });
    };
    expect(await run(place.family)).toEqual({ kind: "succeeded" });
    const ctx = keptCtx as Ctx;
    for (const work of [() => ctx.read((db) => db.items.count()), () => ctx.write((db) => db.items.insert({ text: "Late" }))]) {
      const error = thrownBy(work);
      expect(error).toBeInstanceOf(RunRefusedError);
      expect((error as Error).message).toBe(RUN_OVER);
    }
    const fetched = await ctx.fetch(FEED).catch((error: unknown) => error);
    expect(fetched).toBeInstanceOf(FetchError);
    expect((fetched as FetchError).code).toBe("stopped");
    const closed = thrownBy(() => keptDb?.items.count());
    expect(closed).toBeInstanceOf(StoreUsageError);
    expect((closed as Error).message).toContain("was used after its work returned");
    expect(requests).toEqual([]);
    expect(kept(place.family)).toEqual([]);
  });
});

describe("how a run ends", () => {
  it("goes well when the function returns, or its promise resolves", async () => {
    behaviour = () => {};
    expect(await run(place.family)).toEqual({ kind: "succeeded" });
    behaviour = async () => {
      await settle();
    };
    expect(await run(place.linsSpace)).toEqual({ kind: "succeeded" });
  });

  it.each([
    ["an error, thrown at once", () => {
      throw new Error("The feed is down.");
    }, "The feed is down."],
    ["a rejection", async () => {
      await settle();
      throw new Error("The feed answered 500.");
    }, "The feed answered 500."],
    ["a message over several lines", () => {
      throw new Error("First line.\n  Second line.\n");
    }, "First line. Second line."],
    ["an error without a message", () => {
      throw new TypeError("");
    }, "TypeError, with no message."],
    ["plain text", () => {
      throw "Something broke.";
    }, "Something broke."],
    ["something that is not an error", () => {
      throw 42;
    }, "The job threw a value of type number instead of an Error."],
  ])("fails with %s, said on one line", async (_, fails, message) => {
    behaviour = fails;
    expect(await run(place.family)).toMatchObject({ kind: "failed", error: message });
    expect(jobRow(place.family)).toMatchObject({ last_error: message, failures: 1 });
  });

  it("undoes work that returns a promise and fails the run, even when the job carries on", async () => {
    put(place.family, "ticker", { text: "Kept" }, place.sam.id);
    let caught: unknown;
    let after: unknown;
    behaviour = async (ctx) => {
      try {
        loose(ctx).write(async (db: { items: { insert(value: object): unknown; removeWhere(where: object): number } }) => {
          db.items.removeWhere({});
          db.items.insert({ text: "Half" });
        });
      } catch (error) {
        caught = error;
      }
      // The run is over: what the job tries next is refused, and its own end changes nothing.
      after = thrownBy(() => ctx.read((db) => db.items.count()));
    };
    const outcome = await run(place.family);
    const message =
      'App "ticker", job "refresh": the work given to ctx.write returned a promise. It must not be async: it runs inside one database transaction, which cannot wait for anything. What it did was undone.';
    expect(outcome).toEqual({ kind: "failed", error: message, cause: caught });
    expect(caught).toBeInstanceOf(StoreUsageError);
    expect((after as Error).message).toBe(RUN_OVER);
    expect(kept(place.family)).toMatchObject([{ text: "Kept" }]);
    expect(jobRow(place.family)).toMatchObject({ last_failed_at: iso(0), last_error: keptError(message), failures: 1 });
  });

  it("stops a run that never ends at 5 minutes, as a failure, and its ctx with it", async () => {
    let keptCtx: Ctx | undefined;
    behaviour = (ctx) => {
      keptCtx = ctx;
      return new Promise<void>(() => {});
    };
    const running = watch(run(place.family));
    await fake.advance(RUN_TIME_LIMIT_MS - 1);
    expect(running.settled).toBe(false);
    expect(statusFor(place.sam.id).state).toBe("running");

    await fake.advance(1);
    expect(running.settled).toBe(true);
    expect(await running.promise).toEqual({
      kind: "failed",
      error: "The run took longer than 5 minutes, so it was stopped.",
      cause: expect.any(Error),
    });
    expect((thrownBy(() => keptCtx?.write((db) => db.items.insert({ text: "Late" }))) as Error).message).toBe(RUN_OVER);
    expect(jobRow(place.family)).toMatchObject({
      run_id: null,
      run_until: null,
      last_started_at: iso(0),
      last_failed_at: iso(RUN_TIME_LIMIT_MS),
      last_error: "The run took longer than 5 minutes, so it was stopped.",
      failures: 1,
      next_run_at: iso(RUN_TIME_LIMIT_MS + 5 * MINUTE),
    });
    expect(fake.pending()).toBe(0);
  });

  it("refuses read and write once the time is up by the clock, however late the timer is", async () => {
    // The process was busy: its timer has not fired, but 5 minutes have passed by the clock of the day.
    let late = 0;
    const seen: unknown[] = [];
    behaviour = (ctx) => {
      late = RUN_TIME_LIMIT_MS;
      seen.push(thrownBy(() => ctx.write((db) => db.items.insert({ text: "Late" }))));
      seen.push(thrownBy(() => ctx.read((db) => db.items.count())));
    };
    const outcome = await run(place.family, { now: () => at(fake.clock.now() + late) });
    expect(outcome).toMatchObject({ kind: "failed", error: "The run took longer than 5 minutes, so it was stopped." });
    expect(seen.map((error) => (error as Error).message)).toEqual([RUN_OVER, RUN_OVER]);
    expect(kept(place.family)).toEqual([]);
    expect(jobRow(place.family)).toMatchObject({ failures: 1, last_failed_at: iso(RUN_TIME_LIMIT_MS) });

    // A moment before the limit, the same write goes through.
    late = 0;
    behaviour = (ctx) => {
      late = RUN_TIME_LIMIT_MS - 1;
      ctx.write((db) => db.items.insert({ text: "Just in time" }));
    };
    expect(await runOnce(place.db, registry, key(place.family), world({ now: () => at(fake.clock.now() + late) }), { force: true })).toEqual({
      kind: "succeeded",
    });
    expect(kept(place.family)).toMatchObject([{ text: "Just in time" }]);
  });

  it("stops a request on its way when the run's time is up", async () => {
    answer = () => "never";
    let fetched: unknown;
    behaviour = async (ctx) => {
      fetched = await ctx.fetch(FEED).catch((error: unknown) => error);
      await new Promise<void>(() => {});
    };
    const running = run(place.family);
    // ctx.fetch gives up on an answer after 20 seconds; this one waits on purpose for longer.
    await fake.advance(19_000);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.signal.aborted).toBe(false);
    await fake.advance(RUN_TIME_LIMIT_MS);
    expect(await running).toMatchObject({ kind: "failed" });
    expect(fetched).toBeInstanceOf(FetchError);
  });

  it("ends a run the server stops at once, records nothing and leaves the job due at once", async () => {
    behaviour = () => {
      throw new Error("The feed is down.");
    };
    await run(place.family);
    const failed = jobRow(place.family);
    expect(failed).toMatchObject({ failures: 1, last_error: "The feed is down." });

    await fake.advance(10 * MINUTE);
    const pause = gate();
    let fetched: unknown;
    answer = () => "never";
    behaviour = async (ctx) => {
      await pause.pass();
      fetched = await ctx.fetch(FEED).catch((error: unknown) => error);
      // A job that does not listen is not waited for.
      await new Promise<void>(() => {});
    };
    const stop = new AbortController();
    const running = run(place.family, { stop: stop.signal });
    await pause.arrived;
    pause.open();
    await fake.advance(2_000);
    expect(requests).toHaveLength(1);
    stop.abort();
    expect(await running).toEqual({ kind: "stopped" });
    expect(requests[0]?.signal.aborted).toBe(true);
    await settle();
    expect((fetched as FetchError).code).toBe("stopped");
    expect(jobRow(place.family)).toEqual({
      ...failed,
      last_started_at: iso(10 * MINUTE),
      next_run_at: iso(10 * MINUTE + 2_000),
      run_id: null,
      run_until: null,
    });
  });

  it("does not start the job at all when the server is already stopping", async () => {
    let ran = false;
    behaviour = () => {
      ran = true;
    };
    const stop = new AbortController();
    stop.abort();
    expect(await run(place.family, { stop: stop.signal })).toEqual({ kind: "stopped" });
    expect(ran).toBe(false);
    expect(jobRow(place.family)).toMatchObject({ run_id: null, next_run_at: iso(0), last_succeeded_at: null });
  });
});

describe("a run whose install changes under it", () => {
  /**
   * Starts a run in the family that waits at a gate, then tries to write and
   * to read; `change` happens while it waits.
   */
  async function writeAfter(change: () => void) {
    put(place.family, "ticker", { text: "Old" }, place.sam.id);
    const everything = () => place.db.prepare("SELECT * FROM app_rows ORDER BY id").all();
    const pause = gate();
    const seen: { write?: unknown; read?: unknown; fetch?: unknown } = {};
    behaviour = async (ctx) => {
      await pause.pass();
      seen.write = thrownBy(() =>
        ctx.write((db) => {
          db.items.removeWhere({});
          db.items.insert({ text: "New" });
        }),
      );
      seen.read = thrownBy(() => ctx.read((db) => db.items.count()));
      seen.fetch = await ctx.fetch(FEED).catch((error: unknown) => error);
    };
    const running = run(place.family);
    await pause.arrived;
    await fake.advance(MINUTE);
    change();
    // What the change left, which the run's write must not touch.
    const before = everything();
    pause.open();
    const outcome = await running;
    expect(everything()).toEqual(before);
    expect(seen.write).toBeInstanceOf(RunRefusedError);
    // The refusal ended the run.
    expect((seen.read as Error).message).toBe(RUN_OVER);
    expect((seen.fetch as FetchError).code).toBe("stopped");
    expect(requests).toEqual([]);
    return { outcome, refused: (seen.write as Error).message };
  }

  it("keeps nothing after a removal, and the job is due at once when the app comes back", async () => {
    const { outcome, refused } = await writeAfter(() =>
      removeApp(place.db, registry, { userId: place.sam.id, spaceId: place.family, appId: "ticker" }),
    );
    expect(refused).toBe("The app was removed from this space during the run. Nothing was read or written.");
    expect(outcome).toEqual({ kind: "gone", reason: refused });
    expect(jobRow(place.family)).toMatchObject({
      run_id: null,
      run_until: null,
      last_started_at: iso(0),
      last_succeeded_at: null,
      last_failed_at: null,
      failures: 0,
      next_run_at: iso(MINUTE),
    });
    expect(claimRun(place.db, registry, key(place.family), { now: at(2 * MINUTE) })).toBe("absent");
    addApp(place.db, registry, { userId: place.sam.id, spaceId: place.family, appId: "ticker", memberAccess: "view" });
    expect(claim(place.family, 2 * MINUTE).startedAt).toEqual(at(2 * MINUTE));
  });

  it("keeps nothing after a move, and the job is due at once where the app went", async () => {
    const { outcome, refused } = await writeAfter(() =>
      moveApp(place.db, registry, {
        userId: place.sam.id,
        spaceId: place.family,
        appId: "ticker",
        toSpaceId: place.samsSpace,
      }),
    );
    expect(refused).toBe(
      "The app left this space during the run: it was moved to another, or its data was deleted. Nothing was read or written.",
    );
    expect(outcome).toEqual({ kind: "gone", reason: refused });
    expect(jobRow(place.family)).toBeUndefined();
    expect(jobRow(place.samsSpace)).toMatchObject({ run_id: null, last_succeeded_at: null, next_run_at: iso(MINUTE) });
    expect(claim(place.samsSpace, MINUTE)).toMatchObject({ space: { kind: "personal", name: "" } });
  });

  it("keeps nothing after a deletion, and nothing is left to record", async () => {
    const { outcome } = await writeAfter(() => {
      removeApp(place.db, registry, { userId: place.sam.id, spaceId: place.family, appId: "ticker" });
      // The rows the test put there go too, so the whole app's data is gone.
      place.db.prepare("DELETE FROM app_rows WHERE space_id = ? AND app_id = 'ticker'").run(place.family);
      deleteAppData(place.db, registry, { userId: place.sam.id, spaceId: place.family, appId: "ticker", confirm: "ticker" });
    });
    expect(outcome).toMatchObject({ kind: "gone" });
    expect(jobRows().filter((row) => row.app_id === "ticker" && row.space_id === place.family)).toEqual([]);
  });

  it("keeps nothing after its claim was taken over, and recording it changes nothing", async () => {
    const first = claim(place.family, 0);
    const second = claim(place.family, RUN_TIME_LIMIT_MS + CLAIM_GRACE_MS);
    // The run of a server that was taken for dead goes on all the same.
    behaviour = (ctx) => {
      ctx.write((db) => {
        db.items.insert({ text: "Stale" });
      });
    };
    const outcome = await runClaimed(place.db, registry, first, world());
    expect(outcome).toEqual({
      kind: "gone",
      reason:
        "Another run has taken this job over: this one went on past its time, or the app's data was deleted and the app added again. Nothing was read or written.",
    });
    expect(kept(place.family)).toEqual([]);
    const held = jobRow(place.family);
    for (const anyOutcome of [outcome, { kind: "succeeded" } as const, { kind: "failed", error: "x", cause: null } as const]) {
      expect(recordRun(place.db, first, anyOutcome, { now: at(7 * MINUTE), random: () => 0 })).toBe(false);
    }
    expect(jobRow(place.family)).toEqual(held);
    expect(held).toMatchObject({ run_id: second.runId, failures: 0, last_succeeded_at: null });

    // The run that took it over writes and is recorded.
    behaviour = (ctx) => {
      ctx.write((db) => {
        db.items.insert({ text: "Fresh" });
      });
    };
    expect(await runClaimed(place.db, registry, second, world())).toEqual({ kind: "succeeded" });
    expect(recordRun(place.db, second, { kind: "succeeded" }, { now: at(7 * MINUTE), random: () => 0 })).toBe(true);
    expect(kept(place.family)).toMatchObject([{ text: "Fresh" }]);
  });

  it("is recorded where the app went when it moved and the run did not touch its rows after", async () => {
    const pause = gate();
    behaviour = async () => {
      await pause.pass();
    };
    const running = run(place.family);
    await pause.arrived;
    moveApp(place.db, registry, { userId: place.sam.id, spaceId: place.family, appId: "ticker", toSpaceId: place.samsSpace });
    pause.open();
    expect(await running).toEqual({ kind: "succeeded" });
    expect(jobRow(place.samsSpace)).toMatchObject({ last_succeeded_at: iso(0), run_id: null, next_run_at: iso(60 * MINUTE) });
  });
});

/* -------------------------------------------------------------------------
 * Recording a run
 * ---------------------------------------------------------------------- */

describe("recordRun", () => {
  /** Claims the job at `start` (forced) and records `outcome` at `end`. */
  function record(outcome: RunOutcome, start: number, end: number, random = 0, job = "refresh"): JobRow {
    const taken = claim(place.family, start, { force: true, job });
    expect(recordRun(place.db, taken, outcome, { now: at(end), random: () => random })).toBe(true);
    const row = jobRow(place.family, job);
    if (row === undefined) throw new Error("The job's row is gone.");
    return row;
  }
  const failed = (error = "The feed is down."): RunOutcome => ({ kind: "failed", error, cause: new Error(error) });

  it("records a run that went well: when it ended, no failures, and the next an interval to a tenth more after its start", () => {
    // The interval is an hour: the next run comes 60 to 66 minutes after this one started.
    for (const [random, next] of [
      [0, 3_600_000],
      [0.5, 3_780_000],
      [0.999_999, 3_959_999],
      [1, 3_960_000],
      // Whatever the randomness gives, the jitter stays within its bounds.
      [-3, 3_600_000],
      [7, 3_960_000],
    ] as const) {
      const row = record({ kind: "succeeded" }, 0, 2 * MINUTE, random);
      expect(row, `random ${random}`).toMatchObject({
        last_started_at: iso(0),
        last_succeeded_at: iso(2 * MINUTE),
        next_run_at: iso(next),
        failures: 0,
        run_id: null,
        run_until: null,
      });
    }
  });

  it("sets the next run a minute after the end when the interval has passed already", () => {
    expect(record({ kind: "succeeded" }, 0, 61 * MINUTE).next_run_at).toBe(iso(62 * MINUTE));
    expect(record({ kind: "succeeded" }, 0, 60 * MINUTE).next_run_at).toBe(iso(61 * MINUTE));
  });

  it("records a run that went wrong: when it ended, why, and the backoff of 5, 10, 20 and 40 minutes up to the interval", () => {
    const waits: number[] = [];
    let time = 0;
    for (let failure = 1; failure <= 7; failure += 1) {
      const row = record(failed(`Failure ${failure}.`), time, time + MINUTE);
      expect(row).toMatchObject({
        last_failed_at: iso(time + MINUTE),
        last_error: `Failure ${failure}.`,
        failures: failure,
        run_id: null,
        run_until: null,
      });
      waits.push((Date.parse(row.next_run_at) - at(time + MINUTE).getTime()) / MINUTE);
      time += 2 * MINUTE;
    }
    expect(waits).toEqual([5, 10, 20, 40, 60, 60, 60]);

    // A run that goes well ends the run of failures, and keeps what the last one said.
    const row = record({ kind: "succeeded" }, time, time + MINUTE);
    expect(row).toMatchObject({ failures: 0, last_error: "Failure 7.", last_failed_at: iso(time - MINUTE) });
    expect(Date.parse(record(failed(), time + 2 * MINUTE, time + 3 * MINUTE).next_run_at)).toBe(
      at(time + 3 * MINUTE + 5 * MINUTE).getTime(),
    );
  });

  it("never backs off for longer than the job's interval", () => {
    const waits: number[] = [];
    for (let failure = 1; failure <= 4; failure += 1) {
      const row = record(failed(), failure * 30 * MINUTE, failure * 30 * MINUTE, 0, "tidy");
      waits.push((Date.parse(row.next_run_at) - at(failure * 30 * MINUTE).getTime()) / MINUTE);
    }
    expect(waits).toEqual([5, 10, 15, 15]);
  });

  it("keeps the first 200 characters of a message", () => {
    expect(MAX_ERROR_LENGTH).toBe(200);
    const exactly = "x".repeat(200);
    expect(record(failed(exactly), 0, MINUTE).last_error).toBe(exactly);
    const long = `${"y".repeat(150)}${"错".repeat(150)}`;
    const cut = record(failed(long), 0, MINUTE).last_error ?? "";
    expect(Array.from(cut)).toHaveLength(200);
    expect(cut).toBe(`${"y".repeat(150)}${"错".repeat(49)}…`);
    // Characters, not halves of one: a character beyond the basic plane is kept whole or not at all.
    const wide = "😀".repeat(250);
    expect(keptError(wide)).toBe(`${"😀".repeat(199)}…`);
    expect(record(failed(wide), 0, MINUTE).last_error).toBe(`${"😀".repeat(199)}…`);
  });

  it("records nothing for a run the server stopped or one whose install went away, and makes the job due at once", () => {
    record({ kind: "succeeded" }, 0, MINUTE);
    const before = record(failed("Before."), 2 * MINUTE, 3 * MINUTE);
    for (const outcome of [{ kind: "stopped" }, { kind: "gone", reason: "Removed." }] as const) {
      const row = record(outcome, 10 * MINUTE, 11 * MINUTE);
      expect(row).toEqual({
        ...before,
        last_started_at: iso(10 * MINUTE),
        next_run_at: iso(11 * MINUTE),
        run_id: null,
        run_until: null,
      });
    }
  });

  it("finds nothing to record for a claim that is not held", () => {
    const taken = claim(place.family, 0);
    expect(recordRun(place.db, taken, { kind: "succeeded" }, { now: at(MINUTE), random: () => 0 })).toBe(true);
    // Recording the same run twice finds its claim gone the second time.
    expect(recordRun(place.db, taken, failed(), { now: at(2 * MINUTE), random: () => 0 })).toBe(false);
    expect(jobRow(place.family)).toMatchObject({ failures: 0, last_failed_at: null });
  });
});

describe("runOnce", () => {
  it("claims, runs and records, and says why it did not run", async () => {
    expect(await run(place.family)).toEqual({ kind: "succeeded" });
    expect(await run(place.family)).toBe("not_due");
    expect(await run(place.samsSpace)).toBe("absent");
    expect(await runOnce(place.db, registry, key(place.family), world(), { force: true })).toEqual({ kind: "succeeded" });

    const pause = gate();
    behaviour = async () => {
      await pause.pass();
    };
    const running = runOnce(place.db, registry, key(place.family), world(), { force: true });
    await pause.arrived;
    expect(await runOnce(place.db, registry, key(place.family), world(), { force: true })).toBe("running");
    pause.open();
    expect(await running).toEqual({ kind: "succeeded" });
    expect(fake.pending()).toBe(0);
  });
});

/* -------------------------------------------------------------------------
 * What people may do and see
 * ---------------------------------------------------------------------- */

describe("jobStatus", () => {
  it("answers for a job that has not run: nothing yet, due now, idle", () => {
    expect(statusFor(place.sam.id, place.family, "refresh", at(0))).toEqual({
      lastStartedAt: null,
      lastSucceededAt: null,
      lastFailedAt: null,
      lastError: null,
      nextRunAt: iso(0),
      state: "idle",
    } satisfies JobStatus);
    expect(jobRows()).toEqual([]);
  });

  it("is running while a run holds the job, asked for while a request waits, and idle otherwise", async () => {
    const pause = gate();
    behaviour = async () => {
      await pause.pass();
      throw new Error("The feed is down.");
    };
    const running = run(place.family);
    await pause.arrived;
    expect(statusFor(place.lin.id)).toMatchObject({ state: "running", lastStartedAt: iso(0) });
    pause.open();
    await running;
    expect(statusFor(place.lin.id)).toEqual({
      lastStartedAt: iso(0),
      lastSucceededAt: null,
      lastFailedAt: iso(0),
      lastError: "The feed is down.",
      nextRunAt: iso(5 * MINUTE),
      state: "idle",
    });
    ask(place.sam.id, place.family, "refresh", at(MINUTE));
    expect(statusFor(place.lin.id, place.family, "refresh", at(MINUTE))).toMatchObject({ state: "requested" });

    // A claim whose time has run out holds nothing.
    claim(place.family, 6 * MINUTE);
    expect(statusFor(place.lin.id, place.family, "refresh", at(12 * MINUTE - 1)).state).toBe("running");
    expect(statusFor(place.lin.id, place.family, "refresh", at(12 * MINUTE)).state).toBe("idle");
  });

  it("is for anyone who may see the app, and 404 for everyone and everything else", () => {
    for (const userId of [place.sam.id, place.lin.id, place.kim.id]) {
      expect(statusFor(userId).state).toBe("idle");
    }
    const notFound = { status: 404, code: "not_found" };
    // Someone not in the family, someone the app is hidden from, and an app removed.
    expect(refusal(() => statusFor(place.noa.id))).toEqual(notFound);
    grant(place.db, place.family, "ticker", place.lin.id, "none", place.sam.id);
    expect(refusal(() => statusFor(place.lin.id))).toEqual(notFound);
    // A job that is not there, a query's name, an app without a server file.
    expect(refusal(() => statusFor(place.sam.id, place.family, "nothing"))).toEqual(notFound);
    expect(refusal(() => statusFor(place.sam.id, place.family, "latest"))).toEqual(notFound);
    install(place.db, place.family, "feed", place.sam.id);
    expect(
      refusal(() => jobStatus(place.db, registry, { userId: place.sam.id, spaceId: place.family, appId: "feed", job: "refresh" })),
    ).toEqual(notFound);
    removeApp(place.db, registry, { userId: place.sam.id, spaceId: place.family, appId: "ticker" });
    expect(refusal(() => statusFor(place.sam.id))).toEqual(notFound);
  });
});

describe("requestRun", () => {
  it("asks for a job that has not run: due at once", () => {
    expect(ask(place.sam.id, place.family, "refresh", at(0))).toEqual({
      lastStartedAt: null,
      lastSucceededAt: null,
      lastFailedAt: null,
      lastError: null,
      nextRunAt: iso(0),
      state: "requested",
    });
    expect(jobRow(place.family)).toMatchObject({ requested_at: iso(0), next_run_at: iso(0), run_id: null });
  });

  it("starts a run at once when the last one started 5 minutes ago or more", () => {
    recordRun(place.db, claim(place.family, 0), { kind: "succeeded" }, { now: at(MINUTE), random: () => 0 });
    expect(REQUEST_GAP_MS).toBe(5 * MINUTE);
    expect(ask(place.sam.id, place.family, "refresh", at(5 * MINUTE))).toMatchObject({
      nextRunAt: iso(5 * MINUTE),
      state: "requested",
    });
    expect(claimRun(place.db, registry, key(place.family), { now: at(5 * MINUTE) })).not.toBe("not_due");
  });

  it("starts it 5 minutes after the last one started, never sooner, however often it is asked", () => {
    recordRun(place.db, claim(place.family, 0), { kind: "succeeded" }, { now: at(MINUTE), random: () => 0 });
    for (const minute of [1, 2, 4]) {
      expect(ask(place.sam.id, place.family, "refresh", at(minute * MINUTE))).toMatchObject({
        nextRunAt: iso(5 * MINUTE),
        state: "requested",
      });
    }
    expect(jobRow(place.family)?.requested_at).toBe(iso(4 * MINUTE));
    expect(claimRun(place.db, registry, key(place.family), { now: at(5 * MINUTE - 1) })).toBe("not_due");
    expect(claim(place.family, 5 * MINUTE)).toBeTruthy();
  });

  it("never puts a run off: one due sooner stays as it is", () => {
    // A run the server stopped leaves the job due at once.
    recordRun(place.db, claim(place.family, 0), { kind: "stopped" }, { now: at(MINUTE), random: () => 0 });
    expect(ask(place.sam.id, place.family, "refresh", at(2 * MINUTE))).toMatchObject({
      nextRunAt: iso(MINUTE),
      state: "requested",
    });
  });

  it("changes nothing during a run, and a claim whose time has run out is no run", () => {
    const taken = claim(place.family, 0);
    const held = jobRow(place.family);
    expect(ask(place.sam.id, place.family, "refresh", at(MINUTE))).toMatchObject({ state: "running", nextRunAt: iso(0) });
    expect(jobRow(place.family)).toEqual(held);
    expect(ask(place.sam.id, place.family, "refresh", at(RUN_TIME_LIMIT_MS + CLAIM_GRACE_MS))).toMatchObject({
      state: "requested",
      nextRunAt: iso(0),
    });
    expect(jobRow(place.family)).toMatchObject({ run_id: taken.runId, requested_at: iso(RUN_TIME_LIMIT_MS + CLAIM_GRACE_MS) });
  });

  it("needs edit: 403 for someone who may only view, 404 as for the status", () => {
    const forbidden = { status: 403, code: "forbidden" };
    const notFound = { status: 404, code: "not_found" };
    // Lin and Kim are members, who may view the family's ticker.
    expect(refusal(() => ask(place.lin.id))).toEqual(forbidden);
    expect(refusal(() => ask(place.kim.id))).toEqual(forbidden);
    expect(jobRows()).toEqual([]);
    grant(place.db, place.family, "ticker", place.kim.id, "edit", place.sam.id);
    expect(ask(place.kim.id).state).toBe("requested");
    expect(ask(place.lin.id, place.linsSpace).state).toBe("requested");

    expect(refusal(() => ask(place.noa.id))).toEqual(notFound);
    expect(refusal(() => ask(place.sam.id, place.family, "latest"))).toEqual(notFound);
    expect(refusal(() => ask(place.sam.id, place.family, "nothing"))).toEqual(notFound);
    // The 404 comes first: a viewer learns nothing of a name that is no job.
    expect(refusal(() => ask(place.lin.id, place.family, "nothing"))).toEqual(notFound);
    removeApp(place.db, registry, { userId: place.sam.id, spaceId: place.family, appId: "ticker" });
    expect(refusal(() => ask(place.sam.id))).toEqual(notFound);
  });
});
