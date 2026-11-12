/**
 * What an app's `server.ts` exports, as the server reads it, and the check
 * that it is fit to run.
 *
 * The export is made by `defineServer(...).routes(...)` in
 * `@hearth/sdk/server`, which only packages what the app's author wrote.
 * Types hold the author to the rules while they write; this check holds the
 * build to them when the server starts, where a problem stops a new release
 * before it replaces the old one (see registry.ts).
 *
 * Design: docs/mini-app-contract.md, sections A3 and A7, the owner's
 * decision 7 (every query, mutation and job says what it does), and for
 * jobs section C.
 */
import type { Manifest } from "@hearth/sdk";
import { ROW_FIELDS, type Job, type RouteDefinition, type z } from "@hearth/sdk/server";

/** The default export of an app's `server.ts`, once checked. */
export type ServerDefinition = {
  readonly manifest: Manifest;
  readonly collections: Readonly<Record<string, z.ZodObject>>;
  /** The app's queries, mutations and jobs, by name: one set of names for the three. */
  readonly routes: Readonly<Record<string, RouteDefinition | Job>>;
};

/** How often a job may run, in minutes: from every quarter of an hour to once a week. */
export const JOB_INTERVAL = { min: 15, max: 10_080 } as const;

/**
 * The names an app chooses that end up in a URL, a JSON path or a property:
 * routes, collections and the fields of a collection.
 */
export const PLAIN_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;
const PLAIN_NAME_RULE = "must be letters, digits and underscores, starting with a letter";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Whether this is a zod schema, by what the server calls on it. */
const isSchema = (value: unknown): value is z.ZodType =>
  isRecord(value) && typeof value.safeParse === "function";

/**
 * Checks what an app's `server.ts` exported. Returns everything that is
 * wrong with it, in words that name the place; an empty list means the
 * value is a ServerDefinition.
 */
export function checkServer(server: unknown, manifest: Manifest): string[] {
  if (!isRecord(server) || !isRecord(server.collections) || !isRecord(server.routes)) {
    return ["server: Must be the default export of server.ts, made with defineServer(manifest, collections).routes({ ... })."];
  }
  const problems: string[] = [];

  if (!isRecord(server.manifest) || server.manifest.id !== manifest.id) {
    problems.push("server: Was defined with another app's manifest. Pass this app's own manifest to defineServer.");
  }

  for (const [name, schema] of Object.entries(server.collections)) {
    const where = `server collection "${name}"`;
    if (!PLAIN_NAME.test(name)) problems.push(`${where}: Its name ${PLAIN_NAME_RULE}.`);
    if (!isSchema(schema) || !isRecord((schema as { shape?: unknown }).shape)) {
      problems.push(`${where}: Must be a zod object schema, z.object({ ... }).`);
      continue;
    }
    for (const field of Object.keys((schema as z.ZodObject).shape)) {
      if ((ROW_FIELDS as readonly string[]).includes(field)) {
        problems.push(`${where}: The field "${field}" has a name every row already has (${ROW_FIELDS.join(", ")}). Choose another.`);
      } else if (!PLAIN_NAME.test(field)) {
        problems.push(`${where}: The name of the field "${field}" ${PLAIN_NAME_RULE}.`);
      }
    }
  }

  for (const [name, route] of Object.entries(server.routes)) {
    const kind = isRecord(route) && isKind(route.kind) ? route.kind : undefined;
    const where = `server ${kind === "job" ? "job" : "route"} "${name}"`;
    if (!PLAIN_NAME.test(name)) problems.push(`${where}: Its name ${PLAIN_NAME_RULE}.`);
    if (!isRecord(route) || kind === undefined || typeof route.run !== "function") {
      problems.push(`${where}: Must be made with app.query(...), app.mutation(...) or app.job(...).`);
      continue;
    }
    if (typeof route.description !== "string" || route.description.trim() === "") {
      problems.push(
        `${where}: Needs a description, one English sentence saying what the ${kind} does, for a reader who has not seen the app.`,
      );
    }
    if (kind === "job") {
      problems.push(...jobProblems(where, route));
    } else if (route.input !== undefined && !isSchema(route.input)) {
      problems.push(`${where}: Its input must be a zod schema.`);
    }
  }

  return problems;
}

const KINDS = ["query", "mutation", "job"] as const;
const isKind = (value: unknown): value is (typeof KINDS)[number] => (KINDS as readonly unknown[]).includes(value);

/** What is wrong with a job besides its description: how often it runs, and an input it cannot be given. */
function jobProblems(where: string, job: Record<string, unknown>): string[] {
  const problems: string[] = [];
  const { everyMinutes } = job;
  if (
    typeof everyMinutes !== "number" ||
    !Number.isInteger(everyMinutes) ||
    everyMinutes < JOB_INTERVAL.min ||
    everyMinutes > JOB_INTERVAL.max
  ) {
    const given = everyMinutes === undefined ? "missing" : typeof everyMinutes === "number" ? String(everyMinutes) : JSON.stringify(everyMinutes);
    problems.push(
      `${where}: everyMinutes, how often it runs, must be a whole number of minutes from ${JOB_INTERVAL.min} to ${JOB_INTERVAL.max} (a week); it is ${given}.`,
    );
  }
  if (job.input !== undefined) {
    problems.push(`${where}: A job takes no input: it runs by itself, for no one. Leave input out.`);
  }
  return problems;
}
