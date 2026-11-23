/**
 * The routes for apps in a space (docs/mini-app-contract.md, section A8):
 * the owners' list of a space's apps and who can use them, and for one app
 * bring back, remove, move to another space, delete the data, who can use
 * it, each person's own switch and pin, and the app's settings. The routes
 * of an app's page and its rows are src/made/routes.ts's. The request and
 * answer shapes are in `@hearth/shared`. The owners' list and the settings
 * routes answer with a body; after the others the web app reloads the
 * session to see what changed.
 */
import {
  addAppRequestSchema,
  appAccessRequestSchema,
  appPrefsPatchSchema,
  appSettingsPatchSchema,
  deleteAppDataRequestSchema,
  moveAppRequestSchema,
  type AppSettings,
  type SpaceApps,
} from "@hearth/shared";
import type { Hono } from "hono";
import type { Db } from "../db/database";
import { readBody } from "../http/body";
import type { Env, RequireMember } from "../http/env";
import { addApp, deleteAppData, listSpaceApps, moveApp, removeApp, setAppAccess, setAppPrefs } from "./installs";
import type { Registry } from "./registry";
import { changeAppSettings, readAppSettings } from "./settings";

export type AppRoutesOptions = {
  db: Db;
  registry: Registry;
  requireMember: RequireMember;
};

/** Adds the routes to the application. Call it before the catch-all for unknown `/api` paths. */
export function registerAppRoutes(app: Hono<Env>, options: AppRoutesOptions): void {
  const { db, registry, requireMember } = options;

  // Every app the space has, removed ones and those the server holds no app for included, with
  // who can use each, and everyone in the space: what its owners manage access with.
  app.get("/api/spaces/:spaceId/apps", requireMember, (c) => {
    const apps: SpaceApps = listSpaceApps(db, registry, { userId: c.get("user").id, spaceId: c.req.param("spaceId") });
    return c.json(apps);
  });

  // Bring a removed app back to its space with its data; one that is there stays as it is.
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

  // Move an app with its data to another space. Access there starts afresh.
  app.post("/api/spaces/:spaceId/apps/:appId/move", requireMember, async (c) => {
    const { toSpaceId, memberAccess } = await readBody(c, moveAppRequestSchema);
    const { spaceId, appId } = c.req.param();
    moveApp(db, registry, { userId: c.get("user").id, spaceId, appId, toSpaceId, memberAccess });
    return c.body(null, 204);
  });

  // Delete the data of an app that was removed or that the server holds no app for.
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
}
