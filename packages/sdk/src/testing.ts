/**
 * `@hearth/sdk/testing`: what a mini-app's tests are written with.
 *
 * ```ts
 * // grocery/grocery.test.ts
 * import { testApp } from "@hearth/sdk/testing";
 * import { expect, it } from "vitest";
 * import server from "./server";
 *
 * it("shows what one person adds to everyone in the space", () => {
 *   const app = testApp(server);
 *   const sam = app.as({ name: "Sam" });
 *   const lin = app.as({ name: "Lin", access: "view" });
 *
 *   sam.mutation("add", { name: "Milk" });
 *   expect(lin.query("list")).toMatchObject([{ name: "Milk", done: false }]);
 *   expect(() => lin.mutation("clearTicked")).toThrow("forbidden");
 * });
 * ```
 *
 * `testApp(server)` gives the app a database of its own, empty and in
 * memory, and adds the app to a space in it: a group, unless the manifest
 * allows personal spaces only. `as(...)` is someone in that space. Their
 * calls are answered the way the server answers a browser: the same check of
 * who may do what, the same check of the input, the same `ctx`, store and
 * transaction, and the answer passed through JSON. A refusal throws
 * `AppCallError`, whose message starts with its code.
 *
 * A job runs with `runJob`, as the server's scheduler runs it, while a
 * function of the test answers what it fetches:
 *
 * ```ts
 * it("keeps the feed's headlines", async () => {
 *   const app = testApp(server);
 *   const run = await app.runJob("refresh", {
 *     fetch: () => ({ body: { items: [{ title: "Rain tomorrow" }] } }),
 *   });
 *   expect(run).toEqual({ ok: true, error: null });
 *   expect(app.as().query("latest")).toMatchObject([{ title: "Rain tomorrow" }]);
 * });
 * ```
 *
 * This file holds the types and a hand-over: the framework supplies the
 * implementation when `hearth-apps test` runs an app's tests, inside its
 * server package (packages/server/src/apps/app-testing.ts). Run them with
 * that command, which is `pnpm test` in a mini-apps repository; `vitest`
 * started by hand has no store to call.
 *
 * Design: docs/mini-app-contract.md, sections A9 and C ("Testing").
 */
import type { Locale, SettingsOf, SpaceKind } from "./index";
import type { InputArgs, JobName, JobState, MutationName, Output, QueryName } from "./routes";
import type { AppServer } from "./server";
import { providedTestApp } from "./testing-host";

/** Where `testApp` puts the app. */
export type TestAppOptions = {
  /**
   * The kind of space the app is added to. Left out, a group, unless the
   * manifest allows personal spaces only. A kind the manifest leaves out is
   * an error, as adding the app there would be.
   */
  space?: SpaceKind;
};

/** Someone in the space, calling the app. */
export type TestPerson = {
  /**
   * Who it is. The same name is the same person for as long as this
   * `testApp` lasts: what they create carries their user ID, and `mine`
   * finds it. Default: "Sam". A personal space has one person.
   */
  name?: string;
  /**
   * What they may do with the app: "view" calls queries, "edit" mutations
   * too. Each caller keeps the access it was made with, so one person may
   * be had both ways. In a personal space it is always "edit". Default: "edit".
   */
  access?: "view" | "edit";
  /** The language they read, which a handler sees as `ctx.locale`. Default: "en". */
  locale?: Locale;
};

/**
 * A request a job made with `ctx.fetch`, as a stand-in sees it once the
 * rules let it through: an https address on a host the manifest lists, its
 * query included. The headers are those sent, names in lower case,
 * `user-agent: Hearth` among them.
 */
export type StandInRequest = { readonly url: string; readonly headers: Readonly<Record<string, string>> };

/**
 * A stand-in's answer: status 200 unless given (200 to 599), headers HTTP
 * allows, and a body sent as is when it is text and as JSON otherwise
 * (none with 204, 205 and 304). A redirect on the same host is followed, as
 * on a server. An answer that HTTP could not carry fails the test.
 */
export type StandInAnswer = { status?: number; headers?: Record<string, string>; body?: unknown };

/**
 * Answers the requests of a job that `runJob` runs, in place of the
 * network: at once, and without the pace a server keeps. Throwing, or
 * rejecting, fails the request as the network would: a `FetchError` of code
 * "timeout" or "network" (from `@hearth/sdk/server`) as itself, anything
 * else as "network", with its message.
 */
export type StandInFetch = (request: StandInRequest) => StandInAnswer | Promise<StandInAnswer>;

/**
 * How a run went: it went well, or it failed, with the whole message of
 * what made it fail, on one line.
 */
export type JobRun = { ok: true; error: null } | { ok: false; error: string };

/** What `runJob` takes. */
export type RunJobOptions = {
  /** Answers every request the job makes. Left out, each request fails as the network would. */
  fetch?: StandInFetch;
  /**
   * When the run starts and ends: the job's `ctx.now`, the time its rows
   * are written and the times its status keeps. Default: the time of day.
   */
  now?: Date;
};

/** One person calling the app: what `testApp(server).as(...)` gives. */
export type TestCaller<S> = {
  /** The person as a handler sees them (`ctx.user`): compare a row's `createdBy` with `user.id`. */
  readonly user: { readonly id: string; readonly name: string };
  /** Calls a query and gives its answer, as the server sends it: through JSON. */
  query<K extends QueryName<S>>(name: K, ...input: InputArgs<S, K>): Output<S, K>;
  /** Calls a mutation and gives its answer. It needs "edit". */
  mutation<K extends MutationName<S>>(name: K, ...input: InputArgs<S, K>): Output<S, K>;
  /** Every setting by name, as `ctx.settings` holds them for this person: the space's, their own, defaults. */
  settings(): SettingsOf<S>;
  /**
   * Saves settings by name, as the settings form does, and gives every
   * setting as it is afterwards. One of the space needs "edit"; a person's
   * own needs "view". A request is saved whole or not at all.
   */
  saveSettings(values: Partial<SettingsOf<S>>): SettingsOf<S>;
  /**
   * How one of the app's jobs is doing in the space, as `useJob` shows it to
   * this person: when the last run that went well ended, when the last run
   * failed if the last to end did, whether a run is going on or was asked
   * for, and whether this person may ask for one (edit). Before the first
   * run every time is null.
   */
  job<K extends JobName<S>>(name: K): Omit<JobState, "run" | "pending">;
  /**
   * Asks for a run now, as "Refresh now" does, and gives the job's status
   * afterwards: `running` is true from then until a run has started and
   * ended. It needs "edit". Nothing here runs it by itself: `runJob` runs
   * the job, as the server's scheduler would.
   */
  requestRun<K extends JobName<S>>(name: K): Omit<JobState, "run" | "pending">;
};

/** An app in a space of a database of its own: what `testApp(server)` gives. */
export type TestApp<S> = {
  /** The space the app is in. A personal space has an empty name. There is no ID. */
  readonly space: { readonly kind: SpaceKind; readonly name: string };
  /** Someone in the space, by name: someone new, or someone already there. */
  as(person?: TestPerson): TestCaller<S>;
  /**
   * Runs one of the app's jobs now, in the app's space, as the server's
   * scheduler runs it: claimed, run and recorded by the same code, with the
   * space's settings, the rules of `ctx.fetch` and the run's 5 minutes, due
   * or not. `fetch` answers what passes the rules. Resolves once the run is
   * recorded, with how it went; a caller's `job(name)` shows it then.
   *
   * It rejects, and the test fails, for what a test gets wrong: a run of
   * the same job going on (await one before the next), a stand-in's answer
   * that HTTP could not carry, and, in a personal space, a run before its
   * one person was named with `as(...)`, which adds the app there.
   */
  runJob<K extends JobName<S>>(name: K, options?: RunJobOptions): Promise<JobRun>;
};

/** The ways the server turns a call down. */
export const APP_CALL_ERROR_CODES = ["invalid_request", "forbidden", "not_found", "conflict"] as const;
export type AppCallErrorCode = (typeof APP_CALL_ERROR_CODES)[number];

/**
 * A call the server turned down, with the answer a browser would have had:
 * 400 `invalid_request` (the input or a setting's value does not fit, or the
 * handler threw `AppError("invalid_request")`), 403 `forbidden` (a mutation,
 * a setting of the space or a run asked for, with "view"), 404 `not_found`
 * (no route or job of that name and kind, or the handler threw
 * `AppError("not_found")`) or 409 `conflict`. The message starts with the code, so that
 * `expect(() => ...).toThrow("forbidden")` says what it means.
 *
 * Whatever else a handler does wrong (another error, a promise, an answer
 * that is not JSON) is no refusal: the test gets the error the server would
 * log, and fails.
 */
export class AppCallError extends Error {
  readonly status: 400 | 403 | 404 | 409;
  readonly code: AppCallErrorCode;
  constructor(status: 400 | 403 | 404 | 409, code: AppCallErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "AppCallError";
    this.status = status;
    this.code = code;
  }
}

/**
 * An app, given by what its `server.ts` default-exports, in a space of a
 * database of its own. Each call starts afresh, so each test can have its
 * own. The app is checked first, as the server checks it at start-up: a
 * manifest or server file the server would refuse throws here.
 */
export function testApp<S extends AppServer<unknown, unknown, unknown>>(
  server: S,
  options: TestAppOptions = {},
): TestApp<S> {
  const implementation = providedTestApp();
  if (!implementation) {
    throw new Error(
      'testApp needs the Hearth framework, which runs an app\'s tests with its own store and database. Run them with "hearth-apps test" ("pnpm test" in a mini-apps repository), not with vitest by itself.',
    );
  }
  return implementation(server, options) as unknown as TestApp<S>;
}
