/**
 * The framework's own sample apps (packages/fixture-apps) as the server's
 * tests are handed them, and the one that has no server file.
 *
 * A real build gets its list of apps from `hearth-apps sync`; tests get
 * `FIXTURE_APPS`, written by hand in ../testing.ts. The first test keeps the
 * hand-written list equal to what sync would write for that folder.
 */
import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { apiErrorSchema, appSettingsSchema, sessionSchema } from "@hearth/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { as, FIXTURE_APPS, testApp } from "../testing";
import { family, install, LIN, SAM } from "./test-world";

const BASE = "http://hearth.example.com";
const FIXTURES = resolve(import.meta.dirname, "../../../fixture-apps");

describe("the sample apps handed to tests", () => {
  it("are the folders of packages/fixture-apps, as a build finds them", () => {
    const folders = readdirSync(FIXTURES, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && existsSync(join(FIXTURES, entry.name, "manifest.ts")))
      .map((entry) => entry.name)
      .sort();
    expect(FIXTURE_APPS.map((app) => app.id)).toEqual(folders);
    for (const app of FIXTURE_APPS) {
      expect(app.manifest.id).toBe(app.id);
      expect([app.id, app.server !== undefined]).toEqual([app.id, existsSync(join(FIXTURES, app.id, "server.ts"))]);
      expect([app.id, app.hasPage]).toEqual([app.id, existsSync(join(FIXTURES, app.id, "page.tsx"))]);
    }
  });
});

describe("the sample feed, an app with a widget and no server file", () => {
  let world: ReturnType<typeof family>;
  let app: ReturnType<typeof testApp>["app"];
  let errors: unknown[];

  const call = (who: string, method: string, path: string, body?: unknown) =>
    app.request(`${BASE}${path}`, {
      method,
      headers: as(who, body === undefined ? {} : { "content-type": "application/json", origin: BASE }),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const settings = async (response: Response) => {
    expect(response.status).toBe(200);
    return appSettingsSchema.parse(await response.json());
  };

  beforeEach(() => {
    world = family();
    ({ app, errors } = testApp({ db: world.db, apps: FIXTURE_APPS }));
    install(world.db, world.family, "feed", world.sam.id, { memberAccess: "view" });
  });

  it("is in the session of everyone it is shared with, as an app without a page", async () => {
    for (const who of [SAM, LIN]) {
      const session = sessionSchema.parse(await (await call(who, "GET", "/api/session")).json());
      expect(session.apps).toEqual([
        expect.objectContaining({ id: "feed", spaceId: world.family, hasPage: false, widgetSize: "wide", icon: "trending-up" }),
      ]);
    }
  });

  it("has no queries or mutations to call", async () => {
    for (const kind of ["q", "m"]) {
      const response = await call(SAM, "POST", `/api/spaces/${world.family}/apps/feed/${kind}/list`, {});
      expect(response.status).toBe(404);
      expect(apiErrorSchema.parse(await response.json()).error.code).toBe("not_found");
    }
    expect(errors).toEqual([]);
  });

  it("keeps each person's own filters, which a viewer may change too", async () => {
    const address = `/api/spaces/${world.family}/apps/feed/settings`;
    expect(await settings(await call(LIN, "GET", address))).toEqual({ space: {}, user: { topics: [], period: "day" } });

    const saved = await settings(await call(LIN, "PATCH", address, { user: { topics: ["food", "science"], period: "week" } }));
    expect(saved).toEqual({ space: {}, user: { topics: ["food", "science"], period: "week" } });
    expect(await settings(await call(SAM, "GET", address))).toEqual({ space: {}, user: { topics: [], period: "day" } });

    const unknownTopic = await call(LIN, "PATCH", address, { user: { topics: ["gossip"] } });
    expect(unknownTopic.status).toBe(400);
    expect(errors).toEqual([]);
  });
});
