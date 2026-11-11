import type { Context } from "hono";
import type { z } from "zod";
import { Refusal } from "./errors";

/**
 * Reads a JSON request body and checks it against its schema in
 * `@hearth/shared`. Anything else is refused with 400 `invalid_request`,
 * naming the first thing that is wrong.
 */
export async function readBody<T>(c: Context, schema: z.ZodType<T>): Promise<T> {
  let input: unknown;
  try {
    input = await c.req.json();
  } catch {
    throw new Refusal(400, "invalid_request", "The request body must be JSON.");
  }
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue && issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
    throw new Refusal(
      400,
      "invalid_request",
      issue ? `${where}${issue.message}` : "The request is not valid.",
    );
  }
  return parsed.data;
}
