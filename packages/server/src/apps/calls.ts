/**
 * Running a mini-app's query or mutation for a signed-in person.
 *
 * One function does it, `callApp`, and everything happens inside one
 * database transaction: the check of who is asking, then the handler. A
 * change of access or a move of the app therefore cannot land between the
 * two, and what a mutation wrote is kept as a whole or not at all.
 *
 * The handler gets a `ctx` whose `db` is built here from the space and app
 * of the address and from the signed-in person, never from the request body
 * or from anything the app says (see store.ts).
 *
 * Design: docs/mini-app-contract.md, sections A3 and A6.
 */
import { AppError, type Json, type RouteDefinition } from "@hearth/sdk/server";
import type { SpaceKind, User } from "@hearth/shared";
import type { Db } from "../db/database";
import { notFound, Refusal } from "../http/errors";
import { resolveInstall } from "./installs";
import type { Registry } from "./registry";
import { settingsFor } from "./settings";
import { readOnlyStore, writableStore } from "./store";

export type AppCall = {
  /** The signed-in person. */
  user: User;
  spaceId: string;
  appId: string;
  kind: RouteDefinition["kind"];
  /** The route's name in the app's `server.ts`. */
  name: string;
  /** What the caller sent, not yet checked; undefined when they sent nothing. */
  input: Json | undefined;
};

/**
 * A fault in a mini-app's own code while it answered a request: its handler
 * threw, returned a promise, or returned something that is not JSON. The
 * cause, when there is one, is the error the handler threw.
 */
export class AppFaultError extends Error {
  constructor(call: Pick<AppCall, "appId" | "kind" | "name">, reason: string, cause?: unknown) {
    super(`Mini-app "${call.appId}": the ${call.kind} "${call.name}" ${reason}`, { cause });
    this.name = "AppFaultError";
  }
}

const STATUS = { invalid_request: 400, not_found: 404, conflict: 409 } as const;

const isThenable = (value: unknown): value is PromiseLike<unknown> =>
  (typeof value === "object" || typeof value === "function") &&
  value !== null &&
  typeof (value as { then?: unknown }).then === "function";

/** Checks what the caller sent against the route's own schema. */
function readInput(route: RouteDefinition, input: Json | undefined): unknown {
  if (!route.input) {
    if (input !== undefined) throw new Refusal(400, "invalid_request", "input: This route takes no input.");
    return undefined;
  }
  const parsed = route.input.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue && issue.path.length > 0 ? `.${issue.path.map(String).join(".")}` : "";
    throw new Refusal(400, "invalid_request", `input${where}: ${issue?.message ?? "Not valid."}`);
  }
  return parsed.data;
}

/**
 * Runs one query or mutation and returns the answer as JSON text in the
 * shape of `appCallResponseSchema`: `{"output": ...}`, or `{}` for a route
 * that returns nothing.
 *
 * Throws a Refusal:
 * - 404 when the app is not there for this person (see `resolveInstall`),
 *   or has no route of this kind and name;
 * - 403 for a mutation by someone who may only view;
 * - 400 when the input does not fit the route's schema;
 * - 400, 404 or 409 when the handler throws an `AppError`.
 * Anything else the handler does wrong is an AppFaultError, which the
 * application logs and answers with 500. Whatever is thrown, nothing the
 * mutation wrote is kept.
 */
export function callApp(db: Db, registry: Registry, call: AppCall): string {
  const { user, spaceId, appId, kind, name } = call;

  const run = db.transaction((): string => {
    const access = resolveInstall(db, registry, user.id, spaceId, appId);
    if (access === null) throw notFound();
    const app = registry.get(appId);
    const route =
      app?.server && Object.hasOwn(app.server.routes, name) ? app.server.routes[name] : undefined;
    // A query asked for as a mutation is not there either: it would run with a store that can write.
    if (!app?.server || !route || route.kind !== kind) throw notFound();
    if (kind === "mutation" && access !== "edit") {
      throw new Refusal(403, "forbidden", "Changing anything in this app needs edit access to it.");
    }
    // After the checks, so that the input's faults are told only to someone who may use the app.
    const input = readInput(route, call.input);

    const space = db.prepare("SELECT kind, name FROM spaces WHERE id = ?").get(spaceId) as {
      kind: SpaceKind;
      name: string;
    };
    const now = new Date();
    // The scope comes from the address and the sign-in, both checked above.
    const scope = { spaceId, appId, userId: user.id, now };
    const ctx = Object.freeze({
      user: Object.freeze({ id: user.id, name: user.name }),
      locale: user.locale,
      space: Object.freeze({ kind: space.kind, name: space.name }),
      access,
      settings: settingsFor(app.manifest),
      now: new Date(now),
      db: Object.freeze(
        kind === "query"
          ? readOnlyStore(db, scope, app.server.collections)
          : writableStore(db, scope, app.server.collections),
      ),
    });

    let output: unknown;
    try {
      output = route.run(ctx as never, input as never);
    } catch (error) {
      if (error instanceof AppError && Object.hasOwn(STATUS, error.code)) {
        throw new Refusal(STATUS[error.code], error.code, error.message);
      }
      throw new AppFaultError(call, "failed.", error);
    }

    if (isThenable(output)) {
      // Whatever becomes of the promise, it is nobody's to wait for.
      Promise.resolve(output).catch(() => {});
      throw new AppFaultError(
        call,
        "returned a promise. A handler must not be async: it runs inside one database transaction and cannot wait for anything.",
      );
    }

    // Inside the transaction, so that an answer that cannot be sent undoes the change it reports.
    try {
      return JSON.stringify(output === undefined ? {} : { output });
    } catch (error) {
      throw new AppFaultError(call, "returned something that cannot be sent as JSON.", error);
    }
  });

  return kind === "query" ? run.deferred() : run.immediate();
}
