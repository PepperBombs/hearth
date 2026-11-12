import {
  preferencesPatchSchema,
  type Health,
  type Session,
  type User,
} from "@hearth/shared";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import { listAppsForUser } from "./apps/installs";
import { createRegistry, type BundledApp } from "./apps/registry";
import { registerAppRoutes } from "./apps/routes";
import { identifyFromConfig, type Identify } from "./auth";
import type { Config } from "./config";
import type { Db } from "./db/database";
import { listSpacesForUser, updatePreferences } from "./db/people";
import { groupRights } from "./groups/policy";
import { registerGroupRoutes } from "./groups/routes";
import { readBody } from "./http/body";
import type { Env, RequireMember } from "./http/env";
import { apiError, NOTHING_HERE, Refusal } from "./http/errors";
import { loopbackOnly, noStore, sameOrigin, securityHeaders } from "./http/security";
import { serveWebApp } from "./http/static";
import { resolveMember } from "./membership";

export type AppOptions = {
  config: Config;
  db: Db;
  /**
   * The mini-apps this build holds. Each manifest is checked here, and a bad
   * one throws AppRegistryError before anything is served.
   */
  apps: readonly BundledApp[];
  /** Defaults to the login method named by the configuration. */
  identify?: Identify;
  /** Receives unexpected errors. Defaults to the console. Nothing of them reaches the client. */
  logError?: (error: unknown) => void;
  /**
   * Called when a job may have fallen due at once: an app was added to a
   * space or brought back. main.ts gives the scheduler's `wake`
   * (src/apps/scheduler.ts), so that the app's jobs run without waiting for
   * the scheduler to look again. Left out when no job runs: with
   * HEARTH_JOBS=off, and in tests, since createApp starts no scheduler.
   */
  wakeJobs?: () => void;
};

const MAX_BODY_BYTES = 64 * 1024;

/**
 * Builds the application without listening, so tests can call it directly.
 * Throws AppRegistryError when one of the given mini-apps is not valid.
 */
export function createApp(options: AppOptions): Hono<Env> {
  const { config, db } = options;
  const registry = createRegistry(options.apps);
  const identify = options.identify ?? identifyFromConfig(config.auth);
  const logError = options.logError ?? ((error: unknown) => console.error(error));

  /** Lets members through and puts the user on the context. */
  const requireMember: RequireMember = async (c, next) => {
    const identity = await identify(c.req.raw);
    if (!identity) {
      return apiError(c, 401, "unauthenticated", "This request carries no valid sign-in.");
    }
    const user = resolveMember(db, {
      email: identity.email,
      ownerEmail: config.ownerEmail,
      acceptLanguage: c.req.header("accept-language"),
    });
    if (!user) {
      return apiError(c, 403, "not_a_member", "This account has not been invited to this server.");
    }
    c.set("user", user);
    return next();
  };

  const app = new Hono<Env>();

  app.use(securityHeaders());
  // Dev mode signs everyone in, so it answers this machine only: pages too, not just /api.
  if (config.auth.mode === "dev") app.use(loopbackOnly());

  app.use("/api/*", noStore());
  app.use("/api/*", sameOrigin({ allowLoopbackOrigins: config.auth.mode === "dev" }));
  app.use(
    "/api/*",
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: (c) => apiError(c, 413, "invalid_request", "The request body is too large."),
    }),
  );

  app.get("/api/health", (c) => {
    const body: Health = { ok: true, version: config.version };
    return c.json(body);
  });

  app.get("/api/session", requireMember, (c) => {
    const user = c.get("user");
    const body: Session = {
      user,
      spaces: listSpacesForUser(db, user.id),
      apps: listAppsForUser(db, registry, user.id),
      // The same answer the routes that create a group or invite someone ask for.
      ...groupRights(config, user),
      version: config.version,
    };
    return c.json(body);
  });

  app.patch("/api/me", requireMember, async (c) => {
    const patch = await readBody(c, preferencesPatchSchema);
    const user = updatePreferences(db, c.get("user").id, patch);
    if (!user) throw new Error("The signed-in user disappeared while being updated.");
    return c.json(user satisfies User);
  });

  registerGroupRoutes(app, { db, config, requireMember });
  registerAppRoutes(app, { db, registry, requireMember, wakeJobs: options.wakeJobs ?? (() => {}) });

  app.all("/api", (c) => apiError(c, 404, "not_found", NOTHING_HERE));
  app.all("/api/*", (c) => apiError(c, 404, "not_found", NOTHING_HERE));

  app.get("*", serveWebApp(config.webDist));

  app.notFound((c) => apiError(c, 404, "not_found", NOTHING_HERE));

  app.onError((error, c) => {
    if (error instanceof Refusal) return apiError(c, error.status, error.code, error.message);
    if (error instanceof HTTPException && error.status < 500) {
      return apiError(c, error.status, "invalid_request", "The request could not be handled.");
    }
    logError(error);
    return apiError(c, 500, "internal", "Something went wrong on the server.");
  });

  return app;
}
