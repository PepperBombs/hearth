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
  return parsed(schema, input);
}

function parsed<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    const issue = result.error.issues[0];
    const where = issue && issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
    throw new Refusal(
      400,
      "invalid_request",
      issue ? `${where}${issue.message}` : "The request is not valid.",
    );
  }
  return result.data;
}

/**
 * As `readBody`, for a request whose body may be left out: no body at all
 * reads as `{}`, and anything sent is checked as `readBody` checks it.
 */
export async function readOptionalBody<T>(c: Context, schema: z.ZodType<T>): Promise<T> {
  const text = await c.req.text();
  if (text.trim() === "") return parsed(schema, {});
  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch {
    throw new Refusal(400, "invalid_request", "The request body must be JSON.");
  }
  return parsed(schema, input);
}
