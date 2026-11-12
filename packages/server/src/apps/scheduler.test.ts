/**
 * The scheduler (docs/mini-app-contract.md, section C, "The scheduler"):
 * one run at a time, the job that fell due first first, a new install at
 * once, the sleep and the wake, a stop, a restart, and two processes on one
 * database file. Time is a clock that moves only when told, and ctx.fetch
 * answers from a transport written here: nothing waits and nothing reaches
 * a network.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineApp } from "@hearth/sdk";
import { defineServer, FetchError, z, type JobCtx } from "@hearth/sdk/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrate, openDatabase, type Db } from "../db/database";
import type { TransportRequest } from "./fetch";
import { addApp, removeApp } from "./installs";
import { CLAIM_GRACE_MS, claimRun, requestRun, RUN_OVER, RUN_TIME_LIMIT_MS } from "./jobs";
import { createRegistry, type BundledApp, type Registry } from "./registry";
import { createScheduler, LOGGED_MESSAGE_LENGTH, LONGEST_WAIT_MS, type Scheduler } from "./scheduler";
import { fakeClock, settle } from "./test-clock";
import { APPS, family, install, NOW } from "./test-world";

/* -------------------------------------------------------------------------
 * Two sample apps whose jobs do what the test at hand asks of them
 * ---------------------------------------------------------------------- */

const tickerManifest = defineApp({
  id: "ticker",
  name: { en: "Ticker", zh: "快讯" },
  description: { en: "Keeps the latest headlines of a feed.", zh: "保存一个订阅源的最新标题。" },
  icon: "file-text",
  color: "teal",
  widget: { size: "small" },
  network: ["feeds.example.com"],
});
const digestManifest = defineApp({
  id: "digest",
  name: { en: "Digest", zh: "摘要" },
  description: { en: "Sums up the feed every half hour.", zh: "每半小时汇总一次订阅源。" },
  icon: "notebook-text",
  color: "amber",
  widget: { size: "small" },
});

const collections = { items: z.object({ text: z.string().max(200) }) };
type Ctx = JobCtx<typeof tickerManifest, typeof collections>;

/** What every job does in the test at hand; `run` names the run as "<space's name>/<app>/<job>". */
let behaviour: (ctx: Ctx, run: string) => Promise<void> | void = () => {};
/** Every run that started, in order, with when it started (minutes after START). */
let runs: { run: string; minute: number }[];

function job(appId: string, name: string) {
  return (ctx: Ctx) => {
    const run = `${ctx.space.name}/${appId}/${name}`;
    runs.push({ run, minute: (ctx.now.getTime() - START) / MINUTE });
    return behaviour(ctx, run);
  };
}

const ticker = defineServer(tickerManifest, collections);
const TICKER: BundledApp = {
  id: "ticker",
  manifest: tickerManifest,
  hasPage: false,
  server: ticker.routes({
    latest: ticker.query({ description: "Lists the headlines kept, oldest first." }, (ctx) => ctx.db.items.list()),
    refresh: ticker.job({ description: "Does what the test at hand asks of it, every hour.", everyMinutes: 60 }, job("ticker", "refresh")),
    tidy: ticker.job({ description: "Does what the test at hand asks of it, every quarter of an hour.", everyMinutes: 15 }, job("ticker", "tidy")),
  }),
};
const digest = defineServer(digestManifest, collections);
const DIGEST: BundledApp = {
  id: "digest",
  manifest: digestManifest,
  hasPage: false,
  server: digest.routes({
    refresh: digest.job(
      { description: "Does what the test at hand asks of it, every half hour.", everyMinutes: 30 },
      job("digest", "refresh"),
    ),
  }),
};

/* -------------------------------------------------------------------------
 * The world: a family, two groups of Sam's, time and the way out
 * ---------------------------------------------------------------------- */

const MINUTE = 60_000;
/** The moment the fake clock's 0 stands for. */
const START = Date.parse("2026-03-01T08:00:00.000Z");
const at = (ms: number) => new Date(START + ms);
const iso = (ms: number) => at(ms).toISOString();

let place: ReturnType<typeof family>;
let registry: Registry;
let fake: ReturnType<typeof fakeClock>;
let lines: string[];
let requests: TransportRequest[];
let made: Scheduler[];

/** A group of Sam's with an ID of the test's choosing, so that the order of spaces is known. */
function group(id: string, name: string, db: Db = place.db): void {
  db.prepare("INSERT INTO spaces (id, kind, name, created_by, created_at) VALUES (?, 'group', ?, ?, ?)").run(
    id,
    name,
    place.sam.id,
    NOW,
  );
  db.prepare(
    "INSERT INTO space_members (space_id, user_id, role, can_add_apps, created_at) VALUES (?, ?, 'owner', 0, ?)",
  ).run(id, place.sam.id, NOW);
}

function setUp(db?: Db): void {
  place = family(db);
  group("a-team", "A");
  group("b-team", "B");
}

beforeEach(() => {
  setUp();
  registry = createRegistry([...APPS, TICKER, DIGEST]);
  fake = fakeClock();
  lines = [];
  requests = [];
  runs = [];
  made = [];
  behaviour = () => {};
});

afterEach(async () => {
  await Promise.all(made.map((scheduler) => scheduler.stop()));
});

function scheduler(options: { db?: Db; registry?: Registry; random?: () => number } = {}): Scheduler {
  const scheduler = createScheduler({
    db: options.db ?? place.db,
    registry: options.registry ?? registry,
    outbound: {
      transport: (request) => {
        requests.push(request);
        return Promise.resolve(Response.json({ items: [] }));
      },
      pace: null,
      clock: fake.clock,
    },
    clock: fake.clock,
    now: () => at(fake.clock.now()),
    random: options.random ?? (() => 0),
    log: (line) => lines.push(line),
  });
  made.push(scheduler);
  return scheduler;
}

const started = () => runs.map((entry) => entry.run);

/** Runs that wait until the test lets each go, by name. */
let waiting: Map<string, () => void>;
beforeEach(() => {
  waiting = new Map();
});
const hold = (_ctx: Ctx, run: string) =>
  new Promise<void>((resolve) => {
    waiting.set(run, resolve);
  });
function release(run: string): void {
  const go = waiting.get(run);
  if (go === undefined) throw new Error(`${run} is not waiting.`);
  waiting.delete(run);
  go();
}

type JobRow = {
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
const jobRow = (spaceId: string, appId: string, job: string, db: Db = place.db) =>
  db
    .prepare(
      `SELECT next_run_at, requested_at, run_id, run_until, last_started_at, last_succeeded_at, last_failed_at,
              last_error, failures
         FROM app_jobs WHERE space_id = ? AND app_id = ? AND job = ?`,
    )
    .get(spaceId, appId, job) as JobRow | undefined;

/** A job's row as an earlier run, of this process or another, left it: due at `next`. */
function due(spaceId: string, appId: string, job: string, next: number): void {
  place.db
    .prepare("INSERT INTO app_jobs (space_id, app_id, job, next_run_at, last_started_at) VALUES (?, ?, ?, ?, ?)")
    .run(spaceId, appId, job, iso(next), iso(next - 60 * MINUTE));
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

/* -------------------------------------------------------------------------
 * Which job, and when
 * ---------------------------------------------------------------------- */

describe("the order of runs", () => {
  it("runs one job at a time, until all that are due have run, in order of space, app and job when due together", async () => {
    install(place.db, "b-team", "ticker", place.sam.id);
    install(place.db, "a-team", "ticker", place.sam.id);
    install(place.db, "a-team", "digest", place.sam.id);
    behaviour = hold;
    scheduler().start();
    await settle();
    expect(started()).toEqual(["A/digest/refresh"]);
    // While a run goes on, nothing else starts, however much is due and however long it takes.
    await fake.advance(4 * MINUTE);
    expect(started()).toEqual(["A/digest/refresh"]);

    const order = ["A/digest/refresh", "A/ticker/refresh", "A/ticker/tidy", "B/ticker/refresh", "B/ticker/tidy"];
    for (const [index, run] of order.entries()) {
      expect(started()).toEqual(order.slice(0, index + 1));
      expect([...waiting.keys()]).toEqual([run]);
      release(run);
      await settle();
    }
    expect(started()).toEqual(order);
    expect(waiting.size).toBe(0);
    expect(lines).toEqual([]);
  });

  it("takes the job that fell due first, then sleeps until the next one is due", async () => {
    install(place.db, "a-team", "ticker", place.sam.id);
    install(place.db, "b-team", "ticker", place.sam.id);
    install(place.db, "a-team", "digest", place.sam.id);
    // As earlier runs left them. The digest has not run in A yet: it is due now.
    due("b-team", "ticker", "refresh", -20 * MINUTE);
    due("a-team", "ticker", "refresh", -5 * MINUTE);
    due("a-team", "ticker", "tidy", 10 * MINUTE);
    due("b-team", "ticker", "tidy", 3 * MINUTE);
    scheduler().start();
    await settle();
    expect(started()).toEqual(["B/ticker/refresh", "A/ticker/refresh", "A/digest/refresh"]);

    await fake.advance(3 * MINUTE - 1);
    expect(runs).toHaveLength(3);
    await fake.advance(1);
    expect(runs.at(-1)).toEqual({ run: "B/ticker/tidy", minute: 3 });
    await fake.advance(7 * MINUTE - 1);
    expect(runs).toHaveLength(4);
    await fake.advance(1);
    expect(runs.at(-1)).toEqual({ run: "A/ticker/tidy", minute: 10 });

    // Each runs again an interval after its run started (the randomness gives no jitter here).
    await fake.advance(50 * MINUTE);
    expect(runs.slice(5)).toEqual([
      { run: "B/ticker/tidy", minute: 18 },
      { run: "A/ticker/tidy", minute: 25 },
      { run: "A/digest/refresh", minute: 30 },
      { run: "B/ticker/tidy", minute: 33 },
      { run: "A/ticker/tidy", minute: 40 },
      { run: "B/ticker/tidy", minute: 48 },
      { run: "A/ticker/tidy", minute: 55 },
      // Three due at the same moment: by space, then app.
      { run: "A/digest/refresh", minute: 60 },
      { run: "A/ticker/refresh", minute: 60 },
      { run: "B/ticker/refresh", minute: 60 },
    ]);
  });

  it("times runs as they are recorded: the backoff after failures, and the jitter after one that went well", async () => {
    install(place.db, "a-team", "digest", place.sam.id);
    let failing = true;
    behaviour = () => {
      if (failing) throw new Error("The feed is down.");
    };
    // The most jitter there is: a tenth of the interval.
    scheduler({ random: () => 1 }).start();
    await settle();
    // Failures in a row: again after 5, 10 and 20 minutes, never more than the interval of 30.
    await fake.advance(35 * MINUTE);
    expect(runs.map((entry) => entry.minute)).toEqual([0, 5, 15, 35]);
    failing = false;
    await fake.advance(30 * MINUTE);
    expect(runs.map((entry) => entry.minute)).toEqual([0, 5, 15, 35, 65]);
    expect(jobRow("a-team", "digest", "refresh")).toMatchObject({ failures: 0, last_succeeded_at: iso(65 * MINUTE) });
    // After a run that went well: 30 minutes and a tenth more.
    await fake.advance(33 * MINUTE - 1);
    expect(runs).toHaveLength(5);
    await fake.advance(1);
    expect(runs.at(-1)).toEqual({ run: "A/digest/refresh", minute: 98 });
  });

  it("passes by a removed app, an app or a job this build does not hold, and apps without jobs", async () => {
    install(place.db, "a-team", "ticker", place.sam.id, { removedAt: NOW });
    install(place.db, "a-team", "retired", place.sam.id);
    install(place.db, "a-team", "feed", place.sam.id);
    install(place.db, "a-team", "checklist", place.sam.id);
    install(place.db, "b-team", "digest", place.sam.id);
    // A job the digest no longer has, long overdue.
    due("b-team", "digest", "summarise", -60 * MINUTE);
    const running = scheduler();
    running.start();
    await settle();
    expect(started()).toEqual(["B/digest/refresh"]);

    // Brought back: its jobs, which never ran, are due at once.
    expect(addApp(place.db, registry, { userId: place.sam.id, spaceId: "a-team", appId: "ticker" })).toBe("restored");
    running.wake();
    await settle();
    expect(started()).toEqual(["B/digest/refresh", "A/ticker/refresh", "A/ticker/tidy"]);
    // Removed again: passed by when it falls due.
    removeApp(place.db, registry, { userId: place.sam.id, spaceId: "a-team", appId: "ticker" });
    await fake.advance(30 * MINUTE);
    expect(started()).toEqual(["B/digest/refresh", "A/ticker/refresh", "A/ticker/tidy", "B/digest/refresh"]);
  });
});

describe("a job it finds due but cannot claim", () => {
  it("is asked for again at once, then not before the scheduler looks again 30 seconds later", async () => {
    install(place.db, "a-team", "digest", place.sam.id);
    // A build whose answer changes between looking and claiming, as when another process claims
    // the job in between: every other question about the digest finds no such app.
    let questions = 0;
    const changing: Registry = {
      ...registry,
      get: (appId) => {
        questions += 1;
        return questions % 2 === 1 ? registry.get(appId) : undefined;
      },
    };
    scheduler({ registry: changing }).start();
    await settle();
    // Looked, was refused, looked again at once, was refused again: then it sleeps.
    expect(questions).toBe(4);
    expect(runs).toEqual([]);
    expect(fake.pending()).toBe(1);
    await fake.advance(LONGEST_WAIT_MS - 1);
    expect(questions).toBe(4);
    await fake.advance(1);
    expect(questions).toBe(6);
    expect(lines).toEqual([]);
  });
});

/* -------------------------------------------------------------------------
 * Sleeping and waking
 * ---------------------------------------------------------------------- */

describe("the sleep and the wake", () => {
  it("runs a new install's jobs at once when woken, and within 30 seconds when another process added it", async () => {
    install(place.db, "a-team", "ticker", place.sam.id);
    const running = scheduler();
    running.start();
    await settle();
    expect(started()).toEqual(["A/ticker/refresh", "A/ticker/tidy"]);
    // Nothing is due for 15 minutes: it sleeps, and only its sleep is left on the clock.
    expect(fake.pending()).toBe(1);
    await fake.advance(10_000);

    // Added in this process: the route that adds an app wakes the scheduler.
    expect(addApp(place.db, registry, { userId: place.sam.id, spaceId: "b-team", appId: "ticker" })).toBe("added");
    running.wake();
    await settle();
    expect(runs.slice(2)).toEqual([
      { run: "B/ticker/refresh", minute: 10_000 / MINUTE },
      { run: "B/ticker/tidy", minute: 10_000 / MINUTE },
    ]);

    // Added by another process that shares the database: nothing wakes this one, which sees it
    // when it looks again, 30 seconds after it went to sleep.
    expect(LONGEST_WAIT_MS).toBe(30_000);
    install(place.db, "b-team", "digest", place.sam.id);
    await fake.advance(LONGEST_WAIT_MS - 1);
    expect(runs).toHaveLength(4);
    await fake.advance(1);
    expect(started().at(-1)).toBe("B/digest/refresh");
  });

  it("starts a run someone asked for at once, or once 5 minutes have passed since the last one started", async () => {
    install(place.db, "a-team", "digest", place.sam.id);
    const running = scheduler();
    running.start();
    await settle();
    expect(runs).toEqual([{ run: "A/digest/refresh", minute: 0 }]);

    const ask = () =>
      requestRun(place.db, registry, { userId: place.sam.id, spaceId: "a-team", appId: "digest", job: "refresh" }, at(fake.clock.now()));
    // Asked for 2 minutes after the last run started: it starts 5 minutes after that one, not sooner.
    await fake.advance(2 * MINUTE);
    expect(ask().state).toBe("requested");
    running.wake();
    await settle();
    expect(runs).toHaveLength(1);
    await fake.advance(3 * MINUTE - 1);
    expect(runs).toHaveLength(1);
    await fake.advance(1);
    expect(runs.at(-1)).toEqual({ run: "A/digest/refresh", minute: 5 });

    // Asked for 15 minutes after that: at once.
    await fake.advance(15 * MINUTE);
    ask();
    running.wake();
    await settle();
    expect(runs.at(-1)).toEqual({ run: "A/digest/refresh", minute: 20 });
    // Without a wake, a run asked for in another process starts when this one looks again.
    await fake.advance(6 * MINUTE);
    ask();
    await fake.advance(LONGEST_WAIT_MS);
    expect(runs.at(-1)).toEqual({ run: "A/digest/refresh", minute: 26.5 });
    expect(runs).toHaveLength(4);
  });

  it("changes nothing when woken during a run, and looks again once the run is over", async () => {
    install(place.db, "a-team", "ticker", place.sam.id);
    behaviour = hold;
    const running = scheduler();
    running.start();
    await settle();
    expect(started()).toEqual(["A/ticker/refresh"]);
    running.wake();
    running.wake();
    await settle();
    expect(started()).toEqual(["A/ticker/refresh"]);
    release("A/ticker/refresh");
    await settle();
    expect(started()).toEqual(["A/ticker/refresh", "A/ticker/tidy"]);
  });

  it("does nothing before it is started, and starts once", async () => {
    install(place.db, "a-team", "digest", place.sam.id);
    const running = scheduler();
    running.wake();
    await fake.advance(LONGEST_WAIT_MS);
    expect(runs).toEqual([]);
    running.start();
    running.start();
    await settle();
    expect(started()).toEqual(["A/digest/refresh"]);
    expect(fake.pending()).toBe(1);
  });
});

/* -------------------------------------------------------------------------
 * Stopping, and starting again
 * ---------------------------------------------------------------------- */

describe("stopping", () => {
  it("ends the run going on at once, leaves its job due at once, and starts nothing after", async () => {
    install(place.db, "a-team", "ticker", place.sam.id);
    let kept: Ctx | undefined;
    let fetched: unknown;
    behaviour = async (ctx) => {
      kept = ctx;
      fetched = await ctx.fetch("https://feeds.example.com/headlines.json").catch((error: unknown) => error);
      // A job that does not listen is not waited for.
      await new Promise<void>(() => {});
    };
    // The answer never comes.
    const running = createScheduler({
      db: place.db,
      registry,
      outbound: { transport: () => new Promise<Response>(() => {}), pace: null, clock: fake.clock },
      clock: fake.clock,
      now: () => at(fake.clock.now()),
      random: () => 0,
      log: (line) => lines.push(line),
    });
    made.push(running);
    running.start();
    await settle();
    expect(started()).toEqual(["A/ticker/refresh"]);
    // Less than the 20 seconds an answer may take: the request is still on its way.
    await fake.advance(10_000);

    const stopped = watch(running.stop());
    await settle();
    expect(stopped.settled).toBe(true);
    // The run is recorded as nothing: no success, no failure, and due at once.
    expect(jobRow("a-team", "ticker", "refresh")).toEqual({
      next_run_at: iso(10_000),
      requested_at: null,
      run_id: null,
      run_until: null,
      last_started_at: iso(0),
      last_succeeded_at: null,
      last_failed_at: null,
      last_error: null,
      failures: 0,
    });
    // The tidy, due all along, never started.
    expect(jobRow("a-team", "ticker", "tidy")).toBeUndefined();
    expect((fetched as FetchError).code).toBe("stopped");
    expect(() => kept?.read((db) => db.items.count())).toThrow(RUN_OVER);
    // No timer is left, and nothing starts again, whatever is asked of it.
    expect(fake.pending()).toBe(0);
    running.wake();
    running.start();
    await fake.advance(60 * MINUTE);
    expect(started()).toEqual(["A/ticker/refresh"]);
    await running.stop();
    expect(lines).toEqual([]);
  });

  it("while it sleeps, stops at once", async () => {
    install(place.db, "a-team", "digest", place.sam.id);
    const running = scheduler();
    running.start();
    await settle();
    expect(fake.pending()).toBe(1);
    const stopped = watch(running.stop());
    await settle();
    expect(stopped.settled).toBe(true);
    expect(fake.pending()).toBe(0);
  });

  it("before it started, does nothing and keeps it from starting", async () => {
    install(place.db, "a-team", "digest", place.sam.id);
    const running = scheduler();
    await running.stop();
    running.start();
    await fake.advance(LONGEST_WAIT_MS);
    expect(runs).toEqual([]);
  });
});

describe("a restart", () => {
  it("goes on where the last scheduler stopped: what is due runs, in order", async () => {
    install(place.db, "a-team", "ticker", place.sam.id);
    install(place.db, "b-team", "ticker", place.sam.id);
    behaviour = (ctx, run) => (run === "B/ticker/refresh" ? new Promise<void>(() => {}) : undefined);
    const first = scheduler();
    first.start();
    await settle();
    expect(started()).toEqual(["A/ticker/refresh", "A/ticker/tidy", "B/ticker/refresh"]);
    await fake.advance(2 * MINUTE);
    await first.stop();

    // The server starts again 18 minutes later: B's refresh has been due since it was stopped,
    // A's tidy since 15 minutes, and B's tidy, which never ran, is due now. A's refresh is not.
    await fake.advance(18 * MINUTE);
    behaviour = () => {};
    const second = scheduler();
    second.start();
    await settle();
    expect(runs.slice(3)).toEqual([
      { run: "B/ticker/refresh", minute: 20 },
      { run: "A/ticker/tidy", minute: 20 },
      { run: "B/ticker/tidy", minute: 20 },
    ]);
    expect(jobRow("a-team", "ticker", "refresh")).toMatchObject({ last_started_at: iso(0), next_run_at: iso(60 * MINUTE) });
  });

  it("takes over a run cut off by a crash once its claim has run out, and counts that run for nothing", async () => {
    install(place.db, "a-team", "digest", place.sam.id);
    // A server that died in the middle of a run left its claim behind.
    const left = claimRun(place.db, registry, { spaceId: "a-team", appId: "digest", job: "refresh" }, { now: at(0) });
    expect(typeof left).toBe("object");
    const running = scheduler();
    running.start();
    await settle();
    expect(runs).toEqual([]);
    const runsOut = RUN_TIME_LIMIT_MS + CLAIM_GRACE_MS;
    await fake.advance(runsOut - 1);
    expect(runs).toEqual([]);
    await fake.advance(1);
    expect(runs).toEqual([{ run: "A/digest/refresh", minute: runsOut / MINUTE }]);
    expect(jobRow("a-team", "digest", "refresh")).toMatchObject({
      run_id: null,
      last_started_at: iso(runsOut),
      last_succeeded_at: iso(runsOut),
      last_failed_at: null,
      failures: 0,
    });
  });
});

describe("two server processes on one database file", () => {
  let folder: string;
  let databases: Db[];
  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), "hearth-scheduler-"));
    databases = [];
  });
  afterEach(async () => {
    // Their schedulers stop before their databases close.
    await Promise.all(made.splice(0).map((scheduler) => scheduler.stop()));
    for (const db of databases) db.close();
    rmSync(folder, { recursive: true, force: true });
  });

  it("run each job once, two runs at a time, one in each", async () => {
    const file = join(folder, "hearth.db");
    const one = openDatabase(file);
    databases.push(one);
    migrate(one);
    setUp(one);
    install(one, "a-team", "ticker", place.sam.id);
    install(one, "b-team", "ticker", place.sam.id);
    install(one, "a-team", "digest", place.sam.id);
    const two = openDatabase(file);
    databases.push(two);

    behaviour = hold;
    // Each process has its own registry, built from the same apps, and its own connection.
    scheduler({ db: one, registry: createRegistry([...APPS, TICKER, DIGEST]) }).start();
    scheduler({ db: two, registry: createRegistry([...APPS, TICKER, DIGEST]) }).start();
    await settle();
    // Each process runs one job, not the same one: the claim in the database keeps them apart.
    expect(waiting.size).toBe(2);
    expect(new Set(started()).size).toBe(2);

    const all = ["A/digest/refresh", "A/ticker/refresh", "A/ticker/tidy", "B/ticker/refresh", "B/ticker/tidy"];
    while (waiting.size > 0) {
      const [run] = waiting.keys();
      release(run ?? "");
      await settle();
      expect(waiting.size).toBeLessThanOrEqual(2);
    }
    expect([...started()].sort()).toEqual(all);

    // A quarter of an hour on, the tidies are due again: once each, whichever process runs them.
    behaviour = () => {};
    await fake.advance(15 * MINUTE);
    expect([...started()].sort()).toEqual([...all, "A/ticker/tidy", "B/ticker/tidy"].sort());
    expect(runs.slice(5).map((entry) => entry.minute)).toEqual([15, 15]);
    expect(lines).toEqual([]);
  });
});

/* -------------------------------------------------------------------------
 * What it says
 * ---------------------------------------------------------------------- */

describe("the log", () => {
  it("has one line for each run that went wrong, with the app, the job, the space's ID and why, and none for the others", async () => {
    install(place.db, "a-team", "ticker", place.sam.id);
    behaviour = (_ctx, run) => {
      if (run === "A/ticker/refresh") throw new Error("The feed is down.\n  Try again later.");
    };
    scheduler().start();
    await settle();
    expect(started()).toEqual(["A/ticker/refresh", "A/ticker/tidy"]);
    expect(lines).toEqual(['App "ticker", job "refresh", space a-team: the run failed: The feed is down. Try again later.']);

    // A long message is cut, still on one line.
    behaviour = () => {
      throw new Error("x".repeat(5_000));
    };
    await fake.advance(5 * MINUTE);
    expect(started().at(-1)).toBe("A/ticker/refresh");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe(
      `App "ticker", job "refresh", space a-team: the run failed: ${"x".repeat(LOGGED_MESSAGE_LENGTH - 1)}…`,
    );
    expect(LOGGED_MESSAGE_LENGTH).toBe(1_000);

    // Cut by characters: one beyond the basic plane is kept whole or not at all.
    behaviour = (_ctx, run) => {
      if (run === "A/ticker/refresh") throw new Error("😀".repeat(1_200));
    };
    await fake.advance(10 * MINUTE);
    expect(runs.slice(-2)).toEqual([
      { run: "A/ticker/refresh", minute: 15 },
      { run: "A/ticker/tidy", minute: 15 },
    ]);
    expect(lines).toHaveLength(3);
    expect(lines[2]).toBe(`App "ticker", job "refresh", space a-team: the run failed: ${"😀".repeat(LOGGED_MESSAGE_LENGTH - 1)}…`);
  });

  it("says when the database cannot be read, and the scheduler looks again 30 seconds later", async () => {
    install(place.db, "a-team", "digest", place.sam.id);
    place.db.exec("ALTER TABLE app_jobs RENAME TO app_jobs_away");
    scheduler().start();
    await settle();
    expect(lines).toEqual(["The scheduler could not run jobs (no such table: app_jobs). It looks again in 30 seconds."]);
    expect(runs).toEqual([]);
    place.db.exec("ALTER TABLE app_jobs_away RENAME TO app_jobs");
    await fake.advance(LONGEST_WAIT_MS - 1);
    expect(runs).toEqual([]);
    await fake.advance(1);
    expect(started()).toEqual(["A/digest/refresh"]);
    expect(lines).toHaveLength(1);
  });
});

describe("the way out", () => {
  it("is the one the scheduler was given, for the hosts each app lists", async () => {
    install(place.db, "a-team", "ticker", place.sam.id);
    const seen: unknown[] = [];
    behaviour = async (ctx, run) => {
      if (run !== "A/ticker/refresh") return;
      seen.push((await ctx.fetch("https://feeds.example.com/headlines.json")).status);
      seen.push(await ctx.fetch("https://elsewhere.example.com/").catch((error: unknown) => (error as FetchError).code));
    };
    scheduler().start();
    await settle();
    expect(seen).toEqual([200, "refused"]);
    expect(requests.map((request) => [request.url, request.headers["user-agent"]])).toEqual([
      ["https://feeds.example.com/headlines.json", "Hearth"],
    ]);
  });
});
