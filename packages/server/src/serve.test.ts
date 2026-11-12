/**
 * The server as a process runs it (src/serve.ts): what HEARTH_JOBS and
 * HEARTH_FETCH_STANDINS decide, the routes that wake the scheduler, a stop
 * that ends the run going on before the database is closed, and a whole
 * process, as main.ts starts one.
 *
 * The scheduler's clock moves only when told, so a job runs only when
 * something wakes the scheduler. The jobs' requests are answered by a file
 * of stand-ins, and the global fetch answers this machine alone: a request
 * that would leave it is refused and counted, so nothing reaches a network
 * whatever the wiring does.
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, connect } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineApp } from "@hearth/sdk";
import { defineServer, FetchError, z } from "@hearth/sdk/server";
import type { JobStatus, Session } from "@hearth/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BundledApp } from "./apps/registry";
import { fakeClock } from "./apps/test-clock";
import type { Config } from "./config";
import { migrate, openDatabase, type Db } from "./db/database";
import { startServer, STOP_LIMIT_MS, unhandledRejectionLine, type RunningServer } from "./serve";
import { FIXTURE_APPS, OWNER_EMAIL, testConfig } from "./testing";

const PACKAGE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FEED = "https://feeds.example.com/headlines.json";

/** A made-up app whose job never ends, so that a stop finds a run going on. */
const sleeperManifest = defineApp({
  id: "sleeper",
  name: { en: "Sleeper", zh: "沉睡" },
  description: { en: "Runs a job that never ends.", zh: "运行一个永不结束的任务。" },
  icon: "file-text",
  color: "teal",
  widget: { size: "small" },
});
const sleeper = defineServer(sleeperManifest, { items: z.object({ text: z.string() }) });
const SLEEPER: BundledApp = {
  id: "sleeper",
  manifest: sleeperManifest,
  hasPage: false,
  server: sleeper.routes({
    nap: sleeper.job({ description: "Waits for ever, every hour.", everyMinutes: 60 }, () => new Promise<void>(() => {})),
  }),
};
const APPS = [...FIXTURE_APPS, SLEEPER];

let folder: string;
let file: string;
let standIns: string;
let db: Db;
let lines: string[];
let fake: ReturnType<typeof fakeClock>;
let running: RunningServer | null;
let base: string;
/** Every request that would have left this machine: none may. */
let outside: string[];
const realFetch = globalThis.fetch;

beforeEach(() => {
  folder = mkdtempSync(path.join(tmpdir(), "hearth-serve-"));
  mkdirSync(path.join(folder, "web"));
  writeFileSync(path.join(folder, "web", "index.html"), "<!doctype html><title>Hearth</title>");
  file = path.join(folder, "hearth.db");
  standIns = path.join(folder, "stand-ins.json");
  writeFileSync(standIns, JSON.stringify([{ url: FEED, body: { items: [{ title: "Rain expected" }, { title: "Market opens" }] } }]));
  db = openDatabase(file);
  migrate(db);
  lines = [];
  fake = fakeClock();
  running = null;
  outside = [];
  vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname === "127.0.0.1") return realFetch(input, init);
    outside.push(url.href);
    return Promise.reject(new TypeError("fetch failed: these tests reach no network"));
  });
});

afterEach(async () => {
  await running?.stop();
  vi.unstubAllGlobals();
  if (db.open) db.close();
  rmSync(folder, { recursive: true, force: true });
  expect(outside).toEqual([]);
});

/** A server on this machine, at a port of its own, signed in as the owner. */
async function start(overrides: Partial<Config> = {}): Promise<RunningServer> {
  const config = testConfig({
    port: 0,
    dbPath: file,
    webDist: path.join(folder, "web"),
    auth: { mode: "dev", devUser: OWNER_EMAIL },
    jobs: "on",
    fetchStandIns: standIns,
    ...overrides,
  });
  const log = (kind: string) => (line: string) => void lines.push(`${kind}: ${line}`);
  running = startServer({ config, db, apps: APPS, clock: fake.clock, log: { info: log("info"), warn: log("warn"), error: log("error") } });
  const { port } = await running.listening;
  base = `http://127.0.0.1:${port}`;
  return running;
}

async function call<T>(method: string, address: string, body?: unknown): Promise<{ status: number; body: T }> {
  const response = await realFetch(`${base}${address}`, {
    method,
    headers: body === undefined ? { origin: base } : { origin: base, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: (text === "" ? null : JSON.parse(text)) as T };
}

/** The owner's personal space, where the tests add apps. */
async function personalSpace(): Promise<string> {
  const session = (await call<Session>("GET", "/api/session")).body;
  const own = session.spaces.find((space) => space.kind === "personal");
  if (own === undefined) throw new Error("The owner has no personal space.");
  return own.id;
}

const statusOf = async (spaceId: string, appId: string, job: string) =>
  (await call<JobStatus>("GET", `/api/spaces/${spaceId}/apps/${appId}/jobs/${job}`)).body;

/** Waits, in real time, for what a run leaves; the scheduler's own clock does not move meanwhile. */
const soon = { timeout: 5_000, interval: 20 };

describe("HEARTH_JOBS", () => {
  it("off: no scheduler, and adding an app with a job runs nothing, as in the deploy's trial start", async () => {
    const server = await start({ jobs: "off", fetchStandIns: null });
    expect(server.scheduler).toBeNull();
    expect(lines).toContain("info: Jobs are switched off (HEARTH_JOBS=off): no mini-app's job runs, and none fetches anything.");

    const spaceId = await personalSpace();
    expect((await call("PUT", `/api/spaces/${spaceId}/apps/headlines`, {})).status).toBe(204);
    // Time enough for a woken scheduler to have run it, had there been one.
    await new Promise((resolve) => setTimeout(resolve, 300));
    await fake.advance(60 * 60_000);
    expect(await statusOf(spaceId, "headlines", "refresh")).toMatchObject({ lastStartedAt: null, state: "idle" });
    expect(db.prepare("SELECT count(*) AS n FROM app_jobs").get()).toEqual({ n: 0 });
  });

  it("on: a scheduler, which starts once the server listens", async () => {
    const server = await start();
    expect(server.scheduler).not.toBeNull();
    expect(lines.filter((line) => line.includes("Jobs are switched off"))).toEqual([]);
    expect(lines).toContain(
      `warn: Jobs reach no network (HEARTH_FETCH_STANDINS): every ctx.fetch is answered from the stand-ins in ${standIns}. This is for end-to-end tests only.`,
    );
  });
});

describe("the way out and the wake", () => {
  it("answers a job's requests from the stand-in file, and the route that adds an app wakes the scheduler", async () => {
    await start();
    const spaceId = await personalSpace();
    // The scheduler has found nothing to run and sleeps on a clock that does not move: only a wake runs the job now.
    expect((await call("PUT", `/api/spaces/${spaceId}/apps/headlines`, {})).status).toBe(204);
    await vi.waitFor(async () => expect((await statusOf(spaceId, "headlines", "refresh")).lastSucceededAt).not.toBeNull(), soon);
    const latest = await call<{ output: { title: string }[] }>("POST", `/api/spaces/${spaceId}/apps/headlines/q/latest`, {});
    expect(latest.body.output.map((row) => row.title)).toEqual(["Rain expected", "Market opens"]);
    expect(lines.filter((line) => line.startsWith("error:"))).toEqual([]);
  });

  it("wakes the scheduler for a run someone asks for", async () => {
    await start();
    const spaceId = await personalSpace();
    await call("PUT", `/api/spaces/${spaceId}/apps/headlines`, {});
    await vi.waitFor(async () => expect((await statusOf(spaceId, "headlines", "refresh")).lastSucceededAt).not.toBeNull(), soon);
    // As if that run had been an hour ago: the next is due in an hour, and one asked for may start at once.
    const hourAgo = new Date(Date.now() - 60 * 60_000).toISOString();
    db.prepare("UPDATE app_jobs SET last_started_at = ?, next_run_at = ? WHERE app_id = 'headlines'").run(
      hourAgo,
      new Date(Date.now() + 60 * 60_000).toISOString(),
    );
    const asked = await call<JobStatus>("POST", `/api/spaces/${spaceId}/apps/headlines/jobs/refresh/run`);
    expect(asked).toMatchObject({ status: 202, body: { state: "requested" } });
    await vi.waitFor(async () => expect((await statusOf(spaceId, "headlines", "refresh")).lastStartedAt).not.toBe(hourAgo), soon);
    await vi.waitFor(async () => expect((await statusOf(spaceId, "headlines", "refresh")).state).toBe("idle"), soon);
  });

  it("without stand-ins, goes to the network, which here refuses: nothing is answered from a file", async () => {
    await start({ fetchStandIns: null });
    const spaceId = await personalSpace();
    await call("PUT", `/api/spaces/${spaceId}/apps/headlines`, {});
    await vi.waitFor(async () => expect((await statusOf(spaceId, "headlines", "refresh")).lastFailedAt).not.toBeNull(), soon);
    // The one request went to the global fetch, which these tests refuse for every host but this machine.
    expect(outside).toEqual([FEED]);
    outside = [];
    expect(lines).toEqual(expect.arrayContaining([expect.stringMatching(/^error: App "headlines", job "refresh", space .*: the run failed: Could not reach feeds\.example\.com/)]));
  });
});

describe("stopping", () => {
  it("ends the run going on as stopped, stops listening, then closes the database", async () => {
    const server = await start();
    const spaceId = await personalSpace();
    await call("PUT", `/api/spaces/${spaceId}/apps/sleeper`, {});
    await vi.waitFor(async () => expect((await statusOf(spaceId, "sleeper", "nap")).state).toBe("running"), soon);

    const before = Date.now();
    await server.stop();
    expect(db.open).toBe(false);
    await expect(realFetch(`${base}/api/health`)).rejects.toThrow();
    // Recorded as stopped: nothing kept of how it went, and due again at once, at the next start.
    const again = openDatabase(file);
    try {
      const row = again.prepare("SELECT run_id, run_until, last_succeeded_at, last_failed_at, failures, next_run_at FROM app_jobs WHERE app_id = 'sleeper'").get() as {
        next_run_at: string;
      };
      expect(row).toMatchObject({ run_id: null, run_until: null, last_succeeded_at: null, last_failed_at: null, failures: 0 });
      expect(Date.parse(row.next_run_at)).toBeGreaterThanOrEqual(before - 1000);
      expect(Date.parse(row.next_run_at)).toBeLessThanOrEqual(Date.now());
    } finally {
      again.close();
    }
    // Stopping again changes nothing.
    await server.stop();
  });

  it("closes the database within 5 seconds whatever holds things up", async () => {
    const server = await start({ jobs: "off", fetchStandIns: null });
    // A request whose body never ends keeps its connection open: the server cannot finish closing.
    const socket = connect(Number(new URL(base).port), "127.0.0.1");
    await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
    socket.write(`PATCH /api/me HTTP/1.1\r\nHost: ${new URL(base).host}\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{"theme":`);
    await new Promise((resolve) => setTimeout(resolve, 100));
    try {
      let stopped = false;
      const stopping = server.stop().then(() => (stopped = true));
      await new Promise((resolve) => setTimeout(resolve, 200));
      await fake.advance(STOP_LIMIT_MS - 1);
      expect(stopped).toBe(false);
      expect(db.open).toBe(true);
      await fake.advance(1);
      await stopping;
      expect(db.open).toBe(false);
    } finally {
      socket.destroy();
    }
  });
});

describe("what is left behind", () => {
  it("logs a rejection that nothing handled on one line, a job's request apart", () => {
    expect(unhandledRejectionLine(new FetchError("stopped", "The run is over, so ctx.fetch gave up on https://feeds.example.com/week.json."))).toBe(
      "A job left behind a request of ctx.fetch that nothing waited for (stopped): The run is over, so ctx.fetch gave up on https://feeds.example.com/week.json.",
    );
    const line = unhandledRejectionLine(new Error("Something\n  broke."));
    expect(line).toMatch(/^A rejected promise was left that nothing handled; the server goes on: Error: Something broke\. at /);
    expect(line).not.toContain("\n");
    expect(unhandledRejectionLine("plain text")).toBe("A rejected promise was left that nothing handled; the server goes on: plain text");
  });
});

/* -------------------------------------------------------------------------
 * A whole process, as main.ts starts one
 * ---------------------------------------------------------------------- */

/** A port nothing listens on at the moment. */
async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", () => resolve()));
  const address = probe.address();
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  if (address === null || typeof address === "string") throw new Error("No port was given.");
  return address.port;
}

describe("a server process", () => {
  it(
    "logs a rejection a job left behind and goes on serving, then ends with status 0 on SIGTERM, its database closed",
    async () => {
      const port = await freePort();
      base = `http://127.0.0.1:${port}`;
      db.close();
      // test-process.ts starts the process with a made-up app whose job leaves a promise of ctx.fetch behind (see there).
      const child = spawn(process.execPath, ["--import", "tsx", "src/test-process.ts"], {
        cwd: PACKAGE,
        env: {
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? "",
          HOST: "127.0.0.1",
          PORT: String(port),
          HEARTH_AUTH: "dev",
          HEARTH_OWNER_EMAIL: OWNER_EMAIL,
          HEARTH_DB: file,
          HEARTH_WEB_DIST: path.join(folder, "web"),
          HEARTH_JOBS: "on",
          HEARTH_FETCH_STANDINS: standIns,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
      child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
      const ended = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
      try {
        await vi.waitFor(() => expect(output).toContain(`is listening on ${base}`), { timeout: 30_000, interval: 50 });
        const spaceId = await personalSpace();
        expect((await call("PUT", `/api/spaces/${spaceId}/apps/leaver`, {})).status).toBe(204);
        // The run fails, and the request its job made and left behind is called off: nothing handles that.
        await vi.waitFor(
          () =>
            expect(output).toContain(
              "A job left behind a request of ctx.fetch that nothing waited for (stopped): The run is over, so ctx.fetch gave up on https://feeds.example.com/week.json.",
            ),
          { timeout: 10_000, interval: 50 },
        );
        expect(output).toMatch(/App "leaver", job "refresh", space .*: the run failed: The day's feed is down\./);
        // It goes on serving.
        await new Promise((resolve) => setTimeout(resolve, 200));
        expect((await call<{ ok: boolean }>("GET", "/api/health")).body).toMatchObject({ ok: true });
        expect(child.exitCode).toBeNull();
      } finally {
        child.kill("SIGTERM");
      }
      expect(await ended).toBe(0);
      const again = openDatabase(file);
      try {
        expect(again.prepare("SELECT last_failed_at IS NOT NULL AS failed, run_id FROM app_jobs WHERE app_id = 'leaver'").get()).toEqual({
          failed: 1,
          run_id: null,
        });
      } finally {
        again.close();
      }
    },
    60_000,
  );
});
