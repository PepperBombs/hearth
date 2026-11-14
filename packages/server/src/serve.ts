/**
 * The server as a process runs it: what main.ts starts, apart from the list
 * of mini-apps the build wrote, which main.ts alone imports.
 *
 * `startServer` is the part a test can run: the scheduler of the mini-apps'
 * jobs when HEARTH_JOBS is "on" (none when "off"), their way out (the
 * stand-in file HEARTH_FETCH_STANDINS names, or the network, paced), the
 * application with the scheduler's wake handed to its routes, listening,
 * and a stop that ends the run going on before the database is closed.
 *
 * `serveHearth` is the process around it: the settings and the apps are
 * checked before the database is opened, a rejection nothing handled is
 * logged instead of ending the process, and SIGTERM or SIGINT stop it.
 *
 * Design: docs/mini-app-contract.md, section C ("The scheduler",
 * "Switches").
 */
import type { AddressInfo } from "node:net";
import { serve, type ServerType } from "@hono/node-server";
import { FetchError } from "@hearth/sdk/server";
import type { Hono } from "hono";
import { createApp } from "./app";
import { outboundFor, processClock, type Clock } from "./apps/fetch";
import { AppRegistryError, createRegistry, type BundledApp } from "./apps/registry";
import { createScheduler, type Scheduler } from "./apps/scheduler";
import type { Identify } from "./auth";
import { ConfigError, isLoopbackHost, loadConfig, type Config } from "./config";
import { migrate, openDatabase, type Db } from "./db/database";
import type { Env } from "./http/env";

/** The longest a stop waits for the run going on and the open connections: then the database is closed all the same. */
export const STOP_LIMIT_MS = 5_000;

/** Where the server's lines go: the console, in a process. */
export type ServerLog = {
  readonly info: (line: string) => void;
  readonly warn: (line: string) => void;
  readonly error: (line: string) => void;
};

export type StartOptions = {
  readonly config: Config;
  /** Opened and migrated. `stop` closes it. */
  readonly db: Db;
  /** The mini-apps this build holds. A bad one throws AppRegistryError before anything starts. */
  readonly apps: readonly BundledApp[];
  readonly log: ServerLog;
  /**
   * Times the scheduler's sleeps, each run's 5 minutes, each answer's 20
   * seconds and the stop's limit: the process's own clock, unless a test
   * gives one that moves when told.
   */
  readonly clock?: Clock;
  /** The login method; the configuration's unless a test gives another. */
  readonly identify?: Identify;
};

/** A server that listens, or is about to. */
export type RunningServer = {
  readonly app: Hono<Env>;
  /** The listening socket's server. Its "error" event says it could not listen. */
  readonly server: ServerType;
  /** The scheduler of the mini-apps' jobs, or null when HEARTH_JOBS is "off": then no job runs. */
  readonly scheduler: Scheduler | null;
  /** Resolves once the server listens and the scheduler has started; rejects when it cannot listen. */
  readonly listening: Promise<AddressInfo>;
  /**
   * Stops for good. The scheduler first: no new run starts, and the run
   * going on ends at once, recorded as stopped (its job due again at the
   * next start), while the server stops listening and lets its open
   * connections finish. Once both are done the database is closed; after
   * STOP_LIMIT_MS it is closed whatever holds things up. Resolves when it
   * is closed. A job's function that goes on all the same is not waited
   * for: its ctx no longer works.
   */
  readonly stop: () => Promise<void>;
};

/**
 * Starts the server: its jobs' scheduler, unless HEARTH_JOBS is "off", the
 * application and the listening socket. The scheduler starts once the
 * server listens.
 */
export function startServer(options: StartOptions): RunningServer {
  const { config, db, apps, log } = options;
  const clock = options.clock ?? processClock;
  const registry = createRegistry(apps);

  // The mini-apps' jobs run in this process, one at a time, unless
  // HEARTH_JOBS=off: the deploy's trial start and the end-to-end servers
  // without stand-ins switch them off. Their way out is the stand-in file
  // when HEARTH_FETCH_STANDINS names one, and the network, paced, otherwise.
  const scheduler =
    config.jobs === "on"
      ? createScheduler({
          db,
          registry,
          outbound: outboundFor(config, clock),
          clock,
          now: () => new Date(),
          random: Math.random,
          log: (line) => log.error(line),
        })
      : null;

  const app = createApp({ config, db, apps, identify: options.identify, wakeJobs: scheduler?.wake });

  let markListening: (info: AddressInfo) => void = () => {};
  let markFailed: (error: unknown) => void = () => {};
  const listening = new Promise<AddressInfo>((resolve, reject) => {
    markListening = resolve;
    markFailed = reject;
  });
  // The caller hears of a failure to listen through `listening` or the server's "error" event; nothing is left waiting.
  listening.catch(() => {});
  // `overrideGlobalObjects: false` leaves the platform's Request and Response in place. Left to itself,
  // serve() puts lighter classes of its own there, and an answer of Node's fetch is no instance of
  // those: every job's ctx.fetch then took a real answer for none (see PlatformResponse in apps/fetch.ts).
  const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port, overrideGlobalObjects: false }, (info) => {
    announce(config, info, scheduler, log);
    scheduler?.start();
    markListening(info);
  });
  server.on("error", (error) => markFailed(error));

  let stopped: Promise<void> | null = null;
  const stop = (): Promise<void> => {
    stopped ??= new Promise<void>((resolve) => {
      let done = false;
      let cancelLimit = () => {};
      const finish = () => {
        if (done) return;
        done = true;
        cancelLimit();
        if (db.open) db.close();
        resolve();
      };
      // Whatever holds things up, such as a request whose body never ends, the database is closed in the end.
      cancelLimit = clock.after(STOP_LIMIT_MS, finish);
      const closed = new Promise<void>((resolveClosed) => server.close(() => resolveClosed()));
      void Promise.all([scheduler?.stop(), closed]).then(finish, finish);
    });
    return stopped;
  };

  return { app, scheduler, server, listening, stop };
}

/** The lines a server says once it listens: where, and what is switched off or stood in for. */
function announce(config: Config, info: AddressInfo, scheduler: Scheduler | null, log: ServerLog): void {
  const host = info.family === "IPv6" ? `[${info.address}]` : info.address;
  log.info(`Hearth ${config.version} is listening on http://${host}:${info.port}`);
  if (config.auth.mode === "dev") {
    log.warn(
      `Sign-in is switched off (HEARTH_AUTH=dev): every request is treated as ${config.auth.devUser}. Never use this on a server.`,
    );
  } else if (!isLoopbackHost(config.host)) {
    log.warn(`Listening on ${config.host}, which other machines can reach. Make sure only Cloudflare can connect to this port.`);
  }
  if (config.fetchStandIns !== null) {
    log.warn(
      `Jobs reach no network (HEARTH_FETCH_STANDINS): every ctx.fetch is answered from the stand-ins in ${config.fetchStandIns}. This is for end-to-end tests only.`,
    );
  }
  if (scheduler === null) {
    log.info("Jobs are switched off (HEARTH_JOBS=off): no mini-app's job runs, and none fetches anything.");
  }
}

/**
 * What the server logs of a rejected promise that nothing handled, on one
 * line. A job's function may leave one behind: it can make promises of its
 * own, such as one made of a `ctx.fetch` that it no longer waits for when its
 * run ends, and a run does not wait for what its function goes on doing.
 */
export function unhandledRejectionLine(reason: unknown): string {
  if (reason instanceof FetchError) {
    return `A job left behind a request of ctx.fetch that nothing waited for (${reason.code}): ${oneLine(reason.message)}`;
  }
  const what = reason instanceof Error ? (reason.stack ?? `${reason.name}: ${reason.message}`) : textOf(reason);
  return `A rejected promise was left that nothing handled; the server goes on: ${oneLine(what)}`;
}

/** A thrown value that is not an Error, as text. */
function textOf(value: unknown): string {
  try {
    return typeof value === "string" ? value : `${typeof value} ${String(value)}`;
  } catch {
    return `a value of type ${typeof value}`;
  }
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Runs the server as a process: reads its settings and checks the apps the
 * build holds before it opens the database (either problem ends the process
 * with status 1, which fails the deploy's trial start, and changes
 * nothing), applies the migrations, starts the server, and stops it on
 * SIGTERM or SIGINT, ending with status 0.
 *
 * A rejected promise that nothing handled is logged on one line instead of
 * ending the process: a job may leave one behind, and the server serves
 * everyone, every other app's jobs included.
 */
export function serveHearth(apps: readonly BundledApp[]): void {
  process.on("unhandledRejection", (reason) => console.error(unhandledRejectionLine(reason)));

  let config: Config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }

  // Before the database is opened: a build with a bad app changes nothing.
  try {
    createRegistry(apps);
  } catch (error) {
    if (error instanceof AppRegistryError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }

  const db = openDatabase(config.dbPath);
  for (const migration of migrate(db)) {
    console.log(`Applied database migration ${migration.id} (${migration.name}).`);
  }

  const running = startServer({
    config,
    db,
    apps,
    log: {
      info: (line) => console.log(line),
      warn: (line) => console.warn(line),
      error: (line) => console.error(line),
    },
  });

  running.server.on("error", (error) => {
    console.error(`Hearth could not listen on ${config.host}:${config.port}: ${error.message}`);
    if (db.open) db.close();
    process.exit(1);
  });

  const stop = () => void running.stop().then(() => process.exit(0));
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
