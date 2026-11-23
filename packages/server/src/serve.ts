/**
 * The server as a process runs it: what main.ts starts.
 *
 * `startServer` is the part a test can run: the apps' way out (the
 * stand-in file HEARTH_FETCH_STANDINS names, or the network, paced), the
 * built-in apps brought up to date and the installs of the apps of the
 * releases before them moved to them, the application, listening, and a
 * stop that closes the database once the server has stopped listening.
 *
 * `serveHearth` is the process around it: the settings are checked before
 * the database is opened, a rejection nothing handled is logged instead of
 * ending the process, and SIGTERM or SIGINT stop it.
 */
import type { AddressInfo } from "node:net";
import { serve, type ServerType } from "@hono/node-server";
import type { Hono } from "hono";
import { createApp } from "./app";
import { outboundFor, processClock, type Clock } from "./apps/fetch";
import { madeAppsRegistry } from "./made/apps";
import { loadCatalog } from "./made/catalog";
import { moveLegacyInstalls, updateBuiltInApps } from "./made/builtin";
import type { Identify } from "./auth";
import { ConfigError, isLoopbackHost, loadConfig, type Config } from "./config";
import { migrate, openDatabase, type Db } from "./db/database";
import type { Env } from "./http/env";

/** The longest a stop waits for the open connections: then the database is closed all the same. */
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
  readonly log: ServerLog;
  /**
   * Times the pace of the apps' fetches, each answer's 20 seconds and the
   * stop's limit: the process's own clock, unless a test gives one that
   * moves when told.
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
  /** Resolves once the server listens; rejects when it cannot. */
  readonly listening: Promise<AddressInfo>;
  /**
   * Stops for good: the server stops listening and lets its open
   * connections finish, then the database is closed; after STOP_LIMIT_MS it
   * is closed whatever holds things up. Resolves when it is closed.
   */
  readonly stop: () => Promise<void>;
};

/** Starts the server: the built-in apps brought up to date, the application and the listening socket. */
export function startServer(options: StartOptions): RunningServer {
  const { config, db, log } = options;
  const clock = options.clock ?? processClock;

  // The apps' way out, one for the whole server, so that one pace holds every request to a host:
  // the stand-in file when HEARTH_FETCH_STANDINS names one, and the network, paced, otherwise.
  const outbound = outboundFor(config, clock);

  // The apps shipped with Hearth (docs/platform.md, "Built-in apps"): their untouched copies brought
  // up to date, and the installs of the apps of the same name that releases before them left moved
  // to them, once, in place, data and all.
  const catalog = loadCatalog();
  const updates = updateBuiltInApps(db, catalog);
  for (const copy of updates.updated) log.info(`Updated the built-in app "${copy.template}" of space ${copy.spaceId} (${copy.appId}) to version ${copy.version}.`);
  for (const copy of updates.failed) log.error(`Could not update the built-in app "${copy.template}" of space ${copy.spaceId} (${copy.appId}): ${copy.reason}`);
  const { moved, failed } = moveLegacyInstalls(db, madeAppsRegistry(db), catalog);
  for (const install of moved) log.info(`Moved the app "${install.from}" of space ${install.spaceId} to the built-in app (${install.to}).`);
  for (const install of failed) log.error(`Could not move the app "${install.from}" of space ${install.spaceId}: ${install.reason}`);

  const app = createApp({ config, db, identify: options.identify, outbound, catalog });

  let markListening: (info: AddressInfo) => void = () => {};
  let markFailed: (error: unknown) => void = () => {};
  const listening = new Promise<AddressInfo>((resolve, reject) => {
    markListening = resolve;
    markFailed = reject;
  });
  // The caller hears of a failure to listen through `listening` or the server's "error" event; nothing is left waiting.
  listening.catch(() => {});
  // serve() puts lighter classes of its own in the place of the globals Request and Response, and it must
  // be left to: Hono's bodyLimit makes a `new Request` of the listener's own request, which only the
  // listener's class can read. So an answer of Node's fetch is no instance of the global Response from
  // here on; apps/fetch.ts knows one by the platform's class instead (PlatformResponse there).
  const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) => {
    announce(config, info, log);
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
      server.close(() => finish());
    });
    return stopped;
  };

  return { app, server, listening, stop };
}

/** The lines a server says once it listens: where, and what is switched off or stood in for. */
function announce(config: Config, info: AddressInfo, log: ServerLog): void {
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
      `Apps reach no network (HEARTH_FETCH_STANDINS): every fetch of an app is answered from the stand-ins in ${config.fetchStandIns}. This is for end-to-end tests only.`,
    );
  }
}

/** What the server logs of a rejected promise that nothing handled, on one line. */
export function unhandledRejectionLine(reason: unknown): string {
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
 * Runs the server as a process: reads its settings before it opens the
 * database (a problem ends the process with status 1, which fails the
 * deploy's trial start, and changes nothing), applies the migrations,
 * starts the server, and stops it on SIGTERM or SIGINT, ending with
 * status 0.
 *
 * A rejected promise that nothing handled is logged on one line instead of
 * ending the process: the server serves everyone, and one request's loose
 * end should not stop it for all.
 */
export function serveHearth(): void {
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

  const db = openDatabase(config.dbPath);
  for (const migration of migrate(db)) {
    console.log(`Applied database migration ${migration.id} (${migration.name}).`);
  }

  const running = startServer({
    config,
    db,
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
