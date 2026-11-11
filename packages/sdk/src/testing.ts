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
 * This file holds the types and a hand-over: the framework supplies the
 * implementation when `hearth-apps test` runs an app's tests, inside its
 * server package (packages/server/src/apps/app-testing.ts). Run them with
 * that command, which is `pnpm test` in a mini-apps repository; `vitest`
 * started by hand has no store to call.
 *
 * Design: docs/mini-app-contract.md, section A9.
 */
import type { Locale, SettingsOf, SpaceKind } from "./index";
import type { InputArgs, MutationName, Output, QueryName } from "./routes";
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
};

/** An app in a space of a database of its own: what `testApp(server)` gives. */
export type TestApp<S> = {
  /** The space the app is in. A personal space has an empty name. There is no ID. */
  readonly space: { readonly kind: SpaceKind; readonly name: string };
  /** Someone in the space, by name: someone new, or someone already there. */
  as(person?: TestPerson): TestCaller<S>;
};

/** The ways the server turns a call down. */
export const APP_CALL_ERROR_CODES = ["invalid_request", "forbidden", "not_found", "conflict"] as const;
export type AppCallErrorCode = (typeof APP_CALL_ERROR_CODES)[number];

/**
 * A call the server turned down, with the answer a browser would have had:
 * 400 `invalid_request` (the input or a setting's value does not fit, or the
 * handler threw `AppError("invalid_request")`), 403 `forbidden` (a mutation
 * or a setting of the space, with "view"), 404 `not_found` (no route of that
 * name and kind, or the handler threw `AppError("not_found")`) or 409
 * `conflict`. The message starts with the code, so that
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
