/**
 * A job's two routes (docs/mini-app-contract.md, section C, "Routes"):
 * `GET /api/spaces/:spaceId/apps/:appId/jobs/:job`, how the job's runs went,
 * for anyone who can see the app, and `POST .../jobs/:job/run`, a run asked
 * for now, with edit access and at most one every 5 minutes. No scheduler
 * runs here: a run is claimed and recorded with jobs.ts's own functions,
 * and the scheduler's wake is counted. The time of day is set by the test.
 */
import { defineApp } from "@hearth/sdk";
import { defineServer, z } from "@hearth/sdk/server";
import { apiErrorSchema, jobStatusSchema, type ApiErrorCode, type JobStatus } from "@hearth/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { as, testApp, testConfig } from "../testing";
import { removeApp } from "./installs";
import { claimRun, recordRun, type Claim } from "./jobs";
import { createRegistry, type BundledApp, type Registry } from "./registry";
import { APPS, family, grant, install, KIM, LIN, NOA, SAM } from "./test-world";

/* -------------------------------------------------------------------------
 * A sample app with a query, a mutation and a job
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
const ticker = defineServer(tickerManifest, { items: z.object({ text: z.string().max(200) }) });
const TICKER: BundledApp = {
  id: "ticker",
  manifest: tickerManifest,
  hasPage: false,
  server: ticker.routes({
    latest: ticker.query({ description: "Lists the headlines kept, oldest first." }, (ctx) => ctx.db.items.list()),
    clear: ticker.mutation({ description: "Deletes every headline kept." }, (ctx) => ctx.db.items.removeWhere({})),
    refresh: ticker.job({ description: "Keeps the latest headlines of the feed, every hour.", everyMinutes: 60 }, () => {}),
  }),
};
const ALL_APPS: readonly BundledApp[] = [...APPS, TICKER];

/* -------------------------------------------------------------------------
 * The world: a family with the ticker in it, and the time of day
 * ---------------------------------------------------------------------- */

const BASE = "http://hearth.example.com";
const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const START = Date.parse("2026-03-01T13:05:00.000Z");
const at = (ms: number) => new Date(START + ms);
const iso = (ms: number) => at(ms).toISOString();
/** Sets the time of day the routes see, `ms` after START. */
const setTime = (ms: number) => vi.setSystemTime(at(ms));

let world: ReturnType<typeof family>;
let registry: Registry;
let app: ReturnType<typeof testApp>["app"];
let errors: unknown[];
/** How often the routes woke the scheduler. */
let wakes: number;

/** A server over the same database holding the given apps, with the given settings. */
function serverWith(apps: readonly BundledApp[], config = testConfig()) {
  return testApp({ db: world.db, apps, config, wakeJobs: () => (wakes += 1) });
}

beforeEach(() => {
  // Only Date: the routes read the time of day, and nothing here waits.
  vi.useFakeTimers({ toFake: ["Date"], now: START });
  world = family();
  registry = createRegistry(ALL_APPS);
  wakes = 0;
  ({ app, errors } = serverWith(ALL_APPS));
  // Sam added the ticker to the family, for every member to view, and Lin has it in her own space.
  install(world.db, world.family, "ticker", world.sam.id, { memberAccess: "view" });
  install(world.db, world.linsSpace, "ticker", world.lin.id);
});

afterEach(() => {
  vi.useRealTimers();
});

function call(who: string | null, method: string, path: string, headers: Record<string, string> = {}, on = app) {
  return on.request(`${BASE}${path}`, { method, headers: who ? as(who, headers) : headers });
}

const address = (spaceId: string, job: string, appId: string) => `/api/spaces/${spaceId}/apps/${appId}/jobs/${job}`;
/** GET the status of a job. */
const statusOf = (who: string | null, spaceId = world.family, job = "refresh", appId = "ticker", on = app) =>
  call(who, "GET", address(spaceId, job, appId), {}, on);
/** POST to ask for a run. */
const ask = (who: string | null, spaceId = world.family, job = "refresh", appId = "ticker", on = app) =>
  call(who, "POST", `${address(spaceId, job, appId)}/run`, {}, on);

/** The status an answer carries. Strict, so that nothing beyond the contract's fields gets out. */
async function statusIn(response: Response, status = 200): Promise<JobStatus> {
  expect(response.status).toBe(status);
  expect(response.headers.get("content-type")).toContain("application/json");
  return jobStatusSchema.strict().parse(await response.json());
}

async function expectError(response: Response, status: number, code: ApiErrorCode): Promise<void> {
  expect(response.status).toBe(status);
  expect(apiErrorSchema.parse(await response.json()).error.code).toBe(code);
}

/** The job's row, as the database has it. */
const rows = () => world.db.prepare("SELECT * FROM app_jobs ORDER BY space_id, app_id, job").all();

/** A run of the family's ticker that starts `ms` after START. */
function claim(ms: number, options: { force?: boolean } = {}): Claim {
  const taken = claimRun(world.db, registry, { spaceId: world.family, appId: "ticker", job: "refresh" }, { now: at(ms), ...options });
  if (typeof taken === "string") throw new Error(`No claim was taken: ${taken}.`);
  return taken;
}

const NOT_RUN: JobStatus = {
  lastStartedAt: null,
  lastSucceededAt: null,
  lastFailedAt: null,
  lastError: null,
  nextRunAt: iso(0),
  state: "idle",
};

/** Who asks about which app and job in which space; made when the test runs, once the world exists. */
const target = (request: () => [who: string, spaceId: string, job: string, appId: string]) => request;

/* -------------------------------------------------------------------------
 * The status
 * ---------------------------------------------------------------------- */

describe("a job's status", () => {
  it("answers anyone who can see the app; a job that has not run here has nothing yet, is due now and idle", async () => {
    for (const who of [SAM, LIN, KIM]) expect(await statusIn(await statusOf(who))).toEqual(NOT_RUN);
    expect(await statusIn(await statusOf(LIN, world.linsSpace))).toEqual(NOT_RUN);
    // Reading makes no row.
    expect(rows()).toEqual([]);
  });

  it("says when the runs started, went well and went wrong, why, when the next is, and whether one is going on", async () => {
    recordRun(world.db, claim(0), { kind: "succeeded" }, { now: at(20 * SECOND), random: () => 0 });
    setTime(30 * SECOND);
    expect(await statusIn(await statusOf(LIN))).toEqual({
      lastStartedAt: iso(0),
      lastSucceededAt: iso(20 * SECOND),
      lastFailedAt: null,
      lastError: null,
      nextRunAt: iso(60 * MINUTE),
      state: "idle",
    });

    const failing = claim(60 * MINUTE);
    setTime(60 * MINUTE + SECOND);
    expect(await statusIn(await statusOf(LIN))).toMatchObject({ lastStartedAt: iso(60 * MINUTE), state: "running" });
    const failure = new Error("The feed answered 500.");
    recordRun(world.db, failing, { kind: "failed", error: failure.message, cause: failure }, { now: at(61 * MINUTE), random: () => 0 });
    setTime(62 * MINUTE);
    expect(await statusIn(await statusOf(LIN))).toEqual({
      lastStartedAt: iso(60 * MINUTE),
      lastSucceededAt: iso(20 * SECOND),
      lastFailedAt: iso(61 * MINUTE),
      lastError: "The feed answered 500.",
      nextRunAt: iso(66 * MINUTE),
      state: "idle",
    });
  });

  it("is the status of the app in that space only", async () => {
    recordRun(world.db, claim(0), { kind: "succeeded" }, { now: at(20 * SECOND), random: () => 0 });
    expect(await statusIn(await statusOf(LIN, world.linsSpace))).toEqual(NOT_RUN);
  });
});

/* -------------------------------------------------------------------------
 * Asking for a run
 * ---------------------------------------------------------------------- */

describe("asking for a run", () => {
  it("needs edit access, answers 202 with the status, and wakes the scheduler", async () => {
    expect(await statusIn(await ask(SAM), 202)).toEqual({ ...NOT_RUN, state: "requested" });
    expect(wakes).toBe(1);
    expect(rows()).toMatchObject([{ space_id: world.family, job: "refresh", requested_at: iso(0), next_run_at: iso(0), run_id: null }]);
    // Anyone who reads the status now sees the run asked for.
    expect(await statusIn(await statusOf(LIN))).toMatchObject({ state: "requested" });

    // A member with an exception for edit, and Lin in her own space.
    grant(world.db, world.family, "ticker", world.kim.id, "edit", world.sam.id);
    expect(await statusIn(await ask(KIM), 202)).toMatchObject({ state: "requested" });
    expect(await statusIn(await ask(LIN, world.linsSpace), 202)).toMatchObject({ state: "requested" });
    expect(wakes).toBe(3);
  });

  it("is refused with view access, and nothing changes", async () => {
    await expectError(await ask(LIN), 403, "forbidden");
    await expectError(await ask(KIM), 403, "forbidden");
    expect(rows()).toEqual([]);
    expect(wakes).toBe(0);
  });

  it("starts a run at once or 5 minutes after the last one started, never sooner, however often it is asked", async () => {
    recordRun(world.db, claim(0), { kind: "succeeded" }, { now: at(20 * SECOND), random: () => 0 });
    for (const minute of [1, 2, 4]) {
      setTime(minute * MINUTE);
      expect(await statusIn(await ask(SAM), 202)).toMatchObject({ nextRunAt: iso(5 * MINUTE), state: "requested" });
    }
    expect(await statusIn(await statusOf(LIN))).toMatchObject({ nextRunAt: iso(5 * MINUTE), state: "requested" });
    // The scheduler finds it due no sooner.
    expect(claimRun(world.db, registry, { spaceId: world.family, appId: "ticker", job: "refresh" }, { now: at(5 * MINUTE - 1) })).toBe(
      "not_due",
    );
    const asked = claim(5 * MINUTE);
    recordRun(world.db, asked, { kind: "succeeded" }, { now: at(5 * MINUTE + 20 * SECOND), random: () => 0 });

    // Five minutes after that run started, a run asked for starts at once.
    setTime(10 * MINUTE);
    expect(await statusIn(await ask(SAM), 202)).toMatchObject({ nextRunAt: iso(10 * MINUTE), state: "requested" });
  });

  it("changes nothing during a run, and leaves the scheduler alone", async () => {
    claim(0);
    const held = rows();
    setTime(MINUTE);
    expect(await statusIn(await ask(SAM), 202)).toMatchObject({ lastStartedAt: iso(0), nextRunAt: iso(0), state: "running" });
    expect(rows()).toEqual(held);
    expect(wakes).toBe(0);
  });

  it("lets a run asked for start 5 seconds after the last one where stand-ins answer every fetch", async () => {
    const withStandIns = serverWith(ALL_APPS, testConfig({ fetchStandIns: "/nonexistent/stand-ins.json" }));
    recordRun(world.db, claim(0), { kind: "succeeded" }, { now: at(SECOND), random: () => 0 });
    setTime(2 * SECOND);
    expect(await statusIn(await ask(SAM, world.family, "refresh", "ticker", withStandIns.app), 202)).toMatchObject({
      nextRunAt: iso(5 * SECOND),
      state: "requested",
    });
    // A server that fetches from the hosts themselves keeps to its 5 minutes.
    recordRun(world.db, claim(5 * SECOND), { kind: "succeeded" }, { now: at(6 * SECOND), random: () => 0 });
    setTime(7 * SECOND);
    expect(await statusIn(await ask(SAM), 202)).toMatchObject({ nextRunAt: iso(5 * SECOND + 5 * MINUTE) });
  });

  it("takes no body: one that is sent is not read, as for the request that removes an app", async () => {
    const response = await app.request(`${BASE}${address(world.family, "refresh", "ticker")}/run`, {
      method: "POST",
      headers: as(SAM, { "content-type": "application/json" }),
      body: JSON.stringify({ force: true, at: "2026-01-01T00:00:00.000Z" }),
    });
    expect(await statusIn(response, 202)).toEqual({ ...NOT_RUN, state: "requested" });
  });

  it("is refused from another site, and nothing changes", async () => {
    const crossSite = await call(SAM, "POST", `${address(world.family, "refresh", "ticker")}/run`, {
      origin: "https://evil.example.net",
    });
    await expectError(crossSite, 403, "invalid_request");
    expect(rows()).toEqual([]);
    expect(wakes).toBe(0);
  });
});

/* -------------------------------------------------------------------------
 * What is not there
 * ---------------------------------------------------------------------- */

describe("a job that is not there for the caller", () => {
  it.each([
    ["someone who is not in the space", target(() => [NOA, world.family, "refresh", "ticker"])],
    ["a member the app is hidden from", target(() => [LIN, world.family, "refresh", "ticker"])],
    ["a job the app does not have", target(() => [SAM, world.family, "nothing", "ticker"])],
    ["a name that only looks like one", target(() => [SAM, world.family, "constructor", "ticker"])],
    ["the name of a query", target(() => [SAM, world.family, "latest", "ticker"])],
    ["the name of a mutation", target(() => [SAM, world.family, "clear", "ticker"])],
    ["an app without a server file", target(() => [SAM, world.family, "refresh", "feed"])],
    ["an app the space does not have", target(() => [SAM, world.samsSpace, "refresh", "ticker"])],
    ["an app the server does not hold", target(() => [SAM, world.family, "refresh", "nothing"])],
    ["a space that does not exist", target(() => [SAM, "nowhere", "refresh", "ticker"])],
  ] as const)("answers 404 to the status and to a run for %s, and changes nothing", async (_label, request) => {
    grant(world.db, world.family, "ticker", world.lin.id, "none", world.sam.id);
    install(world.db, world.family, "feed", world.sam.id);
    const [who, spaceId, job, appId] = request();
    await expectError(await statusOf(who, spaceId, job, appId), 404, "not_found");
    await expectError(await ask(who, spaceId, job, appId), 404, "not_found");
    expect(rows()).toEqual([]);
    expect(wakes).toBe(0);
  });

  it("answers 404 before 403: someone who may only view learns nothing of a name that is no job", async () => {
    for (const job of ["nothing", "latest", "clear"]) await expectError(await ask(LIN, world.family, job), 404, "not_found");
    await expectError(await ask(LIN, world.family, "refresh"), 403, "forbidden");
  });

  it("answers 404 for an app that was removed from the space, to its owner too, and keeps its status", async () => {
    recordRun(world.db, claim(0), { kind: "succeeded" }, { now: at(SECOND), random: () => 0 });
    const kept = rows();
    removeApp(world.db, registry, { userId: world.sam.id, spaceId: world.family, appId: "ticker" });
    await expectError(await statusOf(SAM), 404, "not_found");
    await expectError(await ask(SAM), 404, "not_found");
    expect(rows()).toEqual(kept);
  });

  it("answers 404 for an app whose code the server no longer holds", async () => {
    const without = serverWith(APPS);
    await expectError(await statusOf(SAM, world.family, "refresh", "ticker", without.app), 404, "not_found");
    await expectError(await ask(SAM, world.family, "refresh", "ticker", without.app), 404, "not_found");
    expect(rows()).toEqual([]);
  });

  it("needs sign-in, and someone on the server", async () => {
    await expectError(await statusOf(null), 401, "unauthenticated");
    await expectError(await ask(null), 401, "unauthenticated");
    await expectError(await statusOf("stranger@example.com"), 403, "not_a_member");
    await expectError(await ask("stranger@example.com"), 403, "not_a_member");
    expect(rows()).toEqual([]);
  });

  it.each([
    ["POST", ""],
    ["PUT", ""],
    ["PATCH", ""],
    ["DELETE", ""],
    ["GET", "/run"],
    ["PUT", "/run"],
    ["DELETE", "/run"],
    ["POST", "/run/again"],
  ])("answers 404 to %s on the address%s", async (method, rest) => {
    await expectError(await call(SAM, method, `${address(world.family, "refresh", "ticker")}${rest}`), 404, "not_found");
    expect(rows()).toEqual([]);
  });

  it("answers 404 to the list of jobs, which has no address", async () => {
    await expectError(await call(SAM, "GET", `/api/spaces/${world.family}/apps/ticker/jobs`), 404, "not_found");
  });

  it("logs nothing for what it turns down", async () => {
    await ask(LIN);
    await statusOf(NOA);
    await ask(SAM, world.family, "latest");
    expect(errors).toEqual([]);
  });
});
