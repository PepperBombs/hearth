/**
 * The routes for one app in one space (docs/mini-app-contract.md, section
 * A8). So far: add or bring back, remove, delete the data, and the app's
 * own queries and mutations. The request shapes are in `@hearth/shared`.
 * Only a query or mutation answers with a body; after the others the web
 * app reloads the session to see what changed.
 */
import { addAppRequestSchema, appCallRequestSchema, deleteAppDataRequestSchema } from "@hearth/shared";
import type { Hono } from "hono";
import type { Db } from "../db/database";
import { readBody } from "../http/body";
import type { Env, RequireMember } from "../http/env";
import { callApp } from "./calls";
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

  // An app's own routes: a query reads and needs view, a mutation changes
  // data and needs edit. Both are POST, because both carry their input in
  // the body. The kind is part of the address, so that a route which
  // changes data can never be reached as one that only reads.
  for (const [segment, kind] of [["q", "query"], ["m", "mutation"]] as const) {
    app.post(`/api/spaces/:spaceId/apps/:appId/${segment}/:name`, requireMember, async (c) => {
      const { input } = await readBody(c, appCallRequestSchema);
      const { spaceId, appId, name } = c.req.param();
      const answer = callApp(db, registry, { user: c.get("user"), spaceId, appId, kind, name, input });
      return c.body(answer, 200, { "content-type": "application/json" });
    });
  }
}
