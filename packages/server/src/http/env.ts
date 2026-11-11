import type { User } from "@hearth/shared";
import type { MiddlewareHandler } from "hono";

/** What the middleware puts on a request's context for the routes behind it. */
export type Env = { Variables: { user: User } };

/** Lets members of this server through and puts the user on the context. */
export type RequireMember = MiddlewareHandler<Env>;
