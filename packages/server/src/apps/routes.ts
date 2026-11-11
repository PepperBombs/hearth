/**
 * The routes for one app in one space (docs/mini-app-contract.md, section
 * A8). So far: add or bring back, remove, and delete the data. The request
 * shapes are in `@hearth/shared`. None of them answers with a body: the web
 * app reloads the session to see what changed.
 */
import { addAppRequestSchema, deleteAppDataRequestSchema } from "@hearth/shared";
import type { Hono } from "hono";
import type { Db } from "../db/database";
import { readBody } from "../http/body";
import type { Env, RequireMember } from "../http/env";
import { addApp, deleteAppData, removeApp } from "./installs";
import type { Registry } from "./registry";

export type AppRoutesOptions = { db: Db; registry: Registry; requireMember: RequireMember };

/** Adds the routes to the application. Call it before the catch-all for unknown `/api` paths. */
export function registerAppRoutes(app: Hono<Env>, options: AppRoutesOptions): void {
  const { db, registry, requireMember } = options;

  // Add an app to a space, or bring a removed one back with its data.
  app.put("/api/spaces/:spaceId/apps/:appId", requireMember, async (c) => {
    const { memberAccess } = await readBody(c, addAppRequestSchema);
    const { spaceId, appId } = c.req.param();
    addApp(db, registry, { userId: c.get("user").id, spaceId, appId, memberAccess });
    return c.body(null, 204);
  });

  // Remove an app from a space. Its data is kept.
  app.delete("/api/spaces/:spaceId/apps/:appId", requireMember, (c) => {
    const { spaceId, appId } = c.req.param();
    removeApp(db, registry, { userId: c.get("user").id, spaceId, appId });
    return c.body(null, 204);
  });

  // Delete the data of an app that was removed or whose code is gone.
  app.delete("/api/spaces/:spaceId/apps/:appId/data", requireMember, async (c) => {
    const { confirm } = await readBody(c, deleteAppDataRequestSchema);
    const { spaceId, appId } = c.req.param();
    deleteAppData(db, registry, { userId: c.get("user").id, spaceId, appId, confirm });
    return c.body(null, 204);
  });
}
