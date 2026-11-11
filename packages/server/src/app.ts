import {
  preferencesPatchSchema,
  type Health,
  type Session,
  type User,
} from "@hearth/shared";
import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import { identifyFromConfig, type Identify } from "./auth";
import type { Config } from "./config";
import type { Db } from "./db/database";
import { listSpacesForUser, updatePreferences } from "./db/people";
import { apiError } from "./http/errors";
import { loopbackOnly, noStore, sameOrigin, securityHeaders } from "./http/security";
import { serveWebApp } from "./http/static";
import { resolveMember } from "./membership";

export type AppOptions = {
  config: Config;
  db: Db;
  /** Defaults to the login method named by the configuration. */
  identify?: Identify;
  /** Receives unexpected errors. Defaults to the console. Nothing of them reaches the client. */
  logError?: (error: unknown) => void;
};

type Env = { Variables: { user: User } };

const MAX_BODY_BYTES = 64 * 1024;

/** Builds the application without listening, so tests can call it directly. */
export function createApp(options: AppOptions): Hono<Env> {
  const { config, db } = options;
  const identify = options.identify ?? identifyFromConfig(config.auth);
  const logError = options.logError ?? ((error: unknown) => console.error(error));

  /** Lets members through and puts the user on the context. */
  const requireMember: MiddlewareHandler<Env> = async (c, next) => {
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
      // The server does not know about mini-apps yet (docs/mini-app-contract.md, step 4).
      apps: [],
      // Groups cannot be created or added to yet. Who may is decided in one
      // place when they can (step 10): for now, the server's owner alone.
      canCreateGroups: false,
      canInvitePeople: false,
      version: config.version,
    };
    return c.json(body);
  });

  app.patch("/api/me", requireMember, async (c) => {
    let input: unknown;
    try {
      input = await c.req.json();
    } catch {
      return apiError(c, 400, "invalid_request", "The request body must be JSON.");
    }
    const patch = preferencesPatchSchema.safeParse(input);
    if (!patch.success) {
      const issue = patch.error.issues[0];
      const where = issue && issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
      return apiError(
        c,
        400,
        "invalid_request",
        issue ? `${where}${issue.message}` : "The request is not valid.",
      );
    }
    const user = updatePreferences(db, c.get("user").id, patch.data);
    if (!user) throw new Error("The signed-in user disappeared while being updated.");
    return c.json(user satisfies User);
  });

  app.all("/api", (c) => apiError(c, 404, "not_found", "There is nothing at this address."));
  app.all("/api/*", (c) => apiError(c, 404, "not_found", "There is nothing at this address."));

  app.get("*", serveWebApp(config.webDist));

  app.notFound((c) => apiError(c, 404, "not_found", "There is nothing at this address."));

  app.onError((error, c) => {
    if (error instanceof HTTPException && error.status < 500) {
      return apiError(c, error.status, "invalid_request", "The request could not be handled.");
    }
    logError(error);
    return apiError(c, 500, "internal", "Something went wrong on the server.");
  });

  return app;
}
