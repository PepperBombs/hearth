import type { ApiError, ApiErrorCode } from "@hearth/shared";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

/**
 * A failure in the shared error shape. The message is for people reading
 * logs and network traces, in English; the web app chooses what to show from
 * the code, in the person's own language.
 */
export function apiError(
  c: Context,
  status: ContentfulStatusCode,
  code: ApiErrorCode,
  message: string,
): Response {
  const body: ApiError = { error: { code, message } };
  return c.json(body, status);
}

/** What an address answers when there is nothing there, or nothing this person may know of. */
export const NOTHING_HERE = "There is nothing at this address.";

/**
 * A request that is turned down on purpose: thrown anywhere below a route,
 * also inside a database transaction (which it rolls back), and answered by
 * the application's error handler in the shared error shape. Unlike any
 * other error it is not logged, and its message does reach the client, so
 * the message must say nothing the person may not know.
 */
export class Refusal extends Error {
  readonly status: 400 | 403 | 404 | 409;
  readonly code: ApiErrorCode;
  constructor(status: 400 | 403 | 404 | 409, code: ApiErrorCode, message: string) {
    super(message);
    this.name = "Refusal";
    this.status = status;
    this.code = code;
  }
}

/**
 * The 404 for a space or an app the person is not in, has no access to, or
 * that does not exist. One answer for all of them, so that it reveals nothing.
 */
export function notFound(): Refusal {
  return new Refusal(404, "not_found", NOTHING_HERE);
}
