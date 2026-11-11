/**
 * The hooks a mini-app's widget and page are written with.
 *
 * ```tsx
 * import { appHooks } from "@hearth/sdk/web";
 * import type server from "./server";
 *
 * const { useApp, useQuery, useMutation } = appHooks<typeof server>();
 *
 * export default function Widget() {
 *   const { t, canEdit } = useApp();
 *   const items = useQuery("list");
 *   const tick = useMutation("tick");
 *   ...
 * }
 * ```
 *
 * `appHooks` is called once, at the top of the file, so that the three hooks
 * are plain names that begin with "use". Its type argument is what the app's
 * `server.ts` exports (imported with `import type`, so that none of the
 * server's code reaches the browser), or the manifest for an app without a
 * server file. From it follow the names of the routes, what each takes and
 * answers, the message keys of `t` and the type of `settings`.
 *
 * The hooks hold no logic: they read what the shell put around the widget
 * (see ./scope.ts). An app never builds an address and never sees a space
 * ID; the shell knows which app in which space it is drawing.
 *
 * Design: docs/mini-app-contract.md, section A4.
 */
import { useContext } from "react";
import type { Locale, Manifest, SettingsOf, SpaceKind, Translate } from "../index";
import type { AppServer, InputOf, OutputOf } from "../server";
import { AppScopeContext, type AppScopeValue } from "./scope";

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

/** What `useApp()` gives a widget or page. */
export type AppContext<S> = {
  /** One of the app's own interface strings (`manifest.messages`) in the reader's language: `t("left", { count: 3 })`. */
  t: Translate<S>;
  /** The language the reader has chosen. */
  locale: Locale;
  /** The signed-in person. */
  user: { id: string; name: string };
  /** The space the app is in, and everyone in it. A personal space has an empty name. */
  space: { kind: SpaceKind; name: string; members: { id: string; name: string }[] };
  /** What the person may do with the app here. */
  access: "view" | "edit";
  /** Whether the person may change anything. Without it every mutation is refused, so disable what would call one. */
  canEdit: boolean;
  /** Every setting of the manifest by name: the space's value, the person's own, or the default. */
  settings: SettingsOf<S>;
  /** The address of the app's own page, for a link to it; null when the app has no `page.tsx`. */
  pagePath: string | null;
};

/** What `useMutation(name)` gives. */
export type MutationResult<S, K> = {
  /**
   * Calls the mutation. When the promise resolves, the change is saved and
   * what the app's queries return is up to date, so the screen already
   * shows it. It rejects when the server refused the change or could not
   * be reached; `error` then says why. When the server refused it, the
   * app's queries are read again before the promise rejects, since the
   * refusal is often about something another person changed first. There
   * is no need to catch it: the shell tells the person, and a promise
   * nobody waits for is not reported.
   */
  run(...input: InputArgs<S, K>): Promise<Output<S, K>>;
  /** True from the call until the promise settles: disable the control that started it. */
  pending: boolean;
  /** Why the last call failed, or null: `forbidden`, `invalid_request`, `not_found`, `conflict`, `internal` or `network`. */
  error: { code: string } | null;
};

/** The three hooks, typed for one app. */
export type AppHooks<S> = {
  /** What the widget is being drawn for: the reader, the space, the settings and `t`. */
  useApp(): AppContext<S>;
  /**
   * The answer of one of the app's queries. The component waits (suspends)
   * until it is there, and the shell shows the loading and the failed state,
   * so the app has neither. The answer is read again after any mutation of
   * this app here that the server answered, saved or not, when the window is looked at again, and every 15 seconds
   * while it is visible, which is how people see each other's changes.
   */
  useQuery<K extends QueryName<S>>(name: K, ...input: InputArgs<S, K>): Output<S, K>;
  /** A way to call one of the app's mutations. Nothing is sent until `run` is called. */
  useMutation<K extends MutationName<S>>(name: K): MutationResult<S, K>;
};

function useScope(): AppScopeValue {
  const scope = useContext(AppScopeContext);
  if (!scope) {
    throw new Error("A mini-app's hooks only work inside its widget or page, where Hearth draws them.");
  }
  return scope;
}

const HOOKS = {
  useApp: () => useScope().app,
  useQuery: (name: string, input?: unknown) => useScope().useQuery(name, input),
  useMutation: (name: string) => useScope().useMutation(name),
};

/**
 * The hooks for one app. `S` is `typeof server` (the default export of the
 * app's `server.ts`) or, for an app without one, `typeof manifest`; then
 * there are no queries or mutations to name.
 */
export function appHooks<S extends AppLike>(): AppHooks<S> {
  return HOOKS as unknown as AppHooks<S>;
}
