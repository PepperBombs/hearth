/**
 * @hearth/sdk/server: what a mini-app's `server.ts` is written with.
 *
 * An app's server file says which collections of rows the app keeps, which
 * queries and mutations it answers, and which jobs it runs by itself:
 *
 * ```ts
 * import { defineServer, z } from "@hearth/sdk/server";
 * import manifest from "./manifest";
 *
 * const app = defineServer(manifest, {
 *   items: z.object({ name: z.string().trim().min(1).max(80), done: z.boolean().default(false) }),
 * });
 *
 * export default app.routes({
 *   list: app.query({ description: "Lists every item, oldest first." }, (ctx) => ctx.db.items.list()),
 *   add: app.mutation(
 *     { description: "Adds an item to the list.", input: z.object({ name: z.string() }) },
 *     (ctx, input) => ctx.db.items.insert({ ...input, done: false }),
 *   ),
 * });
 * ```
 *
 * This file holds types, two error classes and functions that only package
 * up what they are given. The framework does the work
 * (packages/server/src/apps): it decides who may call a route, opens the
 * transaction and hands the handler a `ctx` whose `db` reaches the rows of
 * this app in this space and no others. A mini-app never sees a database
 * handle or a space ID.
 *
 * The design is docs/mini-app-contract.md, section A3, with the owner's
 * decision 7 (every route says what it does), and for jobs and `ctx.fetch`
 * section C.
 */
import { z } from "zod";
import type { Locale, Manifest, SettingsOf, SpaceKind, SpaceSettingsOf } from "./index";

/** The one zod that mini-apps use, so that an app declares no dependency of its own. */
export { z };

/**
 * A value that survives being sent as JSON. An object may leave a property
 * undefined; it is then left out, as `JSON.stringify` does.
 */
export type Json =
  | string
  | number
  | boolean
  | null
  | readonly Json[]
  | { readonly [key: string]: Json | undefined };

/** The names every row has besides its own fields. A collection may not use them for a field. */
export const ROW_FIELDS = ["id", "createdBy", "updatedBy", "createdAt", "updatedAt"] as const;

/**
 * A stored row: the collection's fields, plus what the framework records.
 * `createdBy` and `updatedBy` are user IDs; the two times are ISO strings.
 */
export type Row<T> = T & {
  id: string;
  createdBy: string;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
};

export type ListOptions<T> = {
  /**
   * Only rows whose fields equal these. A value is text, a number, true,
   * false or null, and is compared together with its kind: `true` does not
   * match a stored 1. A key the collection does not have, a value of another
   * kind and an undefined value are errors: leave a key out to match all.
   */
  where?: Partial<T>;
  /** Only rows the caller created. */
  mine?: boolean;
  /** A field of the collection, or when the row was created or last changed. Default: `createdAt`. */
  orderBy?: Extract<keyof T, string> | "createdAt" | "updatedAt";
  /** Last first. Rows that tie are in the order they were inserted, reversed with `desc`. */
  desc?: boolean;
  /** At most this many rows. Default 1000; more than 5000 is an error. */
  limit?: number;
};

/** What a query may do with a collection: read. All of it is limited to this app in this space. */
export interface ReadCollection<T> {
  /** The row with this ID, or null. A row of another space or another app is not found. */
  get(id: string): Row<T> | null;
  list(options?: ListOptions<T>): Row<T>[];
  count(where?: Partial<T>): number;
}

/** What a mutation may do with a collection: read and write. */
export interface Collection<T> extends ReadCollection<T> {
  /**
   * Stores a row. The value is checked against the collection's schema; one
   * that does not fit throws `AppError("invalid_request")`, so a route need
   * not repeat the collection's rules in its input schema.
   */
  insert(value: T): Row<T>;
  /**
   * Replaces the given top-level fields of a row; a field given as undefined
   * is left as it is. The result is checked like an insert. An unknown ID
   * throws `AppError("not_found")`.
   */
  update(id: string, patch: Partial<T>): Row<T>;
  /** Deletes the row with this ID. An unknown ID is not an error. */
  remove(id: string): void;
  /** Deletes the rows whose fields equal these, as in `list`, and says how many went. `{}` deletes all. */
  removeWhere(where: Partial<T>): number;
}

/** The collections of an app: a zod object schema for each, by name. */
export type Collections = Record<string, z.ZodObject>;

type BaseCtx<M> = {
  /** The person the request is from. */
  readonly user: { readonly id: string; readonly name: string };
  /** The language that person reads. */
  readonly locale: Locale;
  /** The space the app is in. A personal space has an empty name. There is no ID: nothing in the SDK takes one. */
  readonly space: { readonly kind: SpaceKind; readonly name: string };
  /** What the caller may do. A mutation only ever runs with "edit". */
  readonly access: "view" | "edit";
  /** The space's values, the caller's own values, and defaults where nothing was saved. */
  readonly settings: SettingsOf<M>;
  /** When the request arrived. Rows written during it carry this time. */
  readonly now: Date;
};

/** What a query's handler receives. Its `db` has no way to write. */
export type QueryCtx<M, C extends Collections> = BaseCtx<M> & {
  readonly db: { readonly [K in keyof C]: ReadCollection<z.output<C[K]>> };
};

/** What a mutation's handler receives. */
export type MutationCtx<M, C extends Collections> = BaseCtx<M> & {
  readonly db: { readonly [K in keyof C]: Collection<z.output<C[K]>> };
};

/**
 * A route as the framework reads it: mini-apps make these with `app.query`
 * and `app.mutation` and never look inside.
 */
export type RouteDefinition = {
  readonly kind: "query" | "mutation";
  /** One English sentence saying what the route does. */
  readonly description: string;
  /** Checks what the caller sent. Absent for a route that takes nothing. */
  readonly input?: z.ZodType;
  readonly run: (ctx: never, input: never) => unknown;
};

/**
 * A query: reads and never changes data. `I` is what a caller sends (`void`
 * for nothing) and `O` what comes back; `__types` only carries those two for
 * the type checker and is never set.
 */
export type Query<I, O> = RouteDefinition & {
  readonly kind: "query";
  readonly __types?: { readonly input: I; readonly output: O };
};

/** A mutation: changes data, and needs edit access. */
export type Mutation<I, O> = RouteDefinition & {
  readonly kind: "mutation";
  readonly __types?: { readonly input: I; readonly output: O };
};

/** What a caller sends to a route: `void` when it takes nothing. */
export type InputOf<R> = R extends { readonly __types?: { readonly input: infer I } } ? I : never;
/** What a route answers with. */
export type OutputOf<R> = R extends { readonly __types?: { readonly output: infer O } } ? O : never;

/**
 * What every route says about itself.
 *
 * `description` is one English sentence saying what the route does, written
 * for a reader who has not seen the app: "Adds an item to the shopping
 * list." A later assistant picks routes by it, so it is required.
 */
export type RouteAbout = { description: string; input?: undefined };
/** The same for a route that takes input: `input` checks, and may reshape, what the caller sent. */
export type RouteAboutWithInput<I extends z.ZodType> = { description: string; input: I };

/* -------------------------------------------------------------------------
 * Jobs: what an app does by itself, every so often, once for each space it
 * is in, and the one way out to the network a job has, `ctx.fetch`.
 * ---------------------------------------------------------------------- */

/**
 * What every job says about itself, as a route does: one English sentence
 * saying what it does ("Fetches the latest headlines and keeps the newest
 * twenty."), for a reader who has not seen the app, and how often it runs.
 */
export type JobAbout = {
  /** One English sentence saying what the job does, for a reader who has not seen the app. */
  description: string;
  /** How often it runs, in minutes: a whole number from 15 to 10080 (a week). */
  everyMinutes: number;
};

/** A job as the framework reads it: made with `app.job`, listed in `app.routes`. */
export type Job = {
  readonly kind: "job";
  readonly description: string;
  readonly everyMinutes: number;
  readonly run: (ctx: never) => unknown;
};

/** What a job may send with a request besides the address. */
export type FetchInit = {
  /**
   * Extra headers: accept, accept-language, if-modified-since, if-none-match,
   * and names starting with "x-" but for x-forwarded-* and x-real-ip, each
   * once, with values of visible ASCII, spaces and tabs. Every request also
   * says `User-Agent: Hearth`. Any other header is refused.
   */
  readonly headers?: Readonly<Record<string, string>>;
};

/** An answer, read whole. A status that is not 2xx is an answer like any other, not an error. */
export type FetchResponse = {
  /** Where the answer came from, after redirects on the same host. */
  readonly url: string;
  readonly status: number;
  /** The status is 200 to 299. */
  readonly ok: boolean;
  /** Header names in lower case; set-cookie is left out. */
  readonly headers: Readonly<Record<string, string>>;
  /** The body, as UTF-8 text. */
  readonly text: string;
  /** The body parsed as JSON; throws when it is not JSON. */
  json(): unknown;
};

/** Why `ctx.fetch` gave no answer. */
export const FETCH_ERROR_CODES = ["refused", "timeout", "too_large", "network", "stopped"] as const;
export type FetchErrorCode = (typeof FETCH_ERROR_CODES)[number];

/**
 * What `ctx.fetch` rejects with when it has no answer to give:
 * - `refused`: the request breaks a rule and was not sent (not https, not a
 *   host the manifest lists, a header a job may not send), or a redirect
 *   leads off https or to another host;
 * - `timeout`: the whole answer did not arrive in time;
 * - `too_large`: the body grew past the limit, and the download stopped;
 * - `network`: no connection could be made;
 * - `stopped`: the run is over, because its time ran out or the server is
 *   stopping.
 * Unless the job catches it, the run fails with its message.
 */
export class FetchError extends Error {
  readonly code: FetchErrorCode;
  constructor(code: FetchErrorCode, message: string) {
    super(message);
    this.name = "FetchError";
    this.code = code;
  }
}

/**
 * What `work` may give back: anything but a promise. `work` runs inside one
 * transaction, which cannot wait for anything; a promise in its place
 * becomes a type error that says so.
 */
type NotAPromise<T> = T extends PromiseLike<unknown> ? "work must not be async: it runs inside one transaction" : T;

/**
 * What a job's function gets. A job runs for the app in one space, for no
 * one in it: there is no person, no access level and no language. What it
 * stores carries the ID of whoever added the app to the space.
 */
export type JobCtx<M, C extends Collections> = {
  /** The space the app is in. A personal space has an empty name. There is no ID. */
  readonly space: { readonly kind: SpaceKind; readonly name: string };
  /** The space's settings, defaults filled in, as they were when the run started. Nobody's own. */
  readonly settings: SpaceSettingsOf<M>;
  /** When the run started. */
  readonly now: Date;
  /**
   * GET from a host the manifest lists in `network`, over https on the
   * default port. Redirects are followed up to 3 times on the same host; an
   * answer takes at most 20 seconds and 2 MiB; requests to one host start
   * 6.5 seconds apart across the server. Rejects with a `FetchError` when
   * there is no answer.
   */
  fetch(url: string, init?: FetchInit): Promise<FetchResponse>;
  /** Reads the app's rows in this space in one transaction. `work` must not be async. */
  read<T>(work: (db: { readonly [K in keyof C]: ReadCollection<z.output<C[K]>> }) => NotAPromise<T>): T;
  /** Changes them in one immediate transaction, all of it or none. `work` must not be async. */
  write<T>(work: (db: { readonly [K in keyof C]: Collection<z.output<C[K]>> }) => NotAPromise<T>): T;
};

/** What an app's `server.ts` default-exports. Only the framework looks inside. */
export type AppServer<M, C, R> = {
  readonly manifest: M;
  readonly collections: C;
  readonly routes: R;
};

/** What `defineServer` returns. The names `search`, `files`, `exporter` and `upgrades` are reserved. */
export interface ServerBuilder<M, C extends Collections> {
  /**
   * A route that reads. Anyone who can see the app may call it. The handler
   * must not be `async`: it runs inside one database transaction together
   * with the check of who is asking, a handler that returns a promise is
   * refused, and `ctx.db` stops working once the handler has returned. What
   * it returns is sent as JSON.
   */
  query<O extends Json>(about: RouteAbout, run: (ctx: QueryCtx<M, C>) => O): Query<void, O>;
  query<I extends z.ZodType, O extends Json>(
    about: RouteAboutWithInput<I>,
    run: (ctx: QueryCtx<M, C>, input: z.output<I>) => O,
  ): Query<z.input<I>, O>;

  /**
   * A route that changes data. Only someone with edit access may call it.
   * Everything it writes is kept, or nothing is: an error thrown by the
   * handler undoes what it did. The same rule about `async` applies.
   */
  mutation<O extends Json | void>(about: RouteAbout, run: (ctx: MutationCtx<M, C>) => O): Mutation<void, O>;
  mutation<I extends z.ZodType, O extends Json | void>(
    about: RouteAboutWithInput<I>,
    run: (ctx: MutationCtx<M, C>, input: z.output<I>) => O,
  ): Mutation<z.input<I>, O>;

  /**
   * Something the app does by itself, every `everyMinutes`, once for each
   * space it is in, for no one in it. Its function may be `async`, because
   * it fetches (`ctx.fetch`, from the hosts the manifest lists in
   * `network`). It reads and writes the app's rows only through `ctx.read`
   * and `ctx.write`, whose `work` is not async, so that no transaction waits
   * on the network. A run went well when the function returned or its
   * promise resolved; whatever it throws or rejects with makes it fail.
   * A job is never called like a query or a mutation.
   */
  job(about: JobAbout, run: (ctx: JobCtx<M, C>) => Promise<void> | void): Job;

  /**
   * The app's queries, mutations and jobs by name: one set of names for the
   * three. A name is letters, digits and underscores, starting with a
   * letter. The result is the file's default export.
   */
  routes<R extends Record<string, Query<any, any> | Mutation<any, any> | Job>>(routes: R): AppServer<M, C, R>; // eslint-disable-line @typescript-eslint/no-explicit-any -- any input, any output
}

/**
 * Starts an app's server file: the manifest, and the app's collections.
 *
 * A collection is a zod object schema. Rows are checked against it when
 * they are written and again when they are read, so:
 * - give every field added later a `.default()`, or old rows stop being
 *   readable and the app's queries fail until that is put right. Rows
 *   stored before the field existed then read, match (`where`) and sort
 *   (`orderBy`) as if they held the default;
 * - the schema must accept what it produces (a transform that cannot be
 *   applied twice does not belong in a collection);
 * - field names are plain identifiers, and none is one of ROW_FIELDS.
 */
export function defineServer<M extends Manifest, const C extends Collections>(
  manifest: M,
  collections: C,
): ServerBuilder<M, C> {
  const route =
    (kind: RouteDefinition["kind"]) =>
    (about: { description: string; input?: z.ZodType }, run: RouteDefinition["run"]): RouteDefinition => ({
      kind,
      description: about.description,
      ...(about.input === undefined ? {} : { input: about.input }),
      run,
    });
  return {
    query: route("query"),
    mutation: route("mutation"),
    // An input given past the types is kept, so that the start-up check
    // refuses it rather than the job losing it without a word.
    job: (about: JobAbout & { input?: unknown }, run: Job["run"]): Job => ({
      kind: "job",
      description: about.description,
      everyMinutes: about.everyMinutes,
      ...(about.input === undefined ? {} : { input: about.input }),
      run,
    }),
    routes: (routes) => ({ manifest, collections, routes }),
  } as ServerBuilder<M, C>;
}

/** The ways a handler may turn a request down. Each becomes the HTTP answer of the same name. */
export const APP_ERROR_CODES = ["invalid_request", "not_found", "conflict"] as const;
export type AppErrorCode = (typeof APP_ERROR_CODES)[number];

/**
 * Thrown by a handler to turn a request down: 400 `invalid_request`, 404
 * `not_found` or 409 `conflict`. Whatever the mutation wrote is undone. The
 * message is in English, for logs and network traces; it reaches the caller,
 * so it must not say what the caller may not know. Any other error thrown by
 * a handler is a fault: it is logged and answered with 500.
 */
export class AppError extends Error {
  readonly code: AppErrorCode;
  constructor(code: AppErrorCode, message: string) {
    super(message);
    this.name = "AppError";
    this.code = code;
  }
}
