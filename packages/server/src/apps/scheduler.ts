/**
 * The scheduler: runs the mini-apps' jobs as they fall due, one at a time
 * across the whole server, for as long as the server runs.
 *
 * It asks which job falls due first (`nextJob` in jobs.ts), runs it once it
 * is due with `runOnce` (claim, run, record: the code an app's own tests
 * run a job through too) and asks again. With nothing due it sleeps until
 * the next job is, at most 30 seconds, so that what another process sharing
 * the database changed is seen within that; `wake` ends the sleep at once,
 * for an app added to a space or brought back, or a run someone asked for.
 *
 * All it knows is in `app_jobs`: after a restart what is due runs, in
 * order, and a run cut off by a crash is taken over once its claim has run
 * out. The claim keeps a run single across processes that share the
 * database file, as the owner's and Lin's copies of the server do in the
 * end-to-end tests; within one process the scheduler starts one run at a
 * time. Timing is jobs.ts's: at most 5 minutes a run; after a run that went
 * well the next an interval to a tenth more after it started (the jitter);
 * after failures in a row 5, 10, 20 ... minutes, never more than the
 * interval (the backoff).
 *
 * Only startServer (src/serve.ts, which main.ts runs) makes one, when
 * HEARTH_JOBS is "on", and starts it once the server listens: createApp
 * starts none, so tests run no job unless one asks. It is given its clock,
 * its randomness and its way out, so that its tests neither wait nor reach
 * a network.
 *
 * Design: docs/mini-app-contract.md, section C ("The scheduler",
 * "Switches"), and the owner's decision 15.
 */
import type { Db } from "../db/database";
import type { Clock, Outbound } from "./fetch";
import { nextJob, runOnce, type JobKey, type RunWorld } from "./jobs";
import type { Registry } from "./registry";

/**
 * The longest the scheduler sleeps before it looks again, even when nothing
 * falls due sooner: what another process sharing the database changed, such
 * as an app it added, is seen within this.
 */
export const LONGEST_WAIT_MS = 30_000;
/** How much of a failed run's message its line in the log holds, in characters. */
export const LOGGED_MESSAGE_LENGTH = 1_000;

export type SchedulerOptions = {
  readonly db: Db;
  /** The apps this build holds: only their jobs run. */
  readonly registry: Registry;
  /** The way out for every run's ctx.fetch: the server's one (`outboundFor`), whose pace holds every job of every app to it. */
  readonly outbound: Outbound;
  /** Times the sleeps and each run's limit: the process's own clock on a server (`processClock`). */
  readonly clock: Clock;
  /** The time of day, which `app_jobs` keeps its times in. */
  readonly now: () => Date;
  /** A number from 0 to 1, for the jitter. */
  readonly random: () => number;
  /** Takes one line for each run that went wrong, and for a look at the database that failed. Nothing for a run that went well. */
  readonly log: (line: string) => void;
};

/** The scheduler of one server process. Its three functions may be passed around on their own. */
export type Scheduler = {
  /** Starts running jobs as they fall due. Only the first call does anything, and none after `stop`. */
  readonly start: () => void;
  /**
   * Looks at once for a job that is due, instead of at the end of the
   * sleep: an app was added to a space or brought back, or someone asked
   * for a run. During a run it changes nothing: the scheduler looks again
   * as soon as the run is over anyway.
   */
  readonly wake: () => void;
  /**
   * Stops for good: no new run starts, and the run going on ends at once,
   * recorded as stopped (nothing kept of how it went, and its job due at
   * once, for the next start). Resolves once the scheduler has let go of
   * the database. A job's function that goes on after its run ended is not
   * waited for: its ctx no longer works.
   */
  readonly stop: () => Promise<void>;
};

/** Makes the scheduler of a server process. It runs nothing until `start`. */
export function createScheduler(options: SchedulerOptions): Scheduler {
  const { db, registry, clock, now, log } = options;
  /** Aborts when the scheduler stops: no run starts after it, and the run going on ends at once. */
  const stopping = new AbortController();
  const world: RunWorld = { outbound: options.outbound, clock, now, random: options.random, stop: stopping.signal };

  /** The loop, once started. */
  let loop: Promise<void> | null = null;
  /** Set by `wake`: look again before sleeping. */
  let woken = false;
  /** Ends the sleep going on, if there is one. */
  let interrupt: (() => void) | null = null;
  /** The job whose claim was refused last, while nothing else ran: so that it is not asked for over and over. */
  let refused: string | null = null;

  /** Sleeps `ms`, or less when woken or stopped. */
  function sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      let cancel = () => {};
      const done = () => {
        cancel();
        interrupt = null;
        resolve();
      };
      interrupt = done;
      cancel = clock.after(ms, done);
    });
  }

  /** Runs the job that is due, if one is, and says how long to sleep before looking again: 0 for not at all. */
  async function step(): Promise<number> {
    const time = now();
    const next = nextJob(db, registry, time);
    if (next === null) {
      refused = null;
      return LONGEST_WAIT_MS;
    }
    const until = next.at.getTime() - time.getTime();
    if (until > 0) {
      refused = null;
      return Math.min(until, LONGEST_WAIT_MS);
    }
    const outcome = await runOnce(db, registry, next.key, world);
    if (typeof outcome === "string") {
      // Between asking and claiming, another process sharing the database
      // claimed the job or ran it, or its install went away: ask again at
      // once, but not over and over for the same job.
      const id = JSON.stringify([next.key.spaceId, next.key.appId, next.key.job]);
      const again = refused !== id;
      refused = id;
      return again ? 0 : LONGEST_WAIT_MS;
    }
    refused = null;
    if (outcome.kind === "failed") log(failureLine(next.key, outcome.error));
    return 0;
  }

  async function run(): Promise<void> {
    while (!stopping.signal.aborted) {
      woken = false;
      let wait: number;
      try {
        wait = await step();
      } catch (error) {
        // The database could not be read or written, for one: the scheduler
        // tries again later instead of stopping for good. A claim this left
        // behind is taken over once it runs out.
        log(`The scheduler could not run jobs (${oneLine(error)}). It looks again in ${LONGEST_WAIT_MS / 1000} seconds.`);
        wait = LONGEST_WAIT_MS;
      }
      if (stopping.signal.aborted) break;
      if (wait > 0 && !woken) {
        await sleep(wait);
      } else {
        // Requests are answered between one run and the next, however quick the runs.
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }
  }

  return {
    start: () => {
      if (loop !== null || stopping.signal.aborted) return;
      loop = run().catch((error: unknown) => {
        try {
          log(`The scheduler stopped: ${oneLine(error)}. No job runs until the server is started again.`);
        } catch {
          // Nowhere left to say it.
        }
      });
    },
    wake: () => {
      woken = true;
      interrupt?.();
    },
    stop: () => {
      stopping.abort();
      interrupt?.();
      return loop ?? Promise.resolve();
    },
  };
}

/** The line a run that went wrong leaves in the log: the app, the job, the space's ID and why. */
function failureLine(key: JobKey, message: string): string {
  // Characters, not halves of one, as in what jobs.ts keeps of a message.
  const characters = Array.from(message);
  const shown =
    characters.length <= LOGGED_MESSAGE_LENGTH
      ? message
      : `${characters.slice(0, LOGGED_MESSAGE_LENGTH - 1).join("")}…`;
  return `App "${key.appId}", job "${key.job}", space ${key.spaceId}: the run failed: ${shown}`;
}

/** What an error says, on one line. */
function oneLine(error: unknown): string {
  let message = "";
  try {
    message = error instanceof Error ? error.message : String(error);
  } catch {
    // A value that cannot even be turned into text.
  }
  return message.replace(/\s+/g, " ").trim() || "no message";
}
