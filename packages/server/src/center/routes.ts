/**
 * The routes of the app center (docs/center.md): publishing an app to a
 * group, publishing it again and unpublishing it. The request and answer
 * shapes are in `@hearth/shared`.
 */
import { publishRequestSchema, type PublishResult } from "@hearth/shared";
import type { Hono } from "hono";
import type { Registry } from "../apps/registry";
import type { Db } from "../db/database";
import { readBody } from "../http/body";
import type { Env, RequireMember } from "../http/env";
import { publishApp, reviewPublish, unpublishApp } from "./publish";

const PUBLISH = "/api/spaces/:spaceId/apps/:appId/publish";

/** Adds the routes to the application. Call it before the catch-all for unknown `/api` paths. */
export function registerCenterRoutes(app: Hono<Env>, deps: { db: Db; registry: Registry; requireMember: RequireMember }): void {
  const { db, registry, requireMember } = deps;

  // What would leave, where it may go, where it is published, and what refuses it.
  app.get(PUBLISH, requireMember, (c) => {
    const { spaceId, appId } = c.req.param();
    return c.json(reviewPublish(db, registry, { userId: c.get("user").id, spaceId, appId }));
  });

  // Publish the app to a group, or publish it there again.
  app.post(PUBLISH, requireMember, async (c) => {
    const { to, note } = await readBody(c, publishRequestSchema);
    const { spaceId, appId } = c.req.param();
    const { created, ...result } = publishApp(db, registry, { userId: c.get("user").id, spaceId, appId, to, note });
    return c.json(result satisfies PublishResult, created ? 201 : 200);
  });

  // Unpublish: the listing goes, and its copies stay as they are.
  app.delete("/api/center/:id", requireMember, (c) => {
    unpublishApp(db, { userId: c.get("user").id, id: c.req.param("id") });
    return c.body(null, 204);
  });
}
