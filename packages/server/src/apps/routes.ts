/**
 * The routes for apps in a space (docs/mini-app-contract.md, section A8):
 * the owners' list of a space's apps and who can use them, and for one app
 * add or bring back, remove, move to another space, delete the data, who
 * can use it, each person's own switch and pin, the app's settings, the
 * app's own queries and mutations, and the status of its jobs and a run
 * asked for now (section C, "Routes"). The request and answer shapes are in
 * `@hearth/shared`. The owners' list, the settings routes, a query or
 * mutation and the two job routes answer with a body; after the others the
 * web app reloads the session to see what changed.
 */
import {
  addAppRequestSchema,
  appAccessRequestSchema,
  appCallRequestSchema,
  appPrefsPatchSchema,
  appSettingsPatchSchema,
  deleteAppDataRequestSchema,
  moveAppRequestSchema,
  type AppSettings,
  type JobStatus,
  type SpaceApps,
} from "@hearth/shared";
import type { Hono } from "hono";
import type { Db } from "../db/database";
import { readBody } from "../http/body";
import type { Env, RequireMember } from "../http/env";
import { callApp } from "./calls";
import { addApp, deleteAppData, listSpaceApps, moveApp, removeApp, setAppAccess, setAppPrefs } from "./installs";
import { jobStatus, requestRun } from "./jobs";
import type { Registry } from "./registry";
import { changeAppSettings, readAppSettings } from "./settings";

export type AppRoutesOptions = {
  db: Db;
  registry: Registry;
  requireMember: RequireMember;
  /** Tells the scheduler that a job may have fallen due at once (see `AppOptions.wakeJobs`). */
  wakeJobs: () => void;
  /**
   * The least time between the start of a job's run and that of a run
   * asked for: five minutes, or five seconds where stand-ins answer every
   * fetch (`requestGapFor` in jobs.ts).
   */
  requestGapMs: number;
};

/** Adds the routes to the application. Call it before the catch-all for unknown `/api` paths. */
export function registerAppRoutes(app: Hono<Env>, options: AppRoutesOptions): void {
  const { db, registry, requireMember, wakeJobs, requestGapMs } = options;

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
    const done = addApp(db, registry, { userId: c.get("user").id, spaceId, appId, memberAccess });
    // A job that has not run in this space is due at once, and one brought back may be overdue.
    if (done !== "unchanged") wakeJobs();
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

  // How one of the app's jobs went here: when its runs started, went well
  // and went wrong, and whether one is going on or was asked for. View
  // access is enough. A job is no route (its name is no query's or
  // mutation's, see callApp), and nothing here runs one: the scheduler does.
  app.get("/api/spaces/:spaceId/apps/:appId/jobs/:job", requireMember, (c) => {
    const { spaceId, appId, job } = c.req.param();
    const status: JobStatus = jobStatus(db, registry, { userId: c.get("user").id, spaceId, appId, job });
    return c.json(status);
  });

  // Ask the scheduler for a run now, as "Refresh now" does: edit access, no
  // body. It starts at once, or once the gap after the last run's start is
  // over, never sooner, so that asking again and again cannot hammer a
  // host. Answers 202: the run is to come, and the status says where it stands.
  app.post("/api/spaces/:spaceId/apps/:appId/jobs/:job/run", requireMember, (c) => {
    const { spaceId, appId, job } = c.req.param();
    const status: JobStatus = requestRun(db, registry, { userId: c.get("user").id, spaceId, appId, job }, new Date(), requestGapMs);
    // A run asked for may be due at once. During a run nothing was asked: the scheduler looks again after it anyway.
    if (status.state === "requested") wakeJobs();
    return c.json(status, 202);
  });
}
