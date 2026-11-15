/**
 * The routes about the assistant (docs/mini-app-contract.md, section F):
 * what an assistant may do in a space. Whether it may use one app there is
 * part of the access route (src/apps/routes.ts).
 */
import { assistantLevelRequestSchema } from "@hearth/shared";
import type { Hono } from "hono";
import type { Db } from "../db/database";
import { readBody } from "../http/body";
import type { Env, RequireMember } from "../http/env";
import { setAssistantLevel } from "./level";

export type AssistantRoutesOptions = { db: Db; requireMember: RequireMember };

/** Adds the routes to the application. Call it before the catch-all for unknown `/api` paths. */
export function registerAssistantRoutes(app: Hono<Env>, options: AssistantRoutesOptions): void {
  const { db, requireMember } = options;

  // What an assistant may do in the space: nothing, read, or read and change.
  app.put("/api/spaces/:spaceId/assistant", requireMember, async (c) => {
    const { level } = await readBody(c, assistantLevelRequestSchema);
    setAssistantLevel(db, { userId: c.get("user").id, spaceId: c.req.param("spaceId"), level });
    return c.body(null, 204);
  });
}
