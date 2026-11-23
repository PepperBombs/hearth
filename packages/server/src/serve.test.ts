/**
 * The server as a process runs it (src/serve.ts): the built-in apps brought
 * up to date and the installs of the apps of releases before them moved at
 * start-up, what HEARTH_FETCH_STANDINS decides for the apps' fetches, a
 * server that cannot listen, a stop that closes the database, and a whole
 * process, as main.ts starts one.
 *
 * The apps' requests are answered by a file of stand-ins, and the global
 * fetch answers this machine alone: a request that would leave it is
 * refused and counted, so nothing reaches a network whatever the wiring
 * does.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer, connect, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Session } from "@hearth/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FetchError } from "./apps/fetch";
import { fakeClock } from "./apps/test-clock";
import { install, NOW } from "./apps/test-world";
import type { Config } from "./config";
import { migrate, openDatabase, type Db } from "./db/database";
import { createUserWithPersonalSpace } from "./db/people";
import { startServer, STOP_LIMIT_MS, unhandledRejectionLine, type RunningServer } from "./serve";
import { OWNER_EMAIL, testConfig } from "./testing";

const PACKAGE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SEARCH = "https://api.github.com/search/repositories";

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
  writeFileSync(standIns, JSON.stringify([{ url: SEARCH, body: { items: [{ full_name: "sample/one" }, { full_name: "sample/two" }] } }]));
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

/**
 * A server on this machine, at a port of its own unless one is given,
 * signed in as the owner, its apps answered from the stand-in file unless
 * the overrides say otherwise: started, and not listening yet.
 */
function launch(overrides: Partial<Config> = {}): RunningServer {
  const config = testConfig({
    port: 0,
    dbPath: file,
    webDist: path.join(folder, "web"),
    auth: { mode: "dev", devUser: OWNER_EMAIL },
    fetchStandIns: standIns,
    ...overrides,
  });
  const log = (kind: string) => (line: string) => void lines.push(`${kind}: ${line}`);
  running = startServer({ config, db, clock: fake.clock, log: { info: log("info"), warn: log("warn"), error: log("error") } });
  return running;
}

/** Waits for a server to listen, and sends the tests' requests to it from then on. */
async function listened(server: RunningServer): Promise<RunningServer> {
  const { port } = await server.listening;
  base = `http://127.0.0.1:${port}`;
  return server;
}

/** A server on this machine, as `launch` makes it, once it listens. */
const start = (overrides: Partial<Config> = {}): Promise<RunningServer> => listened(launch(overrides));

async function call<T>(method: string, address: string, body?: unknown): Promise<{ status: number; body: T }> {
  const response = await realFetch(`${base}${address}`, {
    method,
    headers: body === undefined ? { origin: base } : { origin: base, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: (text === "" ? null : JSON.parse(text)) as T };
}

/** The owner's personal space. */
async function personalSpace(): Promise<string> {
  const session = (await call<Session>("GET", "/api/session")).body;
  const own = session.spaces.find((space) => space.kind === "personal");
  if (own === undefined) throw new Error("The owner has no personal space.");
  return own.id;
}

/** GitHub Trending, a built-in app that names a host, added to the owner's own space; its address. */
async function trending(): Promise<string> {
  const spaceId = await personalSpace();
  const added = await call<{ appId: string }>("POST", `/api/spaces/${spaceId}/catalog/trending`, {});
  expect(added.status).toBe(201);
  return `/api/spaces/${spaceId}/apps/${added.body.appId}`;
}

type Fetched = { ok: boolean; status: number; text: string } | { error: { code: string; message: string } };

describe("starting", () => {
  it("listens on this machine, and says that sign-in is off and that apps reach no network", async () => {
    const server = launch();
    await listened(server);
    expect(lines).toContain(`info: Hearth test is listening on ${base}`);
    expect(lines).toContain(
      `warn: Sign-in is switched off (HEARTH_AUTH=dev): every request is treated as ${OWNER_EMAIL}. Never use this on a server.`,
    );
    expect(lines).toContain(
      `warn: Apps reach no network (HEARTH_FETCH_STANDINS): every fetch of an app is answered from the stand-ins in ${standIns}. This is for end-to-end tests only.`,
    );
    expect((await call<{ ok: boolean }>("GET", "/api/health")).body).toEqual({ ok: true, version: "test" });
  });

  it("moves the installs a release before the built-in apps left to them, once, and says so", async () => {
    const owner = createUserWithPersonalSpace(db, { email: OWNER_EMAIL, locale: "en" });
    const { id: spaceId } = db.prepare("SELECT id FROM spaces WHERE created_by = ?").get(owner.id) as { id: string };
    install(db, spaceId, "grocery", owner.id);
    db.prepare(
      `INSERT INTO app_rows (id, space_id, app_id, collection, data, created_by, updated_by, created_at, updated_at)
       VALUES ('r-milk', ?, 'grocery', 'items', '{"name":"Milk","aisle":"","done":false}', ?, ?, ?, ?)`,
    ).run(spaceId, owner.id, owner.id, NOW, NOW);
    // An install whose row the built-in app would not take stays as it was, and that is said too.
    install(db, spaceId, "ideas", owner.id);
    db.prepare(
      `INSERT INTO app_rows (id, space_id, app_id, collection, data, created_by, updated_by, created_at, updated_at)
       VALUES ('r-odd', ?, 'ideas', 'ideas', '{"words":"not an idea"}', ?, ?, ?, ?)`,
    ).run(spaceId, owner.id, owner.id, NOW, NOW);

    await start();
    const moved = lines.filter((line) => line.startsWith("info: Moved the app"));
    expect(moved).toEqual([expect.stringMatching(new RegExp(`^info: Moved the app "grocery" of space ${spaceId} to the built-in app \\(m-[a-z0-9]{10}\\)\\.$`))]);
    expect(lines).toContainEqual(expect.stringMatching(new RegExp(`^error: Could not move the app "ideas" of space ${spaceId}: `)));
    const session = (await call<Session>("GET", "/api/session")).body;
    expect(session.apps).toEqual([expect.objectContaining({ spaceId, made: true, template: "grocery" })]);
    const rows = await call<{ rows: { name: string }[] }>("GET", `/api/spaces/${spaceId}/apps/${session.apps[0]!.id}/rows/items`);
    expect(rows.body.rows.map((row) => row.name)).toEqual(["Milk"]);
  });

  it("cannot listen where something else does: the start fails, and a stop closes the database all the same", async () => {
    // Something else listens on the port already.
    const taken = createServer();
    await new Promise<void>((resolve) => taken.listen(0, "127.0.0.1", () => resolve()));
    try {
      const server = launch({ port: (taken.address() as AddressInfo).port });
      await expect(server.listening).rejects.toMatchObject({ code: "EADDRINUSE" });
      expect(lines.filter((line) => line.includes("is listening"))).toEqual([]);
      await server.stop();
      expect(db.open).toBe(false);
    } finally {
      await new Promise<void>((resolve) => taken.close(() => resolve()));
    }
  });
});

describe("the apps' way out", () => {
  it("answers an app's fetch from the stand-in file", async () => {
    await start();
    const app = await trending();
    const fetched = await call<Fetched>("POST", `${app}/fetch`, { url: `${SEARCH}?q=stars`, headers: { accept: "application/json" } });
    expect(fetched).toMatchObject({ status: 200, body: { ok: true, status: 200 } });
    expect(JSON.parse((fetched.body as { text: string }).text)).toEqual({ items: [{ full_name: "sample/one" }, { full_name: "sample/two" }] });
    expect(lines.filter((line) => line.startsWith("error:"))).toEqual([]);
  });

  it("without stand-ins, goes to the network, which here refuses: nothing is answered from a file", async () => {
    await start({ fetchStandIns: null });
    expect(lines.filter((line) => line.includes("reach no network"))).toEqual([]);
    const app = await trending();
    const fetched = await call<Fetched>("POST", `${app}/fetch`, { url: `${SEARCH}?q=stars` });
    expect(fetched).toMatchObject({ status: 502, body: { error: { code: "network" } } });
    // The one request went to the global fetch, which these tests refuse for every host but this machine.
    expect(outside).toEqual([`${SEARCH}?q=stars`]);
    outside = [];
  });

  it("without stand-ins, reads a real answer of Node's fetch while the server listens", async () => {
    // The host, on this machine. Its answer comes from Node's own fetch: no test's "new Response" stands for it.
    const host = createHttpServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ items: [{ full_name: "sample/real" }] }));
    });
    await new Promise<void>((resolve) => host.listen(0, "127.0.0.1", () => resolve()));
    const hostAt = `http://127.0.0.1:${(host.address() as AddressInfo).port}/search/repositories`;
    // The search's address leads there, with everything else Node's transport asked for; any other request stays refused.
    const refusing = globalThis.fetch;
    vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) =>
      String(input).startsWith(SEARCH) ? realFetch(hostAt, init) : refusing(input, init),
    );
    try {
      await start({ fetchStandIns: null });
      const app = await trending();
      const fetched = await call<Fetched>("POST", `${app}/fetch`, { url: `${SEARCH}?q=stars` });
      // The route read the answer's status and its body.
      expect(fetched).toMatchObject({ status: 200, body: { ok: true, status: 200 } });
      expect(JSON.parse((fetched.body as { text: string }).text)).toEqual({ items: [{ full_name: "sample/real" }] });
      expect(lines.filter((line) => line.startsWith("error:"))).toEqual([]);
    } finally {
      await new Promise<void>((resolve) => host.close(() => resolve()));
    }
  });
});

describe("stopping", () => {
  it("stops listening, then closes the database", async () => {
    const server = await start();
    expect((await call<{ ok: boolean }>("GET", "/api/health")).status).toBe(200);
    await server.stop();
    expect(db.open).toBe(false);
    await expect(realFetch(`${base}/api/health`)).rejects.toThrow();
    // Stopping again changes nothing.
    await server.stop();
  });

  it("closes the database within 5 seconds whatever holds things up", async () => {
    const server = await start({ fetchStandIns: null });
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
  it("logs a rejection that nothing handled on one line", () => {
    const line = unhandledRejectionLine(new Error("Something\n  broke."));
    expect(line).toMatch(/^A rejected promise was left that nothing handled; the server goes on: Error: Something broke\. at /);
    expect(line).not.toContain("\n");
    expect(unhandledRejectionLine("plain text")).toBe("A rejected promise was left that nothing handled; the server goes on: plain text");
    expect(unhandledRejectionLine(new FetchError("stopped", "The request is over."))).toMatch(
      /^A rejected promise was left that nothing handled; the server goes on: FetchError: The request is over\. at /,
    );
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

/** main.ts as a process of its own, with these settings and nothing else of this one's environment. */
function serverProcess(env: Record<string, string>) {
  const child = spawn(process.execPath, ["--import", "tsx", "src/main.ts"], {
    cwd: PACKAGE,
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
  const ended = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
  return { child, ended, output: () => output };
}

describe("a server process", () => {
  it(
    "applies the migrations, serves, and ends with status 0 on SIGTERM, its database closed",
    async () => {
      const port = await freePort();
      base = `http://127.0.0.1:${port}`;
      db.close();
      const fresh = path.join(folder, "fresh.db");
      const { child, ended, output } = serverProcess({
        HOST: "127.0.0.1",
        PORT: String(port),
        HEARTH_AUTH: "dev",
        HEARTH_OWNER_EMAIL: OWNER_EMAIL,
        HEARTH_DB: fresh,
        HEARTH_WEB_DIST: path.join(folder, "web"),
        HEARTH_FETCH_STANDINS: standIns,
        // Read no more: the server goes on as if neither were set.
        HEARTH_JOBS: "on",
        HEARTH_APPS_DIR: path.join(folder, "apps"),
      });
      try {
        await vi.waitFor(() => expect(output()).toContain(`is listening on ${base}`), { timeout: 30_000, interval: 50 });
        expect(output()).toMatch(/Applied database migration 1 /);
        expect((await call<{ ok: boolean }>("GET", "/api/health")).body).toMatchObject({ ok: true });
        expect((await personalSpace()).length).toBeGreaterThan(0);
        expect(child.exitCode).toBeNull();
      } finally {
        child.kill("SIGTERM");
      }
      expect(await ended).toBe(0);
      const again = openDatabase(fresh);
      try {
        expect(again.prepare("SELECT count(*) AS n FROM users").get()).toEqual({ n: 1 });
      } finally {
        again.close();
      }
    },
    60_000,
  );

  it(
    "ends with status 1 before it opens the database when its settings are not valid",
    async () => {
      const never = path.join(folder, "never.db");
      const { ended, output } = serverProcess({ HEARTH_AUTH: "cloudflare-access", HEARTH_OWNER_EMAIL: OWNER_EMAIL, HEARTH_DB: never });
      expect(await ended).toBe(1);
      expect(output()).toContain("Hearth cannot start: the configuration is not valid.");
      expect(output()).toContain("HEARTH_CF_TEAM_DOMAIN is required");
      expect(existsSync(never)).toBe(false);
    },
    60_000,
  );
});
