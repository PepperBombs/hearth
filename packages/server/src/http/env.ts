import type { User } from "@hearth/shared";
import type { MiddlewareHandler } from "hono";

/**
 * What the middleware puts on a request's context for the routes behind it.
 * `sandboxed` is set by the route that serves a made app's page, so that the
 * security headers are the sandbox's (src/made/frame.ts).
 */
export type Env = { Variables: { user: User; sandboxed?: boolean } };

/** Lets members of this server through and puts the user on the context. */
export type RequireMember = MiddlewareHandler<Env>;
