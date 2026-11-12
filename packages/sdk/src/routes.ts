/**
 * The names, inputs and outputs of an app's routes, and the names of its
 * jobs, read off its types.
 *
 * `S` stands for an app: what its `server.ts` default-exports, or its
 * manifest for an app without a server file (which has no routes). The
 * hooks of a widget (`@hearth/sdk/web`) and an app's tests
 * (`@hearth/sdk/testing`) both call routes by name, so both take these.
 * They are types only, and need neither React nor a browser.
 *
 * Mini-apps import them from `@hearth/sdk/web`, which re-exports them; this
 * file is no entry point of its own.
 */
import type { Manifest } from "./index";
import type { AppServer, InputOf, OutputOf } from "./server";

/** What may stand for an app: what its `server.ts` exports, or its manifest. */
export type AppLike = AppServer<unknown, unknown, unknown> | Manifest<unknown, unknown>;

/** The routes of `S`: none when `S` is a manifest. */
type RoutesOf<S> = S extends { readonly manifest: unknown; readonly routes: infer R } ? R : Record<never, never>;

type NamesOfKind<S, Kind extends string> = {
  [K in keyof RoutesOf<S>]: RoutesOf<S>[K] extends { readonly kind: Kind } ? K : never;
}[keyof RoutesOf<S>] &
  string;

/** The names of an app's queries. */
export type QueryName<S> = NamesOfKind<S, "query">;
/** The names of an app's mutations. */
export type MutationName<S> = NamesOfKind<S, "mutation">;
/**
 * The names of an app's jobs. They share one set of names with the queries
 * and mutations, but a job is never called like one: `QueryName` and
 * `MutationName` leave it out.
 */
export type JobName<S> = NamesOfKind<S, "job">;

type RouteOf<S, K> = K extends keyof RoutesOf<S> ? RoutesOf<S>[K] : never;

/**
 * What follows a route's name in a call: nothing for a route that takes no
 * input, otherwise the input, which may be left out when the route's schema
 * accepts that.
 */
export type InputArgs<S, K> =
  InputOf<RouteOf<S, K>> extends infer I
    ? [I] extends [void]
      ? []
      : undefined extends I
        ? [input?: I]
        : [input: I]
    : never;

/** What a route answers with. */
export type Output<S, K> = OutputOf<RouteOf<S, K>>;
