/**
 * The routes for apps in a space (docs/mini-app-contract.md, section A8):
 * the owners' list of a space's apps and who can use them, and for one app
 * add or bring back, remove, delete the data, who can use it, each person's
 * own switch and pin, the app's settings, and the app's own queries and
 * mutations. Moving an app to another space is not built yet. The request
 * shapes are in `@hearth/shared`. The owners' list, the settings routes and
 * a query or mutation answer with a body; after the others the web app
 * reloads the session to see what changed.
 */
import {
  addAppRequestSchema,
  appAccessRequestSchema,
  appCallRequestSchema,
  appPrefsPatchSchema,
  appSettingsPatchSchema,
  deleteAppDataRequestSchema,
  type AppSettings,
  type SpaceApps,
} from "@hearth/shared";
import type { Hono } from "hono";
import type { Db } from "../db/database";
import { readBody } from "../http/body";
import type { Env, RequireMember } from "../http/env";
import { callApp } from "./calls";
import { addApp, deleteAppData, listSpaceApps, removeApp, setAppAccess, setAppPrefs } from "./installs";
import type { Registry } from "./registry";
import { changeAppSettings, readAppSettings } from "./settings";

export type AppRoutesOptions = { db: Db; registry: Registry; requireMember: RequireMember };

/** Adds the routes to the application. Call it before the catch-all for unknown `/api` paths. */
export function registerAppRoutes(app: Hono<Env>, options: AppRoutesOptions): void {
  const { db, registry, requireMember } = options;

  // Every app the space has, removed ones and those without code included, with who can use
  // each, and everyone in the space: what its owners manage access with.
  app.get("/api/spaces/:spaceId/apps", requireMember, (c) => {
    const apps: SpaceApps = listSpaceApps(db, registry, { userId: c.get("user").id, spaceId: c.req.param("spaceId") });
    return c.json(apps);
  });

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

  // Who can use the app: what every member gets, and exceptions for single members.
  app.put("/api/spaces/:spaceId/apps/:appId/access", requireMember, async (c) => {
    const change = await readBody(c, appAccessRequestSchema);
    const { spaceId, appId } = c.req.param();
    setAppAccess(db, registry, { userId: c.get("user").id, spaceId, appId, change });
    return c.body(null, 204);
  });

  // The caller's own switch and pin for the app. View access is enough: they are nobody else's.
  app.patch("/api/spaces/:spaceId/apps/:appId/me", requireMember, async (c) => {
    const patch = await readBody(c, appPrefsPatchSchema);
    const { spaceId, appId } = c.req.param();
    setAppPrefs(db, registry, { userId: c.get("user").id, spaceId, appId, patch });
    return c.body(null, 204);
  });

  // The app's settings here: the values the space shares and the caller's own, defaults filled in.
  app.get("/api/spaces/:spaceId/apps/:appId/settings", requireMember, (c) => {
    const { spaceId, appId } = c.req.param();
    const settings: AppSettings = readAppSettings(db, registry, { userId: c.get("user").id, spaceId, appId });
    return c.json(settings);
  });

  // Save some of them. The space's need edit access; a person's own need only view.
  app.patch("/api/spaces/:spaceId/apps/:appId/settings", requireMember, async (c) => {
    const patch = await readBody(c, appSettingsPatchSchema);
    const { spaceId, appId } = c.req.param();
    const settings: AppSettings = changeAppSettings(db, registry, { userId: c.get("user").id, spaceId, appId, patch });
    return c.json(settings);
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
