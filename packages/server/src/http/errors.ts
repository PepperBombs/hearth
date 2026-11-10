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
