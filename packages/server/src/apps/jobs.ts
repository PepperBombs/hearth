/**
 * Running a mini-app's jobs: what an app does by itself, every so often,
 * once for each space it is in, for no one in it.
 *
 * A job runs through three functions, in this order, and nothing else runs
 * one:
 *
 * 1. `claimRun`, one immediate transaction. The install must be there (the
 *    app's entry in the space and not removed, the app and the job in this
 *    build), the job due or the caller forcing it, and no run may hold it.
 *    It takes the job for this run (`run_id`, and `run_until`, after which
 *    another run may take it over) and reads what the run sees: the space's
 *    kind, name and settings.
 * 2. `runClaimed`, outside any transaction: the job's function with its
 *    `ctx`, for at most five minutes. `ctx.read` and `ctx.write` run their
 *    work in one transaction each, after checking inside it that the run's
 *    time is not up and that it still holds its install; `ctx.fetch` is
 *    fetch.ts's, limited to the hosts the manifest lists. Once the run is
 *    over all three stop working.
 * 3. `recordRun`, one immediate transaction: how the run went, when the
 *    job runs next, and the claim let go.
 *
 * `runOnce` does the three in order: the scheduler (scheduler.ts) and an
 * app's own tests run jobs through it. `nextJob` is what the scheduler asks
 * which job to run next. `requestRun` and `jobStatus` are what a person may
 * do and see: ask for a run now (edit), and read how the runs went (view).
 *
 * The table is `app_jobs` (migration 3), whose SQL is in this file only.
 * An app's rows and settings are still read and written by store.ts, one
 * install at a time, through the same stores a handler gets. A job's rows
 * carry the person who added the app to the space, on whose behalf it runs.
 *
 * Design: docs/mini-app-contract.md, section C ("Jobs in the server file",
 * "Running a job"), and the owner's decisions 14 and 15.
 */
import type { Job } from "@hearth/sdk/server";
import type { SettingValue, SpaceKind } from "@hearth/shared";
import type { Db } from "../db/database";
import { newId } from "../db/ids";
import { notFound, Refusal } from "../http/errors";
import { isThenable } from "./calls";
import type { ServerDefinition } from "./definition";
import { fetchFor, type Clock, type Outbound } from "./fetch";
import { resolveInstall, type AppRequest } from "./installs";
import type { RegisteredApp, Registry } from "./registry";
import { spaceSettingsFor } from "./settings";
import { readOnlyStore, StoreUsageError, writableStore } from "./store";

const MINUTE_MS = 60_000;

/** How long a run may take. Then it is stopped, and it failed. */
export const RUN_TIME_LIMIT_MS = 5 * MINUTE_MS;
/**
 * How long after a run's time limit its claim is taken over: what a server
 * that died in the middle of a run leaves behind holds the job no longer.
 */
export const CLAIM_GRACE_MS = MINUTE_MS;
/** The least time between the start of a run and that of a run a person asked for. */
export const REQUEST_GAP_MS = 5 * MINUTE_MS;
/** A run that went well is followed by the next after its interval and up to this part of it again. */
export const JITTER = 0.1;
/** When the next run after one that went well would be due already, it is due this long after that run ended. */
export const LATE_RUN_MS = MINUTE_MS;
/** The wait after a first failure in a row, in minutes; it doubles with each one after it, up to the interval. */
export const FIRST_BACKOFF_MINUTES = 5;
/** How much of a failure's message is kept, in characters. */
export const MAX_ERROR_LENGTH = 200;

/** One app's job in one space. */
export type JobKey = {
  readonly spaceId: string;
  readonly appId: string;
  /** The job's name in the app's `server.ts`. */
  readonly job: string;
};

/** A run that holds its job: what `claimRun` took, and what the run and `recordRun` go by. */
export type Claim = JobKey & {
  /** This run's own ID, which `app_jobs.run_id` holds while the claim does. */
  readonly runId: string;
  /** When the run started: `ctx.now`, and what its next run is counted from. */
  readonly startedAt: Date;
  /** How often the job runs, in minutes, as the build says. */
  readonly everyMinutes: number;
  /** The space the app is in, as the job sees it: no ID. A personal space has an empty name. */
  readonly space: { readonly kind: SpaceKind; readonly name: string };
  /** The space's settings, defaults filled in, as they were when the run was claimed. Nobody's own. */
  readonly settings: Record<string, SettingValue>;
};

/** Why `claimRun` took no claim. */
export type NoClaim =
  /** The app's entry is not in the space or was removed from it, or this build lacks the app or the job. */
  | "absent"
  /** Another run holds the job, and its time has not run out. */
  | "running"
  /** It is not due yet, and the caller did not force it. */
  | "not_due";

/** How a run ended: what `recordRun` records. */
export type RunOutcome =
  /** The job's function returned, or its promise resolved. */
  | { readonly kind: "succeeded" }
  /**
   * It threw or rejected, ran out of time, or gave `ctx.read` or
   * `ctx.write` work that returned a promise. `error` says what happened,
   * on one line; `cause` is what was thrown.
   */
  | { readonly kind: "failed"; readonly error: string; readonly cause: unknown }
  /** The server stopped it. Nothing is recorded; the job is due at once. */
  | { readonly kind: "stopped" }
  /**
   * During the run the app was removed, left the space or had its data
   * deleted, or another run took the job over, and `ctx.read` or
   * `ctx.write` was refused for it: nothing of the run was kept. Nothing is
   * recorded; the job is due at once wherever the app now is, if anywhere.
   */
  | { readonly kind: "gone"; readonly reason: string };

/** What a run needs from around it: given, so that tests need not wait and reach no network. */
export type RunWorld = {
  /** The way out for `ctx.fetch`: the server's one Outbound, or a test's. */
  readonly outbound: Outbound;
  /** Times a run's limit. The server's is the process's own (`processClock` in fetch.ts). */
  readonly clock: Clock;
  /** The time of day, for what is stored: when a run starts and ends, and when rows are written. */
  readonly now: () => Date;
  /** A number from 0 to 1, for the jitter. */
  readonly random: () => number;
  /** Aborts when the server is stopping: the run ends at once and counts for nothing. */
  readonly stop?: AbortSignal;
};

/** A job's status in an install, as a person who may see the app reads it. */
export type JobStatus = {
  /** When the last run started. */
  readonly lastStartedAt: string | null;
  /** When the last run that went well ended: the app's data is from then. */
  readonly lastSucceededAt: string | null;
  /** When the last run that went wrong ended. */
  readonly lastFailedAt: string | null;
  /** Why, in English, for owners and logs; never interface text. */
  readonly lastError: string | null;
  /** When it runs next, unless someone asks for a run sooner. */
  readonly nextRunAt: string;
  /** "running" while a run holds the job, "requested" while a run asked for has not started, else "idle". */
  readonly state: "idle" | "requested" | "running";
};

/**
 * Thrown by `ctx.read` and `ctx.write` instead of running their work: the
 * run is over, or the install it started in is no longer the run's.
 * Nothing was read or written.
 */
export class RunRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunRefusedError";
  }
}

/** What `ctx.read` and `ctx.write` say once the run is over, as `ctx.fetch` does. */
export const RUN_OVER = "The run is over: ctx.read and ctx.write work only while its job runs.";

/* -------------------------------------------------------------------------
 * The table
 * ---------------------------------------------------------------------- */

type JobRow = {
  nextRunAt: string;
  requestedAt: string | null;
  runId: string | null;
  runUntil: string | null;
  lastStartedAt: string | null;
  lastSucceededAt: string | null;
  lastFailedAt: string | null;
  lastError: string | null;
  failures: number;
};

const COLUMNS = `next_run_at AS nextRunAt, requested_at AS requestedAt, run_id AS runId, run_until AS runUntil,
  last_started_at AS lastStartedAt, last_succeeded_at AS lastSucceededAt, last_failed_at AS lastFailedAt,
  last_error AS lastError, failures`;

function rowOf(db: Db, key: JobKey): JobRow | undefined {
  return db
    .prepare(`SELECT ${COLUMNS} FROM app_jobs WHERE space_id = ? AND app_id = ? AND job = ?`)
    .get(key.spaceId, key.appId, key.job) as JobRow | undefined;
}

/** Whether a run holds the job: it has a claim, and the claim's time has not run out. */
const held = (row: Pick<JobRow, "runId" | "runUntil">, now: Date): boolean =>
  row.runId !== null && row.runUntil !== null && Date.parse(row.runUntil) > now.getTime();

function statusOf(row: JobRow | undefined, now: Date): JobStatus {
  // A job that has not run in an install has no row there yet, and is due at once.
  if (row === undefined) {
    return {
      lastStartedAt: null,
      lastSucceededAt: null,
      lastFailedAt: null,
      lastError: null,
      nextRunAt: now.toISOString(),
      state: "idle",
    };
  }
  return {
    lastStartedAt: row.lastStartedAt,
    lastSucceededAt: row.lastSucceededAt,
    lastFailedAt: row.lastFailedAt,
    lastError: row.lastError,
    nextRunAt: row.nextRunAt,
    state: held(row, now) ? "running" : row.requestedAt !== null ? "requested" : "idle",
  };
}

/** The app and the job as this build holds them. */
type JobCode = { readonly app: RegisteredApp & { readonly server: ServerDefinition }; readonly job: Job };

/** The app's code and its job of this name, or undefined when the build lacks either. A query's name is not a job's. */
function codeOf(registry: Registry, appId: string, name: string): JobCode | undefined {
  const app = registry.get(appId);
  const server = app?.server;
  if (app === undefined || server === undefined || !Object.hasOwn(server.routes, name)) return undefined;
  const job = server.routes[name];
  return job?.kind === "job" ? { app: { ...app, server }, job } : undefined;
}

/* -------------------------------------------------------------------------
 * 1. Claiming a run
 * ---------------------------------------------------------------------- */

/**
 * Takes a job for a run that starts now, in one immediate transaction, or
 * says why it did not:
 *
 * - "absent": the app's entry is not in the space, or was removed, or this
 *   build lacks the app or the job;
 * - "running": a run holds the job and its `run_until` is still ahead;
 * - "not_due": its `next_run_at` is ahead and the caller did not force it.
 *   A job that has never run in an install is due at once, and its row is
 *   made now.
 *
 * The claim sets `run_id` (a new ID), `run_until` (now, the time limit and
 * a minute) and `last_started_at`, and clears `requested_at`. A claim left
 * by a server that died is taken over once its `run_until` has passed, and
 * counts for nothing: neither a success nor a failure. The run's space and
 * settings are read in the same transaction; a change made during the run
 * counts from the next.
 *
 * It asks whether the install is there, never who may use it:
 * `resolveInstall` stays the one answer to what a person may do.
 */
export function claimRun(
  db: Db,
  registry: Registry,
  key: JobKey,
  options: { readonly now: Date; readonly force?: boolean },
): Claim | NoClaim {
  const { spaceId, appId, job } = key;
  const code = codeOf(registry, appId, job);
  if (code === undefined) return "absent";
  const now = options.now;
  return db
    .transaction((): Claim | NoClaim => {
      const space = db
        .prepare(
          `SELECT s.kind, s.name
             FROM space_apps a JOIN spaces s ON s.id = a.space_id
            WHERE a.space_id = ? AND a.app_id = ? AND a.removed_at IS NULL`,
        )
        .get(spaceId, appId) as { kind: SpaceKind; name: string } | undefined;
      if (space === undefined) return "absent";
      const row = rowOf(db, key);
      if (row !== undefined && held(row, now)) return "running";
      if (row !== undefined && !options.force && Date.parse(row.nextRunAt) > now.getTime()) return "not_due";

      const runId = newId();
      const startedAt = now.toISOString();
      db.prepare(
        `INSERT INTO app_jobs (space_id, app_id, job, next_run_at, run_id, run_until, last_started_at)
         VALUES (@spaceId, @appId, @job, @startedAt, @runId, @runUntil, @startedAt)
         ON CONFLICT (space_id, app_id, job) DO UPDATE
            SET run_id = excluded.run_id, run_until = excluded.run_until,
                last_started_at = excluded.last_started_at, requested_at = NULL`,
      ).run({
        spaceId,
        appId,
        job,
        startedAt,
        runId,
        runUntil: new Date(now.getTime() + RUN_TIME_LIMIT_MS + CLAIM_GRACE_MS).toISOString(),
      });
      return Object.freeze({
        spaceId,
        appId,
        job,
        runId,
        startedAt: new Date(now),
        everyMinutes: code.job.everyMinutes,
        space: Object.freeze({ kind: space.kind, name: space.name }),
        settings: spaceSettingsFor(db, { spaceId, appId }, code.app.manifest),
      });
    })
    .immediate();
}

/* -------------------------------------------------------------------------
 * 2. The run
 * ---------------------------------------------------------------------- */

/**
 * Who the run's writes are recorded as: the person who added the app to the
 * space, as long as the run still holds its install. Otherwise why not, in
 * words for the job's author and the status. Called inside the transaction
 * of `ctx.read` or `ctx.write`, before their work.
 */
function holder(db: Db, registry: Registry, claim: Claim): { author: string } | { refused: string } {
  if (codeOf(registry, claim.appId, claim.job) === undefined) {
    return { refused: "This build no longer holds the app or its job. Nothing was read or written." };
  }
  const row = db
    .prepare(
      `SELECT a.created_by AS author, a.removed_at AS removedAt, j.run_id AS runId
         FROM space_apps a
         LEFT JOIN app_jobs j ON j.space_id = a.space_id AND j.app_id = a.app_id AND j.job = @job
        WHERE a.space_id = @spaceId AND a.app_id = @appId`,
    )
    .get({ spaceId: claim.spaceId, appId: claim.appId, job: claim.job }) as
    | { author: string; removedAt: string | null; runId: string | null }
    | undefined;
  if (row === undefined) {
    return {
      refused: "The app left this space during the run: it was moved to another, or its data was deleted. Nothing was read or written.",
    };
  }
  if (row.removedAt !== null) {
    return { refused: "The app was removed from this space during the run. Nothing was read or written." };
  }
  if (row.runId !== claim.runId) {
    return {
      refused: "Another run has taken this job over: this one went on past its time, or the app's data was deleted and the app added again. Nothing was read or written.",
    };
  }
  return { author: row.author };
}

/** A failure as it is recorded and logged: what was thrown, said on one line. */
function failure(cause: unknown): RunOutcome {
  return { kind: "failed", error: messageOf(cause), cause };
}

/** The failure of a run that reached its time limit. */
const outOfTime = (): RunOutcome =>
  failure(new Error(`The run took longer than ${RUN_TIME_LIMIT_MS / MINUTE_MS} minutes, so it was stopped.`));

function messageOf(error: unknown): string {
  let message: string;
  try {
    if (error instanceof Error) {
      message = error.message.trim() === "" ? `${error.name}, with no message.` : error.message;
    } else if (typeof error === "string" && error.trim() !== "") {
      message = error;
    } else {
      message = `The job threw ${error === null ? "null" : `a value of type ${typeof error}`} instead of an Error.`;
    }
  } catch {
    message = "The job failed with an error whose message could not be read.";
  }
  return message.replace(/\s+/g, " ").trim();
}

/**
 * Runs a claimed job: its function with its `ctx`, outside any
 * transaction, until it returns or its promise settles, it runs out of
 * time, the server stops it, or `ctx.read` or `ctx.write` finds that the
 * run no longer holds its install. Resolves with how it ended, at once in
 * each case: a function that goes on after that is not waited for, and its
 * `ctx` no longer works.
 *
 * The `ctx`:
 * - `space`, `settings` and `now`: what the claim read, and when it started;
 * - `fetch`: fetch.ts's rules, pace and transport, for the hosts the
 *   manifest lists in `network`, with a signal that ends with the run, so
 *   that a request on its way rejects with `stopped` then;
 * - `read(work)` and `write(work)`: work in one transaction, deferred for
 *   `read` and immediate for `write`. Inside it, first, the check that the
 *   run's time limit has not passed by the clock of the day, which a busy
 *   process's timer may be behind, and that the run still holds its
 *   install (`holder`): the app's entry is in the space the run started in
 *   and not removed, the build holds the app and the job, and the job's
 *   row holds this run's ID. Then `work`, with a store
 *   made as a handler's is, in the name of whoever added the app, closed
 *   when `work` returns. Work that returns a promise is a fault: its
 *   transaction is undone and the run fails, whatever the job does after.
 *   Refused for the install, they end the run as "gone". They cannot be
 *   nested, and throw once the run is over.
 */
export async function runClaimed(db: Db, registry: Registry, claim: Claim, world: RunWorld): Promise<RunOutcome> {
  const code = codeOf(registry, claim.appId, claim.job);
  if (code === undefined) return { kind: "gone", reason: "This build does not hold the app or its job." };
  const { appId, job } = claim;
  const { collections } = code.app.server;

  /** Aborted when the run is over, for whatever reason: ctx then stops working. */
  const over = new AbortController();
  const state: { outcome: RunOutcome | null } = { outcome: null };
  let settle: (outcome: RunOutcome) => void = () => {};
  const ended = new Promise<RunOutcome>((resolve) => {
    settle = resolve;
  });
  /** Ends the run, unless it has ended already: the first reason wins. */
  const end = (outcome: RunOutcome): void => {
    if (state.outcome !== null) return;
    state.outcome = outcome;
    over.abort();
    settle(outcome);
  };

  const misuse = (message: string) => new StoreUsageError(`App "${appId}", job "${job}": ${message}`);
  /** Whether work given to ctx.read or ctx.write is running: their transactions do not nest. */
  let working = false;

  function transact(mode: "read" | "write", work: unknown): unknown {
    const name = `ctx.${mode}`;
    if (over.signal.aborted) throw new RunRefusedError(RUN_OVER);
    if (typeof work !== "function") throw misuse(`${name} takes the work to do, a function: ${name}((db) => ...).`);
    if (working) {
      throw misuse(`${name} was called inside the work of ctx.read or ctx.write. Do all of it in one: work runs in one transaction.`);
    }
    working = true;
    /** What the transaction threw that ends the run, told apart from what the work threw. */
    const ending: { late?: RunRefusedError; refusal?: RunRefusedError; fault?: StoreUsageError } = {};
    try {
      const transaction = db.transaction((): unknown => {
        const now = world.now();
        // The timer that ends the run comes late when the process is busy; the clock does not.
        if (now.getTime() >= claim.startedAt.getTime() + RUN_TIME_LIMIT_MS) {
          ending.late = new RunRefusedError(RUN_OVER);
          throw ending.late;
        }
        const found = holder(db, registry, claim);
        if ("refused" in found) {
          ending.refusal = new RunRefusedError(found.refused);
          throw ending.refusal;
        }
        const scope = { spaceId: claim.spaceId, appId, userId: found.author, job, now };
        const store = mode === "read" ? readOnlyStore(db, scope, collections) : writableStore(db, scope, collections);
        let result: unknown;
        try {
          result = (work as (db: unknown) => unknown)(store.collections);
        } finally {
          // The check holds for this transaction only. Work that kept the store finds it closed.
          store.close();
        }
        if (isThenable(result)) {
          // Whatever becomes of the promise, it is nobody's to wait for.
          Promise.resolve(result).catch(() => {});
          ending.fault = misuse(
            `the work given to ${name} returned a promise. It must not be async: it runs inside one database transaction, which cannot wait for anything. What it did was undone.`,
          );
          throw ending.fault;
        }
        return result;
      });
      return mode === "read" ? transaction.deferred() : transaction.immediate();
    } catch (error) {
      // The transaction has been undone by now.
      if (ending.late !== undefined && error === ending.late) end(outOfTime());
      if (ending.refusal !== undefined && error === ending.refusal) end({ kind: "gone", reason: ending.refusal.message });
      if (ending.fault !== undefined && error === ending.fault) end(failure(ending.fault));
      throw error;
    } finally {
      working = false;
    }
  }

  const cancelLimit = world.clock.after(RUN_TIME_LIMIT_MS, () => end(outOfTime()));
  const onStop = () => end({ kind: "stopped" });
  world.stop?.addEventListener("abort", onStop, { once: true });
  if (world.stop?.aborted) onStop();

  const ctx = Object.freeze({
    space: claim.space,
    settings: claim.settings,
    now: new Date(claim.startedAt),
    fetch: fetchFor(world.outbound, { hosts: code.app.manifest.network ?? [], signal: over.signal }),
    read: (work: unknown) => transact("read", work),
    write: (work: unknown) => transact("write", work),
  });

  try {
    if (state.outcome === null) {
      let returned: unknown;
      let threw = false;
      try {
        returned = code.job.run(ctx as never);
      } catch (error) {
        threw = true;
        end(failure(error));
      }
      if (!threw) {
        Promise.resolve(returned).then(
          () => end({ kind: "succeeded" }),
          (error: unknown) => end(failure(error)),
        );
      }
    }
    return await ended;
  } finally {
    cancelLimit();
    world.stop?.removeEventListener("abort", onStop);
  }
}

/* -------------------------------------------------------------------------
 * 3. Recording it
 * ---------------------------------------------------------------------- */

/** A message as it is kept: at most MAX_ERROR_LENGTH characters, ending in "…" when it was longer. */
export function keptError(message: string): string {
  const characters = Array.from(message);
  return characters.length <= MAX_ERROR_LENGTH ? message : `${characters.slice(0, MAX_ERROR_LENGTH - 1).join("")}…`;
}

/**
 * Records how a run went and when the job runs next, and lets the claim
 * go, in one immediate transaction. It finds the job's row by the run's
 * ID, so the row of an app that moved during the run is found where it now
 * is. A run whose claim was taken over, or whose app's data was deleted,
 * finds none, and nothing is recorded.
 *
 * - succeeded: `last_succeeded_at` is now and `failures` 0; the next run is
 *   the job's interval after this one started, plus up to a tenth of it
 *   (`random` picks how much: the jitter), or a minute from now when that
 *   has passed.
 * - failed: `last_failed_at` is now, `last_error` the message cut to 200
 *   characters, and `failures` one more; the next run waits 5 minutes,
 *   doubled for each failure in a row before this one, never more than the
 *   job's interval (the backoff: 5, 10, 20, 40, 60, 60 ... for an hourly
 *   job).
 * - stopped or gone: nothing is recorded, and the job is due at once.
 *
 * In every case `run_id` and `run_until` are cleared. Returns whether the
 * row was found.
 */
export function recordRun(
  db: Db,
  claim: Claim,
  outcome: RunOutcome,
  options: { readonly now: Date; readonly random: () => number },
): boolean {
  const now = options.now.getTime();
  const ended = options.now.toISOString();
  const at = (time: number) => new Date(Math.floor(time)).toISOString();
  return db
    .transaction((): boolean => {
      const row = db.prepare("SELECT failures FROM app_jobs WHERE run_id = ?").get(claim.runId) as
        | { failures: number }
        | undefined;
      if (row === undefined) return false;
      const bindings = { runId: claim.runId, ended };
      switch (outcome.kind) {
        case "succeeded": {
          const share = Math.min(Math.max(options.random(), 0), 1);
          let next = claim.startedAt.getTime() + claim.everyMinutes * MINUTE_MS * (1 + JITTER * share);
          if (next <= now) next = now + LATE_RUN_MS;
          db.prepare(
            `UPDATE app_jobs
                SET last_succeeded_at = @ended, failures = 0, next_run_at = @next, run_id = NULL, run_until = NULL
              WHERE run_id = @runId`,
          ).run({ ...bindings, next: at(next) });
          break;
        }
        case "failed": {
          const failures = row.failures + 1;
          const minutes = Math.min(claim.everyMinutes, FIRST_BACKOFF_MINUTES * 2 ** (failures - 1));
          db.prepare(
            `UPDATE app_jobs
                SET last_failed_at = @ended, last_error = @error, failures = @failures, next_run_at = @next,
                    run_id = NULL, run_until = NULL
              WHERE run_id = @runId`,
          ).run({ ...bindings, error: keptError(outcome.error), failures, next: at(now + minutes * MINUTE_MS) });
          break;
        }
        case "stopped":
        case "gone":
          db.prepare("UPDATE app_jobs SET next_run_at = @ended, run_id = NULL, run_until = NULL WHERE run_id = @runId").run(
            bindings,
          );
          break;
      }
      return true;
    })
    .immediate();
}

/**
 * Runs one job of one install if it may: claims it, runs it and records
 * how the run went. Gives why it did not run, or how the run ended. The
 * scheduler runs every job through this, and an app's own tests through
 * this with `force`: due or not, but never beside another run of the job.
 */
export async function runOnce(
  db: Db,
  registry: Registry,
  key: JobKey,
  world: RunWorld,
  options: { readonly force?: boolean } = {},
): Promise<RunOutcome | NoClaim> {
  const claim = claimRun(db, registry, key, { now: world.now(), force: options.force });
  if (typeof claim === "string") return claim;
  const outcome = await runClaimed(db, registry, claim, world);
  recordRun(db, claim, outcome, { now: world.now(), random: world.random });
  return outcome;
}

/* -------------------------------------------------------------------------
 * Which job runs next
 * ---------------------------------------------------------------------- */

/** A job of an install, and the first moment a run of it may be claimed. */
export type NextJob = {
  readonly key: JobKey;
  /** When it is due: now or earlier means at once. */
  readonly at: Date;
};

/**
 * The job the scheduler runs next: of every job of every install that is
 * there (the app's entry in its space and not removed, the app and the job
 * in this build), the one that falls due first, ties going by space ID, app
 * ID and job name. Null when no install has a job.
 *
 * - A job that has not run in an install has no row there yet: it is due
 *   now, and its row is made when it is claimed.
 * - A job that a run holds, in this process or in another one that shares
 *   the database, is due once that claim has run out (`run_until`), not
 *   before: the run records when the job is due after it.
 * - Otherwise it is due at its `next_run_at`, which a run asked for brought
 *   forward.
 *
 * It asks whether an install is there, never who may use it, and reads
 * `space_apps` and `app_jobs` in one query and nothing else: an app's rows
 * and settings are read by a run, one install at a time. A job that is due
 * here is one `claimRun` takes at the same moment, unless another process
 * claims or runs it in between.
 */
export function nextJob(db: Db, registry: Registry, now: Date): NextJob | null {
  const rows = db
    .prepare(
      `SELECT a.space_id AS spaceId, a.app_id AS appId,
              j.job, j.next_run_at AS nextRunAt, j.run_id AS runId, j.run_until AS runUntil
         FROM space_apps a
         LEFT JOIN app_jobs j ON j.space_id = a.space_id AND j.app_id = a.app_id
        WHERE a.removed_at IS NULL`,
    )
    .all() as {
    spaceId: string;
    appId: string;
    job: string | null;
    nextRunAt: string | null;
    runId: string | null;
    runUntil: string | null;
  }[];

  /** Each install there is, with the rows of its jobs by name. */
  const installs = new Map<string, { spaceId: string; appId: string; jobs: Map<string, (typeof rows)[number]> }>();
  for (const row of rows) {
    const id = JSON.stringify([row.spaceId, row.appId]);
    let install = installs.get(id);
    if (install === undefined) {
      install = { spaceId: row.spaceId, appId: row.appId, jobs: new Map() };
      installs.set(id, install);
    }
    if (row.job !== null) install.jobs.set(row.job, row);
  }

  const time = now.getTime();
  /** A stored time, or now should it not be one: claimRun takes such a job as due. */
  const timeOf = (text: string | null) => {
    const parsed = text === null ? Number.NaN : Date.parse(text);
    return Number.isNaN(parsed) ? time : parsed;
  };
  let next: { key: JobKey; at: number } | null = null;
  for (const { spaceId, appId, jobs } of installs.values()) {
    const server = registry.get(appId)?.server;
    if (server === undefined) continue;
    for (const [job, route] of Object.entries(server.routes)) {
      if (route.kind !== "job") continue;
      const row = jobs.get(job);
      const at =
        row === undefined
          ? time
          : held(row, now)
            ? Math.max(timeOf(row.nextRunAt), timeOf(row.runUntil))
            : timeOf(row.nextRunAt);
      const key = { spaceId, appId, job };
      if (next === null || at < next.at || (at === next.at && comesBefore(key, next.key))) next = { key, at };
    }
  }
  return next === null ? null : { key: next.key, at: new Date(next.at) };
}

/** Whether one job goes before another due at the same moment: by space ID, app ID and job name. */
function comesBefore(a: JobKey, b: JobKey): boolean {
  if (a.spaceId !== b.spaceId) return a.spaceId < b.spaceId;
  if (a.appId !== b.appId) return a.appId < b.appId;
  return a.job < b.job;
}

/* -------------------------------------------------------------------------
 * What people may do and see
 * ---------------------------------------------------------------------- */

/** A request about one job of an app in a space, from a signed-in person. */
export type JobRequest = AppRequest & { readonly job: string };

/**
 * A job's status, for anyone who may see the app: when its runs started,
 * went well and went wrong, why the last one went wrong, when it runs
 * next, and whether a run is going on or was asked for. A job that has not
 * run in this install answers nulls, `nextRunAt` now and "idle".
 *
 * Throws a Refusal: 404 when the app is not there for this person, has no
 * server file, or has no job of this name (a query's or a mutation's name
 * included).
 */
export function jobStatus(db: Db, registry: Registry, request: JobRequest, now: Date = new Date()): JobStatus {
  const { userId, spaceId, appId, job } = request;
  return db
    .transaction((): JobStatus => {
      if (resolveInstall(db, registry, userId, spaceId, appId) === null || codeOf(registry, appId, job) === undefined) {
        throw notFound();
      }
      return statusOf(rowOf(db, { spaceId, appId, job }), now);
    })
    .deferred();
}

/**
 * Asks for a run of a job now, as "Refresh now" does, and answers with the
 * job's status afterwards, in one immediate transaction.
 *
 * Unless a run is going on, `requested_at` becomes now, and `next_run_at`
 * the earlier of itself and the later of now and five minutes after the
 * last run started. A run asked for starts at once, or five minutes after
 * the last one started, never sooner, so that asking again and again
 * cannot hammer a host; a request is never refused for being early, and
 * during a run it changes nothing.
 *
 * Throws a Refusal: 404 as `jobStatus` does, then 403 for someone who may
 * only view the app.
 */
export function requestRun(db: Db, registry: Registry, request: JobRequest, now: Date = new Date()): JobStatus {
  const { userId, spaceId, appId, job } = request;
  return db
    .transaction((): JobStatus => {
      const access = resolveInstall(db, registry, userId, spaceId, appId);
      if (access === null || codeOf(registry, appId, job) === undefined) throw notFound();
      if (access !== "edit") {
        throw new Refusal(403, "forbidden", "Asking an app's job to run now needs edit access to the app.");
      }
      const key = { spaceId, appId, job };
      const row = rowOf(db, key);
      if (row !== undefined && held(row, now)) return statusOf(row, now);

      const time = now.getTime();
      const lastStart = row?.lastStartedAt == null ? -Infinity : Date.parse(row.lastStartedAt);
      // A job that has not run here is due at once.
      const due = row === undefined ? time : Date.parse(row.nextRunAt);
      const next = Math.min(due, Math.max(time, lastStart + REQUEST_GAP_MS));
      db.prepare(
        `INSERT INTO app_jobs (space_id, app_id, job, next_run_at, requested_at)
         VALUES (@spaceId, @appId, @job, @next, @now)
         ON CONFLICT (space_id, app_id, job) DO UPDATE
            SET next_run_at = excluded.next_run_at, requested_at = excluded.requested_at`,
      ).run({ ...key, next: new Date(next).toISOString(), now: now.toISOString() });
      return statusOf(rowOf(db, key), now);
    })
    .immediate();
}
