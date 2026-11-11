/**
 * `hearth-apps dev`: Hearth running on this machine, with the mini-apps of
 * a folder in it, for working on them.
 *
 * It runs sync for the folders (refusing what a build refuses, with the same
 * status), then `pnpm dev` in the hearth checkout with HEARTH_APPS_DIR
 * naming them and sign-in switched off (HEARTH_AUTH=dev): the server on
 * port 4310 and the web app on http://localhost:5173. A change to a widget
 * or page shows without a reload of the page; a change to a manifest or a
 * server file restarts the server. An app, page or server file added or
 * taken away changes the lists sync writes, so it needs `hearth-apps dev`
 * started again.
 *
 * Which folders: those named in HEARTH_APPS_DIR, or the folder the command
 * runs in when the variable is not set, which is how a mini-apps repository
 * runs it (`pnpm dev` there).
 *
 * Everyone is signed in as HEARTH_OWNER_EMAIL, the server's owner, or as
 * you@example.com when that is not set. The data is the framework's own
 * development database (packages/server/data), never a server's.
 *
 * Design: docs/mini-app-contract.md, section A9.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { AppsError, frameworkRoot, sync } from "./sync.mjs";

/** Who is signed in when HEARTH_OWNER_EMAIL is not set. Sample data. */
export const DEV_OWNER_EMAIL = "you@example.com";

/**
 * The environment of the framework's dev servers: the given one, with the
 * apps folders, sign-in switched off and an owner.
 *
 * @param {NodeJS.ProcessEnv} env
 * @param {readonly string[]} appsDirs Absolute paths.
 * @returns {NodeJS.ProcessEnv}
 */
export function devEnvironment(env, appsDirs) {
  return {
    ...env,
    HEARTH_APPS_DIR: appsDirs.join(path.delimiter),
    HEARTH_AUTH: "dev",
    HEARTH_OWNER_EMAIL: env.HEARTH_OWNER_EMAIL?.trim() ? env.HEARTH_OWNER_EMAIL : DEV_OWNER_EMAIL,
  };
}

/**
 * Starts `pnpm dev` in the hearth checkout and resolves with its exit
 * status once it ends, or with 0 when it was stopped.
 *
 * The servers run in a process group of their own, and a stop signal that
 * reaches this process (Ctrl+C in a terminal, or a signal sent to it alone)
 * goes to that whole group: pnpm does not pass a signal on through the
 * shell and `concurrently` below it, so signalling pnpm alone would leave
 * the servers running.
 *
 * @param {object} options
 * @param {string} options.root The hearth checkout.
 * @param {NodeJS.ProcessEnv} options.env
 * @param {(line: string) => void} options.log
 * @param {Pick<NodeJS.EventEmitter, "on" | "off">} [options.signals] Where stop signals arrive: this process. For tests.
 * @returns {Promise<number>}
 */
export function startDevServers({ root, env, log, signals = process }) {
  return new Promise((resolve) => {
    const child = spawn("pnpm", ["run", "dev"], { cwd: root, env, stdio: "inherit", detached: true });
    let stopping = false;
    const pass = (/** @type {NodeJS.Signals} */ signal) => {
      stopping = true;
      try {
        if (child.pid !== undefined) process.kill(-child.pid, signal);
      } catch {
        // The group is gone already.
      }
    };
    const stops = /** @type {const} */ (["SIGINT", "SIGTERM", "SIGHUP"]);
    for (const signal of stops) signals.on(signal, pass);
    const done = (/** @type {number} */ status) => {
      for (const signal of stops) signals.off(signal, pass);
      resolve(status);
    };
    child.on("error", (error) => {
      log(`hearth-apps dev: could not start "pnpm dev" in ${root} (${error.message}). It needs pnpm on the PATH.`);
      done(1);
    });
    child.on("exit", (code) => done(stopping ? 0 : (code ?? 1)));
  });
}

/**
 * The whole command. Resolves with the exit status: sync's when it refuses
 * the apps (3 for a folder written for another SDK version, 1 otherwise),
 * else that of the dev servers once they stop.
 *
 * @param {object} options
 * @param {readonly string[]} options.appsDirs Absolute paths of the apps folders.
 * @param {string} [options.root] The hearth checkout. Defaults to the one this file is in.
 * @param {string} [options.out] Where sync's files go, in place of `root`. For tests, which do not start the servers.
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {(line: string) => void} [options.log]
 * @param {typeof startDevServers} [options.start] What starts the servers. For tests.
 * @returns {Promise<number>}
 */
export async function dev(options) {
  const root = options.root ?? frameworkRoot();
  const log = options.log ?? ((line) => console.error(line));
  const env = options.env ?? process.env;
  const start = options.start ?? startDevServers;

  let found;
  try {
    found = sync({ appsDirs: options.appsDirs, root, out: options.out });
  } catch (error) {
    if (!(error instanceof AppsError)) throw error;
    log("hearth-apps dev: the mini-apps cannot be built in. Nothing was started.");
    for (const problem of error.problems) log(`  - ${problem}`);
    return error.exitCode;
  }
  for (const notice of found.notices) log(`hearth-apps dev: ${notice}`);
  const names = found.apps.map((app) => app.id).join(", ");
  log(
    found.apps.length === 0
      ? "hearth-apps dev: no mini-apps to run; starting Hearth without any."
      : `hearth-apps dev: running Hearth with ${found.apps.length === 1 ? "1 mini-app" : `${found.apps.length} mini-apps`} (${names}).`,
  );

  const serverEnv = devEnvironment(env, options.appsDirs);
  const signedIn = serverEnv.HEARTH_DEV_USER?.trim() || serverEnv.HEARTH_OWNER_EMAIL;
  log(
    `hearth-apps dev: open http://localhost:5173 and add the apps to a space on the Apps page. Sign-in is off: everyone is ${signedIn}.`,
  );
  return start({ root, env: serverEnv, log });
}
